/* =====================================================================
   IKRIS PHARMA NETWORK — Chat Inbox (WhatsApp conversations)
   chat.js — plain JavaScript module, loaded before app.js.

   Data:     Supabase tables chat_conversations / chat_messages
             (access enforced by Row Level Security per department)
   Live:     Supabase Realtime (no page refresh needed)
   Sending:  Edge Function "chat-send" → n8n → Cunnekt WhatsApp

   app.js calls:  IkrisChat.init(ctx) · start(user) · stop()
                  IkrisChat.openDepartment(label) · statsFor(label)
   ===================================================================== */
window.IkrisChat = (() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const STATUSES = ['open', 'pending', 'resolved', 'closed'];
  const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
  const MAX_FILE = 20 * 1024 * 1024;
  const NONE = '__none__';

  /* ---------------- helpers ---------------- */
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
  const pad = (n) => String(n).padStart(2, '0');
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
  const time = (d) => { const h = d.getHours(); return `${pad(h % 12 || 12)}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`; };
  const dateLabel = (d) => `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const listTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return sameDay(d, new Date()) ? time(d) : `${dateLabel(d)} ${time(d)}`;
  };
  const dayHeading = (d) => {
    const now = new Date();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, now)) return 'Today';
    if (sameDay(d, y)) return 'Yesterday';
    return dateLabel(d);
  };
  const phoneLabel = (p) => {
    const s = String(p || '');
    if (s.length === 12 && s.startsWith('91')) return `+91 ${s.slice(2, 7)} ${s.slice(7)}`;
    return s ? `+${s}` : '';
  };
  const initials = (name, phone) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return String(phone || '#').slice(-2);
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const linkify = (html) => html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  const isImage = (type, name) => /^image\//.test(type || '') || /\.(png|jpe?g|gif|webp)$/i.test(name || '');

  /* ---------------- state ---------------- */
  let ctx = null;            // { client(), toast(opts), showView(view), isViewing(view), onCounts() }
  const fresh = () => ({
    user: null,
    me: null,                // chat_staff row
    staff: [],
    convs: new Map(),
    loaded: false,
    error: null,
    selected: null,
    messages: new Map(),     // conversation_id -> array
    filters: { status: 'open', department: '', assigned: '', unread: false, q: '' },
    channel: null,
    signed: new Map(),       // storage path -> signed url
    pendingFile: null,
    sending: false
  });
  let S = fresh();

  const client = () => ctx.client();
  const isAdmin = () => !!S.me && S.me.role === 'admin';

  /** Department labels the current user can work with (admin: all known). */
  function departmentOptions() {
    const seen = new Map();
    const add = (label) => { const k = norm(label); if (k && !seen.has(k)) seen.set(k, label); };
    if (isAdmin()) {
      S.staff.forEach((s) => { if (s.role === 'department' && s.departments[0]) add(s.departments[0]); });
      S.convs.forEach((c) => { if (c.department && !aliasOwner(c.department)) add(c.department); });
    } else if (S.me) {
      add(S.me.departments[0]);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }

  /** Staff row whose department list contains this label (handles aliases like Import ↔ Import/NPP). */
  function aliasOwner(label) {
    const k = norm(label);
    return S.staff.find((s) => s.role === 'department' && s.departments.some((d) => norm(d) === k)) || null;
  }

  /** All normalised names that count as the same department as `label`. */
  function aliasSet(label) {
    const owner = aliasOwner(label);
    return new Set(owner ? owner.departments.map(norm) : [norm(label)]);
  }

  const deptMatches = (convDept, label) => !label || (label === NONE ? !norm(convDept) : aliasSet(label).has(norm(convDept)));
  const deptDisplay = (dep) => { const o = aliasOwner(dep); return o ? o.departments[0] : (dep || 'Unassigned'); };

  function assigneeNames(label) {
    const names = new Set();
    S.staff.forEach((s) => {
      if (s.role !== 'department' || !s.display_name) return;
      if (!label || s.departments.some((d) => aliasSet(label).has(norm(d)))) names.add(s.display_name);
    });
    S.convs.forEach((c) => { if (c.assigned_to && (!label || deptMatches(c.department, label))) names.add(c.assigned_to); });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }

  /* ---------------- data ---------------- */
  async function load() {
    const sb = client();
    const email = (S.user.email || '').toLowerCase();
    const [meRes, staffRes, convRes] = await Promise.all([
      sb.from('chat_staff').select('*').eq('email', email).maybeSingle(),
      sb.from('chat_staff').select('email, display_name, role, departments'),
      sb.from('chat_conversations').select('*').order('last_message_at', { ascending: false, nullsFirst: false }).limit(1000)
    ]);
    if (meRes.error || convRes.error) throw meRes.error || convRes.error;
    S.me = meRes.data || null;
    S.staff = (staffRes.data || []).map((s) => ({ ...s, departments: s.departments || [] }));
    S.convs = new Map((convRes.data || []).map((c) => [c.id, c]));
    S.loaded = true;
    S.error = null;
  }

  function subscribe() {
    const sb = client();
    if (S.channel) sb.removeChannel(S.channel);
    S.channel = sb.channel('ikris-chat-inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_conversations' }, onConvChange)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (p) => onMessage(p.new, true))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_messages' }, (p) => onMessage(p.new, false))
      .subscribe((status) => {
        const dot = $('#chat-live');
        if (dot) dot.dataset.state = status === 'SUBSCRIBED' ? 'live' : 'off';
        if (status === 'SUBSCRIBED' && S.loaded) resync();   // catch anything missed while reconnecting
      });
  }

  const resync = debounce(async () => {
    if (!S.user) return;
    try {
      const { data } = await client().from('chat_conversations').select('*')
        .order('last_message_at', { ascending: false, nullsFirst: false }).limit(1000);
      if (data) { S.convs = new Map(data.map((c) => [c.id, c])); renderAll(); }
    } catch (_) { /* keep current data */ }
  }, 400);

  function onConvChange(p) {
    if (p.eventType === 'DELETE') {
      S.convs.delete(p.old.id);
      if (S.selected === p.old.id) closeThread();
    } else {
      const prev = S.convs.get(p.new.id);
      S.convs.set(p.new.id, p.new);
      // Viewing this chat → keep it read.
      if (S.selected === p.new.id && p.new.unread_count > 0 && ctx.isViewing('chat') && !document.hidden) markRead(p.new.id);
      if (S.selected === p.new.id) renderThreadHeader();
      if (prev && prev.department !== p.new.department && S.selected === p.new.id) renderAssign();
    }
    renderListSoon();
    ctx.onCounts();
  }

  function onMessage(m, isInsert) {
    const list = S.messages.get(m.conversation_id);
    if (list) {
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) list[i] = m; else list.push(m);
      list.sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (S.selected === m.conversation_id) renderMessages(isInsert);
    }
    if (isInsert && m.direction === 'in') {
      const c = S.convs.get(m.conversation_id);
      const viewing = S.selected === m.conversation_id && ctx.isViewing('chat') && !document.hidden;
      if (viewing) markRead(m.conversation_id);
      else if (c) {
        ctx.toast({
          eyebrow: '<svg aria-hidden="true"><use href="#i-wa"/></svg>New WhatsApp message',
          title: c.customer_name || phoneLabel(c.customer_phone),
          body: `<p class="muted small" style="margin-top:4px">${esc((m.body || '📎 Attachment').slice(0, 120))}</p>`,
          actions: [{ label: 'Open chat', onClick: () => { ctx.showView('chat'); select(c.id); } }],
          timeout: 8000
        });
      }
    }
  }

  async function markRead(id) {
    const c = S.convs.get(id);
    if (c && c.unread_count) { c.unread_count = 0; renderListSoon(); ctx.onCounts(); }
    try { await client().rpc('chat_mark_read', { conv: id }); } catch (_) { /* realtime will correct */ }
  }

  async function loadMessages(id) {
    const { data, error } = await client().from('chat_messages').select('*')
      .eq('conversation_id', id).order('created_at', { ascending: true }).limit(1000);
    if (error) throw error;
    S.messages.set(id, data || []);
  }

  async function signedUrl(path) {
    if (S.signed.has(path)) return S.signed.get(path);
    const { data } = await client().storage.from('chat-attachments').createSignedUrl(path, 60 * 60);
    const url = data && data.signedUrl;
    if (url) S.signed.set(path, url);
    return url || '';
  }

  /* ---------------- filtering ---------------- */
  function visibleConvs() {
    const f = S.filters;
    const tokens = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    return Array.from(S.convs.values())
      .filter((c) =>
        (f.status === 'all' || c.status === f.status) &&
        deptMatches(c.department, f.department) &&
        (!f.assigned || (f.assigned === NONE ? !c.assigned_to : norm(c.assigned_to) === norm(f.assigned))) &&
        (!f.unread || c.unread_count > 0) &&
        tokens.every((t) => [c.customer_name, c.customer_phone, phoneLabel(c.customer_phone), c.last_message,
          c.assigned_to, c.id, c.inquiry_id, c.department].join(' ').toLowerCase().includes(t)))
      .sort((a, b) => String(b.last_message_at || b.created_at).localeCompare(String(a.last_message_at || a.created_at)));
  }

  /* ---------------- rendering ---------------- */
  const renderListSoon = debounce(() => renderList(), 60);

  function renderAll() {
    renderShell();
    renderFilters();
    renderList();
    if (S.selected && !S.convs.has(S.selected)) closeThread();
    ctx.onCounts();
  }

  function renderShell() {
    const root = $('#chat');
    if (!root) return;
    const noAccess = S.loaded && !S.me;
    $('#chat-noaccess').hidden = !noAccess;
    root.hidden = noAccess;
    $('#chat-error').hidden = !S.error;
    if (S.error) $('#chat-error-text').textContent = S.error;
  }

  function renderFilters() {
    const depSel = $('#chat-f-dept');
    const opts = departmentOptions();
    const cur = S.filters.department;
    depSel.innerHTML = (isAdmin() ? '<option value="">All departments</option>' : '') +
      opts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('') +
      (isAdmin() ? `<option value="${NONE}">Not yet routed</option>` : '');
    if (cur && ![...depSel.options].some((o) => o.value === cur)) {
      depSel.insertAdjacentHTML('beforeend', `<option value="${esc(cur)}">${esc(cur)}</option>`);
    }
    depSel.value = cur || (isAdmin() ? '' : (opts[0] || ''));
    if (!isAdmin()) S.filters.department = depSel.value;
    depSel.disabled = !isAdmin() && opts.length <= 1;

    const asSel = $('#chat-f-assigned');
    const names = assigneeNames(S.filters.department && S.filters.department !== NONE ? S.filters.department : '');
    const curA = S.filters.assigned;
    asSel.innerHTML = '<option value="">All users</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
      `<option value="${NONE}">Unassigned</option>`;
    asSel.value = names.includes(curA) || curA === NONE ? curA : '';
    S.filters.assigned = asSel.value;

    $('#chat-f-unread').checked = S.filters.unread;
    $('#chat-status').value = S.filters.status;
    $('#chat-search-input').value = S.filters.q;
    renderChips();
  }

  function renderChips() {
    const f = S.filters;
    const chips = [];
    if (f.department && isAdmin()) chips.push(['department', f.department === NONE ? 'Not yet routed' : f.department]);
    if (f.assigned) chips.push(['assigned', f.assigned === NONE ? 'Unassigned' : f.assigned]);
    if (f.unread) chips.push(['unread', 'Unread only']);
    if (f.q) chips.push(['q', `“${f.q}”`]);
    const box = $('#chat-chips');
    box.innerHTML = chips.map(([k, t]) => `<button type="button" class="chip" data-chat-clear="${k}" aria-label="Remove filter ${esc(t)}">${esc(t)}<svg aria-hidden="true"><use href="#i-close"/></svg></button>`).join('');
    box.hidden = !chips.length;
    $('#chat-filter-btn').classList.toggle('is-active', !!(f.assigned || f.unread || (f.department && isAdmin())));
  }

  function renderList() {
    const box = $('#chat-list');
    if (!box) return;
    if (!S.loaded) {
      box.innerHTML = `<li class="chat-empty">${S.error ? 'Chats could not be loaded.' : '<span class="spinner" aria-hidden="true"></span> Loading conversations…'}</li>`;
      $('#chat-count').textContent = '';
      return;
    }
    const list = visibleConvs();
    const totalUnread = list.reduce((s, c) => s + (c.unread_count || 0), 0);
    $('#chat-count').textContent = `${list.length} ${list.length === 1 ? 'conversation' : 'conversations'}${totalUnread ? ` · ${totalUnread} unread` : ''}`;
    if (!list.length) {
      box.innerHTML = `<li class="chat-empty">${S.convs.size ? 'No conversations match these filters.' : 'No WhatsApp conversations yet. New chats appear here automatically.'}</li>`;
      return;
    }
    box.innerHTML = list.map((c) => {
      const name = c.customer_name || phoneLabel(c.customer_phone);
      const unread = c.unread_count > 0;
      const meta = [deptDisplay(c.department), c.assigned_to].filter(Boolean).join(' · ');
      return `
        <li>
          <button type="button" class="chat-card${S.selected === c.id ? ' is-active' : ''}${unread ? ' is-unread' : ''}" data-chat-open="${esc(c.id)}">
            <span class="chat-card__avatar" aria-hidden="true"><svg><use href="#i-wa"/></svg></span>
            <span class="chat-card__body">
              <span class="chat-card__row">
                <span class="chat-card__name">${esc(name)}</span>
                <span class="chat-card__time">${esc(listTime(c.last_message_at || c.created_at))}</span>
              </span>
              <span class="chat-card__row">
                <span class="chat-card__channel"><svg aria-hidden="true"><use href="#i-phone"/></svg>${esc(c.channel || 'Ikris')}</span>
                <span class="chat-card__meta">${esc(meta)}</span>
              </span>
              <span class="chat-card__row">
                <span class="chat-card__msg">${esc(c.last_message || '—')}</span>
                ${unread ? `<span class="chat-card__badge" aria-label="${c.unread_count} unread">${c.unread_count > 99 ? '99+' : c.unread_count}</span>` : ''}
              </span>
              ${c.status !== 'open' ? `<span class="chat-card__status chat-status--${esc(c.status)}">${esc(cap(c.status))}</span>` : ''}
            </span>
          </button>
        </li>`;
    }).join('');
  }

  /* ---------------- thread ---------------- */
  async function select(id) {
    if (!S.convs.has(id)) return;
    S.selected = id;
    S.pendingFile = null;
    $('#chat').classList.add('chat--thread-open');
    $('#chat-thread-empty').hidden = true;
    $('#chat-thread-main').hidden = false;
    $('#chat-assign').hidden = true;
    $('#chat-details-btn').setAttribute('aria-expanded', 'false');
    renderList();
    renderThreadHeader();
    renderAssign();
    renderFileChip();
    $('#chat-messages').innerHTML = '<div class="chat-empty"><span class="spinner" aria-hidden="true"></span> Loading messages…</div>';
    try {
      await loadMessages(id);
      if (S.selected !== id) return;
      renderMessages(true);
      const c = S.convs.get(id);
      if (c && c.unread_count) markRead(id);
    } catch (e) {
      $('#chat-messages').innerHTML = '<div class="chat-empty">Messages could not be loaded. Please try again.</div>';
    }
    setTimeout(() => { const t = $('#chat-text'); if (t && window.innerWidth > 860) t.focus(); }, 50);
  }

  function closeThread() {
    S.selected = null;
    const root = $('#chat');
    if (!root) return;
    root.classList.remove('chat--thread-open');
    $('#chat-thread-empty').hidden = false;
    $('#chat-thread-main').hidden = true;
    renderList();
  }

  function renderThreadHeader() {
    const c = S.convs.get(S.selected);
    if (!c) return;
    const name = c.customer_name || phoneLabel(c.customer_phone);
    $('#chat-th-avatar').textContent = initials(c.customer_name, c.customer_phone);
    $('#chat-th-name').textContent = name;
    $('#chat-th-phone').textContent = phoneLabel(c.customer_phone);
    $('#chat-th-phone').href = `https://wa.me/${c.customer_phone}`;
    $('#chat-th-meta').innerHTML = [
      `<span class="chat-pill">${esc(deptDisplay(c.department))}</span>`,
      `<span class="chat-pill chat-pill--plain">Assigned: <b>${esc(c.assigned_to || 'Unassigned')}</b></span>`,
      `<span class="chat-pill chat-status--${esc(c.status)}">${esc(cap(c.status))}</span>`,
      c.priority !== 'normal' ? `<span class="chat-pill chat-prio--${esc(c.priority)}">${esc(cap(c.priority))} priority</span>` : '',
      c.inquiry_id ? `<span class="chat-pill chat-pill--plain mono">${esc(c.inquiry_id)}</span>` : ''
    ].join('');
    const old = c.last_inbound_at && (Date.now() - new Date(c.last_inbound_at).getTime() > 24 * 3600 * 1000);
    const note = $('#chat-window-note');
    note.hidden = !(old || !c.last_inbound_at);
    note.textContent = !c.last_inbound_at
      ? 'This customer has not messaged yet. WhatsApp only delivers a first message if your provider sends it as an approved template.'
      : 'Last customer message was more than 24 hours ago. WhatsApp may reject free-text replies until the customer writes again (or an approved template is used).';
  }

  function renderAssign() {
    const c = S.convs.get(S.selected);
    if (!c) return;
    const depSel = $('#chat-a-dept');
    const opts = departmentOptions();
    const curLabel = deptDisplay(c.department);
    depSel.innerHTML = (c.department ? '' : '<option value="">Not yet routed</option>') +
      opts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    if (c.department && !opts.some((d) => norm(d) === norm(curLabel))) {
      depSel.insertAdjacentHTML('afterbegin', `<option value="${esc(c.department)}">${esc(c.department)}</option>`);
    }
    depSel.value = opts.find((d) => norm(d) === norm(curLabel)) || c.department || '';
    depSel.disabled = !isAdmin();
    $('#chat-a-dept-hint').hidden = isAdmin();

    $('#chat-a-assigned').value = c.assigned_to || '';
    $('#chat-a-assigned-list').innerHTML = assigneeNames(c.department).map((n) => `<option value="${esc(n)}"></option>`).join('');
    $('#chat-a-status').value = c.status;
    $('#chat-a-priority').value = c.priority;
    $('#chat-a-msg').textContent = '';
  }

  async function renderMessages(scrollToEnd) {
    const box = $('#chat-messages');
    const list = S.messages.get(S.selected) || [];
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (!list.length) {
      box.innerHTML = '<div class="chat-empty">No messages in this conversation yet.</div>';
      return;
    }
    let lastDay = '';
    const parts = [];
    for (const m of list) {
      const d = new Date(m.created_at);
      const day = dayHeading(d);
      if (day !== lastDay) { parts.push(`<div class="chat-day"><span>${esc(day)}</span></div>`); lastDay = day; }
      const out = m.direction === 'out';
      const who = m.sender_type === 'customer' ? (m.sender_name || 'Customer')
        : m.sender_type === 'bot' ? (m.sender_name || 'Ikris Bot')
          : (m.sender_name || 'Agent');
      const tick = out ? deliveryIcon(m) : '';
      parts.push(`
        <div class="msg ${out ? 'msg--out' : 'msg--in'}${m.sender_type === 'bot' ? ' msg--bot' : ''}" data-msg="${esc(m.id)}">
          <div class="msg__bubble">
            <div class="msg__who">${esc(who)}${m.sender_type === 'bot' ? ' <span class="msg__tag">Bot</span>' : ''}</div>
            ${m.attachment_url || m.attachment_path ? `<div class="msg__att" data-att="${esc(m.id)}"></div>` : ''}
            ${m.body ? `<div class="msg__text">${linkify(esc(m.body))}</div>` : ''}
            <div class="msg__foot"><time datetime="${esc(m.created_at)}">${esc(time(d))}</time>${tick}</div>
            ${m.delivery_status === 'failed' || m.delivery_status === 'not_sent'
              ? `<div class="msg__err">${esc(m.delivery_status === 'not_sent' ? 'Saved — not sent to WhatsApp' : 'Not delivered')}${m.error ? `: ${esc(m.error)}` : ''}</div>` : ''}
          </div>
        </div>`);
    }
    box.innerHTML = parts.join('');
    // Attachments (signed URLs for files sent from the dashboard)
    for (const m of list) {
      if (!m.attachment_url && !m.attachment_path) continue;
      const el = box.querySelector(`[data-att="${CSS.escape(m.id)}"]`);
      if (!el) continue;
      const url = m.attachment_path ? await signedUrl(m.attachment_path) : m.attachment_url;
      const name = m.attachment_name || (m.attachment_path || m.attachment_url || '').split('/').pop().split('?')[0] || 'Attachment';
      if (!url) { el.innerHTML = `<span class="msg__file">📎 ${esc(name)} (unavailable)</span>`; continue; }
      el.innerHTML = isImage(m.attachment_type, name)
        ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(url)}" alt="${esc(name)}" loading="lazy"></a>`
        : `<a class="msg__file" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><svg aria-hidden="true"><use href="#i-file"/></svg><span>${esc(name)}</span></a>`;
    }
    if (scrollToEnd || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function deliveryIcon(m) {
    const map = {
      queued: ['Sending…', 'i-clock', ''],
      sent: ['Sent', 'i-check', ''],
      delivered: ['Delivered', 'i-check2', ''],
      read: ['Read', 'i-check2', ' is-read'],
      failed: ['Failed', 'i-alert', ' is-failed'],
      not_sent: ['Not sent to WhatsApp', 'i-alert', ' is-warn']
    };
    const [label, icon, cls] = map[m.delivery_status] || map.sent;
    return `<span class="msg__tick${cls}" title="${label}" aria-label="${label}"><svg aria-hidden="true"><use href="#${icon}"/></svg></span>`;
  }

  function renderFileChip() {
    const box = $('#chat-file');
    const f = S.pendingFile;
    box.hidden = !f;
    box.innerHTML = f ? `<svg aria-hidden="true"><use href="#i-file"/></svg><span>${esc(f.name)}</span><small>${(f.size / 1024 / 1024).toFixed(1)} MB</small>
      <button type="button" class="icon-btn" data-chat-unfile aria-label="Remove attachment"><svg aria-hidden="true"><use href="#i-close"/></svg></button>` : '';
  }

  /* ---------------- actions ---------------- */
  async function invokeSend(body) {
    const { data, error } = await client().functions.invoke('chat-send', { body });
    if (error) {
      let msg = 'Message could not be sent. Please try again.';
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) { /* keep default */ }
      throw new Error(msg);
    }
    return data;
  }

  async function uploadFile(convId, file) {
    const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
    const path = `${convId}/${Date.now()}-${safe}`;
    const { error } = await client().storage.from('chat-attachments').upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (error) throw new Error('The attachment could not be uploaded.');
    return { path, type: file.type || '', name: file.name };
  }

  async function send() {
    if (S.sending || !S.selected) return;
    const input = $('#chat-text');
    const text = input.value.trim();
    const file = S.pendingFile;
    if (!text && !file) return;
    const convId = S.selected;
    S.sending = true;
    $('#chat-send').disabled = true;
    $('#chat-send').setAttribute('aria-busy', 'true');
    try {
      const att = file ? await uploadFile(convId, file) : null;
      const res = await invokeSend({
        conversation_id: convId, text,
        attachment_path: att && att.path, attachment_type: att && att.type, attachment_name: att && att.name
      });
      input.value = '';
      autoGrow();
      S.pendingFile = null;
      renderFileChip();
      if (res && res.message) onMessage(res.message, false);
      if (res && res.sent === false) {
        ctx.toast({ type: 'error', title: 'Saved but not sent to WhatsApp', body: `<p class="muted small" style="margin-top:4px">${esc(res.message && res.message.error || 'WhatsApp sending is not configured yet.')}</p>`, timeout: 8000 });
      }
    } catch (e) {
      ctx.toast({ type: 'error', title: e.message || 'Message could not be sent.', timeout: 7000 });
    } finally {
      S.sending = false;
      $('#chat-send').disabled = false;
      $('#chat-send').setAttribute('aria-busy', 'false');
      input.focus();
    }
  }

  async function saveAssignment() {
    const c = S.convs.get(S.selected);
    if (!c) return;
    const btn = $('#chat-a-save');
    const msg = $('#chat-a-msg');
    const patch = {
      assigned_to: $('#chat-a-assigned').value.trim() || null,
      status: $('#chat-a-status').value,
      priority: $('#chat-a-priority').value
    };
    if (isAdmin()) patch.department = $('#chat-a-dept').value || null;
    btn.disabled = true;
    msg.className = 'chat-assign__msg';
    msg.textContent = 'Saving…';
    const { data, error } = await client().from('chat_conversations').update(patch).eq('id', c.id).select('*').maybeSingle();
    btn.disabled = false;
    if (error || !data) {
      msg.classList.add('is-error');
      msg.textContent = 'Could not save. You may not have permission for that department.';
      return;
    }
    S.convs.set(data.id, data);
    msg.classList.add('is-ok');
    msg.textContent = 'Saved.';
    renderThreadHeader();
    renderFilters();
    renderList();
    ctx.onCounts();
  }

  /* ---------------- new chat dialog ---------------- */
  function openNewChat() {
    const dlg = $('#chat-new-dialog');
    const dep = $('#chat-n-dept');
    const opts = departmentOptions();
    dep.innerHTML = opts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    const pre = S.filters.department && S.filters.department !== NONE ? opts.find((d) => norm(d) === norm(S.filters.department)) : '';
    dep.value = pre || opts[0] || '';
    dep.disabled = !isAdmin() && opts.length <= 1;
    fillNewAssignees();
    $('#chat-new-form').reset();
    dep.value = pre || opts[0] || '';
    $('#chat-n-assigned').value = S.me && S.me.role === 'department' ? (S.me.display_name || '') : '';
    $('#chat-n-msg').textContent = '';
    dlg.hidden = false;
    $('#chat-new-scrim').hidden = false;
    setTimeout(() => $('#chat-n-name').focus(), 30);
  }

  function fillNewAssignees() {
    $('#chat-n-assigned-list').innerHTML = assigneeNames($('#chat-n-dept').value).map((n) => `<option value="${esc(n)}"></option>`).join('');
  }

  function closeNewChat() {
    $('#chat-new-dialog').hidden = true;
    $('#chat-new-scrim').hidden = true;
    $('#chat-new-btn').focus();
  }

  async function submitNewChat(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = form.querySelector('[type="submit"]');
    const msg = $('#chat-n-msg');
    const phone = $('#chat-n-phone').value.replace(/\D/g, '');
    const text = $('#chat-n-text').value.trim();
    if (phone.length < 10) { msg.textContent = 'Enter the WhatsApp number with country code, e.g. 91 98765 43210.'; return; }
    if (!text) { msg.textContent = 'Type the first message.'; return; }
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    msg.textContent = '';
    try {
      const res = await invokeSend({
        new_conversation: {
          phone,
          customer_name: $('#chat-n-name').value.trim(),
          department: $('#chat-n-dept').value,
          assigned_to: $('#chat-n-assigned').value.trim()
        },
        text
      });
      closeNewChat();
      // Make sure the new chat is visible with the current filters.
      const { data } = await client().from('chat_conversations').select('*').eq('id', res.conversation_id).maybeSingle();
      if (data) S.convs.set(data.id, data);
      S.filters.status = 'all';
      S.filters.q = '';
      renderFilters();
      renderList();
      await select(res.conversation_id);
      if (res.sent === false) {
        ctx.toast({ type: 'error', title: 'Chat created but not sent to WhatsApp', body: `<p class="muted small" style="margin-top:4px">${esc(res.message && res.message.error || 'WhatsApp sending is not configured yet.')}</p>`, timeout: 8000 });
      } else {
        ctx.toast({ type: 'success', title: 'Conversation started', timeout: 4000 });
      }
    } catch (err) {
      msg.textContent = err.message || 'Could not start the conversation.';
    } finally {
      btn.disabled = false;
      btn.setAttribute('aria-busy', 'false');
    }
  }

  /* ---------------- composer ---------------- */
  function autoGrow() {
    const t = $('#chat-text');
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
  }

  function pickFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE) { ctx.toast({ type: 'error', title: 'File is larger than 20 MB.', timeout: 5000 }); return; }
    S.pendingFile = file;
    renderFileChip();
  }

  /* ---------------- events ---------------- */
  function bind() {
    const root = $('#chat-view');
    root.addEventListener('click', (e) => {
      const open = e.target.closest('[data-chat-open]');
      if (open) { select(open.dataset.chatOpen); return; }
      const clr = e.target.closest('[data-chat-clear]');
      if (clr) {
        const k = clr.dataset.chatClear;
        if (k === 'unread') S.filters.unread = false; else S.filters[k] = '';
        if (k === 'department') S.filters.assigned = '';
        renderFilters(); renderList(); return;
      }
      if (e.target.closest('[data-chat-unfile]')) { S.pendingFile = null; renderFileChip(); return; }
      if (e.target.closest('#chat-back')) { closeThread(); return; }
      if (e.target.closest('#chat-search-btn')) {
        const box = $('#chat-search');
        box.hidden = !box.hidden;
        $('#chat-search-btn').setAttribute('aria-expanded', String(!box.hidden));
        if (!box.hidden) $('#chat-search-input').focus();
        return;
      }
      if (e.target.closest('#chat-filter-btn')) {
        const box = $('#chat-filters');
        box.hidden = !box.hidden;
        $('#chat-filter-btn').setAttribute('aria-expanded', String(!box.hidden));
        return;
      }
      if (e.target.closest('#chat-details-btn')) {
        const box = $('#chat-assign');
        box.hidden = !box.hidden;
        $('#chat-details-btn').setAttribute('aria-expanded', String(!box.hidden));
        if (!box.hidden) renderAssign();
        return;
      }
      if (e.target.closest('#chat-new-btn')) { openNewChat(); return; }
      if (e.target.closest('#chat-attach')) { $('#chat-file-input').click(); return; }
      if (e.target.closest('#chat-retry')) { start(S.user); }
    });

    $('#chat-status').addEventListener('change', (e) => { S.filters.status = e.target.value; renderList(); });
    $('#chat-f-dept').addEventListener('change', (e) => { S.filters.department = e.target.value; S.filters.assigned = ''; renderFilters(); renderList(); });
    $('#chat-f-assigned').addEventListener('change', (e) => { S.filters.assigned = e.target.value; renderChips(); renderList(); });
    $('#chat-f-unread').addEventListener('change', (e) => { S.filters.unread = e.target.checked; renderChips(); renderList(); });
    const onSearch = debounce((v) => { S.filters.q = v.trim(); renderChips(); renderList(); }, 200);
    $('#chat-search-input').addEventListener('input', (e) => onSearch(e.target.value));

    $('#chat-a-save').addEventListener('click', saveAssignment);
    $('#chat-a-dept').addEventListener('change', () => {
      $('#chat-a-assigned-list').innerHTML = assigneeNames($('#chat-a-dept').value).map((n) => `<option value="${esc(n)}"></option>`).join('');
    });

    const text = $('#chat-text');
    text.addEventListener('input', autoGrow);
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    $('#chat-send').addEventListener('click', send);
    $('#chat-file-input').addEventListener('change', (e) => { pickFile(e.target.files[0]); e.target.value = ''; });

    const thread = $('#chat-thread');
    thread.addEventListener('dragover', (e) => { if (S.selected) { e.preventDefault(); thread.classList.add('is-drop'); } });
    thread.addEventListener('dragleave', () => thread.classList.remove('is-drop'));
    thread.addEventListener('drop', (e) => {
      thread.classList.remove('is-drop');
      if (!S.selected) return;
      e.preventDefault();
      pickFile(e.dataTransfer.files[0]);
    });

    $('#chat-new-form').addEventListener('submit', submitNewChat);
    $('#chat-n-dept').addEventListener('change', fillNewAssignees);
    $$('[data-chat-new-close]').forEach((b) => b.addEventListener('click', closeNewChat));
    $('#chat-new-scrim').addEventListener('click', closeNewChat);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#chat-new-dialog').hidden) closeNewChat(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && S.selected && ctx.isViewing('chat')) {
        const c = S.convs.get(S.selected);
        if (c && c.unread_count) markRead(c.id);
      }
    });
  }

  /* ---------------- public API ---------------- */
  function init(context) {
    ctx = context;
    bind();
  }

  async function start(user) {
    stop();
    S.user = user;
    renderShell();
    renderList();
    try {
      await load();
      if (S.user !== user) return;
      subscribe();
    } catch (e) {
      console.error(e);
      S.error = 'Chats could not be loaded. Please check your connection and try again.';
    }
    renderAll();
  }

  function stop() {
    if (S.channel) { try { client().removeChannel(S.channel); } catch (_) { /* ignore */ } }
    S = fresh();
    if ($('#chat')) {
      $('#chat-list').innerHTML = '';
      $('#chat-messages').innerHTML = '';
      $('#chat').classList.remove('chat--thread-open');
      $('#chat-thread-empty').hidden = false;
      $('#chat-thread-main').hidden = true;
      $('#chat-new-dialog').hidden = true;
      $('#chat-new-scrim').hidden = true;
    }
  }

  /** Called from a department card's "Chat" button. */
  function openDepartment(label) {
    const opts = departmentOptions();
    const match = opts.find((d) => aliasSet(d).has(norm(label))) || label;
    if (isAdmin() || norm(match) === norm(S.filters.department) || opts.some((d) => norm(d) === norm(match))) {
      S.filters.department = match;
    }
    S.filters.assigned = '';
    S.filters.status = 'all';
    S.filters.q = '';
    S.filters.unread = false;
    if (S.selected && !deptMatches((S.convs.get(S.selected) || {}).department, match)) closeThread();
    renderFilters();
    renderList();
    ctx.showView('chat');
  }

  /** { active, unread, total } for a department label (used on dashboard cards). */
  function statsFor(label) {
    let active = 0; let unread = 0; let total = 0;
    S.convs.forEach((c) => {
      if (!deptMatches(c.department, label)) return;
      total++;
      if (c.status === 'open' || c.status === 'pending') active++;
      unread += c.unread_count || 0;
    });
    return { active, unread, total };
  }

  function totalUnread() {
    let n = 0;
    S.convs.forEach((c) => { n += c.unread_count || 0; });
    return n;
  }

  return {
    init, start, stop, openDepartment, statsFor, totalUnread,
    ready: () => S.loaded && !!S.me,
    onShow() { renderList(); if (S.selected) { const c = S.convs.get(S.selected); if (c && c.unread_count) markRead(c.id); } }
  };
})();
