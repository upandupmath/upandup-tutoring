import { errorResponse, HttpError, json } from "../_shared/http.ts";
import { db, patch, rpc } from "../_shared/db.ts";
import { createPaymentIntent } from "../_shared/stripe.ts";

function authorized(request) {
  const expected = Deno.env.get("CRON_SECRET") || "";
  const supplied = request.headers.get("x-cron-secret") || "";
  if (!expected || supplied !== expected) throw new HttpError(401, "Unauthorized");
}

Deno.serve(async (request) => {
  try {
    if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
    authorized(request);

    const due = await db("edu_payment2_due?select=*&limit=25");
    const results = [];

    for (const item of due) {
      try {
        await patch("edu_packages", "id=eq." + encodeURIComponent(item.package_id), {
          payment2_status: "processing",
          payment2_error: null,
        });
        const intent = await createPaymentIntent([
          ["amount", item.amount_cents],
          ["currency", String(item.currency || "USD").toLowerCase()],
          ["customer", item.stripe_customer_id],
          ["payment_method", item.stripe_payment_method_id],
          ["confirm", "true"],
          ["off_session", "true"],
          ["error_on_requires_action", "true"],
          ["description", "Up and Up tutoring package — sessions 3 and 4"],
          ["metadata[package_id]", item.package_id],
          ["metadata[payment_number]", "2"],
        ], item.package_id);

        if (intent.status !== "succeeded") {
          throw new Error("Second payment returned status " + intent.status);
        }
        await rpc("edu_finalize_payment2_stripe", {
          p_package_id: item.package_id,
          p_payment_intent_id: intent.id,
          p_amount_cents: intent.amount_received,
          p_currency: String(intent.currency || "").toUpperCase(),
        });
        results.push({ package_id: item.package_id, status: "captured" });
      } catch (error) {
        console.error("Second payment failed", item.package_id, error);
        await patch("edu_packages", "id=eq." + encodeURIComponent(item.package_id), {
          payment2_status: "failed",
          payment2_error: String(error).slice(0, 1000),
        });
        results.push({ package_id: item.package_id, status: "failed" });
      }
    }

    return json(request, { processed: results.length, results });
  } catch (error) {
    return errorResponse(request, error);
  }
});
