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
import { createCheckoutSession } from "../_shared/stripe.ts";

const VALID_TIMES = new Set(["16:00", "17:00", "18:00", "19:00"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GRADES = new Set(["6", "7", "8", "9", "10", "11", "12"]);
const RESERVATION_MINUTES = 35;

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

function cents(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("Invalid configured price");
  return Math.round(number * 100);
}

function successUrl(returnUrl) {
  const url = new URL(returnUrl);
  url.searchParams.set("stripe", "return");
  url.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
  return url.toString().replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}");
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
    if (input.payment_authorized !== true) {
      throw new HttpError(400, "Second-payment authorization is required");
    }

    packageId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000);
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
        payment_authorization_version: "stripe-split-v1",
        reservation_expires_at: expiresAt.toISOString(),
      },
      p_sessions: sessions,
    });
    const row = Array.isArray(reserved) ? reserved[0] : reserved;
    if (!row || row.payment1_amount === undefined) {
      throw new Error("Reservation did not return pricing");
    }

    if (Number(row.payment1_amount) === 0) {
      await rpc("edu_finalize_comped_package", { p_package_id: packageId });
      return json(request, { mode: "comped", package_id: packageId, payment1_amount: 0 });
    }

    const session = await createCheckoutSession([
      ["mode", "payment"],
      ["customer_creation", "always"],
      ["customer_email", parentEmail],
      ["client_reference_id", packageId],
      ["success_url", successUrl(returnUrl)],
      ["cancel_url", cancelUrl],
      ["expires_at", Math.floor(expiresAt.getTime() / 1000)],
      ["payment_method_types[0]", "card"],
      ["metadata[package_id]", packageId],
      ["payment_intent_data[metadata][package_id]", packageId],
      ["payment_intent_data[metadata][payment_number]", "1"],
      ["payment_intent_data[setup_future_usage]", "off_session"],
      ["line_items[0][price_data][currency]", "usd"],
      ["line_items[0][price_data][product_data][name]", "Tutoring package — sessions 1 and 2"],
      ["line_items[0][price_data][unit_amount]", cents(row.payment1_amount)],
      ["line_items[0][quantity]", "1"],
      ["custom_text[submit][message]",
        "By paying, you authorize the remaining package payment to be charged to this card within 3 days before session 3."],
    ], packageId);

    if (!session.id || !session.url) {
      throw new HttpError(502, "Stripe did not return a Checkout URL");
    }
    await patch("edu_packages", "id=eq." + encodeURIComponent(packageId), {
      stripe_checkout_session_id: session.id,
      payment1_status: "pending",
    });

    return json(request, {
      mode: "stripe",
      package_id: packageId,
      checkoutUrl: session.url,
      payment1_amount: Number(row.payment1_amount),
    }, 201);
  } catch (error) {
    if (packageId) {
      try { await rpc("edu_release_package_reservation", { p_package_id: packageId }); }
      catch (releaseError) { console.error("Reservation release failed", releaseError); }
    }
    if (error && (error.status === 409 || error.code === "23505")) {
      return json(request, {
        error: "One or more sessions are no longer available",
        conflicts: true,
      }, 409);
    }
    return errorResponse(request, error);
  }
});
