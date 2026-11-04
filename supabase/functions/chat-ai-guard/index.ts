// =====================================================================
//  chat-ai-guard — the chatbot asks permission here (backend enforcement
//  of Human Agent Takeover). Called by n8n only.
//  Auth: header x-ikris-secret = chat_settings.ingest_secret
//
//  POST { action: "check", phone, wa_message_id }
//     → before the AI starts on an incoming message
//     → { ok, allowed, reason: AI_ACTIVE|HUMAN_HANDOVER|CLOSED|DUPLICATE, epoch, chat_history }
//  POST { action: "claim_send", phone, epoch }
//     → immediately before the AI reply is sent to WhatsApp (atomic)
//     → { ok, allowed, reason }
//  A reply is allowed only if the chat is still AI_ACTIVE and nobody took
//  it over since "check" (same epoch). See migrations 009-011.
//
//  Speed: secret check + decision (+ chat history) happen in ONE database
//  call (public.chat_ai_guard). n8n calls it with ?forceFunctionRegion=ap-south-1
//  so it runs next to the database.
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
  if (phone.length < 6) return json(400, { ok: false, error: "phone is required" });
  const action = String(b.action ?? "");
  if (action !== "check" && action !== "claim_send") return json(400, { ok: false, error: "action must be check or claim_send" });
  const epoch = Number.isInteger(Number(b.epoch)) && b.epoch !== null && b.epoch !== undefined ? Number(b.epoch) : -1; // missing epoch never matches → blocked

  const { data, error } = await admin.rpc("chat_ai_guard", {
    p_secret: secret, p_action: action, p_phone: phone,
    p_wa_message_id: String(b.wa_message_id ?? "").slice(0, 200), p_epoch: epoch,
  });
  if (error) return json(500, { ok: false, error: error.message });
  const out = (data ?? {}) as Record<string, unknown>;
  if (out.ok === false && out.error === "unauthorized") return json(401, out);
  return json(200, out);
});
