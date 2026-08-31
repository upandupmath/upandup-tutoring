const DEFAULT_ORIGINS = ["https://upandupmath.github.io"];

export function allowedOrigins() {
  const configured = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...configured]);
}

export function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const allowed = allowedOrigins();
  return {
    "access-control-allow-origin": allowed.has(origin) ? origin : DEFAULT_ORIGINS[0],
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "vary": "Origin",
  };
}

export function assertAllowedOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins().has(origin)) {
    throw new HttpError(403, "Origin is not allowed");
  }
}

export function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "content-type": "application/json; charset=utf-8" },
  });
}

export function preflight(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

export function errorResponse(request, error) {
  if (error instanceof HttpError) {
    return json(request, { error: error.message, ...(error.details || {}) }, error.status);
  }
  console.error(error);
  return json(request, { error: "The booking service is temporarily unavailable" }, 500);
}

export function requirePost(request) {
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
}

export function cleanText(value, name, maxLength, required = true) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new HttpError(400, name + " is required");
  if (text.length > maxLength) throw new HttpError(400, name + " is too long");
  return text || null;
}

export function cleanEmail(value, name, required = true) {
  const email = cleanText(value, name, 254, required);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, name + " is invalid");
  }
  return email ? email.toLowerCase() : null;
}

export function trustedRedirect(value, name) {
  let url;
  try {
    url = new URL(cleanText(value, name, 2048));
  } catch {
    throw new HttpError(400, name + " is invalid");
  }
  if (url.protocol !== "https:" || !allowedOrigins().has(url.origin)) {
    throw new HttpError(400, name + " must use an approved site origin");
  }
  return url.toString();
}
