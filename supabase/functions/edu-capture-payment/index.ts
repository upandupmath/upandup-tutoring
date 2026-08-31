import {
  assertAllowedOrigin,
  errorResponse,
  HttpError,
  json,
  preflight,
  readJson,
  requirePost,
} from "../_shared/http.ts";
import { patch, rpc, selectOne } from "../_shared/db.ts";
import { captureOrder, completedCapture, vaultDetails } from "../_shared/paypal.ts";

function cents(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid monetary value");
  return Math.round(parsed * 100);
}

async function syncCalendar(packageId) {
  const url = Deno.env.get("CALENDAR_WEBHOOK_URL");
  if (!url) return { status: "not_configured" };
  const secret = Deno.env.get("CALENDAR_WEBHOOK_SECRET") || "";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": secret,
      "idempotency-key": packageId + "-payment-1-calendar",
    },
    body: JSON.stringify({ action: "payment1_captured", package_id: packageId }),
  });
  if (!response.ok) throw new Error("Calendar webhook returned " + response.status);
  return { status: "sent" };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);

  try {
    assertAllowedOrigin(request);
    requirePost(request);
    const input = await readJson(request);
    const orderId = typeof input.order_id === "string" ? input.order_id.trim() : "";
    if (!/^[A-Z0-9]+$/i.test(orderId)) throw new HttpError(400, "Invalid PayPal order ID");

    const record = await selectOne(
      "edu_packages",
      "select=id,paypal_order_id,payment1_status,payment1_amount,currency,calendar_sync_status" +
        "&paypal_order_id=eq." + encodeURIComponent(orderId)
    );
    if (!record || !record.id) throw new HttpError(404, "Booking was not found");

    if (record.payment1_status === "captured") {
      return json(request, {
        status: "already_captured",
        package_id: record.id,
        calendar_sync_status: record.calendar_sync_status,
      });
    }

    const order = await captureOrder(orderId, record.id + "-capture-payment-1");
    const capture = completedCapture(order);
    if (!capture || order.status !== "COMPLETED") {
      throw new HttpError(502, "PayPal has not completed this payment");
    }

    const unit = order.purchase_units && order.purchase_units[0];
    const boundPackage = unit && (unit.custom_id || unit.reference_id);
    if (boundPackage && boundPackage !== record.id) {
      throw new HttpError(409, "Payment does not belong to this booking");
    }
    if (capture.amount.currency_code !== (record.currency || "USD")) {
      throw new HttpError(409, "Payment currency does not match the booking");
    }
    if (cents(capture.amount.value) !== cents(record.payment1_amount)) {
      throw new HttpError(409, "Payment amount does not match the booking");
    }

    const vault = vaultDetails(order);
    const finalized = await rpc("edu_finalize_payment1", {
      p_package_id: record.id,
      p_paypal_order_id: orderId,
      p_capture_id: capture.id,
      p_amount: capture.amount.value,
      p_currency: capture.amount.currency_code,
      p_vault_id: vault.id,
      p_vault_status: vault.status,
      p_paypal_customer_id: vault.customerId,
      p_payment_source: vault.sourceType,
    });
    const result = Array.isArray(finalized) ? finalized[0] : finalized;

    let calendarStatus = "pending";
    try {
      const sync = await syncCalendar(record.id);
      calendarStatus = sync.status;
      await patch("edu_packages", "id=eq." + encodeURIComponent(record.id), {
        calendar_sync_status: calendarStatus,
        calendar_sync_error: null,
      });
    } catch (calendarError) {
      calendarStatus = "failed";
      console.error("Calendar synchronization failed", calendarError);
      await patch("edu_packages", "id=eq." + encodeURIComponent(record.id), {
        calendar_sync_status: "failed",
        calendar_sync_error: String(calendarError).slice(0, 1000),
      });
    }

    return json(request, {
      status: result && result.already_captured ? "already_captured" : "captured",
      package_id: record.id,
      calendar_sync_status: calendarStatus,
      vault_status: vault.status,
    });
  } catch (error) {
    return errorResponse(request, error);
  }
});
