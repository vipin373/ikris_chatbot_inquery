// =====================================================================
//  chat-send — called by the dashboard when staff reply or start a chat.
//  Auth: the signed-in user's Supabase access token (verify_jwt = true),
//  plus a chat_staff access check on the conversation's department.
//
//  Delivery to WhatsApp: the message is POSTed to the n8n webhook stored
//  in chat_settings.send_webhook_url. n8n sends it through Cunnekt and
//  replies with JSON, e.g. { "ok": true, "wa_message_id": "wamid…" }.
//  If no webhook is configured the message is saved with status not_sent.
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const norm = (t: unknown) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const clean = (v: unknown, max = 4000) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

type Staff = { email: string; display_name: string | null; role: string; departments: string[] };
const canSee = (s: Staff, dep: string | null) =>
  s.role === "admin" || (!!norm(dep) && s.departments.some((d) => norm(d) === norm(dep)));

async function setting(key: string) {
  const { data } = await admin.from("chat_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value ?? "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  // ---- who is calling ----
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !auth?.user?.email) return json(401, { ok: false, code: "UNAUTHORIZED", error: "Session is not valid." });
  const email = auth.user.email.toLowerCase();
  const { data: staff } = await admin.from("chat_staff").select("*").eq("email", email).maybeSingle();
  if (!staff) return json(403, { ok: false, code: "FORBIDDEN", error: "Your account has no chat access." });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "Invalid request." });
  }

  const text = clean(body.text, 4096);
  const attachmentPath = clean(body.attachment_path, 500);
  if (!text && !attachmentPath) return json(400, { ok: false, error: "Type a message or attach a file." });

  // ---- conversation: existing or new ----
  let conv: Record<string, any> | null = null;
  if (body.conversation_id) {
    const { data } = await admin.from("chat_conversations").select("*").eq("id", String(body.conversation_id)).maybeSingle();
    conv = data;
    if (!conv || !canSee(staff, conv.department)) return json(403, { ok: false, code: "FORBIDDEN", error: "You cannot reply in this conversation." });
  } else if (body.new_conversation && typeof body.new_conversation === "object") {
    const n = body.new_conversation as Record<string, unknown>;
    const phone = String(n.phone ?? "").replace(/\D/g, "");
    if (phone.length < 8) return json(400, { ok: false, error: "Enter the customer's WhatsApp number with country code." });
    const department = clean(n.department, 200) ?? (staff.role === "admin" ? null : staff.departments[0]);
    if (!department || !canSee(staff, department)) return json(403, { ok: false, code: "FORBIDDEN", error: "Choose a department you have access to." });

    const { data: existing } = await admin.from("chat_conversations").select("*").eq("customer_phone", phone).maybeSingle();
    if (existing) {
      if (!canSee(staff, existing.department)) {
        return json(409, { ok: false, code: "EXISTS_ELSEWHERE", error: "A conversation with this number already exists in another department. Ask an admin to move it." });
      }
      conv = existing;
    } else {
      const { data, error } = await admin.from("chat_conversations").insert({
        customer_phone: phone,
        customer_name: clean(n.customer_name, 200),
        department,
        assigned_to: clean(n.assigned_to, 200) ?? staff.display_name,
        status: "open",
      }).select("*").single();
      if (error) return json(500, { ok: false, error: "Could not create the conversation." });
      conv = data;
    }
  } else {
    return json(400, { ok: false, error: "No conversation specified." });
  }

  // Attachments must live in this conversation's folder.
  if (attachmentPath && !attachmentPath.startsWith(`${conv!.id}/`)) {
    return json(400, { ok: false, error: "Attachment does not belong to this conversation." });
  }

  // ---- store the outgoing message ----
  const { data: msg, error: msgErr } = await admin.from("chat_messages").insert({
    conversation_id: conv!.id,
    direction: "out",
    sender_type: "agent",
    sender_name: staff.display_name ?? email,
    sender_email: email,
    body: text,
    attachment_path: attachmentPath,
    attachment_type: clean(body.attachment_type, 200),
    attachment_name: clean(body.attachment_name, 300),
    delivery_status: "queued",
    is_read: true,
  }).select("*").single();
  if (msgErr) return json(500, { ok: false, error: "Could not save the message." });

  // Replying re-opens a resolved/closed chat.
  if (["resolved", "closed"].includes(conv!.status)) {
    await admin.from("chat_conversations").update({ status: "open" }).eq("id", conv!.id);
  }

  // ---- deliver through n8n → Cunnekt ----
  const webhook = await setting("send_webhook_url");
  let delivery = "not_sent";
  let errorText: string | null = webhook ? null : "WhatsApp sending is not configured yet (n8n send webhook missing).";
  let waId: string | null = null;

  if (webhook) {
    let mediaUrl: string | null = null;
    if (attachmentPath) {
      const { data: signed } = await admin.storage.from("chat-attachments").createSignedUrl(attachmentPath, 60 * 60 * 24 * 7);
      mediaUrl = signed?.signedUrl ?? null;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(webhook, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "x-ikris-secret": await setting("send_webhook_secret") },
        body: JSON.stringify({
          to: conv!.customer_phone,
          customer_name: conv!.customer_name,
          text,
          media_url: mediaUrl,
          media_type: clean(body.attachment_type, 200),
          file_name: clean(body.attachment_name, 300),
          message_id: msg.id,
          conversation_id: conv!.id,
          department: conv!.department,
          agent: { email, name: staff.display_name },
        }),
      });
      const raw = await res.text();
      let out: Record<string, unknown> = {};
      try { out = JSON.parse(raw); } catch { /* plain-text reply */ }
      if (res.ok && out.ok !== false) {
        delivery = "sent";
        waId = clean(out.wa_message_id ?? out.message_id ?? out.id, 200);
      } else {
        delivery = "failed";
        errorText = clean(out.error ?? out.message ?? raw, 500) ?? `HTTP ${res.status}`;
      }
    } catch (e) {
      delivery = "failed";
      errorText = (e as Error).name === "AbortError" ? "WhatsApp gateway timed out." : "Could not reach the WhatsApp gateway.";
    } finally {
      clearTimeout(timer);
    }
  }

  const { data: finalMsg } = await admin.from("chat_messages")
    .update({ delivery_status: delivery, error: errorText, wa_message_id: waId })
    .eq("id", msg.id).select("*").single();

  return json(200, { ok: true, sent: delivery === "sent", conversation_id: conv!.id, message: finalMsg ?? msg });
});
