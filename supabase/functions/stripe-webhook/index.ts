import { errorResponse, HttpError, json } from "../_shared/http.ts";
import { patch, rpc, selectOne } from "../_shared/db.ts";
import { retrieveCheckoutSession, verifyStripeWebhook } from "../_shared/stripe.ts";

async function syncCalendar(packageId, paymentNumber) {
  const url = Deno.env.get("CALENDAR_WEBHOOK_URL");
  if (!url) return "not_configured";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": Deno.env.get("CALENDAR_WEBHOOK_SECRET") || "",
      "idempotency-key": packageId + "-payment-" + paymentNumber + "-calendar",
    },
    body: JSON.stringify({
      action: paymentNumber === 1 ? "payment1_captured" : "payment2_captured",
      package_id: packageId,
    }),
  });
  if (!response.ok) throw new Error("Calendar webhook returned " + response.status);
  return "sent";
}

async function finalizeCheckout(sessionObject) {
  const session = await retrieveCheckoutSession(sessionObject.id);
  if (session.payment_status !== "paid") return;
  const packageId = session.metadata && session.metadata.package_id
    ? session.metadata.package_id
    : session.client_reference_id;
  if (!packageId) throw new HttpError(400, "Stripe session is missing package metadata");

  const record = await selectOne(
    "edu_packages",
    "select=id,payment1_amount,currency,stripe_checkout_session_id" +
      "&id=eq." + encodeURIComponent(packageId)
  );
  if (!record || record.stripe_checkout_session_id !== session.id) {
    throw new HttpError(409, "Stripe session does not match the booking");
  }
  if (Number(session.amount_total) !== Math.round(Number(record.payment1_amount) * 100)) {
    throw new HttpError(409, "Stripe amount does not match the booking");
  }
  if (String(session.currency || "").toUpperCase() !== String(record.currency || "USD").toUpperCase()) {
    throw new HttpError(409, "Stripe currency does not match the booking");
  }

  const intent = session.payment_intent;
  if (!intent || typeof intent !== "object" || intent.status !== "succeeded") {
    throw new HttpError(409, "Stripe PaymentIntent is not complete");
  }
  const paymentMethod = typeof intent.payment_method === "string"
    ? intent.payment_method
    : intent.payment_method && intent.payment_method.id;

  await rpc("edu_finalize_payment1_stripe", {
    p_package_id: packageId,
    p_checkout_session_id: session.id,
    p_payment_intent_id: intent.id,
    p_customer_id: typeof session.customer === "string" ? session.customer : session.customer && session.customer.id,
    p_payment_method_id: paymentMethod,
    p_amount_cents: session.amount_total,
    p_currency: String(session.currency || "").toUpperCase(),
  });

  try {
    const status = await syncCalendar(packageId, 1);
    await patch("edu_packages", "id=eq." + encodeURIComponent(packageId), {
      calendar_sync_status: status,
      calendar_sync_error: null,
    });
  } catch (error) {
    console.error("Calendar synchronization failed", error);
    await patch("edu_packages", "id=eq." + encodeURIComponent(packageId), {
      calendar_sync_status: "failed",
      calendar_sync_error: String(error).slice(0, 1000),
    });
  }
}

async function finalizeSecondPayment(intent) {
  const packageId = intent.metadata && intent.metadata.package_id;
  if (!packageId || intent.metadata.payment_number !== "2") return;
  if (intent.status !== "succeeded") return;
  await rpc("edu_finalize_payment2_stripe", {
    p_package_id: packageId,
    p_payment_intent_id: intent.id,
    p_amount_cents: intent.amount_received,
    p_currency: String(intent.currency || "").toUpperCase(),
  });
  try { await syncCalendar(packageId, 2); }
  catch (error) { console.error("Second-payment calendar sync failed", error); }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
  let eventId = null;
  try {
    const rawBody = await request.text();
    const event = await verifyStripeWebhook(rawBody, request.headers.get("stripe-signature"));
    eventId = event.id;
    const accepted = await rpc("edu_begin_stripe_event", {
      p_event_id: event.id,
      p_event_type: event.type,
    });
    if (accepted === false) return json(request, { received: true, duplicate: true });

    if (event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded") {
      await finalizeCheckout(event.data.object);
    } else if (event.type === "checkout.session.expired") {
      const packageId = event.data.object.metadata && event.data.object.metadata.package_id;
      if (packageId) await rpc("edu_release_package_reservation", { p_package_id: packageId });
    } else if (event.type === "payment_intent.succeeded") {
      await finalizeSecondPayment(event.data.object);
    } else if (event.type === "payment_intent.payment_failed") {
      const intent = event.data.object;
      if (intent.metadata && intent.metadata.payment_number === "2" && intent.metadata.package_id) {
        await patch("edu_packages", "id=eq." + encodeURIComponent(intent.metadata.package_id), {
          payment2_status: "failed",
          payment2_error: intent.last_payment_error && intent.last_payment_error.message
            ? intent.last_payment_error.message.slice(0, 1000)
            : "Stripe reported a failed payment",
        });
      }
    }

    await rpc("edu_finish_stripe_event", {
      p_event_id: event.id,
      p_status: "processed",
      p_error: null,
    });
    return json(request, { received: true });
  } catch (error) {
    if (eventId) {
      try {
        await rpc("edu_finish_stripe_event", {
          p_event_id: eventId,
          p_status: "failed",
          p_error: String(error).slice(0, 1000),
        });
      } catch (logError) { console.error("Could not log Stripe event failure", logError); }
    }
    return errorResponse(request, error);
  }
});
