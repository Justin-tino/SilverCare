// Process Benefits board helpers — additive only.
(function () {
  function $(id) { return document.getElementById(id); }
  function setText(id, v) { var el = $(id); if (el) el.textContent = v; }
  function countItems(box) {
    if (!box) return 0;
    // Tables: count real <tr> rows (employee.js injects full <table> markup).
    var bodyRows = box.querySelectorAll('tbody tr');
    if (bodyRows.length) return bodyRows.length;
    var full = (box.textContent || '').trim();
    if (!full) return 0;
    // Empty-state placeholders are the only single-message contents employee.js writes.
    if (/^(No |Loading|All approved senior)/i.test(full)) return 0;
    var kids = Array.prototype.slice.call(box.children || []);
    if (!kids.length) return 1;
    if (kids.length === 1 && /No |Loading/i.test(full) && !box.querySelector('[data-pb-searchable]')) return 0;
    return kids.length;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/</g, '&lt;'); }
  function renderClaimedPensions() {
    var box = $('pensionClaimedContainer');
    if (!box) return;
    box.style.maxHeight = '380px';
    box.style.overflowY = 'auto';
    box.style.overflowX = 'hidden';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '10px';
    try {
      var users = window.lastUsersData || {};
      var rows = [];
      Object.entries(users).forEach(function (entry) {
        var u = entry[1];
        if (!u || u.role !== 'senior') return;
        // Deceased accounts stay in history but never show as live payouts —
        // skip them in the claimed-pension board column too.
        if (String(u.lifeStatus || '') === 'Deceased' || String(u.status || '') === 'Deceased') return;
        if (u.pensionSuspended) return;
        var benefits = (u.benefits && typeof u.benefits === 'object') ? Object.values(u.benefits) : [];
        benefits.forEach(function (b) {
          if (!b || !/pension/i.test(String(b.title || ''))) return;
          rows.push({
            name: u.name || 'Senior', sid: u.seniorId || '-',
            amount: b.amount || (function () {
              var _l = Number(u.pensionLocalAmount) || Number(u.pensionAmount) || 0;
              var _n = Number(u.pensionNationalAmount) || 0;
              var _q = _l * 3 + _n;
              return _q > 0 ? ('Local ₱' + _l.toLocaleString() + '/mo + National ₱' + _n.toLocaleString() + '/qtr') : '-';
            })(),
            ref: b.refNumber || b.reference || '-', when: b.approvedAt || b.createdAt || u.lastPensionMonth || ''
          });
        });
      });
      rows.sort(function (a, b) { return String(b.when).localeCompare(String(a.when)); });
      setText('pbMiniClaimedPension', rows.length + ' released');
      if (!rows.length) {
        box.innerHTML = '<div style="text-align:center;color:#71717a;padding:18px 12px;border:1px dashed #d4d4d8;border-radius:4px;font-size:0.85rem;">No claimed pension payouts yet.<br>Released Local + National pension payouts appear here.</div>';
        return;
      }
      var h = rows.slice(0, 30).map(function (r) {
        var when = r.when ? (isNaN(Number(r.when)) ? String(r.when) : new Date(Number(r.when)).toLocaleDateString()) : '-';
        return '<div data-pb-searchable style="border:1px solid #e4e4e7;border-radius:6px;padding:10px 12px;background:#fcfcfc;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;">' +
          '<div style="font-weight:700;color:#1e293b;font-size:0.85rem;overflow-wrap:anywhere;">' + esc(r.name) + '</div>' +
          '<div style="font-size:0.76rem;color:#71717a;overflow-wrap:anywhere;">ID: ' + esc(r.sid) + ' - Ref: ' + esc(r.ref) + ' - ' + esc(when) + '</div>' +
          '<div style="font-weight:700;color:#166534;font-size:0.85rem;margin-top:4px;">' + esc(r.amount) + '</div></div>';
      }).join('');
      if (rows.length > 30) h += '<div style="font-size:0.75rem;color:#71717a;margin-top:8px;">Showing latest 30 of ' + rows.length + '.</div>';
      box.innerHTML = h;
    } catch (e) { /* never break board */ }
  }
  function refreshCounts() {
    try {
      var cSetup = countItems($('pensionSetupContainer'));
      var cCfg = countItems($('pensionConfiguredContainer'));
      var cPen = 0;
      var pb = $('pensionClaimedContainer');
      if (pb && !/No claimed pension/i.test(pb.textContent || '')) {
        cPen = pb.querySelectorAll('[data-pb-searchable]').length || countItems(pb);
      }
      var cPend = countItems($('claimsListContainer'));
      var cPay = countItems($('claimsPayoutContainer'));
      var cClm = countItems($('claimsClaimedContainer'));
      var cHis = 0;
      var hb = $('claimsHistoryContainer');
      if (hb) {
        var rows = hb.querySelectorAll('tbody tr');
        if (rows.length) cHis = rows.length;
        else if (!/No claim history/i.test(hb.textContent || '')) cHis = countItems(hb);
      }
      setText('pbStatPendingSetup', cSetup); setText('pbStatWithPension', cCfg);
      setText('pbStatToPayout', cPay); setText('pbStatClaimed', cClm);
      setText('pbCountCol1', cSetup + cCfg); setText('pbCountCol2', cPen);
      setText('pbMiniPending', cSetup + ' waiting'); setText('pbMiniConfigured', cCfg + ' active');
      setText('pbMiniToPayout', cPay + ' ready'); setText('pbMiniClaimed', cClm + ' done');
      setText('pbCountPending', cPend); setText('pbCountHistory', cHis);
      var badge = $('approvedClaimsBadge');
      if (badge) { badge.textContent = cPay; badge.style.display = cPay > 0 ? 'inline-block' : 'none'; }
      updateReportStats();
    } catch (e) {}
  }

  // ── Generate Reports: appointments + benefits totals ───────────────────────
  // Live totals computed from the same data the board renders:
  //   queue  → seniors who made appointments / successful / pending / declined
  //   users  → total quarterly Local + National pension allocation across all seniors (PHP)
  //   claims → total claimed assistance (paid/claimed claims, PHP)
  function fmtPhp(v) { return 'PHP ' + Number(v || 0).toLocaleString(); }

  function computeReportStats() {
    var users = window.lastUsersData || {};
    var queues = window.lastQueuesData || {};
    var claims = window.lastClaimsData || {};
    var totalAppt = 0, successful = 0, pending = 0, declined = 0;
    var seniorsWhoBooked = {};
    Object.values(queues).forEach(function (q) {
      if (!q) return;
      totalAppt++;
      var key = q.uid || q.seniorUid || q.seniorId || '';
      if (key) seniorsWhoBooked[key] = true;
      var s = String(q.status || 'Pending');
      // Successful = approved and/or attended; Pending = pending/rescheduled;
      // Declined = declined by staff (same buckets the admin dashboard uses).
      if (s === 'Approved' || s === 'Attended') successful++;
      else if (s === 'Declined') declined++;
      else pending++;
    });
    var pensionTotal = 0, withPension = 0;
    Object.values(users).forEach(function (u) {
      if (!u || u.role !== 'senior') return;
      // Deceased accounts stop receiving pension — keep them out of totals.
      if (String(u.lifeStatus || '') === 'Deceased' || String(u.status || '') === 'Deceased') return;
      if (u.pensionSuspended) return;
      var _l = Number(u.pensionLocalAmount) || Number(u.pensionAmount) || 0;
      var _n = Number(u.pensionNationalAmount) || 0;
      var _q = _l * 3 + _n;
      if (_l > 0 && _n > 0) { pensionTotal += _q; withPension++; }
    });
    var assistanceTotal = 0, claimedCount = 0;
    Object.values(claims).forEach(function (c) {
      if (!c) return;
      var st = String(c.status || '');
      if (st === 'Claimed' || st === 'Paid') {
        claimedCount++;
        assistanceTotal += Number(c.paidAmount) || 0;
      }
    });
    return {
      totalAppt: totalAppt,
      totalSeniors: Object.keys(seniorsWhoBooked).length,
      successful: successful, pending: pending, declined: declined,
      pensionTotal: pensionTotal, withPension: withPension,
      assistanceTotal: assistanceTotal, claimedCount: claimedCount,
      combinedTotal: pensionTotal + assistanceTotal
    };
  }

  function updateReportStats() {
    try {
      var s = computeReportStats();
      setText('pbRepTotalSeniors', s.totalSeniors);
      setText('pbRepTotalAppt', s.totalAppt);
      setText('pbRepSuccessful', s.successful);
      setText('pbRepPending', s.pending);
      setText('pbRepDeclined', s.declined);
      setText('pbRepPensionTotal', fmtPhp(s.pensionTotal));
      setText('pbRepAssistanceTotal', fmtPhp(s.assistanceTotal));
      setText('pbRepCombined', fmtPhp(s.combinedTotal));
    } catch (e) { /* never break the board */ }
  }
  window.updatePbReportStats = updateReportStats;

  function queueSeniorOf(q, users) {
    return users[q.uid || q.seniorUid || ''] || null;
  }

  function generateReportCsv() {
    try {
      var users = window.lastUsersData || {};
      var queues = window.lastQueuesData || {};
      var claims = window.lastClaimsData || {};
      var s = computeReportStats();
      var d = new Date();
      var L = [];
      L.push(['SilverCare — OSCA Magalang · Process Benefits Report']);
      L.push(['Generated', d.toLocaleString(), 'By', (window.currentStaffName || 'OSCA Staff')]);
      L.push([]);
      L.push(['APPOINTMENTS SUMMARY']);
      L.push(['Seniors Who Made Appointments', s.totalSeniors]);
      L.push(['Total Appointments Made', s.totalAppt]);
      L.push(['Successful Appointments', s.successful]);
      L.push(['Pending Appointments', s.pending]);
      L.push(['Declined Appointments', s.declined]);
      L.push([]);
      L.push(['BENEFITS SUMMARY']);
      L.push(['Total Quarterly Pension Given (all seniors)', fmtPhp(s.pensionTotal)]);
      L.push(['Seniors With Pension', s.withPension]);
      L.push(['Total Claimed Assistance', fmtPhp(s.assistanceTotal)]);
      L.push(['Assistance Claims Paid', s.claimedCount]);
      L.push(['Combined Total (Pension + Assistance)', fmtPhp(s.combinedTotal)]);
      L.push([]);
      L.push(['APPOINTMENT DETAILS']);
      L.push(['Senior Name', 'OSCA ID', 'Service', 'Queue #', 'Status', 'Date']);
      Object.values(queues).forEach(function (q) {
        if (!q) return;
        var u = queueSeniorOf(q, users);
        L.push([
          (u && u.name) || q.seniorName || q.applicantName || 'Senior',
          q.seniorId || (u && u.seniorId) || 'N/A',
          q.service || 'General Consultation',
          q.queueNumber || 'N/A',
          q.status || 'Pending',
          q.date || (q.scheduledAt ? new Date(Number(q.scheduledAt)).toLocaleDateString() : '')
        ]);
      });
      L.push([]);
      L.push(['PENSION CONFIGURED (Local monthly + National quarterly)']);
      L.push(['Senior Name', 'OSCA ID', 'Local (Monthly)', 'National (Quarterly)', 'Quarterly Total', 'Set On', 'Set By']);
      Object.values(users).forEach(function (u) {
        if (!u || u.role !== 'senior') return;
        // Deceased accounts no longer receive pension — exclude from the report.
        if (String(u.lifeStatus || '') === 'Deceased' || String(u.status || '') === 'Deceased' || u.pensionSuspended) return;
        var _l = Number(u.pensionLocalAmount) || Number(u.pensionAmount) || 0;
        var _n = Number(u.pensionNationalAmount) || 0;
        if (_l > 0 && _n > 0) L.push([
          u.name || 'Senior', u.seniorId || 'N/A', fmtPhp(_l), fmtPhp(_n), fmtPhp(_l * 3 + _n),
          u.pensionSetAt ? new Date(Number(u.pensionSetAt)).toLocaleDateString() : '',
          u.pensionSetBy || ''
        ]);
      });
      appendClaimedRows(L, claims);
      var fname = 'SilverCare_Benefits_Report_' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.csv';
      var csv = L.map(function (r) { return r.map(toCell).join(','); }).join('\r\n');
      var blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = fname;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      if (window.scNotify) window.scNotify('success', 'Report generated — appointments + benefits totals included.');
    } catch (e) { if (window.scNotify) window.scNotify('error', 'Report generation failed. Please try again.'); }
  }

  function appendClaimedRows(L, claims) {
    L.push([]);
    L.push(['CLAIMED ASSISTANCE']);
    L.push(['Senior Name', 'OSCA ID', 'Service', 'Amount Paid', 'Reference #', 'Claimed On']);
    Object.values(claims || {}).forEach(function (c) {
      if (!c) return;
      var st = String(c.status || '');
      if (st !== 'Claimed' && st !== 'Paid') return;
      L.push([
        c.applicantName || 'Senior', c.seniorId || c.uid || 'N/A',
        c.serviceType || 'Welfare',
        fmtPhp(c.paidAmount),
        c.refNumber || '',
        c.paidAt ? new Date(Number(c.paidAt)).toLocaleDateString() : ''
      ]);
    });
  }
  function applySearch() {
    try {
      var q = (($('processBenefitsSearch') || {}).value || '').trim().toLowerCase();
      var ids = ['pensionSetupContainer', 'pensionConfiguredContainer', 'pensionClaimedContainer', 'claimsListContainer', 'claimsPayoutContainer', 'claimsClaimedContainer', 'claimsHistoryContainer'];
      ids.forEach(function (id) {
        var box = $(id);
        if (!box) return;
        if (id === 'claimsHistoryContainer') {
          box.querySelectorAll('tbody tr').forEach(function (tr) {
            var hit = (!q || (tr.textContent || '').toLowerCase().indexOf(q) > -1);
            tr.style.display = hit ? '' : 'none';
          });
          return;
        }
        Array.prototype.slice.call(box.children).forEach(function (child) {
          if (child.tagName === 'TABLE') {
            child.querySelectorAll('tbody tr').forEach(function (tr) {
              var hit2 = (!q || (tr.textContent || '').toLowerCase().indexOf(q) > -1);
              tr.style.display = hit2 ? '' : 'none';
            });
            return;
          }
          var hit3 = (!q || (child.textContent || '').toLowerCase().indexOf(q) > -1);
          child.style.display = hit3 ? '' : 'none';
        });
      });
    } catch (e) {}
  }

  function toCell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
  function exportBoard() {
    try {
      var users = window.lastUsersData || {};
      var claims = window.lastClaimsData || {};
      var rows = [['Section', 'Senior Name', 'Senior ID', 'Detail', 'Amount', 'Status/Ref', 'Date']];
      Object.entries(users).forEach(function (entry) {
        var u = entry[1];
        if (!u || u.role !== 'senior') return;
        // Deceased accounts stop receiving pension — keep them out of exports.
        var _dec = String(u.lifeStatus || '') === 'Deceased' || String(u.status || '') === 'Deceased' || u.pensionSuspended;
        var _l = Number(u.pensionLocalAmount) || Number(u.pensionAmount) || 0;
        var _n = Number(u.pensionNationalAmount) || 0;
        if (!_dec && _l > 0 && _n > 0) rows.push(['Pension-configured', u.name || '', u.seniorId || '', 'Local monthly + National quarterly', 'Local PHP ' + _l.toLocaleString() + ' + National PHP ' + _n.toLocaleString() + ' (Qtr PHP ' + (_l * 3 + _n).toLocaleString() + ')', u.pensionSetBy || '', u.pensionSetAt ? new Date(Number(u.pensionSetAt)).toLocaleDateString() : '']);
        var benefits = (u.benefits && typeof u.benefits === 'object') ? Object.values(u.benefits) : [];
        // Pension payouts of archived Deceased accounts stay in audit history
        // (claimed / paid records) but must never reappear as live pension rows.
        if (_dec) return;
        benefits.forEach(function (b) {
          if (!b || !/pension/i.test(String(b.title || ''))) return;
          rows.push(['Pension-claimed', u.name || '', u.seniorId || '', b.title || '', b.amount || '', b.refNumber || b.reference || '', b.approvedAt ? new Date(Number(b.approvedAt)).toLocaleDateString() : '']);
        });
      });
      Object.entries(claims).forEach(function (entry) {
        var id = entry[0], c = entry[1];
        if (!c) return;
        var when = c.claimedAt || c.processedAt || c.approvedAt || c.createdAt || '';
        rows.push(['Assistance-' + (c.status || 'Pending'), c.applicantName || '', c.seniorId || c.uid || '', (c.serviceType || '') + ' / ' + id, c.amount || '', c.refNumber || c.status || '', when ? new Date(Number(when)).toLocaleDateString() : '']);
      });
      var d = new Date();
      var fname = 'process-benefits-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.csv';
      var csv = rows.map(function (r) { return r.map(toCell).join(','); }).join('\r\n');
      var blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = fname;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      if (window.scNotify) window.scNotify('success', 'Board exported (' + (rows.length - 1) + ' rows).');
    } catch (e) { if (window.scNotify) window.scNotify('error', 'Export failed. Please try again.'); }
  }
  function toggleRow(btnId, bodyId, chevId, hintId) {
    var btn = $(btnId), body = $(bodyId);
    if (!btn || !body) return;
    btn.addEventListener('click', function () {
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      var ch = $(chevId); if (ch) ch.className = open ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
      var hh = $(hintId); if (hh) hh.textContent = open ? 'show' : 'hide';
    });
  }
  function initBoard() {
    var s = $('processBenefitsSearch');
    if (s) s.addEventListener('input', applySearch);
    // Claim-reference confirmation input was removed from the markup —
    // the Claim Reference stays displayed on each Not Claimed Yet card,
    // matched live against the DB (claim.refNumber = senior notification ref).
    var r = $('processBenefitsRefresh');
    if (r) r.addEventListener('click', function () { renderClaimedPensions(); refreshCounts(); applySearch(); if (window.scNotify) window.scNotify('success', 'Board refreshed.'); });
    // Report buttons are owned by pb-comprehensive-report.js (PDF/Excel modal).
    // Legacy CSV exports (exportBoard / generateReportCsv below) are retired.
    var pr = $('pbPrintReport');
    if (pr) pr.addEventListener('click', function () { window.print(); });
    var p = $('processBenefitsPrint');
    if (p) p.addEventListener('click', function () { window.print(); });
    toggleRow('pbPendingToggle', 'pbPendingBody', 'pbPendingChevron', 'pbPendingHint');
    toggleRow('pbHistoryToggle', 'pbHistoryBody', 'pbHistoryChevron', 'pbHistoryHint');
    var ids = ['pensionSetupContainer', 'pensionConfiguredContainer', 'claimsListContainer', 'claimsPayoutContainer', 'claimsClaimedContainer', 'claimsHistoryContainer'];
    ids.forEach(function (id) {
      var box = $(id);
      if (!box || !window.MutationObserver) return;
      var t = null;
      new MutationObserver(function () {
        clearTimeout(t);
        t = setTimeout(function () {
          renderClaimedPensions(); refreshCounts(); applySearch();
        }, 120);
      }).observe(box, { childList: true, subtree: true });
    });
    var tries = 0;
    var boot = setInterval(function () {
      tries++;
      renderClaimedPensions(); refreshCounts(); applySearch();
      if (tries > 40) clearInterval(boot);
    }, 500);
    renderClaimedPensions(); refreshCounts();
  }
  window.initProcessBenefitsBoard = initBoard;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBoard);
  else initBoard();
})();

