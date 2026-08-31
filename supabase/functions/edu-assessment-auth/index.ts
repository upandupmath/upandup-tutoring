const DEFAULT_ORIGINS = ["https://upandupmath.github.io"];
const TOKEN_TTL_SECONDS = 2 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const loginAttempts = new Map();

function requiredEnv(name) {
  const value = Deno.env.get(name);
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

function allowedOrigins() {
  const configured = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...configured]);
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  return {
    "access-control-allow-origin": allowedOrigins().has(origin) ? origin : DEFAULT_ORIGINS[0],
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "cache-control": "no-store",
    "vary": "Origin",
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "content-type": "application/json; charset=utf-8" },
  });
}

function assertAllowedOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins().has(origin)) {
    throw new HttpError(403, "Origin is not allowed");
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clientKey(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function enforceLoginRateLimit(request) {
  const key = clientKey(request);
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  const recent = (loginAttempts.get(key) || []).filter((time) => time > cutoff);
  if (recent.length >= MAX_LOGIN_ATTEMPTS) {
    throw new HttpError(429, "Too many attempts. Please wait 15 minutes and try again.");
  }
  recent.push(Date.now());
  loginAttempts.set(key, recent);
  return key;
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(value) {
  const secret = requiredEnv("ASSESSMENT_SESSION_SECRET");
  if (secret.length < 32) throw new Error("ASSESSMENT_SESSION_SECRET must contain at least 32 characters");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return {
    key,
    signature: new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))
    ),
  };
}

async function accessCodeMatches(candidate) {
  const expected = requiredEnv("ASSESSMENT_ACCESS_CODE");
  const actualDigest = (await hmac(candidate)).signature;
  const expectedDigest = (await hmac(expected)).signature;
  if (actualDigest.length !== expectedDigest.length) return false;
  let mismatch = 0;
  for (let index = 0; index < actualDigest.length; index += 1) {
    mismatch |= actualDigest[index] ^ expectedDigest[index];
  }
  return mismatch === 0;
}

async function createToken() {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    scope: "assessment",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  })));
  const unsigned = header + "." + payload;
  const signature = base64Url((await hmac(unsigned)).signature);
  return unsigned + "." + signature;
}

async function verifyToken(token) {
  if (typeof token !== "string") throw new HttpError(401, "Assessment session is required");
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "Assessment session is invalid");
  const unsigned = parts[0] + "." + parts[1];
  let signature;
  try {
    signature = decodeBase64Url(parts[2]);
  } catch {
    throw new HttpError(401, "Assessment session is invalid");
  }
  const { key } = await hmac(unsigned);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(unsigned)
  );
  if (!valid) throw new HttpError(401, "Assessment session is invalid");
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  } catch {
    throw new HttpError(401, "Assessment session is invalid");
  }
  if (
    payload.scope !== "assessment" ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new HttpError(401, "Assessment session has expired");
  }
}

function cleanText(value, name, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HttpError(400, name + " is required");
  if (text.length > maxLength) throw new HttpError(400, name + " is too long");
  return text;
}

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > 25000) throw new HttpError(413, "Request is too large");
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

async function handleLogin(request, body) {
  const attemptKey = enforceLoginRateLimit(request);
  const accessCode = cleanText(body.accessCode, "Access code", 200);
  if (!(await accessCodeMatches(accessCode))) {
    throw new HttpError(401, "Incorrect access code");
  }
  loginAttempts.delete(attemptKey);
  return json(request, { token: await createToken(), expiresIn: TOKEN_TTL_SECONDS });
}

async function handleReport(request, body) {
  await verifyToken(body.token);
  const report = body.report || {};
  const studentName = cleanText(report.studentName, "Student name", 80);
  const gradeLevel = Number(report.gradeLevel);
  const score = Number(report.score);
  const verdict = cleanText(report.verdict, "Verdict", 200);
  const reportText = cleanText(report.reportText, "Report", 20000);
  if (!Number.isInteger(gradeLevel) || gradeLevel < 6 || gradeLevel > 11) {
    throw new HttpError(400, "Grade level is invalid");
  }
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new HttpError(400, "Score is invalid");
  }

  const response = await fetch(requiredEnv("ASSESSMENT_REPORT_URL"), {
    method: "POST",
    headers: { "content-type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "assessmentReport",
      studentName,
      gradeLevel,
      score,
      verdict,
      report: reportText,
    }),
  });
  if (!response.ok) throw new HttpError(502, "Report delivery service rejected the request");
  return json(request, { status: "submitted" });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  try {
    assertAllowedOrigin(request);
    if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readBody(request);
    if (body.action === "login") return await handleLogin(request, body);
    if (body.action === "report") return await handleReport(request, body);
    throw new HttpError(400, "Action is invalid");
  } catch (error) {
    if (error instanceof HttpError) return json(request, { error: error.message }, error.status);
    console.error(error);
    return json(request, { error: "Assessment service is temporarily unavailable" }, 500);
  }
});
