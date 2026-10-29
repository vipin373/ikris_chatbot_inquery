// =====================================================================
//  chat-ai-guard — the chatbot asks permission here (backend enforcement
//  of Human Agent Takeover). Called by n8n only.
//  Auth: header x-ikris-secret = chat_settings.ingest_secret
//
//  POST { action: "check", phone, wa_message_id }
//     → before the AI starts on an incoming message
//     → { ok, allowed, reason: AI_ACTIVE|HUMAN_HANDOVER|CLOSED|DUPLICATE, epoch }
//  POST { action: "claim_send", phone, epoch }
//     → immediately before the AI reply is sent to WhatsApp (atomic)
//     → { ok, allowed, reason }
//  A reply is allowed only if the chat is still AI_ACTIVE and nobody took
//  it over since "check" (same epoch). See migration 009.
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let cached: { v: string; at: number } | null = null;
async function secret() {
  if (cached && Date.now() - cached.at < 60_000) return cached.v;
  const { data } = await admin.from("chat_settings").select("value").eq("key", "ingest_secret").maybeSingle();
  cached = { v: (data?.value ?? "").trim(), at: Date.now() };
  return cached.v;
}
function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!safeEqual(req.headers.get("x-ikris-secret") ?? "", await secret())) return json(401, { ok: false, error: "unauthorized" });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(400, { ok: false, error: "invalid JSON" }); }

  const phone = String(b.phone ?? "").replace(/\D/g, "");
  if (phone.length < 6) return json(400, { ok: false, error: "phone is required" });

  if (b.action === "check") {
    const { data, error } = await admin.rpc("chat_ai_gate", {
      p_phone: phone, p_wa_message_id: String(b.wa_message_id ?? "").slice(0, 200),
    });
    if (error) return json(500, { ok: false, error: error.message });
    return json(200, { ok: true, ...(data as Record<string, unknown>) });
  }

  if (b.action === "claim_send") {
    const epoch = Number.isInteger(Number(b.epoch)) ? Number(b.epoch) : -1;   // missing epoch never matches → blocked
    const { data, error } = await admin.rpc("chat_ai_claim_send", { p_phone: phone, p_epoch: epoch });
    if (error) return json(500, { ok: false, error: error.message });
    return json(200, { ok: true, ...(data as Record<string, unknown>) });
  }

  return json(400, { ok: false, error: "action must be check or claim_send" });
});
