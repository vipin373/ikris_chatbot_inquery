/* =====================================================================
   IKRIS PHARMA NETWORK — WhatsApp templates & campaigns
   ---------------------------------------------------------------------
   • Templates: created here, submitted to Meta for approval (via the
     "wa-campaigns" edge function → n8n → WhatsApp Cloud API).
   • Campaigns: send an approved template to many chat contacts.
     Admin: any contact. Department users: their own department's chats
     (enforced again on the server).
   • Chat: "Send template" re-opens conversations older than 24 hours.
   Reads use Row Level Security; all writes go through the edge function.
   ===================================================================== */
window.IkrisCampaigns = (function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const num = (n) => Number(n || 0).toLocaleString('en-IN');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const phoneLabel = (p) => (p ? `+${String(p).replace(/\D/g, '')}` : '');
  const dateTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const countVars = (t) => {
    const nums = [...String(t || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
    return nums.length ? Math.max(...nums) : 0;
  };

  const VAR_SOURCES = [
    ['name', 'Customer name'],
    ['text', 'Fixed text'],
    ['inquiry', 'Inquiry ID'],
    ['agent', 'Your name']
  ];
  const MEDIA_RULES = {
    IMAGE: { types: ['image/jpeg', 'image/png'], max: 5 * 1024 * 1024, accept: 'image/jpeg,image/png', label: 'JPG or PNG image, up to 5 MB', noun: 'image' },
    VIDEO: { types: ['video/mp4', 'video/3gpp'], max: 16 * 1024 * 1024, accept: 'video/mp4,video/3gpp', label: 'MP4 video, up to 16 MB', noun: 'video' },
    DOCUMENT: { types: ['application/pdf'], max: 100 * 1024 * 1024, accept: 'application/pdf', label: 'PDF document, up to 100 MB', noun: 'PDF' }
  };
  const isMediaFormat = (f) => !!MEDIA_RULES[String(f || '').toUpperCase()];
  const fileSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const STATUS_LABEL = { APPROVED: 'Approved', PENDING: 'In review', IN_APPEAL: 'In appeal', REJECTED: 'Rejected', PAUSED: 'Paused', DISABLED: 'Disabled', PENDING_DELETION: 'Deleting' };

  let ctx = null;
  const fresh = () => ({
    user: null, loaded: false, error: null,
    templates: [], campaigns: [], stats: new Map(),
    tab: 'campaigns', q: '', tplQ: '', syncing: false, channel: null, poll: null,
    send: null, tplButtons: [], confirmArmed: false,
    tplHeader: 'NONE', tplMedia: null
  });
  let S = fresh();

  const client = () => ctx.client();
  const chat = () => window.IkrisChat;
  const me = () => (chat() && chat().me()) || null;
  const isAdmin = () => !!(chat() && chat().isAdmin());

  async function invoke(body) {
    const { data, error } = await client().functions.invoke('wa-campaigns', { body });
    if (error) {
      let msg = 'The request could not be completed. Please try again.';
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) { /* keep default */ }
      throw new Error(msg);
    }
    if (data && data.ok === false && data.error && !('sent' in data)) throw new Error(data.error);
    return data;
  }

  /* Upload a header file to the public wa-media bucket (folder: templates/ or campaigns/). */
  async function uploadMedia(folder, file, format) {
    const rule = MEDIA_RULES[format];
    if (!rule) throw new Error('Choose a header type first.');
    if (!rule.types.includes(file.type)) throw new Error(`This file type is not allowed. Use a ${rule.label}.`);
    if (file.size > rule.max) throw new Error(`The file is too large (${fileSize(file.size)}). Use a ${rule.label}.`);
    const safe = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'file';
    const id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    const path = `${folder}/${id}-${safe}`;
    const store = client().storage.from('wa-media');
    const { error } = await store.upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
    if (error) throw new Error(error.message || 'The file could not be uploaded.');
    const url = store.getPublicUrl(path).data.publicUrl;
    return { path, url, type: file.type, size: file.size, name: file.name };
  }

  /* ---------------- data ---------------- */
  async function loadTemplates() {
    const { data, error } = await client().from('wa_templates').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    S.templates = data || [];
  }

  async function loadCampaigns() {
    const [c, st] = await Promise.all([
      client().from('campaigns').select('*').order('created_at', { ascending: false }).limit(300),
      client().rpc('campaign_stats')
    ]);
    if (c.error) throw c.error;
    S.campaigns = c.data || [];
    S.stats = new Map((st.data || []).map((r) => [r.campaign_id, r]));
  }

  async function sync(silent) {
    if (S.syncing) return;
    S.syncing = true;
    renderTemplates();
    try {
      await invoke({ action: 'sync_templates' });
      await loadTemplates();
      if (!silent) ctx.toast({ type: 'success', title: 'Templates refreshed from WhatsApp.', timeout: 3000 });
    } catch (e) {
      if (!silent) ctx.toast({ type: 'error', title: e.message, timeout: 6000 });
    } finally {
      S.syncing = false;
      renderTemplates();
    }
  }

  function subscribe() {
    const sb = client();
    if (S.channel) sb.removeChannel(S.channel);
    S.channel = sb.channel('ikris-campaigns')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, () => refreshCampaignsSoon())
      .subscribe();
  }
  const refreshCampaignsSoon = debounce(async () => {
    if (!S.user) return;
    try { await loadCampaigns(); renderCampaigns(); renderStats(); } catch (_) { /* keep current */ }
  }, 600);

  /* ---------------- rendering: page ---------------- */
  function renderAll() {
    const noAccess = S.loaded && !me();
    $('#cmp-noaccess').hidden = !noAccess;
    $$('.view--campaigns .cmp-head, .view--campaigns .cmp-panel').forEach((el) => { el.style.display = noAccess ? 'none' : ''; });
    $$('[data-cmp-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.cmpTab === S.tab)));
    $$('[data-cmp-panel]').forEach((p) => { p.hidden = p.dataset.cmpPanel !== S.tab; });
    renderStats();
    renderCampaigns();
    renderTemplates();
  }

  function sumStats(list) {
    const t = { total: 0, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0 };
    list.forEach((c) => {
      const s = S.stats.get(c.id);
      if (!s) return;
      for (const k of Object.keys(t)) t[k] += s[k] || 0;
    });
    return t;
  }

  function statTiles(t) {
    const tiles = [
      ['Sent', t.sent, `of ${num(t.total)} contacts`, 'sent'],
      ['Delivered', t.delivered, pct(t.delivered, t.sent) + ' of sent', 'delivered'],
      ['Read', t.read, pct(t.read, t.delivered) + ' of delivered', 'read'],
      ['Replied', t.replied, pct(t.replied, t.delivered) + ' of delivered', 'replied'],
      ['Failed', t.failed, pct(t.failed, t.total) + ' of contacts', 'failed']
    ];
    return tiles.map(([label, v, sub, cls]) => `
      <div class="cmp-stat cmp-stat--${cls}">
        <span class="cmp-stat__label">${label}</span>
        <span class="cmp-stat__value">${num(v)}</span>
        <span class="cmp-stat__sub">${esc(sub)}</span>
      </div>`).join('');
  }

  function renderStats() {
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const recent = S.campaigns.filter((c) => new Date(c.created_at).getTime() >= since);
    $('#cmp-stats').innerHTML = S.loaded ? statTiles(sumStats(recent)) : '<div class="cmp-loading"><span class="spinner" aria-hidden="true"></span> Loading…</div>';
    $('#cmp-overview-sub').textContent = `Last 30 days · ${recent.length} campaign${recent.length === 1 ? '' : 's'}${isAdmin() ? ' · all departments' : ''}`;
  }

  function campaignBadge(c) {
    if (c.status === 'sending') return `<span class="cmp-badge cmp-badge--sending"><span class="spinner spinner--xs" aria-hidden="true"></span>Sending ${num((c.sent || 0) + (c.failed || 0))}/${num(c.total)}</span>`;
    if (c.status === 'failed') return '<span class="cmp-badge cmp-badge--failed">Failed</span>';
    return '<span class="cmp-badge cmp-badge--done">Complete</span>';
  }

  function renderCampaigns() {
    const q = S.q.toLowerCase();
    const list = S.campaigns.filter((c) => !q || `${c.name} ${c.template_name} ${c.created_by_name || ''} ${c.department || ''}`.toLowerCase().includes(q));
    $('#cmp-count').textContent = S.loaded ? `${list.length} campaign${list.length === 1 ? '' : 's'}` : '';
    const body = $('#cmp-rows');
    if (!S.loaded) { body.innerHTML = '<tr><td colspan="11" class="cmp-empty"><span class="spinner" aria-hidden="true"></span> Loading campaigns…</td></tr>'; return; }
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="11" class="cmp-empty">${S.campaigns.length ? 'No campaigns match your search.' : '<strong>No campaigns yet</strong><span>Create a template, wait for Meta to approve it, then click <b>Create Campaign</b>.</span>'}</td></tr>`;
      return;
    }
    body.innerHTML = list.map((c) => {
      const s = S.stats.get(c.id) || {};
      return `<tr data-cmp="${esc(c.id)}" tabindex="0">
        <td><b>${esc(c.name)}</b>${c.department ? `<div class="muted small">${esc(c.department)}</div>` : ''}</td>
        <td class="mono small">${esc(c.template_name)}</td>
        <td>${esc(c.created_by_name || c.created_by)}</td>
        <td class="small">${esc(dateTime(c.created_at))}</td>
        <td class="num">${num(c.total)}</td>
        <td class="num">${num(s.sent)}</td>
        <td class="num">${num(s.delivered)}</td>
        <td class="num">${num(s.read)}</td>
        <td class="num">${num(s.replied)}</td>
        <td class="num${s.failed ? ' is-bad' : ''}">${num(s.failed)}</td>
        <td>${campaignBadge(c)}</td>
      </tr>`;
    }).join('');
  }

  function waFormat(text) {
    return esc(text)
      .replace(/\{\{\s*(\d+)\s*\}\}/g, '<span class="wa-var">{{$1}}</span>')
      .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>')
      .replace(/~([^~\n]+)~/g, '<s>$1</s>')
      .replace(/\n/g, '<br>');
  }

  function mediaHtml(m) {
    if (!m || !m.format) return '';
    const f = m.format;
    if (f === 'IMAGE' && m.url) return `<div class="wa-bubble__media"><img src="${esc(m.url)}" alt="Header image" loading="lazy"></div>`;
    if (f === 'VIDEO' && m.url) return `<div class="wa-bubble__media wa-bubble__media--video"><video src="${esc(m.url)}" muted preload="metadata"></video><span class="wa-play" aria-hidden="true">▶</span></div>`;
    if (f === 'DOCUMENT') return `<div class="wa-bubble__doc"><span class="wa-doc-ico" aria-hidden="true">PDF</span><span>${esc(m.name || 'Document')}</span></div>`;
    return `<div class="wa-bubble__media wa-bubble__media--empty"><span>${f === 'VIDEO' ? 'Video' : 'Image'} header</span></div>`;
  }

  function bubbleHtml({ header, body, footer, buttons, media }) {
    return `${mediaHtml(media)}${header ? `<div class="wa-bubble__head">${waFormat(header)}</div>` : ''}
      <div class="wa-bubble__body">${body ? waFormat(body) : '<span class="muted">Your message will appear here.</span>'}</div>
      ${footer ? `<div class="wa-bubble__foot">${esc(footer)}</div>` : ''}
      <div class="wa-bubble__time">${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>
      ${(buttons || []).length ? `<div class="wa-bubble__btns">${buttons.map((b) => `<span>${b.type === 'URL' ? '↗ ' : b.type === 'PHONE_NUMBER' ? '☎ ' : '↩ '}${esc(b.text || 'Button')}</span>`).join('')}</div>` : ''}`;
  }

  const tplParts = (t) => {
    const comps = Array.isArray(t.components) ? t.components : [];
    const btns = (comps.find((c) => c.type === 'BUTTONS') || {}).buttons || [];
    const f = String(t.header_format || '').toUpperCase();
    const media = isMediaFormat(f) ? { format: f, url: t.header_media_url || '', name: t.header_media_name || '' } : null;
    return { header: f === 'TEXT' ? (t.header_text || '') : '', body: t.body_text || '', footer: t.footer_text || '', buttons: btns, media };
  };

  function renderTemplates() {
    const n = S.templates.length;
    $('#cmp-tpl-count').textContent = n ? String(n) : '';
    const latest = S.templates.reduce((a, t) => (t.synced_at && t.synced_at > a ? t.synced_at : a), '');
    $('#tpl-synced').textContent = S.syncing ? 'Refreshing…' : latest ? `Updated ${dateTime(latest)}` : '';
    $('#tpl-refresh').disabled = S.syncing;
    const q = S.tplQ.toLowerCase();
    const list = S.templates.filter((t) => !q || `${t.name} ${t.body_text || ''} ${t.category || ''}`.toLowerCase().includes(q));
    const grid = $('#tpl-grid');
    if (!S.loaded) { grid.innerHTML = '<div class="cmp-empty"><span class="spinner" aria-hidden="true"></span> Loading templates…</div>'; return; }
    if (!list.length) {
      grid.innerHTML = `<div class="cmp-empty">${n ? 'No templates match your search.' : '<strong>No templates yet</strong><span>Click <b>New Template</b> to create one and submit it to Meta.</span>'}</div>`;
      return;
    }
    const mine = (me() && me().email || '').toLowerCase();
    grid.innerHTML = list.map((t) => {
      const st = String(t.status || '').toUpperCase();
      const canDelete = isAdmin() || (t.created_by && t.created_by.toLowerCase() === mine);
      return `<article class="tpl-card">
        <header class="tpl-card__head">
          <div><h3 class="mono">${esc(t.name)}</h3>
            <p class="muted small">${esc(t.category ? t.category[0] + t.category.slice(1).toLowerCase() : '')} · ${esc(t.language)}${t.created_by_name ? ` · by ${esc(t.created_by_name)}` : ''}</p></div>
          <span class="tpl-status tpl-status--${esc(st.toLowerCase())}">${esc(STATUS_LABEL[st] || st || 'Unknown')}</span>
        </header>
        <div class="wa-bubble wa-bubble--card">${bubbleHtml(tplParts(t))}</div>
        ${t.rejected_reason ? `<p class="tpl-card__reason">Rejected: ${esc(String(t.rejected_reason).replace(/_/g, ' ').toLowerCase())}</p>` : ''}
        ${st === 'APPROVED' && !t.sendable ? '<p class="tpl-card__reason">Has a dynamic button — send it from Meta/Cunnekt instead.</p>' : ''}
        <footer class="tpl-card__foot">
          ${st === 'APPROVED' && t.sendable ? `<button type="button" class="btn btn--wa btn--sm" data-tpl-use="${esc(t.name)}|${esc(t.language)}">Use in campaign</button>` : ''}
          ${canDelete ? `<button type="button" class="icon-btn" data-tpl-delete="${esc(t.name)}" aria-label="Delete template ${esc(t.name)}" title="Delete"><svg aria-hidden="true"><use href="#i-trash"/></svg></button>` : ''}
        </footer>
      </article>`;
    }).join('');
  }

  /* ---------------- dialogs (shared) ---------------- */
  function openDialog(id) {
    $$('#tpl-dialog, #send-dialog, #cmp-detail').forEach((d) => { d.hidden = d.id !== id; });
    $('#cmp-scrim').hidden = false;
    const first = $(`#${id} input:not([type=hidden]), #${id} select, #${id} textarea`);
    if (first) setTimeout(() => first.focus(), 40);
  }
  function closeDialogs() {
    $$('#tpl-dialog, #send-dialog, #cmp-detail').forEach((d) => { d.hidden = true; });
    $('#cmp-scrim').hidden = true;
    S.send = null;
    S.confirmArmed = false;
  }

  /* ---------------- new template ---------------- */
  function openTemplateDialog() {
    $('#tpl-form').reset();
    S.tplButtons = [];
    S.tplMedia = null;
    setHeaderType('NONE');
    $('#tpl-msg').textContent = '';
    renderTplExamples();
    renderTplButtons();
    renderTplPreview();
    openDialog('tpl-dialog');
  }

  function setHeaderType(type) {
    S.tplHeader = type;
    $$('#tpl-header-type [data-htype]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.htype === type)));
    $('#tpl-header').hidden = type !== 'TEXT';
    const rule = MEDIA_RULES[type];
    $('#tpl-media').hidden = !rule;
    if (rule) {
      if (S.tplMedia && S.tplMedia.format !== type) S.tplMedia = null;
      $('#tpl-media-file').accept = rule.accept;
      $('#tpl-media-label').innerHTML = `<b>Choose ${rule.noun}</b> or drag it here`;
      $('#tpl-media-rule').textContent = rule.label;
    }
    renderTplMedia();
    renderTplPreview();
  }

  function renderTplMedia() {
    const m = S.tplMedia;
    const info = $('#tpl-media-info');
    $('#tpl-media-drop').hidden = !!m;
    info.hidden = !m;
    if (!m) { info.innerHTML = ''; return; }
    info.innerHTML = m.uploading
      ? `<span class="spinner" aria-hidden="true"></span><span class="media-file__name">${esc(m.name)}</span><span class="muted small">Uploading…</span>`
      : `<svg aria-hidden="true" class="media-file__ok"><use href="#i-check"/></svg><span class="media-file__name">${esc(m.name)}</span><span class="muted small">${fileSize(m.size)}</span><button type="button" class="btn btn--ghost btn--sm" data-tpl-media-change>Change</button><button type="button" class="icon-btn" data-tpl-media-remove aria-label="Remove file" title="Remove"><svg aria-hidden="true"><use href="#i-close"/></svg></button>`;
  }

  async function pickTplMedia(file) {
    if (!file) return;
    const format = S.tplHeader;
    const msg = $('#tpl-msg');
    msg.textContent = '';
    const local = format === 'IMAGE' ? URL.createObjectURL(file) : '';
    S.tplMedia = { format, name: file.name, size: file.size, uploading: true, url: local };
    renderTplMedia(); renderTplPreview();
    try {
      const up = await uploadMedia('templates', file, format);
      if (S.tplHeader !== format) return;
      S.tplMedia = { ...up, format, url: up.url, uploading: false };
      ctx.toast({ type: 'success', title: 'File uploaded.', timeout: 2500 });
    } catch (err) {
      S.tplMedia = null;
      msg.textContent = err.message;
      ctx.toast({ type: 'error', title: err.message, timeout: 6000 });
    } finally {
      $('#tpl-media-file').value = '';
      renderTplMedia(); renderTplPreview();
    }
  }

  function renderTplExamples() {
    const n = countVars($('#tpl-body').value);
    const box = $('#tpl-examples');
    const prev = $$('input', box).map((i) => i.value);
    box.innerHTML = n ? `<p class="send-label">Example values for Meta's review</p>` + Array.from({ length: n }, (_, i) => `
      <div class="var-row"><span class="var-chip">{{${i + 1}}}</span><input data-tpl-example="${i}" value="${esc(prev[i] || (i === 0 ? 'Rahul' : ''))}" placeholder="Example for {{${i + 1}}}" autocomplete="off"></div>`).join('') : '';
    $('#tpl-body-count').textContent = String($('#tpl-body').value.length);
  }

  function renderTplButtons() {
    $('#tpl-buttons').innerHTML = S.tplButtons.map((b, i) => `
      <div class="tpl-btn-row" data-btn-row="${i}">
        <select data-btn-type aria-label="Button type">
          <option value="QUICK_REPLY"${b.type === 'QUICK_REPLY' ? ' selected' : ''}>Quick reply</option>
          <option value="URL"${b.type === 'URL' ? ' selected' : ''}>Visit website</option>
          <option value="PHONE_NUMBER"${b.type === 'PHONE_NUMBER' ? ' selected' : ''}>Call phone</option>
        </select>
        <input data-btn-text value="${esc(b.text)}" maxlength="25" placeholder="Button text" aria-label="Button text">
        ${b.type === 'URL' ? `<input data-btn-url value="${esc(b.url || '')}" placeholder="https://…" aria-label="Website link">` : ''}
        ${b.type === 'PHONE_NUMBER' ? `<input data-btn-phone value="${esc(b.phone_number || '')}" placeholder="+91…" aria-label="Phone number">` : ''}
        <button type="button" class="icon-btn" data-btn-remove aria-label="Remove button"><svg aria-hidden="true"><use href="#i-close"/></svg></button>
      </div>`).join('');
    $('#tpl-add-btn').hidden = S.tplButtons.length >= 3;
  }

  function readTplButtons() {
    S.tplButtons = $$('#tpl-buttons [data-btn-row]').map((row) => ({
      type: $('[data-btn-type]', row).value,
      text: $('[data-btn-text]', row).value,
      url: ($('[data-btn-url]', row) || {}).value,
      phone_number: ($('[data-btn-phone]', row) || {}).value
    }));
  }

  function renderTplPreview() {
    const media = MEDIA_RULES[S.tplHeader] ? { format: S.tplHeader, url: S.tplMedia && S.tplMedia.url, name: S.tplMedia && S.tplMedia.name } : null;
    $('#tpl-preview').innerHTML = bubbleHtml({
      media,
      header: S.tplHeader === 'TEXT' ? $('#tpl-header').value.trim() : '',
      body: $('#tpl-body').value,
      footer: $('#tpl-footer').value.trim(),
      buttons: S.tplButtons.filter((b) => b.text)
    });
  }

  async function submitTemplate(e) {
    e.preventDefault();
    readTplButtons();
    const msg = $('#tpl-msg');
    msg.textContent = '';
    const name = $('#tpl-name').value.trim().toLowerCase().replace(/\s+/g, '_');
    $('#tpl-name').value = name;
    const body = $('#tpl-body').value.trim();
    if (!/^[a-z0-9_]+$/.test(name)) { msg.textContent = 'Template name: use only lowercase letters, numbers and _ (e.g. enquiry_followup).'; $('#tpl-name').focus(); return; }
    if (!body) { msg.textContent = 'Write the message.'; $('#tpl-body').focus(); return; }
    if (S.templates.some((t) => t.name === name && t.language === $('#tpl-language').value)) { msg.textContent = 'A template with this name and language already exists.'; return; }
    const examples = $$('[data-tpl-example]').map((i) => i.value.trim());
    if (examples.some((x) => !x)) { msg.textContent = 'Fill in an example value for every variable.'; return; }
    const htype = S.tplHeader;
    if (htype === 'TEXT' && !$('#tpl-header').value.trim()) { msg.textContent = 'Type the header text, or choose “None”.'; $('#tpl-header').focus(); return; }
    const m = S.tplMedia;
    if (MEDIA_RULES[htype] && (!m || m.uploading || !m.path)) { msg.textContent = m && m.uploading ? 'Wait for the file to finish uploading.' : `Upload the header ${MEDIA_RULES[htype].noun}.`; return; }

    const btn = $('#tpl-submit');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    try {
      await invoke({
        action: 'create_template',
        template: {
          name, category: $('#tpl-category').value, language: $('#tpl-language').value,
          header_type: htype,
          header_text: htype === 'TEXT' ? $('#tpl-header').value.trim() : '',
          ...(MEDIA_RULES[htype] ? { media_path: m.path, media_type: m.type, media_size: m.size, media_name: m.name } : {}),
          body, footer_text: $('#tpl-footer').value.trim(),
          examples, buttons: S.tplButtons.filter((b) => b.text && b.text.trim())
        }
      });
      closeDialogs();
      await loadTemplates();
      S.tab = 'templates';
      renderAll();
      ctx.toast({ type: 'success', title: 'Template submitted to Meta for approval.', body: '<p class="muted small" style="margin-top:4px">It usually takes a few minutes. Click “Refresh from WhatsApp” to see the new status.</p>', timeout: 7000 });
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false; btn.setAttribute('aria-busy', 'false');
    }
  }

  async function deleteTemplate(name) {
    if (!window.confirm(`Delete the template “${name}” from your WhatsApp account? This cannot be undone.`)) return;
    try {
      await invoke({ action: 'delete_template', name });
      await loadTemplates();
      renderTemplates();
      ctx.toast({ type: 'success', title: `Template “${name}” deleted.`, timeout: 4000 });
    } catch (e) {
      ctx.toast({ type: 'error', title: e.message, timeout: 6000 });
    }
  }

  /* ---------------- send: campaign or single chat ---------------- */
  const approved = () => S.templates.filter((t) => String(t.status).toUpperCase() === 'APPROVED' && t.sendable);
  const selectedTemplate = () => {
    const [name, lang] = String($('#send-template').value || '').split('|');
    return S.templates.find((t) => t.name === name && t.language === lang) || null;
  };

  function openSend(opts) {
    S.send = { mode: opts.mode, conv: opts.conv || null, onSent: opts.onSent || null, selected: new Set() };
    S.confirmArmed = false;
    const chatMode = opts.mode === 'chat';
    $('#send-title').textContent = chatMode ? 'Send WhatsApp template' : 'Create Campaign';
    $('#send-name-field').hidden = chatMode;
    $('#send-audience').hidden = chatMode;
    $('#send-to').hidden = !chatMode;
    if (chatMode) $('#send-to').innerHTML = `To <b>${esc(opts.conv.customer_name || phoneLabel(opts.conv.customer_phone))}</b> <span class="muted">${esc(phoneLabel(opts.conv.customer_phone))}</span>`;
    $('#send-name').value = '';
    $('#send-msg').textContent = '';

    const list = approved();
    $('#send-template').innerHTML = list.length
      ? list.map((t) => `<option value="${esc(t.name)}|${esc(t.language)}">${esc(t.name)} · ${esc(t.language)} · ${esc((t.category || '').toLowerCase())}</option>`).join('')
      : '<option value="">No approved templates yet</option>';
    if (opts.template) $('#send-template').value = opts.template;
    $('#send-template-hint').innerHTML = list.length
      ? 'Only templates approved by Meta are listed.'
      : 'Create a template in the <b>Templates</b> tab and wait for Meta to approve it.';

    if (!chatMode) setupAudience();
    S.send.media = null;
    renderSendMedia();
    renderVars();
    renderSendPreview();
    updateSendButton();
    openDialog('send-dialog');
  }

  const sendMediaFormat = () => {
    const t = selectedTemplate();
    const f = t ? String(t.header_format || '').toUpperCase() : '';
    return MEDIA_RULES[f] ? f : '';
  };
  // The file that will go in the header: one chosen for this send, else the template's own file.
  const sendMedia = () => {
    const f = sendMediaFormat();
    if (!f || !S.send) return null;
    if (S.send.media && S.send.media.format === f) return S.send.media;
    const t = selectedTemplate();
    return t.header_media_url ? { format: f, url: t.header_media_url, name: t.header_media_name || '', isDefault: true } : { format: f, missing: true };
  };

  function renderSendMedia() {
    const box = $('#send-media');
    const f = sendMediaFormat();
    box.hidden = !f;
    if (!f) { box.innerHTML = ''; return; }
    const rule = MEDIA_RULES[f];
    const m = sendMedia();
    $('#send-media-file').accept = rule.accept;
    const thumb = m && m.url && f === 'IMAGE' ? `<img src="${esc(m.url)}" alt="" class="send-media__thumb">` : `<span class="send-media__ico" aria-hidden="true">${f === 'DOCUMENT' ? 'PDF' : f === 'VIDEO' ? '▶' : '🖼'}</span>`;
    box.innerHTML = `<p class="send-label">Header ${rule.noun}</p>
      <div class="send-media__row">
        ${m && m.uploading ? '<span class="spinner" aria-hidden="true"></span>' : thumb}
        <div class="send-media__text">
          ${m && m.missing ? `<b>No ${rule.noun} saved with this template.</b><span class="muted small">Upload a ${rule.label}.</span>`
            : `<b>${esc(m.name || (m.isDefault ? `Template ${rule.noun}` : rule.noun))}</b><span class="muted small">${m.uploading ? 'Uploading…' : m.isDefault ? 'Same file as the approved template' : 'Uploaded for this send'}</span>`}
        </div>
        <button type="button" class="btn btn--ghost btn--sm" data-send-media-change${m && m.uploading ? ' disabled' : ''}>${m && m.missing ? 'Upload' : 'Change file'}</button>
        ${S.send && S.send.media && !S.send.media.uploading ? '<button type="button" class="btn btn--ghost btn--sm" data-send-media-reset>Use template file</button>' : ''}
      </div>`;
  }

  async function pickSendMedia(file) {
    if (!file || !S.send) return;
    const f = sendMediaFormat();
    if (!f) return;
    const send = S.send;
    send.media = { format: f, name: file.name, uploading: true };
    renderSendMedia(); updateSendButton();
    try {
      const up = await uploadMedia('campaigns', file, f);
      if (S.send !== send) return;
      send.media = { format: f, url: up.url, name: up.name };
    } catch (err) {
      if (S.send !== send) return;
      send.media = null;
      $('#send-msg').textContent = err.message;
      ctx.toast({ type: 'error', title: err.message, timeout: 6000 });
    } finally {
      $('#send-media-file').value = '';
      if (S.send === send) { renderSendMedia(); renderSendPreview(); updateSendButton(); }
    }
  }

  function renderVars() {
    const t = selectedTemplate();
    const box = $('#send-vars');
    if (!t) { box.innerHTML = ''; return; }
    const rows = [];
    for (let i = 0; i < (t.header_vars || 0); i++) rows.push(['header', i]);
    for (let i = 0; i < (t.body_vars || 0); i++) rows.push(['body', i]);
    if (!rows.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<p class="send-label">Fill in the variables</p>' + rows.map(([part, i]) => `
      <div class="var-row" data-var="${part}:${i}">
        <span class="var-chip">${part === 'header' ? 'Header ' : ''}{{${i + 1}}}</span>
        <select data-var-src aria-label="Value source">${VAR_SOURCES.map(([v, l]) => `<option value="${v}"${(part === 'body' && i === 0 ? 'name' : 'text') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <input data-var-val placeholder="${part === 'body' && i === 0 ? 'If the name is missing, use…' : 'Text'}" value="${part === 'body' && i === 0 ? 'Customer' : ''}" autocomplete="off" aria-label="Value">
      </div>`).join('');
    syncVarInputs();
  }

  function syncVarInputs() {
    $$('#send-vars [data-var]').forEach((row) => {
      const src = $('[data-var-src]', row).value;
      const input = $('[data-var-val]', row);
      input.hidden = src === 'agent';
      input.placeholder = src === 'text' ? 'Text to send' : src === 'name' ? 'If the name is missing, use…' : src === 'inquiry' ? 'If there is no inquiry, use…' : '';
    });
  }

  function readVars() {
    const out = { header: [], body: [] };
    $$('#send-vars [data-var]').forEach((row) => {
      const [part, i] = row.dataset.var.split(':');
      out[part][Number(i)] = { source: $('[data-var-src]', row).value, value: $('[data-var-val]', row).value.trim() };
    });
    return out;
  }

  function resolveForPreview(spec, conv) {
    if (!spec) return '';
    if (spec.source === 'name') return (conv && conv.customer_name) || spec.value || 'Customer';
    if (spec.source === 'inquiry') return (conv && conv.inquiry_id) || spec.value || '-';
    if (spec.source === 'agent') return (me() && me().display_name) || 'Ikris Pharma Network';
    return spec.value || '…';
  }

  function renderSendPreview() {
    const t = selectedTemplate();
    if (!t) { $('#send-preview').innerHTML = bubbleHtml({ body: '' }); return; }
    const vars = readVars();
    let conv = S.send && S.send.conv;
    if (!conv && S.send && S.send.selected.size && window.IkrisContacts) {
      const ct = window.IkrisContacts.get(Array.from(S.send.selected)[0]);
      if (ct) conv = { customer_name: ct.name, inquiry_id: null };
    }
    const fill = (text, list) => String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => {
      const v = resolveForPreview(list[Number(n) - 1], conv);
      return v || m;
    });
    const p = tplParts(t);
    const m = sendMedia();
    const media = p.media ? { format: p.media.format, url: m && m.url, name: m && m.name } : null;
    $('#send-preview').innerHTML = bubbleHtml({ media, header: fill(p.header, vars.header), body: fill(p.body, vars.body), footer: p.footer, buttons: p.buttons });
  }

  /* audience */
  const contactsApi = () => window.IkrisContacts;

  function setupAudience() {
    const deptSel = $('#aud-dept');
    const opts = chat() ? chat().departmentOptions() : [];
    if (isAdmin()) {
      deptSel.innerHTML = '<option value="">All departments</option><option value="__none">No department</option>' + opts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
      deptSel.disabled = false;
    } else {
      deptSel.innerHTML = (opts.length > 1 ? '<option value="">All my departments</option>' : '') + opts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('') || '<option value="">My department</option>';
      deptSel.disabled = opts.length <= 1;
    }
    const tags = contactsApi() ? contactsApi().tags() : [];
    $('#aud-tag').innerHTML = '<option value="">All tags</option>' + tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    $('#aud-source').value = '';
    $('#aud-search').value = '';
    renderAudience();
  }

  function audienceList() {
    const all = contactsApi() ? contactsApi().list() : [];
    const dep = $('#aud-dept').value;
    const tag = $('#aud-tag').value;
    const src = $('#aud-source').value;
    const q = $('#aud-search').value.trim().toLowerCase();
    const qd = q.replace(/\D/g, '');
    return all.filter((c) =>
      !c.opted_out &&
      (!dep || (dep === '__none' ? !norm(c.department) : chat().convMatches({ department: c.department, shared_departments: [] }, dep))) &&
      (!tag || (c.tags || []).includes(tag)) &&
      (!src || c.source === src) &&
      (!q || `${c.name || ''} ${c.email || ''} ${(c.tags || []).join(' ')}`.toLowerCase().includes(q) || (qd.length >= 3 && c.phone.includes(qd)))
    );
  }

  function renderAudience() {
    if (!S.send || S.send.mode !== 'campaign') return;
    const list = audienceList();
    const sel = S.send.selected;
    const shown = list.slice(0, 600);
    $('#aud-list').innerHTML = shown.length ? shown.map((c) => `
      <li><label class="aud-item">
        <input type="checkbox" data-aud="${esc(c.id)}"${sel.has(c.id) ? ' checked' : ''}>
        <span class="aud-item__name">${esc(c.name || 'Unknown')}</span>
        <span class="aud-item__phone mono">${esc(phoneLabel(c.phone))}</span>
        <span class="aud-item__dept">${esc(c.department ? chat().deptDisplay(c.department) : 'No department')}${(c.tags || []).length ? ` · ${esc(c.tags.join(', '))}` : ''}</span>
      </label></li>`).join('') + (list.length > shown.length ? `<li class="muted small aud-more">Showing the first ${shown.length} of ${list.length}. Narrow the filters to see the rest.</li>` : '')
      : `<li class="cmp-empty small">${(contactsApi() && contactsApi().list().length) ? 'No contacts match these filters.' : 'No contacts yet — add them on the Contacts page.'}</li>`;
    const allChecked = list.length > 0 && list.every((c) => sel.has(c.id));
    $('#aud-all').checked = allChecked;
    $('#aud-all').indeterminate = !allChecked && list.some((c) => sel.has(c.id));
    $('#aud-count').textContent = `${sel.size} selected · ${list.length} shown`;
    updateSendButton();
  }

  function updateSendButton() {
    const b = $('#send-submit');
    const label = $('.btn__label', b);
    if (!S.send) return;
    const t = selectedTemplate();
    const m = sendMedia();
    const mediaBlocked = !!(m && (m.missing || m.uploading));
    if (S.send.mode === 'chat') {
      b.classList.remove('btn--danger-confirm');
      label.textContent = 'Send template';
      b.disabled = !t || mediaBlocked;
      return;
    }
    const n = S.send.selected.size;
    label.textContent = S.confirmArmed ? `Confirm — send to ${n} contact${n === 1 ? '' : 's'}` : `Send to ${n} contact${n === 1 ? '' : 's'}`;
    b.classList.toggle('btn--danger-confirm', S.confirmArmed);
    b.disabled = !t || !n || mediaBlocked;
  }

  async function submitSend(e) {
    e.preventDefault();
    if (!S.send) return;
    const msg = $('#send-msg');
    msg.textContent = '';
    const t = selectedTemplate();
    if (!t) { msg.textContent = 'Choose an approved template.'; return; }
    const vars = readVars();
    const missing = [...vars.header, ...vars.body].some((v) => v && v.source === 'text' && !v.value);
    if (missing) { msg.textContent = 'Fill in every “Fixed text” variable.'; return; }
    const media = sendMedia();
    if (media && (media.missing || media.uploading)) { msg.textContent = media.uploading ? 'Wait for the file to finish uploading.' : 'Upload the header file.'; return; }
    if (media && !media.isDefault) { vars.media_url = media.url; vars.media_name = media.name; }

    const btn = $('#send-submit');
    if (S.send.mode === 'campaign') {
      const name = $('#send-name').value.trim();
      if (!name) { msg.textContent = 'Give the campaign a name.'; $('#send-name').focus(); return; }
      if (!S.send.selected.size) { msg.textContent = 'Select at least one contact.'; return; }
      if (!S.confirmArmed) { S.confirmArmed = true; updateSendButton(); return; }
      btn.disabled = true; btn.setAttribute('aria-busy', 'true');
      try {
        const dep = $('#aud-dept').value;
        const res = await invoke({
          action: 'send_campaign', name, template_name: t.name, language: t.language, variables: vars,
          contact_ids: Array.from(S.send.selected), department: dep && dep !== '__none' ? dep : null
        });
        closeDialogs();
        S.tab = 'campaigns';
        await loadCampaigns();
        renderAll();
        ctx.toast({ type: 'success', title: `Campaign “${name}” started.`, body: `<p class="muted small" style="margin-top:4px">Sending to ${num(res.campaign && res.campaign.total)} contacts. Progress updates here automatically.${res.skipped ? ` ${res.skipped} contact(s) were skipped (opted out or outside your department).` : ''}</p>`, timeout: 7000 });
      } catch (err) {
        msg.textContent = err.message;
        S.confirmArmed = false;
        updateSendButton();
      } finally {
        btn.disabled = false; btn.setAttribute('aria-busy', 'false');
      }
      return;
    }

    // single chat
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    try {
      const res = await invoke({ action: 'send_template', conversation_id: S.send.conv.id, template_name: t.name, language: t.language, variables: vars });
      const cb = S.send.onSent;
      closeDialogs();
      if (cb) cb(res.message || null);
      if (res.sent) ctx.toast({ type: 'success', title: 'Template sent on WhatsApp.', timeout: 4000 });
      else ctx.toast({ type: 'error', title: 'WhatsApp did not accept the template', body: `<p class="muted small" style="margin-top:4px">${esc(res.error || '')}</p>`, timeout: 8000 });
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false; btn.setAttribute('aria-busy', 'false');
    }
  }

  /* ---------------- campaign details ---------------- */
  async function openDetail(id) {
    const c = S.campaigns.find((x) => x.id === id);
    if (!c) return;
    $('#cmp-detail-title').textContent = c.name;
    $('#cmp-detail-sub').textContent = `Template ${c.template_name} · ${dateTime(c.created_at)} · by ${c.created_by_name || c.created_by}`;
    $('#cmp-detail-stats').innerHTML = statTiles(Object.assign({ total: c.total }, S.stats.get(c.id) || {}));
    $('#cmp-detail-rows').innerHTML = '<tr><td colspan="4" class="cmp-empty"><span class="spinner" aria-hidden="true"></span> Loading…</td></tr>';
    openDialog('cmp-detail');
    try {
      const { data: recs } = await client().from('campaign_recipients').select('*').eq('campaign_id', id).order('created_at').limit(2000);
      const ids = (recs || []).map((r) => r.message_id).filter(Boolean);
      const msgs = new Map();
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await client().from('chat_messages').select('id, delivery_status, error').in('id', ids.slice(i, i + 200));
        (data || []).forEach((m) => msgs.set(m.id, m));
      }
      const label = { sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', queued: 'Sending', pending: 'Waiting' };
      $('#cmp-detail-rows').innerHTML = (recs || []).map((r) => {
        const m = msgs.get(r.message_id);
        const st = (m && m.delivery_status) || r.status;
        const note = (m && m.error) || r.error || '';
        return `<tr data-open-conv="${esc(r.conversation_id || '')}" tabindex="0">
          <td>${esc(r.customer_name || 'Unknown')}</td>
          <td class="mono small">${esc(phoneLabel(r.phone))}</td>
          <td><span class="rec-st rec-st--${esc(st)}">${esc(label[st] || st)}</span></td>
          <td class="small muted rec-note" title="${esc(note)}">${esc(note)}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="4" class="cmp-empty">No contacts.</td></tr>';
    } catch (_) {
      $('#cmp-detail-rows').innerHTML = '<tr><td colspan="4" class="cmp-empty">Could not load the contacts.</td></tr>';
    }
  }

  /* ---------------- events ---------------- */
  function bind() {
    document.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-cmp-tab]');
      if (tab) { S.tab = tab.dataset.cmpTab; renderAll(); if (S.tab === 'templates' && staleTemplates()) sync(true); return; }
      if (e.target.closest('#cmp-new-template')) { openTemplateDialog(); return; }
      if (e.target.closest('#cmp-new-campaign')) { openSend({ mode: 'campaign' }); return; }
      if (e.target.closest('#tpl-refresh')) { sync(false); return; }
      const use = e.target.closest('[data-tpl-use]');
      if (use) { openSend({ mode: 'campaign', template: use.dataset.tplUse }); return; }
      const del = e.target.closest('[data-tpl-delete]');
      if (del) { deleteTemplate(del.dataset.tplDelete); return; }
      const row = e.target.closest('#cmp-rows [data-cmp]');
      if (row) { openDetail(row.dataset.cmp); return; }
      const rec = e.target.closest('#cmp-detail-rows [data-open-conv]');
      if (rec && rec.dataset.openConv && chat()) { closeDialogs(); chat().openConversation(rec.dataset.openConv); return; }
      if (e.target.closest('[data-cmp-close]') || e.target === $('#cmp-scrim')) { closeDialogs(); return; }
      if (e.target.closest('#tpl-add-var')) {
        const ta = $('#tpl-body');
        const n = countVars(ta.value) + 1;
        const pos = ta.selectionStart ?? ta.value.length;
        ta.value = `${ta.value.slice(0, pos)}{{${n}}}${ta.value.slice(pos)}`;
        ta.focus();
        renderTplExamples(); renderTplPreview();
        return;
      }
      if (e.target.closest('#tpl-add-btn')) { readTplButtons(); if (S.tplButtons.length < 3) S.tplButtons.push({ type: 'QUICK_REPLY', text: '' }); renderTplButtons(); renderTplPreview(); return; }
      const rm = e.target.closest('[data-btn-remove]');
      if (rm) { readTplButtons(); S.tplButtons.splice(Number(rm.closest('[data-btn-row]').dataset.btnRow), 1); renderTplButtons(); renderTplPreview(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#cmp-scrim').hidden) closeDialogs();
      if (e.key === 'Enter' && e.target.closest && e.target.closest('#cmp-rows [data-cmp]')) openDetail(e.target.closest('[data-cmp]').dataset.cmp);
    });

    $('#cmp-search').addEventListener('input', debounce((e) => { S.q = e.target.value.trim(); renderCampaigns(); }, 150));
    $('#tpl-search').addEventListener('input', debounce((e) => { S.tplQ = e.target.value.trim(); renderTemplates(); }, 150));

    // template form
    $('#tpl-form').addEventListener('submit', submitTemplate);
    $('#tpl-body').addEventListener('input', () => { renderTplExamples(); renderTplPreview(); });
    ['#tpl-header', '#tpl-footer'].forEach((s) => $(s).addEventListener('input', renderTplPreview));
    $('#tpl-header-type').addEventListener('click', (e) => { const b = e.target.closest('[data-htype]'); if (b) setHeaderType(b.dataset.htype); });
    $('#tpl-header-type').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const btns = $$('#tpl-header-type [data-htype]');
      const i = btns.findIndex((b) => b.dataset.htype === S.tplHeader);
      const next = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
      setHeaderType(next.dataset.htype); next.focus(); e.preventDefault();
    });
    $('#tpl-media-file').addEventListener('change', (e) => pickTplMedia(e.target.files[0]));
    const drop = $('#tpl-media-drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); pickTplMedia(e.dataTransfer.files[0]); });
    $('#tpl-media-info').addEventListener('click', (e) => {
      if (e.target.closest('[data-tpl-media-change]')) $('#tpl-media-file').click();
      if (e.target.closest('[data-tpl-media-remove]')) { S.tplMedia = null; renderTplMedia(); renderTplPreview(); }
    });
    $('#send-media').addEventListener('click', (e) => {
      if (e.target.closest('[data-send-media-change]')) $('#send-media-file').click();
      if (e.target.closest('[data-send-media-reset]') && S.send) { S.send.media = null; renderSendMedia(); renderSendPreview(); updateSendButton(); }
    });
    $('#send-media-file').addEventListener('change', (e) => pickSendMedia(e.target.files[0]));
    $('#tpl-name').addEventListener('input', (e) => { e.target.value = e.target.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''); });
    $('#tpl-buttons').addEventListener('input', () => { readTplButtons(); renderTplPreview(); });
    $('#tpl-buttons').addEventListener('change', (e) => { if (e.target.matches('[data-btn-type]')) { readTplButtons(); renderTplButtons(); renderTplPreview(); } });

    // send form
    $('#send-form').addEventListener('submit', submitSend);
    $('#send-template').addEventListener('change', () => { S.confirmArmed = false; if (S.send) S.send.media = null; renderSendMedia(); renderVars(); renderSendPreview(); updateSendButton(); });
    $('#send-vars').addEventListener('change', (e) => { if (e.target.matches('[data-var-src]')) syncVarInputs(); renderSendPreview(); });
    $('#send-vars').addEventListener('input', renderSendPreview);
    ['#aud-dept', '#aud-tag', '#aud-source'].forEach((s) => $(s).addEventListener('change', () => { S.confirmArmed = false; renderAudience(); }));
    $('#aud-search').addEventListener('input', debounce(renderAudience, 150));
    $('#aud-list').addEventListener('change', (e) => {
      const box = e.target.closest('[data-aud]');
      if (!box || !S.send) return;
      if (box.checked) S.send.selected.add(box.dataset.aud); else S.send.selected.delete(box.dataset.aud);
      S.confirmArmed = false;
      renderAudience();
      renderSendPreview();
    });
    $('#aud-all').addEventListener('change', (e) => {
      if (!S.send) return;
      audienceList().forEach((c) => { if (e.target.checked) S.send.selected.add(c.id); else S.send.selected.delete(c.id); });
      S.confirmArmed = false;
      renderAudience();
      renderSendPreview();
    });
  }

  const staleTemplates = () => {
    const latest = S.templates.reduce((a, t) => (t.synced_at && t.synced_at > a ? t.synced_at : a), '');
    return !latest || Date.now() - new Date(latest).getTime() > 10 * 60 * 1000 || S.templates.some((t) => String(t.status).toUpperCase() === 'PENDING');
  };

  /* ---------------- public API ---------------- */
  function init(context) {
    ctx = context;
    bind();
  }

  async function start(user) {
    stop();
    S.user = user;
    renderAll();
    try {
      await Promise.all([loadTemplates(), loadCampaigns()]);
      if (S.user !== user) return;
      S.loaded = true;
      subscribe();
    } catch (e) {
      console.error(e);
      S.loaded = true;
      S.error = 'Campaigns could not be loaded.';
    }
    renderAll();
    if (staleTemplates()) sync(true);
  }

  function stop() {
    if (S.channel) { try { client().removeChannel(S.channel); } catch (_) { /* ignore */ } }
    clearInterval(S.poll);
    S = fresh();
    if ($('#cmp-scrim')) closeDialogs();
  }

  function onShow() {
    renderAll();
    clearInterval(S.poll);
    // Delivery/read receipts arrive over time — refresh numbers while the page is open.
    S.poll = setInterval(() => {
      if (!ctx.isViewing('campaigns') || document.hidden) return;
      refreshCampaignsSoon();
      if (S.templates.some((t) => String(t.status).toUpperCase() === 'PENDING')) sync(true);
    }, 20000);
    refreshCampaignsSoon();
  }

  /** From the chat thread: pick an approved template and send it to one conversation. */
  function openTemplatePicker(conv, onSent) {
    if (!conv) return;
    if (!approved().length && S.templates.length === 0 && !S.syncing) sync(true);
    openSend({ mode: 'chat', conv, onSent });
  }

  /** From the Contacts page: start a campaign with these contacts pre-selected. */
  function openCampaignFor(contactIds) {
    ctx.showView('campaigns');
    openSend({ mode: 'campaign' });
    contactIds.forEach((id) => S.send.selected.add(id));
    renderAudience();
    renderSendPreview();
  }

  return { init, start, stop, onShow, openTemplatePicker, openCampaignFor };
})();
