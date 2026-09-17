/* NOVA interactions — palette, ripple, reveals, counters, toasts, loading.
   Progressive enhancement. No dependencies beyond jQuery (optional). */
(function () {
  'use strict';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- CSRF: attach session token to every non-safe fetch ---------- */
  (function csrfFetch() {
    var originalFetch = window.fetch;
    var cachedToken = null;
    function readToken() {
      var m = document.querySelector('meta[name="csrf-token"]');
      return m && m.getAttribute('content') ? m.getAttribute('content') : '';
    }
    function token() {
      if (cachedToken) return cachedToken;
      cachedToken = readToken();
      return cachedToken;
    }
    window.fetch = function (input, init) {
      init = init || {};
      var method = String(init.method || (typeof input === 'string' ? 'GET' : 'GET')).toUpperCase();
      var nonSafe = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
      if (nonSafe) {
        var t = token();
        if (t) {
          init.headers = init.headers || {};
          if (init.headers instanceof Headers) {
            if (!init.headers.has('X-CSRF-Token')) init.headers.set('X-CSRF-Token', t);
          } else {
            init.headers['X-CSRF-Token'] = t;
          }
        }
      }
      return originalFetch.call(window, input, init);
    };
    // Refresh the cached token if the page re-serves it (SPA-ish nav).
    window.__vmpCsrf = { refresh: function () { cachedToken = readToken(); } };
  })();

  /* ---------- main landmark for skip link ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    var main = document.querySelector('.main-panel .content');
    if (main && !main.id) { main.id = 'vmpMain'; main.setAttribute('tabindex', '-1'); }
  });

  /* ---------- ripple (feedback) ---------- */
  document.addEventListener('pointerdown', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.btn, .sidebar .nav-link, .btn-fab') : null;
    if (!btn || reduced) return;
    var rect = btn.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);
    var ripple = document.createElement('span');
    ripple.className = 'vmp-ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    setTimeout(function () { ripple.remove(); }, 650);
  });

  /* ---------- staggered reveal (orientation) ---------- */
  function revealize() {
    var cards = document.querySelectorAll('.card, .vmp-auth-hero');
    cards.forEach(function (el, i) {
      if (el.classList.contains('vmp-reveal') || el.classList.contains('vmp-in')) return;
      el.classList.add('vmp-reveal');
      el.style.transitionDelay = Math.min(i * 45, 400) + 'ms';
    });
    var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('vmp-in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.06 }) : null;
    document.querySelectorAll('.vmp-reveal:not(.vmp-in)').forEach(function (el) {
      if (io) io.observe(el); else el.classList.add('vmp-in');
    });
  }

  /* ---------- animated counters ---------- */
  function animateCount(el) {
    var raw = (el.getAttribute('data-count') || el.textContent || '').replace(/[^0-9]/g, '');
    if (!raw) return;
    var target = parseInt(raw, 10);
    if (isNaN(target)) return;
    if (reduced) { el.textContent = target; return; }
    var start = null, dur = 1100;
    function frame(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  function counters() {
    var nums = document.querySelectorAll('.vmp-stat-num[data-count]');
    if (!('IntersectionObserver' in window)) { nums.forEach(animateCount); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { animateCount(en.target); io.unobserve(en.target); }
      });
    }, { threshold: 0.4 });
    nums.forEach(function (el) { io.observe(el); });
  }

  /* ---------- navbar scroll glow ---------- */
  function navbar() {
    var nav = document.querySelector('.navbar');
    if (!nav) return;
    var onScroll = function () { nav.classList.toggle('vmp-scrolled', window.scrollY > 12); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------- mobile sidebar ---------- */
  window.vmpToggleNav = function (force) {
    var open = typeof force === 'boolean' ? force : !document.body.classList.contains('vmp-nav-open');
    document.body.classList.toggle('vmp-nav-open', open);
  };
  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('.sidebar .nav-link') : null;
    if (link && window.innerWidth <= 991) document.body.classList.remove('vmp-nav-open');
  });

  /* ---------- loading buttons + toast mirror ---------- */
  window.vmpLoading = function (btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.vmpLabel = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="vmp-spinner" aria-hidden="true"></span>' + (label || 'Working…');
    } else {
      btn.disabled = false;
      if (btn.dataset.vmpLabel) btn.innerHTML = btn.dataset.vmpLabel;
    }
  };
  // Track the button that fired an ajax action so it can spin until the toast lands.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('button[onclick*="ajax"], button[onclick*="Pay"], button[onclick*="pay"]') : null;
    if (btn && !btn.disabled) {
      window._vmpPendingBtn = btn;
      window.vmpLoading(btn, true);
      setTimeout(function () { window.vmpLoading(btn, false); }, 15000); // failsafe
    }
  }, true);
  function announce(msg) {
    var live = document.getElementById('vmpLiveRegion');
    if (live) { live.textContent = ''; setTimeout(function () { live.textContent = msg; }, 30); }
  }

  window.vmpToast = function (message, type) {
    var msg = String(message).slice(0, 300);
    announce(msg);
    try {
      if (window.$ && $.notify) {
        $.notify({ icon: type === 'success' ? 'check_circle' : 'add_alert', message: msg },
          { type: type === 'success' ? 'success' : 'warning', timer: 3200, placement: { from: 'top', align: 'right' } });
        return;
      }
    } catch (e) { /* fall through */ }
    alert(msg);
  };

  /* ---------- settings radios → segmented toggles / swatches ---------- */
  function enhanceSettingRadios() {
    var groups = {};
    document.querySelectorAll('input[type="radio"][name]').forEach(function (r) {
      (groups[r.name] = groups[r.name] || []).push(r);
    });
    Object.keys(groups).forEach(function (name) {
      var radios = groups[name];
      if (radios[0].closest('.vmp-seg, .vmp-swatches')) return;
      var vals = radios.map(function (r) { return r.value; }).sort().join(',');
      var isYesNo = vals === '0,1';
      var isTheme = name === 'color_theme';
      if (!isYesNo && !isTheme) return;
      var wrap = document.createElement('div');
      wrap.className = isTheme ? 'vmp-swatches' : 'vmp-seg';
      wrap.setAttribute('role', 'radiogroup');
      wrap.setAttribute('aria-label', name);
      var host = radios[0].parentNode.parentNode;
      var empties = [];
      // Keep DOM order: it already reads Yes-then-No in every group.
      radios.forEach(function (r) {
        var label = document.querySelector('label[for="' + r.id + '"]');
        if (r.parentNode && r.parentNode !== host) empties.push(r.parentNode);
        wrap.appendChild(r);
        if (label) {
          if (label.parentNode && label.parentNode !== host && empties.indexOf(label.parentNode) === -1) empties.push(label.parentNode);
          wrap.appendChild(label);
        }
      });
      host.appendChild(wrap);
      empties.forEach(function (d) { if (!d.textContent.trim() && !d.querySelector('input,label')) d.remove(); });
    });
  }

  /* ---------- delegated checkout (PayU / Razorpay, no inline JSON) ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-checkout]') : null;
    if (!btn || btn.disabled) return;
    var payload = {};
    try { payload = JSON.parse(decodeURIComponent(btn.getAttribute('data-payload') || '%7B%7D')); }
    catch (err) { window.vmpToast('Could not start checkout', 'warning'); return; }
    var type = btn.getAttribute('data-buytype') || 'newPurchase';
    var gateway = btn.getAttribute('data-gateway');
    try {
      if (gateway === 'payu' && typeof initPayUpayment === 'function') initPayUpayment(payload, type);
      else if (gateway === 'razorpay' && typeof initRazorpayPayment === 'function') initRazorpayPayment(payload, type);
      else window.vmpToast('Checkout unavailable', 'warning');
    } catch (err) { window.vmpToast('Could not start checkout', 'warning'); }
  });

  /* ---------- copy buttons ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!btn) return;
    var text = btn.getAttribute('data-copy') || '';
    function done() { window.vmpToast('Copied to clipboard', 'success'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { window.vmpToast('Copy failed', 'warning'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { window.vmpToast('Copy failed', 'warning'); }
      ta.remove();
    }
  });

  /* ---------- client table filter ---------- */
  document.addEventListener('input', function (e) {
    var input = e.target && e.target.closest ? e.target.closest('[data-table-filter]') : null;
    if (!input) return;
    var table = document.querySelector(input.getAttribute('data-table-filter'));
    if (!table) return;
    var q = input.value.toLowerCase();
    table.querySelectorAll('tbody tr').forEach(function (tr) {
      tr.style.display = tr.textContent.toLowerCase().indexOf(q) === -1 ? 'none' : '';
    });
  });

  /* ---------- command palette ---------- */
  // Roles: guest | steam | admin | super (super implies admin).
  // Guests must never see admin destinations or privileged actions.
  function vmpRole() {
    var r = window.VMP_ROLE || {};
    return {
      admin: !!r.admin,
      superAdmin: !!r.superAdmin,
      steam: !!r.steam
    };
  }
  function vmpCan(item) {
    var role = vmpRole();
    var need = item.roles || ['guest', 'steam', 'admin'];
    if (need.indexOf('super') !== -1 && role.superAdmin) return true;
    if (need.indexOf('admin') !== -1 && role.admin) return true;
    if (need.indexOf('steam') !== -1 && role.steam) return true;
    if (need.indexOf('guest') !== -1 && !role.admin && !role.steam) return true;
    if (need.indexOf('user') !== -1 && (role.admin || role.steam)) return true;
    return false;
  }
  var PALETTE = [
    { icon: 'grid_view', label: 'Go to Dashboard', hint: 'page', href: '/dashboard', roles: ['guest', 'steam', 'admin'] },
    { icon: 'storefront', label: 'Go to VIP Store', hint: 'page', href: '/mydashboard', roles: ['steam'] },
    { icon: 'stars', label: 'Manage VIPs', hint: 'admin', href: '/managevip', roles: ['admin'] },
    { icon: 'admin_panel_settings', label: 'Manage Admins', hint: 'admin', href: '/manageadmin', roles: ['admin'] },
    { icon: 'payments', label: 'Sales Records', hint: 'admin', href: '/salesrecord', roles: ['super'] },
    { icon: 'manage_history', label: 'Audit Logs', hint: 'admin', href: '/auditlogs', roles: ['super'] },
    { icon: 'tune', label: 'Panel Settings', hint: 'admin', href: '/panelsetting', roles: ['admin'] },
    { icon: 'login', label: 'Log In', hint: 'page', href: '/login', roles: ['guest'] },
    { icon: 'brightness_6', label: 'Toggle Light / Dark Mode', hint: 'action', roles: ['guest', 'steam', 'admin'], run: function () { window.vmpToggleTheme(); } },
    { icon: 'cached', label: 'Refresh All Servers Now', hint: 'action', roles: ['admin'], run: function () {
      fetch('/performmanualrefresh', { method: 'POST' }).then(function (r) { return r.json(); })
        .then(function (res) { window.vmpToast(res && res.success ? 'Servers refreshed' : 'Refresh failed', res && res.success ? 'success' : 'warning'); })
        .catch(function () { window.vmpToast('Refresh failed', 'warning'); });
    } },
    { icon: 'logout', label: 'Log Out', hint: 'action', href: '/logout', roles: ['user'] }
  ];
  var palIndex = 0;
  window.vmpTogglePalette = function (force) {
    var open = typeof force === 'boolean' ? force : !document.body.classList.contains('vmp-palette-open');
    document.body.classList.toggle('vmp-palette-open', open);
    var pal = document.getElementById('vmpPalette');
    if (pal) pal.style.display = open ? 'block' : 'none';
    if (open) {
      palIndex = 0;
      var input = document.getElementById('vmpPaletteInput');
      input.value = '';
      renderPalette('');
      setTimeout(function () { input.focus(); }, 30);
    }
  };
  function paletteItems(q) {
    q = (q || '').toLowerCase();
    return PALETTE.filter(function (p) {
      return vmpCan(p) && p.label.toLowerCase().indexOf(q) !== -1;
    });
  }
  function renderPalette(q) {
    var list = document.getElementById('vmpPaletteList');
    if (!list) return;
    var items = paletteItems(q);
    palIndex = Math.max(0, Math.min(palIndex, items.length - 1));
    list.innerHTML = items.length ? items.map(function (p, i) {
      return '<button class="vmp-pal-item" role="option" data-pal="' + i + '" aria-selected="' + (i === palIndex) + '">' +
        '<i class="material-icons" aria-hidden="true">' + p.icon + '</i><span>' + p.label + '</span><small>' + p.hint + '</small></button>';
    }).join('') : '<div class="vmp-empty"><h5>No matches</h5><div>Try a different search.</div></div>';
    list.querySelectorAll('[data-pal]').forEach(function (btn) {
      btn.addEventListener('click', function () { runPalette(items[parseInt(btn.getAttribute('data-pal'), 10)]); });
    });
    list._items = items;
  }
  function runPalette(item) {
    if (!item) return;
    window.vmpTogglePalette(false);
    if (item.run) { item.run(); return; }
    window.location = item.href;
  }
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); window.vmpTogglePalette(); return; }
    if (!document.body.classList.contains('vmp-palette-open')) return;
    var input = document.getElementById('vmpPaletteInput');
    var list = document.getElementById('vmpPaletteList');
    var items = (list && list._items) || [];
    if (e.key === 'Escape') { window.vmpTogglePalette(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); palIndex = Math.min(palIndex + 1, items.length - 1); renderPalette(input.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palIndex = Math.max(palIndex - 1, 0); renderPalette(input.value); }
    else if (e.key === 'Enter') { runPalette(items[palIndex]); }
  });
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'vmpPaletteInput') { palIndex = 0; renderPalette(e.target.value); }
  });

  /* ---------- empty tables (observer: ajax fills replace content) ---------- */
  function paintEmpty(tb, msg) {
    if (tb.rows.length !== 0) return;
    var cols = (tb.closest('table').querySelectorAll('thead th') || []).length || 3;
    var tr = document.createElement('tr');
    tr.className = 'vmp-empty-row';
    tr.innerHTML = '<td colspan="' + cols + '"><div class="vmp-empty">' +
      '<i class="material-icons" aria-hidden="true">inbox</i><h5>Nothing here yet</h5>' +
      '<div>' + msg + '</div></div></td>';
    tb.appendChild(tr);
  }
  function emptyTables() {
    document.querySelectorAll('table tbody').forEach(function (tb) {
      if (tb.dataset.vmpEmptyDone) return;
      tb.dataset.vmpEmptyDone = '1';
      paintEmpty(tb, 'Select a server above to load records.');
    });
    if (!window._vmpEmptyObs && ('MutationObserver' in window)) {
      var obs = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          if (m.target.tagName === 'TBODY' && !m.target.querySelector('.vmp-empty-row')) {
            paintEmpty(m.target, 'No records found.');
          }
        });
      });
      document.querySelectorAll('table tbody').forEach(function (tb) {
        obs.observe(tb, { childList: true });
      });
      window._vmpEmptyObs = obs;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    revealize(); counters(); navbar(); emptyTables(); enhanceSettingRadios();
    setTimeout(emptyTables, 2500);
    // Safety net: pages without notifications.js still get working toasts.
    // Adapts showNotif({success, data}) shape onto vmpToast(message, type).
    if (typeof window.showNotif !== 'function') {
      window.showNotif = function (response) {
        try {
          var ok = response && (response.success === true || response.success === 'true');
          var d = (response && response.data) || {};
          var msg = d.message || d.error || 'Done';
          window.vmpToast(msg, ok ? 'success' : 'warning');
        } catch (e) { /* non-fatal */ }
      };
    }
    // Stacked toasts cascade from under the navbar instead of piling up.
    try {
      if (window.$ && $.notifyDefaults) {
        $.notifyDefaults({ offset: { x: 14, y: 96 }, spacing: 10, newest_on_top: true, delay: 3200 });
      }
    } catch (e) { /* non-fatal */ }
    // Settle any spinning action button when its toast lands.
    if (typeof window.showNotif === 'function' && !window.showNotif._vmpWrapped) {
      var orig = window.showNotif;
      var wrapped = function (response) {
        if (window._vmpPendingBtn) { window.vmpLoading(window._vmpPendingBtn, false); window._vmpPendingBtn = null; }
        try {
          var msg = response && response.data && (response.data.message || response.data.error);
          if (msg) announce(typeof msg === 'string' ? msg.slice(0, 300) : 'Done');
        } catch (e) { /* non-fatal */ }
        return orig(response);
      };
      wrapped._vmpWrapped = true;
      window.showNotif = wrapped;
    }
  });
})();
