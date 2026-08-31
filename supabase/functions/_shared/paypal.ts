import { HttpError } from "./http.ts";

function requiredEnv(name) {
  const value = Deno.env.get(name);
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

function paypalBase() {
  const value = requiredEnv("PAYPAL_BASE_URL").replace(/\/$/, "");
  const allowed = new Set(["https://api-m.paypal.com", "https://api-m.sandbox.paypal.com"]);
  if (!allowed.has(value)) throw new Error("PAYPAL_BASE_URL is not an approved PayPal API host");
  return value;
}

async function accessToken() {
  const credentials = btoa(requiredEnv("PAYPAL_CLIENT_ID") + ":" + requiredEnv("PAYPAL_CLIENT_SECRET"));
  const response = await fetch(paypalBase() + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      authorization: "Basic " + credentials,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    console.error("PayPal OAuth failed", response.status, body);
    throw new HttpError(502, "Payment provider authentication failed");
  }
  return body.access_token;
}

export async function paypal(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", "Bearer " + await accessToken());
  headers.set("content-type", "application/json");
  const response = await fetch(paypalBase() + path, { ...options, headers });
  const text = await response.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  if (!response.ok) {
    console.error("PayPal request failed", response.status, body);
    throw new HttpError(502, "Payment provider request failed");
  }
  return body;
}

export function createOrder(payload, requestId) {
  return paypal("/v2/checkout/orders", {
    method: "POST",
    headers: { "PayPal-Request-Id": requestId },
    body: JSON.stringify(payload),
  });
}

export function captureOrder(orderId, requestId) {
  if (!/^[A-Z0-9]+$/i.test(orderId)) throw new HttpError(400, "Invalid PayPal order ID");
  return paypal("/v2/checkout/orders/" + encodeURIComponent(orderId) + "/capture", {
    method: "POST",
    headers: { "PayPal-Request-Id": requestId },
    body: "{}",
  });
}

export function completedCapture(order) {
  const captures = order && order.purchase_units && order.purchase_units[0] &&
    order.purchase_units[0].payments && order.purchase_units[0].payments.captures;
  return Array.isArray(captures) ? captures.find((item) => item.status === "COMPLETED") : null;
}

export function vaultDetails(order) {
  const source = order && order.payment_source;
  const paypalVault = source && source.paypal && source.paypal.attributes && source.paypal.attributes.vault;
  const cardVault = source && source.card && source.card.attributes && source.card.attributes.vault;
  const vault = paypalVault || cardVault || {};
  return {
    id: vault.status === "VAULTED" ? vault.id || null : null,
    status: vault.status || "UNAVAILABLE",
    customerId: vault.customer && vault.customer.id ? vault.customer.id : null,
    sourceType: paypalVault ? "paypal" : cardVault ? "card" : null,
  };
}
