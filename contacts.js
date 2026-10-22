/* =====================================================================
   IKRIS PHARMA NETWORK — Contacts (WhatsApp address book)
   ---------------------------------------------------------------------
   • Add one contact, or bulk-upload a CSV (sample file provided).
   • Every WhatsApp chat is added automatically (database trigger).
   • Tags, department, opt-out; search & filter; bulk actions;
     "Quick Broadcast" sends a campaign to the selected contacts.
   Access is enforced by Row Level Security on public.contacts:
   admin → everything, departments → their own contacts.
   ===================================================================== */
window.IkrisContacts = (function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const digits = (v) => String(v ?? '').replace(/\D/g, '');
  const phoneLabel = (p) => (p ? `+${digits(p)}` : '');
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-') : '—');
  const num = (n) => Number(n || 0).toLocaleString('en-IN');
  const PAGE_SIZE = 50;
  const SOURCE_LABEL = { whatsapp: 'WhatsApp chat', upload: 'CSV upload', manual: 'Added manually' };

  let ctx = null;
  const fresh = () => ({
    user: null, loaded: false, loading: false, error: null,
    list: [], selected: new Set(),
    f: { q: '', tag: '', dept: '', source: '' },
    page: 1, editing: null, upload: null
  });
  let S = fresh();

  const client = () => ctx.client();
  const chat = () => window.IkrisChat;
  const me = () => (chat() && chat().me()) || null;
  const isAdmin = () => !!(chat() && chat().isAdmin());
  const deptOptions = () => (chat() ? chat().departmentOptions() : []);
  const deptDisplay = (d) => (chat() && d ? chat().deptDisplay(d) : (d || '—'));
  const myDefaultDept = () => (me() && me().departments && me().departments[0]) || '';

  /* ---------------- data ---------------- */
  async function load() {
    S.loading = true;
    render();
    try {
      const rows = [];
      for (let from = 0; from < 50000; from += 1000) {
        const { data, error } = await client().from('contacts').select('*')
          .order('created_at', { ascending: false }).range(from, from + 999);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      S.list = rows;
      S.error = null;
      const ids = new Set(rows.map((r) => r.id));
      S.selected.forEach((id) => { if (!ids.has(id)) S.selected.delete(id); });
    } catch (e) {
      console.error(e);
      S.error = 'Contacts could not be loaded. Please try again.';
    } finally {
      S.loaded = true;
      S.loading = false;
      render();
    }
  }

  const allTags = () => Array.from(new Set(S.list.flatMap((c) => c.tags || []))).sort((a, b) => a.localeCompare(b));

  function filtered() {
    const { q, tag, dept, source } = S.f;
    const t = q.toLowerCase();
    const td = digits(q);
    return S.list.filter((c) =>
      (!tag || (c.tags || []).includes(tag)) &&
      (!source || c.source === source) &&
      (!dept || (dept === '__none' ? !norm(c.department) : (chat() ? chat().convMatches({ department: c.department, shared_departments: [] }, dept) : norm(c.department) === norm(dept)))) &&
      (!t || `${c.name || ''} ${c.email || ''} ${c.company || ''} ${c.country || ''} ${(c.tags || []).join(' ')}`.toLowerCase().includes(t) || (td.length >= 3 && c.phone.includes(td))));
  }

  /* ---------------- rendering ---------------- */
  function render() {
    const noAccess = S.loaded && !me();
    $('#ct-noaccess').hidden = !noAccess;
    $('#ct-main').hidden = noAccess;
    if (noAccess) return;

    $('#ct-total').textContent = S.loaded ? `${num(S.list.length)} total contacts` : 'Loading contacts…';

    // filters
    const tagSel = $('#ct-tag');
    const tags = allTags();
    tagSel.innerHTML = '<option value="">All tags</option>' + tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    tagSel.value = tags.includes(S.f.tag) ? S.f.tag : '';
    S.f.tag = tagSel.value;
    const deptSel = $('#ct-dept');
    const opts = deptOptions();
    deptSel.innerHTML = '<option value="">All departments</option>' + (isAdmin() ? '<option value="__none">No department</option>' : '') + opts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    deptSel.value = S.f.dept;
    $('#ct-dept-wrap').hidden = !isAdmin() && opts.length <= 1;
    $('#ct-tag-list').innerHTML = tags.map((t) => `<option value="${esc(t)}"></option>`).join('');

    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    S.page = Math.min(S.page, pages);
    const rows = list.slice((S.page - 1) * PAGE_SIZE, S.page * PAGE_SIZE);
    const body = $('#ct-rows');
    if (!S.loaded || (S.loading && !S.list.length)) {
      body.innerHTML = '<tr><td colspan="8" class="cmp-empty"><span class="spinner" aria-hidden="true"></span> Loading contacts…</td></tr>';
    } else if (S.error) {
      body.innerHTML = `<tr><td colspan="8" class="cmp-empty">${esc(S.error)}</td></tr>`;
    } else if (!rows.length) {
      body.innerHTML = `<tr><td colspan="8" class="cmp-empty">${S.list.length ? 'No contacts match your filters.' : '<strong>No contacts yet</strong><span>Click <b>Add Contact</b> to create one or bulk-upload a CSV file.</span>'}</td></tr>`;
    } else {
      body.innerHTML = rows.map((c) => `
        <tr data-ct="${esc(c.id)}"${S.selected.has(c.id) ? ' class="is-selected"' : ''}>
          <td class="ct-check"><input type="checkbox" data-ct-check="${esc(c.id)}" aria-label="Select ${esc(c.name || c.phone)}"${S.selected.has(c.id) ? ' checked' : ''}></td>
          <td><b>${esc(c.name || phoneLabel(c.phone))}</b>${c.company ? `<div class="muted small">${esc(c.company)}</div>` : ''}</td>
          <td class="mono small">${esc(phoneLabel(c.phone))}${c.opted_out ? ' <span class="ct-optout">Opted out</span>' : ''}</td>
          <td class="small">${esc(c.email || '')}</td>
          <td><div class="ct-tags">${(c.tags || []).map((t) => `<span class="ct-tag">${esc(t)}</span>`).join('')}</div></td>
          <td class="small">${esc(c.department ? deptDisplay(c.department) : '—')}</td>
          <td class="small" title="${esc(SOURCE_LABEL[c.source] || '')}">${esc(fmtDate(c.created_at))}</td>
          <td class="ct-actions"><button type="button" class="icon-btn" data-ct-edit="${esc(c.id)}" aria-label="Edit ${esc(c.name || c.phone)}" title="Edit"><svg aria-hidden="true"><use href="#i-sliders"/></svg></button></td>
        </tr>`).join('');
    }
    const allOnPage = rows.length > 0 && rows.every((c) => S.selected.has(c.id));
    $('#ct-check-all').checked = allOnPage;
    $('#ct-check-all').indeterminate = !allOnPage && rows.some((c) => S.selected.has(c.id));

    const n = S.selected.size;
    $('#ct-selected').textContent = n ? `${num(n)} selected` : '';
    $('#ct-select-filtered').hidden = !(list.length > rows.length && list.some((c) => !S.selected.has(c.id)));
    $('#ct-select-filtered').textContent = `Select all ${num(list.length)} matching`;
    $('#ct-clear-sel').hidden = !n;
    $('#ct-bulk-apply').disabled = !n;
    $('#ct-broadcast .btn__label').textContent = n ? `Quick Broadcast (${num(n)})` : 'Quick Broadcast';

    $('#ct-pager-info').textContent = list.length ? `${num((S.page - 1) * PAGE_SIZE + 1)}–${num(Math.min(S.page * PAGE_SIZE, list.length))} of ${num(list.length)}` : '';
    $('#ct-prev').disabled = S.page <= 1;
    $('#ct-next').disabled = S.page >= pages;
  }

  /* ---------------- single contact dialog ---------------- */
  function fillDeptSelect(sel, value) {
    const opts = deptOptions();
    sel.innerHTML = (isAdmin() ? '<option value="">No department</option>' : '') + opts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    sel.value = value && opts.some((d) => norm(d) === norm(deptDisplay(value))) ? opts.find((d) => norm(d) === norm(deptDisplay(value))) : (value || (isAdmin() ? '' : myDefaultDept()));
    if (value && !sel.value) { sel.insertAdjacentHTML('afterbegin', `<option value="${esc(value)}">${esc(value)}</option>`); sel.value = value; }
    sel.disabled = !isAdmin() && opts.length <= 1;
  }

  function openContact(c) {
    S.editing = c || null;
    $('#ct-form').reset();
    $('#ct-dialog-title').textContent = c ? 'Edit Contact' : 'Create New Contact';
    $('#ct-f-name').value = c ? c.name || '' : '';
    $('#ct-f-code').value = c ? '' : '91';
    $('#ct-f-phone').value = c ? phoneLabel(c.phone) : '';
    $('#ct-f-phone').disabled = !!c;
    $('#ct-f-code-wrap').hidden = !!c;
    $('#ct-f-email').value = c ? c.email || '' : '';
    $('#ct-f-company').value = c ? c.company || '' : '';
    $('#ct-f-country').value = c ? c.country || '' : '';
    $('#ct-f-tags').value = c ? (c.tags || []).join(', ') : '';
    $('#ct-f-notes').value = c ? c.notes || '' : '';
    $('#ct-f-optout').checked = !!(c && c.opted_out);
    $('#ct-f-optout-wrap').hidden = !c;
    fillDeptSelect($('#ct-f-dept'), c ? c.department : '');
    $('#ct-f-msg').textContent = '';
    $('#ct-delete').hidden = !c;
    $('#ct-f-meta').textContent = c ? `${SOURCE_LABEL[c.source] || ''} · added ${fmtDate(c.created_at)}${c.created_by && c.created_by !== 'whatsapp' ? ` by ${c.created_by}` : ''}` : '';
    openDialog('ct-dialog');
  }

  const parseTags = (v) => Array.from(new Set(String(v || '').split(',').map((t) => t.trim()).filter(Boolean))).slice(0, 20);

  function fullPhone(code, phone) {
    const p = String(phone || '').trim();
    const d = digits(p);
    if (!d) return '';
    if (p.startsWith('+') || p.startsWith('00')) return digits(p.replace(/^00/, ''));
    const cc = digits(code);
    if (cc && !(d.length > 10 && d.startsWith(cc))) return cc + d.replace(/^0+/, '');
    return d;
  }

  function dbError(error) {
    if (!error) return '';
    if (error.code === '23505') return 'This WhatsApp number is already saved as a contact (possibly in another department).';
    if (error.code === '22023' || /Invalid phone/.test(error.message || '')) return 'Invalid phone number: use the full number with country code (8–15 digits).';
    if (error.code === '42501' || /row-level security/i.test(error.message || '')) return 'You can only add contacts to your own department.';
    return error.message || 'Could not save the contact.';
  }

  async function saveContact(e) {
    e.preventDefault();
    const msg = $('#ct-f-msg');
    msg.textContent = '';
    const row = {
      name: $('#ct-f-name').value.trim() || null,
      email: $('#ct-f-email').value.trim() || null,
      company: $('#ct-f-company').value.trim() || null,
      country: $('#ct-f-country').value.trim() || null,
      tags: parseTags($('#ct-f-tags').value),
      department: $('#ct-f-dept').value || null,
      notes: $('#ct-f-notes').value.trim() || null
    };
    if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) { msg.textContent = 'Enter a valid email address.'; $('#ct-f-email').focus(); return; }
    if (!isAdmin() && !row.department) { msg.textContent = 'Choose a department.'; return; }
    const btn = $('#ct-save');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    try {
      if (S.editing) {
        row.opted_out = $('#ct-f-optout').checked;
        const { error } = await client().from('contacts').update(row).eq('id', S.editing.id);
        if (error) throw error;
        ctx.toast({ type: 'success', title: 'Contact updated.', timeout: 3500 });
      } else {
        const phone = fullPhone($('#ct-f-code').value, $('#ct-f-phone').value);
        if (phone.length < 8 || phone.length > 15) { msg.textContent = 'Enter the WhatsApp number with country code, e.g. 91 98765 43210.'; $('#ct-f-phone').focus(); return; }
        const { error } = await client().from('contacts').insert({ ...row, phone, source: 'manual' });
        if (error) throw error;
        ctx.toast({ type: 'success', title: `Contact ${row.name || phoneLabel(phone)} created.`, timeout: 3500 });
      }
      closeDialogs();
      await load();
    } catch (err) {
      msg.textContent = dbError(err);
      ctx.toast({ type: 'error', title: dbError(err), timeout: 6000 });
    } finally {
      btn.disabled = false; btn.setAttribute('aria-busy', 'false');
    }
  }

  async function deleteContacts(ids, label) {
    if (!ids.length) return;
    if (!window.confirm(`Delete ${label}? WhatsApp chat history is kept; only the contact entry is removed.`)) return;
    let failed = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data, error } = await client().from('contacts').delete().in('id', chunk).select('id');
      if (error) failed += chunk.length; else failed += chunk.length - (data || []).length;
    }
    closeDialogs();
    ids.forEach((id) => S.selected.delete(id));
    await load();
    if (failed === ids.length) ctx.toast({ type: 'error', title: 'Could not delete — you can only delete contacts of your own department.', timeout: 6000 });
    else ctx.toast({ type: failed ? 'error' : 'success', title: `${num(ids.length - failed)} contact${ids.length - failed === 1 ? '' : 's'} deleted${failed ? `, ${failed} not allowed` : ''}.`, timeout: 4500 });
  }

  /* ---------------- bulk actions ---------------- */
  function onBulkChange() {
    const a = $('#ct-bulk').value;
    $('#ct-bulk-tag').hidden = !(a === 'add_tag' || a === 'remove_tag');
    $('#ct-bulk-dept').hidden = a !== 'department';
    if (a === 'department') fillDeptSelect($('#ct-bulk-dept'), '');
  }

  async function applyBulk() {
    const a = $('#ct-bulk').value;
    const ids = Array.from(S.selected);
    if (!a || !ids.length) return;
    if (a === 'delete') { deleteContacts(ids, `${ids.length} selected contact${ids.length === 1 ? '' : 's'}`); return; }
    if (a === 'broadcast') { broadcast(); return; }
    const byId = new Map(S.list.map((c) => [c.id, c]));
    const tag = $('#ct-bulk-tag').value.trim();
    if ((a === 'add_tag' || a === 'remove_tag') && !tag) { ctx.toast({ type: 'error', title: 'Type the tag first.', timeout: 4000 }); $('#ct-bulk-tag').focus(); return; }
    const btn = $('#ct-bulk-apply');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    let ok = 0; let bad = 0;
    try {
      if (a === 'department' || a === 'optout' || a === 'optin') {
        const patch = a === 'department' ? { department: $('#ct-bulk-dept').value || null } : { opted_out: a === 'optout' };
        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          const { data, error } = await client().from('contacts').update(patch).in('id', chunk).select('id');
          if (error) bad += chunk.length; else { ok += (data || []).length; bad += chunk.length - (data || []).length; }
        }
      } else {
        // tags differ per contact → update one by one (in small parallel batches)
        const jobs = ids.map((id) => async () => {
          const c = byId.get(id);
          if (!c) return;
          const set = new Set(c.tags || []);
          if (a === 'add_tag') set.add(tag); else set.delete(tag);
          const { error } = await client().from('contacts').update({ tags: Array.from(set) }).eq('id', id);
          if (error) bad++; else ok++;
        });
        for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map((j) => j()));
      }
      await load();
      const verb = { add_tag: `Tag “${tag}” added to`, remove_tag: `Tag “${tag}” removed from`, department: 'Department changed for', optout: 'Marked opted out:', optin: 'Marked subscribed:' }[a];
      ctx.toast({ type: bad && !ok ? 'error' : 'success', title: `${verb} ${num(ok)} contact${ok === 1 ? '' : 's'}${bad ? ` (${bad} not allowed)` : ''}.`, timeout: 4500 });
    } finally {
      btn.disabled = !S.selected.size; btn.setAttribute('aria-busy', 'false');
    }
  }

  function broadcast() {
    const ids = Array.from(S.selected);
    if (!window.IkrisCampaigns) return;
    if (!ids.length) { ctx.toast({ type: 'error', title: 'Select the contacts to broadcast to first.', timeout: 4000 }); return; }
    window.IkrisCampaigns.openCampaignFor(ids);
  }

  /* ---------------- CSV bulk upload ---------------- */
  const SAMPLE = 'Name,Country Code,Phone Number,Email,Company,Country,Tags\n' +
    'Rahul Sharma,91,9876543210,rahul@example.com,Max Hospital,India,doctor;delhi\n' +
    'Ahmed Ali,971,501234567,,,UAE,export\n';

  function downloadSample() {
    const blob = new Blob([SAMPLE], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ikris-contacts-sample.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /** RFC-4180-ish CSV parser (quotes, commas/semicolons, CRLF). */
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/)[0] || '';
    const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : (first.includes('\t') && !first.includes(',') ? '\t' : ',');
    const rows = [];
    let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim()));
  }

  function mapRows(rows) {
    if (!rows.length) return { valid: [], invalid: [], dupes: 0 };
    const head = rows[0].map((h) => norm(h));
    const find = (...names) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const idx = {
      name: find('name', 'fullname', 'customername'),
      code: find('countrycode', 'code', 'isd'),
      phone: find('phonenumber', 'phone', 'mobile', 'whatsapp', 'number', 'contact'),
      email: find('email'),
      company: find('company', 'organisation', 'organization', 'hospital'),
      country: head.findIndex((h) => h === 'country'),
      tags: find('tags', 'tag')
    };
    if (idx.phone < 0) return { error: 'No “Phone Number” column found. Use the sample CSV headings.' };
    const out = []; const invalid = []; const seen = new Set(); let dupes = 0;
    rows.slice(1).forEach((r, i) => {
      const get = (k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '');
      let code = digits(get('code'));
      const raw = get('phone');
      let phone = fullPhone(code || '91', raw);
      if (!code && digits(raw).length > 10) phone = digits(raw);   // already includes country code
      if (phone.length < 8 || phone.length > 15) { invalid.push({ line: i + 2, phone: raw || '(empty)', name: get('name') }); return; }
      if (seen.has(phone)) { dupes++; return; }
      seen.add(phone);
      out.push({
        phone,
        name: get('name') || null,
        email: get('email') || null,
        company: get('company') || null,
        country: get('country') || null,
        tags: get('tags').split(/[;|,]/).map((t) => t.trim()).filter(Boolean)
      });
    });
    return { valid: out, invalid, dupes };
  }

  function openUpload() {
    S.upload = null;
    $('#up-file').value = '';
    $('#up-file-name').textContent = 'No file chosen';
    $('#up-preview').hidden = true;
    $('#up-preview').innerHTML = '';
    $('#up-tag').value = '';
    $('#up-msg').textContent = '';
    $('#up-progress').hidden = true;
    fillDeptSelect($('#up-dept'), '');
    $('#up-submit .btn__label').textContent = 'Upload';
    $('#up-submit').disabled = true;
    openDialog('up-dialog');
  }

  async function pickUpload(file) {
    $('#up-msg').textContent = '';
    if (!file) return;
    $('#up-file-name').textContent = file.name;
    if (!/\.(csv|txt)$/i.test(file.name)) { $('#up-msg').textContent = 'Please choose a .csv file (in Excel: File → Save As → CSV).'; return; }
    if (file.size > 10 * 1024 * 1024) { $('#up-msg').textContent = 'The file is larger than 10 MB.'; return; }
    const text = await file.text();
    const res = mapRows(parseCsv(text));
    if (res.error) { $('#up-msg').textContent = res.error; S.upload = null; $('#up-submit').disabled = true; return; }
    S.upload = res;
    const existing = new Set(S.list.map((c) => c.phone));
    const fresh = res.valid.filter((r) => !existing.has(r.phone));
    const already = res.valid.length - fresh.length;
    $('#up-preview').hidden = false;
    $('#up-preview').innerHTML = `
      <div class="up-summary">
        <span class="up-pill up-pill--ok"><b>${num(res.valid.length - already)}</b> new</span>
        ${already ? `<span class="up-pill"><b>${num(already)}</b> already saved (skipped)</span>` : ''}
        ${res.dupes ? `<span class="up-pill"><b>${num(res.dupes)}</b> repeated in file</span>` : ''}
        ${res.invalid.length ? `<span class="up-pill up-pill--bad"><b>${num(res.invalid.length)}</b> invalid number</span>` : ''}
      </div>
      ${fresh.length ? `<table class="table up-table"><thead><tr><th>Name</th><th>WhatsApp</th><th>Email</th><th>Tags</th></tr></thead><tbody>
        ${fresh.slice(0, 5).map((r) => `<tr><td>${esc(r.name || '—')}</td><td class="mono small">${esc(phoneLabel(r.phone))}</td><td class="small">${esc(r.email || '')}</td><td class="small">${esc(r.tags.join(', '))}</td></tr>`).join('')}
      </tbody></table>${fresh.length > 5 ? `<p class="muted small">…and ${num(fresh.length - 5)} more</p>` : ''}` : ''}
      ${res.invalid.length ? `<p class="small up-bad">Invalid rows: ${res.invalid.slice(0, 6).map((r) => `line ${r.line} (${esc(r.phone)})`).join(', ')}${res.invalid.length > 6 ? '…' : ''}</p>` : ''}`;
    const n = res.valid.length - already;
    $('#up-submit .btn__label').textContent = n ? `Upload ${num(n)} contact${n === 1 ? '' : 's'}` : 'Nothing new to upload';
    $('#up-submit').disabled = !n;
  }

  async function submitUpload(e) {
    e.preventDefault();
    if (!S.upload) return;
    const dept = $('#up-dept').value || null;
    if (!isAdmin() && !dept) { $('#up-msg').textContent = 'Choose a department.'; return; }
    const extraTags = parseTags($('#up-tag').value);
    const existing = new Set(S.list.map((c) => c.phone));
    const rows = S.upload.valid.filter((r) => !existing.has(r.phone)).map((r) => ({
      ...r, department: dept, source: 'upload', tags: Array.from(new Set([...r.tags, ...extraTags]))
    }));
    const btn = $('#up-submit');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    const bar = $('#up-progress');
    bar.hidden = false;
    let added = 0; let failed = 0; let skipped = 0;
    try {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { data, error } = await client().from('contacts')
          .upsert(chunk, { onConflict: 'phone', ignoreDuplicates: true }).select('id');
        if (error) { console.error(error); failed += chunk.length; } else { added += (data || []).length; skipped += chunk.length - (data || []).length; }
        bar.value = Math.round(((i + chunk.length) / rows.length) * 100);
      }
      closeDialogs();
      await load();
      const parts = [`${num(added)} contact${added === 1 ? '' : 's'} uploaded`];
      if (skipped) parts.push(`${num(skipped)} already existed`);
      if (failed) parts.push(`${num(failed)} failed`);
      if (S.upload && S.upload.invalid.length) parts.push(`${num(S.upload.invalid.length)} invalid`);
      ctx.toast({ type: added ? 'success' : 'error', title: parts.join(' · ') + '.', timeout: 6000 });
    } catch (err) {
      $('#up-msg').textContent = err.message || 'Upload failed.';
      ctx.toast({ type: 'error', title: 'Upload failed.', timeout: 6000 });
    } finally {
      btn.disabled = false; btn.setAttribute('aria-busy', 'false');
    }
  }

  /* ---------------- dialogs ---------------- */
  function openDialog(id) {
    $$('#ct-dialog, #up-dialog').forEach((d) => { d.hidden = d.id !== id; });
    $('#ct-scrim').hidden = false;
    const first = $(`#${id} input:not([disabled]):not([type=file]):not([type=checkbox]), #${id} select`);
    if (first) setTimeout(() => first.focus(), 40);
  }
  function closeDialogs() {
    $$('#ct-dialog, #up-dialog').forEach((d) => { d.hidden = true; });
    $('#ct-scrim').hidden = true;
    S.editing = null;
  }

  /* ---------------- events ---------------- */
  function bind() {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('#ct-add')) {
        const menu = $('#ct-add-menu');
        menu.hidden = !menu.hidden;
        $('#ct-add').setAttribute('aria-expanded', String(!menu.hidden));
        return;
      }
      if (!t.closest('#ct-add-menu') && $('#ct-add-menu') && !$('#ct-add-menu').hidden) { $('#ct-add-menu').hidden = true; $('#ct-add').setAttribute('aria-expanded', 'false'); }
      if (t.closest('[data-ct-new]')) { $('#ct-add-menu').hidden = true; openContact(null); return; }
      if (t.closest('[data-ct-upload]')) { $('#ct-add-menu').hidden = true; openUpload(); return; }
      if (t.closest('#up-sample')) { e.preventDefault(); downloadSample(); return; }
      const edit = t.closest('[data-ct-edit]');
      if (edit) { const c = S.list.find((x) => x.id === edit.dataset.ctEdit); if (c) openContact(c); return; }
      if (t.closest('#ct-delete') && S.editing) { deleteContacts([S.editing.id], S.editing.name || phoneLabel(S.editing.phone)); return; }
      if (t.closest('[data-ct-close]') || t === $('#ct-scrim')) { closeDialogs(); return; }
      if (t.closest('#ct-broadcast')) { broadcast(); return; }
      if (t.closest('#ct-bulk-apply')) { applyBulk(); return; }
      if (t.closest('#ct-select-filtered')) { filtered().forEach((c) => S.selected.add(c.id)); render(); return; }
      if (t.closest('#ct-clear-sel')) { S.selected.clear(); render(); return; }
      if (t.closest('#ct-prev')) { S.page = Math.max(1, S.page - 1); render(); return; }
      if (t.closest('#ct-next')) { S.page += 1; render(); return; }
      if (t.closest('#ct-reload')) { load(); return; }
      // click a row (not on controls) → edit
      const row = t.closest('#ct-rows tr[data-ct]');
      if (row && !t.closest('input, button, a')) { const c = S.list.find((x) => x.id === row.dataset.ct); if (c) openContact(c); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#ct-scrim').hidden) closeDialogs(); });

    $('#ct-rows').addEventListener('change', (e) => {
      const box = e.target.closest('[data-ct-check]');
      if (!box) return;
      if (box.checked) S.selected.add(box.dataset.ctCheck); else S.selected.delete(box.dataset.ctCheck);
      render();
    });
    $('#ct-check-all').addEventListener('change', (e) => {
      const list = filtered().slice((S.page - 1) * PAGE_SIZE, S.page * PAGE_SIZE);
      list.forEach((c) => { if (e.target.checked) S.selected.add(c.id); else S.selected.delete(c.id); });
      render();
    });
    $('#ct-search').addEventListener('input', debounce((e) => { S.f.q = e.target.value.trim(); S.page = 1; render(); }, 150));
    $('#ct-tag').addEventListener('change', (e) => { S.f.tag = e.target.value; S.page = 1; render(); });
    $('#ct-dept').addEventListener('change', (e) => { S.f.dept = e.target.value; S.page = 1; render(); });
    $('#ct-source').addEventListener('change', (e) => { S.f.source = e.target.value; S.page = 1; render(); });
    $('#ct-bulk').addEventListener('change', onBulkChange);

    $('#ct-form').addEventListener('submit', saveContact);
    $('#up-form').addEventListener('submit', submitUpload);
    $('#up-file').addEventListener('change', (e) => pickUpload(e.target.files[0]));
    const drop = $('#up-drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-drop'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-drop'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-drop'); pickUpload(e.dataTransfer.files[0]); });
  }

  /* ---------------- public API ---------------- */
  function init(context) { ctx = context; bind(); }

  async function start(user) {
    stop();
    S.user = user;
    render();
    await load();
  }

  function stop() {
    S = fresh();
    if ($('#ct-scrim')) closeDialogs();
    if ($('#ct-rows')) $('#ct-rows').innerHTML = '';
  }

  function onShow() { render(); if (S.loaded && !S.loading) load(); }

  return {
    init, start, stop, onShow,
    reload: () => load(),
    list: () => S.list.slice(),
    tags: allTags,
    get: (id) => S.list.find((c) => c.id === id) || null
  };
})();
