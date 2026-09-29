import { auth, db } from './firebase-init.js';
import { ref, get, update, onValue } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-database.js";

// Manage Seniors — employee can view + edit senior account info.
// Firebase RTDB stays the source of truth (users/{uid}); edits are
// audit-logged and mirrored to Supabase via /api/supabase/sync-senior.
window.manageSeniorsFilter = window.manageSeniorsFilter || 'all';
const ARCHIVED_LIFE = ['Inactive', 'Deceased', 'Transferred', 'Archived'];
let manageSeniorsCache = [];
let manageSeniorsBound = false;

function msEsc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function msVal(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}
function msSet(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = (v == null ? '' : String(v));
}
function msNotify(type, msg) {
  if (window.scNotify) { try { window.scNotify(type, msg); return; } catch (e) {} }
  try { alert(msg); } catch (e) {}
}
// Shared "Are you sure?" dialog — reuses the employee confirm modal and falls
// back to the native confirm() when the modal is not on the page.
function msConfirm(message, onConfirm) {
  const modal = document.getElementById('empConfirmModal');
  const msgEl = document.getElementById('empConfirmMessage');
  const yesBtn = document.getElementById('empConfirmYesBtn');
  const noBtn = document.getElementById('empConfirmNoBtn');
  if (!modal || !msgEl || !yesBtn || !noBtn) {
    if (window.confirm(message)) onConfirm();
    return;
  }
  msgEl.textContent = message;
  modal.style.display = 'flex';
  const cleanup = () => {
    modal.style.display = 'none';
    yesBtn.onclick = null;
    noBtn.onclick = null;
  };
  yesBtn.onclick = () => { cleanup(); onConfirm(); };
  noBtn.onclick = cleanup;
}
function msIsArchived(u) {
  const life = String((u && (u.lifeStatus || u.status)) || 'Active');
  return ARCHIVED_LIFE.indexOf(life) > -1;
}
function msIsDeceased(u) {
  const life = String((u && (u.lifeStatus || u.status)) || 'Active');
  return life === 'Deceased';
}
function msStatusOf(u) {
  if (!u) return 'Unknown';
  if (String(u.status || '') === 'Pending') return 'Pending';
  return String(u.lifeStatus || u.status || 'Active');
}
function msStatusBadge(u) {
  const s = msStatusOf(u);
  let bg = '#dcfce7', fg = '#166534';
  if (s === 'Pending') { bg = '#fef9c3'; fg = '#854d0e'; }
  else if (s === 'Deceased') { bg = '#e2e8f0'; fg = '#1e293b'; }
  else if (ARCHIVED_LIFE.indexOf(s) > -1 && s !== 'Active') { bg = '#f1f5f9'; fg = '#475569'; }
  return '<span style="background:' + bg + '; color:' + fg + '; padding:4px 12px; border-radius:999px; font-size:0.75rem; font-weight:700; white-space:nowrap;">' + msEsc(s) + '</span>';
}
function msAge(u) {
  const n = Number(u && u.age);
  if (n > 0) return n;
  if (u && u.dob) {
    const b = new Date(u.dob); const t = new Date();
    if (!isNaN(b.getTime())) {
      let a = t.getFullYear() - b.getFullYear();
      const m = t.getMonth() - b.getMonth();
      if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
      if (a > 0) return a;
    }
  }
  return null;
}
function msCalcAge(dobStr) {
  if (!dobStr) return null;
  const b = new Date(dobStr); const t = new Date();
  if (isNaN(b.getTime())) return null;
  let a = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
  return a >= 0 ? a : null;
}
// Manage Seniors helpers (P2: collect + filter).
function msCollectSeniors() {
  const src = (window.lastUsersData && typeof window.lastUsersData === 'object')
    ? window.lastUsersData : {};
  const out = [];
  Object.entries(src).forEach(([uid, u]) => {
    if (!u || u.role !== 'senior') return;
    out.push({ uid, ...(u) });
  });
  out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return out;
}
function msMatchesFilter(entry) {
  const f = window.manageSeniorsFilter || 'all';
  const u = entry;
  if (f === 'active') return String(u.status || '') !== 'Pending' && !msIsArchived(u);
  if (f === 'pending') return String(u.status || '') === 'Pending';
  if (f === 'archived') return msIsArchived(u);
  return true;
}
function msMatchesSearch(entry, q) {
  if (!q) return true;
  const hay = [entry.name, entry.firstName, entry.lastName, entry.seniorId, entry.verificationSeniorId, entry.email, entry.cpNumber, entry.address, entry.barangay, entry.city, entry.province].map(v => String(v || '').toLowerCase()).join(' | ');
  return hay.indexOf(q) > -1;
}
function renderManageSeniorsList() {
  const body = document.getElementById('manageSeniorsTableBody');
  if (!body) return;
  const q = String((document.getElementById('seniorSearchInput') || {}).value || '').trim().toLowerCase();
  const rows = manageSeniorsCache.filter(e => msMatchesFilter(e) && msMatchesSearch(e, q));
  const pill = document.getElementById('seniorCountPill');
  if (pill) pill.textContent = rows.length + (rows.length === 1 ? ' account' : ' accounts');
  if (!manageSeniorsCache.length) {
    body.innerHTML = '<tr><td colspan="6" style="padding: 26px; text-align: center; color: #94a3b8;">No senior accounts yet. They appear here after registration.</td></tr>';
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" style="padding: 26px; text-align: center; color: #94a3b8;">No accounts match your search/filter.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((s) => {
    const age = msAge(s);
    const contact = s.cpNumber || '—';
    const addr = [s.address, s.barangay, s.city].filter(Boolean).join(', ') || '—';
    return '<tr style="border-top: 1px solid #f1f5f9;">'
      + '<td style="padding: 12px 14px;"><div style="font-weight: 700; color: #1e293b;">' + msEsc(s.name || 'Unnamed Senior') + '</div>'
      + '<div style="font-size: 0.75rem; color: #64748b; margin-top: 2px;">' + msEsc(s.email || 'No email') + (age != null ? ' &bull; ' + age + ' yrs old' : '') + '</div></td>'
      + '<td style="padding: 12px 14px; font-weight: 700; color: #1e293b; white-space: nowrap;">' + msEsc(s.seniorId || 'N/A') + '</td>'
      + '<td style="padding: 12px 14px; color: #334155; white-space: nowrap;">' + msEsc(contact) + '</td>'
      + '<td style="padding: 12px 14px; color: #334155; max-width: 240px;">' + msEsc(addr) + '</td>'
      + '<td style="padding: 12px 14px;">' + msStatusBadge(s) + '</td>'
      + '<td style="padding: 12px 14px; text-align: right; white-space: nowrap;">'
      + '<button type="button" onclick="window.openManageSeniorsEditor(\'' + msEsc(s.uid) + '\')" style="border: 1px solid #2563eb; background: #2563eb; color: white; border-radius: 7px; padding: 7px 14px; font-size: 0.78rem; font-weight: 700; cursor: pointer;"><i class="fas fa-pen" style="margin-right: 5px;"></i>Edit</button>'
      // Deceased: archive the account of a senior who has passed away (no more
      // pension / benefit payouts). Hidden once the record is already Deceased.
      + (msIsDeceased(s) ? ''
        : '<button type="button" onclick="window.markSeniorDeceased(\'' + msEsc(s.uid) + '\')" title="Mark this senior as Deceased — the account moves to the Archive and stops receiving pension" style="border: 1px solid #475569; background: #475569; color: white; border-radius: 7px; padding: 7px 14px; font-size: 0.78rem; font-weight: 700; cursor: pointer; margin-left: 6px;"><i class="fas fa-book-dead" style="margin-right: 5px;"></i>Deceased</button>')
      + '</td></tr>';
  }).join('');
}
window.renderManageSeniors = function () {
  manageSeniorsCache = msCollectSeniors();
  renderManageSeniorsList();
};
window.filterManageSeniors = function () { renderManageSeniorsList(); };
window.setManageSeniorsFilter = function (f, btn) {
  window.manageSeniorsFilter = f || 'all';
  document.querySelectorAll('.senior-filter-btn').forEach((b) => {
    const on = b.getAttribute('data-filter') === window.manageSeniorsFilter;
    b.style.border = on ? '1px solid #2563eb' : '1px solid #cbd5e1';
    b.style.background = on ? '#eff6ff' : 'white';
    b.style.color = on ? '#1d4ed8' : '#475569';
  });
  renderManageSeniorsList();
};
// Manage Seniors editor open/close (P3).
function msShowNotice(msg, kind) {
  const box = document.getElementById('seniorEditNotice');
  if (!box) return;
  box.style.display = 'block';
  const ok = kind === 'ok';
  box.style.background = ok ? '#f0fdf4' : '#fef2f2';
  box.style.border = ok ? '1px solid #bbf7d0' : '1px solid #fecaca';
  box.style.color = ok ? '#15803d' : '#991b1b';
  box.textContent = msg;
}
function msHideNotice() {
  const box = document.getElementById('seniorEditNotice');
  if (box) { box.style.display = 'none'; box.textContent = ''; }
}
window.openManageSeniorsEditor = function (uid) {
  const found = (manageSeniorsCache || []).find(e => e.uid === uid)
    || (((window.lastUsersData || {})[uid] && { uid, ...(window.lastUsersData[uid]) }) || null);
  if (!found || found.role !== 'senior') { msNotify('error', 'Senior account not found.'); return; }
  msSet('seniorEditUid', uid);
  msSet('seniorEditName', found.name || '');
  msSet('seniorEditFirstName', found.firstName || '');
  msSet('seniorEditLastName', found.lastName || '');
  msSet('seniorEditMiddleName', found.middleName || '');
  msSet('seniorEditExtension', found.extension || '');
  msSet('seniorEditSeniorId', found.seniorId || '');
  msSet('seniorEditEmail', found.email || '');
  msSet('seniorEditCp', found.cpNumber || '');
  msSet('seniorEditDob', found.dob || '');
  msSet('seniorEditSex', found.sex || '');
  msSet('seniorEditCivil', found.civilStatus || '');
  msSet('seniorEditAddress', found.address || '');
  msSet('seniorEditBarangay', found.barangay || '');
  msSet('seniorEditCity', found.city || '');
  msSet('seniorEditProvince', found.province || '');
  msSet('seniorEditPostal', found.postalCode || '');
  msHideNotice();
  const sub = document.getElementById('seniorEditSub');
  if (sub) sub.textContent = 'Editing: ' + (found.name || found.email || uid) + '  •  Senior ID: ' + (found.seniorId || 'N/A');
  // Already-deceased records cannot be marked again — hide the action button.
  const decBtn = document.getElementById('seniorEditDeceasedBtn');
  if (decBtn) decBtn.style.display = msIsDeceased(found) ? 'none' : 'inline-block';
  const modal = document.getElementById('manageSeniorsEditModal');
  if (modal) { modal.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
};
window.closeManageSeniorsEditor = function () {
  const modal = document.getElementById('manageSeniorsEditModal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
  msHideNotice();
};
// ── Deceased (Archive) action ────────────────────────────────────────────────
// Marks a senior account as DECEASED when the senior citizen has passed away.
// The account is moved out of the active roster (main dashboard + every
// processing list) and into the Archive, keeps its history (no data is
// deleted), and stops receiving pension / benefits:
//   • every pension + benefit list already skips archived life statuses
//     (see isArchivedSenior in employee.js)
//   • /api/eligibility/check refuses any record whose status is not "Active"
//   • logging in with the account is blocked and the person is told to visit
//     OSCA (see the login gate in public/js/main.js)
// Pension amounts are preserved so OSCA staff can restore the record from the
// Archive tab if the senior was reported deceased by mistake.
window.markSeniorDeceased = function (uidArg) {
  const uid = String(uidArg || msVal('seniorEditUid') || '').trim();
  if (!uid) { msNotify('error', 'No senior account selected.'); return; }
  const rec = (manageSeniorsCache || []).find(e => e.uid === uid)
    || (((window.lastUsersData || {})[uid] && { uid, ...(window.lastUsersData[uid]) }) || {});
  const name = rec.name || rec.email || 'this senior';
  if (rec.role && rec.role !== 'senior') { msNotify('error', 'That account is not a senior account.'); return; }
  if (msIsDeceased(rec)) {
    msNotify('warning', name + ' is already marked as Deceased — the account is already in the archive.');
    return;
  }
  const label = name + (rec.seniorId ? ' (' + rec.seniorId + ')' : '');
  msConfirm('Mark ' + label + ' as DECEASED? The account will be moved to the Archive, will no longer receive any pension or benefit, and anyone who tries to log in will be told to visit the OSCA office. OSCA staff can still restore the record from the Archive tab.', async () => {
    const by = (window.currentStaffName || '').trim() || 'OSCA Staff';
    const staffUid = (auth.currentUser && auth.currentUser.uid) || null;
    const now = Date.now();
    try {
      await update(ref(db, 'users/' + uid), {
        lifeStatus: 'Deceased',
        status: 'Deceased',
        deceasedAt: now,
        deceasedBy: by,
        deceasedByUid: staffUid,
        // Archive metadata (same shape the Archive tab already reads/writes)
        archivedAt: now,
        archivedBy: by,
        archivedReason: 'Deceased — marked by OSCA staff; pension entitlement stopped',
        // Pension stop flag — every payout list also filters archived
        // life statuses, this is kept as an explicit record for audits.
        pensionSuspended: true,
        pensionSuspendedAt: now,
        pensionSuspendedReason: 'Senior marked Deceased',
        lastProfileUpdateAt: now,
        lastProfileUpdatedBy: by,
        lastProfileUpdatedByUid: staffUid
      });
      await msLogAudit('SENIOR_MARKED_DECEASED', uid, name,
        'Employee marked ' + label + ' as Deceased — account archived and pension entitlement stopped.');
      await msSyncSupabase(uid);
      manageSeniorsCache = msCollectSeniors();
      // Reflect the change immediately for the employee — the live `users`
      // listener re-renders again with the fresh server value moments later.
      const cached = (manageSeniorsCache || []).find(e => e.uid === uid);
      if (cached) { cached.lifeStatus = 'Deceased'; cached.status = 'Deceased'; }
      renderManageSeniorsList();
      const modal = document.getElementById('manageSeniorsEditModal');
      if (modal && modal.style.display === 'flex') window.closeManageSeniorsEditor();
      msNotify('success', label + ' has been marked as Deceased and moved to the Archive.');
    } catch (err) {
      console.error('Mark senior as deceased failed:', err);
      const msg = (err && err.message) ? err.message : 'Failed to mark this senior as deceased. Please try again.';
      msShowNotice(msg);
      msNotify('error', msg);
    }
  });
};
// Manage Seniors save flow (P4): validate, update RTDB, audit, mirror.
async function msLogAudit(action, seniorUid, seniorName, detail) {
  try {
    const key = 'audit_' + Date.now() + Math.random().toString(36).substring(2, 7);
    await update(ref(db, 'auditLogs/' + key), {
      action: action,
      actorUid: (auth.currentUser && auth.currentUser.uid) || 'staff',
      actorRole: window.currentStaffRole || 'employee',
      actorName: (window.currentStaffName || '').trim() || 'OSCA Staff',
      targetUid: seniorUid || null,
      docId: null,
      pension: 0,
      detail: detail || null,
      timestamp: Date.now()
    });
  } catch (e) { console.error('Manage Seniors audit log failed:', e); }
}
async function msSyncSupabase(uid) {
  try {
    if (!auth.currentUser) return;
    const token = await auth.currentUser.getIdToken();
    await fetch('/api/supabase/sync-senior', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ uid })
    });
  } catch (e) { console.warn('Manage Seniors Supabase mirror skipped:', e); }
}
window.saveManageSeniorsEdits = async function () {
  const uid = String(msVal('seniorEditUid') || '').trim();
  if (!uid) { msShowNotice('No senior account selected.'); return; }
  const name = String(msVal('seniorEditName') || '').trim();
  const seniorId = String(msVal('seniorEditSeniorId') || '').trim();
  if (!name) { msShowNotice('Full name is required.'); return; }
  if (!seniorId) { msShowNotice('Senior Citizen ID is required.'); return; }
  const dob = String(msVal('seniorEditDob') || '').trim();
  if (dob) {
    const b = new Date(dob); const now = new Date();
    if (isNaN(b.getTime()) || b > now) { msShowNotice('Date of birth is not valid.'); return; }
  }
  const firstName = String(msVal('seniorEditFirstName') || '').trim();
  const lastName = String(msVal('seniorEditLastName') || '').trim();
  const middleName = String(msVal('seniorEditMiddleName') || '').trim();
  const extension = String(msVal('seniorEditExtension') || '').trim();
  const cpNumber = String(msVal('seniorEditCp') || '').trim();
  const sex = String(msVal('seniorEditSex') || '').trim();
  const civilStatus = String(msVal('seniorEditCivil') || '').trim();
  const address = String(msVal('seniorEditAddress') || '').trim();
  const barangay = String(msVal('seniorEditBarangay') || '').trim();
  const city = String(msVal('seniorEditCity') || '').trim();
  const province = String(msVal('seniorEditProvince') || '').trim();
  const postalCode = String(msVal('seniorEditPostal') || '').trim();
  const saveBtn = document.getElementById('seniorEditSaveBtn');
  const orig = saveBtn ? saveBtn.innerHTML : '';
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }
  try {
    // Guard: keep Senior IDs unique across other senior accounts.
    const snap = await get(ref(db, 'users'));
    const all = snap.exists() ? snap.val() : {};
    const normNew = seniorId.toUpperCase();
    for (const [otherUid, other] of Object.entries(all)) {
      if (otherUid === uid || !other || other.role !== 'senior') continue;
      if (String(other.seniorId || '').trim().toUpperCase() === normNew) {
        throw new Error('That Senior Citizen ID is already used by ' + (other.name || other.email || 'another account') + '.');
      }
    }
    const prior = all[uid] || {};
    const updates = {
      name, seniorId, firstName, middleName, lastName, extension,
      cpNumber, dob: dob || null, sex, civilStatus,
      address, barangay, city, province, postalCode,
      lastProfileUpdateAt: Date.now(),
      lastProfileUpdatedBy: (window.currentStaffName || '').trim() || 'OSCA Staff',
      lastProfileUpdatedByUid: (auth.currentUser && auth.currentUser.uid) || null
    };
    const age = msCalcAge(dob);
    if (age != null) updates.age = age;
    if (verificationIdChanged(prior, seniorId)) updates.verificationSeniorId = seniorId;
    await update(ref(db, 'users/' + uid), updates);
    const changed = diffSeniorFields(prior, updates);
    await msLogAudit('SENIOR_INFO_UPDATED', uid, name,
      'Employee updated senior account info of ' + name + ' (' + seniorId + ')' + (changed ? ' — changed: ' + changed : ''));
    await msSyncSupabase(uid);
    manageSeniorsCache = msCollectSeniors();
    renderManageSeniorsList();
    msShowNotice('Senior account info updated successfully.', 'ok');
    msNotify('success', 'Senior account info updated for ' + name + '.');
    setTimeout(() => { window.closeManageSeniorsEditor(); }, 900);
  } catch (err) {
    console.error('Manage Seniors save failed:', err);
    msShowNotice(err && err.message ? err.message : 'Failed to save changes. Please try again.');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = orig; }
  }
};
function verificationIdChanged(prior, seniorId) {
  return String((prior && prior.verificationSeniorId) || '') !== String(seniorId || '');
}
function diffSeniorFields(prior, updates) {
  const labels = { name: 'name', seniorId: 'Senior ID', firstName: 'first name', middleName: 'middle name', lastName: 'last name', extension: 'extension', cpNumber: 'contact', dob: 'birth date', age: 'age', sex: 'sex', civilStatus: 'civil status', address: 'address', barangay: 'barangay', city: 'city', province: 'province', postalCode: 'postal code' };
  const out = [];
  Object.keys(labels).forEach((k) => {
    const a = String((prior && prior[k]) == null ? '' : prior[k]);
    const b = String(updates[k] == null ? '' : updates[k]);
    if (a !== b) out.push(labels[k]);
  });
  return out.join(', ');
}
// Manage Seniors live refresh binding (P5).
function msBindLiveRefresh() {
  if (manageSeniorsBound) return;
  manageSeniorsBound = true;
  try {
    onValue(ref(db, 'users'), (snapshot) => {
      const data = snapshot.exists() ? snapshot.val() : {};
      window.lastUsersData = data;
      const tab = document.getElementById('tab-seniors');
      if (tab && tab.style.display !== 'none') {
        manageSeniorsCache = msCollectSeniors();
        renderManageSeniorsList();
      }
    });
  } catch (e) { console.warn('Manage Seniors live refresh unavailable:', e); }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', msBindLiveRefresh);
} else { msBindLiveRefresh(); }
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('manageSeniorsEditModal');
  if (modal && modal.style.display === 'flex') window.closeManageSeniorsEditor();
});
