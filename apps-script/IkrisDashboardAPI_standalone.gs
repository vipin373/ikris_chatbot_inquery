/**
 * IKRIS DASHBOARD API — STANDALONE VERSION (one file, copy-paste ready)
 * Paste this whole file into a NEW, separate Apps Script project (script.google.com → New project).
 * It is completely separate from the Apps Script attached to your sheet, so your existing
 * chatbot / email automation is not touched. It only READS the department_inquery tab.
 */

/**
 * =====================================================================
 *  IKRIS PHARMA NETWORK — Department Inquiry Dashboard API
 *  Standalone project — the only file in "Ikris Dashboard API"
 * =====================================================================
 *
 *  What this file does
 *  -------------------
 *  • Exposes a READ-ONLY JSON endpoint for the dashboard.
 *  • Reads ONLY the "department_inquery" tab. No other tab is touched.
 *  • Every request must carry a valid Supabase access token. The token is
 *    verified server-side against Supabase Auth (GET /auth/v1/user) before
 *    any sheet data is returned.
 *  • The Google Sheet itself stays private. The web app runs as YOU, so
 *    no Google credentials ever reach the browser.
 *
 *  Naming
 *  ------
 *  All helpers are prefixed with "dashboard" so they cannot collide with
 *  functions in your existing email/inquiry automation (e.g. an existing
 *  jsonResponse() or formatDate()). The equivalents of the requested names:
 *
 *    doGet()                  -> routed via handleDashboardRequest(e)
 *    getDepartmentInquiries() -> getDepartmentInquiries()
 *    jsonResponse()           -> dashboardJsonResponse()
 *    formatDate()             -> dashboardFormatDate()
 *    validateRequest()        -> dashboardValidateRequest()
 *
 *  doGet()
 *  -------
 *  Declared at the bottom of this file (standalone project only).
 *
 *  Script Properties (Project Settings → Script Properties)
 *  --------------------------------------------------------
 *  All optional — defaults are in DASHBOARD_CONFIG below.
 *    SUPABASE_URL              https://mdyniigwwhupdnxwtnvo.supabase.co
 *    SUPABASE_PUBLISHABLE_KEY  sb_publishable_...   (public key, NOT service_role)
 *    DASHBOARD_ALLOWED_DOMAINS default "ikrispharmanetwork.com". Comma-separated;
 *                              only users whose email is on one of these domains
 *                              get data. Set to "*" to allow any verified user.
 * =====================================================================
 */

var DASHBOARD_CONFIG = {
  SPREADSHEET_ID: '1JWgKel_MnCtZKnm4s-knliTYyVzRBITfs7wxlL9JQtU',
  SHEET_NAME: 'department_inquery',          // the ONLY tab this API reads
  ACTIONS: {
    INQUIRIES: 'dashboard_inquiries',         // authenticated data request
    PING: 'dashboard_ping'                    // unauthenticated health check (returns no data)
  },
  TOKEN_CACHE_SECONDS: 300,                   // cache verified tokens for up to 5 min
  API_VERSION: '1.1.0',

  // Public Supabase values (safe to embed; Script Properties override them if set).
  SUPABASE_URL: 'https://mdyniigwwhupdnxwtnvo.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_VpQjX0Y7Fh6PGrx0TmlAQA_dQ6t8xPf',
  // Only these email domains receive data. Override with the DASHBOARD_ALLOWED_DOMAINS
  // Script Property (set it to "*" to allow any verified Supabase user).
  DEFAULT_ALLOWED_DOMAINS: 'ikrispharmanetwork.com'
};

/* ------------------------------------------------------------------ */
/*  Routing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Returns true when a GET request is meant for the dashboard.
 * Use this at the very top of your existing doGet(e).
 */
function isDashboardRequest(e) {
  var action = e && e.parameter && e.parameter.action;
  if (!action) return false;
  var actions = DASHBOARD_CONFIG.ACTIONS;
  return action === actions.INQUIRIES || action === actions.PING;
}

/**
 * Main dashboard handler. Always returns a JSON TextOutput and never throws.
 */
function handleDashboardRequest(e) {
  try {
    var action = e.parameter.action;

    if (action === DASHBOARD_CONFIG.ACTIONS.PING) {
      return dashboardJsonResponse({
        ok: true,
        data: { service: 'ikris-dashboard-api', version: DASHBOARD_CONFIG.API_VERSION, time: new Date().toISOString() }
      });
    }

    var user = dashboardValidateRequest(e);          // throws on invalid/expired token
    var data = getDepartmentInquiries();             // throws on sheet problems
    return dashboardJsonResponse({ ok: true, user: { email: user.email }, data: data });

  } catch (err) {
    return dashboardErrorResponse(err);
  }
}

/* ------------------------------------------------------------------ */
/*  Authentication (Supabase access-token verification)                */
/* ------------------------------------------------------------------ */

/**
 * Validates the request's Supabase access token and returns { id, email }.
 * Throws a dashboard error with code UNAUTHORIZED / FORBIDDEN / CONFIG_ERROR.
 */
function dashboardValidateRequest(e) {
  var token = (e.parameter.token || '').trim();
  if (!token) throw dashboardError('UNAUTHORIZED', 'Missing session token.');

  var parts = token.split('.');
  if (parts.length !== 3) throw dashboardError('UNAUTHORIZED', 'Malformed session token.');

  // Cheap local pre-checks before calling Supabase: expiry + issuer.
  var payload = dashboardDecodeJwtPayload(parts[1]);
  var nowSec = Math.floor(Date.now() / 1000);
  if (!payload || !payload.exp || payload.exp <= nowSec) {
    throw dashboardError('UNAUTHORIZED', 'Session expired.');
  }

  var props = PropertiesService.getScriptProperties();
  var supabaseUrl = (props.getProperty('SUPABASE_URL') || DASHBOARD_CONFIG.SUPABASE_URL || '').replace(/\/+$/, '');
  var supabaseKey = props.getProperty('SUPABASE_PUBLISHABLE_KEY') || DASHBOARD_CONFIG.SUPABASE_PUBLISHABLE_KEY || '';
  if (!supabaseUrl || !supabaseKey) {
    throw dashboardError('CONFIG_ERROR', 'Dashboard API is not configured (Supabase script properties missing).');
  }
  if (payload.iss && String(payload.iss).indexOf(supabaseUrl) !== 0) {
    throw dashboardError('UNAUTHORIZED', 'Token was not issued by the configured Supabase project.');
  }

  // Cache successful verifications so 30-second polling does not hit Supabase every time.
  var cache = CacheService.getScriptCache();
  var cacheKey = 'dash_auth_' + dashboardSha256(token);
  var cached = cache.get(cacheKey);
  var user = cached ? JSON.parse(cached) : null;

  if (!user) {
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
    user = { id: body.id, email: String(body.email).toLowerCase() };

    var ttl = Math.min(DASHBOARD_CONFIG.TOKEN_CACHE_SECONDS, payload.exp - nowSec - 5);
    if (ttl > 0) cache.put(cacheKey, JSON.stringify(user), ttl);
  }

  // Optional: restrict access to company email domains.
  var allowedSetting = props.getProperty('DASHBOARD_ALLOWED_DOMAINS');
  if (allowedSetting === null) allowedSetting = DASHBOARD_CONFIG.DEFAULT_ALLOWED_DOMAINS;
  if (String(allowedSetting).trim() === '*') allowedSetting = '';
  var allowed = String(allowedSetting || '')
    .split(',').map(function (d) { return d.trim().toLowerCase().replace(/^@/, ''); })
    .filter(function (d) { return d; });
  if (allowed.length) {
    var domain = user.email.split('@')[1] || '';
    if (allowed.indexOf(domain) === -1) {
      throw dashboardError('FORBIDDEN', 'Your account is not authorised to view inquiry data.');
    }
  }

  return user;
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
/*  Data                                                               */
/* ------------------------------------------------------------------ */

/**
 * Reads ALL headers and ALL non-empty rows from department_inquery.
 * Headers are taken dynamically from row 1, so new columns added to the
 * right of the sheet are returned automatically.
 *
 * Returns { sheet, headers[], rows[{ _row, <header>: <string value> }], rowCount, generatedAt, timezone }
 */
function getDepartmentInquiries() {
  var ss;
  try {
    ss = SpreadsheetApp.openById(DASHBOARD_CONFIG.SPREADSHEET_ID);
  } catch (err) {
    console.error('openById failed: ' + err);
    throw dashboardError('SHEET_UNAVAILABLE', 'The inquiry spreadsheet could not be opened.');
  }

  var sheet = ss.getSheetByName(DASHBOARD_CONFIG.SHEET_NAME);
  if (!sheet) {
    throw dashboardError('SHEET_NOT_FOUND', 'The "' + DASHBOARD_CONFIG.SHEET_NAME + '" tab was not found.');
  }

  var tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  var base = {
    sheet: DASHBOARD_CONFIG.SHEET_NAME,
    headers: [],
    rows: [],
    rowCount: 0,
    generatedAt: new Date().toISOString(),
    timezone: tz
  };

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return base;            // completely empty tab

  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var rawHeaders = values[0];

  // Keep a column when it has a header OR any data; name blank headers "Column N";
  // de-duplicate repeated header names ("Notes", "Notes (2)").
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
    if (isEmpty) continue;                                 // skip empty rows safely

    var obj = { _row: i + 1 };                             // actual sheet row number
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

function dashboardIsBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Normalises every cell to a string so the frontend gets predictable JSON. */
function dashboardCellToString(v, tz) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return dashboardFormatDate(v, tz);
  if (typeof v === 'number') {
    // Avoid "8.448645084E9" style output for phone numbers.
    return Number.isInteger(v) ? v.toFixed(0) : String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).trim();
}

/**
 * Converts a real Date cell into ISO-8601 with the spreadsheet's offset,
 * e.g. 2026-09-29T18:20:52.778+05:30. Invalid dates return ''.
 */
function dashboardFormatDate(date, tz) {
  if (!date || isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, tz || Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
}

/* ------------------------------------------------------------------ */
/*  Responses & errors                                                 */
/* ------------------------------------------------------------------ */

function dashboardJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function dashboardError(code, message) {
  var err = new Error(message);
  err.dashboardCode = code;
  return err;
}

/** Converts any error into a safe JSON response (no stack traces leak). */
function dashboardErrorResponse(err) {
  var code = err && err.dashboardCode;
  if (!code) {
    console.error('Dashboard API unexpected error: ' + (err && err.stack ? err.stack : err));
    code = 'SERVER_ERROR';
  }
  var message = code === 'SERVER_ERROR'
    ? 'An unexpected error occurred while reading inquiry data.'
    : err.message;
  return dashboardJsonResponse({ ok: false, error: { code: code, message: message } });
}

/* ------------------------------------------------------------------ */
/*  Maintenance helpers (run manually from the editor)                 */
/* ------------------------------------------------------------------ */

/**
 * Run once from the editor to check the sheet can be read.
 * View → Logs shows the headers and row count. Does not need a token.
 */
function dashboardSelfTest() {
  var data = getDepartmentInquiries();
  console.log('Sheet: ' + data.sheet);
  console.log('Headers: ' + JSON.stringify(data.headers));
  console.log('Rows: ' + data.rowCount + '  Timezone: ' + data.timezone);
  var props = PropertiesService.getScriptProperties();
  console.log('Supabase URL: ' + (props.getProperty('SUPABASE_URL') || DASHBOARD_CONFIG.SUPABASE_URL));
  var domains = props.getProperty('DASHBOARD_ALLOWED_DOMAINS');
  console.log('Allowed email domains: ' + (domains === null ? DASHBOARD_CONFIG.DEFAULT_ALLOWED_DOMAINS : domains));
}

/* ------------------------------------------------------------------ */
/*  Web App entry point (standalone project only)                      */
/* ------------------------------------------------------------------ */
function doGet(e) {
  if (isDashboardRequest(e)) return handleDashboardRequest(e);
  return dashboardJsonResponse({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown request.' } });
}
