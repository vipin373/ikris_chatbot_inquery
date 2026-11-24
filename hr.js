/* =====================================================================
   IKRIS PHARMA NETWORK — Employee Management + Leave Management
   ---------------------------------------------------------------------
   • Visible only to HR (staff with department "Hr") and administrators.
   • Employees: directory, add / edit / deactivate through the server
     functions hr_save_employee() and hr_set_employee_status() (validated
     + audited in the database). No employee or manager logins.
   • Leave: read-only. Employees apply and reporting managers approve or
     reject on WhatsApp; HR can only monitor here.
   Access is enforced by Row Level Security, not just by hiding the menu.
   ===================================================================== */
window.IkrisHR = (function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const digits = (v) => String(v ?? '').replace(/\D/g, '');
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const num = (n) => Number(n || 0).toLocaleString('en-IN');
  const phone = (p) => {
    const d = digits(p);
    if (!d) return '—';
    return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : `+${d}`;
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const date = (iso) => { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d} ${MONTHS[+m - 1]} ${y}`; };
  const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '—');
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

  let ctx = null;
  const fresh = () => ({
    user: null, checked: false, allowed: false,
    emps: [], empLoaded: false, empError: null, empQ: '', empStatus: '',
    leaves: [], lvLoaded: false, lvError: null, lvQ: '', lvTab: '',
    editing: null, confirming: null, loading: { emp: false, lv: false }
  });
  let S = fresh();
  const client = () => ctx.client();

  /* ---------------- access ---------------- */
  function applyAccess() {
    $$('[data-nav="employees"], [data-nav="leave"]').forEach((el) => { el.hidden = !S.allowed; });
    ['emp', 'lv'].forEach((k) => {
      const na = $(`#${k}-noaccess`); const main = $(`#${k}-main`);
      if (na) na.hidden = S.allowed || !S.checked;
      if (main) main.hidden = !S.allowed;
    });
  }

  /* ---------------- data ---------------- */
  async function loadEmployees() {
    if (!S.allowed || S.loading.emp) return;
    S.loading.emp = true;
    try {
      const { data, error } = await client().from('employees').select('*').order('employee_name');
      if (error) throw error;
      S.emps = data || [];
      S.empError = null;
    } catch (e) {
      console.error(e);
      S.empError = 'Employees could not be loaded. Please try again.';
    } finally {
      S.empLoaded = true; S.loading.emp = false;
      renderEmployees();
    }
  }
  async function loadLeaves() {
    if (!S.allowed || S.loading.lv) return;
    S.loading.lv = true;
    try {
      const rows = [];
      for (let from = 0; from < 20000; from += 1000) {
        const { data, error } = await client().from('leave_requests').select('*').order('applied_at', { ascending: false }).range(from, from + 999);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      S.leaves = rows;
      S.lvError = null;
    } catch (e) {
      console.error(e);
      S.lvError = 'Leave applications could not be loaded. Please try again.';
    } finally {
      S.lvLoaded = true; S.loading.lv = false;
      renderLeaves();
    }
  }

  const byId = () => new Map(S.emps.map((e) => [e.id, e]));

  /* ---------------- employees ---------------- */
  function kpi(label, value, sub, mod) {
    return `<div class="kpi${mod ? ` kpi--${mod}` : ''}"><p class="kpi__label">${esc(label)}</p><p class="kpi__value">${num(value)}</p><p class="kpi__sub">${esc(sub)}</p></div>`;
  }
  function empFiltered() {
    const q = S.empQ.toLowerCase(), qd = digits(S.empQ);
    return S.emps.filter((e) =>
      (!S.empStatus || (S.empStatus === 'flag' ? !!e.hr_flag : e.status === S.empStatus)) &&
      (!q || e.employee_name.toLowerCase().includes(q) || e.employee_id.toLowerCase().includes(q) || (qd.length >= 3 && e.whatsapp_number.includes(qd))));
  }
  function renderEmployees() {
    if (!S.allowed) return;
    const active = S.emps.filter((e) => e.status === 'active').length;
    const flagged = S.emps.filter((e) => e.hr_flag).length;
    $('#emp-kpis').innerHTML = !S.empLoaded
      ? ['Total Employees', 'Active Employees', 'Inactive Employees', 'Needs HR Attention'].map((l) => `<div class="kpi kpi--skeleton"><p class="kpi__label">${l}</p><div class="kpi__value"></div><p class="kpi__sub">&nbsp;</p></div>`).join('')
      : kpi('Total Employees', S.emps.length, 'In the employee directory', 'new') + kpi('Active Employees', active, 'Can apply for leave on WhatsApp', 'completed')
        + kpi('Inactive Employees', S.emps.length - active, 'Records kept, cannot apply', '') + kpi('Needs HR Attention', flagged, flagged ? 'Missing manager or details' : 'All records complete', 'pending');
    $$('[data-emp-flags]').forEach((b) => { b.hidden = !flagged; b.textContent = String(flagged); });

    const map = byId();
    const list = empFiltered();
    const body = $('#emp-rows');
    if (!S.empLoaded) body.innerHTML = '<tr><td colspan="8" class="cmp-empty"><span class="spinner" aria-hidden="true"></span> Loading employees…</td></tr>';
    else if (S.empError) body.innerHTML = `<tr><td colspan="8" class="cmp-empty">${esc(S.empError)}</td></tr>`;
    else if (!list.length) body.innerHTML = `<tr><td colspan="8" class="cmp-empty">${S.emps.length ? 'No employees match your search or filter.' : 'No employees yet. Click <b>ADD NEW EMPLOYEE</b>.'}</td></tr>`;
    else body.innerHTML = list.map((e) => {
      const m = map.get(e.reporting_manager_id);
      return `<tr data-emp="${esc(e.id)}" class="${e.status === 'inactive' ? 'is-muted' : ''}">
        <td class="mono">${esc(e.employee_id)}</td>
        <td><b>${esc(e.employee_name)}</b>${e.hr_flag ? ` <span class="hr-flagdot" title="${esc(e.hr_flag)}" aria-label="Needs HR attention">!</span>` : ''}</td>
        <td class="mono small">${esc(phone(e.whatsapp_number))}</td>
        <td>${esc(e.designation)}</td>
        <td>${m ? esc(m.employee_name) : '<span class="hr-missing">Not assigned</span>'}</td>
        <td class="mono small">${m ? esc(phone(m.whatsapp_number)) : '—'}</td>
        <td><span class="cmp-badge cmp-badge--${e.status === 'active' ? 'done' : 'cancelled'}">${e.status === 'active' ? 'Active' : 'Inactive'}</span></td>
        <td class="hr-actions">
          <button type="button" class="link small" data-emp-view="${esc(e.id)}">View</button>
          <button type="button" class="link small" data-emp-edit="${esc(e.id)}">Edit</button>
          ${e.status === 'active'
            ? `<button type="button" class="link small hr-link-danger" data-emp-deact="${esc(e.id)}">Deactivate</button>`
            : `<button type="button" class="link small" data-emp-react="${esc(e.id)}">Activate</button>`}
        </td></tr>`;
    }).join('');
    $('#emp-info').textContent = S.empLoaded ? `Showing ${num(list.length)} of ${num(S.emps.length)} employees` : '';
  }

  function managerOptions(selfId, current) {
    const opts = S.emps.filter((e) => e.status === 'active' && e.id !== selfId).sort((a, b) => a.employee_name.localeCompare(b.employee_name));
    return '<option value="">Select reporting manager</option>' + opts.map((e) =>
      `<option value="${esc(e.id)}"${e.id === current ? ' selected' : ''}>${esc(e.employee_name)} (${esc(e.employee_id)}) - ${esc(e.designation)}</option>`).join('');
  }
  function showManagerInfo() {
    const m = byId().get($('#emp-f-mgr').value);
    const box = $('#emp-f-mgrinfo');
    box.hidden = !m;
    if (m) box.innerHTML = `<b>${esc(m.employee_name)}</b> · Employee ID ${esc(m.employee_id)} · WhatsApp <span class="mono">${esc(phone(m.whatsapp_number))}</span>`;
  }

  function openDialog(id) {
    $$('#emp-dialog, #emp-view, #emp-confirm, #lv-view').forEach((d) => { d.hidden = d.id !== id; });
    $('#hr-scrim').hidden = false;
    const first = $(`#${id} input:not([disabled]), #${id} select, #${id} button`);
    if (first) setTimeout(() => first.focus(), 40);
  }
  function closeDialogs() {
    $$('#emp-dialog, #emp-view, #emp-confirm, #lv-view').forEach((d) => { d.hidden = true; });
    if ($('#hr-scrim')) $('#hr-scrim').hidden = true;
    S.editing = null; S.confirming = null;
  }

  function openEmployeeForm(id) {
    const e = id ? S.emps.find((x) => x.id === id) : null;
    S.editing = e ? e.id : null;
    $('#emp-dialog-title').textContent = e ? `Edit employee - ${e.employee_name}` : 'Add New Employee';
    $('#emp-f-meta').textContent = e ? `Last updated ${dateTime(e.updated_at)}${e.updated_by ? ` by ${e.updated_by}` : ''}` : 'All fields marked * are required.';
    $('#emp-f-id').value = e ? e.employee_id : '';
    $('#emp-f-name').value = e ? e.employee_name : '';
    const d = e ? e.whatsapp_number : '';
    $('#emp-f-code').value = d && d.startsWith('91') && d.length === 12 ? '91' : (d ? '' : '91');
    $('#emp-f-phone').value = d ? (d.startsWith('91') && d.length === 12 ? d.slice(2) : d) : '';
    $('#emp-f-desig').value = e && e.designation !== 'Not specified' ? e.designation : '';
    $('#emp-f-mgr').innerHTML = managerOptions(e ? e.id : null, e ? e.reporting_manager_id : '');
    showManagerInfo();
    $('#emp-f-status-wrap').hidden = !!e;                 // status changes on existing records: Deactivate / Activate buttons
    $('#emp-f-status').value = 'active';
    $('#emp-f-flag').hidden = !(e && e.hr_flag);
    $('#emp-f-flag').textContent = e && e.hr_flag ? `Needs HR attention: ${e.hr_flag}` : '';
    $('#emp-f-msg').textContent = '';
    openDialog('emp-dialog');
  }

  async function saveEmployee(ev) {
    ev.preventDefault();
    const msg = $('#emp-f-msg');
    msg.textContent = '';
    const code = digits($('#emp-f-code').value);
    let ph = digits($('#emp-f-phone').value);
    if (ph.length === 10 && code) ph = code + ph;
    const row = {
      id: S.editing || '',
      employee_id: $('#emp-f-id').value.trim().toUpperCase(),
      employee_name: $('#emp-f-name').value.trim(),
      whatsapp_number: ph,
      designation: $('#emp-f-desig').value.trim(),
      reporting_manager_id: $('#emp-f-mgr').value,
      status: S.editing ? '' : $('#emp-f-status').value
    };
    const missing = [['Employee ID', row.employee_id, '#emp-f-id'], ['Employee Full Name', row.employee_name, '#emp-f-name'], ['WhatsApp Number', row.whatsapp_number, '#emp-f-phone'],
      ['Designation', row.designation, '#emp-f-desig'], ['Reporting Manager', row.reporting_manager_id, '#emp-f-mgr']].find((f) => !f[1]);
    if (missing) { msg.textContent = `${missing[0]} is required.`; $(missing[2]).focus(); return; }
    if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(row.employee_id)) { msg.textContent = 'Employee ID: use letters and numbers only (e.g. IK082).'; $('#emp-f-id').focus(); return; }
    if (ph.length < 12 || ph.length > 15) { msg.textContent = 'Enter a valid WhatsApp number: 10-digit Indian number, or the full number with country code.'; $('#emp-f-phone').focus(); return; }
    if (S.editing && row.reporting_manager_id === S.editing) { msg.textContent = 'An employee cannot be their own reporting manager.'; return; }
    const dupId = S.emps.find((e) => e.employee_id.toUpperCase() === row.employee_id && e.id !== S.editing);
    if (dupId) { msg.textContent = `Employee ID ${row.employee_id} already belongs to ${dupId.employee_name}.`; $('#emp-f-id').focus(); return; }
    const dupPh = S.emps.find((e) => e.whatsapp_number === ph && e.status === 'active' && e.id !== S.editing);
    if (dupPh) { msg.textContent = `This WhatsApp number is already registered to ${dupPh.employee_name} (${dupPh.employee_id}). Please check with HR before saving.`; $('#emp-f-phone').focus(); return; }

    const btn = $('#emp-save');
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    try {
      const { data, error } = await client().rpc('hr_save_employee', { p: row });
      if (error) throw error;
      if (!data || !data.ok) { msg.textContent = (data && data.error) || 'The employee could not be saved.'; return; }
      closeDialogs();
      ctx.toast({ type: 'success', title: data.created ? 'New employee has been successfully added to the employee directory.' : data.unchanged ? 'No changes to save.' : 'Employee details updated.', body: data.warning || undefined, timeout: 6000 });
      await loadEmployees();
    } catch (e) {
      console.error(e);
      msg.textContent = 'The employee could not be saved. Please try again.';
    } finally {
      btn.disabled = false; btn.setAttribute('aria-busy', 'false');
    }
  }

  async function openEmployeeView(id) {
    const e = S.emps.find((x) => x.id === id);
    if (!e) return;
    const map = byId();
    const m = map.get(e.reporting_manager_id);
    const team = S.emps.filter((x) => x.reporting_manager_id === e.id && x.status === 'active');
    $('#emp-view-title').textContent = e.employee_name;
    $('#emp-view-sub').textContent = `${e.employee_id} · ${e.status === 'active' ? 'Active' : 'Inactive'}`;
    const rows = [['Employee ID', e.employee_id], ['Employee Name', e.employee_name], ['WhatsApp Number', phone(e.whatsapp_number)], ['Designation', e.designation],
      ['Reporting Manager', m ? `${m.employee_name} (${m.employee_id})` : 'Not assigned'], ['Manager WhatsApp', m ? phone(m.whatsapp_number) : '—'],
      ['Status', e.status === 'active' ? 'Active' : 'Inactive'], ['Team members', team.length ? team.map((t) => t.employee_name).join(', ') : '—'],
      ['Added', `${dateTime(e.created_at)}${e.created_by ? ` · ${e.created_by}` : ''}`], ['Last updated', `${dateTime(e.updated_at)}${e.updated_by ? ` · ${e.updated_by}` : ''}`]];
    $('#emp-view-body').innerHTML = `${e.hr_flag ? `<div class="hr-flag">Needs HR attention: ${esc(e.hr_flag)}</div>` : ''}
      <dl class="hr-dl">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <h3 class="hr-h3">Leave applications</h3><div id="emp-view-leave" class="muted small">Loading…</div>
      <h3 class="hr-h3">Change history</h3><ol class="hr-audit" id="emp-view-audit"><li class="muted small">Loading…</li></ol>`;
    $('#emp-view-foot').innerHTML = `<button type="button" class="btn btn--ghost btn--sm" data-hr-close>Close</button><button type="button" class="btn btn--wa btn--sm" data-emp-edit="${esc(e.id)}"><svg aria-hidden="true"><use href="#i-edit"/></svg>Edit</button>`;
    openDialog('emp-view');
    const [aud, lv] = await Promise.all([
      client().from('employee_audit').select('*').eq('employee_uuid', id).order('performed_at', { ascending: false }).limit(50),
      client().from('leave_requests').select('request_id,status,from_date,to_date').eq('employee_id', id).order('applied_at', { ascending: false }).limit(20)
    ]);
    if ($('#emp-view').hidden) return;
    const L = lv.data || [];
    $('#emp-view-leave').innerHTML = L.length ? L.map((r) => `<span class="hr-chip">${esc(r.request_id)} · ${esc(date(r.from_date))}–${esc(date(r.to_date))} · ${statusBadge(r.status)}</span>`).join(' ') : 'No leave applications yet.';
    const A = aud.data || [];
    const label = { created: 'Added', updated: 'Details updated', manager_changed: 'Reporting manager changed', deactivated: 'Deactivated', reactivated: 'Activated' };
    $('#emp-view-audit').innerHTML = A.length ? A.map((a) => {
      const ch = a.changes || {};
      const det = a.action === 'created' ? '' : Object.entries(ch).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v[0] ?? '—'} → ${v[1] ?? '—'}`).join('; ');
      return `<li><b>${esc(label[a.action] || a.action)}</b> <span class="muted small">${esc(dateTime(a.performed_at))} · ${esc(a.performed_by || '')}</span>${det ? `<div class="small">${esc(det)}</div>` : ''}</li>`;
    }).join('') : '<li class="muted small">No history.</li>';
  }

  function askDeactivate(id) {
    const e = S.emps.find((x) => x.id === id);
    if (!e) return;
    const team = S.emps.filter((x) => x.reporting_manager_id === e.id && x.status === 'active');
    S.confirming = id;
    $('#emp-confirm-text').innerHTML = `Are you sure you want to deactivate this employee?<br><b>${esc(e.employee_name)}</b> (${esc(e.employee_id)})`;
    $('#emp-confirm-msg').textContent = team.length ? `${e.employee_name} is the reporting manager of ${team.map((t) => t.employee_name).join(', ')}. Reassign them to another manager first.` : '';
    $('#emp-confirm-yes').disabled = !!team.length;
    openDialog('emp-confirm');
  }
  async function setStatus(id, status) {
    const btn = $('#emp-confirm-yes');
    if (status === 'inactive') { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try {
      const { data, error } = await client().rpc('hr_set_employee_status', { p_id: id, p_status: status });
      if (error) throw error;
      if (!data || !data.ok) {
        if (status === 'inactive') $('#emp-confirm-msg').textContent = (data && data.error) || 'Could not deactivate.';
        else ctx.toast({ type: 'error', title: (data && data.error) || 'Could not activate the employee.', timeout: 7000 });
        return;
      }
      closeDialogs();
      ctx.toast({ type: 'success', title: status === 'inactive' ? 'Employee deactivated.' : 'Employee activated.',
        body: data.pending_flagged ? `${data.pending_flagged} pending leave request(s) were flagged for HR review.` : undefined, timeout: 6000 });
      await Promise.all([loadEmployees(), S.lvLoaded ? loadLeaves() : null]);
    } catch (e) {
      console.error(e);
      ctx.toast({ type: 'error', title: 'Something went wrong. Please try again.', timeout: 6000 });
    } finally {
      btn.disabled = false; btn.setAttribute('aria-busy', 'false');
    }
  }

  /* ---------------- leave ---------------- */
  const statusBadge = (s) => `<span class="cmp-badge cmp-badge--${s === 'APPROVED' ? 'done' : s === 'REJECTED' ? 'failed' : 'scheduled'}">${s === 'APPROVED' ? 'Approved' : s === 'REJECTED' ? 'Rejected' : 'Pending'}</span>`;
  function lvFiltered() {
    const q = S.lvQ.toLowerCase();
    return S.leaves.filter((r) => (!S.lvTab || r.status === S.lvTab) &&
      (!q || r.employee_name_snapshot.toLowerCase().includes(q) || r.employee_code_snapshot.toLowerCase().includes(q) || r.request_id.toLowerCase().includes(q)));
  }
  function renderLeaves() {
    if (!S.allowed) return;
    const c = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
    S.leaves.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
    $('#lv-kpis').innerHTML = !S.lvLoaded
      ? ['Total Applications', 'Pending', 'Approved', 'Rejected'].map((l) => `<div class="kpi kpi--skeleton"><p class="kpi__label">${l}</p><div class="kpi__value"></div><p class="kpi__sub">&nbsp;</p></div>`).join('')
      : kpi('Total Applications', S.leaves.length, 'All leave requests', 'new') + kpi('Pending Applications', c.PENDING, "Waiting for manager's decision", 'pending')
        + kpi('Approved Applications', c.APPROVED, 'Approved by reporting manager', 'completed') + kpi('Rejected Applications', c.REJECTED, 'Rejected with a reason', '');
    $$('[data-leave-pending]').forEach((b) => { b.hidden = !c.PENDING; b.textContent = String(c.PENDING); });
    $$('[data-lv-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.lvTab === S.lvTab)));
    const list = lvFiltered();
    const body = $('#lv-rows');
    if (!S.lvLoaded) body.innerHTML = '<tr><td colspan="12" class="cmp-empty"><span class="spinner" aria-hidden="true"></span> Loading leave applications…</td></tr>';
    else if (S.lvError) body.innerHTML = `<tr><td colspan="12" class="cmp-empty">${esc(S.lvError)}</td></tr>`;
    else if (!list.length) body.innerHTML = `<tr><td colspan="12" class="cmp-empty">${S.leaves.length ? 'No leave applications match your search or filter.' : '<strong>No leave applications yet</strong><span>Employees apply by sending "apply for leave" to the Ikris WhatsApp number.</span>'}</td></tr>`;
    else body.innerHTML = list.map((r) => `
      <tr data-lv="${esc(r.id)}" class="hr-click" tabindex="0" aria-label="Open ${esc(r.request_id)}">
        <td class="mono"><b>${esc(r.request_id)}</b>${r.hr_review_flag ? ' <span class="hr-flagdot" title="' + esc(r.hr_review_flag) + '">!</span>' : ''}</td>
        <td class="mono">${esc(r.employee_code_snapshot)}</td>
        <td>${esc(r.employee_name_snapshot)}</td>
        <td>${esc(r.designation_snapshot || '—')}</td>
        <td>${esc(r.manager_name_snapshot)}</td>
        <td class="nowrap">${esc(date(r.from_date))}</td>
        <td class="nowrap">${esc(date(r.to_date))}</td>
        <td class="hr-reason">${esc(r.leave_reason)}</td>
        <td class="nowrap small">${esc(dateTime(r.applied_at))}</td>
        <td>${statusBadge(r.status)}</td>
        <td class="hr-reason">${esc(r.rejection_reason || '—')}</td>
        <td class="nowrap small">${esc(r.decision_at ? dateTime(r.decision_at) : '—')}</td>
      </tr>`).join('');
    $('#lv-info').textContent = S.lvLoaded ? `Showing ${num(list.length)} of ${num(S.leaves.length)} applications` : '';
  }

  async function openLeave(id) {
    const r = S.leaves.find((x) => x.id === id);
    if (!r) return;
    $('#lv-view-title').textContent = r.request_id;
    $('#lv-view-sub').innerHTML = `${statusBadge(r.status)} · ${esc(r.employee_name_snapshot)}`;
    const rows = [['Request ID', r.request_id], ['Status', r.status], ['Employee ID', r.employee_code_snapshot], ['Employee Name', r.employee_name_snapshot],
      ['Designation', r.designation_snapshot || '—'], ['Employee WhatsApp', phone(r.employee_whatsapp_snapshot)],
      ['Reporting Manager', `${r.manager_name_snapshot}${r.manager_code_snapshot ? ` (${r.manager_code_snapshot})` : ''}`], ['Manager WhatsApp', phone(r.manager_whatsapp_snapshot)],
      ['From Date', date(r.from_date)], ['To Date', date(r.to_date)], ['Days', String(days(r.from_date, r.to_date))], ['Reason', r.leave_reason],
      ['Application Date', dateTime(r.applied_at)], ['Decision', r.decision_at ? `${r.status} by ${r.decided_by_name || r.manager_name_snapshot}` : 'Waiting for reporting manager'],
      ['Decision Time', r.decision_at ? dateTime(r.decision_at) : '—'], ['Rejection Reason', r.rejection_reason || '—']];
    $('#lv-view-body').innerHTML = `${r.hr_review_flag ? `<div class="hr-flag">HR review: ${esc(r.hr_review_flag)}</div>` : ''}
      <dl class="hr-dl">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <p class="hr-note"><svg aria-hidden="true"><use href="#i-shield"/></svg>Only the reporting manager can approve or reject, on WhatsApp.</p>
      <h3 class="hr-h3">WhatsApp notifications</h3><div class="table-wrap"><table class="table hr-mini"><thead><tr><th>Message</th><th>To</th><th>Status</th><th>Time</th></tr></thead><tbody id="lv-view-notes"><tr><td colspan="4" class="muted small">Loading…</td></tr></tbody></table></div>
      <h3 class="hr-h3">History</h3><ol class="hr-audit" id="lv-view-audit"><li class="muted small">Loading…</li></ol>`;
    openDialog('lv-view');
    const [n, a] = await Promise.all([
      client().from('leave_notifications').select('*').eq('leave_request_id', id).order('created_at'),
      client().from('leave_request_audit').select('*').eq('leave_request_id', id).order('action_timestamp')
    ]);
    if ($('#lv-view').hidden) return;
    const KIND = { manager_card: 'Approval card to manager', hr_new: 'New application to HR', hr_decision: 'Decision to HR', employee_decision: 'Decision to employee' };
    const ROLE = { manager: 'Manager', hr: 'HR', employee: 'Employee' };
    const N = n.data || [];
    $('#lv-view-notes').innerHTML = N.length ? N.map((x) => `<tr><td>${esc(KIND[x.kind] || x.kind)}</td><td class="small">${esc(ROLE[x.recipient_role] || '')} · <span class="mono">${esc(phone(x.phone))}</span></td>
      <td><span class="cmp-badge cmp-badge--${x.status === 'failed' ? 'failed' : x.status === 'pending' ? 'scheduled' : 'done'}">${esc(x.status[0].toUpperCase() + x.status.slice(1))}</span>${x.error ? `<div class="small hr-missing">${esc(x.error)}</div>` : ''}</td>
      <td class="small nowrap">${esc(dateTime(x.updated_at))}</td></tr>`).join('') : '<tr><td colspan="4" class="muted small">No notifications.</td></tr>';
    const A = a.data || [];
    const LBL = { submitted: 'Submitted on WhatsApp', approved: 'Approved', rejected: 'Rejected', flagged: 'Flagged for HR review' };
    $('#lv-view-audit').innerHTML = A.length ? A.map((x) => `<li><b>${esc(LBL[x.action_type] || x.action_type)}</b> <span class="muted small">${esc(dateTime(x.action_timestamp))} · ${esc(x.action_performed_by || '')}</span>${x.rejection_reason ? `<div class="small">Reason: ${esc(x.rejection_reason)}</div>` : ''}${x.details && x.details.note ? `<div class="small">${esc(x.details.note)}</div>` : ''}</li>`).join('') : '<li class="muted small">No history.</li>';
  }

  /* ---------------- events ---------------- */
  function bind() {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t.closest('[data-view="employees"], [data-view="leave"], #emp-dialog, #emp-view, #emp-confirm, #lv-view, #hr-scrim')) return;
      let el;
      if (t.closest('[data-hr-close]') || t === $('#hr-scrim')) return void closeDialogs();
      if (t.closest('#emp-add')) return void openEmployeeForm(null);
      if (t.closest('#emp-refresh')) return void loadEmployees();
      if (t.closest('#lv-refresh')) return void loadLeaves();
      if ((el = t.closest('[data-emp-view]'))) return void openEmployeeView(el.dataset.empView);
      if ((el = t.closest('[data-emp-edit]'))) return void openEmployeeForm(el.dataset.empEdit);
      if ((el = t.closest('[data-emp-deact]'))) return void askDeactivate(el.dataset.empDeact);
      if ((el = t.closest('[data-emp-react]'))) return void setStatus(el.dataset.empReact, 'active');
      if (t.closest('#emp-confirm-yes') && S.confirming) return void setStatus(S.confirming, 'inactive');
      if ((el = t.closest('[data-lv-tab]'))) { S.lvTab = el.dataset.lvTab; renderLeaves(); return; }
      if ((el = t.closest('[data-lv]'))) return void openLeave(el.dataset.lv);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#hr-scrim') && !$('#hr-scrim').hidden) closeDialogs();
      if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-lv]')) openLeave(e.target.dataset.lv);
    });
    $('#emp-search').addEventListener('input', debounce((e) => { S.empQ = e.target.value.trim(); renderEmployees(); }, 150));
    $('#emp-status').addEventListener('change', (e) => { S.empStatus = e.target.value; renderEmployees(); });
    $('#lv-search').addEventListener('input', debounce((e) => { S.lvQ = e.target.value.trim(); renderLeaves(); }, 150));
    $('#emp-f-mgr').addEventListener('change', showManagerInfo);
    $('#emp-form').addEventListener('submit', saveEmployee);
  }

  /* ---------------- public API ---------------- */
  function init(context) { ctx = context; bind(); }
  async function start(user) {
    S = fresh();
    S.user = user;
    try {
      const { data } = await client().from('chat_staff').select('role, departments').eq('email', String(user.email || '').toLowerCase()).maybeSingle();
      S.allowed = !!data && (data.role === 'admin' || (data.departments || []).some((d) => norm(d) === 'hr'));
    } catch (_) { S.allowed = false; }
    S.checked = true;
    applyAccess();
    if (!S.allowed) return;
    loadEmployees();
    loadLeaves();
    if (ctx.isViewing('employees') || ctx.isViewing('leave')) onShow(ctx.isViewing('leave') ? 'leave' : 'employees');
  }
  function stop() {
    closeDialogs();
    S = fresh();
    applyAccess();
    ['#emp-rows', '#lv-rows', '#emp-kpis', '#lv-kpis'].forEach((s) => { const el = $(s); if (el) el.innerHTML = ''; });
    $$('[data-emp-flags], [data-leave-pending]').forEach((b) => { b.hidden = true; });
  }
  function onShow(view) {
    applyAccess();
    if (!S.allowed) return;
    if (view === 'employees') { renderEmployees(); loadEmployees(); }
    if (view === 'leave') { renderLeaves(); loadLeaves(); if (!S.empLoaded) loadEmployees(); }
  }
  return { init, start, stop, onShow };
})();
