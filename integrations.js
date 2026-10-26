/* =====================================================================
   IKRIS — API Integration Center (admin only)
   • API Setup : integrations (credentials in Supabase Vault), callback URLs,
                 project API keys, audit log
   • API Usage : real metrics from integration_metrics / webhook_deliveries
   All writes go through the "integrations" edge function; the browser only
   ever sees safe metadata (never a stored secret).
   ===================================================================== */
window.IkrisIntegrations = (function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const num = (n) => Number(n || 0).toLocaleString('en-IN');
  const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const ago = (iso) => {
    if (!iso) return 'never';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };
  const usd = (v) => (v === null || v === undefined || v === '' ? '—' : `$${Number(v).toFixed(2)}`);

  const PROVIDERS = {
    openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', auth: 'bearer', test: '/models' },
    openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', auth: 'bearer', test: '/key' },
    whatsapp_cloud: { label: 'WhatsApp Cloud API', base: 'https://graph.facebook.com/v23.0', auth: 'bearer', test: '/me' },
    cunnekt: { label: 'Cunnekt WhatsApp API', base: '', auth: 'api_key_header', header: 'X-API-Key', test: '' },
    sendgrid: { label: 'SendGrid (email)', base: 'https://api.sendgrid.com/v3', auth: 'bearer', test: '/scopes' },
    resend: { label: 'Resend (email)', base: 'https://api.resend.com', auth: 'bearer', test: '/domains' },
    hubspot: { label: 'HubSpot CRM', base: 'https://api.hubapi.com', auth: 'bearer', test: '/crm/v3/objects/contacts?limit=1' },
    custom_rest: { label: 'Custom REST API', base: '', auth: 'bearer', test: '' },
    n8n: { label: 'n8n' },
    apps_script: { label: 'Google Apps Script' }
  };
  const AUTH_LABEL = { none: 'No authentication', bearer: 'Bearer token', api_key_header: 'API key in header', basic: 'Basic auth', oauth2_client: 'OAuth 2.0 (client credentials)', managed: 'Managed outside' };
  const STATUS = {
    connected: ['Connected', 'ok'], failed: ['Failed', 'bad'], untested: ['Not tested', 'idle'], disabled: ['Disabled', 'off'],
    healthy: ['Healthy', 'ok'], failing: ['Failing', 'bad']
  };
  const INTEG_COLS = 'id,slug,name,provider,base_url,auth_type,auth_header,config,managed_by,secret_hint,enabled,status,last_tested_at,last_test,rotated_at,created_by,created_at,updated_by,updated_at';
  const HOOK_COLS = 'id,name,url,events,enabled,secret_hint,status,last_delivery_at,last_status_code,last_error,created_at,updated_at';
  const DELIV_COLS = 'id,endpoint_id,event_type,status,attempts,status_code,duration_ms,error,is_test,created_at,delivered_at';
  const KEY_COLS = 'id,name,key_prefix,allowed,expires_at,revoked_at,last_used_at,created_by,created_at';

  let ctx = null;
  const fresh = () => ({
    user: null, admin: false, checked: false, loaded: false, tab: 'setup', q: '',
    integrations: [], hooks: [], deliveries: [], keys: [], audit: [],
    editing: null, busy: new Set(), usage: null, recent: [], errors: []
  });
  let S = fresh();
  const client = () => ctx.client();

  async function invoke(body) {
    const { data, error } = await client().functions.invoke('integrations', { body });
    if (error) {
      let msg = 'The request could not be completed. Please try again.';
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) { /* keep default */ }
      throw new Error(msg);
    }
    return data;
  }
  const toastOk = (title, body) => ctx.toast({ type: 'success', title, body: body ? `<p class="muted small" style="margin-top:4px">${body}</p>` : undefined, timeout: 5000 });
  const toastErr = (title) => ctx.toast({ type: 'error', title, timeout: 8000 });

  /* ---------------- data ---------------- */
  async function loadSetup() {
    const c = client();
    const [i, h, d, k, a] = await Promise.all([
      c.from('integrations').select(INTEG_COLS).order('managed_by', { ascending: false }).order('created_at'),
      c.from('webhook_endpoints').select(HOOK_COLS).order('created_at'),
      c.from('webhook_deliveries').select(DELIV_COLS).order('id', { ascending: false }).limit(25),
      c.from('integration_clients').select(KEY_COLS).order('created_at', { ascending: false }),
      c.from('integration_audit').select('id,actor,action,target,created_at').order('id', { ascending: false }).limit(15)
    ]);
    const err = [i, h, d, k, a].find((r) => r.error);
    if (err) throw err.error;
    S.integrations = i.data || []; S.hooks = h.data || []; S.deliveries = d.data || []; S.keys = k.data || []; S.audit = a.data || [];
    S.loaded = true;
  }

  async function refresh(silent) {
    try {
      await loadSetup();
      renderSetup();
      if (S.tab === 'usage') await loadUsage();
    } catch (e) {
      if (!silent) toastErr('Could not load integrations. ' + (e.message || ''));
    }
  }

  /* ---------------- setup tab ---------------- */
  const providerLabel = (p) => (PROVIDERS[p] && PROVIDERS[p].label) || p;
  function statusBadge(st) {
    const [label, tone] = STATUS[st] || [st || 'Unknown', 'idle'];
    return `<span class="integ-status integ-status--${tone}"><i aria-hidden="true"></i>${esc(label)}</span>`;
  }
  function managedBadge(i) {
    if (i.managed_by === 'n8n') return '<span class="integ-tag" title="The credential is stored in an n8n credential, not in this center">Key stored in n8n</span>';
    if (i.managed_by === 'external') return '<span class="integ-tag">Managed by Google</span>';
    return '<span class="integ-tag integ-tag--vault" title="Encrypted at rest in Supabase Vault">Encrypted in Vault</span>';
  }

  function renderSetup() {
    if (!S.loaded) return;
    const q = S.q.toLowerCase();
    const list = S.integrations.filter((i) => !q || `${i.name} ${i.slug} ${providerLabel(i.provider)} ${i.base_url || ''}`.toLowerCase().includes(q));
    $('#integ-count').textContent = `${S.integrations.length} integration${S.integrations.length === 1 ? '' : 's'}`;
    $('#integ-list').innerHTML = list.length ? list.map(card).join('') :
      `<div class="cmp-empty">${S.integrations.length ? 'No integrations match your search.' : '<strong>No integrations yet</strong><span>Click <b>Add integration</b> to connect your first API.</span>'}</div>`;
    renderHooks();
    renderKeys();
    renderAudit();
  }

  function card(i) {
    const t = i.last_test || null;
    const busy = S.busy.has(i.id);
    const center = i.managed_by === 'center';
    const details = t && t.details ? Object.entries(t.details).filter(([, v]) => v !== null && v !== undefined) : [];
    const detailLabels = { provider_usage_usd: 'Total usage', usage_today_usd: 'Today', usage_month_usd: 'This month', credit_limit_usd: 'Credit limit', limit_remaining_usd: 'Remaining' };
    return `<article class="integ-card${i.enabled ? '' : ' is-off'}" data-integ="${esc(i.id)}">
      <header class="integ-card__head">
        <div class="integ-card__title">
          <h3>${esc(i.name)}</h3>
          <p class="muted small"><span class="mono">${esc(i.slug)}</span> · ${esc(providerLabel(i.provider))}</p>
        </div>
        ${statusBadge(i.enabled ? i.status : 'disabled')}
      </header>
      <dl class="integ-kv">
        <div><dt>Base URL</dt><dd class="mono" title="${esc(i.base_url || '')}">${esc(i.base_url || '—')}</dd></div>
        <div><dt>Authentication</dt><dd>${esc(AUTH_LABEL[i.auth_type] || i.auth_type)}${i.auth_type === 'api_key_header' && i.auth_header ? ` <span class="mono muted">(${esc(i.auth_header)})</span>` : ''}</dd></div>
        <div><dt>Credential</dt><dd>${i.secret_hint ? `<span class="mono">${esc(i.secret_hint)}</span>` : (center && i.auth_type !== 'none' ? '<span class="muted">not set</span>' : '<span class="muted">—</span>')} ${managedBadge(i)}</dd></div>
        <div><dt>Last tested</dt><dd>${i.last_tested_at ? `${esc(ago(i.last_tested_at))}${t && t.http ? ` · HTTP ${esc(t.http)}` : ''}${t && t.ms ? ` · ${esc(t.ms)} ms` : ''}` : '<span class="muted">never</span>'}</dd></div>
        <div><dt>Last updated</dt><dd>${esc(dateTime(i.updated_at))}${i.rotated_at ? ` <span class="muted small">· key changed ${esc(ago(i.rotated_at))}</span>` : ''}</dd></div>
      </dl>
      ${t && t.message ? `<p class="integ-result integ-result--${t.ok ? 'ok' : 'bad'}">${esc(t.message)}</p>` : ''}
      ${details.length ? `<div class="integ-provider-usage"><span class="muted small">Reported by ${esc(providerLabel(i.provider))}:</span>${details.map(([k, v]) => `<span><b>${esc(usd(v))}</b> ${esc(detailLabels[k] || k)}</span>`).join('')}</div>` : ''}
      ${i.config && i.config.note ? `<p class="muted small integ-note">${esc(i.config.note)}</p>` : ''}
      <footer class="integ-card__foot">
        <button type="button" class="btn btn--wa btn--sm" data-integ-test="${esc(i.id)}"${busy || !i.enabled ? ' disabled' : ''} aria-busy="${busy}">${busy ? 'Testing…' : 'Test connection'}</button>
        <button type="button" class="btn btn--outline btn--sm" data-integ-edit="${esc(i.id)}">${center ? 'Edit' : 'Rename'}</button>
        ${center && i.auth_type !== 'none' ? `<button type="button" class="btn btn--outline btn--sm" data-integ-rotate="${esc(i.id)}">Rotate key</button>` : ''}
        <label class="integ-switch" title="${i.enabled ? 'Disable' : 'Enable'} this integration">
          <input type="checkbox" data-integ-toggle="${esc(i.id)}"${i.enabled ? ' checked' : ''}>
          <span aria-hidden="true"></span><span class="sr-only">Enabled</span>${i.enabled ? 'Enabled' : 'Disabled'}
        </label>
        ${center ? `<button type="button" class="icon-btn" data-integ-delete="${esc(i.id)}" aria-label="Delete ${esc(i.name)}" title="Delete"><svg aria-hidden="true"><use href="#i-trash"/></svg></button>` : ''}
      </footer>
    </article>`;
  }

  /* callbacks */
  function renderHooks() {
    const box = $('#hook-list');
    if (!S.hooks.length) {
      box.innerHTML = '<div class="cmp-empty small"><strong>No callback URL yet</strong><span>Add one above to receive WhatsApp events on your own system.</span></div>';
    } else {
      box.innerHTML = S.hooks.map((h) => {
        const recent = S.deliveries.filter((d) => d.endpoint_id === h.id).slice(0, 5);
        const busy = S.busy.has(h.id);
        return `<article class="hook-card" data-hook="${esc(h.id)}">
          <header class="integ-card__head">
            <div class="integ-card__title"><h3>${esc(h.name)}</h3><p class="mono small hook-url">${esc(h.url)}</p></div>
            ${statusBadge(h.enabled ? h.status : 'disabled')}
          </header>
          <dl class="integ-kv">
            <div><dt>Events</dt><dd>${(h.events || []).map((e) => `<span class="integ-tag">${esc(e)}</span>`).join(' ')}</dd></div>
            <div><dt>Signing secret</dt><dd><span class="mono">${esc(h.secret_hint || '—')}</span></dd></div>
            <div><dt>Last delivery</dt><dd>${h.last_delivery_at ? esc(dateTime(h.last_delivery_at)) : '<span class="muted">none yet</span>'}</dd></div>
            <div><dt>Last HTTP response</dt><dd>${h.last_status_code ? `<span class="mono">${esc(h.last_status_code)}</span>` : '<span class="muted">—</span>'}</dd></div>
          </dl>
          ${h.last_error ? `<p class="integ-result integ-result--bad">Last error: ${esc(h.last_error)}</p>` : ''}
          ${recent.length ? `<details class="hook-recent"><summary>Recent deliveries (${recent.length})</summary><ul>${recent.map((d) => `<li><span class="integ-status integ-status--${d.status === 'delivered' ? 'ok' : d.status === 'failed' ? 'bad' : 'idle'}"><i aria-hidden="true"></i>${esc(d.status)}</span> <span class="mono small">${esc(d.event_type)}</span> <span class="muted small">${esc(dateTime(d.created_at))} · attempt ${esc(d.attempts)}${d.status_code ? ` · HTTP ${esc(d.status_code)}` : ''}${d.error ? ` · ${esc(d.error)}` : ''}</span></li>`).join('')}</ul></details>` : ''}
          <footer class="integ-card__foot">
            <button type="button" class="btn btn--wa btn--sm" data-hook-test="${esc(h.id)}"${busy ? ' disabled' : ''} aria-busy="${busy}">${busy ? 'Sending…' : 'Send test event'}</button>
            <button type="button" class="btn btn--outline btn--sm" data-hook-edit="${esc(h.id)}">Edit</button>
            <button type="button" class="btn btn--outline btn--sm" data-hook-secret="${esc(h.id)}">New signing secret</button>
            <button type="button" class="icon-btn" data-hook-delete="${esc(h.id)}" aria-label="Delete callback ${esc(h.name)}" title="Delete"><svg aria-hidden="true"><use href="#i-trash"/></svg></button>
          </footer>
        </article>`;
      }).join('');
    }
    const pending = S.deliveries.filter((d) => d.status === 'pending').length;
    $('#hook-retry').hidden = !pending;
    $('#hook-retry').textContent = `Retry ${pending} pending now`;
  }

  /* project keys */
  function renderKeys() {
    const center = S.integrations.filter((i) => i.managed_by === 'center');
    $('#key-allowed').innerHTML = center.length
      ? center.map((i) => `<label class="integ-check"><input type="checkbox" value="${esc(i.slug)}"> ${esc(i.name)} <span class="mono muted small">${esc(i.slug)}</span></label>`).join('')
      : '<p class="muted small">Add an integration first - keys can only use integrations configured in this center.</p>';
    $('#key-create').disabled = !center.length;
    $('#key-list').innerHTML = S.keys.length ? S.keys.map((k) => {
      const expired = k.expires_at && new Date(k.expires_at) < new Date();
      const state = k.revoked_at ? ['Revoked', 'off'] : expired ? ['Expired', 'bad'] : ['Active', 'ok'];
      return `<tr>
        <td><b>${esc(k.name)}</b><div class="mono muted small">${esc(k.key_prefix)}…</div></td>
        <td>${(k.allowed || []).map((s) => `<span class="integ-tag mono">${esc(s)}</span>`).join(' ')}</td>
        <td>${k.expires_at ? esc(dateTime(k.expires_at)) : 'Never'}</td>
        <td>${k.last_used_at ? esc(ago(k.last_used_at)) : '<span class="muted">never</span>'}</td>
        <td><span class="integ-status integ-status--${state[1]}"><i aria-hidden="true"></i>${state[0]}</span></td>
        <td class="num">${k.revoked_at ? '' : `<button type="button" class="btn btn--ghost btn--sm" data-key-revoke="${esc(k.id)}">Revoke</button>`}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="muted small">No project keys yet.</td></tr>';
  }

  function renderAudit() {
    $('#integ-audit').innerHTML = S.audit.length ? S.audit.map((a) => `<li><span class="mono small">${esc(a.action)}</span> <span>${esc(a.target || '')}</span> <span class="muted small">${esc(a.actor || '')} · ${esc(dateTime(a.created_at))}</span></li>`).join('')
      : '<li class="muted small">No changes recorded yet.</li>';
  }

  /* ---------------- dialogs ---------------- */
  function openDialog(id) {
    $$('.integ-modal').forEach((d) => { d.hidden = d.id !== id; });
    $('#integ-scrim').hidden = false;
    const first = $(`#${id} input:not([type=hidden]):not([type=checkbox]), #${id} select, #${id} textarea`);
    if (first) setTimeout(() => first.focus(), 40);
  }
  function closeDialogs() {
    $$('.integ-modal').forEach((d) => { d.hidden = true; });
    $('#integ-scrim').hidden = true;
    $$('.integ-modal input[type=password], #secret-value').forEach((el) => { if ('value' in el) el.value = ''; else el.textContent = ''; });
    S.editing = null;
  }

  function openIntegDialog(id) {
    const i = id ? S.integrations.find((x) => x.id === id) : null;
    S.editing = i;
    const managed = i && i.managed_by !== 'center';
    $('#integ-form').reset();
    $('#integ-dialog-title').textContent = !i ? 'Add integration' : managed ? 'Rename integration' : 'Edit integration';
    $('#integ-msg').textContent = '';
    $('#integ-provider').value = i ? i.provider : 'custom_rest';
    $('#integ-name').value = i ? i.name : '';
    $('#integ-base').value = i ? i.base_url || '' : '';
    $('#integ-auth').value = i ? i.auth_type : 'bearer';
    $('#integ-header').value = (i && i.auth_header) || 'X-API-Key';
    $('#integ-secret').value = '';
    $('#integ-secret').placeholder = i && i.secret_hint ? `Leave blank to keep ${i.secret_hint}` : 'Paste the API key or token';
    $('#integ-test-path').value = (i && i.config && i.config.test_path) || '';
    const headers = (i && i.config && i.config.headers) || {};
    $('#integ-headers').value = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    $$('[data-integ-full]').forEach((el) => { el.hidden = !!managed; });
    if (!i) applyPreset(false);
    syncAuthFields();
    openDialog('integ-dialog');
  }

  function applyPreset(overwrite) {
    const p = PROVIDERS[$('#integ-provider').value] || {};
    if (overwrite || !$('#integ-base').value) $('#integ-base').value = p.base || '';
    if (p.auth) $('#integ-auth').value = p.auth;
    if (p.header) $('#integ-header').value = p.header;
    $('#integ-test-path').placeholder = p.test ? `Default: ${p.test}` : 'e.g. /status';
    if (!$('#integ-name').value || overwrite) $('#integ-name').value = p.label && $('#integ-provider').value !== 'custom_rest' ? p.label : $('#integ-name').value;
    syncAuthFields();
  }

  function syncAuthFields() {
    const a = $('#integ-auth').value;
    $('#integ-header-field').hidden = a !== 'api_key_header' || !!(S.editing && S.editing.managed_by !== 'center');
    $('#integ-secret-field').hidden = a === 'none' || !!(S.editing && S.editing.managed_by !== 'center');
    $('#integ-secret-label').textContent = a === 'basic' ? 'Username:password' : a === 'oauth2_client' ? 'OAuth 2.0 client (JSON)' : 'API key or token';
    $('#integ-secret-hint').textContent = a === 'oauth2_client'
      ? '{"token_url": "https://…/oauth/token", "client_id": "…", "client_secret": "…", "scope": "…"} - a token is requested on the server each time.'
      : 'Stored encrypted in Supabase Vault. It is never shown again, logged or sent to the browser.';
  }

  function parseHeaders(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const i = s.indexOf(':');
      if (i < 1) throw new Error(`Custom header "${s}" must look like Name: value`);
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
    return out;
  }

  async function submitInteg(e) {
    e.preventDefault();
    const msg = $('#integ-msg');
    msg.textContent = '';
    const btn = $('#integ-save');
    const i = S.editing;
    let body;
    try {
      body = { action: 'save', id: i ? i.id : undefined, name: $('#integ-name').value.trim() };
      if (!i || i.managed_by === 'center') {
        const config = { ...((i && i.config) || {}) };
        const tp = $('#integ-test-path').value.trim();
        if (tp) config.test_path = tp; else delete config.test_path;
        const hdrs = parseHeaders($('#integ-headers').value);
        if (Object.keys(hdrs).length) config.headers = hdrs; else delete config.headers;
        Object.assign(body, {
          provider: $('#integ-provider').value, base_url: $('#integ-base').value.trim(), auth_type: $('#integ-auth').value,
          auth_header: $('#integ-header').value.trim(), config, secret: $('#integ-secret').value
        });
      }
    } catch (err) { msg.textContent = err.message; return; }
    if (!body.name) { msg.textContent = 'Give the integration a name.'; $('#integ-name').focus(); return; }
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    try {
      const r = await invoke(body);
      $('#integ-secret').value = '';
      closeDialogs();
      await refresh(true);
      toastOk(i ? 'Integration updated.' : 'Integration saved.', 'Click “Test connection” to check it with the provider.');
      if (!i && r && r.id) { const el = $(`[data-integ="${CSS.escape(r.id)}"]`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false; btn.setAttribute('aria-busy', 'false');
    }
  }

  async function testInteg(id) {
    S.busy.add(id); renderSetup();
    try {
      const r = await invoke({ action: 'test', id });
      const t = r.test || {};
      if (t.ok) toastOk('Connection works.', esc(t.message || ''));
      else toastErr(`Connection failed: ${t.message || 'no answer'}`);
    } catch (e) { toastErr(e.message); }
    S.busy.delete(id);
    await refresh(true);
  }

  async function toggleInteg(id, enabled) {
    try {
      await invoke({ action: 'toggle', id, enabled });
      toastOk(enabled ? 'Integration enabled.' : 'Integration disabled.');
    } catch (e) { toastErr(e.message); }
    await refresh(true);
  }

  function openRotate(id) {
    const i = S.integrations.find((x) => x.id === id);
    if (!i) return;
    S.editing = i;
    $('#rotate-form').reset();
    $('#rotate-msg').textContent = '';
    $('#rotate-name').textContent = i.name;
    $('#rotate-current').textContent = i.secret_hint || 'not set';
    const testable = !!((i.config && i.config.test_path) || (PROVIDERS[i.provider] && PROVIDERS[i.provider].test));
    $('#rotate-untested-field').hidden = testable;
    openDialog('rotate-dialog');
  }

  async function submitRotate(e) {
    e.preventDefault();
    const i = S.editing; if (!i) return;
    const msg = $('#rotate-msg');
    const secret = $('#rotate-secret').value;
    if (!secret.trim()) { msg.textContent = 'Enter the new credential.'; return; }
    const btn = $('#rotate-save');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true'); msg.textContent = '';
    try {
      const r = await invoke({ action: 'rotate', id: i.id, secret, activate_untested: $('#rotate-untested').checked });
      if (!r.ok) { msg.textContent = r.error || 'The new credential was not activated.'; return; }
      closeDialogs();
      await refresh(true);
      toastOk(r.tested ? 'New key tested and activated.' : 'New key activated (not tested).', 'Remember to revoke the old key in the provider’s dashboard.');
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false; btn.setAttribute('aria-busy', 'false');
      $('#rotate-secret').value = '';
    }
  }

  function openDelete(id) {
    const i = S.integrations.find((x) => x.id === id);
    if (!i) return;
    S.editing = i;
    $('#del-form').reset();
    $('#del-msg').textContent = '';
    $('#del-name').textContent = i.name;
    $('#del-slug').textContent = i.slug;
    openDialog('del-dialog');
  }
  async function submitDelete(e) {
    e.preventDefault();
    const i = S.editing; if (!i) return;
    if ($('#del-confirm').value.trim() !== i.slug) { $('#del-msg').textContent = `Type ${i.slug} to confirm.`; return; }
    const btn = $('#del-save'); btn.disabled = true;
    try {
      await invoke({ action: 'delete', id: i.id, confirm: i.slug });
      closeDialogs();
      await refresh(true);
      toastOk(`“${i.name}” deleted.`, 'Its stored credential was removed from the Vault.');
    } catch (err) { $('#del-msg').textContent = err.message; }
    btn.disabled = false;
  }

  function showSecret(title, value, help) {
    $('#secret-title').textContent = title;
    $('#secret-value').textContent = value;
    $('#secret-help').innerHTML = help;
    $('#secret-copied').textContent = '';
    openDialog('secret-dialog');
  }

  /* callbacks */
  function editHook(id) {
    const h = S.hooks.find((x) => x.id === id);
    $('#hook-id').value = h ? h.id : '';
    $('#hook-name').value = h ? h.name : '';
    $('#hook-url').value = h ? h.url : '';
    $$('#hook-form [name=hook-event]').forEach((c) => { c.checked = h ? (h.events || []).includes(c.value) : true; });
    $('#hook-enabled').checked = h ? h.enabled : true;
    $('#hook-save').textContent = h ? 'Update callback' : 'Save callback';
    $('#hook-cancel').hidden = !h;
    $('#hook-msg').textContent = '';
    $('#hook-msg').className = 'form-msg';
    $('#hook-url').focus();
  }

  async function validateHook() {
    const msg = $('#hook-msg');
    const url = $('#hook-url').value.trim();
    if (!url) { msg.className = 'form-msg is-bad'; msg.textContent = 'Enter the callback URL.'; return; }
    msg.className = 'form-msg'; msg.textContent = 'Checking…';
    try {
      const r = await invoke({ action: 'validate_url', url });
      msg.className = 'form-msg is-ok'; msg.textContent = r.message;
    } catch (e) { msg.className = 'form-msg is-bad'; msg.textContent = e.message; }
  }

  async function submitHook(e) {
    e.preventDefault();
    const msg = $('#hook-msg');
    const events = $$('#hook-form [name=hook-event]:checked').map((c) => c.value);
    const body = { action: 'save_webhook', id: $('#hook-id').value || undefined, name: $('#hook-name').value.trim() || 'Callback', url: $('#hook-url').value.trim(), events, enabled: $('#hook-enabled').checked };
    if (!body.url) { msg.className = 'form-msg is-bad'; msg.textContent = 'Enter the callback URL.'; return; }
    if (!events.length) { msg.className = 'form-msg is-bad'; msg.textContent = 'Choose at least one event.'; return; }
    const btn = $('#hook-save'); btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    msg.className = 'form-msg'; msg.textContent = '';
    try {
      const r = await invoke(body);
      editHook(null);
      await refresh(true);
      if (r.signing_secret) {
        showSecret('Callback saved - copy the signing secret', r.signing_secret,
          'Use it on your server to verify the <span class="mono">X-Ikris-Signature</span> header. It is shown <b>only once</b>.');
      } else toastOk('Callback updated.');
    } catch (err) { msg.className = 'form-msg is-bad'; msg.textContent = err.message; }
    btn.disabled = false; btn.setAttribute('aria-busy', 'false');
  }

  async function testHook(id) {
    S.busy.add(id); renderHooks();
    try {
      const r = await invoke({ action: 'test_webhook', id });
      if (r.delivered) toastOk(`Test event delivered - your server answered HTTP ${r.status}.`, `${r.ms} ms`);
      else toastErr(`Test event NOT delivered: ${r.error || 'no answer'}${r.status ? ` (HTTP ${r.status})` : ''}`);
    } catch (e) { toastErr(e.message); }
    S.busy.delete(id);
    await refresh(true);
  }

  async function newHookSecret(id) {
    if (!window.confirm('Create a new signing secret? Your server must switch to the new secret, otherwise it will reject events.')) return;
    try {
      const r = await invoke({ action: 'regenerate_webhook_secret', id });
      await refresh(true);
      showSecret('New signing secret', r.signing_secret, 'Update your server with this secret. It is shown <b>only once</b>.');
    } catch (e) { toastErr(e.message); }
  }

  async function deleteHook(id) {
    const h = S.hooks.find((x) => x.id === id);
    if (!h || !window.confirm(`Delete the callback “${h.name}”? Events will stop being sent to ${h.url}.`)) return;
    try { await invoke({ action: 'delete_webhook', id }); toastOk('Callback deleted.'); } catch (e) { toastErr(e.message); }
    await refresh(true);
  }

  async function retryHooks() {
    try { const r = await invoke({ action: 'retry_deliveries' }); toastOk(`Retried ${r.processed} delivery(ies).`); } catch (e) { toastErr(e.message); }
    await refresh(true);
  }

  /* project keys */
  async function createKey(e) {
    e.preventDefault();
    const msg = $('#key-msg');
    const allowed = $$('#key-allowed input:checked').map((c) => c.value);
    const name = $('#key-name').value.trim();
    if (!name) { msg.textContent = 'Name the project that will use this key.'; return; }
    if (!allowed.length) { msg.textContent = 'Choose at least one integration.'; return; }
    const btn = $('#key-create'); btn.disabled = true; msg.textContent = '';
    try {
      const r = await invoke({ action: 'create_client_key', name, allowed, expires_days: Number($('#key-expiry').value) });
      $('#key-form').reset();
      await refresh(true);
      showSecret(`API key for “${name}”`, r.key,
        `Send it in the <span class="mono">x-ikris-key</span> header. Only a SHA-256 hash is stored, so it is shown <b>only once</b>. Keep it on the server side of the other project - never in a web page.`);
    } catch (err) { msg.textContent = err.message; }
    btn.disabled = false;
  }
  async function revokeKey(id) {
    const k = S.keys.find((x) => x.id === id);
    if (!k || !window.confirm(`Revoke the key “${k.name}” (${k.key_prefix}…)? Requests using it will be refused immediately.`)) return;
    try { await invoke({ action: 'revoke_client_key', id }); toastOk('Key revoked.'); } catch (e) { toastErr(e.message); }
    await refresh(true);
  }

  /* ---------------- usage tab ---------------- */
  function usageRange() {
    const v = $('#usage-range').value;
    const to = new Date();
    if (v === 'custom') {
      const f = $('#usage-from').value, t = $('#usage-to').value;
      const from = f ? new Date(`${f}T00:00:00`) : new Date(Date.now() - 7 * 86400000);
      const end = t ? new Date(new Date(`${t}T00:00:00`).getTime() + 86400000) : to;
      return { from, to: end };
    }
    const hours = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 }[v] || 168;
    return { from: new Date(Date.now() - hours * 3600000), to };
  }

  async function loadUsage() {
    const { from, to } = usageRange();
    const integ = $('#usage-integ').value || null;
    const ok = $('#usage-ok').value === '' ? null : $('#usage-ok').value === 'ok';
    const endpoint = $('#usage-endpoint').value || null;
    $('#usage-kpis').innerHTML = '<div class="cmp-empty"><span class="spinner" aria-hidden="true"></span> Loading…</div>';
    try {
      const c = client();
      let q = c.from('integration_metrics').select('id,integration,endpoint,method,status_code,ok,duration_ms,error,source,created_at')
        .gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).order('id', { ascending: false }).limit(50);
      if (integ) q = q.eq('integration', integ);
      if (ok !== null) q = q.eq('ok', ok);
      if (endpoint) q = q.eq('endpoint', endpoint);
      let qe = c.from('integration_metrics').select('id,integration,endpoint,status_code,error,source,created_at')
        .eq('ok', false).gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).order('id', { ascending: false }).limit(15);
      if (integ) qe = qe.eq('integration', integ);
      const [u, r, e] = await Promise.all([
        c.rpc('integration_usage', { p_from: from.toISOString(), p_to: to.toISOString(), p_integration: integ, p_ok: ok, p_endpoint: endpoint }),
        q, qe
      ]);
      const err = [u, r, e].find((x) => x.error);
      if (err) throw err.error;
      S.usage = u.data; S.recent = r.data || []; S.errors = e.data || [];
      renderUsage();
    } catch (err) {
      $('#usage-kpis').innerHTML = `<div class="cmp-empty">Could not load usage: ${esc(err.message || '')}</div>`;
    }
  }

  function bars(rows, labelKey, valueKey, extra) {
    const max = Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0));
    return rows.map((r) => `<div class="ubar"><span class="ubar__label">${esc(r[labelKey])}</span><span class="ubar__track"><span class="ubar__fill${extra ? ' ' + extra(r) : ''}" style="width:${Math.max(2, (Number(r[valueKey]) / max) * 100)}%"></span></span><span class="ubar__val">${num(r[valueKey])}</span></div>`).join('');
  }

  function renderUsage() {
    const u = S.usage || {};
    const total = Number(u.total || 0);
    const rate = total ? Math.round((Number(u.ok || 0) / total) * 1000) / 10 : null;
    const tiles = [
      ['Total requests', num(total), 'Recorded by Ikris (locally observed)'],
      ['Successful', num(u.ok), ''],
      ['Failed', num(u.failed), ''],
      ['Success rate', rate === null ? '—' : `${rate}%`, ''],
      ['Avg response time', u.avg_ms ? `${num(u.avg_ms)} ms` : '—', '']
    ];
    $('#usage-kpis').innerHTML = tiles.map(([l, v, s]) => `<div class="kpi"><p class="kpi__label">${esc(l)}</p><p class="kpi__value">${esc(v)}</p>${s ? `<p class="kpi__sub">${esc(s)}</p>` : ''}</div>`).join('');

    // endpoint filter options (keep selection)
    const sel = $('#usage-endpoint'); const cur = sel.value;
    sel.innerHTML = '<option value="">All endpoints</option>' + (u.endpoints || []).sort().map((e) => `<option value="${esc(e)}"${e === cur ? ' selected' : ''}>${esc(e)}</option>`).join('');

    const nameOf = (slug) => (slug === 'callback' ? 'Callback URLs (outgoing events)' : (S.integrations.find((i) => i.slug === slug) || {}).name || slug);
    const prov = u.by_integration || [];
    $('#usage-providers').innerHTML = prov.length ? `<table class="table"><thead><tr><th>Integration</th><th class="num">Requests</th><th class="num">OK</th><th class="num">Failed</th><th class="num">Avg ms</th></tr></thead><tbody>${prov.map((p) => `<tr><td>${esc(nameOf(p.integration))}</td><td class="num">${num(p.total)}</td><td class="num">${num(p.ok)}</td><td class="num ${p.failed ? 'is-bad' : ''}">${num(p.failed)}</td><td class="num">${p.avg_ms ? num(p.avg_ms) : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="cmp-empty small">No requests in this period.</div>';

    const sc = u.by_status || [];
    $('#usage-status').innerHTML = sc.length ? bars(sc, 'code', 'count', (r) => (/^2/.test(r.code) ? 'is-ok' : /^[45]/.test(r.code) || r.code === 'no response' ? 'is-bad' : '')) : '<div class="cmp-empty small">No data.</div>';

    const days = (u.by_day || []).map((d) => ({ ...d, total: Number(d.ok) + Number(d.failed) }));
    $('#usage-days').innerHTML = days.length ? bars(days.map((d) => ({ ...d, label: new Date(d.day).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) })), 'label', 'total', (r) => (r.failed ? 'is-mixed' : 'is-ok')) : '<div class="cmp-empty small">No data.</div>';

    const w = u.webhooks || {};
    $('#usage-hooks').innerHTML = [['Events', w.total], ['Delivered', w.delivered], ['Failed', w.failed], ['Waiting for retry', w.pending], ['Test events', w.tests]]
      .map(([l, v]) => `<div class="mini-stat"><b>${num(v)}</b><span>${esc(l)}</span></div>`).join('');

    const or = S.integrations.find((i) => i.slug === 'openrouter');
    const d = or && or.last_test && or.last_test.details;
    $('#usage-reported').innerHTML = d
      ? `<p class="muted small">OpenRouter (reported by the provider at the last connection test, ${esc(ago(or.last_tested_at))}):</p><div class="mini-stats">${[['Total', d.provider_usage_usd], ['Today', d.usage_today_usd], ['This month', d.usage_month_usd], ['Credit limit', d.credit_limit_usd], ['Remaining', d.limit_remaining_usd]].map(([l, v]) => `<div class="mini-stat"><b>${esc(usd(v))}</b><span>${esc(l)}</span></div>`).join('')}</div>`
      : '<p class="muted small">Run “Test connection” on OpenRouter to fetch the provider-reported spend.</p>';

    $('#usage-recent').innerHTML = S.recent.length ? S.recent.map((m) => `<tr><td>${esc(dateTime(m.created_at))}</td><td>${esc(nameOf(m.integration))}</td><td class="mono small">${esc(m.endpoint || '—')}</td><td>${esc(m.source || '')}</td><td class="num">${m.status_code ? esc(m.status_code) : '—'}</td><td class="num">${m.duration_ms ? num(m.duration_ms) : '—'}</td><td><span class="integ-status integ-status--${m.ok ? 'ok' : 'bad'}"><i aria-hidden="true"></i>${m.ok ? 'OK' : 'Failed'}</span></td></tr>`).join('')
      : '<tr><td colspan="7" class="muted small">No requests match these filters.</td></tr>';
    $('#usage-errors').innerHTML = S.errors.length ? S.errors.map((m) => `<li><span class="mono small">${esc(dateTime(m.created_at))}</span> <b>${esc(nameOf(m.integration))}</b> <span class="mono small">${esc(m.endpoint || '')}</span>${m.status_code ? ` · HTTP ${esc(m.status_code)}` : ''}<div class="muted small">${esc(m.error || 'No details')}</div></li>`).join('')
      : '<li class="muted small">No errors in this period. 🎉</li>';
  }

  function fillUsageFilters() {
    const sel = $('#usage-integ'); const cur = sel.value;
    sel.innerHTML = '<option value="">All integrations</option>' + S.integrations.map((i) => `<option value="${esc(i.slug)}"${i.slug === cur ? ' selected' : ''}>${esc(i.name)}</option>`).join('') + `<option value="callback"${cur === 'callback' ? ' selected' : ''}>Callback URLs</option>`;
  }

  /* ---------------- tabs / access ---------------- */
  function renderTab() {
    $$('[data-integ-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.integTab === S.tab)));
    $$('[data-integ-panel]').forEach((p) => { p.hidden = p.dataset.integPanel !== S.tab; });
    $('#integ-add').hidden = S.tab !== 'setup';
    if (S.tab === 'usage') { fillUsageFilters(); loadUsage(); }
  }

  function applyAccess() {
    $$('[data-nav="integrations"]').forEach((el) => { el.hidden = !S.admin; });
    $('#integ-noaccess').hidden = S.admin || !S.checked;
    $('#integ-body').hidden = !S.admin;
  }

  /* ---------------- events ---------------- */
  function bind() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('[data-view="integrations"], .integ-modal')) return;
      const tab = e.target.closest('[data-integ-tab]');
      if (tab) { S.tab = tab.dataset.integTab; renderTab(); return; }
      if (e.target.closest('#integ-add')) { openIntegDialog(null); return; }
      let el;
      if ((el = e.target.closest('[data-integ-test]'))) return void testInteg(el.dataset.integTest);
      if ((el = e.target.closest('[data-integ-edit]'))) return void openIntegDialog(el.dataset.integEdit);
      if ((el = e.target.closest('[data-integ-rotate]'))) return void openRotate(el.dataset.integRotate);
      if ((el = e.target.closest('[data-integ-delete]'))) return void openDelete(el.dataset.integDelete);
      if ((el = e.target.closest('[data-hook-test]'))) return void testHook(el.dataset.hookTest);
      if ((el = e.target.closest('[data-hook-edit]'))) return void editHook(el.dataset.hookEdit);
      if ((el = e.target.closest('[data-hook-secret]'))) return void newHookSecret(el.dataset.hookSecret);
      if ((el = e.target.closest('[data-hook-delete]'))) return void deleteHook(el.dataset.hookDelete);
      if ((el = e.target.closest('[data-key-revoke]'))) return void revokeKey(el.dataset.keyRevoke);
      if (e.target.closest('#hook-validate')) return void validateHook();
      if (e.target.closest('#hook-cancel')) return void editHook(null);
      if (e.target.closest('#hook-retry')) return void retryHooks();
      if (e.target.closest('#usage-refresh')) return void loadUsage();
      if (e.target.closest('[data-integ-close]')) return void closeDialogs();
      if (e.target.closest('#integ-secret-reveal')) {
        const inp = $('#integ-secret'); inp.type = inp.type === 'password' ? 'text' : 'password';
        e.target.closest('#integ-secret-reveal').setAttribute('aria-pressed', String(inp.type === 'text'));
        return;
      }
      if (e.target.closest('#secret-copy')) {
        const v = $('#secret-value').textContent;
        navigator.clipboard.writeText(v).then(() => { $('#secret-copied').textContent = 'Copied.'; }, () => { $('#secret-copied').textContent = 'Copy failed - select the text and copy it manually.'; });
      }
    });
    $('#integ-scrim').addEventListener('click', closeDialogs);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#integ-scrim').hidden) closeDialogs(); });
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-integ-toggle]')) toggleInteg(t.dataset.integToggle, t.checked);
      if (t.id === 'integ-provider') applyPreset(!S.editing);
      if (t.id === 'integ-auth') syncAuthFields();
      if (t.id === 'usage-range') { $('#usage-custom').hidden = t.value !== 'custom'; if (t.value !== 'custom') loadUsage(); }
      if (['usage-integ', 'usage-ok', 'usage-endpoint', 'usage-from', 'usage-to'].includes(t.id)) loadUsage();
    });
    $('#integ-search').addEventListener('input', debounce((e) => { S.q = e.target.value.trim(); renderSetup(); }, 150));
    $('#integ-form').addEventListener('submit', submitInteg);
    $('#rotate-form').addEventListener('submit', submitRotate);
    $('#del-form').addEventListener('submit', submitDelete);
    $('#hook-form').addEventListener('submit', submitHook);
    $('#key-form').addEventListener('submit', createKey);
  }

  /* ---------------- public API ---------------- */
  function init(context) { ctx = context; bind(); }

  async function start(user) {
    S = fresh();
    S.user = user;
    try {
      const { data } = await client().from('chat_staff').select('role').eq('email', String(user.email || '').toLowerCase()).maybeSingle();
      S.admin = !!data && data.role === 'admin';
    } catch (_) { S.admin = false; }
    S.checked = true;
    applyAccess();
    if (S.admin && ctx.isViewing('integrations')) { renderTab(); refresh(false); }
  }
  function stop() {
    closeDialogs();
    S = fresh();
    applyAccess();
    ['#integ-list', '#hook-list', '#key-list', '#integ-audit', '#usage-kpis', '#usage-recent', '#usage-errors'].forEach((s) => { const el = $(s); if (el) el.innerHTML = ''; });
  }
  function onShow() {
    applyAccess();
    if (!S.admin) return;
    renderTab();
    refresh(false);
  }
  return { init, start, stop, onShow };
})();
