# Ikris Pharma Network — Department Inquiry Dashboard

Internal, read-only dashboard for the **`department_inquery`** tab of the `CHATBOT_IKRIS` Google Sheet.

- **Frontend:** plain HTML + CSS + vanilla JavaScript (no React / Next / Vite, no build step) → hosted on **GitHub Pages**
- **Authentication:** **Supabase Auth** only (register, login, logout, session, password reset)
- **Data:** **Google Sheet** stays the single source of truth, read **live** through a **Google Apps Script** Web App
- No Supabase database tables are used. No inquiry data is stored anywhere except your sheet.

```
GitHub Pages (index.html · style.css · app.js · config.js)
      │  1. user signs in with Supabase Auth  ──►  Supabase (project "IKRIS Dashboard")
      │  2. GET ?action=dashboard_inquiries&token=<Supabase access token>
      ▼
Google Apps Script Web App (DashboardAPI.gs, runs as the sheet owner)
      │  3. verifies the token with Supabase  GET /auth/v1/user
      │  4. reads ONLY the tab "department_inquery"
      ▼
Google Sheet 1JWgKel_MnCtZKnm4s-knliTYyVzRBITfs7wxlL9JQtU  (remains private)
```

---

## 1. Files and where each one goes

| File | Where it goes |
|---|---|
| `index.html` | Root of the GitHub repository |
| `style.css` | Root of the GitHub repository |
| `app.js` | Root of the GitHub repository |
| `config.js` | Root of the GitHub repository (edit `GOOGLE_APPS_SCRIPT_URL` first) |
| `README.md` | Root of the GitHub repository |
| `apps-script/DashboardAPI.gs` | **Not** GitHub Pages — paste into your existing Apps Script project as a **new file** named `DashboardAPI` |

Keeping `apps-script/DashboardAPI.gs` in the repo as a reference copy is fine — it contains no secrets.

---

## 2. What is safe to publish (security)

| Value | Where it lives | Safe in GitHub? |
|---|---|---|
| Supabase Project URL `https://mdyniigwwhupdnxwtnvo.supabase.co` | `config.js`, Apps Script property | ✅ Yes — public |
| Supabase **publishable** key `sb_publishable_…` | `config.js`, Apps Script property | ✅ Yes — designed for browsers |
| Apps Script Web App URL `…/exec` | `config.js` | ✅ Yes — returns data only for a verified session |
| Supabase **service_role / secret** key (`sb_secret_…`) | Nowhere in this project | ❌ **Never** |
| Google service-account keys, OAuth client secrets | Not needed at all | ❌ **Never** |

Why the data stays protected:

- The sheet is **not** published or shared publicly. The Web App runs **as you**, so the browser never gets Google credentials.
- Every data request must include the user's Supabase **access token**. `DashboardAPI.gs` checks the expiry and issuer, then asks Supabase (`/auth/v1/user`) whether the token is genuine. Invalid or expired tokens get `UNAUTHORIZED` and no data.
- Verified tokens are cached for up to 5 minutes (never beyond their expiry) so 30-second polling doesn't hammer Supabase.
- Only the `department_inquery` tab is read. FAQ, medicine, Logistics_tracker, department_contacts, Bot_Config and n8n_Tool_Map are never opened.
- The API is read-only. It has no write action.

> ⚠️ **Important — who can register?** As requested, every registered user can view the dashboard. Because anyone who finds the URL could register, please do at least one of these:
> 1. **Recommended:** set the Apps Script property `DASHBOARD_ALLOWED_DOMAINS` = `ikrispharmanetwork.com`. Only verified `@ikrispharmanetwork.com` accounts then receive data (others can sign in but see "not authorised").
> 2. Keep **Confirm email** switched on in Supabase (default), so nobody can use an address they don't own.
> 3. After your team has registered, turn off **Allow new users to sign up** in Supabase (Authentication → Sign In / Providers) and invite new staff from the Supabase dashboard instead.

---

## 3. Google Apps Script setup (backend)

### 3.0 Recommended: separate standalone project (zero changes to your sheet's script)
1. Open **https://script.google.com** → **New project**. Rename it `Ikris Dashboard API`.
2. Replace everything in `Code.gs` with the full contents of `apps-script/IkrisDashboardAPI_standalone.gs` → **Save**.
3. Choose `dashboardSelfTest` in the function dropdown → **Run** → approve access. The log lists the sheet headers.
4. **Deploy → New deployment → Web app** · Execute as **Me** · Who has access **Anyone** → **Deploy** → copy the `/exec` URL into `config.js`.

No Script Properties are needed: the public Supabase values and the default allowed domain (`ikrispharmanetwork.com`) are built in. (Optional: in Project Settings tick "Show appsscript.json" and replace it with `apps-script/appsscript.json` to limit the script to **read-only** spreadsheet access.)

Sections 3.1–3.5 below are the alternative: adding the API into the Apps Script already attached to the sheet.

Your existing email/inquiry automation is **not changed or deleted**. You only add one file and, if needed, two lines to `doGet`.

### 3.1 Add the dashboard file
1. Open the sheet → **Extensions → Apps Script** (your existing project).
2. In the left **Files** panel click **+ → Script**, name it **`DashboardAPI`** (the editor adds `.gs`).
3. Delete the placeholder `function myFunction() {}` in that new file only, then paste the full contents of `apps-script/DashboardAPI.gs`.
4. Click **Save** 💾.

All helper functions are prefixed with `dashboard…` (e.g. `dashboardJsonResponse`, `dashboardFormatDate`, `dashboardValidateRequest`) so they can't clash with an existing `jsonResponse()` or `formatDate()` in your automation. `DashboardAPI.gs` deliberately does **not** declare `doGet()`, so a duplicate is impossible.

### 3.2 Connect it to `doGet()`
Use the editor search (**Ctrl/Cmd + F** in each file, or look through each file) for `function doGet`.

**Case A — you already have a `doGet(e)`:** add this as the **first line inside it**. Nothing else changes.
```javascript
function doGet(e) {
  if (isDashboardRequest(e)) return handleDashboardRequest(e);   // ← add this line
  // ... your existing doGet code continues unchanged ...
}
```
If your existing function is written `function doGet()` (no `e`), change it to `function doGet(e)`.

**Case B — there is no `doGet` anywhere:** create another new script file `DashboardRouter` containing:
```javascript
function doGet(e) {
  if (isDashboardRequest(e)) return handleDashboardRequest(e);
  return dashboardJsonResponse({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown request.' } });
}
```
Your `doPost()` (e.g. used by n8n) is not touched.

### 3.3 Script Properties
**Project Settings (⚙️) → Script Properties → Add script property**:

| Property | Value |
|---|---|
| `SUPABASE_URL` | `https://mdyniigwwhupdnxwtnvo.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_VpQjX0Y7Fh6PGrx0TmlAQA_dQ6t8xPf` |
| `DASHBOARD_ALLOWED_DOMAINS` | `ikrispharmanetwork.com` *(optional, recommended; comma-separate several)* |

### 3.4 Self-test
In the editor choose the function **`dashboardSelfTest`** → **Run**. Approve the permissions prompt (Sheets + external requests). The **Execution log** should list the headers of `department_inquery` and the row count.

### 3.5 Deploy the Web App
1. **Deploy → New deployment** → gear icon → **Web app**.
2. Description: `Dashboard API v1`
3. **Execute as:** **Me** (your account)
4. **Who has access:** **Anyone**
   *(Required so the browser can call it without a Google login. Data is still protected by the Supabase token check. The sheet itself stays private.)*
5. **Deploy** → copy the **Web app URL** ending in `/exec`.

> If your project already has a Web App deployment used by other automation, you can instead use **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same, and existing callers keep working because the dashboard route only answers `action=dashboard_inquiries` / `action=dashboard_ping`.

**Every time you change Apps Script code** you must publish a **new version** of the deployment (Manage deployments → Edit → New version), otherwise the old code keeps running.

Quick check in a browser: `https://script.google.com/macros/s/<ID>/exec?action=dashboard_ping` → `{"ok":true,...}`. Calling `?action=dashboard_inquiries` without a token returns `UNAUTHORIZED` — that is correct.

---

## 4. Frontend configuration (`config.js`)

`config.js` is the only file you edit:

```javascript
SUPABASE_URL: 'https://mdyniigwwhupdnxwtnvo.supabase.co',          // already filled
SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_VpQjX0Y7Fh6PGrx0TmlAQA_dQ6t8xPf', // already filled
GOOGLE_APPS_SCRIPT_URL: 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec', // ← paste your /exec URL
APP_URL: '',                 // optional: 'https://USERNAME.github.io/REPOSITORY/'
REFRESH_INTERVAL_MS: 30000,  // live refresh every 30 s
PAGE_SIZE: 25,
MIN_PASSWORD_LENGTH: 8
```

Until `GOOGLE_APPS_SCRIPT_URL` is set, users can sign in and the dashboard shows a "not configured yet" notice instead of data.

---

## 5. GitHub Pages deployment

### 5.1 Create the repository
1. github.com → **+ → New repository**.
2. Name, e.g. `ikris-inquiry-dashboard`. Choose **Public** (free GitHub Pages) or **Private** (needs a paid plan for Pages). The code contains no secrets either way; data is never in the repo.
3. **Create repository**.

### 5.2 Upload the files
1. In the new repo click **Add file → Upload files**.
2. Drag in `index.html`, `style.css`, `app.js`, `config.js`, `README.md` (and optionally the `apps-script` folder).
3. **Commit changes**.

### 5.3 Enable GitHub Pages
1. Repo **Settings → Pages**.
2. **Source:** *Deploy from a branch* → **Branch:** `main` / `/ (root)` → **Save**.
3. After ~1 minute the site is live at `https://USERNAME.github.io/REPOSITORY/`.

### 5.4 Custom domain (later, optional)
1. In your DNS provider add a **CNAME** record, e.g. `inquiries.ikrispharmanetwork.com` → `USERNAME.github.io`.
2. Repo **Settings → Pages → Custom domain** → enter `inquiries.ikrispharmanetwork.com` → Save → tick **Enforce HTTPS** once available.
3. Add the new domain to Supabase URL Configuration (section 6) and set `APP_URL` in `config.js`.

---

## 6. Supabase configuration

Project: **IKRIS Dashboard** (`mdyniigwwhupdnxwtnvo`, region ap-south-1).

### 6.1 URL Configuration
Supabase Dashboard → **Authentication → URL Configuration**:

- **Site URL:** `https://USERNAME.github.io/REPOSITORY/`
- **Redirect URLs** → **Add URL**:
  - `https://USERNAME.github.io/REPOSITORY/`
  - `https://USERNAME.github.io/REPOSITORY/**`
  - (later) `https://inquiries.ikrispharmanetwork.com/**`
  - (optional, local testing) `http://localhost:8000/**`

The password-reset and email-confirmation links are sent with `redirectTo` = the dashboard URL (from `APP_URL`, or the current page address). The URL **must** be in the Redirect URLs list or Supabase will fall back to the Site URL.

### 6.2 Email / password provider
**Authentication → Sign In / Providers → Email**:
- **Enable Email provider:** on
- **Confirm email:** on (recommended)
- **Minimum password length:** 8 (matches `MIN_PASSWORD_LENGTH`)

### 6.3 Emails
**Authentication → Emails**: the default templates work. Optional: brand the "Confirm signup" and "Reset password" templates with Ikris wording. Supabase's built-in email sender has low hourly limits — for production, configure **SMTP** (e.g. your Google Workspace / company mail) under **Authentication → Emails → SMTP Settings**.

### 6.4 How the auth flows work
| Flow | What happens |
|---|---|
| Register | `supabase.auth.signUp()` → verification email → link returns to the dashboard and signs the user in |
| Login | `supabase.auth.signInWithPassword()` → session stored in the browser (stays logged in) |
| Session | `supabase.auth.getSession()` on load, `onAuthStateChange()` for changes; tokens auto-refresh |
| Logout | `supabase.auth.signOut()` → polling stops, all inquiry data is wiped from memory, login screen shown |
| Forgot password | `supabase.auth.resetPasswordForEmail(email, { redirectTo })` → link opens the "Choose a new password" screen → `supabase.auth.updateUser({ password })` |
| Expired session | the API returns `UNAUTHORIZED` → the app refreshes the token once; if that fails the user is signed out with a clear message |

---

## 7. How the dashboard reads the sheet

- Headers come from **row 1** of `department_inquery` every time. New columns on the right appear automatically (table → details drawer; Settings → Detected columns).
- Detected automatically by header name: Inquiry ID, Date/Time, Name, Phone, Company, Country, Department, **Status**, Assigned To, Email, Problem / Inquiry, Product / Medicine. If a column is missing, its filter / chart / KPI hides itself.
- **Status handling** (current sheet uses `New` and `Done`):
  - *New*: New, Open, Received, Unassigned
  - *Pending*: Pending, In Progress, Assigned, Awaiting, On hold, Follow up… and any other non-empty value
  - *Completed*: Done, Resolved, Completed, Closed
  - If the sheet ever has **no Status column**, the KPIs switch to Total / Received today / Last 7 days / Departments — no invented statuses.
- Department, Country and Status filter options are built from the live data (case-insensitive, so `uk` and `UK` are one option).
- Dates like `2026-09-29T18:20:52.778+05:30` are shown as `29 Sep 2026, 6:20 PM`. If a date cell is blank, the date encoded in the Inquiry ID (`INQ-YYMMDD-HHMMSS-…`) is used.
- **New inquiry alerts:** the first load remembers all Inquiry IDs; any new ID in later refreshes shows a toast ("New Department Inquiry Received" with ID, name, department, time and *View Inquiry*), highlights the row as **NEW**, updates KPIs, and adds a badge in the sidebar.
- **Live refresh:** initial load + every 30 s + manual **Refresh**. While the browser tab is hidden it slows to every 60 s, and refreshes immediately when you return. Failed refreshes keep the data already on screen and show *"Unable to refresh inquiry data. Please try again."*

### When the sheet grows large
Everything is filtered client-side after one request, which is comfortable up to several thousand rows. Beyond that, extend `getDepartmentInquiries()` with parameters such as `since=<ISO date>` (return only rows newer than the last poll), `limit`/`offset` (server-side pages) or `department=` (server-side filtering), and cache the sheet read for ~15 s with `CacheService` so many simultaneous users share one read.

---

## 8. Testing checklist

| # | Test | Expected |
|---|---|---|
| 1 | Open the GitHub Pages URL | Login page appears |
| 2 | Click **Create account** | Registration form appears |
| 3 | Register with a valid email/password | "Account created… verification link" message; user visible in Supabase → Authentication → Users |
| 3b | Register with mismatched passwords / an existing email | Friendly error, no account created |
| 4 | Confirm email, then log in | Dashboard appears with your email in the header |
| 4b | Wrong password | "Incorrect email or password" |
| 5 | Dashboard loads | Real rows from `department_inquery` (e.g. INQ-260928-142246-780 · Raman · Export). No demo data |
| 6 | Add a row to the sheet (new Inquiry ID), wait ≤ 30 s | Toast "New Department Inquiry Received", row marked NEW, KPIs increase |
| 7 | Search `INQ-260928` / `Raman` / `India` / `Export` | Matching inquiries only |
| 8 | Department filter = Export (or click the Export card) | Only Export inquiries |
| 9 | Click a row (or press Enter on it) | Inquiry Details drawer with every column; Esc / Close closes it |
| 10 | Click **Logout** | Returns to login; data cleared |
| 11 | Reload the URL after logout | Login screen; no inquiry data visible. `…/exec?action=dashboard_inquiries` without a token → `UNAUTHORIZED` |
| 12 | **Forgot password?** → email → open link | "Choose a new password" screen → update → signed in |
| 13 | Rename the tab temporarily (optional) | "department_inquery sheet could not be found"; rename back to restore |
| 14 | Resize to phone width | Menu button opens navigation; table scrolls horizontally |

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| "Google Apps Script URL has not been set" | Paste the `/exec` URL into `config.js` and commit |
| "Unexpected response" / network error on refresh | Deployment access must be **Anyone**; use the `/exec` URL (not `/dev`); publish a **new version** after code edits |
| "Inquiry service is not fully configured" | Add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` Script Properties |
| "Not authorised to view inquiry data" | The user's email domain is not in `DASHBOARD_ALLOWED_DOMAINS` |
| Reset / confirmation link opens the wrong page | Add the exact GitHub Pages URL to Supabase **Redirect URLs** and **Site URL** |
| Emails not arriving | Check spam; configure custom SMTP in Supabase (built-in sender is rate-limited) |
