// =====================================================================
//  wa-campaigns — WhatsApp templates & campaigns for the Ikris dashboard.
//  Auth: the signed-in user's Supabase token (verify_jwt = true) + chat_staff.
//
//  POST { action, ... }
//    sync_templates                      → refresh the template list from Meta
//    create_template  { template }       → submit a new template for Meta approval
//    delete_template  { name }           → delete a template (admin or its creator)
//    send_campaign    { name, template_name, language, variables, conversation_ids }
//    send_template    { conversation_id, template_name, language, variables }
//
//  Meta calls go through the n8n webhook in chat_settings.wa_api_webhook_url
//  (secret header x-ikris-secret = chat_settings.send_webhook_secret), so the
//  WhatsApp access token never leaves n8n.
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
const isAdmin = (s: Staff) => s.role === "admin";
const canSeeDept = (s: Staff, dep: string | null) =>
  isAdmin(s) || (!!norm(dep) && s.departments.some((d) => norm(d) === norm(dep)));
const canSeeConv = (s: Staff, c: Record<string, any>) =>
  isAdmin(s) || canSeeDept(s, c.department) || (c.shared_departments ?? []).some((d) => canSeeDept(s, d));

const MAX_RECIPIENTS = 1000;
const MEDIA_FORMATS = ["IMAGE", "VIDEO", "DOCUMENT"];
const MEDIA_RULES: Record<string, { types: string[]; max: number; label: string }> = {
  IMAGE: { types: ["image/jpeg", "image/png"], max: 5 * 1024 * 1024, label: "JPG or PNG image up to 5 MB" },
  VIDEO: { types: ["video/mp4", "video/3gpp"], max: 16 * 1024 * 1024, label: "MP4 video up to 16 MB" },
  DOCUMENT: { types: ["application/pdf"], max: 100 * 1024 * 1024, label: "PDF up to 100 MB" },
};
const publicMediaUrl = (path: string) =>
  `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/wa-media/${path.split("/").map(encodeURIComponent).join("/")}`;

async function setting(key: string) {
  const { data } = await admin.from("chat_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value ?? "").trim();
}

/** Calls the n8n proxy. Returns { ok, status, data } where data is Meta's JSON. */
async function meta(payload: Record<string, unknown>) {
  const url = await setting("wa_api_webhook_url");
  if (!url) return { ok: false, status: 0, data: null, error: "WhatsApp template API is not configured." };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-ikris-secret": await setting("send_webhook_secret") },
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    let out: Record<string, any> = {};
    try { out = JSON.parse(raw); } catch { /* not JSON */ }
    const data = out.data ?? null;
    const metaErr = data?.error;
    const error = metaErr
      ? clean(metaErr.error_user_msg || metaErr.error_data?.details || metaErr.message, 500)
      : (out.ok === false ? clean(out.error ?? raw, 500) : null);
    const ok = res.ok && out.ok !== false && !metaErr;
    await recordMetric("whatsapp_cloud", `${String(payload.action ?? "call")} (via n8n)`, ok, Number(out.status ?? res.status) || null, Math.round(performance.now() - t0), ok ? null : error, "wa-campaigns");
    return { ok, status: out.status ?? res.status, data, error };
  } catch (e) {
    const error = (e as Error).name === "AbortError" ? "WhatsApp API timed out." : "Could not reach the WhatsApp API.";
    await recordMetric("whatsapp_cloud", `${String(payload.action ?? "call")} (via n8n)`, false, null, Math.round(performance.now() - t0), error, "wa-campaigns");
    return { ok: false, status: 0, data: null, error };
  } finally {
    clearTimeout(timer);
  }
}

/** Records one outbound API call for the API Integration Center (no bodies, no headers, no secrets). */
async function recordMetric(integration: string, endpoint: string, ok: boolean, status: number | null, ms: number, error: string | null, source: string) {
  try {
    await admin.from("integration_metrics").insert({
      integration, endpoint, method: "POST", ok, status_code: status, duration_ms: ms, source,
      error: error ? String(error).replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[redacted]").slice(0, 300) : null,
    });
  } catch { /* metrics must never break the main flow */ }
}

// ---------- templates ----------
const countVars = (t: string | null | undefined) => {
  const nums = [...String(t ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
};

function summarize(t: Record<string, any>) {
  const comps: any[] = Array.isArray(t.components) ? t.components : [];
  const header = comps.find((c) => c.type === "HEADER");
  const body = comps.find((c) => c.type === "BODY");
  const footer = comps.find((c) => c.type === "FOOTER");
  const buttons = comps.find((c) => c.type === "BUTTONS")?.buttons ?? [];
  const headerFormat = header?.format ?? null;
  // Dynamic URL / copy-code / flow buttons need extra input we don't collect.
  const dynamicButton = buttons.some((b: any) => (b.type === "URL" && /\{\{/.test(b.url ?? "")) || b.type === "COPY_CODE" || b.type === "OTP" || b.type === "FLOW");
  const sendable = (!headerFormat || ["TEXT", ...MEDIA_FORMATS].includes(headerFormat)) && !dynamicButton;
  return {
    name: t.name,
    language: t.language,
    meta_id: t.id ?? null,
    category: t.category ?? null,
    status: t.status ?? null,
    rejected_reason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
    components: comps,
    header_format: headerFormat,
    header_text: headerFormat === "TEXT" ? header?.text ?? null : null,
    body_text: body?.text ?? null,
    footer_text: footer?.text ?? null,
    body_vars: countVars(body?.text),
    header_vars: headerFormat === "TEXT" ? countVars(header?.text) : 0,
    sendable,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function syncTemplates() {
  const r = await meta({ action: "list_templates" });
  if (!r.ok) return { ok: false, error: r.error ?? "Could not load templates from WhatsApp." };
  const list: any[] = r.data?.data ?? [];
  const rows = list.map(summarize);
  if (rows.length) {
    const { error } = await admin.from("wa_templates").upsert(rows, { onConflict: "name,language" });
    if (error) return { ok: false, error: error.message };
  }
  // Remove templates that no longer exist in Meta.
  const { data: existing } = await admin.from("wa_templates").select("name, language");
  const keep = new Set(rows.map((t) => `${t.name}|${t.language}`));
  for (const t of existing ?? []) {
    if (!keep.has(`${t.name}|${t.language}`)) await admin.from("wa_templates").delete().eq("name", t.name).eq("language", t.language);
  }
  return { ok: true, count: rows.length };
}

/** Uploads a header sample to Meta (via n8n resumable upload) and returns its handle. */
async function uploadHandle(url: string, size: number, type: string, name: string) {
  const hook = await setting("wa_media_webhook_url");
  if (!hook) return { ok: false, error: "Media upload is not configured." };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  const t0 = performance.now();
  try {
    const res = await fetch(hook, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-ikris-secret": await setting("send_webhook_secret") },
      body: JSON.stringify({ url, file_length: size, file_type: type, file_name: name }),
    });
    const out = await res.json().catch(() => ({}));
    const ok = res.ok && !!out.ok && !!out.handle;
    await recordMetric("whatsapp_cloud", "template_media_upload (via n8n)", ok, res.status, Math.round(performance.now() - t0), ok ? null : clean(out.error, 300), "wa-campaigns");
    if (!ok) return { ok: false, error: clean(out.error, 300) ?? "WhatsApp could not accept the header file." };
    return { ok: true, handle: String(out.handle) };
  } catch (e) {
    return { ok: false, error: (e as Error).name === "AbortError" ? "Uploading the file to WhatsApp timed out." : "Could not reach the media upload service." };
  } finally {
    clearTimeout(timer);
  }
}

const LANGS = ["en", "en_US", "en_GB", "hi", "ar", "fr", "es", "pt_BR", "ru", "de", "bn", "ur"];

async function createTemplate(staff: Staff, input: Record<string, any>) {
  const name = String(input.name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{1,512}$/.test(name)) return { ok: false, error: "Template name: use only lowercase letters, numbers and underscores (e.g. followup_enquiry)." };
  const category = String(input.category ?? "").toUpperCase();
  if (!["MARKETING", "UTILITY"].includes(category)) return { ok: false, error: "Choose Marketing or Utility." };
  const language = String(input.language ?? "en");
  if (!LANGS.includes(language)) return { ok: false, error: "Unsupported language." };

  const body = String(input.body ?? "").trim();
  if (!body) return { ok: false, error: "Message body is required." };
  if (body.length > 1024) return { ok: false, error: "Message body can be at most 1024 characters." };
  const bodyVars = countVars(body);
  const found = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  for (let i = 1; i <= bodyVars; i++) if (!found.includes(i)) return { ok: false, error: `Variables must be numbered in order: {{1}}, {{2}}… ({{${i}}} is missing).` };
  if (/^\s*\{\{/.test(body) || /\}\}\s*$/.test(body)) return { ok: false, error: "The message cannot start or end with a variable — add some text before/after it." };
  const examples: string[] = Array.isArray(input.examples) ? input.examples.map((e: unknown) => String(e ?? "").trim()) : [];
  if (examples.length < bodyVars || examples.slice(0, bodyVars).some((e) => !e)) return { ok: false, error: "Give an example value for every variable — Meta needs them to review the template." };

  const components: any[] = [];
  const headerType = String(input.header_type ?? (input.header_text ? "TEXT" : "NONE")).toUpperCase();
  let mediaUrl: string | null = null;
  let mediaName: string | null = null;
  if (headerType === "TEXT") {
    const header = clean(input.header_text, 60);
    if (!header) return { ok: false, error: "Type the header text, or choose “No header”." };
    if (/\{\{/.test(header)) return { ok: false, error: "Header variables are not supported here — keep the header as plain text." };
    components.push({ type: "HEADER", format: "TEXT", text: header });
  } else if (MEDIA_FORMATS.includes(headerType)) {
    const rule = MEDIA_RULES[headerType];
    const path = String(input.media_path ?? "");
    const type = String(input.media_type ?? "").toLowerCase();
    const size = Number(input.media_size ?? 0);
    if (!/^templates\/[^/]+$/.test(path)) return { ok: false, error: "Upload the header file first." };
    if (!rule.types.includes(type) || !size || size > rule.max) return { ok: false, error: `Header file must be a ${rule.label}.` };
    mediaUrl = publicMediaUrl(path);
    mediaName = clean(input.media_name, 200) ?? path.split("/").pop()!;
    const up = await uploadHandle(mediaUrl, size, type, mediaName);
    if (!up.ok) return { ok: false, error: up.error };
    components.push({ type: "HEADER", format: headerType, example: { header_handle: [up.handle] } });
  }
  const bodyComp: any = { type: "BODY", text: body };
  if (bodyVars) bodyComp.example = { body_text: [examples.slice(0, bodyVars)] };
  components.push(bodyComp);
  const footer = clean(input.footer_text, 60);
  if (footer) components.push({ type: "FOOTER", text: footer });

  const buttons: any[] = [];
  for (const b of (Array.isArray(input.buttons) ? input.buttons : []).slice(0, 3)) {
    const text = clean(b?.text, 25);
    if (!text) continue;
    if (b.type === "URL") {
      const url = clean(b.url, 2000);
      if (!url || !/^https:\/\//.test(url) || /\{\{/.test(url)) return { ok: false, error: "Website buttons need a full https:// link without variables." };
      buttons.push({ type: "URL", text, url });
    } else if (b.type === "PHONE_NUMBER") {
      const phone = String(b.phone_number ?? "").replace(/[^\d+]/g, "");
      if (phone.replace(/\D/g, "").length < 8) return { ok: false, error: "Call buttons need a phone number with country code." };
      buttons.push({ type: "PHONE_NUMBER", text, phone_number: phone.startsWith("+") ? phone : `+${phone}` });
    } else {
      buttons.push({ type: "QUICK_REPLY", text });
    }
  }
  if (buttons.length) components.push({ type: "BUTTONS", buttons });

  const r = await meta({ action: "create_template", template: { name, language, category, components } });
  if (!r.ok) return { ok: false, error: r.error ?? "WhatsApp rejected the template." };

  const row = summarize({ name, language, category: r.data?.category ?? category, status: r.data?.status ?? "PENDING", id: r.data?.id, components });
  await admin.from("wa_templates").upsert({
    ...row,
    header_media_url: mediaUrl,
    header_media_name: mediaName,
    created_by: staff.email,
    created_by_name: staff.display_name,
    department: isAdmin(staff) ? null : staff.departments[0] ?? null,
    created_at: new Date().toISOString(),
  }, { onConflict: "name,language" });
  return { ok: true, template: row };
}

async function deleteTemplate(staff: Staff, input: Record<string, any>) {
  const name = String(input.name ?? "");
  const { data: t } = await admin.from("wa_templates").select("*").eq("name", name).limit(1).maybeSingle();
  if (!t) return { ok: false, error: "Template not found." };
  if (!isAdmin(staff) && (t.created_by ?? "") !== staff.email) return { ok: false, error: "Only an admin or the person who created this template can delete it." };
  const r = await meta({ action: "delete_template", name });
  if (!r.ok) return { ok: false, error: r.error ?? "WhatsApp could not delete the template." };
  await admin.from("wa_templates").delete().eq("name", name);
  return { ok: true };
}

// ---------- sending ----------
type VarSpec = { source?: string; value?: string };
type Vars = { body?: VarSpec[]; header?: VarSpec[]; media_url?: string | null; media_name?: string | null };

function resolveVar(spec: VarSpec | undefined, conv: Record<string, any>, staff: Staff) {
  const src = spec?.source ?? "text";
  if (src === "name") return clean(conv.customer_name, 60) ?? clean(spec?.value, 60) ?? "Customer";
  if (src === "agent") return staff.display_name ?? "Ikris Pharma Network";
  if (src === "inquiry") return clean(conv.inquiry_id, 60) ?? clean(spec?.value, 60) ?? "-";
  return clean(spec?.value, 1000) ?? "-";
}

const fill = (text: string | null, values: string[]) =>
  String(text ?? "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n) => values[Number(n) - 1] ?? `{{${n}}}`);

async function sendOne(
  staff: Staff,
  tpl: Record<string, any>,
  conv: Record<string, any>,
  vars: Vars,
  campaignId: string | null,
) {
  const fmt = String(tpl.header_format ?? "");
  const isMedia = MEDIA_FORMATS.includes(fmt);
  const mediaLink = isMedia ? (clean(vars.media_url, 2000) ?? tpl.header_media_url ?? null) : null;
  if (isMedia && (!mediaLink || !/^https:\/\//.test(mediaLink))) {
    return { ok: false, message_id: null, wa_message_id: null, error: `This template needs a header ${fmt.toLowerCase()} — choose a file before sending.` };
  }
  const mediaName = clean(vars.media_name, 200) ?? tpl.header_media_name ?? (mediaLink ? decodeURIComponent(mediaLink.split("/").pop()!.split("?")[0]) : null);
  const bodyValues = Array.from({ length: tpl.body_vars }, (_, i) => resolveVar(vars.body?.[i], conv, staff));
  const headerValues = Array.from({ length: tpl.header_vars }, (_, i) => resolveVar(vars.header?.[i], conv, staff));
  const components: any[] = [];
  if (headerValues.length) components.push({ type: "header", parameters: headerValues.map((t) => ({ type: "text", text: t })) });
  if (isMedia) {
    const key = fmt.toLowerCase();
    const media: Record<string, string> = { link: mediaLink! };
    if (key === "document" && mediaName) media.filename = mediaName;
    components.push({ type: "header", parameters: [{ type: key, [key]: media }] });
  }
  if (bodyValues.length) components.push({ type: "body", parameters: bodyValues.map((t) => ({ type: "text", text: t })) });

  const rendered = [tpl.header_text ? `*${fill(tpl.header_text, headerValues)}*` : null, fill(tpl.body_text, bodyValues), tpl.footer_text ? `_${tpl.footer_text}_` : null]
    .filter(Boolean).join("\n\n");

  const { data: msg } = await admin.from("chat_messages").insert({
    conversation_id: conv.id,
    direction: "out",
    sender_type: "agent",
    sender_name: staff.display_name ?? staff.email,
    sender_email: staff.email,
    body: rendered,
    attachment_url: mediaLink,
    attachment_type: isMedia ? ({ IMAGE: "image/jpeg", VIDEO: "video/mp4", DOCUMENT: "application/pdf" } as Record<string, string>)[fmt] : null,
    attachment_name: isMedia ? mediaName : null,
    template_name: tpl.name,
    campaign_id: campaignId,
    delivery_status: "queued",
    is_read: true,
  }).select("id").single();

  const r = await meta({ action: "send_template", to: conv.customer_phone, name: tpl.name, language: tpl.language, components });
  const waId = r.ok ? clean(r.data?.messages?.[0]?.id, 200) : null;
  const error = r.ok ? null : (r.error ?? "WhatsApp rejected the message.");
  if (msg) {
    await admin.from("chat_messages").update({ delivery_status: r.ok ? "sent" : "failed", wa_message_id: waId, error }).eq("id", msg.id);
  }
  return { ok: r.ok, message_id: msg?.id ?? null, wa_message_id: waId, error };
}

async function loadTemplate(name: string, language: string) {
  const { data } = await admin.from("wa_templates").select("*").eq("name", name).eq("language", language).maybeSingle();
  if (!data) return { error: "Template not found — click Refresh on the Templates tab." };
  if (data.status !== "APPROVED") return { error: `This template is ${String(data.status ?? "not approved").toLowerCase()} — only approved templates can be sent.` };
  if (!data.sendable) return { error: "This template has a dynamic button (link with a variable, coupon code or form), which this dashboard cannot fill in yet." };
  return { tpl: data };
}

async function runCampaign(staff: Staff, campaignId: string, tpl: Record<string, any>, vars: Vars, convs: Record<string, any>[]) {
  let sent = 0;
  let failed = 0;
  const queue = [...convs];
  const worker = async () => {
    while (queue.length) {
      const conv = queue.shift()!;
      const res = await sendOne(staff, tpl, conv, vars, campaignId).catch((e) => ({ ok: false, message_id: null, wa_message_id: null, error: String(e) }));
      if (res.ok) sent++; else failed++;
      await admin.from("campaign_recipients").update({
        status: res.ok ? "sent" : "failed",
        message_id: res.message_id,
        wa_message_id: res.wa_message_id,
        error: res.error,
        sent_at: new Date().toISOString(),
      }).eq("campaign_id", campaignId).eq("conversation_id", conv.id);
      if ((sent + failed) % 10 === 0) await admin.from("campaigns").update({ sent, failed }).eq("id", campaignId);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  await admin.from("campaigns").update({
    sent, failed, status: sent === 0 && failed > 0 ? "failed" : "completed", completed_at: new Date().toISOString(),
  }).eq("id", campaignId);
}

async function sendCampaign(staff: Staff, input: Record<string, any>) {
  const name = clean(input.name, 120);
  if (!name) return { ok: false, error: "Give the campaign a name." };
  const t = await loadTemplate(String(input.template_name ?? ""), String(input.language ?? ""));
  if (t.error) return { ok: false, error: t.error };
  const ids: string[] = Array.isArray(input.conversation_ids) ? [...new Set(input.conversation_ids.map(String))] : [];
  const contactIds: string[] = Array.isArray(input.contact_ids) ? [...new Set(input.contact_ids.map(String))] : [];
  if (!ids.length && !contactIds.length) return { ok: false, error: "Select at least one contact." };
  if (ids.length + contactIds.length > MAX_RECIPIENTS) return { ok: false, error: `A campaign can have at most ${MAX_RECIPIENTS} contacts.` };

  const convs: Record<string, any>[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin.from("chat_conversations").select("*").in("id", ids.slice(i, i + 200));
    convs.push(...(data ?? []));
  }
  const allowed = convs.filter((c) => canSeeConv(staff, c));
  const contactOf = new Map<string, string>();   // conversation id → contact id
  let optedOut = 0;

  if (contactIds.length) {
    const contacts: Record<string, any>[] = [];
    for (let i = 0; i < contactIds.length; i += 200) {
      const { data } = await admin.from("contacts").select("*").in("id", contactIds.slice(i, i + 200));
      contacts.push(...(data ?? []));
    }
    const phones = contacts.map((c) => c.phone);
    const existing = new Map<string, Record<string, any>>();
    for (let i = 0; i < phones.length; i += 200) {
      const { data } = await admin.from("chat_conversations").select("*").in("customer_phone", phones.slice(i, i + 200));
      (data ?? []).forEach((c) => existing.set(c.customer_phone, c));
    }
    const seen = new Set(allowed.map((c) => c.id));
    for (const ct of contacts) {
      if (ct.opted_out) { optedOut++; continue; }
      const conv = existing.get(ct.phone);
      const mayUse = isAdmin(staff) || canSeeDept(staff, ct.department) || (ct.created_by ?? "") === staff.email || (conv && canSeeConv(staff, conv));
      if (!mayUse) continue;
      let c = conv;
      if (!c) {
        // First message to this contact: create the chat (it stays "resolved" until the customer replies).
        const { data, error: e2 } = await admin.from("chat_conversations").insert({
          customer_phone: ct.phone,
          customer_name: ct.name,
          department: ct.department ?? (isAdmin(staff) ? null : staff.departments[0] ?? null),
          status: "resolved",
        }).select("*").single();
        if (e2) {
          const again = await admin.from("chat_conversations").select("*").eq("customer_phone", ct.phone).maybeSingle();
          c = again.data ?? undefined;
        } else c = data;
      }
      if (c && !seen.has(c.id)) { seen.add(c.id); allowed.push(c); contactOf.set(c.id, ct.id); }
    }
  }
  if (!allowed.length) return { ok: false, error: optedOut ? "All selected contacts have opted out." : "None of the selected contacts belong to your department." };

  const department = isAdmin(staff) ? clean(input.department, 200) : staff.departments[0] ?? null;
  const vars: Vars = { body: input.variables?.body ?? [], header: input.variables?.header ?? [], media_url: clean(input.variables?.media_url, 2000), media_name: clean(input.variables?.media_name, 200) };
  const { data: campaign, error } = await admin.from("campaigns").insert({
    name,
    template_name: t.tpl!.name,
    template_language: t.tpl!.language,
    department,
    variables: vars,
    total: allowed.length,
    created_by: staff.email,
    created_by_name: staff.display_name,
  }).select("*").single();
  if (error || !campaign) return { ok: false, error: "Could not create the campaign." };

  await admin.from("campaign_recipients").insert(allowed.map((c) => ({
    campaign_id: campaign.id, conversation_id: c.id, contact_id: contactOf.get(c.id) ?? null, phone: c.customer_phone, customer_name: c.customer_name,
  })));

  // Keep sending after the response is returned.
  const job = runCampaign(staff, campaign.id, t.tpl!, vars, allowed).catch(async (e) => {
    console.error(e);
    await admin.from("campaigns").update({ status: "failed", completed_at: new Date().toISOString() }).eq("id", campaign.id);
  });
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(job); else await job;

  return { ok: true, campaign, skipped: ids.length + contactIds.length - allowed.length, opted_out: optedOut };
}

async function sendTemplateToChat(staff: Staff, input: Record<string, any>) {
  const { data: conv } = await admin.from("chat_conversations").select("*").eq("id", String(input.conversation_id ?? "")).maybeSingle();
  if (!conv || !canSeeConv(staff, conv)) return { ok: false, error: "You cannot message this conversation." };
  const t = await loadTemplate(String(input.template_name ?? ""), String(input.language ?? ""));
  if (t.error) return { ok: false, error: t.error };
  const vars: Vars = { body: input.variables?.body ?? [], header: input.variables?.header ?? [], media_url: clean(input.variables?.media_url, 2000), media_name: clean(input.variables?.media_name, 200) };
  const res = await sendOne(staff, t.tpl!, conv, vars, null);
  if (["resolved", "closed"].includes(conv.status)) await admin.from("chat_conversations").update({ status: "open" }).eq("id", conv.id);
  const { data: message } = res.message_id
    ? await admin.from("chat_messages").select("*").eq("id", res.message_id).maybeSingle()
    : { data: null };
  return { ok: res.ok, sent: res.ok, error: res.error, message };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !auth?.user?.email) return json(401, { ok: false, code: "UNAUTHORIZED", error: "Session is not valid." });
  const email = auth.user.email.toLowerCase();
  const { data: staffRow } = await admin.from("chat_staff").select("*").eq("email", email).maybeSingle();
  if (!staffRow) return json(403, { ok: false, code: "FORBIDDEN", error: "Your account has no WhatsApp access." });
  const staff = { ...staffRow, departments: staffRow.departments ?? [] } as Staff;

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "Invalid request." }); }

  try {
    switch (body.action) {
      case "sync_templates": return json(200, await syncTemplates());
      case "create_template": return json(200, await createTemplate(staff, body.template ?? {}));
      case "delete_template": return json(200, await deleteTemplate(staff, body));
      case "send_campaign": return json(200, await sendCampaign(staff, body));
      case "send_template": return json(200, await sendTemplateToChat(staff, body));
      default: return json(400, { ok: false, error: "Unknown action." });
    }
  } catch (e) {
    console.error(e);
    return json(500, { ok: false, error: "Server error." });
  }
});
