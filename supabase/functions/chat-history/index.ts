// =====================================================================
//  chat-history — recent WhatsApp conversation for the n8n chatbot.
//  The chatbot's own short-term memory resets when n8n restarts; this
//  returns the permanent record saved in the dashboard so the bot never
//  asks a customer again for something they already told us.
//
//  POST { phone, limit? }   header x-ikris-secret = chat_settings.ingest_secret
//  → { ok, customer_name, department, inquiry_id, messages: "…transcript…" }
//  Staff are labelled "Ikris team" (the bot must not name staff to customers).
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
const ist = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!safeEqual(req.headers.get("x-ikris-secret") ?? "", await secret())) return json(401, { ok: false, error: "unauthorized" });
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(400, { ok: false, error: "invalid JSON" }); }
  const phone = String(b.phone ?? "").replace(/\D/g, "");
  if (phone.length < 8) return json(400, { ok: false, error: "phone is required" });
  const limit = Math.min(Math.max(Number(b.limit) || 20, 4), 40);

  const { data: conv } = await admin.from("chat_conversations")
    .select("id, customer_name, department, inquiry_id").eq("customer_phone", phone).maybeSingle();
  if (!conv) return json(200, { ok: true, messages: "No earlier conversation with this customer." });

  const { data: rows } = await admin.from("chat_messages")
    .select("created_at, sender_type, body, attachment_name, attachment_type, template_name")
    .eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(limit);
  const lines = (rows ?? []).reverse().map((m) => {
    const who = m.sender_type === "customer" ? "Customer" : m.sender_type === "bot" ? "Ikris Bot (you)"
      : m.sender_type === "system" ? "Inquiry form" : "Ikris team";
    const file = m.attachment_name || m.attachment_type ? ` [sent a file: ${m.attachment_name ?? m.attachment_type}]` : "";
    const text = String(m.body ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    return `[${ist(m.created_at)}] ${who}:${file} ${text}`.trim();
  });
  return json(200, {
    ok: true,
    customer_name: conv.customer_name ?? null,
    department: conv.department ?? null,
    inquiry_id: conv.inquiry_id ?? null,
    messages: lines.length ? lines.join("\n") : "No earlier messages.",
  });
});
