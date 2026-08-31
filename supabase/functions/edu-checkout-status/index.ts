import {
  assertAllowedOrigin,
  errorResponse,
  HttpError,
  json,
  preflight,
} from "../_shared/http.ts";
import { selectOne } from "../_shared/db.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);
  try {
    assertAllowedOrigin(request);
    if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
    const sessionId = new URL(request.url).searchParams.get("session_id") || "";
    if (!/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(sessionId)) {
      throw new HttpError(400, "Invalid Stripe Checkout Session ID");
    }

    const record = await selectOne(
      "edu_packages",
      "select=id,payment1_status,calendar_sync_status" +
        "&stripe_checkout_session_id=eq." + encodeURIComponent(sessionId)
    );
    if (!record || !record.id) throw new HttpError(404, "Booking was not found");

    return json(request, {
      package_id: record.id,
      payment_status: record.payment1_status,
      calendar_sync_status: record.calendar_sync_status,
    });
  } catch (error) {
    return errorResponse(request, error);
  }
});
