/**
 * =====================================================================
 *  IKRIS PHARMA NETWORK — Inquiry → Chat sync
 *  File: ChatSync.gs  (add as a NEW file in the "Ikris Dashboard API" project)
 * =====================================================================
 *  Every inquiry row in "department_inquery" that has a phone number becomes
 *  (or updates) a conversation in the dashboard's Chat inbox:
 *    • customer name, phone, department, assigned person, inquiry ID
 *    • one "Inquiry" message with the Problem / Inquiry text (+ product, notes)
 *  It only READS the sheet. Re-running is safe: each inquiry is sent once
 *  (duplicates are ignored by the server using the Inquiry ID).
 *
 *  Setup (once):
 *    1. Project Settings → Script Properties → add
 *         CHAT_INGEST_SECRET = <secret you were given privately>
 *    2. Run  syncAllInquiriesToChat   (copies all existing inquiries)
 *    3. Run  installChatSyncTrigger   (keeps new inquiries in sync every minute)
 * =====================================================================
 */

var CHAT_SYNC = {
  INGEST_URL: 'https://mdyniigwwhupdnxwtnvo.supabase.co/functions/v1/chat-ingest',
  RECENT_DAYS: 2,          // the 1-minute trigger re-checks inquiries from the last 2 days
  DEFAULT_COUNTRY_CODE: '91',
  BATCH: 100
};

/** Copies ALL inquiries with a phone number into Chat. Run manually once. */
function syncAllInquiriesToChat() {
  var result = chatSyncRun_(null);
  console.log('Synced ' + result.sent + ' inquiries to Chat (' + result.skipped + ' rows skipped: no phone). Errors: ' + result.errors);
  return result;
}

/** Called by the time trigger: only recent inquiries (cheap, safe to run every minute). */
function syncRecentInquiriesToChat() {
  var since = new Date(Date.now() - CHAT_SYNC.RECENT_DAYS * 24 * 3600 * 1000);
  return chatSyncRun_(since);
}

/** Creates the every-minute trigger (removes older copies first). Run manually once. */
function installChatSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncRecentInquiriesToChat') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncRecentInquiriesToChat').timeBased().everyMinutes(1).create();
  console.log('Chat sync trigger installed: new inquiries appear in Chat within about a minute.');
}

/** Removes the trigger (stop syncing). */
function removeChatSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncRecentInquiriesToChat') ScriptApp.deleteTrigger(t);
  });
  console.log('Chat sync trigger removed.');
}

function chatSyncRun_(since) {
  var secret = PropertiesService.getScriptProperties().getProperty('CHAT_INGEST_SECRET');
  if (!secret) throw new Error('Add the Script Property CHAT_INGEST_SECRET first (Project Settings → Script Properties).');

  var data = getDepartmentInquiries({ role: 'admin', departments: [] });   // read-only, from DashboardAPI
  var H = chatSyncHeaders_(data.headers);
  var items = [];
  var skipped = 0;

  data.rows.forEach(function (row) {
    var id = H.id ? String(row[H.id] || '').trim() : '';
    var phone = chatSyncPhone_(H.phone ? row[H.phone] : '', H.country ? row[H.country] : '');
    if (!id || !phone) { skipped++; return; }

    var when = H.date ? new Date(row[H.date]) : null;
    if (since && when && !isNaN(when.getTime()) && when < since) return;

    var lines = ['📝 Inquiry ' + id];
    if (H.inquiry && row[H.inquiry]) lines.push(String(row[H.inquiry]));
    if (H.product && row[H.product]) lines.push('Product: ' + row[H.product]);
    if (H.notes && row[H.notes] && row[H.notes] !== row[H.inquiry]) lines.push('Notes: ' + row[H.notes]);

    items.push({
      phone: phone,
      customer_name: H.name ? row[H.name] : '',
      direction: 'in',
      sender_type: 'system',
      sender_name: 'Inquiry',
      text: lines.join('\n'),
      wa_message_id: 'inquiry:' + id,
      timestamp: when && !isNaN(when.getTime()) ? when.toISOString() : null,
      department: H.department ? row[H.department] : '',
      assigned_to: H.assigned ? row[H.assigned] : '',
      inquiry_id: id
    });
  });

  // Oldest first so the newest inquiry decides the chat's current department.
  items.sort(function (a, b) { return String(a.timestamp || '').localeCompare(String(b.timestamp || '')); });

  var sent = 0;
  var errors = 0;
  for (var i = 0; i < items.length; i += CHAT_SYNC.BATCH) {
    var batch = items.slice(i, i + CHAT_SYNC.BATCH);
    var res = UrlFetchApp.fetch(CHAT_SYNC.INGEST_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-ikris-secret': secret },
      payload: JSON.stringify(batch),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 200 || code === 207) {
      var body = JSON.parse(res.getContentText());
      (body.results || []).forEach(function (r) { if (r.ok) sent++; else errors++; });
    } else {
      errors += batch.length;
      console.error('Chat sync failed (HTTP ' + code + '): ' + res.getContentText().slice(0, 300));
    }
  }
  return { sent: sent, skipped: skipped, errors: errors };
}

function chatSyncHeaders_(headers) {
  function find(re) { for (var i = 0; i < headers.length; i++) if (re.test(headers[i])) return headers[i]; return null; }
  return {
    id: find(/^(inquiry|inquery|enquiry|ticket)\s*(id|no|number)$/i),
    date: find(/(date|time|timestamp)/i),
    name: find(/^(name|full name|customer name|patient name)$/i),
    phone: find(/(phone|mobile|whatsapp)/i),
    country: find(/country/i),
    department: find(/(department|dept)/i),
    inquiry: find(/(problem|inquiry \/|inquery \/|^inquiry$|query|message)/i),
    product: find(/(product|medicine)/i),
    assigned: find(/(assigned|owner)/i),
    notes: find(/^notes?$/i)
  };
}

/** Digits only; adds 91 for 10-digit Indian numbers without a country code. */
function chatSyncPhone_(value, country) {
  var d = String(value || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return '';
  var c = String(country || '').toLowerCase();
  if (d.length === 10 && (c === '' || c === 'india' || c === 'in')) d = CHAT_SYNC.DEFAULT_COUNTRY_CODE + d;
  return d.length >= 10 ? d : '';
}
