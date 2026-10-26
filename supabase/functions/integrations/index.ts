// =====================================================================
//  integrations — Ikris API Integration Center (server side)
//
//  Who can call:
//    • admin staff  (Authorization: Bearer <supabase user token>)     → management actions
//    • internal     (x-ikris-secret = chat_settings.ingest_secret)     → enqueue / dispatch / request
//    • project key  (x-ikris-key = key from "Project API keys")        → request (allowed integrations only)
//
//  Credentials live encrypted in Supabase Vault and are only decrypted here.
//  They are never returned to the browser, written to logs or sent to callback URLs.
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ikris-key, x-ikris-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class Fail extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const clean = (v: unknown, max = 500) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

// ---------------------------------------------------------------- settings
const cache = new Map<string, { v: string; at: number }>();
async function setting(key: string) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < 60_000) return c.v;
  const { data } = await admin.from("chat_settings").select("value").eq("key", key).maybeSingle();
  const v = (data?.value ?? "").trim();
  cache.set(key, { v, at: Date.now() });
  return v;
}
function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------- crypto helpers
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(s: string) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
function randomToken(prefix: string, bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const hint = (s: string) => (s.length <= 4 ? "••••" : "••••" + s.slice(-4));

// ---------------------------------------------------------------- vault
async function putSecret(id: string | null, secret: string, label: string) {
  const { data, error } = await admin.rpc("integ_put_secret", { p_id: id, p_secret: secret, p_label: label });
  if (error) throw new Fail(500, "Could not store the credential securely.");
  return data as string;
}
async function readSecret(id: string | null) {
  if (!id) return null;
  const { data, error } = await admin.rpc("integ_read_secret", { p_id: id });
  if (error) throw new Fail(500, "Could not read the stored credential.");
  return (data as string | null) ?? null;
}
async function dropSecret(id: string | null) {
  if (id) await admin.rpc("integ_drop_secret", { p_id: id });
}

// ---------------------------------------------------------------- audit + rate limit
async function audit(actor: string, action: string, target: string | null, details: Record<string, unknown> = {}) {
  await admin.from("integration_audit").insert({ actor, action, target, details });
}
async function rateLimit(actor: string, actions: string[], max: number, seconds = 60) {
  const since = new Date(Date.now() - seconds * 1000).toISOString();
  const { count } = await admin.from("integration_audit").select("id", { count: "exact", head: true })
    .eq("actor", actor).in("action", actions).gte("created_at", since);
  if ((count ?? 0) >= max) throw new Fail(429, "Too many attempts. Please wait a minute and try again.");
}

// ---------------------------------------------------------------- metrics
async function metric(row: { integration: string; endpoint?: string | null; method?: string; status_code?: number | null; ok: boolean; duration_ms?: number; error?: string | null; source?: string; client_id?: string | null }) {
  await admin.from("integration_metrics").insert({
    ...row,
    endpoint: row.endpoint ? String(row.endpoint).split("?")[0].slice(0, 200) : null,
    error: row.error ? redact(String(row.error)).slice(0, 300) : null,
  });
}
function redact(s: string) {
  return s
    .replace(/(bearer\s+)[\w\-.~+/=]{8,}/gi, "$1[redacted]")
    .replace(/\b(sk|pk|key|token|secret|ikr|whsec)[-_][\w\-]{8,}/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[redacted]");
}

// ---------------------------------------------------------------- SSRF guard
function ipv4Private(ip: string) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}
function ipv6Private(ip: string) {
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("::ffff:")) return ipv4Private(s.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
}
async function checkUrl(raw: string, purpose: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Fail(400, `${purpose}: enter a full URL starting with https://`); }
  if (u.protocol !== "https:") throw new Fail(400, `${purpose}: only https:// URLs are allowed.`);
  if (u.username || u.password) throw new Fail(400, `${purpose}: do not put a username or password inside the URL.`);
  if (u.port && u.port !== "443") throw new Fail(400, `${purpose}: only the standard HTTPS port (443) is allowed.`);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host) || host.endsWith(".supabase.internal")) {
    throw new Fail(400, `${purpose}: this host is not allowed (local or internal address).`);
  }
  if (/^[\d.]+$/.test(host)) { if (ipv4Private(host)) throw new Fail(400, `${purpose}: private or reserved IP addresses are not allowed.`); return u; }
  if (host.includes(":")) { if (ipv6Private(host)) throw new Fail(400, `${purpose}: private or reserved IP addresses are not allowed.`); return u; }
  let ips: string[] = [];
  try {
    const [a4, a6] = await Promise.all([
      Deno.resolveDns(host, "A").catch(() => [] as string[]),
      Deno.resolveDns(host, "AAAA").catch(() => [] as string[]),
    ]);
    ips = [...a4, ...a6];
  } catch { ips = []; }
  if (!ips.length) throw new Fail(400, `${purpose}: the domain "${host}" could not be found (DNS).`);
  if (ips.some((ip) => (ip.includes(":") ? ipv6Private(ip) : ipv4Private(ip)))) {
    throw new Fail(400, `${purpose}: "${host}" points to a private or internal network address.`);
  }
  return u;
}

async function safeFetch(url: string, init: RequestInit, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, redirect: "manual", signal: ctrl.signal });
    const text = await res.text().catch(() => "");
    const ms = Math.round(performance.now() - t0);
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, ms, text: "", headers: res.headers, error: "The server answered with a redirect; redirects are not followed for security." };
    }
    return { ok: res.ok, status: res.status, ms, text, headers: res.headers, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    return { ok: false, status: 0, ms, text: "", error: (e as Error).name === "AbortError" ? "Timed out." : "Could not connect." };
  } finally {
    clearTimeout(timer);
  }
}
const parseJson = (t: string) => { try { return JSON.parse(t); } catch { return null; } };

// ---------------------------------------------------------------- providers
const PROVIDERS: Record<string, { label: string; base?: string; auth?: string; header?: string; test?: string }> = {
  openai:         { label: "OpenAI", base: "https://api.openai.com/v1", auth: "bearer", test: "/models" },
  openrouter:     { label: "OpenRouter", base: "https://openrouter.ai/api/v1", auth: "bearer", test: "/key" },
  whatsapp_cloud: { label: "WhatsApp Cloud API", base: "https://graph.facebook.com/v23.0", auth: "bearer", test: "/me" },
  cunnekt:        { label: "Cunnekt WhatsApp API", auth: "api_key_header" },
  sendgrid:       { label: "SendGrid (email)", base: "https://api.sendgrid.com/v3", auth: "bearer", test: "/scopes" },
  resend:         { label: "Resend (email)", base: "https://api.resend.com", auth: "bearer", test: "/domains" },
  hubspot:        { label: "HubSpot CRM", base: "https://api.hubapi.com", auth: "bearer", test: "/crm/v3/objects/contacts?limit=1" },
  custom_rest:    { label: "Custom REST API" },
  n8n:            { label: "n8n" },
  apps_script:    { label: "Google Apps Script" },
};
const AUTH_TYPES = ["none", "bearer", "api_key_header", "basic", "oauth2_client"];
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "cookie", "authorization", "proxy-authorization"]);

type Integration = Record<string, any>;

async function authHeaders(integ: Integration, secret: string | null): Promise<Record<string, string>> {
  const h: Record<string, string> = {};
  const custom = (integ.config?.headers ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(custom)) if (HEADER_RE.test(k) && !FORBIDDEN_HEADERS.has(k.toLowerCase())) h[k] = String(v).slice(0, 500);
  switch (integ.auth_type) {
    case "none": break;
    case "bearer":
      if (!secret) throw new Fail(400, "No credential is saved for this integration.");
      h["Authorization"] = `Bearer ${secret}`; break;
    case "api_key_header":
      if (!secret) throw new Fail(400, "No credential is saved for this integration.");
      h[integ.auth_header || "X-API-Key"] = secret; break;
    case "basic":
      if (!secret || !secret.includes(":")) throw new Fail(400, "Basic authentication needs the credential as username:password.");
      h["Authorization"] = `Basic ${btoa(secret)}`; break;
    case "oauth2_client": {
      const c = parseJson(secret ?? "") ?? {};
      if (!c.token_url || !c.client_id || !c.client_secret) throw new Fail(400, "OAuth 2.0 needs token_url, client_id and client_secret.");
      await checkUrl(c.token_url, "Token URL");
      const body = new URLSearchParams({ grant_type: "client_credentials", client_id: c.client_id, client_secret: c.client_secret, ...(c.scope ? { scope: c.scope } : {}) });
      const r = await safeFetch(c.token_url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      const t = parseJson(r.text);
      if (!r.ok || !t?.access_token) throw new Fail(400, `OAuth token request failed (${r.status || "no response"}).`);
      h["Authorization"] = `Bearer ${t.access_token}`; break;
    }
    default: throw new Fail(400, "This integration is managed outside the center.");
  }
  return h;
}

function joinUrl(base: string, path: string) {
  const b = new URL(base);
  if (!path.startsWith("/") || path.includes("..") || path.includes("\\") || /^\/\//.test(path)) throw new Fail(400, "Path must start with / and stay on the integration's server.");
  const full = new URL(b.pathname.replace(/\/$/, "") + path, b.origin);
  if (full.origin !== b.origin) throw new Fail(400, "Path must stay on the integration's server.");
  return full;
}

// ---------------------------------------------------------------- connection tests
async function testManaged(integ: Integration, userToken: string | null) {
  const secretHdr = { "Content-Type": "application/json", "x-ikris-secret": await setting("send_webhook_secret") };
  if (integ.slug === "whatsapp_cloud") {
    const url = await setting("wa_api_webhook_url");
    const r = await safeFetch(url, { method: "POST", headers: secretHdr, body: JSON.stringify({ action: "list_templates" }) }, 30000);
    const out = parseJson(r.text);
    const ok = r.ok && out?.ok !== false && !out?.data?.error;
    const n = Array.isArray(out?.data?.data) ? out.data.data.length : null;
    return { ok, http: out?.status ?? r.status, ms: r.ms, message: ok ? `Meta answered: ${n ?? 0} message template(s) on the WhatsApp Business account.` : (out?.data?.error?.message ?? out?.error ?? r.error ?? "WhatsApp did not answer."), endpoint: "message_templates (via n8n)" };
  }
  if (integ.slug === "openrouter") {
    const url = await setting("openrouter_health_url");
    if (!url) return { ok: false, http: 0, ms: 0, message: "Health check URL is not configured.", endpoint: "key" };
    const r = await safeFetch(url, { method: "POST", headers: secretHdr, body: "{}" }, 20000);
    const out = parseJson(r.text);
    const ok = r.ok && out?.ok === true;
    return { ok, http: out?.status ?? r.status, ms: r.ms, endpoint: "key (via n8n)",
      message: ok ? "OpenRouter accepted the API key." : (out?.error ?? r.error ?? "OpenRouter did not answer."),
      details: ok && out?.data ? { provider_usage_usd: out.data.usage, usage_today_usd: out.data.usage_daily, usage_month_usd: out.data.usage_monthly, credit_limit_usd: out.data.limit, limit_remaining_usd: out.data.limit_remaining } : undefined };
  }
  if (integ.slug === "n8n_send") {
    const url = await setting("wa_media_get_url");
    const r = await safeFetch(url, { method: "POST", headers: secretHdr, body: JSON.stringify({ media_id: "healthcheck" }) }, 20000);
    // The media workflow answers 404 "media not found" for an unknown id: that proves n8n is up and the secret is accepted.
    const out = parseJson(r.text);
    const ok = r.status === 404 && out?.ok === false && out?.error !== "unauthorized";
    return { ok, http: r.status, ms: r.ms, endpoint: "ikris-wa-media-get", message: ok ? "n8n webhooks are reachable and accept the shared secret." : (r.status === 401 ? "n8n rejected the shared secret." : r.error ?? `Unexpected answer (${r.status}).`) };
  }
  if (integ.slug === "google_sheet") {
    if (!userToken) return { ok: false, http: 0, ms: 0, message: "Sign in again to test.", endpoint: "dashboard_inquiries" };
    const url = `${integ.base_url}?action=dashboard_inquiries&token=${encodeURIComponent(userToken)}`;
    const r = await safeFetch(url, { method: "GET" }, 60000);
    // Apps Script answers through a redirect to googleusercontent.com; follow only that one hop.
    let res = r;
    if (r.status === 302 || r.status === 301) {
      const loc = (r as any).headers?.get("location") ?? "";
      if (/^https:\/\/script\.googleusercontent\.com\//.test(loc)) res = await safeFetch(loc, { method: "GET" }, 60000);
    }
    const out = parseJson(res.text);
    const rows = Array.isArray(out?.data?.rows) ? out.data.rows.length : null;
    const ok = res.ok && out?.ok === true;
    return { ok, http: res.status, ms: r.ms + (res === r ? 0 : res.ms), endpoint: "dashboard_inquiries",
      message: ok ? `Apps Script answered: ${rows ?? 0} enquiry row(s) readable.` : String(out?.error?.message ?? out?.error ?? res.error ?? "Apps Script did not answer.") };
  }
  return { ok: false, http: 0, ms: 0, message: "No test is available for this integration.", endpoint: null };
}

async function testCenter(integ: Integration, secretOverride?: string | null) {
  if (!integ.base_url) return { ok: false, http: 0, ms: 0, message: "Set a base URL first.", endpoint: null };
  const path = String(integ.config?.test_path || PROVIDERS[integ.provider]?.test || "");
  if (!path) return { ok: false, http: 0, ms: 0, message: "Set a test path (for example /status) so the connection can be checked.", endpoint: null, untestable: true };
  await checkUrl(integ.base_url, "Base URL");
  const secret = secretOverride !== undefined ? secretOverride : await readSecret(integ.secret_id);
  const headers = await authHeaders(integ, secret);
  const url = joinUrl(integ.base_url, path);
  const r = await safeFetch(url.toString(), { method: "GET", headers: { Accept: "application/json", ...headers } });
  const body = parseJson(r.text);
  const providerMsg = clean(body?.error?.message ?? body?.message ?? body?.error ?? "", 200);
  return {
    ok: r.ok, http: r.status, ms: r.ms, endpoint: url.pathname,
    message: r.ok ? "Connected - the provider accepted the credential." :
      r.status === 401 || r.status === 403 ? `The provider rejected the credential (${r.status}).${providerMsg ? " " + redact(providerMsg) : ""}` :
      `${r.error ?? "Request failed"}${providerMsg ? ": " + redact(providerMsg) : ""}`,
  };
}

// ---------------------------------------------------------------- management actions
async function getIntegration(id: string) {
  const { data } = await admin.from("integrations").select("*").eq("id", id).maybeSingle();
  if (!data) throw new Fail(404, "Integration not found.");
  return data as Integration;
}
function publicView(i: Integration) {
  const { secret_id: _s, ...rest } = i;
  return rest;
}
function validConfig(raw: unknown) {
  const cfg = (raw && typeof raw === "object" && !Array.isArray(raw)) ? { ...(raw as Record<string, unknown>) } : {};
  if (JSON.stringify(cfg).length > 4000) throw new Fail(400, "Additional configuration is too large (max 4 KB).");
  if (cfg.headers !== undefined) {
    if (typeof cfg.headers !== "object" || Array.isArray(cfg.headers)) throw new Fail(400, "Custom headers must be name: value pairs.");
    for (const k of Object.keys(cfg.headers as object)) {
      if (!HEADER_RE.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new Fail(400, `Header "${k}" is not allowed.`);
    }
  }
  if (cfg.test_path !== undefined && cfg.test_path !== "" && !/^\/[^\s]*$/.test(String(cfg.test_path))) throw new Fail(400, "Test path must start with /.");
  return cfg;
}
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "api";

async function saveIntegration(actor: string, b: Record<string, any>) {
  const name = clean(b.name, 80);
  if (!name) throw new Fail(400, "Give the integration a name.");
  if (b.id) {
    const cur = await getIntegration(String(b.id));
    if (cur.managed_by !== "center") {
      await admin.from("integrations").update({ name, updated_by: actor, updated_at: new Date().toISOString() }).eq("id", cur.id);
      await audit(actor, "integration.rename", cur.slug, { name });
      return { ok: true };
    }
  }
  const provider = String(b.provider ?? "");
  if (!PROVIDERS[provider] || ["n8n", "apps_script"].includes(provider)) throw new Fail(400, "Choose a provider.");
  const auth_type = String(b.auth_type ?? "bearer");
  if (!AUTH_TYPES.includes(auth_type)) throw new Fail(400, "Choose an authentication type.");
  const base_url = clean(b.base_url, 300);
  if (!base_url) throw new Fail(400, "Enter the base API URL.");
  await checkUrl(base_url, "Base URL");
  const auth_header = auth_type === "api_key_header" ? clean(b.auth_header, 64) ?? "X-API-Key" : null;
  if (auth_header && !HEADER_RE.test(auth_header)) throw new Fail(400, "Header name may contain only letters, numbers and - _ .");
  const config = validConfig(b.config);
  const secret = typeof b.secret === "string" && b.secret.trim() ? b.secret.trim() : null;
  if (secret && secret.length > 8000) throw new Fail(400, "Credential is too long.");
  if (auth_type === "basic" && secret && !secret.includes(":")) throw new Fail(400, "Basic authentication: enter username:password.");
  if (auth_type === "oauth2_client" && secret) {
    const c = parseJson(secret);
    if (!c?.token_url || !c?.client_id || !c?.client_secret) throw new Fail(400, 'OAuth 2.0: enter {"token_url": "...", "client_id": "...", "client_secret": "...", "scope": "..."}.');
  }
  const now = new Date().toISOString();
  if (b.id) {
    const cur = await getIntegration(String(b.id));
    const patch: Record<string, unknown> = { name, provider, base_url, auth_type, auth_header, config, updated_by: actor, updated_at: now };
    if (secret) {
      patch.secret_id = await putSecret(cur.secret_id, secret, `integration ${cur.slug}`);
      patch.secret_hint = hint(secret);
      patch.rotated_at = now;
      patch.status = "untested";
    }
    if (auth_type === "none") patch.secret_hint = null;
    await admin.from("integrations").update(patch).eq("id", cur.id);
    await audit(actor, "integration.update", cur.slug, { fields: Object.keys(patch).filter((k) => !["secret_id"].includes(k)), credential_changed: !!secret });
    return { ok: true, id: cur.id };
  }
  let slug = slugify(clean(b.slug, 40) ?? name);
  const { data: clash } = await admin.from("integrations").select("id").eq("slug", slug).maybeSingle();
  if (clash) slug = `${slug}_${Math.random().toString(36).slice(2, 6)}`;
  if (auth_type !== "none" && !secret) throw new Fail(400, "Enter the API key or token.");
  const secret_id = secret ? await putSecret(null, secret, `integration ${slug}`) : null;
  const { data, error } = await admin.from("integrations").insert({
    slug, name, provider, base_url, auth_type, auth_header, config, managed_by: "center",
    secret_id, secret_hint: secret ? hint(secret) : null, created_by: actor, updated_by: actor, rotated_at: secret ? now : null,
  }).select("id, slug").single();
  if (error) { await dropSecret(secret_id); throw new Fail(400, "Could not save the integration."); }
  await audit(actor, "integration.create", data.slug, { provider, auth_type });
  return { ok: true, id: data.id, slug: data.slug };
}

async function runTest(actor: string, integ: Integration, userToken: string | null) {
  const t = integ.managed_by === "center" ? await testCenter(integ) : await testManaged(integ, userToken);
  const now = new Date().toISOString();
  const last_test = { ok: t.ok, http: t.http, ms: t.ms, message: typeof t.message === "string" ? t.message : JSON.stringify(t.message), endpoint: t.endpoint, details: (t as any).details ?? null, by: actor, at: now };
  await admin.from("integrations").update({ status: integ.enabled ? (t.ok ? "connected" : "failed") : "disabled", last_tested_at: now, last_test }).eq("id", integ.id);
  await metric({ integration: integ.slug, endpoint: t.endpoint ?? "test", method: "TEST", status_code: t.http || null, ok: t.ok, duration_ms: t.ms, error: t.ok ? null : t.message, source: "connection-test" });
  await audit(actor, "integration.test", integ.slug, { ok: t.ok, http: t.http });
  return { ok: true, test: last_test };
}

async function rotate(actor: string, b: Record<string, any>) {
  const integ = await getIntegration(String(b.id));
  if (integ.managed_by !== "center") throw new Fail(400, "This credential is managed in n8n - rotate it in the provider's dashboard and update the n8n credential.");
  const secret = typeof b.secret === "string" ? b.secret.trim() : "";
  if (!secret) throw new Fail(400, "Enter the new credential.");
  const t = await testCenter(integ, secret);
  if (!t.ok && !((t as any).untestable && b.activate_untested === true)) {
    await audit(actor, "integration.rotate_rejected", integ.slug, { http: t.http });
    return { ok: false, error: `The new credential was NOT activated: ${t.message}`, test: t };
  }
  const now = new Date().toISOString();
  const secret_id = await putSecret(integ.secret_id, secret, `integration ${integ.slug}`);
  await admin.from("integrations").update({
    secret_id, secret_hint: hint(secret), rotated_at: now, updated_by: actor, updated_at: now,
    status: t.ok ? "connected" : "untested", last_tested_at: t.ok ? now : integ.last_tested_at,
    last_test: t.ok ? { ok: true, http: t.http, ms: t.ms, message: "New credential tested and activated.", endpoint: t.endpoint, by: actor, at: now } : integ.last_test,
  }).eq("id", integ.id);
  await audit(actor, "integration.rotate", integ.slug, { tested: t.ok });
  return { ok: true, tested: t.ok };
}

// ---------------------------------------------------------------- reusable request service
async function proxyRequest(caller: { actor: string; clientId: string | null; allowed: string[] | null }, b: Record<string, any>) {
  const slug = String(b.integration ?? "");
  const { data: integ } = await admin.from("integrations").select("*").eq("slug", slug).maybeSingle();
  if (!integ) throw new Fail(404, "Unknown integration.");
  if (caller.allowed && !caller.allowed.includes(slug)) throw new Fail(403, "This key may not use that integration.");
  if (!integ.enabled) throw new Fail(409, "This integration is disabled.");
  if (integ.managed_by !== "center") throw new Fail(400, "This integration is managed in n8n; call its n8n workflow instead.");
  if (caller.clientId) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await admin.from("integration_metrics").select("id", { count: "exact", head: true }).eq("client_id", caller.clientId).gte("created_at", since);
    if ((count ?? 0) >= 60) throw new Fail(429, "Rate limit: max 60 requests per minute per key.");
  }
  const method = String(b.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Fail(400, "Unsupported method.");
  await checkUrl(integ.base_url, "Base URL");
  const url = joinUrl(integ.base_url, String(b.path ?? "/"));
  if (b.query && typeof b.query === "object") for (const [k, v] of Object.entries(b.query)) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Accept: "application/json", ...(await authHeaders(integ, await readSecret(integ.secret_id))) };
  if (b.headers && typeof b.headers === "object") {
    for (const [k, v] of Object.entries(b.headers)) if (HEADER_RE.test(k) && !FORBIDDEN_HEADERS.has(k.toLowerCase()) && !(k in headers)) headers[k] = String(v).slice(0, 500);
  }
  let body: string | undefined;
  if (b.body !== undefined && method !== "GET") { body = typeof b.body === "string" ? b.body : JSON.stringify(b.body); headers["Content-Type"] ??= "application/json"; }
  if (body && body.length > 1_000_000) throw new Fail(413, "Request body too large.");
  const r = await safeFetch(url.toString(), { method, headers, body }, 30000);
  await metric({ integration: slug, endpoint: url.pathname, method, status_code: r.status || null, ok: r.ok, duration_ms: r.ms, error: r.ok ? null : r.error, source: caller.clientId ? "project-key" : "request", client_id: caller.clientId });
  if (caller.clientId) await admin.from("integration_clients").update({ last_used_at: new Date().toISOString() }).eq("id", caller.clientId);
  return { ok: r.ok, status: r.status, data: parseJson(r.text) ?? r.text.slice(0, 1_000_000), error: r.ok ? null : r.error };
}

// ---------------------------------------------------------------- webhooks (callback URLs)
const EVENTS = ["message.received", "message.status"];

async function saveWebhook(actor: string, b: Record<string, any>) {
  const name = clean(b.name, 80) ?? "Callback";
  const url = clean(b.url, 500);
  if (!url) throw new Fail(400, "Enter the callback URL.");
  await checkUrl(url, "Callback URL");
  const events = Array.isArray(b.events) ? b.events.filter((e: string) => EVENTS.includes(e)) : EVENTS;
  if (!events.length) throw new Fail(400, "Choose at least one event.");
  const enabled = b.enabled !== false;
  const now = new Date().toISOString();
  if (b.id) {
    const { data: cur } = await admin.from("webhook_endpoints").select("id, url").eq("id", String(b.id)).maybeSingle();
    if (!cur) throw new Fail(404, "Callback not found.");
    await admin.from("webhook_endpoints").update({ name, url, events, enabled, status: enabled ? (cur.url === url ? undefined : "untested") : "disabled", updated_at: now }).eq("id", cur.id);
    await audit(actor, "webhook.update", cur.id, { url_changed: cur.url !== url, events, enabled });
    return { ok: true, id: cur.id };
  }
  const secret = randomToken("whsec_");
  const secret_id = await putSecret(null, secret, "webhook signing secret");
  const { data, error } = await admin.from("webhook_endpoints").insert({ name, url, events, enabled, secret_id, secret_hint: hint(secret), created_by: actor })
    .select("id").single();
  if (error) { await dropSecret(secret_id); throw new Fail(400, "Could not save the callback."); }
  await audit(actor, "webhook.create", data.id, { events });
  return { ok: true, id: data.id, signing_secret: secret };
}

async function deliver(row: Record<string, any>, endpoint: Record<string, any>) {
  const secret = await readSecret(endpoint.secret_id);
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ id: row.event_id, type: row.event_type, created_at: row.created_at, test: row.is_test, data: row.payload ?? {} });
  const sig = secret ? await hmac(secret, `${ts}.${body}`) : "";
  let res;
  try { await checkUrl(endpoint.url, "Callback URL"); res = await safeFetch(endpoint.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Ikris-Webhooks/1.0", "X-Ikris-Event-Id": row.event_id, "X-Ikris-Event-Type": row.event_type, "X-Ikris-Timestamp": ts, "X-Ikris-Signature": `v1=${sig}` },
      body,
    }, 10000);
  } catch (e) { res = { ok: false, status: 0, ms: 0, text: "", error: (e as Error).message }; }
  const attempts = (row.attempts ?? 0) + 1;
  const now = new Date().toISOString();
  const err = res.ok ? null : (res.error ?? `HTTP ${res.status}`) + (res.text ? ` – ${redact(res.text.slice(0, 120))}` : "");
  const finalFail = !res.ok && (attempts >= 5 || row.is_test);
  await admin.from("webhook_deliveries").update({
    attempts, status_code: res.status || null, duration_ms: res.ms, error: err,
    status: res.ok ? "delivered" : finalFail ? "failed" : "pending",
    next_attempt_at: new Date(Date.now() + 30_000 * Math.pow(4, attempts - 1)).toISOString(),   // 30s, 2m, 8m, 32m
    delivered_at: res.ok ? now : null,
    payload: res.ok || finalFail ? null : row.payload,                                         // don't keep message data longer than needed
  }).eq("id", row.id);
  await admin.from("webhook_endpoints").update({
    last_delivery_at: now, last_status_code: res.status || null, last_error: err,
    status: endpoint.enabled ? (res.ok ? "healthy" : "failing") : "disabled",
  }).eq("id", endpoint.id);
  await metric({ integration: "callback", endpoint: new URL(endpoint.url).hostname, method: "POST", status_code: res.status || null, ok: res.ok, duration_ms: res.ms, error: err, source: row.is_test ? "webhook-test" : "webhook" });
  return { ok: res.ok, status: res.status, ms: res.ms, error: err, attempts };
}

async function dispatchDue(limit = 25) {
  const { data: due } = await admin.from("webhook_deliveries").select("*").eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString()).order("next_attempt_at").limit(limit);
  if (!due?.length) return { processed: 0 };
  const ids = [...new Set(due.map((d) => d.endpoint_id))];
  const { data: eps } = await admin.from("webhook_endpoints").select("*").in("id", ids);
  const byId = new Map((eps ?? []).map((e) => [e.id, e]));
  let n = 0;
  for (const d of due) {
    const ep = byId.get(d.endpoint_id);
    if (!ep || !ep.enabled) { await admin.from("webhook_deliveries").update({ status: "failed", error: "Callback disabled", payload: null }).eq("id", d.id); continue; }
    // Claim it so two dispatchers never send the same event twice.
    const { data: claimed } = await admin.from("webhook_deliveries").update({ next_attempt_at: new Date(Date.now() + 120_000).toISOString() })
      .eq("id", d.id).eq("status", "pending").lte("next_attempt_at", new Date().toISOString()).select("id");
    if (!claimed?.length) continue;
    await deliver(d, ep);
    n++;
  }
  return { processed: n };
}

async function enqueue(b: Record<string, any>) {
  const type = String(b.event_type ?? "");
  if (!EVENTS.includes(type)) throw new Fail(400, "Unknown event type.");
  const { data: eps } = await admin.from("webhook_endpoints").select("id, events").eq("enabled", true);
  const targets = (eps ?? []).filter((e) => (e.events ?? []).includes(type));
  if (!targets.length) return { queued: 0 };
  const eventId = clean(b.event_id, 120) ?? crypto.randomUUID();
  await admin.from("webhook_deliveries").upsert(
    targets.map((e) => ({ endpoint_id: e.id, event_id: eventId, event_type: type, payload: b.data ?? {} })),
    { onConflict: "endpoint_id,event_id", ignoreDuplicates: true },
  );
  return { queued: targets.length, ...(await dispatchDue()) };
}

// ---------------------------------------------------------------- project API keys
async function createClientKey(actor: string, b: Record<string, any>) {
  const name = clean(b.name, 80);
  if (!name) throw new Fail(400, "Name the project that will use this key.");
  const allowed = Array.isArray(b.allowed) ? b.allowed.map(String).filter((s: string) => /^[a-z0-9_-]+$/.test(s)) : [];
  if (!allowed.length) throw new Fail(400, "Choose at least one integration this key may use.");
  const { data: integs } = await admin.from("integrations").select("slug").in("slug", allowed).eq("managed_by", "center");
  if ((integs ?? []).length !== allowed.length) throw new Fail(400, "Keys can only use integrations configured in this center.");
  const days = Number(b.expires_days ?? 90);
  const expires_at = days > 0 ? new Date(Date.now() + Math.min(days, 730) * 86400_000).toISOString() : null;
  const key = randomToken("ikr_live_", 32);
  const { data, error } = await admin.from("integration_clients").insert({
    name, key_prefix: key.slice(0, 13), key_hash: await sha256(key), allowed, expires_at, created_by: actor,
  }).select("id").single();
  if (error) throw new Fail(400, "Could not create the key.");
  await audit(actor, "client_key.create", data.id, { name, allowed, expires_at });
  return { ok: true, id: data.id, key };
}

// ---------------------------------------------------------------- entry
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return json(400, { ok: false, error: "Invalid request." }); }
  const action = String(b.action ?? "");

  try {
    // 1) internal calls (other Ikris functions / pg_cron)
    const internal = safeEqual(req.headers.get("x-ikris-secret") ?? "", await setting("ingest_secret"));
    if (internal) {
      if (action === "enqueue") return json(200, { ok: true, ...(await enqueue(b)) });
      if (action === "dispatch") return json(200, { ok: true, ...(await dispatchDue()) });
      if (action === "request") return json(200, await proxyRequest({ actor: "internal", clientId: null, allowed: null }, b));
      return json(400, { ok: false, error: "Unknown action." });
    }

    // 2) project API keys
    const key = req.headers.get("x-ikris-key");
    if (key) {
      const { data: c } = await admin.from("integration_clients").select("*").eq("key_hash", await sha256(key)).maybeSingle();
      if (!c || c.revoked_at || (c.expires_at && new Date(c.expires_at) < new Date())) return json(401, { ok: false, error: "Invalid, expired or revoked API key." });
      if (action !== "request") return json(403, { ok: false, error: "Project keys can only make requests." });
      return json(200, await proxyRequest({ actor: `key:${c.key_prefix}`, clientId: c.id, allowed: c.allowed ?? [] }, b));
    }

    // 3) signed-in admins
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: auth } = await admin.auth.getUser(token);
    const email = auth?.user?.email?.toLowerCase();
    if (!email) return json(401, { ok: false, error: "Please sign in again." });
    const { data: staff } = await admin.from("chat_staff").select("role").eq("email", email).maybeSingle();
    if (staff?.role !== "admin") return json(403, { ok: false, error: "Only administrators can manage integrations." });

    switch (action) {
      case "save":
        await rateLimit(email, ["integration.create", "integration.update", "integration.rename"], 20);
        return json(200, await saveIntegration(email, b));
      case "test": {
        await rateLimit(email, ["integration.test"], 10);
        return json(200, await runTest(email, await getIntegration(String(b.id)), token));
      }
      case "toggle": {
        const integ = await getIntegration(String(b.id));
        const enabled = b.enabled === true;
        await admin.from("integrations").update({ enabled, status: enabled ? (integ.last_test?.ok ? "connected" : "untested") : "disabled", updated_by: email, updated_at: new Date().toISOString() }).eq("id", integ.id);
        await audit(email, enabled ? "integration.enable" : "integration.disable", integ.slug);
        return json(200, { ok: true });
      }
      case "rotate":
        await rateLimit(email, ["integration.rotate", "integration.rotate_rejected"], 5);
        return json(200, await rotate(email, b));
      case "delete": {
        const integ = await getIntegration(String(b.id));
        if (integ.managed_by !== "center") throw new Fail(400, "Integrations used by the live chatbot cannot be deleted here - disable them instead.");
        if (b.confirm !== integ.slug) throw new Fail(400, "Type the integration id to confirm deletion.");
        await admin.from("integrations").delete().eq("id", integ.id);
        await dropSecret(integ.secret_id);
        await audit(email, "integration.delete", integ.slug);
        return json(200, { ok: true });
      }
      case "request":
        await rateLimit(email, ["integration.request"], 30);
        await audit(email, "integration.request", String(b.integration ?? ""), { method: b.method, path: String(b.path ?? "").split("?")[0] });
        return json(200, await proxyRequest({ actor: email, clientId: null, allowed: null }, b));
      case "validate_url": {
        const u = await checkUrl(String(b.url ?? ""), "Callback URL");
        return json(200, { ok: true, message: `${u.hostname} is a valid public HTTPS address.` });
      }
      case "save_webhook":
        await rateLimit(email, ["webhook.create", "webhook.update"], 10);
        return json(200, await saveWebhook(email, b));
      case "regenerate_webhook_secret": {
        await rateLimit(email, ["webhook.secret"], 5);
        const { data: ep } = await admin.from("webhook_endpoints").select("id, secret_id").eq("id", String(b.id)).maybeSingle();
        if (!ep) throw new Fail(404, "Callback not found.");
        const secret = randomToken("whsec_");
        const secret_id = await putSecret(ep.secret_id, secret, "webhook signing secret");
        await admin.from("webhook_endpoints").update({ secret_id, secret_hint: hint(secret), updated_at: new Date().toISOString() }).eq("id", ep.id);
        await audit(email, "webhook.secret", ep.id);
        return json(200, { ok: true, signing_secret: secret });
      }
      case "test_webhook": {
        await rateLimit(email, ["webhook.test"], 6);
        const { data: ep } = await admin.from("webhook_endpoints").select("*").eq("id", String(b.id)).maybeSingle();
        if (!ep) throw new Fail(404, "Callback not found.");
        const eventId = `evt_test_${crypto.randomUUID()}`;
        const { data: row } = await admin.from("webhook_deliveries").insert({
          endpoint_id: ep.id, event_id: eventId, event_type: "test.ping", is_test: true,
          payload: { message: "Test event from the Ikris API Integration Center. No customer data.", sent_by: "admin" },
        }).select("*").single();
        await audit(email, "webhook.test", ep.id);
        const r = await deliver(row!, { ...ep, enabled: true });
        return json(200, { ok: true, delivered: r.ok, status: r.status, ms: r.ms, error: r.error });
      }
      case "delete_webhook": {
        const { data: ep } = await admin.from("webhook_endpoints").select("id, secret_id").eq("id", String(b.id)).maybeSingle();
        if (!ep) throw new Fail(404, "Callback not found.");
        await admin.from("webhook_endpoints").delete().eq("id", ep.id);
        await dropSecret(ep.secret_id);
        await audit(email, "webhook.delete", ep.id);
        return json(200, { ok: true });
      }
      case "retry_deliveries": {
        await admin.from("webhook_deliveries").update({ next_attempt_at: new Date().toISOString() }).eq("status", "pending");
        return json(200, { ok: true, ...(await dispatchDue()) });
      }
      case "create_client_key":
        await rateLimit(email, ["client_key.create"], 5);
        return json(200, await createClientKey(email, b));
      case "revoke_client_key": {
        await admin.from("integration_clients").update({ revoked_at: new Date().toISOString() }).eq("id", String(b.id)).is("revoked_at", null);
        await audit(email, "client_key.revoke", String(b.id));
        return json(200, { ok: true });
      }
      default:
        return json(400, { ok: false, error: "Unknown action." });
    }
  } catch (e) {
    if (e instanceof Fail) return json(e.status, { ok: false, error: e.message });
    console.error("integrations error", redact(String((e as Error)?.message ?? e)));
    return json(500, { ok: false, error: "Server error." });
  }
});
