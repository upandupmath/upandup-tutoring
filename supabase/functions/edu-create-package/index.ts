import {
  assertAllowedOrigin,
  cleanEmail,
  cleanText,
  errorResponse,
  HttpError,
  json,
  preflight,
  readJson,
  requirePost,
  trustedRedirect,
} from "../_shared/http.ts";
import { patch, rpc } from "../_shared/db.ts";
import { createOrder } from "../_shared/paypal.ts";

const VALID_TIMES = new Set(["16:00", "17:00", "18:00", "19:00"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GRADES = new Set(["6", "7", "8", "9", "10", "11", "12"]);
const RESERVATION_MINUTES = 30;

function easternToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return map.year + "-" + map.month + "-" + map.day;
}

function validateSessions(input) {
  if (!Array.isArray(input) || input.length !== 4) {
    throw new HttpError(400, "Exactly four sessions are required");
  }
  const today = easternToday();
  const horizon = new Date(today + "T12:00:00Z");
  horizon.setUTCMonth(horizon.getUTCMonth() + 6);
  const latest = horizon.toISOString().slice(0, 10);
  const unique = new Set();

  const sessions = input.map((raw) => {
    const date = typeof raw.date === "string" ? raw.date : "";
    const time = typeof raw.time === "string" ? raw.time.slice(0, 5) : "";
    if (!DATE.test(date) || !VALID_TIMES.has(time)) {
      throw new HttpError(400, "One or more session times are invalid");
    }
    const weekday = new Date(date + "T12:00:00Z").getUTCDay();
    if (weekday === 0 || weekday === 6 || date < today || date > latest) {
      throw new HttpError(400, "Sessions must be future weekdays within six months");
    }
    const key = date + "|" + time;
    if (unique.has(key)) throw new HttpError(400, "Duplicate sessions are not allowed");
    unique.add(key);
    return { date, time };
  });

  return sessions.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("Invalid configured price");
  return number.toFixed(2);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);
  let packageId = null;

  try {
    assertAllowedOrigin(request);
    requirePost(request);
    const input = await readJson(request);
    const sessions = validateSessions(input.sessions);
    const parentName = cleanText(input.parent_name, "Parent name", 120);
    const parentEmail = cleanEmail(input.parent_email, "Parent email");
    const studentEmail = cleanEmail(input.student_email, "Student email", false);
    const grade = cleanText(input.student_grade, "Student grade", 12);
    if (!GRADES.has(grade)) throw new HttpError(400, "Student grade is invalid");
    const subject = cleanText(input.subject, "Subject", 80);
    const notes = cleanText(input.notes, "Notes", 2000, false);
    const discountCode = cleanText(input.discount_code, "Discount code", 64, false);
    const returnUrl = trustedRedirect(input.return_url, "Return URL");
    const cancelUrl = trustedRedirect(input.cancel_url, "Cancel URL");

    packageId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000).toISOString();
    const reserved = await rpc("edu_reserve_package", {
      p_package: {
        id: packageId,
        parent_name: parentName,
        parent_email: parentEmail,
        student_email: studentEmail,
        student_grade: grade,
        subject,
        notes,
        discount_code: discountCode,
        reservation_expires_at: expiresAt,
      },
      p_sessions: sessions,
    });

    const row = Array.isArray(reserved) ? reserved[0] : reserved;
    if (!row || !row.payment1_amount) {
      throw new Error("Reservation did not return pricing");
    }

    if (Number(row.payment1_amount) === 0) {
      await rpc("edu_finalize_comped_package", { p_package_id: packageId });
      return json(request, { mode: "comped", package_id: packageId, payment1_amount: 0 });
    }

    const order = await createOrder({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: packageId,
        custom_id: packageId,
        invoice_id: "edu-" + packageId + "-payment-1",
        description: "Up and Up tutoring package — sessions 1 and 2",
        amount: { currency_code: "USD", value: money(row.payment1_amount) },
      }],
      payment_source: {
        paypal: {
          attributes: {
            vault: {
              store_in_vault: "ON_SUCCESS",
              usage_type: "MERCHANT",
              customer_type: "CONSUMER",
            },
          },
          experience_context: {
            brand_name: "Up and Up Educational Services",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    }, packageId + "-payment-1");

    const approveUrl = Array.isArray(order.links) &&
      order.links.find((link) => link.rel === "approve" || link.rel === "payer-action");
    if (!order.id || !approveUrl || !approveUrl.href) {
      throw new HttpError(502, "PayPal did not return an approval link");
    }

    await patch("edu_packages", "id=eq." + encodeURIComponent(packageId), {
      paypal_order_id: order.id,
      payment1_status: "pending",
    });

    return json(request, {
      mode: "paypal",
      package_id: packageId,
      order_id: order.id,
      approveUrl: approveUrl.href,
      payment1_amount: Number(row.payment1_amount),
    }, 201);
  } catch (error) {
    if (packageId) {
      try { await rpc("edu_release_package_reservation", { p_package_id: packageId }); }
      catch (releaseError) { console.error("Reservation release failed", releaseError); }
    }
    if (error && error.status === 409) {
      return json(request, { error: "One or more sessions are no longer available", conflicts: true }, 409);
    }
    return errorResponse(request, error);
  }
});
