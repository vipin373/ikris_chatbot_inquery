// =====================================================================
//  leave-bot — WhatsApp leave applications for Ikris employees.
//  Called by the n8n chatbot only. Auth: header x-ikris-secret = chat_settings.ingest_secret
//
//  POST { action: "route", body: <Meta webhook body> }
//     → { handled, messages: [{ to, payload, notification_id? }] }
//       handled = false → n8n continues with the normal chatbot (nothing changes for customers)
//       handled = true  → n8n sends `messages` (WhatsApp Cloud API payloads) and reports back
//  POST { action: "sent", notification_id, ok, wa_message_id, error }
//     → records the WhatsApp result of a notification (never rolls back a decision)
//
//  Identity = the sender's WhatsApp number (from Meta), never a typed name or ID.
//  Decisions: only the assigned, active reporting manager; one-time token per request
//  (button payload "LV|A|<token>" / "LV|R|<token>"); atomic checks in SQL (leave_decide).
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const SESSION_TTL_MS = 2 * 3600 * 1000;
const WINDOW_MS = 23.5 * 3600 * 1000;
const TZ = "Asia/Kolkata";

let cache: { at: number; values: Record<string, string> } = { at: 0, values: {} };
async function settings() {
  if (Date.now() - cache.at < 60_000) return cache.values;
  const { data } = await admin.from("chat_settings").select("key, value")
    .in("key", ["ingest_secret", "leave_hr_whatsapp", "leave_test_redirect"]);
  const values: Record<string, string> = {};
  (data ?? []).forEach((r: any) => { values[r.key] = String(r.value ?? "").trim(); });
  cache = { at: Date.now(), values };
  return values;
}

// ---------- formatting ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const istNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${String(d).padStart(2, "0")} ${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${y}`;
};
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })
    .replace(/ (am|pm)$/i, (m) => m.toUpperCase()).replace(",", ",");
const param = (s: unknown, max = 300) =>         // WhatsApp template parameters: no newlines / tabs / 4+ spaces
  String(s ?? "-").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max) || "-";

/** Parses a date the employee typed. Returns YYYY-MM-DD or null. */
function parseDate(input: string): string | null {
  const t = input.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const today = istNow();
  today.setHours(0, 0, 0, 0);
  const mk = (y: number, m: number, d: number) => {
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
  };
  const yearFix = (y: number) => (y < 100 ? 2000 + y : y);
  let dt: Date | null = null;
  let m: RegExpMatchArray | null;
  if (/^(today|aaj)$/.test(t)) dt = today;
  else if (/^(tomorrow|tmrw|tmr)$/.test(t)) { dt = new Date(today); dt.setDate(dt.getDate() + 1); }
  else if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) dt = mk(+m[1], +m[2], +m[3]);
  else if ((m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/))) dt = mk(yearFix(+m[3]), +m[2], +m[1]);
  else if ((m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})$/))) dt = mk(today.getFullYear(), +m[2], +m[1]);
  else if ((m = t.match(/^(\d{1,2})[ \-]?([a-z]{3,9})\.?(?:[ \-]?(\d{2,4}))?$/))) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3));
    if (mi >= 0) dt = mk(m[3] ? yearFix(+m[3]) : today.getFullYear(), mi + 1, +m[1]);
  } else if ((m = t.match(/^([a-z]{3,9})\.? (\d{1,2})(?: (\d{2,4}))?$/))) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3));
    if (mi >= 0) dt = mk(m[3] ? yearFix(+m[3]) : today.getFullYear(), mi + 1, +m[2]);
  }
  if (!dt) return null;
  // no year typed and the date is long past → next year (e.g. "5 Jan" typed in December)
  if (!/\d{4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2}/.test(t) && (today.getTime() - dt.getTime()) > 60 * 86400_000) dt.setFullYear(dt.getFullYear() + 1);
  return ymd(dt);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

// ---------- WhatsApp payloads ----------
const text = (to: string, body: string) => ({ to, payload: { messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: false } } });
const buttons = (to: string, body: string, btns: { id: string; title: string }[]) => ({
  to,
  payload: {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: { type: "button", body: { text: body.slice(0, 1024) }, action: { buttons: btns.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) } },
  },
});
const template = (to: string, name: string, params: string[], quickReplies: string[] = []) => ({
  to,
  payload: {
    messaging_product: "whatsapp", to, type: "template",
    template: {
      name, language: { code: "en" },
      components: [
        { type: "body", parameters: params.map((p) => ({ type: "text", text: param(p) })) },
        ...quickReplies.map((payload, i) => ({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload }] })),
      ],
    },
  },
});

const NOT_REGISTERED = "Your WhatsApp number is not registered as an active employee. Please contact HR for assistance.";
const LEAVE_INTENT = /\b(leave|chh?utt?i)\b|छुट्टी/i;
const STRONG_INTENT = /\bapply(ing)?\s+(for\s+)?(a\s+)?leave\b|\bleave\s+(application|request)\b|\bwant\s+to\s+apply\b.*\bleave\b/i;
const CANCEL = /^(cancel|stop|exit|quit|no|nahi|rehne do)[.!]*$/i;            // the whole message, not "No electricity…"
const CONFIRM = /^(confirm|confirm submission|yes|submit|ok|okay|haan|ha)[.!]*$/i;

// ---------- data helpers ----------
async function identify(secret: string, phone: string) {
  const { data } = await admin.rpc("leave_identify", { p_secret: secret, p_phone: phone });
  return (data ?? {}) as { ok?: boolean; employee?: any; manager?: any };
}
async function getSession(phone: string) {
  const { data } = await admin.from("leave_sessions").select("*").eq("phone", phone).maybeSingle();
  if (!data) return null;
  if (Date.now() - Date.parse(data.updated_at) > SESSION_TTL_MS) {
    await admin.from("leave_sessions").delete().eq("phone", phone);
    return null;
  }
  return data as { phone: string; kind: string; step: string; data: any };
}
const saveSession = (phone: string, kind: string, step: string, data: unknown) =>
  admin.from("leave_sessions").upsert({ phone, kind, step, data, updated_at: new Date().toISOString() });
const endSession = (phone: string) => admin.from("leave_sessions").delete().eq("phone", phone);

async function inWindow(phone: string) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data: li } = await admin.from("leave_inbound").select("last_in_at").eq("phone", phone).maybeSingle();
  if (li && li.last_in_at > since) return true;
  const { data: conv } = await admin.from("chat_conversations").select("id").eq("customer_phone", phone).maybeSingle();
  if (!conv) return false;
  const { data: msg } = await admin.from("chat_messages").select("created_at").eq("conversation_id", conv.id)
    .eq("direction", "in").gt("created_at", since).limit(1).maybeSingle();
  return !!msg;
}

type Out = { to: string; payload: any; notification_id?: string };

/**
 * Queues one notification (manager / HR / employee). Duplicate kinds for the same request are skipped.
 * Inside the 24-hour window → normal WhatsApp message; outside → approved template.
 */
async function notify(opts: {
  kind: string; role: "employee" | "manager" | "hr"; phone: string; requestId?: string | null; employeeUuid?: string | null;
  session: () => Out; tpl: { name: string; params: string[]; quick?: string[] };
}): Promise<Out | null> {
  const s = await settings();
  const redirect = (s.leave_test_redirect || "").replace(/\D/g, "");
  const realTo = opts.phone;
  const useSession = await inWindow(redirect && opts.role !== "hr" ? redirect : realTo);
  const { data: row, error } = await admin.from("leave_notifications").insert({
    leave_request_id: opts.requestId ?? null, employee_uuid: opts.employeeUuid ?? null, recipient_role: opts.role, kind: opts.kind,
    phone: realTo, method: useSession ? "session" : "template", template_name: useSession ? null : opts.tpl.name,
  }).select("id").single();
  if (error || !row) return null;                                  // already sent once (unique per request + kind)
  const out = useSession ? opts.session() : template(realTo, opts.tpl.name, opts.tpl.params, opts.tpl.quick ?? []);
  return { ...out, notification_id: row.id };
}

/**
 * Test mode (chat_settings.leave_test_redirect): messages meant for managers go to the test number (labelled),
 * so one phone can be employee + manager. HR messages still go to the real HR number.
 */
function applyRedirect(list: Out[], redirect: string, hr: string): Out[] {
  if (!redirect) return list;
  return list.map((o) => {
    if (o.to === redirect || (hr && o.to === hr)) return o;
    const p = JSON.parse(JSON.stringify(o.payload));
    const label = `[TEST - meant for +${o.to}]\n\n`;
    if (p.type === "text") p.text.body = (label + p.text.body).slice(0, 4096);
    if (p.type === "interactive") p.interactive.body.text = (label + p.interactive.body.text).slice(0, 1024);
    p.to = redirect;
    return { ...o, to: redirect, payload: p };
  });
}

// ---------- messages ----------
const managerCard = (r: any) =>
  `*NEW LEAVE APPLICATION*\nIKRIS PHARMA NETWORK\nStatus: PENDING\n\n*EMPLOYEE DETAILS*\nEmployee ID: ${r.employee_code_snapshot}\nEmployee Name: ${r.employee_name_snapshot}\nDesignation: ${r.designation_snapshot ?? "-"}\nReporting Manager: ${r.manager_name_snapshot}\n\n*LEAVE DETAILS*\nFrom Date: ${fmtDate(r.from_date)}\nTo Date: ${fmtDate(r.to_date)}\nReason: ${r.leave_reason}\nRequest ID: ${r.request_id}\nApplication Date: ${fmtDateTime(r.applied_at)}\n\n*ACTION REQUIRED*\nPlease review this leave application.`;
const hrNewText = (r: any) =>
  `*NEW LEAVE APPLICATION RECEIVED*\nStatus: PENDING\n\nEmployee ID: ${r.employee_code_snapshot}\nEmployee Name: ${r.employee_name_snapshot}\nDesignation: ${r.designation_snapshot ?? "-"}\nReporting Manager: ${r.manager_name_snapshot}\nFrom Date: ${fmtDate(r.from_date)}\nTo Date: ${fmtDate(r.to_date)}\nReason: ${r.leave_reason}\nRequest ID: ${r.request_id}\nApplication Date: ${fmtDateTime(r.applied_at)}\n\nWaiting for reporting manager's decision.`;
const cardParams = (r: any) => [r.employee_code_snapshot, r.employee_name_snapshot, r.designation_snapshot ?? "-", r.manager_name_snapshot,
  fmtDate(r.from_date), fmtDate(r.to_date), r.leave_reason, r.request_id, fmtDateTime(r.applied_at)];

function confirmCard(phone: string, emp: any, d: any) {
  return buttons(phone,
    `*PLEASE CONFIRM YOUR LEAVE APPLICATION*\n\n*Employee Details*\nEmployee Name: ${emp.name}\nEmployee ID: ${emp.employee_id}\nDesignation: ${emp.designation}\n\n*Leave Details*\nFrom Date: ${fmtDate(d.from)}\nTo Date: ${fmtDate(d.to)}\nReason: ${d.reason}\n\nWould you like to submit this leave application?`,
    [{ id: `LVC|confirm|${d.nonce}`, title: "Confirm submission" }, { id: `LVC|cancel|${d.nonce}`, title: "Cancel" }]);
}

async function hrAlert(emp: any, issue: string): Promise<Out | null> {
  const s = await settings();
  const hr = (s.leave_hr_whatsapp || "").replace(/\D/g, "");
  if (!hr) return null;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: recent } = await admin.from("leave_notifications").select("id").eq("employee_uuid", emp.id).eq("kind", "hr_alert").gt("created_at", since).limit(1);
  if (recent && recent.length) return null;                          // at most one alert per employee per day
  return notify({
    kind: "hr_alert", role: "hr", phone: hr, employeeUuid: emp.id,
    session: () => text(hr, `*HR ACTION NEEDED - LEAVE*\n\nEmployee: ${emp.name} (${emp.employee_id})\nIssue: ${issue}\n\nPlease update this employee in Employee Management on the dashboard.`),
    tpl: { name: "leave_hr_alert", params: [emp.name, emp.employee_id, issue] },
  });
}

async function startApply(secret: string, phone: string, who: any): Promise<Out[]> {
  const emp = who.employee;
  if (!emp || emp.status !== "active") { await endSession(phone); return [text(phone, NOT_REGISTERED)]; }
  const mgr = who.manager;
  if (!mgr || mgr.status !== "active" || !mgr.whatsapp) {
    await endSession(phone);
    const issue = !mgr ? "No reporting manager is assigned, so the leave application could not be sent."
      : mgr.status !== "active" ? `The assigned reporting manager (${mgr.name}) is inactive, so the leave application could not be sent.`
      : `The reporting manager (${mgr.name}) has no WhatsApp number, so the leave application could not be sent.`;
    const out: Out[] = [text(phone, "Your reporting manager is not set up correctly in our employee records, so I can't send a leave application right now. HR has been informed and will update your record. Please contact HR for urgent leave.")];
    const a = await hrAlert(emp, issue);
    if (a) out.push(a);
    return out;
  }
  await saveSession(phone, "apply", "from", { nonce: crypto.randomUUID().slice(0, 8) });
  return [text(phone, `Hello ${emp.name.split(" ")[0]} 👋\nLet's apply for your leave. (Type *cancel* at any time to stop.)\n\nPlease tell me the date from which you want to apply for leave.\n_Example: 26/11/2026 or 26 Nov_`)];
}

async function continueApply(secret: string, phone: string, sess: any, msg: { text: string; payload: string }): Promise<Out[]> {
  const d = { ...(sess.data || {}) };
  const t = msg.text.trim();
  if (CANCEL.test(t) && !msg.payload) {
    await endSession(phone);
    return [text(phone, "Your leave application has been cancelled. No request was created.")];
  }
  const who = await identify(secret, phone);
  if (!who.employee || who.employee.status !== "active") { await endSession(phone); return [text(phone, NOT_REGISTERED)]; }
  const emp = who.employee;

  if (sess.step === "from") {
    const from = parseDate(t);
    if (!from) return [text(phone, "Sorry, I couldn't read that date. Please send the start date like *26/11/2026* or *26 Nov*.")];
    const today = ymd(istNow());
    if (daysBetween(today, from) < -30) return [text(phone, "That date is more than 30 days in the past. Please send the start date of your leave again, or contact HR.")];
    if (daysBetween(today, from) > 365) return [text(phone, "That date is more than a year away. Please check and send the start date again.")];
    d.from = from;
    await saveSession(phone, "apply", "to", d);
    return [text(phone, `From date: *${fmtDate(from)}* ✅\n\nPlease tell me the date until which you want to apply for leave.`)];
  }
  if (sess.step === "to") {
    const to = parseDate(t);
    if (!to) return [text(phone, "Sorry, I couldn't read that date. Please send the end date like *27/11/2026* or *27 Nov*.")];
    if (to < d.from) return [text(phone, `The end date cannot be earlier than the start date (${fmtDate(d.from)}). Please tell me the date until which you want to apply for leave.`)];
    if (daysBetween(d.from, to) > 90) return [text(phone, "That is more than 90 days of leave. Please check the end date, or contact HR for long leave.")];
    d.to = to;
    await saveSession(phone, "apply", "reason", d);
    return [text(phone, `To date: *${fmtDate(to)}* ✅\n\nPlease share the reason for your leave.`)];
  }
  if (sess.step === "reason") {
    if (t.length < 3) return [text(phone, "Please share the reason for your leave (a few words is enough).")];
    d.reason = t.replace(/\s+/g, " ").slice(0, 500);
    await saveSession(phone, "apply", "confirm", d);
    return [confirmCard(phone, emp, d)];
  }
  if (sess.step === "confirm") {
    const [kind, act, nonce] = msg.payload.split("|");
    const isButton = kind === "LVC";
    if (isButton && nonce !== d.nonce) return [text(phone, "That button belongs to an older application. Please use the buttons on the latest confirmation message.")];
    const choice = isButton ? act : CONFIRM.test(t) ? "confirm" : CANCEL.test(t) ? "cancel" : "";
    if (choice === "cancel") { await endSession(phone); return [text(phone, "Your leave application has been cancelled. No request was created.")]; }
    if (choice !== "confirm") return [confirmCard(phone, emp, d)];
    return submit(secret, phone, emp, d);
  }
  await endSession(phone);
  return [];
}

async function submit(secret: string, phone: string, emp: any, d: any): Promise<Out[]> {
  const { data } = await admin.rpc("leave_submit", { p_secret: secret, p_phone: phone, p_from: d.from, p_to: d.to, p_reason: d.reason });
  const res = (data ?? {}) as any;
  await endSession(phone);
  if (!res.ok) {
    if (res.code === "DUPLICATE") return [text(phone, `You already have a pending leave application (${res.request_id}) for these dates, so it was not submitted again.`)];
    if (res.code === "NOT_EMPLOYEE") return [text(phone, NOT_REGISTERED)];
    if (res.code === "NO_MANAGER") return startApply(secret, phone, await identify(secret, phone));
    return [text(phone, "Sorry, the leave application could not be submitted. Please try again or contact HR.")];
  }
  const r = res.request;
  const token = res.token as string;
  const s = await settings();
  const hr = (s.leave_hr_whatsapp || "").replace(/\D/g, "");
  const out: Out[] = [text(phone, `✅ Your leave application has been submitted.\n\nRequest ID: *${r.request_id}*\nFrom: ${fmtDate(r.from_date)}\nTo: ${fmtDate(r.to_date)}\nSent to: ${r.manager_name_snapshot} (reporting manager)\n\nYou will get a WhatsApp message here as soon as your manager decides.`)];
  const m = await notify({
    kind: "manager_card", role: "manager", phone: r.manager_whatsapp_snapshot, requestId: r.id, employeeUuid: r.employee_id,
    session: () => buttons(r.manager_whatsapp_snapshot, managerCard(r), [{ id: `LV|A|${token}`, title: "Approve" }, { id: `LV|R|${token}`, title: "Reject" }]),
    tpl: { name: "leave_manager_request", params: cardParams(r), quick: [`LV|A|${token}`, `LV|R|${token}`] },
  });
  if (m) out.push(m);
  if (hr) {
    const h = await notify({
      kind: "hr_new", role: "hr", phone: hr, requestId: r.id, employeeUuid: r.employee_id,
      session: () => text(hr, hrNewText(r)), tpl: { name: "leave_hr_new", params: cardParams(r) },
    });
    if (h) out.push(h);
  }
  return out;
}

async function decisionMessages(r: any): Promise<Out[]> {
  const s = await settings();
  const hr = (s.leave_hr_whatsapp || "").replace(/\D/g, "");
  const approved = r.status === "APPROVED";
  const from = fmtDate(r.from_date), to = fmtDate(r.to_date), when = fmtDateTime(r.decision_at);
  const out: Out[] = [];
  const e = await notify({
    kind: "employee_decision", role: "employee", phone: r.employee_whatsapp_snapshot, requestId: r.id, employeeUuid: r.employee_id,
    session: () => text(r.employee_whatsapp_snapshot, approved
      ? `Your leave application from ${from} to ${to} has been APPROVED by your reporting manager.\n\nRequest ID: ${r.request_id}`
      : `Your leave application from ${from} to ${to} has been REJECTED by your reporting manager.\n\nReason: ${r.rejection_reason}\nRequest ID: ${r.request_id}`),
    tpl: approved ? { name: "leave_employee_approved", params: [from, to, r.request_id] }
                  : { name: "leave_employee_rejected", params: [from, to, r.rejection_reason, r.request_id] },
  });
  if (e) out.push(e);
  if (hr) {
    const h = await notify({
      kind: "hr_decision", role: "hr", phone: hr, requestId: r.id, employeeUuid: r.employee_id,
      session: () => text(hr, approved
        ? `*LEAVE APPLICATION APPROVED*\n\nRequest ID: ${r.request_id}\nStatus: APPROVED\nEmployee ID: ${r.employee_code_snapshot}\nEmployee Name: ${r.employee_name_snapshot}\nReporting Manager: ${r.manager_name_snapshot}\nLeave Dates: ${from} to ${to}\nApproved By: ${r.decided_by_name}\nDecision Time: ${when}`
        : `*LEAVE APPLICATION REJECTED*\n\nRequest ID: ${r.request_id}\nStatus: REJECTED\nEmployee ID: ${r.employee_code_snapshot}\nEmployee Name: ${r.employee_name_snapshot}\nReporting Manager: ${r.manager_name_snapshot}\nLeave Dates: ${from} to ${to}\nRejection Reason: ${r.rejection_reason}\nRejected By: ${r.decided_by_name}\nDecision Time: ${when}`),
      tpl: approved
        ? { name: "leave_hr_approved", params: [r.request_id, r.employee_code_snapshot, r.employee_name_snapshot, r.manager_name_snapshot, from, to, r.decided_by_name, when] }
        : { name: "leave_hr_rejected", params: [r.request_id, r.employee_code_snapshot, r.employee_name_snapshot, r.manager_name_snapshot, from, to, r.rejection_reason, r.decided_by_name, when] },
    });
    if (h) out.push(h);
  }
  return out;
}

function decideError(phone: string, res: any): Out[] {
  if (res.code === "ALREADY") return [text(phone, `Leave request ${res.request?.request_id ?? ""} has already been ${String(res.request?.status ?? "decided").toUpperCase()}. No further action is needed.`)];
  if (res.code === "NOT_ASSIGNED") return [text(phone, `You are not the assigned reporting manager for leave request ${res.request_id ?? ""}, so you can't approve or reject it.`)];
  return [text(phone, "This leave action is no longer valid. Please contact HR if you need help.")];
}

/**
 * Test mode only: the test number (chat_settings.leave_test_redirect) may act as the assigned manager,
 * so the whole flow can be tried from one phone. With test mode off this returns the real sender.
 */
async function actingPhone(phone: string, token: string) {
  const s = await settings();
  const redirect = (s.leave_test_redirect || "").replace(/\D/g, "");
  if (!redirect || phone !== redirect) return phone;
  const { data: t } = await admin.from("leave_action_tokens").select("leave_request_id").eq("token", token).maybeSingle();
  if (!t) return phone;
  const { data: r } = await admin.from("leave_requests").select("manager_whatsapp_snapshot").eq("id", t.leave_request_id).maybeSingle();
  return r?.manager_whatsapp_snapshot ?? phone;
}

async function managerAction(secret: string, sender: string, action: string, token: string): Promise<Out[]> {
  const phone = await actingPhone(sender, token);
  if (action === "A") {
    const { data } = await admin.rpc("leave_decide", { p_secret: secret, p_phone: phone, p_token: token, p_action: "approve" });
    const res = (data ?? {}) as any;
    if (!res.ok) return decideError(phone, res);
    return [text(phone, `Leave request ${res.request.request_id} has been successfully approved.`), ...(await decisionMessages(res.request))];
  }
  const { data } = await admin.rpc("leave_decide", { p_secret: secret, p_phone: phone, p_token: token, p_action: "check" });
  const res = (data ?? {}) as any;
  if (!res.ok) return decideError(phone, res);
  await saveSession(sender, "reject_reason", "reason", { token, request_id: res.request.request_id, acting: phone });
  return [text(phone, `Please provide the reason for rejecting this leave application (${res.request.request_id} - ${res.request.employee_name_snapshot}).\n\n_Type *cancel* to go back without rejecting._`)];
}

async function rejectReason(secret: string, phone: string, sess: any, t: string): Promise<Out[]> {
  const d = sess.data || {};
  if (CANCEL.test(t)) {
    await endSession(phone);
    return [text(phone, `Rejection cancelled. Leave request ${d.request_id} is still PENDING - you can tap Approve or Reject on the leave card again.`)];
  }
  if (t.trim().length < 3) return [text(phone, "The rejection reason is required. Please type the reason for rejecting this leave application.")];
  const { data } = await admin.rpc("leave_decide", { p_secret: secret, p_phone: d.acting || phone, p_token: d.token, p_action: "reject", p_reason: t.trim().replace(/\s+/g, " ") });
  const res = (data ?? {}) as any;
  await endSession(phone);
  if (!res.ok) return decideError(phone, res);
  return [text(phone, `Leave request ${res.request.request_id} has been successfully rejected.`), ...(await decisionMessages(res.request))];
}

// ---------- router ----------
async function route(secret: string, body: any) {
  const value = body?.entry?.[0]?.changes?.[0]?.value ?? {};
  // delivery receipts for our notifications (the normal chatbot flow still gets them too)
  for (const st of value.statuses ?? []) {
    const map: Record<string, string> = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };
    const next = map[st.status];
    if (!next || !st.id) continue;
    const rank: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
    const { data: n } = await admin.from("leave_notifications").select("id, status").eq("wa_message_id", st.id).maybeSingle();
    if (n && (next === "failed" || rank[next] > (rank[n.status] ?? 0))) {
      await admin.from("leave_notifications").update({ status: next, error: next === "failed" ? String(st.errors?.[0]?.title ?? st.errors?.[0]?.message ?? "Failed").slice(0, 300) : null }).eq("id", n.id);
    }
  }
  const m = value.messages?.[0];
  if (!m) return { handled: false };
  const phone = String(m.from ?? value.contacts?.[0]?.wa_id ?? "").replace(/\D/g, "");
  if (phone.length < 8) return { handled: false };
  const payload = String(m.button?.payload ?? m.interactive?.button_reply?.id ?? "");
  const t = String(m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? "").trim();

  let messages: Out[] | null = null;
  if (/^LV\|[AR]\|[0-9a-f]{24}$/.test(payload)) {
    const [, act, token] = payload.split("|");
    messages = await managerAction(secret, phone, act, token);
  } else {
    const sess = await getSession(phone);
    if (sess && sess.kind === "reject_reason") {
      messages = await rejectReason(secret, phone, sess, t);
    } else if (payload.startsWith("LVC|") || sess) {
      if (sess && sess.kind === "apply" && LEAVE_INTENT.test(t) && STRONG_INTENT.test(t)) {
        messages = await startApply(secret, phone, await identify(secret, phone));      // "apply for leave" again → restart
      } else if (sess) {
        messages = await continueApply(secret, phone, sess, { text: t, payload });
      } else {
        messages = [text(phone, "This leave confirmation has expired. Send *apply for leave* to start again.")];
      }
    } else if (m.type === "text" && LEAVE_INTENT.test(t)) {
      const who = await identify(secret, phone);
      if (who.employee) messages = await startApply(secret, phone, who);
      else if (STRONG_INTENT.test(t)) messages = [text(phone, NOT_REGISTERED)];
    }
  }
  if (messages === null) return { handled: false };
  await admin.from("leave_inbound").upsert({ phone, last_in_at: new Date().toISOString() });
  const s = await settings();
  return { handled: true, messages: applyRedirect(messages, (s.leave_test_redirect || "").replace(/\D/g, ""), (s.leave_hr_whatsapp || "").replace(/\D/g, "")) };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
  const s = await settings();
  const secret = (req.headers.get("x-ikris-secret") ?? "").trim();
  if (!secret || !s.ingest_secret || secret !== s.ingest_secret) return json(401, { ok: false, error: "unauthorized" });
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return json(400, { ok: false, error: "invalid JSON" }); }
  try {
    if (b.action === "route") return json(200, { ok: true, ...(await route(secret, b.body)) });
    if (b.action === "sent") {
      const id = String(b.notification_id ?? "");
      if (!/^[0-9a-f-]{36}$/.test(id)) return json(200, { ok: true, skipped: true });
      const ok = b.ok === true || b.ok === "true";
      const wamid = ok ? String(b.wa_message_id ?? "").slice(0, 200) || null : null;
      const { data: cur } = await admin.from("leave_notifications").select("attempts").eq("id", id).maybeSingle();
      await admin.from("leave_notifications").update({
        status: ok ? "sent" : "failed", wa_message_id: wamid, attempts: (cur?.attempts ?? 0) + 1,
        error: ok ? null : String(b.error ?? "WhatsApp did not accept the message.").slice(0, 300),
      }).eq("id", id);
      return json(200, { ok: true });
    }
    return json(400, { ok: false, error: "unknown action" });
  } catch (e) {
    console.error(e);
    return json(500, { ok: false, error: "server error" });
  }
});
