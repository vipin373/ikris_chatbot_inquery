/* =====================================================================
   IKRIS PHARMA NETWORK — Department Inquiry Dashboard
   app.js  (plain modern JavaScript, no framework, no build step)

   Modules (in order):
     Fmt       formatting & parsing helpers
     Columns   dynamic column detection from sheet headers
     Status    status value → group mapping (new / pending / completed)
     State     single in-memory app state (cleared on logout)
     UI        view switching, live indicator, banners, sidebar
     Notify    toast notifications (new inquiry alerts etc.)
     Auth      Supabase authentication (register, login, logout, reset)
     Api       Google Apps Script API client (token-authenticated)
     Data      load → normalise → detect new inquiries
     Poller    30-second live refresh (stops on logout)
     Dashboard KPI cards, department summary, latest inquiries
     Filters   search + dropdown + date filters
     Table     sortable, paginated inquiry table
     Drawer    inquiry details side panel
     Charts    Chart.js analytics
     Settings  account + data-source information
     App       lifecycle: enter / leave dashboard, boot
   ===================================================================== */
(() => {
  'use strict';

  const CFG = window.IKRIS_CONFIG || {};
  const REFRESH_MS = Math.max(10000, Number(CFG.REFRESH_INTERVAL_MS) || 30000);
  const MIN_PASS = Math.max(6, Number(CFG.MIN_PASSWORD_LENGTH) || 8);
  const API_ACTION = 'dashboard_inquiries';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ===================================================================
     Fmt — formatting helpers
     =================================================================== */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const Fmt = {
    esc(v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    pad: (n) => String(n).padStart(2, '0'),
    num: (n) => Number(n || 0).toLocaleString('en-IN'),
    norm: (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' '),

    /** 30 Sep 2026, 11:45 AM */
    dateTime(d) {
      if (!d) return '';
      const h = d.getHours();
      return `${Fmt.pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h % 12 || 12}:${Fmt.pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
    },
    date(d) { return d ? `${Fmt.pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : ''; },
    time(d) {
      if (!d) return '';
      const h = d.getHours();
      return `${h % 12 || 12}:${Fmt.pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
    },
    dayKey(d) { return `${d.getFullYear()}-${Fmt.pad(d.getMonth() + 1)}-${Fmt.pad(d.getDate())}`; },
    relative(d) {
      if (!d) return '';
      const s = Math.round((Date.now() - d.getTime()) / 1000);
      if (s < 0) return Fmt.date(d);
      if (s < 60) return 'Just now';
      if (s < 3600) return `${Math.floor(s / 60)} min ago`;
      if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
      if (s < 7 * 86400) { const n = Math.floor(s / 86400); return n === 1 ? 'Yesterday' : `${n} days ago`; }
      return Fmt.date(d);
    },

    /** Parses the sheet's date/time strings: ISO, "YYYY-MM-DD HH:mm", "DD/MM/YYYY HH:mm[:ss] [AM|PM]". */
    parseDate(value) {
      if (!value) return null;
      const s = String(value).trim();
      if (!s) return null;
      let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) return Fmt.valid(new Date(+m[1], +m[2] - 1, +m[3]));
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/.test(s)) return Fmt.valid(new Date(s.replace(' ', 'T')));
      m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
      if (m) { // Day-first (Indian / UK convention)
        let [, dd, mm, yy, hh = '0', mi = '0', ss = '0', ap] = m;
        let year = +yy; if (year < 100) year += 2000;
        let hour = +hh;
        if (ap) { const pm = /p/i.test(ap); if (pm && hour < 12) hour += 12; if (!pm && hour === 12) hour = 0; }
        return Fmt.valid(new Date(year, +mm - 1, +dd, hour, +mi, +ss));
      }
      const t = Date.parse(s);
      return Number.isNaN(t) ? null : new Date(t);
    },
    /** Fallback: Inquiry IDs like INQ-260929-182052-209 encode YYMMDD-HHMMSS. */
    dateFromId(id) {
      const m = String(id || '').match(/(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
      if (!m) return null;
      const d = new Date(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      return d.getMonth() === +m[2] - 1 ? Fmt.valid(d) : null;
    },
    valid: (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d : null),

    /** "uk" → "UK", "general / other" → "General / Other", mixed case kept as typed. */
    label(v) {
      const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
      if (!s) return '';
      if (/^[a-z]{2,3}$/.test(s)) return s.toUpperCase();
      if (s === s.toLowerCase()) return s.replace(/(^|[\s/(-])([a-z])/g, (a, p, c) => p + c.toUpperCase());
      return s;
    },
    hash(str) {
      let h = 5381;
      for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    },
    debounce(fn, ms) {
      let t;
      return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }
  };

  /* ===================================================================
     Columns — detect important columns from whatever headers exist
     =================================================================== */
  const Columns = {
    // role → test on normalised header. First matching header wins.
    rules: [
      ['id', (n) => /\b(inquiry|inquery|enquiry|ticket|reference|ref)\s*(id|no|number)\b/.test(n) || n === 'id'],
      ['date', (n) => /(date|time|timestamp|created|received)/.test(n)],
      ['name', (n) => /^(name|full name|customer name|contact name|client name|patient name)$/.test(n)],
      ['phone', (n) => /(phone|mobile|whatsapp|contact number|contact no)/.test(n)],
      ['company', (n) => /(company|organi[sz]ation|organisation)/.test(n)],
      ['country', (n) => /country/.test(n)],
      ['department', (n) => /(department|dept)/.test(n)],
      ['status', (n) => /status/.test(n)],
      ['assigned', (n) => /(assigned|owner|handled by)/.test(n)],
      ['email', (n) => /e-?mail/.test(n)],
      ['inquiry', (n) => /(problem|inquiry|inquery|enquiry|query|message|request|description)/.test(n)],
      ['product', (n) => /(product|medicine|drug)/.test(n)]
    ],
    labels: {
      id: 'Inquiry ID', date: 'Date/Time', name: 'Name', phone: 'Phone', company: 'Company', country: 'Country',
      department: 'Department', status: 'Status', assigned: 'Assigned to', email: 'Email', inquiry: 'Inquiry text', product: 'Product'
    },
    detect(headers) {
      const found = {};
      const used = new Set();
      for (const [role, test] of Columns.rules) {
        const h = headers.find((hd) => !used.has(hd) && test(Fmt.norm(hd).replace(/[_]+/g, ' ')));
        if (h) { found[role] = h; used.add(h); }
      }
      return found;
    },
    /** Columns shown in the table (others live in the details drawer). */
    table() {
      const c = State.cols;
      const cols = ['id', 'date', 'name', 'phone', 'company', 'country', 'department', 'status', 'assigned']
        .map((k) => c[k]).filter(Boolean);
      return cols.length >= 3 ? cols : State.headers.slice(0, 8);
    },
    roleOf(header) {
      return Object.keys(State.cols).find((k) => State.cols[k] === header) || null;
    }
  };

  /* ===================================================================
     Status — map free-text status values to groups
     =================================================================== */
  const Status = {
    groups: {
      new: ['new', 'open', 'received', 'unassigned', 'not started'],
      pending: ['pending', 'in progress', 'inprogress', 'in-progress', 'processing', 'assigned', 'awaiting', 'on hold',
        'hold', 'follow up', 'follow-up', 'followup', 'under review', 'in review', 'working', 'waiting', 'escalated'],
      completed: ['done', 'resolved', 'completed', 'complete', 'closed', 'fulfilled', 'finished', 'solved']
    },
    group(value) {
      const v = Fmt.norm(value);
      if (!v) return 'none';
      for (const g of ['completed', 'new', 'pending']) {
        if (Status.groups[g].some((w) => v === w || v.startsWith(w + ' ') || v.startsWith(w + ' -'))) return g;
      }
      return 'pending'; // any other non-empty status counts as open / in progress
    },
    badge(value) {
      if (!value) return '<span class="cell-empty">—</span>';
      const g = Status.group(value);
      const cls = g === 'none' ? '' : ` badge--${g}`;
      return `<span class="badge${cls}">${Fmt.esc(Fmt.label(value))}</span>`;
    },
    colors: { new: '#2A4A92', pending: '#ED9B00', completed: '#2E7D32', none: '#98A2B3' }
  };

  /* ===================================================================
     State — everything lives in memory and is wiped on logout
     =================================================================== */
  const NONE = '__none__';
  const freshState = () => ({
    user: null,
    view: 'dashboard',
    loaded: false,
    sheetName: 'department_inquery',
    timezone: '',
    headers: [],
    cols: {},
    records: [],
    filtered: [],
    knownKeys: null,        // Set of inquiry keys seen so far (null until first load)
    fresh: new Set(),       // keys that arrived during this session
    unseen: 0,              // new-inquiry count for the nav badge
    lastUpdated: null,
    lastFetchAt: 0,
    inFlight: null,
    error: null,
    filters: { q: '', department: '', country: '', status: '', from: '', to: '' },
    sort: null,
    page: 1,
    pageSize: Number(CFG.PAGE_SIZE) || 25
  });
  let State = freshState();

  /* ===================================================================
     UI — views, live indicator, banners, sidebar
     =================================================================== */
  const VIEW_TITLES = {
    dashboard: 'Department Inquiry Dashboard',
    inquiries: 'Department Inquiries',
    analytics: 'Analytics',
    settings: 'Settings'
  };

  const UI = {
    showBoot(on) { $('#boot').hidden = !on; },

    showAuth(panel = 'login', message = null) {
      $('#app-view').hidden = true;
      $('#auth-view').hidden = false;
      UI.authPanel(panel);
      UI.authMessage(message);
    },
    authPanel(panel) {
      $$('[data-auth-panel]').forEach((f) => { f.hidden = f.dataset.authPanel !== panel; });
      const form = $(`[data-auth-panel="${panel}"]`);
      const first = form && form.querySelector('input');
      if (first && !first.value) setTimeout(() => first.focus(), 30);
    },
    /** message: { type: 'error'|'success'|'info', text, html? } */
    authMessage(message) {
      const box = $('#auth-message');
      if (!message) { box.hidden = true; box.innerHTML = ''; return; }
      box.className = `notice notice--${message.type || 'info'}`;
      box.innerHTML = message.html || Fmt.esc(message.text);
      box.hidden = false;
    },
    busy(btn, on) {
      if (!btn) return;
      btn.disabled = on;
      btn.setAttribute('aria-busy', on ? 'true' : 'false');
    },

    showApp() {
      $('#auth-view').hidden = true;
      $('#app-view').hidden = false;
    },

    showView(view) {
      if (!VIEW_TITLES[view]) view = 'dashboard';
      State.view = view;
      $$('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
      $$('.nav__item[data-nav]').forEach((b) => {
        if (b.dataset.nav === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      });
      $('#page-title').textContent = VIEW_TITLES[view];
      UI.closeSidebar();
      if (view === 'inquiries') { State.unseen = 0; UI.updateBadge(); }
      Charts.renderFor(view);
      $('#content').scrollTop = 0;
      window.scrollTo({ top: 0 });
    },

    setLive(state) {
      const el = $('#live-status');
      el.dataset.state = state;
      $('.live__label', el).textContent =
        state === 'loading' ? 'Updating…' : state === 'error' ? 'Refresh failed' : 'Live';
      $('#btn-refresh').setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
      if (State.lastUpdated) {
        const t = $('#last-updated');
        t.textContent = Fmt.dateTime(State.lastUpdated);
        t.dateTime = State.lastUpdated.toISOString();
      }
    },

    banner(text, type = 'error', retry = true) {
      const b = $('#data-banner');
      if (!text) { b.hidden = true; return; }
      b.className = `banner${type === 'info' ? ' banner--info' : ''}`;
      $('.banner__text', b).textContent = text;
      $('[data-action="retry"]', b).hidden = !retry;
      b.hidden = false;
    },

    updateBadge() {
      const n = State.unseen;
      $$('[data-new-count]').forEach((el) => { el.hidden = !n; el.textContent = n > 99 ? '99+' : String(n); });
      document.title = (n && document.hidden ? `(${n}) ` : '') + 'Department Inquiry Dashboard · Ikris Pharma Network';
    },

    openSidebar() {
      $('#sidebar').classList.add('is-open');
      $('.scrim').hidden = false;
      $('[data-open-sidebar]').setAttribute('aria-expanded', 'true');
      $('.nav__item', $('#sidebar')).focus();
    },
    closeSidebar() {
      if (!$('#sidebar').classList.contains('is-open')) return;
      $('#sidebar').classList.remove('is-open');
      $('.scrim').hidden = true;
      $('[data-open-sidebar]').setAttribute('aria-expanded', 'false');
    }
  };

  /* ===================================================================
     Notify — subtle toast notifications
     =================================================================== */
  const Notify = {
    max: 4,
    toast({ type = 'info', eyebrow = '', title = '', body = '', actions = [], timeout = 7000 }) {
      const wrap = $('#toasts');
      while (wrap.children.length >= Notify.max) wrap.firstElementChild.remove();

      const el = document.createElement('div');
      el.className = `toast toast--${type}`;
      el.setAttribute('role', type === 'error' ? 'alert' : 'status');
      el.innerHTML = `
        <div>
          ${eyebrow ? `<p class="toast__eyebrow">${eyebrow}</p>` : ''}
          ${title ? `<p class="toast__title">${Fmt.esc(title)}</p>` : ''}
          ${body}
          ${actions.length ? `<div class="toast__actions"></div>` : ''}
        </div>
        <button type="button" class="icon-btn toast__close" aria-label="Dismiss notification"><svg aria-hidden="true"><use href="#i-close"/></svg></button>`;
      const actionBox = $('.toast__actions', el);
      actions.forEach((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn--outline btn--sm';
        b.textContent = a.label;
        b.addEventListener('click', () => { a.onClick(); dismiss(); });
        actionBox.appendChild(b);
      });

      let timer = null;
      const dismiss = () => { clearTimeout(timer); el.remove(); };
      const arm = () => { if (timeout) timer = setTimeout(dismiss, timeout); };
      el.addEventListener('mouseenter', () => clearTimeout(timer));
      el.addEventListener('mouseleave', arm);
      el.addEventListener('focusin', () => clearTimeout(timer));
      $('.toast__close', el).addEventListener('click', dismiss);
      wrap.appendChild(el);
      arm();
      return el;
    },

    newInquiry(rec) {
      const c = State.cols;
      const rows = [
        ['Name', c.name && rec.values[c.name]],
        ['Department', rec.dept && Fmt.label(rec.dept)],
        ['Country', rec.country && Fmt.label(rec.country)],
        ['Time', rec.ts ? Fmt.dateTime(rec.ts) : '']
      ].filter(([, v]) => v);
      Notify.toast({
        eyebrow: '<svg aria-hidden="true"><use href="#i-bell"/></svg>New inquiry received',
        title: 'New Department Inquiry Received',
        body: `${rec.id ? `<p class="toast__id">${Fmt.esc(rec.id)}</p>` : ''}
          <dl class="toast__rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${Fmt.esc(v)}</dd>`).join('')}</dl>`,
        actions: [{ label: 'View Inquiry', onClick: () => Drawer.open(rec) }],
        timeout: 12000
      });
    },

    newSummary(count) {
      Notify.toast({
        eyebrow: '<svg aria-hidden="true"><use href="#i-bell"/></svg>New inquiries received',
        title: `${count} new department inquiries received`,
        body: '<p class="muted small" style="margin-top:4px">The newest entries are highlighted in the inquiry table.</p>',
        actions: [{ label: 'View inquiries', onClick: () => { Filters.reset(); UI.showView('inquiries'); } }],
        timeout: 12000
      });
    },

    success(title) { Notify.toast({ type: 'success', title, timeout: 4000 }); },
    clearAll() { $('#toasts').innerHTML = ''; }
  };

  /* ===================================================================
     Auth — Supabase (authentication & session only)
     =================================================================== */
  const Auth = {
    client: null,
    recovery: false,

    appUrl() {
      return CFG.APP_URL || (window.location.origin + window.location.pathname);
    },

    init() {
      this.client = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: 'ikris-dashboard-auth'
        }
      });
      // Supabase recommends not awaiting other auth calls inside this callback.
      this.client.auth.onAuthStateChange((event, session) => setTimeout(() => Auth.onChange(event, session), 0));
    },

    onChange(event, session) {
      if (event === 'PASSWORD_RECOVERY') {
        Auth.recovery = true;
        if (State.user) App.leave();
        UI.showAuth('update', { type: 'info', text: 'Reset link verified. Please choose a new password.' });
        return;
      }
      if (event === 'SIGNED_IN' && session && !Auth.recovery && !State.user) {
        App.enter(session.user);
        return;
      }
      if (event === 'SIGNED_OUT' && State.user) {
        App.leave();
        UI.showAuth('login', { type: 'info', text: 'You have been signed out.' });
      }
    },

    async accessToken() {
      const { data } = await this.client.auth.getSession();
      return data && data.session ? data.session.access_token : null;
    },

    async signOut() {
      try {
        const { error } = await this.client.auth.signOut();
        if (error) throw error;
      } catch (e) {
        // Network issue: still clear the local session so the dashboard is locked.
        try { await this.client.auth.signOut({ scope: 'local' }); } catch (_) { /* ignore */ }
      }
    },

    friendly(error, context) {
      const msg = String((error && error.message) || '').toLowerCase();
      const status = error && error.status;
      if (error && error.name === 'TypeError') return 'Network error — please check your internet connection and try again.';
      if (msg.includes('failed to fetch') || msg.includes('network')) return 'Network error — please check your internet connection and try again.';
      if (msg.includes('invalid login credentials')) return 'Incorrect email or password. Please try again.';
      if (msg.includes('email not confirmed')) return 'Please verify your email address first. Check your inbox for the confirmation link.';
      if (msg.includes('already registered') || msg.includes('already exists')) return 'An account with this email already exists. Please sign in, or reset your password.';
      if (msg.includes('different from the old password')) return 'Your new password must be different from your current password.';
      if (msg.includes('password') && (msg.includes('weak') || msg.includes('at least') || msg.includes('characters'))) return error.message;
      if (msg.includes('signups not allowed') || msg.includes('signup is disabled')) return 'New registrations are currently disabled. Please contact the administrator.';
      if (msg.includes('email address') && msg.includes('invalid')) return 'Please enter a valid email address.';
      if (msg.includes('expired') || msg.includes('otp')) return 'This link has expired or was already used. Please request a new one.';
      if (status === 429 || msg.includes('rate limit') || msg.includes('too many')) return 'Too many attempts. Please wait a minute and try again.';
      if (context === 'register') return 'We could not create your account. Please try again.';
      if (context === 'reset') return 'We could not send the reset email. Please try again.';
      return 'Something went wrong. Please try again.';
    },

    /* ----- form handlers ----- */
    validEmail: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v),

    markInvalid(input, invalid) { input.setAttribute('aria-invalid', invalid ? 'true' : 'false'); },

    async handleLogin(e) {
      e.preventDefault();
      const form = e.currentTarget;
      const btn = form.querySelector('[type="submit"]');
      if (btn.disabled) return;
      const email = form.email.value.trim();
      const password = form.password.value;
      Auth.markInvalid(form.email, !Auth.validEmail(email));
      Auth.markInvalid(form.password, !password);
      if (!Auth.validEmail(email)) return UI.authMessage({ type: 'error', text: 'Please enter a valid email address.' });
      if (!password) return UI.authMessage({ type: 'error', text: 'Please enter your password.' });

      UI.busy(btn, true);
      UI.authMessage(null);
      try {
        const { data, error } = await Auth.client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        form.password.value = '';
        App.enter(data.user);
      } catch (err) {
        const text = Auth.friendly(err, 'login');
        if (String(err.message || '').toLowerCase().includes('email not confirmed')) {
          UI.authMessage({
            type: 'error',
            html: `${Fmt.esc(text)} <button type="button" class="link" data-resend="${Fmt.esc(email)}">Resend verification email</button>`
          });
        } else {
          UI.authMessage({ type: 'error', text });
        }
      } finally {
        UI.busy(btn, false);
      }
    },

    async handleResend(email, btn) {
      btn.disabled = true;
      const { error } = await Auth.client.auth.resend({ type: 'signup', email, options: { emailRedirectTo: Auth.appUrl() } });
      UI.authMessage(error
        ? { type: 'error', text: Auth.friendly(error) }
        : { type: 'success', text: `Verification email re-sent to ${email}.` });
    },

    async handleRegister(e) {
      e.preventDefault();
      const form = e.currentTarget;
      const btn = form.querySelector('[type="submit"]');
      if (btn.disabled) return;
      const email = form.email.value.trim();
      const password = form.password.value;
      const confirm = form.confirm.value;

      Auth.markInvalid(form.email, !Auth.validEmail(email));
      Auth.markInvalid(form.password, password.length < MIN_PASS);
      Auth.markInvalid(form.confirm, !confirm || confirm !== password);
      if (!Auth.validEmail(email)) return UI.authMessage({ type: 'error', text: 'Please enter a valid email address.' });
      if (!password) return UI.authMessage({ type: 'error', text: 'Please choose a password.' });
      if (password.length < MIN_PASS) return UI.authMessage({ type: 'error', text: `Your password must be at least ${MIN_PASS} characters.` });
      if (password !== confirm) return UI.authMessage({ type: 'error', text: 'Passwords do not match.' });

      UI.busy(btn, true);
      UI.authMessage(null);
      try {
        const { data, error } = await Auth.client.auth.signUp({
          email, password, options: { emailRedirectTo: Auth.appUrl() }
        });
        if (error) throw error;
        // With email confirmation on, Supabase returns a user with no identities for an existing email.
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          UI.authMessage({ type: 'error', text: 'An account with this email already exists. Please sign in, or reset your password.' });
          return;
        }
        form.reset();
        if (data.session) { App.enter(data.user); return; }       // email confirmation disabled
        $('#login-email').value = email;
        UI.showAuth('login', {
          type: 'success',
          text: `Account created. We have sent a verification link to ${email}. Please confirm your email, then sign in.`
        });
      } catch (err) {
        UI.authMessage({ type: 'error', text: Auth.friendly(err, 'register') });
      } finally {
        UI.busy(btn, false);
      }
    },

    async handleForgot(e) {
      e.preventDefault();
      const form = e.currentTarget;
      const btn = form.querySelector('[type="submit"]');
      if (btn.disabled) return;
      const email = form.email.value.trim();
      Auth.markInvalid(form.email, !Auth.validEmail(email));
      if (!Auth.validEmail(email)) return UI.authMessage({ type: 'error', text: 'Please enter a valid email address.' });

      UI.busy(btn, true);
      UI.authMessage(null);
      try {
        const { error } = await Auth.client.auth.resetPasswordForEmail(email, { redirectTo: Auth.appUrl() });
        if (error) throw error;
        UI.authMessage({
          type: 'success',
          text: `If an account exists for ${email}, a password reset link has been sent. The link opens this dashboard, where you can set a new password.`
        });
      } catch (err) {
        UI.authMessage({ type: 'error', text: Auth.friendly(err, 'reset') });
      } finally {
        UI.busy(btn, false);
      }
    },

    async handleUpdatePassword(e) {
      e.preventDefault();
      const form = e.currentTarget;
      const btn = form.querySelector('[type="submit"]');
      if (btn.disabled) return;
      const password = form.password.value;
      const confirm = form.confirm.value;
      Auth.markInvalid(form.password, password.length < MIN_PASS);
      Auth.markInvalid(form.confirm, confirm !== password);
      if (password.length < MIN_PASS) return UI.authMessage({ type: 'error', text: `Your password must be at least ${MIN_PASS} characters.` });
      if (password !== confirm) return UI.authMessage({ type: 'error', text: 'Passwords do not match.' });

      UI.busy(btn, true);
      UI.authMessage(null);
      try {
        const { data, error } = await Auth.client.auth.updateUser({ password });
        if (error) throw error;
        form.reset();
        Auth.recovery = false;
        App.cleanUrl();
        App.enter(data.user);
        Notify.success('Your password has been updated.');
      } catch (err) {
        const { data } = await Auth.client.auth.getSession();
        if (!data.session) {
          Auth.recovery = false;
          UI.showAuth('forgot', { type: 'error', text: 'Your reset link has expired. Please request a new one.' });
        } else {
          UI.authMessage({ type: 'error', text: Auth.friendly(err) });
        }
      } finally {
        UI.busy(btn, false);
      }
    }
  };

  /* ===================================================================
     Api — Google Apps Script client
     =================================================================== */
  const API_MESSAGES = {
    NETWORK: 'Unable to refresh inquiry data. Please check your internet connection and try again.',
    TIMEOUT: 'The inquiry service took too long to respond. Please try again.',
    BAD_RESPONSE: 'Unable to refresh inquiry data. The inquiry service returned an unexpected response.',
    INVALID_DATA: 'Inquiry data was received in an unexpected format. Please contact the administrator.',
    SHEET_NOT_FOUND: 'The department_inquery sheet could not be found. Please contact the administrator.',
    SHEET_UNAVAILABLE: 'The inquiry sheet is currently unavailable. Please try again shortly.',
    FORBIDDEN: 'Your account is not authorised to view inquiry data. Please contact the administrator.',
    CONFIG_ERROR: 'The inquiry service is not fully configured yet. Please contact the administrator.',
    AUTH_UNAVAILABLE: 'Your session could not be verified right now. Please try again.',
    NOT_CONFIGURED: 'The Google Apps Script URL has not been set yet. Add GOOGLE_APPS_SCRIPT_URL in config.js.',
    DEFAULT: 'Unable to refresh inquiry data. Please try again.'
  };

  class ApiError extends Error {
    constructor(code, detail) {
      super(detail || code);
      this.code = code;
      this.userMessage = API_MESSAGES[code] || API_MESSAGES.DEFAULT;
    }
  }

  const Api = {
    configured() {
      const u = String(CFG.GOOGLE_APPS_SCRIPT_URL || '');
      return /^https:\/\/script\.google(usercontent)?\.com\//.test(u) && !u.includes('DEPLOYMENT_ID');
    },

    async fetchInquiries() {
      if (!Api.configured()) throw new ApiError('NOT_CONFIGURED');
      const token = await Auth.accessToken();
      if (!token) throw new ApiError('SESSION_EXPIRED');

      let res = await Api.call(token);
      if (!res.ok && res.error && res.error.code === 'UNAUTHORIZED') {
        // Token may have just expired — refresh once and retry.
        const { data, error } = await Auth.client.auth.refreshSession();
        if (error || !data.session) throw new ApiError('SESSION_EXPIRED');
        res = await Api.call(data.session.access_token);
        if (!res.ok && res.error && res.error.code === 'UNAUTHORIZED') throw new ApiError('SESSION_EXPIRED');
      }
      if (!res.ok) throw new ApiError((res.error && res.error.code) || 'DEFAULT', res.error && res.error.message);
      const d = res.data;
      if (!d || !Array.isArray(d.headers) || !Array.isArray(d.rows)) throw new ApiError('INVALID_DATA');
      return d;
    },

    /** Simple GET (no custom headers) so Apps Script works without CORS preflight. */
    async call(token) {
      const url = new URL(CFG.GOOGLE_APPS_SCRIPT_URL);
      url.searchParams.set('action', API_ACTION);
      url.searchParams.set('token', token);
      url.searchParams.set('_', String(Date.now()));

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let resp;
      try {
        resp = await fetch(url.toString(), { method: 'GET', cache: 'no-store', redirect: 'follow', signal: ctrl.signal });
      } catch (e) {
        throw new ApiError(e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) throw new ApiError('BAD_RESPONSE', `HTTP ${resp.status}`);
      const text = await resp.text();
      try { return JSON.parse(text); } catch (_) { throw new ApiError('BAD_RESPONSE'); }
    }
  };

  /* ===================================================================
     Data — load, normalise, detect new inquiries
     =================================================================== */
  const Data = {
    refresh({ manual = false } = {}) {
      if (!State.user) return Promise.resolve();
      if (State.inFlight) return State.inFlight;

      UI.setLive('loading');
      const run = (async () => {
        try {
          const payload = await Api.fetchInquiries();
          if (!State.user) return;                         // logged out while loading
          Data.ingest(payload);
          State.lastUpdated = new Date();
          State.error = null;
          UI.banner(null);
          UI.setLive('live');
          Render.all();
          if (manual) Notify.success('Inquiry data is up to date.');
        } catch (err) {
          if (!State.user) return;
          if (err.code === 'SESSION_EXPIRED') { await App.expire(); return; }
          if (!(err instanceof ApiError)) console.error(err);
          State.error = err instanceof ApiError ? err : new ApiError('DEFAULT');
          UI.banner(State.error.userMessage, State.error.code === 'NOT_CONFIGURED' ? 'info' : 'error', State.error.code !== 'NOT_CONFIGURED');
          UI.setLive('error');
          if (!State.loaded) Render.all();                 // show empty/error states; keep old data otherwise
        } finally {
          State.lastFetchAt = Date.now();
          State.inFlight = null;
        }
      })();
      State.inFlight = run;
      return run;
    },

    ingest(payload) {
      const headers = payload.headers.map(String);
      State.headers = headers;
      State.sheetName = payload.sheet || State.sheetName;
      State.timezone = payload.timezone || '';
      State.cols = Columns.detect(headers);
      const C = State.cols;

      const records = payload.rows.map((row, i) => {
        const values = {};
        headers.forEach((h) => { values[h] = row[h] == null ? '' : String(row[h]); });
        const id = C.id ? values[C.id].trim() : '';
        const ts = (C.date && Fmt.parseDate(values[C.date])) || (id && Fmt.dateFromId(id)) || null;
        const status = C.status ? values[C.status].trim() : '';
        return {
          key: id ? `id:${id}` : `h:${Fmt.hash(headers.map((h) => values[h]).join('␟'))}`,
          row: row._row || i + 2,
          id,
          ts,
          t: ts ? ts.getTime() : null,
          values,
          status,
          statusGroup: C.status ? Status.group(status) : 'none',
          dept: C.department ? values[C.department].trim() : '',
          country: C.country ? values[C.country].trim() : '',
          assigned: C.assigned ? values[C.assigned].trim() : '',
          search: (headers.map((h) => values[h]).join(' • ') + ' ' + (ts ? Fmt.dateTime(ts) : '')).toLowerCase()
        };
      });

      // New-inquiry detection (skipped on the very first load of the session).
      if (State.knownKeys) {
        const arrivals = records.filter((r) => !State.knownKeys.has(r.key))
          .sort((a, b) => (b.t || b.row) - (a.t || a.row));
        if (arrivals.length) {
          arrivals.forEach((r) => { State.fresh.add(r.key); State.knownKeys.add(r.key); });
          if (State.view !== 'inquiries' || document.hidden) State.unseen += arrivals.length;
          if (arrivals.length <= 3) arrivals.forEach(Notify.newInquiry);
          else Notify.newSummary(arrivals.length);
        }
      } else {
        State.knownKeys = new Set(records.map((r) => r.key));
      }

      State.records = records;
      if (!State.sort) State.sort = C.date ? { key: C.date, dir: 'desc' } : { key: '__row', dir: 'desc' };
      State.loaded = true;
    },

    /** Records sorted newest first (for "latest" lists and alerts). */
    newest() {
      return State.records.slice().sort((a, b) => ((b.t ?? 0) - (a.t ?? 0)) || (b.row - a.row));
    },

    /** Grouped counts by a normalised field. Returns [{ key, label, count, records }] sorted desc. */
    groupBy(field) {
      const map = new Map();
      for (const r of State.records) {
        const raw = r[field];
        const key = Fmt.norm(raw) || NONE;
        if (!map.has(key)) map.set(key, { key, labels: new Map(), count: 0, records: [] });
        const g = map.get(key);
        g.count++;
        g.records.push(r);
        if (raw) g.labels.set(raw, (g.labels.get(raw) || 0) + 1);
      }
      return Array.from(map.values()).map((g) => {
        const top = Array.from(g.labels.entries()).sort((a, b) => b[1] - a[1])[0];
        return { key: g.key, label: top ? Fmt.label(top[0]) : 'Not specified', count: g.count, records: g.records };
      }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    }
  };

  /* ===================================================================
     Poller — live refresh every REFRESH_MS (slower while tab hidden)
     =================================================================== */
  const Poller = {
    timer: null,
    running: false,
    start() { Poller.stop(); Poller.running = true; Poller.schedule(); },
    stop() { Poller.running = false; clearTimeout(Poller.timer); Poller.timer = null; },
    schedule() {
      clearTimeout(Poller.timer);
      if (!Poller.running) return;
      const delay = document.hidden ? REFRESH_MS * 2 : REFRESH_MS;
      Poller.timer = setTimeout(() => { Data.refresh().finally(Poller.schedule); }, delay);
    },
    now(manual) {
      clearTimeout(Poller.timer);
      return Data.refresh({ manual }).finally(Poller.schedule);
    },
    onVisibility() {
      if (!Poller.running) return;
      if (!document.hidden) {
        UI.updateBadge();
        if (Date.now() - State.lastFetchAt >= REFRESH_MS) Poller.now(false);
      }
    }
  };

  /* ===================================================================
     Render — orchestrates all views after data changes
     =================================================================== */
  const Render = {
    all() {
      Dashboard.render();
      Filters.renderOptions();
      Table.render();
      Settings.render();
      Charts.renderFor(State.view);
      UI.updateBadge();
      $$('[data-sheet-name]').forEach((el) => { el.textContent = State.sheetName; });
    }
  };

  /* ===================================================================
     Dashboard — KPIs, department summary, latest inquiries
     =================================================================== */
  const Dashboard = {
    render() {
      Dashboard.kpis();
      Dashboard.departments();
      Dashboard.recent();
    },

    kpis() {
      const box = $('#kpis');
      if (!State.loaded) {
        box.innerHTML = ['Total inquiries', 'New inquiries', 'Pending', 'Completed'].map((l) => `
          <div class="kpi kpi--skeleton"><p class="kpi__label">${l}</p><div class="kpi__value"></div><p class="kpi__sub">&nbsp;</p></div>`).join('');
        return;
      }
      const recs = State.records;
      const total = recs.length;
      const now = new Date();
      const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const last7 = now.getTime() - 7 * 86400000;
      const today = recs.filter((r) => r.t != null && r.t >= startToday).length;
      const week = recs.filter((r) => r.t != null && r.t >= last7).length;
      const pct = (n) => (total ? Math.round((n / total) * 100) : 0);

      let cards;
      if (State.cols.status) {
        const count = (g) => recs.filter((r) => r.statusGroup === g).length;
        const nNew = count('new');
        const nPending = count('pending');
        const nDone = count('completed');
        cards = [
          { label: 'Total inquiries', value: total, sub: `${Fmt.num(week)} in the last 7 days` },
          { label: 'New inquiries', value: nNew, sub: `${Fmt.num(today)} received today`, cls: 'kpi--new' },
          { label: 'Pending', value: nPending, sub: 'In progress / awaiting action', cls: 'kpi--pending' },
          { label: 'Completed', value: nDone, sub: `${pct(nDone)}% of all inquiries`, cls: 'kpi--completed' }
        ];
      } else {
        // No Status column in the sheet → do not invent statuses.
        const depts = Data.groupBy('dept').filter((g) => g.key !== NONE).length;
        cards = [
          { label: 'Total inquiries', value: total, sub: 'All records in the sheet' },
          { label: 'Received today', value: today, sub: Fmt.date(now), cls: 'kpi--new' },
          { label: 'Last 7 days', value: week, sub: `${pct(week)}% of all inquiries` },
          { label: 'Departments', value: depts, sub: 'With at least one inquiry' }
        ];
      }
      box.innerHTML = cards.map((c) => `
        <div class="kpi ${c.cls || ''}">
          <p class="kpi__label">${c.label}</p>
          <p class="kpi__value">${Fmt.num(c.value)}</p>
          <p class="kpi__sub">${Fmt.esc(c.sub)}</p>
        </div>`).join('');
    },

    departments() {
      const box = $('#dept-cards');
      if (!State.loaded) { box.innerHTML = Dashboard.placeholder(State.error ? 'Inquiry data could not be loaded.' : 'Loading departments…'); return; }
      if (!State.cols.department) { box.innerHTML = Dashboard.placeholder('No Department column was found in the sheet.'); return; }
      const groups = Data.groupBy('dept');
      if (!groups.length) { box.innerHTML = Dashboard.placeholder('No inquiries have been recorded yet.'); return; }
      const max = groups[0].count;
      const hasStatus = !!State.cols.status;
      box.innerHTML = groups.map((g) => {
        const open = g.records.filter((r) => r.statusGroup !== 'completed').length;
        const nNew = g.records.filter((r) => r.statusGroup === 'new').length;
        return `
          <button type="button" class="dept" data-dept="${Fmt.esc(g.key)}" aria-label="${Fmt.esc(g.label)}: ${g.count} inquiries. Show in table">
            <span class="dept__top">
              <span class="dept__name">${Fmt.esc(g.label)}</span>
              <svg class="dept__arrow" aria-hidden="true"><use href="#i-chevron"/></svg>
            </span>
            <span class="dept__count">${Fmt.num(g.count)}<small>${g.count === 1 ? 'inquiry' : 'inquiries'}</small></span>
            <span class="dept__bar" aria-hidden="true"><span style="width:${Math.max(4, (g.count / max) * 100)}%"></span></span>
            ${hasStatus ? `<span class="dept__foot"><span><b>${nNew}</b> new</span><span><b>${open}</b> open</span></span>` : ''}
          </button>`;
      }).join('');
    },

    recent() {
      const box = $('#recent-list');
      if (!State.loaded) { box.innerHTML = `<li>${Dashboard.placeholder(State.error ? 'Inquiry data could not be loaded.' : 'Loading…')}</li>`; return; }
      const list = Data.newest().slice(0, 6);
      if (!list.length) { box.innerHTML = `<li>${Dashboard.placeholder('No inquiries yet.')}</li>`; return; }
      const C = State.cols;
      box.innerHTML = list.map((r) => {
        const idx = State.records.indexOf(r);
        const name = (C.name && r.values[C.name]) || r.id || `Row ${r.row}`;
        const meta = [r.dept && Fmt.label(r.dept), r.country && Fmt.label(r.country)].filter(Boolean).join(' · ');
        return `
          <li><button type="button" data-open="${idx}">
            <span style="min-width:0;display:grid;gap:2px">
              ${r.id ? `<span class="recent__id">${Fmt.esc(r.id)}</span>` : ''}
              <span class="recent__name">${Fmt.esc(Fmt.label(name))}</span>
              <span class="recent__meta">${Fmt.esc(meta || '—')}</span>
            </span>
            <span class="recent__right">
              ${C.status ? Status.badge(r.status) : ''}
              <span class="recent__time">${Fmt.esc(Fmt.relative(r.ts))}</span>
            </span>
          </button></li>`;
      }).join('');
    },

    placeholder(text) {
      return `<p class="muted" style="padding:18px 4px;grid-column:1/-1">${Fmt.esc(text)}</p>`;
    }
  };

  /* ===================================================================
     Filters — search, department/country/status, date range
     =================================================================== */
  const Filters = {
    fields: { department: 'dept', country: 'country', status: 'status' },

    renderOptions() {
      const C = State.cols;
      const avail = { department: !!C.department, country: !!C.country, status: !!C.status, date: !!(C.date || C.id) };
      $$('[data-filter-wrap]').forEach((w) => { w.hidden = !avail[w.dataset.filterWrap]; });

      for (const [filter, field] of Object.entries(Filters.fields)) {
        const select = $(`#f-${filter}`);
        if (!avail[filter]) continue;
        const current = State.filters[filter];
        const groups = Data.groupBy(field);
        const first = select.options[0].outerHTML;
        select.innerHTML = first + groups.map((g) =>
          `<option value="${Fmt.esc(g.key)}">${Fmt.esc(g.label)} (${g.count})</option>`).join('');
        select.value = current;
        if (select.value !== current) { State.filters[filter] = ''; select.value = ''; }
      }
    },

    set(patch) {
      Object.assign(State.filters, patch);
      State.page = 1;
      Filters.syncInputs();
      Table.render();
    },

    reset() {
      State.filters = { q: '', department: '', country: '', status: '', from: '', to: '' };
      State.page = 1;
      Filters.syncInputs();
      Table.render();
    },

    syncInputs() {
      const f = State.filters;
      $('#search').value = f.q;
      $('#f-department').value = f.department;
      $('#f-country').value = f.country;
      $('#f-status').value = f.status;
      $('#f-from').value = f.from;
      $('#f-to').value = f.to;
    },

    active() {
      const f = State.filters;
      return !!(f.q || f.department || f.country || f.status || f.from || f.to);
    },

    apply() {
      const f = State.filters;
      const tokens = f.q.toLowerCase().split(/\s+/).filter(Boolean);
      const from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
      const to = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : null;
      const match = (value, sel) => !sel || (sel === NONE ? !Fmt.norm(value) : Fmt.norm(value) === sel);

      const list = State.records.filter((r) =>
        match(r.dept, f.department) &&
        match(r.country, f.country) &&
        match(r.status, f.status) &&
        (from == null || (r.t != null && r.t >= from)) &&
        (to == null || (r.t != null && r.t <= to)) &&
        tokens.every((t) => r.search.includes(t)));

      State.filtered = Table.sort(list);
      return State.filtered;
    },

    chips() {
      const f = State.filters;
      const chips = [];
      const labelFor = (filter) => {
        const opt = $(`#f-${filter}`).selectedOptions[0];
        return opt ? opt.textContent.replace(/\s\(\d+\)$/, '') : f[filter];
      };
      if (f.q) chips.push(['q', `Search: “${f.q}”`]);
      if (f.department) chips.push(['department', `Department: ${labelFor('department')}`]);
      if (f.country) chips.push(['country', `Country: ${labelFor('country')}`]);
      if (f.status) chips.push(['status', `Status: ${labelFor('status')}`]);
      if (f.from) chips.push(['from', `From ${Fmt.date(new Date(`${f.from}T00:00:00`))}`]);
      if (f.to) chips.push(['to', `To ${Fmt.date(new Date(`${f.to}T00:00:00`))}`]);
      $('#active-chips').innerHTML = chips.map(([k, text]) => `
        <button type="button" class="chip" data-clear-filter="${k}" aria-label="Remove filter ${Fmt.esc(text)}">
          ${Fmt.esc(text)}<svg aria-hidden="true"><use href="#i-close"/></svg>
        </button>`).join('');
    },

    bind() {
      const onSearch = Fmt.debounce((v) => Filters.set({ q: v.trim() }), 220);
      $('#search').addEventListener('input', (e) => onSearch(e.target.value));
      $$('[data-filter]').forEach((el) => {
        if (el.id === 'search') return;
        el.addEventListener('change', () => Filters.set({ [el.dataset.filter]: el.value }));
      });
      $('#btn-clear-filters').addEventListener('click', Filters.reset);
      $('#active-chips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-clear-filter]');
        if (b) Filters.set({ [b.dataset.clearFilter]: '' });
      });
    }
  };

  /* ===================================================================
     Table — dynamic columns, sorting, pagination
     =================================================================== */
  const Table = {
    sort(list) {
      const s = State.sort || { key: '__row', dir: 'desc' };
      const dir = s.dir === 'asc' ? 1 : -1;
      const isDate = s.key === State.cols.date;
      return list.slice().sort((a, b) => {
        if (s.key === '__row') return (a.row - b.row) * dir;
        if (isDate) {
          if (a.t == null && b.t == null) return (a.row - b.row) * dir;
          if (a.t == null) return 1;
          if (b.t == null) return -1;
          return (a.t - b.t) * dir || (a.row - b.row) * dir;
        }
        const av = a.values[s.key] || '';
        const bv = b.values[s.key] || '';
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * dir;
      });
    },

    render() {
      const head = $('#table-head');
      const body = $('#table-body');
      const empty = $('#table-empty');
      const cols = Columns.table();
      const C = State.cols;

      head.innerHTML = cols.map((h) => {
        const sorted = State.sort && State.sort.key === h;
        const aria = sorted ? (State.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
        return `<th scope="col" aria-sort="${aria}"><button type="button" data-sort="${Fmt.esc(h)}">${Fmt.esc(h)}<svg aria-hidden="true"><use href="#i-sort"/></svg></button></th>`;
      }).join('');

      if (!State.loaded) {
        body.innerHTML = '';
        empty.hidden = false;
        empty.innerHTML = State.error
          ? `<svg aria-hidden="true"><use href="#i-alert"/></svg><strong>Inquiry data could not be loaded</strong><span>${Fmt.esc(State.error.userMessage)}</span>
             ${State.error.code !== 'NOT_CONFIGURED' ? '<button type="button" class="btn btn--outline btn--sm" data-action="retry">Try again</button>' : ''}`
          : '<span class="spinner" aria-hidden="true"></span><span>Loading inquiries…</span>';
        $('#result-count').textContent = '';
        $('#page-info').textContent = '';
        $('#pager-btns').innerHTML = '';
        Filters.chips();
        return;
      }

      const list = Filters.apply();
      const total = list.length;
      const pages = Math.max(1, Math.ceil(total / State.pageSize));
      State.page = Math.min(Math.max(1, State.page), pages);
      const start = (State.page - 1) * State.pageSize;
      const pageRows = list.slice(start, start + State.pageSize);

      if (!total) {
        body.innerHTML = '';
        empty.hidden = false;
        empty.innerHTML = State.records.length
          ? '<svg aria-hidden="true"><use href="#i-search"/></svg><strong>No inquiries match your search or filters</strong><span>Try a different term or clear the filters.</span><button type="button" class="btn btn--outline btn--sm" data-action="clear-filters">Clear filters</button>'
          : `<svg aria-hidden="true"><use href="#i-sheet"/></svg><strong>No inquiries yet</strong><span>${State.headers.length ? 'New rows added to the sheet will appear here automatically.' : 'The department_inquery sheet is empty (no header row found).'}</span>`;
      } else {
        empty.hidden = true;
        body.innerHTML = pageRows.map((r) => {
          const idx = State.records.indexOf(r);
          const fresh = State.fresh.has(r.key);
          const cells = cols.map((h) => {
            const v = r.values[h];
            if (h === C.id) return `<td class="cell-id">${Fmt.esc(v || '—')}${fresh ? '<span class="badge badge--fresh">NEW</span>' : ''}</td>`;
            if (h === C.date) return `<td class="cell-date">${r.ts ? Fmt.esc(Fmt.dateTime(r.ts)) : (v ? Fmt.esc(v) : '<span class="cell-empty">—</span>')}</td>`;
            if (h === C.status) return `<td>${Status.badge(v)}</td>`;
            if (!v) return '<td class="cell-empty">—</td>';
            const display = (h === C.country || h === C.department || h === C.name) ? Fmt.label(v) : v;
            return `<td${h === C.name ? ' class="cell-strong"' : ''} title="${Fmt.esc(v)}">${Fmt.esc(display)}</td>`;
          }).join('');
          return `<tr tabindex="0" data-open="${idx}"${fresh ? ' class="is-fresh"' : ''}>${cells}</tr>`;
        }).join('');
      }

      const shownFrom = total ? start + 1 : 0;
      const shownTo = Math.min(start + State.pageSize, total);
      $('#result-count').textContent = Filters.active()
        ? `${Fmt.num(total)} of ${Fmt.num(State.records.length)} inquiries match`
        : `${Fmt.num(total)} ${total === 1 ? 'inquiry' : 'inquiries'}`;
      $('#page-info').textContent = total ? `Showing ${shownFrom}–${shownTo} of ${Fmt.num(total)}` : '';
      Table.pager(pages);
      Filters.chips();
    },

    pager(pages) {
      const p = State.page;
      const btn = (label, page, opts = {}) =>
        `<button type="button" data-page="${page}"${opts.disabled ? ' disabled' : ''}${opts.current ? ' aria-current="page"' : ''} aria-label="${opts.aria || `Page ${page}`}">${label}</button>`;
      const nums = new Set([1, pages, p - 1, p, p + 1].filter((n) => n >= 1 && n <= pages));
      const sorted = Array.from(nums).sort((a, b) => a - b);
      let html = btn('‹', p - 1, { disabled: p <= 1, aria: 'Previous page' });
      sorted.forEach((n, i) => {
        if (i && n - sorted[i - 1] > 1) html += '<span class="pager__gap">…</span>';
        html += btn(n, n, { current: n === p });
      });
      html += btn('›', p + 1, { disabled: p >= pages, aria: 'Next page' });
      $('#pager-btns').innerHTML = pages > 1 ? html : '';
    },

    bind() {
      $('#table-head').addEventListener('click', (e) => {
        const b = e.target.closest('[data-sort]');
        if (!b) return;
        const key = b.dataset.sort;
        const cur = State.sort;
        State.sort = cur && cur.key === key
          ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: key === State.cols.date ? 'desc' : 'asc' };
        Table.render();
        const again = $(`#table-head [data-sort="${CSS.escape(key)}"]`);
        if (again) again.focus();
      });
      const body = $('#table-body');
      body.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        const tr = e.target.closest('tr[data-open]');
        if (tr) Drawer.open(State.records[+tr.dataset.open], tr);
      });
      body.addEventListener('keydown', (e) => {
        const tr = e.target.closest('tr[data-open]');
        if (!tr) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Drawer.open(State.records[+tr.dataset.open], tr); }
        if (e.key === 'ArrowDown' && tr.nextElementSibling) { e.preventDefault(); tr.nextElementSibling.focus(); }
        if (e.key === 'ArrowUp' && tr.previousElementSibling) { e.preventDefault(); tr.previousElementSibling.focus(); }
      });
      $('#pager-btns').addEventListener('click', (e) => {
        const b = e.target.closest('[data-page]');
        if (!b || b.disabled) return;
        State.page = +b.dataset.page;
        Table.render();
        $('.table-wrap').scrollIntoView({ block: 'nearest' });
      });
      const size = $('#page-size');
      size.value = String(State.pageSize);
      size.addEventListener('change', () => { State.pageSize = +size.value; State.page = 1; Table.render(); });
    }
  };

  /* ===================================================================
     Drawer — inquiry details (read-only)
     =================================================================== */
  const Drawer = {
    returnFocus: null,
    open(rec, origin) {
      if (!rec) return;
      Drawer.returnFocus = origin || document.activeElement;
      const C = State.cols;
      $('#drawer-title').textContent = rec.id || `Sheet row ${rec.row}`;
      $('#drawer-meta').innerHTML = [
        C.status ? Status.badge(rec.status) : '',
        rec.ts ? `<span>${Fmt.esc(Fmt.dateTime(rec.ts))}</span>` : '',
        State.fresh.has(rec.key) ? '<span class="badge badge--fresh">NEW</span>' : ''
      ].filter(Boolean).join('');

      $('#drawer-fields').innerHTML = State.headers.map((h) => {
        const v = rec.values[h];
        if (!v) return `<div><dt>${Fmt.esc(h)}</dt><dd class="is-empty">Not provided</dd></div>`;
        let html = Fmt.esc(v);
        if (h === C.date && rec.ts) html = `${Fmt.esc(Fmt.dateTime(rec.ts))}<small>${Fmt.esc(v)}</small>`;
        else if (h === C.status) html = Status.badge(v);
        else if (h === C.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) html = `<a href="mailto:${Fmt.esc(v)}">${Fmt.esc(v)}</a>`;
        else if (h === C.phone && /^[+\d][\d\s()-]{5,}$/.test(v)) html = `<a href="tel:${Fmt.esc(v.replace(/[^\d+]/g, ''))}">${Fmt.esc(v)}</a>`;
        else if (h === C.country || h === C.department) html = Fmt.esc(Fmt.label(v));
        return `<div${v.length > 80 ? ' class="details--long"' : ''}><dt>${Fmt.esc(h)}</dt><dd>${html}</dd></div>`;
      }).join('');
      $('#drawer-row').textContent = `Sheet row ${rec.row} · ${State.sheetName}`;

      $('#drawer-scrim').hidden = false;
      $('#drawer').hidden = false;
      document.body.classList.add('drawer-open');
      $('.drawer__body').scrollTop = 0;
      $('#drawer-close').focus();
    },
    close() {
      if ($('#drawer').hidden) return;
      $('#drawer').hidden = true;
      $('#drawer-scrim').hidden = true;
      document.body.classList.remove('drawer-open');
      if (Drawer.returnFocus && document.contains(Drawer.returnFocus)) Drawer.returnFocus.focus();
      Drawer.returnFocus = null;
    },
    trap(e) {
      if (e.key !== 'Tab' || $('#drawer').hidden) return;
      const focusables = $$('#drawer a[href], #drawer button:not([disabled])');
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },
    bind() {
      $('#drawer-close').addEventListener('click', Drawer.close);
      $('#drawer-close-2').addEventListener('click', Drawer.close);
      $('#drawer-scrim').addEventListener('click', Drawer.close);
      $('#drawer').addEventListener('keydown', Drawer.trap);
    }
  };

  /* ===================================================================
     Charts — Chart.js (CDN, plain JS)
     =================================================================== */
  const Charts = {
    inst: {},
    ready: () => typeof window.Chart !== 'undefined',
    navy: '#172A5C',

    setup() {
      if (!Charts.ready()) return;
      const d = window.Chart.defaults;
      d.font.family = '"IBM Plex Sans", system-ui, sans-serif';
      d.font.size = 12;
      d.color = '#667085';
      d.borderColor = '#E3E8F1';
      d.plugins.legend.display = false;
      d.plugins.tooltip.backgroundColor = '#101828';
      d.plugins.tooltip.padding = 10;
      d.plugins.tooltip.cornerRadius = 6;
      d.plugins.tooltip.displayColors = false;
      d.maintainAspectRatio = false;
      d.animation = false;
    },

    renderFor(view) {
      if (!State.loaded) return;
      if (view === 'dashboard') Charts.trend('chart-trend-mini');
      if (view === 'analytics') {
        Charts.trend('chart-trend');
        Charts.grouped('chart-department', 'dept', 'department', 12);
        Charts.grouped('chart-country', 'country', 'country', 10);
        Charts.status();
        Charts.assignee();
      }
    },

    upsert(id, config, emptyText) {
      const canvas = document.getElementById(id);
      if (!canvas) return;
      const host = canvas.parentElement;
      let msg = host.querySelector('.chart__empty');
      const text = !Charts.ready() ? 'Charts could not be loaded. Check your internet connection.' : emptyText;
      if (text) {
        if (Charts.inst[id]) { Charts.inst[id].destroy(); delete Charts.inst[id]; }
        canvas.hidden = true;
        if (!msg) { msg = document.createElement('div'); msg.className = 'chart__empty'; host.appendChild(msg); }
        msg.textContent = text;
        return;
      }
      canvas.hidden = false;
      if (msg) msg.remove();
      const existing = Charts.inst[id];
      if (existing && existing.config.type === config.type) {
        existing.data = config.data;
        existing.options = config.options;
        existing.update('none');
      } else {
        if (existing) existing.destroy();
        Charts.inst[id] = new window.Chart(canvas, config);
      }
    },

    trend(id) {
      const withDate = State.records.filter((r) => r.t != null);
      if (!withDate.length) {
        Charts.upsert(id, null, State.records.length ? 'No date values found to build a trend.' : 'No inquiries yet.');
        return;
      }
      // Last 30 days ending today, or ending at the latest inquiry if all data is older.
      const latest = Math.max(...withDate.map((r) => r.t));
      const end = Date.now() - latest > 29 * 86400000 ? new Date(latest) : new Date();
      const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      const days = [];
      for (let i = 29; i >= 0; i--) days.push(new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() - i));
      const counts = new Map(days.map((d) => [Fmt.dayKey(d), 0]));
      withDate.forEach((r) => {
        const k = Fmt.dayKey(r.ts);
        if (counts.has(k)) counts.set(k, counts.get(k) + 1);
      });
      Charts.upsert(id, {
        type: 'line',
        data: {
          labels: days.map((d) => `${Fmt.pad(d.getDate())} ${MONTHS[d.getMonth()]}`),
          datasets: [{
            label: 'Inquiries',
            data: Array.from(counts.values()),
            borderColor: Charts.navy,
            backgroundColor: 'rgba(23, 42, 92, .08)',
            fill: true,
            cubicInterpolationMode: 'monotone',
            pointRadius: 2.5,
            pointHoverRadius: 5,
            pointBackgroundColor: Charts.navy,
            borderWidth: 2
          }]
        },
        options: {
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
            y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#EEF1F6' } }
          },
          plugins: { tooltip: { callbacks: { label: (c) => ` ${c.parsed.y} ${c.parsed.y === 1 ? 'inquiry' : 'inquiries'}` } } }
        }
      });
    },

    hbar(id, labels, values, colors) {
      Charts.upsert(id, {
        type: 'bar',
        data: { labels, datasets: [{ data: values, backgroundColor: colors || Charts.navy, borderRadius: 3, maxBarThickness: 22 }] },
        options: {
          indexAxis: 'y',
          scales: {
            x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#EEF1F6' } },
            y: { grid: { display: false }, ticks: { autoSkip: false, callback(v) { const l = this.getLabelForValue(v); return l.length > 26 ? `${l.slice(0, 25)}…` : l; } } }
          },
          plugins: { tooltip: { callbacks: { label: (c) => ` ${c.parsed.x} ${c.parsed.x === 1 ? 'inquiry' : 'inquiries'}` } } }
        }
      });
    },

    grouped(id, field, colRole, limit) {
      if (!State.cols[colRole]) { Charts.upsert(id, null, `No ${Columns.labels[colRole]} column found in the sheet.`); return; }
      const groups = Data.groupBy(field);
      if (!groups.length) { Charts.upsert(id, null, 'No inquiries yet.'); return; }
      let rows = groups.slice(0, limit);
      if (groups.length > limit) {
        rows = rows.concat([{ label: 'Other', count: groups.slice(limit).reduce((s, g) => s + g.count, 0) }]);
      }
      Charts.hbar(id, rows.map((g) => g.label), rows.map((g) => g.count));
    },

    status() {
      const card = $('#status-chart-card');
      card.hidden = !State.cols.status;
      if (!State.cols.status) return;
      const groups = Data.groupBy('status');
      if (!groups.length) { Charts.upsert('chart-status', null, 'No inquiries yet.'); return; }
      Charts.hbar('chart-status', groups.map((g) => g.label), groups.map((g) => g.count),
        groups.map((g) => Status.colors[g.key === NONE ? 'none' : Status.group(g.key)]));
    },

    assignee() {
      const card = $('#assignee-chart-card');
      card.hidden = !State.cols.assigned;
      if (!State.cols.assigned) return;
      const open = State.records.filter((r) => r.statusGroup !== 'completed');
      const map = new Map();
      open.forEach((r) => {
        const k = Fmt.norm(r.assigned) || NONE;
        const cur = map.get(k) || { label: r.assigned ? Fmt.label(r.assigned) : 'Unassigned', count: 0 };
        cur.count++;
        map.set(k, cur);
      });
      const rows = Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, 10);
      if (!rows.length) { Charts.upsert('chart-assignee', null, State.cols.status ? 'No open inquiries — all caught up.' : 'No inquiries yet.'); return; }
      Charts.hbar('chart-assignee', rows.map((r) => r.label), rows.map((r) => r.count), '#2A4A92');
    },

    destroyAll() {
      Object.values(Charts.inst).forEach((c) => c.destroy());
      Charts.inst = {};
    }
  };

  /* ===================================================================
     Settings — account & data source info (placeholder settings page)
     =================================================================== */
  const Settings = {
    render() {
      const endpoint = Api.configured()
        ? (() => { const u = new URL(CFG.GOOGLE_APPS_SCRIPT_URL); const p = u.pathname.split('/'); const id = p[3] || ''; return `Configured · ${u.host}/…/${id.slice(0, 6)}…${id.slice(-4)}`; })()
        : 'Not configured — set GOOGLE_APPS_SCRIPT_URL in config.js';
      const rows = [
        ['Sheet tab', `<span class="mono">${Fmt.esc(State.sheetName)}</span>`],
        ['Rows loaded', State.loaded ? Fmt.num(State.records.length) : '—'],
        ['Columns', State.loaded ? Fmt.num(State.headers.length) : '—'],
        ['Auto refresh', `Every ${Math.round(REFRESH_MS / 1000)} seconds`],
        ['Last updated', State.lastUpdated ? Fmt.dateTime(State.lastUpdated) : '—'],
        ['Apps Script API', Fmt.esc(endpoint)],
        ['Access mode', 'Read-only (version 1)']
      ];
      $('#source-info').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

      const chips = $('#column-chips');
      const note = $('#column-note');
      if (!State.loaded) { chips.innerHTML = ''; note.textContent = 'Columns appear after the first successful data load.'; return; }
      chips.innerHTML = State.headers.map((h) => {
        const role = Columns.roleOf(h);
        return `<span class="chip chip--static">${Fmt.esc(h)}${role && Columns.labels[role] !== h ? ` · <b>${Columns.labels[role]}</b>` : ''}</span>`;
      }).join('') || '<span class="muted">No header row found.</span>';
      const missing = ['id', 'date', 'department', 'country', 'status'].filter((k) => !State.cols[k]).map((k) => Columns.labels[k]);
      note.textContent = missing.length
        ? `Not found in the sheet: ${missing.join(', ')}. Related filters and metrics are hidden automatically.`
        : 'All key columns were detected.';
    }
  };

  /* ===================================================================
     App — lifecycle
     =================================================================== */
  const App = {
    enter(user) {
      if (!user) return;
      if (State.user && State.user.id === user.id) return;     // already inside
      State = freshState();
      State.user = user;
      const email = user.email || '';
      $$('[data-user-email]').forEach((el) => { el.textContent = email; });
      $$('[data-user-initial]').forEach((el) => { el.textContent = (email[0] || '?').toUpperCase(); });
      UI.authMessage(null);
      UI.showApp();
      UI.banner(null);
      $('#last-updated').textContent = '—';
      Filters.syncInputs();
      $('#page-size').value = String(State.pageSize);
      UI.showView('dashboard');
      Render.all();                                            // skeleton states
      Data.refresh().finally(() => { if (State.user) Poller.start(); });
    },

    /** Clears all dashboard state & DOM. Safe to call more than once. */
    leave() {
      Poller.stop();
      Drawer.close();
      Notify.clearAll();
      Charts.destroyAll();
      State = freshState();
      $('#kpis').innerHTML = '';
      $('#dept-cards').innerHTML = '';
      $('#recent-list').innerHTML = '';
      $('#table-head').innerHTML = '';
      $('#table-body').innerHTML = '';
      $('#pager-btns').innerHTML = '';
      $('#source-info').innerHTML = '';
      $('#column-chips').innerHTML = '';
      $$('[data-user-email]').forEach((el) => { el.textContent = ''; });
      UI.closeSidebar();
      UI.banner(null);
      UI.updateBadge();
      $('#app-view').hidden = true;
    },

    async logout() {
      Poller.stop();
      await Auth.signOut();
      App.leave();
      UI.showAuth('login', { type: 'success', text: 'You have been signed out securely.' });
    },

    async expire() {
      Poller.stop();
      try { await Auth.client.auth.signOut({ scope: 'local' }); } catch (_) { /* ignore */ }
      App.leave();
      UI.showAuth('login', { type: 'info', text: 'Your session has expired. Please sign in again.' });
    },

    cleanUrl() {
      if (window.location.href.includes('#') || /[?&](code|error)/.test(window.location.search)) {
        window.history.replaceState(null, '', window.location.pathname);
      }
    },

    bind() {
      // Auth forms
      $('#form-login').addEventListener('submit', Auth.handleLogin);
      $('#form-register').addEventListener('submit', Auth.handleRegister);
      $('#form-forgot').addEventListener('submit', Auth.handleForgot);
      $('#form-update-password').addEventListener('submit', Auth.handleUpdatePassword);
      $('#auth-view').addEventListener('click', (e) => {
        const go = e.target.closest('[data-go]');
        if (go) {
          const from = $('[data-auth-panel]:not([hidden]) input[type="email"]');
          const panel = go.dataset.go;
          UI.showAuth(panel);
          const to = $(`[data-auth-panel="${panel}"] input[type="email"]`);
          if (from && to && from.value && !to.value) to.value = from.value;
          return;
        }
        const resend = e.target.closest('[data-resend]');
        if (resend) Auth.handleResend(resend.dataset.resend, resend);
        const toggle = e.target.closest('[data-toggle-password]');
        if (toggle) {
          const input = toggle.parentElement.querySelector('input');
          const show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          toggle.setAttribute('aria-pressed', String(show));
          toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
          toggle.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
        }
      });

      // Dashboard-wide actions (delegated)
      document.addEventListener('click', (e) => {
        const nav = e.target.closest('[data-nav]');
        if (nav) { UI.showView(nav.dataset.nav); return; }
        const act = e.target.closest('[data-action]');
        if (act) {
          const a = act.dataset.action;
          if (a === 'logout') App.logout();
          if (a === 'retry') Poller.now(false);
          if (a === 'clear-filters') Filters.reset();
          return;
        }
        const dept = e.target.closest('[data-dept]');
        if (dept) {
          Filters.reset();
          Filters.set({ department: dept.dataset.dept });
          UI.showView('inquiries');
          return;
        }
        const open = e.target.closest('#recent-list [data-open]');
        if (open) Drawer.open(State.records[+open.dataset.open], open);
        if (e.target.closest('[data-open-sidebar]')) UI.openSidebar();
        if (e.target.closest('[data-close-sidebar]')) UI.closeSidebar();
      });

      $('#btn-refresh').addEventListener('click', () => Poller.now(true));

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (!$('#drawer').hidden) Drawer.close();
          else UI.closeSidebar();
        }
      });
      document.addEventListener('visibilitychange', Poller.onVisibility);

      Filters.bind();
      Table.bind();
      Drawer.bind();
    },

    fatal(text) {
      UI.showBoot(false);
      UI.showAuth('login', { type: 'error', text });
      $$('#auth-view form button[type="submit"]').forEach((b) => { b.disabled = true; });
    },

    async boot() {
      $$('[data-year]').forEach((el) => { el.textContent = String(new Date().getFullYear()); });
      $$('[data-min-pass]').forEach((el) => { el.textContent = String(MIN_PASS); });
      App.bind();
      Charts.setup();

      if (!CFG.SUPABASE_URL || !CFG.SUPABASE_PUBLISHABLE_KEY) {
        App.fatal('The dashboard is not configured: Supabase URL or publishable key is missing in config.js.');
        return;
      }
      if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        App.fatal('The sign-in service could not be loaded. Please check your internet connection and reload the page.');
        return;
      }

      // Read auth redirects (email confirmation / password reset) before Supabase consumes the URL.
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const query = new URLSearchParams(window.location.search);
      Auth.recovery = hash.get('type') === 'recovery';
      const linkError = hash.get('error_description') || query.get('error_description');
      const confirmed = hash.get('type') === 'signup';

      try {
        Auth.init();
        const { data, error } = await Auth.client.auth.getSession();
        if (error) throw error;
        const session = data.session;
        UI.showBoot(false);

        if (Auth.recovery && session) {
          UI.showAuth('update', { type: 'info', text: 'Reset link verified. Please choose a new password.' });
        } else if (session) {
          App.cleanUrl();
          App.enter(session.user);
          if (confirmed) Notify.success('Your email has been verified. Welcome!');
        } else {
          Auth.recovery = false;
          App.cleanUrl();
          UI.showAuth('login', linkError
            ? { type: 'error', text: 'This link is invalid or has expired. Please request a new one.' }
            : null);
        }
      } catch (err) {
        console.error(err);
        Auth.recovery = false;
        UI.showBoot(false);
        UI.showAuth('login', { type: 'error', text: 'Your sign-in link could not be verified. Please sign in or request a new link.' });
      }
    }
  };

  document.addEventListener('DOMContentLoaded', App.boot);
})();
