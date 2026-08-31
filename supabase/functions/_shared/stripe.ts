import { HttpError } from "./http.ts";

function requiredEnv(name) {
  const value = Deno.env.get(name);
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

function encodeForm(entries) {
  const form = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== null && value !== undefined) form.append(key, String(value));
  }
  return form;
}

export async function stripeRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", "Bearer " + requiredEnv("STRIPE_SECRET_KEY"));
  if (options.form) headers.set("content-type", "application/x-www-form-urlencoded");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
  const configuredVersion = Deno.env.get("STRIPE_API_VERSION");
  if (configuredVersion) headers.set("stripe-version", configuredVersion);

  const response = await fetch("https://api.stripe.com" + path, {
    method: options.method || "GET",
    headers,
    body: options.form ? encodeForm(options.form) : undefined,
  });
  const text = await response.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  if (!response.ok) {
    console.error("Stripe request failed", response.status, body);
    const message = body && body.error && body.error.message
      ? body.error.message
      : "Payment provider request failed";
    const error = new HttpError(response.status >= 500 ? 502 : 402, message);
    error.stripeCode = body && body.error ? body.error.code || null : null;
    throw error;
  }
  return body;
}

export function createCheckoutSession(entries, packageId) {
  return stripeRequest("/v1/checkout/sessions", {
    method: "POST",
    form: entries,
    idempotencyKey: packageId + "-checkout-1",
  });
}

export function retrieveCheckoutSession(sessionId) {
  if (!/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(sessionId)) {
    throw new HttpError(400, "Invalid Stripe Checkout Session ID");
  }
  return stripeRequest(
    "/v1/checkout/sessions/" + encodeURIComponent(sessionId) +
      "?expand%5B%5D=payment_intent"
  );
}

export function createPaymentIntent(entries, packageId) {
  return stripeRequest("/v1/payment_intents", {
    method: "POST",
    form: entries,
    idempotencyKey: packageId + "-payment-2",
  });
}

function equalHex(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function verifyStripeWebhook(rawBody, signatureHeader) {
  if (!signatureHeader) throw new HttpError(400, "Missing Stripe-Signature header");
  const fields = signatureHeader.split(",").map((part) => part.trim().split("="));
  const timestamp = fields.find(([key]) => key === "t");
  const signatures = fields.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !timestamp[1] || signatures.length === 0) {
    throw new HttpError(400, "Invalid Stripe signature header");
  }

  const seconds = Number(timestamp[1]);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) {
    throw new HttpError(400, "Expired Stripe webhook signature");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(requiredEnv("STRIPE_WEBHOOK_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(timestamp[1] + "." + rawBody)
  );
  const expected = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (!signatures.some((signature) => equalHex(signature, expected))) {
    throw new HttpError(400, "Invalid Stripe webhook signature");
  }

  try { return JSON.parse(rawBody); }
  catch { throw new HttpError(400, "Invalid Stripe webhook payload"); }
}
