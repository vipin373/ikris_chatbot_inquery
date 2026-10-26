/* =====================================================================
   IKRIS — UI motion layer (presentation only)
   • collapsible sidebar (desktop) with tooltips, remembered per browser
   • pointer spotlight on cards, press ripple on buttons
   • count-up animation for statistics when their value changes
   • entrance animation for newly arrived chat messages
   It only reads the DOM and adds classes / CSS variables. It never calls
   the backend, never changes data and never replaces an existing handler.
   ===================================================================== */
(function () {
  'use strict';

  const reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (_) { /* storage unavailable: preference just isn't remembered */ } }
  };

  /* ---------- collapsible sidebar ---------- */
  function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const btn = document.getElementById('sidebar-collapse');
    if (!sidebar || !btn) return;
    const apply = (collapsed) => {
      sidebar.classList.toggle('is-collapsed', collapsed);
      btn.setAttribute('aria-pressed', String(collapsed));
      const label = collapsed ? 'Expand navigation' : 'Collapse navigation';
      btn.setAttribute('aria-label', label);
      btn.title = label;
    };
    apply(store.get('ikris.sidebar') === 'collapsed');
    btn.addEventListener('click', () => {
      const next = !sidebar.classList.contains('is-collapsed');
      apply(next);
      store.set('ikris.sidebar', next ? 'collapsed' : 'open');
    });
  }

  /* ---------- pointer spotlight (one delegated, rAF-throttled listener) ---------- */
  function initSpotlight() {
    const SEL = '.kpi, .dept, .tpl-card, .integ-card, .hook-card';
    let raf = 0, last = null;
    document.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = last.target instanceof Element ? last.target.closest(SEL) : null;
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${last.clientX - r.left}px`);
        el.style.setProperty('--my', `${last.clientY - r.top}px`);
      });
    }, { passive: true });
  }

  /* ---------- press ripple ---------- */
  function initRipple() {
    document.addEventListener('pointerdown', (e) => {
      if (reduce.matches || e.button !== 0) return;
      const btn = e.target instanceof Element ? e.target.closest('.btn') : null;
      if (!btn || btn.disabled || btn.getAttribute('aria-busy') === 'true') return;
      const r = btn.getBoundingClientRect();
      const dot = document.createElement('span');
      dot.className = 'ik-ripple';
      dot.setAttribute('aria-hidden', 'true');
      dot.style.left = `${e.clientX - r.left}px`;
      dot.style.top = `${e.clientY - r.top}px`;
      btn.appendChild(dot);
      setTimeout(() => dot.remove(), 600);
    }, { passive: true });
  }

  /* ---------- count-up statistics ---------- */
  // Values are re-rendered by the app on every refresh; animate only when a value changes.
  const VALUE_SEL = '.kpi__value, .cmp-stat__value, .dept__count';
  const prev = new Map();
  const NUM = /^([\d,]+(?:\.\d+)?)(.*)$/s;

  function keyFor(el) {
    const tile = el.closest('.kpi, .cmp-stat, .dept');
    const label = tile && tile.querySelector('.kpi__label, .cmp-stat__label, .dept__name');
    const box = el.closest('[id]');
    return `${box ? box.id : ''}|${label ? label.textContent.trim() : ''}`;
  }

  function countUp(el) {
    // .dept__count holds "<number><small>…</small>": only animate its first text node.
    const node = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : null;
    if (!node) return;
    const finalText = node.nodeValue;
    const m = finalText.trim().match(NUM);
    if (!m) return;
    const to = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(to)) return;
    const key = keyFor(el);
    const from = prev.has(key) ? prev.get(key) : 0;
    prev.set(key, to);
    if (reduce.matches || from === to || document.hidden) return;
    const dec = (m[1].split('.')[1] || '').length;
    const fmt = (v) => v.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    const lead = finalText.match(/^\s*/)[0];
    const dur = Math.min(900, 420 + Math.abs(to - from) * 6);
    const t0 = performance.now();
    const step = (now) => {
      if (!node.isConnected) return;
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      node.nodeValue = p < 1 ? lead + fmt(from + (to - from) * eased) + m[2] : finalText;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- chat message entrance ---------- */
  let lastIds = new Set();
  function markNewMessages(box) {
    const els = box.querySelectorAll('[data-msg]');
    const ids = new Set(Array.from(els, (el) => el.dataset.msg));
    // Same conversation (some ids overlap) → animate only the messages that just arrived.
    const sameThread = Array.from(ids).some((id) => lastIds.has(id));
    if (sameThread && !reduce.matches) {
      els.forEach((el) => { if (!lastIds.has(el.dataset.msg)) el.classList.add('msg--enter'); });
    }
    lastIds = ids;
  }

  function initObservers() {
    const root = document.getElementById('app') || document.body;
    const mo = new MutationObserver((muts) => {
      let msgBox = null;
      for (const mu of muts) {
        for (const n of mu.addedNodes) {
          if (n.nodeType !== 1) continue;               // our own text updates add text nodes only: ignored
          if (n.matches(VALUE_SEL)) countUp(n);
          n.querySelectorAll && n.querySelectorAll(VALUE_SEL).forEach(countUp);
          if (mu.target.id === 'chat-messages') msgBox = mu.target;
        }
      }
      if (msgBox) markNewMessages(msgBox);
    });
    mo.observe(root, { childList: true, subtree: true });
  }

  function init() {
    initSidebar();
    initSpotlight();
    initRipple();
    initObservers();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
