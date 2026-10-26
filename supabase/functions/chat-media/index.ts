// =====================================================================
//  chat-media — saves a file a customer sent on WhatsApp into the private
//  chat-attachments bucket, so staff can open it in the dashboard.
//
//  POST { message_id }
//  Auth (verify_jwt = false, checked here):
//    • a signed-in staff member who can see the conversation (Authorization: Bearer <token>), or
//    • chat-ingest / n8n with header x-ikris-secret = chat_settings.ingest_secret
//
//  The bytes are fetched by the n8n webhook in chat_settings.wa_media_get_url
//  (it holds the WhatsApp token). Result: chat_messages.attachment_path is set to
//  <conversation_id>/in-<message_id>-<file name>.
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

async function setting(key: string) {
  const { data } = await admin.from("chat_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value ?? "").trim();
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/3gpp": "3gp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr",
  "application/pdf": "pdf",
};

function fileName(name: string | null, mime: string) {
  const base = mime.split(";")[0].trim();
  const ext = EXT[base] ?? (base.split("/")[1] || "bin").replace(/[^a-z0-9]/g, "");
  if (!name) {
    const kind = base.startsWith("image/") ? "image" : base.startsWith("audio/") ? "voice-message" : base.startsWith("video/") ? "video" : "file";
    return `${kind}.${ext}`;
  }
  return name;
}
const safeKey = (s: string) =>
  s.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(-100) || "file";

/** Records one outbound API call for the API Integration Center (no bodies, no headers, no secrets). */
async function recordMetric(integration: string, endpoint: string, ok: boolean, status: number | null, ms: number, error: string | null, source: string) {
  try {
    await admin.from("integration_metrics").insert({
      integration, endpoint, method: "POST", ok, status_code: status, duration_ms: ms, source,
      error: error ? String(error).replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[redacted]").slice(0, 300) : null,
    });
  } catch { /* metrics must never break the main flow */ }
}

async function canSee(token: string, conv: Record<string, any>) {
  const { data: auth } = await admin.auth.getUser(token);
  const email = auth?.user?.email?.toLowerCase();
  if (!email) return false;
  const { data: staff } = await admin.from("chat_staff").select("role, departments").eq("email", email).maybeSingle();
  if (!staff) return false;
  if (staff.role === "admin") return true;
  const mine = (staff.departments ?? []).map(norm);
  return [conv.department, ...(conv.shared_departments ?? [])].some((d) => norm(d) && mine.includes(norm(d)));
}

async function saveMedia(messageId: string) {
  const { data: m } = await admin.from("chat_messages").select("*").eq("id", messageId).maybeSingle();
  if (!m) return { ok: false, status: 404, error: "Message not found." };
  if (m.attachment_path) return { ok: true, path: m.attachment_path, name: m.attachment_name, type: m.attachment_type };
  if (!m.wa_media_id) return { ok: false, status: 404, error: "This message has no file." };

  const hook = await setting("wa_media_get_url");
  if (!hook) return { ok: false, status: 500, error: "Media download is not configured." };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(hook, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-ikris-secret": await setting("send_webhook_secret") },
      body: JSON.stringify({ media_id: m.wa_media_id }),
    });
  } catch (e) {
    clearTimeout(timer);
    await recordMetric("whatsapp_cloud", "media_download (via n8n)", false, null, Math.round(performance.now() - t0), (e as Error).name, "chat-media");
    return { ok: false, status: 502, error: (e as Error).name === "AbortError" ? "Downloading the file from WhatsApp timed out." : "Could not reach WhatsApp." };
  }
  clearTimeout(timer);
  const mime = (res.headers.get("x-media-mime") || res.headers.get("content-type") || m.attachment_type || "application/octet-stream").split(";")[0].trim();
  await recordMetric("whatsapp_cloud", "media_download (via n8n)", res.ok && !mime.startsWith("application/json"), res.status, Math.round(performance.now() - t0), res.ok ? null : `HTTP ${res.status}`, "chat-media");
  if (!res.ok || mime.startsWith("application/json")) {
    const body = await res.text().catch(() => "");
    console.error("media fetch failed", res.status, body.slice(0, 300));
    return { ok: false, status: 410, error: "WhatsApp no longer has this file (files expire after 30 days)." };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) return { ok: false, status: 502, error: "WhatsApp returned an empty file." };

  const name = fileName(m.attachment_name, mime);
  const path = `${m.conversation_id}/in-${m.id}-${safeKey(name)}`;
  const up = await admin.storage.from("chat-attachments").upload(path, bytes, { contentType: mime, upsert: true });
  if (up.error) return { ok: false, status: 500, error: up.error.message };
  await admin.from("chat_messages").update({ attachment_path: path, attachment_type: mime, attachment_name: name }).eq("id", m.id);
  return { ok: true, path, name, type: mime };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "Invalid request." }); }
  const id = String(body.message_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json(400, { ok: false, error: "message_id is required." });

  const internal = safeEqual(req.headers.get("x-ikris-secret") ?? "", await setting("ingest_secret"));
  if (!internal) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: m } = await admin.from("chat_messages").select("conversation_id").eq("id", id).maybeSingle();
    if (!m) return json(404, { ok: false, error: "Message not found." });
    const { data: conv } = await admin.from("chat_conversations").select("department, shared_departments").eq("id", m.conversation_id).maybeSingle();
    if (!token || !conv || !(await canSee(token, conv))) return json(403, { ok: false, error: "You cannot open this file." });
  }
  try {
    const r = await saveMedia(id);
    return json(r.ok ? 200 : (r as any).status ?? 500, r);
  } catch (e) {
    console.error(e);
    return json(500, { ok: false, error: "Server error." });
  }
});
