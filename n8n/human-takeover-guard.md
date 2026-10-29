# Human agent takeover — n8n chatbot guard steps

Two Code nodes in the live chatbot workflow (secret redacted here — the live nodes use chat_settings.ingest_secret):

- **Check AI allowed** — between *Receive Message* and *Is Text Message?*
- **Check AI still allowed** — between *AI Agent* and *Send message*

Backend: `supabase/functions/chat-ai-guard`, `supabase/migrations/009_human_takeover.sql`. Staff replies from the dashboard (`chat-send`) switch the chat to HUMAN_HANDOVER before the message is sent.

## Check AI allowed
```js
// HUMAN TAKEOVER GUARD (step 1 of 2). Asks the dashboard whether the AI may answer this message.
// Silent (no output -> the AI never runs) when an employee is handling the chat, the chat is closed,
// or WhatsApp re-delivered a message the bot already handled. Status/delivery events pass through unchanged.
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const value = ((((item.json.body || {}).entry || [{}])[0] || {}).changes || [{}])[0]?.value || {};
  const msg = (value.messages || [])[0];
  if (!msg) { out.push({ json: item.json, pairedItem: { item: i } }); continue; }
  const wa = String(((value.contacts || [])[0] || {}).wa_id || msg.from || '');
  let g = null;
  for (let attempt = 0; attempt < 2 && !g; attempt++) {
    try {
      const res = await this.helpers.httpRequest({
        method: 'POST',
        url: 'https://mdyniigwwhupdnxwtnvo.supabase.co/functions/v1/chat-ai-guard',
        headers: { 'x-ikris-secret': 'REPLACE_WITH_IKRIS_SECRET', 'Content-Type': 'application/json' },
        body: { action: 'check', phone: wa, wa_message_id: msg.id || '' },
        json: true,
        timeout: 8000,
      });
      if (res && res.ok) g = res;
    } catch (e) { /* retry once */ }
  }
  if (g && g.allowed === false) continue;   // HUMAN_HANDOVER / CLOSED / DUPLICATE -> AI stays silent
  // If the guard could not be reached, epoch -1 makes step 2 refuse the send for an existing chat.
  out.push({ json: Object.assign({}, item.json, { ai_guard: { epoch: g ? g.epoch : -1 } }), pairedItem: { item: i } });
}
return out;
```

## Check AI still allowed
```js
// HUMAN TAKEOVER GUARD (step 2 of 2). Runs immediately before the AI reply goes to WhatsApp.
// The dashboard atomically confirms the chat is still AI_ACTIVE and that no employee took it over
// while the AI was thinking (same epoch as step 1). Otherwise the reply is dropped - never sent.
const recv = $('Receive Message').first().json.body || {};
const value = (((recv.entry || [{}])[0] || {}).changes || [{}])[0]?.value || {};
const wa = String(((value.contacts || [])[0] || {}).wa_id || ((value.messages || [])[0] || {}).from || '');
let epoch = -1;
try { const e = $('Check AI allowed').first().json.ai_guard; if (e && Number.isInteger(e.epoch)) epoch = e.epoch; } catch (e) { epoch = -1; }
let res = null;
for (let attempt = 0; attempt < 2 && !res; attempt++) {
  try {
    const r = await this.helpers.httpRequest({
      method: 'POST',
      url: 'https://mdyniigwwhupdnxwtnvo.supabase.co/functions/v1/chat-ai-guard',
      headers: { 'x-ikris-secret': 'REPLACE_WITH_IKRIS_SECRET', 'Content-Type': 'application/json' },
      body: { action: 'claim_send', phone: wa, epoch },
      json: true,
      timeout: 8000,
    });
    if (r && r.ok) res = r;
  } catch (e) { /* retry once */ }
}
if (!res || res.allowed !== true) return [];   // taken over / closed / guard unreachable -> do not send
return $input.all().map((it, i) => ({ json: it.json, pairedItem: { item: i } }));
```
