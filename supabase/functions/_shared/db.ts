import { HttpError } from "./http.ts";

function requiredEnv(name) {
  const value = Deno.env.get(name);
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

const baseUrl = () => requiredEnv("SUPABASE_URL").replace(/\/$/, "");
const serviceKey = () => requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

export async function db(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("apikey", serviceKey());
  headers.set("authorization", "Bearer " + serviceKey());
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  const response = await fetch(baseUrl() + "/rest/v1/" + path, { ...init, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    console.error("Database request failed", response.status, body);
    throw new HttpError(500, "Database operation failed");
  }
  return body;
}

export function rpc(name, payload) {
  return db("rpc/" + name, { method: "POST", body: JSON.stringify(payload) });
}

export function selectOne(table, query) {
  return db(table + "?" + query, {
    headers: { accept: "application/vnd.pgrst.object+json" },
  });
}

export function patch(table, query, values) {
  return db(table + "?" + query, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify(values),
  });
}
