// =====================================================================
//  chat-history — recent WhatsApp conversation for the n8n chatbot.
//  The chatbot's own short-term memory resets when n8n restarts; this
//  returns the permanent record saved in the dashboard so the bot never
//  asks a customer again for something they already told us.
//
//  POST { phone, limit? }   header x-ikris-secret = chat_settings.ingest_secret
//  → { ok, customer_name, department, inquiry_id, messages: "…transcript…" }
//  Staff are labelled "Ikris team" (the bot must not name staff to customers).
//
//  Speed: the secret check and the transcript are done by ONE database call
//  (public.chat_bot_history, migration 010) — this function often runs far
//  from the database, so every extra query costs a long round trip.
//  (The live chatbot now gets the history from chat-ai-guard "check".)
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
  const secret = (req.headers.get("x-ikris-secret") ?? "").trim();
  if (!secret) return json(401, { ok: false, error: "unauthorized" });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(400, { ok: false, error: "invalid JSON" }); }
  const phone = String(b.phone ?? "").replace(/\D/g, "");
  if (phone.length < 8) return json(400, { ok: false, error: "phone is required" });
  const limit = Math.min(Math.max(Number(b.limit) || 20, 4), 40);

  const { data, error } = await admin.rpc("chat_bot_history", { p_secret: secret, p_phone: phone, p_limit: limit });
  if (error) return json(500, { ok: false, error: error.message });
  const out = (data ?? {}) as Record<string, unknown>;
  if (out.ok === false && out.error === "unauthorized") return json(401, out);
  return json(200, out);
});
