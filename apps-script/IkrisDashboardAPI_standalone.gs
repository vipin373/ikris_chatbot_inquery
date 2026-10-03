/**
 * IKRIS DASHBOARD API — STANDALONE VERSION (one file, copy-paste ready)
 * Paste this whole file into your standalone Apps Script project, replacing the old code.
 * It is separate from the Apps Script attached to your sheet, so your chatbot / email
 * automation is not touched. It reads department_inquery and, when a ticket is closed,
 * changes only that row's Status cell.
 */

/**
 * =====================================================================
 *  IKRIS PHARMA NETWORK — Department Inquiry Dashboard API  (v2)
 * =====================================================================
 *
 *  What this code does
 *  -------------------
 *  • Serves inquiry data from the "department_inquery" tab ONLY.
 *  • Every request must carry a valid Supabase access token, verified
 *    server-side with Supabase Auth (GET /auth/v1/user).
 *  • ROLE-BASED ACCESS (see DASHBOARD_ACCESS below):
 *      - Admins see every inquiry.
 *      - Department users see ONLY inquiries of their own department.
 *        Filtering happens here on the server, so other departments'
 *        data never reaches their browser.
 *      - Any other signed-in account gets "not authorised".
 *  • CLOSE TICKET: an admin, or the user of that inquiry's department, can
 *    close a ticket. The ONLY cell changed is that row's "Status" cell
 *    (e.g. New → Done). Optional "Closed By" / "Closed At" columns are
 *    filled only if such columns already exist. Nothing else in the sheet
 *    is ever modified, and no other tab is opened.
 *
 *  Script Properties (optional)
 *  ----------------------------
 *    SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY   override the built-in public values
 *    DASHBOARD_ACCESS_JSON  override DASHBOARD_ACCESS without editing code, e.g.
 *      {"admins":["vipin@ikrispharmanetwork.com"],
 *       "departments":{"qa@ikrispharmanetwork.com":["Quality Assurance"]}}
 * =====================================================================
 */

var DASHBOARD_CONFIG = {
  SPREADSHEET_ID: '1JWgKel_MnCtZKnm4s-knliTYyVzRBITfs7wxlL9JQtU',
  SHEET_NAME: 'department_inquery',          // the ONLY tab this API touches
  ACTIONS: {
    INQUIRIES: 'dashboard_inquiries',         // authenticated, read
    CLOSE: 'dashboard_close_ticket',          // authenticated, sets Status → Done
    PING: 'dashboard_ping'                    // unauthenticated health check (no data)
  },
  CLOSED_STATUS_VALUE: 'Done',                // value written when a ticket is closed
  TOKEN_CACHE_SECONDS: 300,
  API_VERSION: '2.0.0',

  // Public Supabase values (safe to embed; Script Properties override them if set).
  SUPABASE_URL: 'https://mdyniigwwhupdnxwtnvo.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_VpQjX0Y7Fh6PGrx0TmlAQA_dQ6t8xPf'
};

/**
 * WHO CAN SEE WHAT.
 * Emails are case-insensitive. Department names are matched against the
 * sheet's "Department" column ignoring case, spaces and punctuation, so
 * "General / Other/Hr" also matches "general/other/HR".
 * List several names for one user if the sheet uses more than one spelling.
 */
var DASHBOARD_ACCESS = {
  admins: [
    'vipin@ikrispharmanetwork.com',
    'bharat@ikrispharmanetwork.com'
  ],
  departments: {
    'marketing@ikrispharmanetwork.com':  ['IT / Technical Support'],
    'sneha@ikrispharmanetwork.com':      ['Rare Disease'],
    'ankita@ikrispharmanetwork.com':     ['Clinical Trial / RLD'],
    'operations@ikrispharmanetwork.com': ['Logistics', 'Logistic'],
    'maneesha@ikrispharmanetwork.com':   ['Real-World Data / Market Access'],
    'shilpi@ikrispharmanetwork.com':     ['Export'],
    'vipin20mar@gmail.com':              ['Hr', 'General / Other/Hr', 'General / Other'],
    'accounts@ikrispharmanetwork.com':   ['Account Teams'],
    'qa@ikrispharmanetwork.com':         ['Quality Assurance'],
    'vipindubey2032001@gmail.com':       ['Import/NPP', 'Import', 'NPP']
  }
};

/* ------------------------------------------------------------------ */
/*  Routing                                                            */
/* ------------------------------------------------------------------ */

/** True when a GET request is meant for the dashboard. */
function isDashboardRequest(e) {
  var action = e && e.parameter && e.parameter.action;
  var a = DASHBOARD_CONFIG.ACTIONS;
  return action === a.INQUIRIES || action === a.PING;
}

/** True when a POST request is meant for the dashboard (JSON body with a dashboard action). */
function isDashboardPost(e) {
  var body = dashboardParseBody(e);
  return !!(body && body.action === DASHBOARD_CONFIG.ACTIONS.CLOSE);
}

/** GET handler — always returns JSON, never throws. */
function handleDashboardRequest(e) {
  try {
    if (e.parameter.action === DASHBOARD_CONFIG.ACTIONS.PING) {
      return dashboardJsonResponse({
        ok: true,
        data: { service: 'ikris-dashboard-api', version: DASHBOARD_CONFIG.API_VERSION, time: new Date().toISOString() }
      });
    }
    var user = dashboardValidateRequest(e.parameter.token);
    var access = dashboardResolveAccess(user.email);
    var data = getDepartmentInquiries(access);
    return dashboardJsonResponse({ ok: true, user: dashboardPublicUser(user, access), data: data });
  } catch (err) {
    return dashboardErrorResponse(err);
  }
}

/** POST handler (close ticket) — always returns JSON, never throws. */
function handleDashboardPost(e) {
  try {
    var body = dashboardParseBody(e);
    if (!body || body.action !== DASHBOARD_CONFIG.ACTIONS.CLOSE) {
      throw dashboardError('BAD_REQUEST', 'Unknown request.');
    }
    var user = dashboardValidateRequest(body.token);
    var access = dashboardResolveAccess(user.email);
    var result = closeDepartmentInquiry(access, user, String(body.inquiryId || ''), Number(body.row) || 0);
    return dashboardJsonResponse({ ok: true, user: dashboardPublicUser(user, access), data: result });
  } catch (err) {
    return dashboardErrorResponse(err);
  }
}

function dashboardParseBody(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return null;
    return JSON.parse(e.postData.contents);
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Authentication & access                                            */
/* ------------------------------------------------------------------ */

/** Verifies a Supabase access token and returns { id, email }. */
function dashboardValidateRequest(token) {
  token = String(token || '').trim();
  if (!token) throw dashboardError('UNAUTHORIZED', 'Missing session token.');

  var parts = token.split('.');
  if (parts.length !== 3) throw dashboardError('UNAUTHORIZED', 'Malformed session token.');

  var payload = dashboardDecodeJwtPayload(parts[1]);
  var nowSec = Math.floor(Date.now() / 1000);
  if (!payload || !payload.exp || payload.exp <= nowSec) {
    throw dashboardError('UNAUTHORIZED', 'Session expired.');
  }

  var props = PropertiesService.getScriptProperties();
  var supabaseUrl = (props.getProperty('SUPABASE_URL') || DASHBOARD_CONFIG.SUPABASE_URL || '').replace(/\/+$/, '');
  var supabaseKey = props.getProperty('SUPABASE_PUBLISHABLE_KEY') || DASHBOARD_CONFIG.SUPABASE_PUBLISHABLE_KEY || '';
  if (!supabaseUrl || !supabaseKey) {
    throw dashboardError('CONFIG_ERROR', 'Dashboard API is not configured (Supabase values missing).');
  }
  if (payload.iss && String(payload.iss).indexOf(supabaseUrl) !== 0) {
    throw dashboardError('UNAUTHORIZED', 'Token was not issued by the configured Supabase project.');
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = 'dash_auth_' + dashboardSha256(token);
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var res;
  try {
    res = UrlFetchApp.fetch(supabaseUrl + '/auth/v1/user', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token, apikey: supabaseKey },
      muteHttpExceptions: true
    });
  } catch (fetchErr) {
    console.error('Supabase verification request failed: ' + fetchErr);
    throw dashboardError('AUTH_UNAVAILABLE', 'Could not verify your session right now. Please try again.');
  }

  var status = res.getResponseCode();
  if (status === 401 || status === 403) throw dashboardError('UNAUTHORIZED', 'Session is not valid.');
  if (status !== 200) {
    console.error('Supabase verification HTTP ' + status + ': ' + res.getContentText().slice(0, 300));
    throw dashboardError('AUTH_UNAVAILABLE', 'Could not verify your session right now. Please try again.');
  }

  var body = JSON.parse(res.getContentText());
  if (!body || !body.id || !body.email) throw dashboardError('UNAUTHORIZED', 'Session is not valid.');
  var user = { id: body.id, email: String(body.email).toLowerCase() };

  var ttl = Math.min(DASHBOARD_CONFIG.TOKEN_CACHE_SECONDS, payload.exp - nowSec - 5);
  if (ttl > 0) cache.put(cacheKey, JSON.stringify(user), ttl);
  return user;
}

/** Returns { role: 'admin'|'department', departments: [...] } or throws FORBIDDEN. */
function dashboardResolveAccess(email) {
  var cfg = DASHBOARD_ACCESS;
  var override = PropertiesService.getScriptProperties().getProperty('DASHBOARD_ACCESS_JSON');
  if (override) {
    try { cfg = JSON.parse(override); } catch (err) { console.error('DASHBOARD_ACCESS_JSON is not valid JSON; using built-in access list.'); }
  }
  email = String(email || '').toLowerCase().trim();

  var admins = (cfg.admins || []).map(function (a) { return String(a).toLowerCase().trim(); });
  if (admins.indexOf(email) !== -1) return { role: 'admin', departments: [] };

  var map = cfg.departments || {};
  for (var key in map) {
    if (Object.prototype.hasOwnProperty.call(map, key) && String(key).toLowerCase().trim() === email) {
      var deps = [].concat(map[key]).map(String).filter(function (d) { return d.trim(); });
      if (deps.length) return { role: 'department', departments: deps };
    }
  }
  throw dashboardError('FORBIDDEN', 'Your account has not been given access to the inquiry dashboard. Please contact the administrator.');
}

function dashboardPublicUser(user, access) {
  return { email: user.email, role: access.role, departments: access.departments };
}

/** "General / Other/Hr" → "generalotherhr" */
function dashboardNormDept(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function dashboardCanSeeDepartment(access, deptValue) {
  if (access.role === 'admin') return true;
  var d = dashboardNormDept(deptValue);
  if (!d) return false;
  return access.departments.some(function (x) { return dashboardNormDept(x) === d; });
}

function dashboardDecodeJwtPayload(segment) {
  try {
    var padded = segment + '===='.slice((segment.length % 4) || 4);
    var bytes = Utilities.base64DecodeWebSafe(padded);
    return JSON.parse(Utilities.newBlob(bytes).getDataAsString());
  } catch (err) {
    return null;
  }
}

function dashboardSha256(text) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return digest.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

/* ------------------------------------------------------------------ */
/*  Sheet helpers                                                      */
/* ------------------------------------------------------------------ */

function dashboardOpenSheet() {
  var ss;
  try {
    ss = SpreadsheetApp.openById(DASHBOARD_CONFIG.SPREADSHEET_ID);
  } catch (err) {
    console.error('openById failed: ' + err);
    throw dashboardError('SHEET_UNAVAILABLE', 'The inquiry spreadsheet could not be opened.');
  }
  var sheet = ss.getSheetByName(DASHBOARD_CONFIG.SHEET_NAME);
  if (!sheet) throw dashboardError('SHEET_NOT_FOUND', 'The "' + DASHBOARD_CONFIG.SHEET_NAME + '" tab was not found.');
  return { ss: ss, sheet: sheet, tz: ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone() };
}

/** Finds a column index (0-based) whose header matches the regex, or -1. */
function dashboardFindColumn(rawHeaders, regex) {
  for (var c = 0; c < rawHeaders.length; c++) {
    if (regex.test(String(rawHeaders[c] || '').trim())) return c;
  }
  return -1;
}

var DASHBOARD_COLUMN_PATTERNS = {
  id: /^(inquiry|inquery|enquiry|ticket)\s*(id|no|number)$/i,
  department: /(department|dept)/i,
  status: /status/i,
  closedBy: /^closed\s*by$/i,
  closedAt: /^closed\s*(at|on|date|time)$/i
};

/* ------------------------------------------------------------------ */
/*  Read                                                               */
/* ------------------------------------------------------------------ */

/**
 * Reads ALL headers and the rows this user may see from department_inquery.
 * Headers come from row 1, so new columns appear automatically.
 * Returns { sheet, headers[], rows[{ _row, <header>: <string> }], rowCount, generatedAt, timezone, scope }
 */
function getDepartmentInquiries(access) {
  access = access || { role: 'admin', departments: [] };
  var s = dashboardOpenSheet();
  var sheet = s.sheet;
  var tz = s.tz;
  var base = {
    sheet: DASHBOARD_CONFIG.SHEET_NAME,
    headers: [],
    rows: [],
    rowCount: 0,
    generatedAt: new Date().toISOString(),
    timezone: tz,
    scope: access.role === 'admin' ? 'all' : access.departments
  };

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return base;

  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var rawHeaders = values[0];
  var deptCol = dashboardFindColumn(rawHeaders, DASHBOARD_COLUMN_PATTERNS.department);
  if (access.role !== 'admin' && deptCol === -1) {
    throw dashboardError('MISSING_COLUMN', 'The sheet has no Department column, so department access cannot be applied.');
  }

  var columns = [];
  var seen = {};
  for (var c = 0; c < lastCol; c++) {
    var header = String(rawHeaders[c] == null ? '' : rawHeaders[c]).trim();
    if (!header) {
      var hasData = false;
      for (var r = 1; r < values.length && !hasData; r++) {
        if (!dashboardIsBlank(values[r][c])) hasData = true;
      }
      if (!hasData) continue;
      header = 'Column ' + (c + 1);
    }
    var name = header;
    var n = 2;
    while (seen[name.toLowerCase()]) name = header + ' (' + (n++) + ')';
    seen[name.toLowerCase()] = true;
    columns.push({ index: c, name: name });
  }

  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var isEmpty = true;
    for (var k = 0; k < columns.length; k++) {
      if (!dashboardIsBlank(row[columns[k].index])) { isEmpty = false; break; }
    }
    if (isEmpty) continue;
    if (!dashboardCanSeeDepartment(access, deptCol === -1 ? '' : row[deptCol])) continue;   // server-side filter

    var obj = { _row: i + 1 };
    for (var j = 0; j < columns.length; j++) {
      obj[columns[j].name] = dashboardCellToString(row[columns[j].index], tz);
    }
    rows.push(obj);
  }

  base.headers = columns.map(function (col) { return col.name; });
  base.rows = rows;
  base.rowCount = rows.length;
  return base;
}

/* ------------------------------------------------------------------ */
/*  Write: close ticket (Status → Done)                                */
/* ------------------------------------------------------------------ */

/**
 * Sets the Status cell of ONE inquiry to CLOSED_STATUS_VALUE.
 * The row is located by Inquiry ID (rowHint is only a fast-path and is re-verified).
 */
function closeDepartmentInquiry(access, user, inquiryId, rowHint) {
  inquiryId = String(inquiryId || '').trim();
  if (!inquiryId && !rowHint) throw dashboardError('BAD_REQUEST', 'No inquiry was specified.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw dashboardError('BUSY', 'The sheet is busy. Please try again in a moment.');
  try {
    var s = dashboardOpenSheet();
    var sheet = s.sheet;
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2) throw dashboardError('NOT_FOUND', 'Inquiry not found.');

    var rawHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var idCol = dashboardFindColumn(rawHeaders, DASHBOARD_COLUMN_PATTERNS.id);
    var deptCol = dashboardFindColumn(rawHeaders, DASHBOARD_COLUMN_PATTERNS.department);
    var statusCol = dashboardFindColumn(rawHeaders, DASHBOARD_COLUMN_PATTERNS.status);
    if (statusCol === -1) throw dashboardError('MISSING_COLUMN', 'The sheet has no Status column.');
    if (idCol === -1 && !rowHint) throw dashboardError('MISSING_COLUMN', 'The sheet has no Inquiry ID column.');

    // Locate the row.
    var rowNumber = 0;
    if (idCol !== -1 && inquiryId) {
      if (rowHint >= 2 && rowHint <= lastRow &&
          String(sheet.getRange(rowHint, idCol + 1).getValue()).trim() === inquiryId) {
        rowNumber = rowHint;
      } else {
        var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
        for (var i = 0; i < ids.length; i++) {
          if (String(ids[i][0]).trim() === inquiryId) { rowNumber = i + 2; break; }
        }
      }
    } else if (rowHint >= 2 && rowHint <= lastRow) {
      rowNumber = rowHint;
    }
    if (!rowNumber) throw dashboardError('NOT_FOUND', 'Inquiry ' + inquiryId + ' was not found in the sheet.');

    var rowValues = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
    if (!dashboardCanSeeDepartment(access, deptCol === -1 ? '' : rowValues[deptCol])) {
      throw dashboardError('FORBIDDEN', 'You can only close inquiries of your own department.');
    }

    var previous = String(rowValues[statusCol] == null ? '' : rowValues[statusCol]).trim();
    var target = DASHBOARD_CONFIG.CLOSED_STATUS_VALUE;
    var closedAt = new Date();
    if (previous.toLowerCase() === target.toLowerCase()) {
      return { inquiryId: inquiryId, row: rowNumber, status: previous, previous: previous, alreadyClosed: true };
    }

    // The only writes: Status, plus Closed By / Closed At if those columns already exist.
    sheet.getRange(rowNumber, statusCol + 1).setValue(target);
    var closedByCol = dashboardFindColumn(rawHeaders, DASHBOARD_COLUMN_PATTERNS.closedBy);
    var closedAtCol = dashboardFindColumn(rawHeaders, DASHBOARD_COLUMN_PATTERNS.closedAt);
    if (closedByCol !== -1) sheet.getRange(rowNumber, closedByCol + 1).setValue(user.email);
    if (closedAtCol !== -1) sheet.getRange(rowNumber, closedAtCol + 1).setValue(closedAt);
    SpreadsheetApp.flush();

    console.log('Inquiry ' + inquiryId + ' (row ' + rowNumber + ') closed by ' + user.email + ': "' + previous + '" → "' + target + '"');
    return {
      inquiryId: inquiryId,
      row: rowNumber,
      status: target,
      previous: previous,
      closedBy: user.email,
      closedAt: dashboardFormatDate(closedAt, s.tz),
      alreadyClosed: false
    };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/*  Formatting, responses & errors                                     */
/* ------------------------------------------------------------------ */

function dashboardIsBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function dashboardCellToString(v, tz) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return dashboardFormatDate(v, tz);
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).trim();
}

/** Date cell → ISO-8601 with offset, e.g. 2026-09-29T18:20:52.778+05:30 */
function dashboardFormatDate(date, tz) {
  if (!date || isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, tz || Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
}

function dashboardJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function dashboardError(code, message) {
  var err = new Error(message);
  err.dashboardCode = code;
  return err;
}

/** Any error → safe JSON (no stack traces leak). */
function dashboardErrorResponse(err) {
  var code = err && err.dashboardCode;
  if (!code) {
    console.error('Dashboard API unexpected error: ' + (err && err.stack ? err.stack : err));
    code = 'SERVER_ERROR';
  }
  var message = code === 'SERVER_ERROR' ? 'An unexpected error occurred while processing the request.' : err.message;
  return dashboardJsonResponse({ ok: false, error: { code: code, message: message } });
}

/* ------------------------------------------------------------------ */
/*  Maintenance (run manually from the editor)                         */
/* ------------------------------------------------------------------ */

/** Checks sheet access and prints what each configured user would see. Changes nothing. */
function dashboardSelfTest() {
  var data = getDepartmentInquiries({ role: 'admin', departments: [] });
  console.log('Sheet: ' + data.sheet + '  Rows: ' + data.rowCount + '  Timezone: ' + data.timezone);
  console.log('Headers: ' + JSON.stringify(data.headers));
  var deptHeader = data.headers.filter(function (h) { return DASHBOARD_COLUMN_PATTERNS.department.test(h); })[0];
  var sheetDepts = {};
  data.rows.forEach(function (r) { if (deptHeader && r[deptHeader]) sheetDepts[r[deptHeader]] = (sheetDepts[r[deptHeader]] || 0) + 1; });
  console.log('Departments in sheet: ' + JSON.stringify(sheetDepts));
  console.log('Admins (see all ' + data.rowCount + '): ' + DASHBOARD_ACCESS.admins.join(', '));
  Object.keys(DASHBOARD_ACCESS.departments).forEach(function (email) {
    var access = { role: 'department', departments: DASHBOARD_ACCESS.departments[email] };
    var n = data.rows.filter(function (r) { return dashboardCanSeeDepartment(access, deptHeader ? r[deptHeader] : ''); }).length;
    console.log(email + ' → ' + access.departments.join(' | ') + ' → ' + n + ' inquiries');
  });
}


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


/* ------------------------------------------------------------------ */
/*  Web App entry points (standalone project only)                     */
/* ------------------------------------------------------------------ */
function doGet(e) {
  if (isDashboardRequest(e)) return handleDashboardRequest(e);
  return dashboardJsonResponse({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown request.' } });
}

function doPost(e) {
  if (isDashboardPost(e)) return handleDashboardPost(e);
  return dashboardJsonResponse({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown request.' } });
}
