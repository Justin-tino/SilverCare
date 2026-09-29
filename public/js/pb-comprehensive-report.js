// SilverCare — Process Benefits comprehensive report (PDF / Excel).
// Additive module: converts the old CSV-only exports into an automated report
// covering: (1) senior population per barangay / status / sex,
// (2) pension + assistance distribution summaries,
// (3) health status + high-risk cases,
// (4) pending applications + compliance status.
// Zero new npm dependencies: Excel = .xls HTML workbook (opens in Excel /
// Sheets), PDF = styled print window (destination: Save as PDF).
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function notify(type, msg) { if (window.scNotify) window.scNotify(type, msg); }
  function escH(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function archivedStatuses() { return ['Inactive', 'Deceased', 'Transferred', 'Archived']; }
  function seniorLocalPension(u) {
    if (!u) return 0;
    var l = Number(u.pensionLocalAmount);
    if (!isNaN(l) && l > 0) return l;
    var legacy = Number(u.pensionAmount);
    return (!isNaN(legacy) && legacy > 0) ? legacy : 0;
  }
  function seniorNationalPension(u) {
    if (!u) return 0;
    var n = Number(u.pensionNationalAmount);
    return (!isNaN(n) && n > 0) ? n : 0;
  }
  function seniorQuarterlyTotal(u) {
    return (seniorLocalPension(u) * 3) + seniorNationalPension(u);
  }
  function isSeniorPensionEnrolled(u) {
    return seniorLocalPension(u) > 0 && seniorNationalPension(u) > 0;
  }
  function seniorStatus(u) { return String((u && (u.lifeStatus || u.status)) || 'Active'); }
  function isSenior(u) { return !!u && u.role === 'senior'; }
  function isArchived(u) { return isSenior(u) && archivedStatuses().indexOf(seniorStatus(u)) > -1; }
  function isVerified(u) { return !!u && (u.kycStatus === 'Verified' || !!u.kycVerifiedAt); }
  function seniorAge(u) {
    var n = Number(u && u.age);
    if (n > 0) return n;
    if (u && u.dob) {
      var b = new Date(u.dob);
      if (!isNaN(b.getTime())) {
        var t = new Date(), a = t.getFullYear() - b.getFullYear();
        var m = t.getMonth() - b.getMonth();
        if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
        if (a > 0) return a;
      }
    }
    return 0;
  }
  function hasIllness(u) {
    if (!u) return false;
    var c = String(u.healthCondition || u.condition || u.illness || u.preExistingConditions || '').trim();
    if (!c) return false;
    return !/^(none|none reported|no illness|healthy|no illness \/ healthy)$/i.test(c);
  }
  function priorityOf(u) {
    if (!u) return 'Low';
    var s = String(u.staffPriorityLevel || '').trim();
    if (s === 'High' || s === 'Medium' || s === 'Low') return s;
    if (hasIllness(u)) return 'High';
    var age = seniorAge(u);
    if (age >= 100) return 'High';
    if (age >= 90) return 'Medium';
    return 'Low';
  }
  function fmtPhp(v) { return 'PHP ' + Number(v || 0).toLocaleString(); }
  function fmtDate(ts) {
    if (ts === null || ts === undefined || ts === '') return '';
    var d = new Date(Number(ts));
    if (!isNaN(d.getTime())) return d.toLocaleDateString();
    return String(ts);
  }
  function claimAmount(c) {
    if (!c) return 0;
    var p = Number(c.paidAmount);
    if (p > 0) return p;
    var a = Number(c.amount);
    if (a > 0) return a;
    var t = String(c.serviceType || '').toLowerCase();
    if (t === 'burial') return 10000;
    if (t === 'bedridden') return 1500;
    return 0;
  }
  function serviceLabel(t) {
    var s = String(t || '').toLowerCase();
    if (s === 'burial') return 'Burial (Death)';
    if (s === 'bedridden') return 'Bedridden';
    return t ? String(t).toUpperCase() : 'WELFARE';
  }
  function stampName(prefix, ext) {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return prefix + '_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + '.' + ext;
  }
  function getSelection() {
    function checked(id, fallback) {
      var el = $(id);
      return el ? !!el.checked : fallback;
    }
    return {
      population: checked('pbRepSecPopulation', true),
      benefits: checked('pbRepSecBenefits', true),
      health: checked('pbRepSecHealth', true),
      pending: checked('pbRepSecPending', true)
    };
  }
  function countMap(list, keyFn) {
    var m = {};
    list.forEach(function (x) { var k = keyFn(x) || 'N/A'; m[k] = (m[k] || 0) + 1; });
    return Object.keys(m).sort().map(function (k) { return [k, m[k]]; });
  }
  function collectData() {
    var users = window.lastUsersData || {};
    var claims = window.lastClaimsData || {};
    var queues = window.lastQueuesData || {};
    var allSeniors = [];
    Object.keys(users).forEach(function (uid) {
      var u = users[uid];
      if (!isSenior(u)) return;
      allSeniors.push({ uid: uid, data: u });
    });
    var active = allSeniors.filter(function (s) { return !isArchived(s.data); });
    var meta = {
      generatedAt: new Date().toLocaleString(),
      generatedBy: (window.currentStaffName || 'OSCA Staff'),
      totalSeniors: allSeniors.length,
      activeSeniors: active.length,
      archivedSeniors: allSeniors.length - active.length
    };
    return { meta: meta, allSeniors: allSeniors, active: active, claims: claims, queues: queues };
  }
  function displayName(s) { return (s.data && s.data.name) || 'Senior'; }
  function displaySid(s) { var u = s.data || {}; return u.seniorId || u.verificationSeniorId || 'N/A'; }
  function displayBarangay(s) { var u = s.data || {}; return (u.barangay || 'N/A'); }
  function displaySex(s) { var u = s.data || {}; return (u.sex || 'N/A'); }
  function buildPopulation(data) {
    var all = data.allSeniors;
    var byBrgy = countMap(all, displayBarangay);
    var byStatus = countMap(all, function (s) { return seniorStatus(s.data); });
    var bySex = countMap(all, displaySex);
    var verified = all.filter(function (s) { return isVerified(s.data); }).length;
    var summary = [['Total senior records', all.length], ['Active seniors', data.meta.activeSeniors],
      ['Archived (Inactive/Deceased/Transferred)', data.meta.archivedSeniors], ['Verified (KYC)', verified],
      ['Pending / unverified KYC', all.length - verified]];
    var headers = ['Senior Name', 'OSCA ID', 'Age', 'Barangay', 'Status', 'Sex', 'KYC'];
    var rows = all.map(function (s) {
      var u = s.data || {}; var age = seniorAge(u);
      return [u.name || 'Senior', u.seniorId || u.verificationSeniorId || 'N/A', age || 'N/A',
        u.barangay || 'N/A', seniorStatus(u), u.sex || 'N/A', isVerified(u) ? 'Verified' : (u.kycStatus || 'Pending')];
    });
    rows.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
    return { id: 'population', title: '1. Senior Citizen Population (per Barangay, Status, Sex)',
      summary: summary, breakdowns: [
        { label: 'Per barangay', pairs: byBrgy }, { label: 'Per status', pairs: byStatus }, { label: 'Per sex', pairs: bySex }],
      headers: headers, rows: rows };
  }
  function buildBenefits(data) {
    var active = data.active;
    var withPension = active.filter(function (s) { return isSeniorPensionEnrolled(s.data); });
    var pensionLocalTotal = 0;
    var pensionNationalTotal = 0;
    var pensionQuarterlyGrand = 0;
    withPension.forEach(function (s) {
      var l = seniorLocalPension(s.data);
      var n = seniorNationalPension(s.data);
      pensionLocalTotal += l;
      pensionNationalTotal += n;
      pensionQuarterlyGrand += (l * 3) + n;
    });
    var claimsArr = [];
    Object.keys(data.claims || {}).forEach(function (id) { var c = data.claims[id]; if (c) claimsArr.push({ id: id, c: c }); });
    function isClaimed(c) { return c && (c.status === 'Claimed' || c.status === 'Paid'); }
    var claimed = claimsArr.filter(function (x) { return isClaimed(x.c); });
    var assistTotal = 0;
    claimed.forEach(function (x) { assistTotal += Number(x.c.paidAmount) || 0; });
    var awaiting = claimsArr.filter(function (x) { return x.c && (x.c.status === 'Approved' || x.c.status === 'Approved_Pending_Payout'); });
    var awaitingTotal = 0;
    awaiting.forEach(function (x) { awaitingTotal += claimAmount(x.c); });
    var summary = [
      ['Seniors with pension setup', withPension.length],
      ['Total monthly local pension (all active seniors)', fmtPhp(pensionLocalTotal)],
      ['Total quarterly national pension (all active seniors)', fmtPhp(pensionNationalTotal)],
      ['Quarterly combined pension allocation', fmtPhp(pensionQuarterlyGrand)],
      ['Claimed / paid assistance claims', claimed.length],
      ['Total claimed assistance', fmtPhp(assistTotal)],
      ['Awaiting payout (approved, not claimed)', awaiting.length],
      ['Awaiting payout amount', fmtPhp(awaitingTotal)],
      ['Quarterly combined total (pension + claimed assistance)', fmtPhp(pensionQuarterlyGrand + assistTotal)]
    ];
    var headers = ['Senior Name', 'OSCA ID', 'Kind', 'Detail / Service', 'Amount', 'Ref / Status', 'Date'];
    var rows = [];
    withPension.forEach(function (s) {
      var u = s.data || {};
      var l = seniorLocalPension(u);
      var n = seniorNationalPension(u);
      var q = (l * 3) + n;
      var detail = 'Local PHP ' + l.toLocaleString() + '/mo + National PHP ' + n.toLocaleString() + '/qtr';
      rows.push([u.name || 'Senior', u.seniorId || 'N/A', 'Pension (Dual Model)', detail, 'Qtr ' + fmtPhp(q), u.pensionSetBy || '', fmtDate(u.pensionSetAt)]);
    });
    claimed.forEach(function (x) {
      var c = x.c || {};
      rows.push([c.applicantName || 'Senior', c.seniorId || c.uid || 'N/A', 'Claimed assistance',
        serviceLabel(c.serviceType), fmtPhp(c.paidAmount), c.refNumber || c.status || '', fmtDate(c.paidAt || c.approvedAt || c.createdAt)]);
    });
    rows.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
    return { id: 'benefits', title: '2. Pension & Assistance Distribution Summary',
      summary: summary, breakdowns: [], headers: headers, rows: rows,
      totals: { pensionTotal: pensionQuarterlyGrand, assistTotal: assistTotal, claimed: claimed.length, withPension: withPension.length } };
  }
  function buildHealth(data) {
    var active = data.active;
    var high = [], med = [], low = [];
    active.forEach(function (s) {
      var p = priorityOf(s.data);
      if (p === 'High') high.push(s); else if (p === 'Medium') med.push(s); else low.push(s);
    });
    var withCond = active.filter(function (s) { return hasIllness(s.data); });
    var queuesArr = [];
    Object.keys(data.queues || {}).forEach(function (id) { var q = data.queues[id]; if (q) queuesArr.push(q); });
    var apptPending = queuesArr.filter(function (q) { return ['Pending', 'Rescheduled'].indexOf(String(q.status || 'Pending')) > -1; }).length;
    var apptDone = queuesArr.filter(function (q) { return ['Approved', 'Attended'].indexOf(String(q.status || '')) > -1; }).length;
    var summary = [['Seniors with reported condition', withCond.length], ['High-risk (High priority)', high.length],
      ['Medium priority', med.length], ['Low priority', low.length],
      ['Appointments pending / rescheduled', apptPending], ['Appointments approved / attended', apptDone]];
    var headers = ['Senior Name', 'OSCA ID', 'Health Condition', 'Priority', 'Last Checkup / Visit', 'Appointment Status'];
    function lastVisit(uid, u) {
      var best = null;
      queuesArr.forEach(function (q) {
        if (!q || (q.uid !== uid && q.seniorUid !== uid)) return;
        var t = Number(q.attendedAt || q.scheduledAt || q.updatedAt || q.createdAt || 0);
        if (!best || t > best.t) best = { t: t, q: q };
      });
      return best ? best.q : null;
    }
    var rows = active.map(function (s) {
      var u = s.data || {};
      var q = lastVisit(s.uid, u);
      var cond = String(u.healthCondition || u.condition || u.illness || 'None reported');
      var visit = q ? ((q.date || fmtDate(q.scheduledAt || q.attendedAt)) + (q.time ? ' ' + q.time : '')) : 'No visit on record';
      return [u.name || 'Senior', u.seniorId || 'N/A', cond, priorityOf(u), visit, q ? (q.status || 'Pending') : 'No appointment'];
    });
    rows.sort(function (a, b) {
      var order = { High: 0, Medium: 1, Low: 2 };
      var d = (order[a[3]] == null ? 9 : order[a[3]]) - (order[b[3]] == null ? 9 : order[b[3]]);
      return d || String(a[0]).localeCompare(String(b[0]));
    });
    return { id: 'health', title: '3. Health Status & High-Risk Cases', summary: summary,
      breakdowns: [{ label: 'Per priority level', pairs: [['High (high-risk)', high.length], ['Medium', med.length], ['Low', low.length]] }],
      headers: headers, rows: rows, highCount: high.length };
  }
  function buildPending(data) {
    var active = data.active;
    var kycPending = active.filter(function (s) {
      var u = s.data || {}; var k = String(u.kycStatus || '');
      return !isVerified(u) && (k === 'Pending' || k === 'Submitted' || !u.kycStatus);
    });
    var noPension = active.filter(function (s) { return isVerified(s.data) && !isSeniorPensionEnrolled(s.data); });
    var claimsArr = [];
    Object.keys(data.claims || {}).forEach(function (id) { var c = data.claims[id]; if (c) claimsArr.push({ id: id, c: c }); });
    var pendingClaims = claimsArr.filter(function (x) { return x.c && x.c.status === 'Pending'; });
    var awaiting = claimsArr.filter(function (x) { return x.c && (x.c.status === 'Approved' || x.c.status === 'Approved_Pending_Payout'); });
    var queuesArr = [];
    Object.keys(data.queues || {}).forEach(function (id) { var q = data.queues[id]; if (q) queuesArr.push(q); });
    var pendingAppt = queuesArr.filter(function (q) { return ['Pending', 'Rescheduled'].indexOf(String(q.status || 'Pending')) > -1; });
    var summary = [['Pending KYC / verification', kycPending.length], ['Verified but no pension setup', noPension.length],
      ['Pending assistance claims (awaiting approval)', pendingClaims.length],
      ['Approved claims awaiting payout', awaiting.length], ['Pending / rescheduled appointments', pendingAppt.length]];
    var headers = ['Senior Name', 'OSCA ID', 'Pending Item', 'Detail', 'Since / Filed'];
    var rows = [];
    var usersByUid = {};
    active.forEach(function (s) { usersByUid[s.uid] = s.data || {}; });
    function nm(uid, fb) { var u = usersByUid[uid] || {}; return u.name || fb || 'Senior'; }
    function sid(uid, fb) { var u = usersByUid[uid] || {}; return u.seniorId || fb || 'N/A'; }
    kycPending.forEach(function (s) {
      rows.push([s.data.name || 'Senior', s.data.seniorId || 'N/A', 'KYC verification', String(s.data.kycStatus || 'Pending'), fmtDate(s.data.kycSubmittedAt || s.data.createdAt)]);
    });
    noPension.forEach(function (s) {
      rows.push([s.data.name || 'Senior', s.data.seniorId || 'N/A', 'Pension setup', 'Verified — Local/National pension amounts not set', '']);
    });
    pendingClaims.forEach(function (x) {
      var c = x.c || {}; var uid = c.uid || c.seniorUid || '';
      rows.push([c.applicantName || nm(uid, 'Senior'), c.seniorId || sid(uid, 'N/A'),
        'Assistance claim — pending approval', serviceLabel(c.serviceType) + ' · ' + (c.refNumber || x.id), fmtDate(c.createdAt)]);
    });
    awaiting.forEach(function (x) {
      var c2 = x.c || {}; var uid2 = c2.uid || c2.seniorUid || '';
      rows.push([c2.applicantName || nm(uid2, 'Senior'), c2.seniorId || sid(uid2, 'N/A'),
        'Assistance payout — ready to claim', serviceLabel(c2.serviceType) + ' · ' + fmtPhp(claimAmount(c2)), fmtDate(c2.approvedAt || c2.createdAt)]);
    });
    pendingAppt.forEach(function (q) {
      rows.push([q.seniorName || q.applicantName || nm(q.uid || q.seniorUid || '', 'Senior'),
        q.seniorId || sid(q.uid || q.seniorUid || '', 'N/A'), 'Appointment — ' + String(q.status || 'Pending'),
        (q.service || 'General Consultation') + ' · ' + (q.queueNumber || ''), q.date || fmtDate(q.scheduledAt || q.createdAt)]);
    });
    rows.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
    return { id: 'pending', title: '4. Pending Applications & Compliance Status',
      summary: summary, breakdowns: [], headers: headers, rows: rows };
  }
  function buildSections(data, sel) {
    var out = [];
    if (sel.population) out.push(buildPopulation(data));
    if (sel.benefits) out.push(buildBenefits(data));
    if (sel.health) out.push(buildHealth(data));
    if (sel.pending) out.push(buildPending(data));
    return out;
  }
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 600);
  }
  function exportExcel(meta, sections) {
    var css = '.h{background:#065f46;color:#ffffff;font-weight:bold;}'
      + '.t{background:#1e293b;color:#ffffff;font-weight:bold;}'
      + '.s{background:#f1f5f9;font-weight:bold;} .n{mso-number-format:"\\@";}';
    var h = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">';
    h += '<head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets>';
    sections.forEach(function (s, i) {
      h += '<x:ExcelWorksheet><x:Name>' + escH(('S' + (i + 1) + '-' + s.id).slice(0, 31)) + '</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet>';
    });
    h += '</x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--><style>' + css + '</style></head><body>';
    h += '<h2>SilverCare — OSCA Magalang · Comprehensive Report</h2>';
    h += '<p>Generated: ' + escH(meta.generatedAt) + ' · Prepared by: ' + escH(meta.generatedBy)
      + ' · Seniors: ' + meta.totalSeniors + ' (Active ' + meta.activeSeniors + ', Archived ' + meta.archivedSeniors + ')</p>';
    sections.forEach(function (s) {
      h += '<h3>' + escH(s.title) + '</h3>';
      h += '<table border="1"><thead><tr><th class="t" colspan="2">Summary</th></tr></thead><tbody>';
      s.summary.forEach(function (p) { h += '<tr><td class="s">' + escH(p[0]) + '</td><td><b>' + escH(p[1]) + '</b></td></tr>'; });
      (s.breakdowns || []).forEach(function (b) {
        h += '<tr><td class="s" colspan="2">' + escH(b.label) + '</td></tr>';
        b.pairs.forEach(function (p2) { h += '<tr><td>' + escH(p2[0]) + '</td><td>' + escH(p2[1]) + '</td></tr>'; });
      });
      h += '</tbody></table><br/>';
      h += '<table border="1"><thead><tr>';
      s.headers.forEach(function (c) { h += '<th class="h">' + escH(c) + '</th>'; });
      h += '</tr></thead><tbody>';
      if (!s.rows.length) h += '<tr><td colspan="' + s.headers.length + '">No records for this section.</td></tr>';
      s.rows.forEach(function (r) {
        h += '<tr>';
        r.forEach(function (c) { h += '<td class="n">' + escH(c) + '</td>'; });
        h += '</tr>';
      });
      h += '</tbody></table><br/><br/>';
    });
    h += '</body></html>';
    downloadBlob(new Blob(['\uFEFF' + h], { type: 'application/vnd.ms-excel;charset=utf-8' }), stampName('SilverCare_Comprehensive_Report', 'xls'));
  }
  function exportPdf(meta, sections) {
    var w = window.open('', '_blank', 'width=1100,height=750');
    if (!w) { notify('warning', 'Please allow pop-ups to export the PDF report.'); return; }
    var totalRows = 0;
    sections.forEach(function (s) { totalRows += s.rows.length; });
    var h = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>SilverCare Comprehensive Report</title>';
    h += '<style>body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;padding:28px;}'
      + 'h1{font-size:20px;margin:0;} p.meta{color:#64748b;font-size:12px;}'
      + 'h2{font-size:15px;margin:26px 0 8px;color:#065f46;border-bottom:2px solid #065f46;padding-bottom:4px;}'
      + 'table{width:100%;border-collapse:collapse;margin-top:10px;font-size:11.5px;}'
      + 'th{background:#065f46;color:#fff;padding:7px 8px;border:1px solid #065f46;text-align:left;}'
      + 'td{padding:6px 8px;border:1px solid #cbd5e1;vertical-align:top;}'
      + 'tr:nth-child(even) td{background:#f8fafc;} .sum td{background:#f1f5f9;font-weight:bold;}'
      + '.brk td{background:#e2e8f0;font-weight:bold;} .muted{color:#64748b;font-size:11px;}'
      + '@media print{ .noprint{display:none;} h2{page-break-after:avoid;} table{page-break-inside:auto;} tr{page-break-inside:avoid;} }</style></head><body>';
    h += '<h1>SilverCare — OSCA Magalang · Comprehensive Report</h1>';
    h += '<p class="meta">Generated: ' + escH(meta.generatedAt) + ' · Prepared by: ' + escH(meta.generatedBy)
      + ' · Seniors: ' + meta.totalSeniors + ' (Active ' + meta.activeSeniors + ', Archived ' + meta.archivedSeniors + ') · Rows: ' + totalRows + '</p>';
    h += '<p class="muted noprint">In the print dialog, choose <strong>Save as PDF</strong> as the destination.</p>';
    sections.forEach(function (s) {
      h += '<h2>' + escH(s.title) + '</h2>';
      h += '<table><tbody>';
      s.summary.forEach(function (p) { h += '<tr class="sum"><td>' + escH(p[0]) + '</td><td>' + escH(p[1]) + '</td></tr>'; });
      (s.breakdowns || []).forEach(function (b) {
        h += '<tr class="brk"><td colspan="2">' + escH(b.label) + '</td></tr>';
        b.pairs.forEach(function (p2) { h += '<tr><td>' + escH(p2[0]) + '</td><td>' + escH(p2[1]) + '</td></tr>'; });
      });
      h += '</tbody></table>';
      h += '<table><thead><tr>';
      s.headers.forEach(function (c) { h += '<th>' + escH(c) + '</th>'; });
      h += '</tr></thead><tbody>';
      if (!s.rows.length) h += '<tr><td>No records for this section.</td></tr>';
      s.rows.forEach(function (r) {
        h += '<tr>';
        r.forEach(function (c) { h += '<td>' + escH(c) + '</td>'; });
        h += '</tr>';
      });
      h += '</tbody></table>';
    });
    h += '<p class="muted" style="margin-top:20px;">End of report.</p>';
    h += '</body></html>';
    w.document.write(h);
    w.document.close();
    w.focus();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 450);
  }
  function openModal() {
    var m = $('pbReportModal');
    if (!m) { fallbackGenerate('excel'); return; }
    var note = $('pbReportModalNote');
    if (note) note.style.display = 'none';
    m.style.display = 'flex';
  }
  function closeModal() {
    var m = $('pbReportModal');
    if (m) m.style.display = 'none';
  }
  window.openPbReportModal = openModal;
  window.closePbReportModal = closeModal;
  function fallbackGenerate(kind) {
    var sel = { population: true, benefits: true, health: true, pending: true };
    runGenerate(kind, sel);
  }
  function runGenerate(kind, sel) {
    var data = collectData();
    var sections = buildSections(data, sel);
    if (!sections.length) {
      var note = $('pbReportModalNote');
      if (note) note.style.display = 'block';
      notify('warning', 'Select at least one section to generate the report.');
      return;
    }
    if (!data.allSeniors.length) {
      notify('warning', 'No senior records available to include in the report yet.');
      return;
    }
    try {
      if (kind === 'pdf') {
        notify('info', 'Opening PDF report — choose "Save as PDF" in the print dialog.');
        exportPdf(data.meta, sections);
      } else {
        exportExcel(data.meta, sections);
        var total = 0;
        sections.forEach(function (s) { total += s.rows.length; });
        notify('success', 'Excel report downloaded (' + total + ' rows across ' + sections.length + ' sections).');
      }
    } catch (e) { notify('error', 'Report generation failed. Please try again.'); }
  }
  window.generatePbReportFile = function (kind) { runGenerate(kind, getSelection()); };
  function bindButtons() {
    function takeOver(id) {
      var el = $(id);
      if (!el || el.getAttribute('data-pb-report') === '1') return false;
      var fresh = el.cloneNode(true);
      fresh.setAttribute('data-pb-report', '1');
      if (el.parentNode) el.parentNode.replaceChild(fresh, el);
      fresh.addEventListener('click', function (ev) { if (ev) ev.preventDefault(); openModal(); });
      return true;
    }
    var hooked = false;
    if (takeOver('processBenefitsExport')) hooked = true;
    if (takeOver('pbGenerateReport')) hooked = true;
    var m = $('pbReportModal');
    if (m && !m.getAttribute('data-pb-report')) {
      m.setAttribute('data-pb-report', '1');
      m.addEventListener('click', function (ev) { if (ev.target === m) closeModal(); });
      document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeModal(); });
    }
    return hooked;
  }
  window.pbReportSelfTest = function () {
    try {
      var data = collectData();
      var sels = { population: true, benefits: true, health: true, pending: true };
      var sections = buildSections(data, sels);
      return { ok: true, seniors: data.allSeniors.length, sections: sections.map(function (s) { return s.id + ':' + s.rows.length; }) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindButtons);
  else bindButtons();
  var tries = 0;
  var timer = setInterval(function () { tries++; bindButtons(); if (tries > 40) clearInterval(timer); }, 500);
})();
