import {
  assertAllowedOrigin,
  errorResponse,
  HttpError,
  json,
  preflight,
} from "../_shared/http.ts";
import { db } from "../_shared/db.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflight(request);
  try {
    assertAllowedOrigin(request);
    if (request.method !== "GET") throw new HttpError(405, "Method not allowed");

    const url = new URL(request.url);
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    if (!DATE.test(from) || !DATE.test(to) || from > to) {
      throw new HttpError(400, "A valid from/to date range is required");
    }

    const maximum = new Date(from + "T00:00:00Z");
    maximum.setUTCMonth(maximum.getUTCMonth() + 7);
    if (to > maximum.toISOString().slice(0, 10)) {
      throw new HttpError(400, "Availability range is too large");
    }

    await db("edu_sessions?status=eq.reserved&reservation_expires_at=lte." +
      encodeURIComponent(new Date().toISOString()), {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ status: "expired" }),
    });

    const query = "select=session_date,session_time,status,reservation_expires_at" +
      "&session_date=gte." + encodeURIComponent(from) +
      "&session_date=lte." + encodeURIComponent(to) +
      "&status=in.(reserved,confirmed)";
    const rows = await db("edu_sessions?" + query);
    const now = Date.now();
    const booked = rows
      .filter((row) => row.status === "confirmed" ||
        (row.reservation_expires_at && Date.parse(row.reservation_expires_at) > now))
      .map((row) => ({
        date: row.session_date,
        time: String(row.session_time).slice(0, 5),
      }));

    return json(request, { booked });
  } catch (error) {
    return errorResponse(request, error);
  }
});
