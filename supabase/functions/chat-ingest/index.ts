// =====================================================================
//  chat-ingest — called by n8n for every WhatsApp message (in or out).
//  Auth: header  x-ikris-secret: <chat_settings.ingest_secret>
//
//  POST body (single object or an array of them):
//  {
//    "phone": "918448645084",            // required (any format; digits are kept)
//    "customer_name": "Raman",           // optional
//    "direction": "in" | "out",          // in = from customer, out = bot/agent reply
//    "sender_type": "customer"|"bot"|"agent",   // optional (default: in→customer, out→bot)
//    "sender_name": "Ikris Bot",         // optional
//    "text": "Hello",                    // optional if attachment given
//    "attachment_url": "https://…",      // optional
//    "attachment_type": "image/jpeg",    // optional
//    "attachment_name": "prescription.pdf", // optional
//    "wa_message_id": "wamid.XXX",       // optional, prevents duplicates
//    "timestamp": "2026-10-01T10:00:00Z",// optional
//    "department": "Export",             // optional — routes the chat
//    "assigned_to": "Shilpi",            // optional
//    "inquiry_id": "INQ-…"               // optional
//  }
//  Status updates:  { "event": "status", "wa_message_id": "wamid.XXX", "status": "delivered" }
//  Routing only:    { "phone": "…", "department": "Export", "assigned_to": "Shilpi" }   (no text)
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const clean = (v: unknown, max = 4000) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

let cachedSecret: { value: string; at: number } | null = null;
async function ingestSecret(): Promise<string> {
  if (cachedSecret && Date.now() - cachedSecret.at < 60_000) return cachedSecret.value;
  const { data } = await admin.from("chat_settings").select("value").eq("key", "ingest_secret").maybeSingle();
  cachedSecret = { value: data?.value ?? "", at: Date.now() };
  return cachedSecret.value;
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const DELIVERY = ["queued", "sent", "delivered", "read", "failed"];

async function handleOne(item: Record<string, unknown>) {
  // Delivery status update for an outgoing message
  if (item.event === "status") {
    const wa = clean(item.wa_message_id, 200);
    const st = String(item.status || "").toLowerCase();
    if (!wa || !DELIVERY.includes(st)) return { ok: false, error: "wa_message_id and a valid status are required" };
    const { error } = await admin.from("chat_messages").update({ delivery_status: st }).eq("wa_message_id", wa);
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  const phone = String(item.phone ?? "").replace(/\D/g, "");
  if (phone.length < 6) return { ok: false, error: "phone is required" };

  const direction = item.direction === "out" ? "out" : "in";
  const senderType = ["customer", "bot", "agent", "system"].includes(String(item.sender_type))
    ? String(item.sender_type)
    : direction === "in" ? "customer" : "bot";
  const name = clean(item.customer_name, 200);
  const department = clean(item.department, 200);
  const assigned = clean(item.assigned_to, 200);
  const inquiry = clean(item.inquiry_id, 200);

  // Find or create the conversation for this phone number
  const { data: existing, error: findErr } = await admin
    .from("chat_conversations").select("id, customer_name").eq("customer_phone", phone).maybeSingle();
  if (findErr) return { ok: false, error: findErr.message };

  let conversationId = existing?.id as string | undefined;
  const routing: Record<string, unknown> = {};
  if (name && (!existing || !existing.customer_name || direction === "in")) routing.customer_name = name;
  if (department) routing.department = department;
  if (assigned) routing.assigned_to = assigned;
  if (inquiry) routing.inquiry_id = inquiry;

  if (!conversationId) {
    const { data, error } = await admin.from("chat_conversations")
      .insert({ customer_phone: phone, ...routing }).select("id").single();
    if (error) {
      // Created concurrently by another call — fetch it.
      const again = await admin.from("chat_conversations").select("id").eq("customer_phone", phone).maybeSingle();
      if (!again.data) return { ok: false, error: error.message };
      conversationId = again.data.id;
    } else {
      conversationId = data.id;
    }
  } else if (Object.keys(routing).length) {
    const { error } = await admin.from("chat_conversations").update(routing).eq("id", conversationId);
    if (error) return { ok: false, error: error.message };
  }

  const text = clean(item.text ?? item.message ?? item.body, 8000);
  const attachmentUrl = clean(item.attachment_url ?? item.media_url, 2000);
  if (!text && !attachmentUrl) return { ok: true, conversation_id: conversationId, message_id: null };

  const ts = clean(item.timestamp, 64);
  const created = ts && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString() : new Date().toISOString();
  const row = {
    conversation_id: conversationId,
    direction,
    sender_type: senderType,
    sender_name: clean(item.sender_name, 200) ?? (senderType === "bot" ? "Ikris Bot" : name),
    body: text,
    attachment_url: attachmentUrl,
    attachment_type: clean(item.attachment_type ?? item.media_type, 200),
    attachment_name: clean(item.attachment_name ?? item.file_name, 300),
    wa_message_id: clean(item.wa_message_id, 200),
    delivery_status: direction === "in" ? "received" : "sent",
    is_read: direction === "out",
    created_at: created,
  };

  const { data: msg, error: msgErr } = await admin.from("chat_messages").insert(row).select("id").single();
  if (msgErr) {
    if (msgErr.code === "23505") return { ok: true, duplicate: true, conversation_id: conversationId };
    return { ok: false, error: msgErr.message };
  }
  return { ok: true, conversation_id: conversationId, message_id: msg.id };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
  const secret = await ingestSecret();
  if (!safeEqual(req.headers.get("x-ikris-secret") ?? "", secret)) return json(401, { ok: false, error: "unauthorized" });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid JSON" });
  }
  const items = Array.isArray(body) ? body : [body];
  if (!items.length || items.length > 200) return json(400, { ok: false, error: "send 1–200 items" });

  const results = [];
  for (const it of items) {
    try {
      results.push(await handleOne((it ?? {}) as Record<string, unknown>));
    } catch (e) {
      console.error(e);
      results.push({ ok: false, error: "server error" });
    }
  }
  const allOk = results.every((r) => r.ok);
  return json(allOk ? 200 : 207, Array.isArray(body) ? { ok: allOk, results } : results[0]);
});
