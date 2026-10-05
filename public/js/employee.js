import { auth, db } from './firebase-init.js';
import { ref, get, onValue, update, remove } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-database.js";

const OTP_EXEMPT_EMAILS = new Set([
    'admin@silvercare.com',
    'employee@silvercare.com'
]);
function isOtpExemptEmail(email) {
    return OTP_EXEMPT_EMAILS.has(String(email || '').trim().toLowerCase());
}

// Helper: Generate professional, unique claim reference numbers
function generateReferenceNumber(prefix = 'REF') {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${prefix}-${result}`;
}

// Helper: Confirmation modal launcher (Are you sure? Yes / No)
function confirmAction(message, onConfirm) {
    const modal = document.getElementById('empConfirmModal');
    const msgEl = document.getElementById('empConfirmMessage');
    const yesBtn = document.getElementById('empConfirmYesBtn');
    const noBtn = document.getElementById('empConfirmNoBtn');

    if (!modal || !msgEl || !yesBtn || !noBtn) {
        if (window.confirm(message)) {
            onConfirm();
        }
        return;
    }

    msgEl.textContent = message;
    modal.style.display = 'flex';

    const cleanup = () => {
        modal.style.display = 'none';
        yesBtn.onclick = null;
        noBtn.onclick = null;
    };

    yesBtn.onclick = () => {
        cleanup();
        onConfirm();
    };

    noBtn.onclick = () => {
        cleanup();
    };
}

// Helper: Log financial transactions securely to admin Overview
async function logTransaction(type, seniorName, seniorUid, amount, refNumber = '', reason = '') {
    try {
        const txKey = 'tx_' + Date.now() + Math.random().toString(36).substring(2, 7);
        await update(ref(db, `transactions/${txKey}`), {
            type: type,
            seniorName: seniorName,
            seniorUid: seniorUid,
            amount: amount,
            refNumber: refNumber,
            reason: reason,
            processedBy: window.currentStaffName || 'Staff Member',
            createdAt: Date.now()
        });
    } catch (e) {
        console.error('Failed to log transaction:', e);
    }
}

// Helper: Write a pension audit-trail entry (shown on the Admin Audit Trail —
// admin account only). `pension` is stored as an INT so the admin can audit
// the exact peso amount of every pension set / change / removal.
async function logPensionAudit(action, seniorUid, seniorName, amount, detail) {
    try {
        const key = 'audit_' + Date.now() + Math.random().toString(36).substring(2, 7);
        await update(ref(db, `auditLogs/${key}`), {
            action: action,
            actorUid: (auth.currentUser && auth.currentUser.uid) || 'staff',
            actorRole: window.currentStaffRole || 'employee',
            actorName: (window.currentStaffName || '').trim() || 'OSCA Staff',
            targetUid: seniorUid || null,
            docId: null,
            pension: Math.round(Number(amount) || 0),
            detail: detail || null,
            timestamp: Date.now()
        });
    } catch (e) {
        console.error('Failed to write pension audit log:', e);
    }
}

// ============================================================
// Face-Scan Reactivation Requests (Archive tab — staff review)
// Staff compare the live photo with the registration photo and
// give the final human decision (Approve = reactivate account).
// ============================================================
let reactivationRequestsCache = [];

async function getStaffIdToken() {
    const user = auth.currentUser;
    if (!user) throw new Error('You are not signed in. Please log in again.');
    return await user.getIdToken();
}

function escapeHtmlAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * In-page document viewer (lightbox). Shows a document FULL SIZE with an
 * X button to close — no new tab, so huge inline data-URL images (which
 * Chrome refuses to open in a new tab) are supported. Handles both image
 * files (jpeg / png / webp) and PDFs (rendered in an embedded frame).
 */
window.openDocViewer = function (src, title, mimeType) {
    if (!src) return;
    let overlay = document.getElementById('docViewerOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'docViewerOverlay';
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,0.85); z-index:99999; display:none; align-items:center; justify-content:center; padding:28px;';
        overlay.innerHTML = `
            <div style="position:relative; background:#ffffff; border-radius:14px; width:min(920px, 100%); max-height:90vh; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 24px 60px rgba(0,0,0,0.35);">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 18px; border-bottom:1px solid #e2e8f0; background:#f8fafc;">
                    <strong id="docViewerTitle" style="color:#1e293b; font-size:0.95rem; word-break:break-all;"></strong>
                    <button type="button" id="docViewerClose" title="Close (X)" style="border:none; background:#fee2e2; color:#b91c1c; width:34px; height:34px; border-radius:50%; font-size:0.95rem; font-weight:700; cursor:pointer; flex-shrink:0;">&#10005;</button>
                </div>
                <div id="docViewerBody" style="flex:1; overflow:auto; background:#f1f5f9; display:flex; align-items:center; justify-content:center; min-height:220px;"></div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) window.closeDocViewer(); });
        document.getElementById('docViewerClose').addEventListener('click', () => window.closeDocViewer());
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.closeDocViewer(); });
    }
    document.getElementById('docViewerTitle').textContent = title || 'Document preview';
    const body = document.getElementById('docViewerBody');
    body.innerHTML = '';
    const s = String(src);
    const isPdf = (mimeType && /pdf/i.test(String(mimeType))) || /^data:application\/pdf/i.test(s) || /\.pdf(\?|#|$)/i.test(s);
    if (isPdf) {
        const frame = document.createElement('iframe');
        frame.src = s; // set as a property — data URLs are far too large for an attribute
        frame.style.cssText = 'width:100%; height:80vh; border:none; background:white;';
        frame.title = title || 'Document';
        body.appendChild(frame);
    } else {
        const img = document.createElement('img');
        img.src = s;
        img.alt = title || 'Document preview';
        img.style.cssText = 'max-width:100%; max-height:82vh; object-fit:contain;';
        body.appendChild(img);
    }
    overlay.style.display = 'flex';
};

/** Closes the document viewer (X button / backdrop / Escape). */
window.closeDocViewer = function () {
    const overlay = document.getElementById('docViewerOverlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    const body = document.getElementById('docViewerBody');
    if (body) body.innerHTML = ''; // release the large data URL from memory
};

/**
 * Re-opens a senior's KYC medical certification through the backend.
 * The backend serves either the durable private-bucket copy (short-lived
 * signed URL) or the inline submitted copy; both are shown in the in-page
 * viewer — staff can always view the document again while it is available.
 */
window.openKycMedCert = async function (uid) {
    try {
        const token = await getStaffIdToken();
        const res = await fetch(`/api/kyc-medcert/view/${encodeURIComponent(uid)}`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success || !data.viewUrl) {
            throw new Error((data && data.message) || 'The medical certification could not be opened.');
        }
        const file = data.file || {};
        window.openDocViewer(data.viewUrl, file.name || 'Medical certification', file.mimeType);
    } catch (err) {
        console.error('openKycMedCert error:', err);
        scNotify('error', err.message || 'Failed to open the medical certification.');
    }
};

/** True when the employee can re-open a senior's KYC medical certification. */
function kycMedCertAvailable(user) {
    return !!(user && (user.kycMedCertImage || user.kycMedCertPath));
}

/** Format the senior's KYC date of birth ("yyyy-mm-dd") for the review card. */
function kycFormatDob(dob) {
    if (!dob) return '';
    const d = new Date(dob);
    return isNaN(d.getTime()) ? String(dob) : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

window.loadReactivationRequests = async function () {
    const container = document.getElementById('reactivationListContainer');
    const badge = document.getElementById('reactivationPendingBadge');
    if (!container) return;
    container.innerHTML = '<div style="text-align: center; color: #64748b; padding: 20px;">Loading reactivation requests...</div>';
    try {
        const idToken = await getStaffIdToken();
        const res = await fetch('/api/reactivation/requests', { headers: { 'Authorization': 'Bearer ' + idToken } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data && data.message) || 'Failed to load requests.');
        reactivationRequestsCache = Array.isArray(data.requests) ? data.requests : [];
        renderReactivationRequests();
    } catch (err) {
        console.error('loadReactivationRequests error:', err);
        container.innerHTML = `<div style="text-align: center; color: #b91c1c; padding: 20px;">${escapeHtmlAttr(err.message)}</div>`;
        if (badge) badge.style.display = 'none';
    }
};

function renderReactivationRequests() {
    const container = document.getElementById('reactivationListContainer');
    const badge = document.getElementById('reactivationPendingBadge');
    if (!container) return;
    const list = reactivationRequestsCache || [];
    const pending = list.filter(r => r.status === 'Pending');
    if (badge) {
        badge.style.display = pending.length ? 'inline-block' : 'none';
        badge.textContent = pending.length + ' pending';
    }
    if (!list.length) {
        container.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 24px; border: 1px dashed #d4d4d8; border-radius: 8px;">No reactivation requests yet.</div>';
        return;
    }
    container.innerHTML = list.map(r => {
        const status = r.status || 'Pending';
        const statusStyle = status === 'Approved'
            ? 'background:#dcfce7;color:#15803d;'
            : status === 'Rejected' ? 'background:#fee2e2;color:#b91c1c;' : 'background:#fef9c3;color:#a16207;';
        const when = r.requestedAt ? new Date(r.requestedAt).toLocaleString() : 'Recently';
        const id = escapeHtmlAttr(r.uid || r.id);
        const noteHtml = r.reviewedBy
            ? '<div style="font-size: 0.82rem; color: #64748b; margin-bottom: 10px;">Reviewed by <strong>' + escapeHtmlAttr(r.reviewedBy) + '</strong>' + (r.reviewNote ? ' — ' + escapeHtmlAttr(r.reviewNote) : '') + '</div>'
            : '';
        const actionsHtml = status === 'Pending'
            ? '<div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: center;">'
              + '<input type="text" id="reactNote_' + id + '" placeholder="Optional note to the senior..." maxlength="200" style="flex: 1; min-width: 200px; padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 0.85rem;">'
              + '<button onclick="window.reviewReactivation(\'' + id + '\', true)" style="background: #059669; color: white; border: none; padding: 9px 20px; border-radius: 8px; font-weight: 700; font-size: 0.85rem; cursor: pointer;"><i class="fas fa-check" style="margin-right: 6px;"></i>Approve &amp; Reactivate</button>'
              + '<button onclick="window.reviewReactivation(\'' + id + '\', false)" style="background: white; color: #b91c1c; border: 1px solid #ef4444; padding: 9px 20px; border-radius: 8px; font-weight: 700; font-size: 0.85rem; cursor: pointer;">Decline</button>'
              + '</div>'
            : '';
        const liveHtml = r.liveImage
            ? '<img src="' + r.liveImage + '" alt="Live photo" style="width: 100%; max-height: 220px; object-fit: cover; border-radius: 8px; border: 2px solid #059669;">'
            : '<div style="color:#94a3b8; font-size:0.85rem;">No photo</div>';
        const refHtml = r.referenceImage
            ? '<img src="' + r.referenceImage + '" alt="Registration photo" style="width: 100%; max-height: 220px; object-fit: cover; border-radius: 8px; border: 2px solid #cbd5e1;">'
            : '<div style="color:#94a3b8; font-size:0.85rem;">No photo</div>';
        return '<div style="border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; margin-bottom: 16px; background: #f8fafc;">'
            + '<div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px;">'
            + '<div><strong style="font-size: 1rem; color: #1e293b;">' + escapeHtmlAttr(r.name || 'Senior Citizen') + '</strong>'
            + '<span style="color: #64748b; font-size: 0.85rem;"> · ' + escapeHtmlAttr(r.seniorId || '') + ' · ' + escapeHtmlAttr(r.barangay || '') + '</span>'
            + '<div style="color: #94a3b8; font-size: 0.78rem;">Requested: ' + escapeHtmlAttr(when) + ' · Face match: <strong>' + escapeHtmlAttr(r.confidence != null ? r.confidence + '%' : 'n/a') + '</strong></div></div>'
            + '<span style="' + statusStyle + ' padding: 5px 14px; border-radius: 999px; font-weight: 700; font-size: 0.8rem;">' + escapeHtmlAttr(status) + '</span></div>'
            + '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">'
            + '<div><div style="font-size: 0.78rem; font-weight: 700; color: #64748b; margin-bottom: 4px;">LIVE PHOTO (just scanned)</div>' + liveHtml + '</div>'
            + '<div><div style="font-size: 0.78rem; font-weight: 700; color: #64748b; margin-bottom: 4px;">REGISTRATION PHOTO (on file)</div>' + refHtml + '</div>'
            + '</div>' + noteHtml + actionsHtml + '</div>';
    }).join('');
}

window.reviewReactivation = function (uid, approve) {
    const action = approve ? 'approve and REACTIVATE this account' : 'DECLINE this reactivation request';
    confirmAction('Are you sure you want to ' + action + '?', async () => {
        const noteInput = document.getElementById('reactNote_' + uid);
        const note = noteInput ? noteInput.value.trim() : '';
        if (!approve && !note) {
            if (typeof showToast === 'function') showToast('Please type a short note explaining why it was declined.');
            else alert('Please type a short note explaining why it was declined.');
            return;
        }
        try {
            const idToken = await getStaffIdToken();
            const res = await fetch('/api/reactivation/requests/' + encodeURIComponent(uid) + '/review', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
                body: JSON.stringify({ approve: !!approve, note })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error((data && data.message) || 'Review failed.');
            if (typeof showToast === 'function') showToast(data.message || 'Done.');
            else alert(data.message || 'Done.');
            window.loadReactivationRequests();
        } catch (err) {
            console.error('reviewReactivation error:', err);
            if (typeof showToast === 'function') showToast(err.message);
            else alert(err.message);
        }
    });
};

// ── Employee Notifications Engine (real-time feed) ───────────────────────────
// Builds a live notification feed from actual system events: senior account
// registrations awaiting verification, KYC identity submissions, checkup
// appointment requests and welfare claims. Read-state is stored per browser
// in localStorage and the nav badge counts unread items.

const EMP_NOTIF_READ_KEY = 'sc_emp_notif_read';
let empNotifFilter = 'all';

function getEmpNotifReadSet() {
    try {
        const arr = JSON.parse(localStorage.getItem(EMP_NOTIF_READ_KEY) || '[]');
        return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) { return new Set(); }
}

function persistEmpNotifReadSet(set) {
    try {
        let arr = Array.from(set);
        if (arr.length > 800) arr = arr.slice(arr.length - 400); // prune old keys
        localStorage.setItem(EMP_NOTIF_READ_KEY, JSON.stringify(arr));
    } catch (e) { /* storage unavailable — unread state simply won't persist */ }
}

function markEmpNotifItemsRead(keys) {
    const set = getEmpNotifReadSet();
    keys.forEach(k => set.add(k));
    persistEmpNotifReadSet(set);
}

function empNotifTimestamp(v) {
    if (typeof v === 'number' && v > 0) return v;
    if (typeof v === 'string' && v) { const p = Date.parse(v); return isNaN(p) ? 0 : p; }
    return 0;
}

function notifRelativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000) return 'Just now';
    const m = Math.floor(diff / 60000);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    if (d === 1) return 'Yesterday';
    if (d < 7) return d + 'd ago';
    return new Date(ts).toLocaleDateString();
}

function collectEmployeeNotifications() {
    const users  = window.lastUsersData  || {};
    const claims = window.lastClaimsData || {};
    const queues = window.lastQueuesData || {};
    const items = [];

    for (const [uid, u] of Object.entries(users)) {
        if (!u || u.role !== 'senior' || isArchivedSenior(u)) continue;
        if (u.status === 'Pending') {
            items.push({
                key: 'reg_' + uid, type: 'verify',
                ts: empNotifTimestamp(u.createdAt),
                title: 'New senior registration',
                desc: `${u.name || 'A senior'} (${u.email || 'no email'}) is awaiting account verification.`,
                tab: 'verify'
            });
        }
        if (u.kycStatus === 'Pending') {
            items.push({
                key: 'kyc_' + uid, type: 'kyc',
                ts: empNotifTimestamp(u.kycSubmittedAt),
                title: 'Identity verification submitted',
                desc: `${u.name || 'A senior'} submitted KYC documents for review.`,
                tab: 'verify'
            });
        }
    }

    for (const [id, q] of Object.entries(queues)) {
        if (!q || !q.uid) continue;
        const u = users[q.uid] || {};
        if (isArchivedSenior(u)) continue;
        if (['Pending', 'Rescheduled'].includes(q.status)) {
            items.push({
                key: 'appt_' + id, type: 'appt',
                ts: empNotifTimestamp(q.createdAt || q.scheduledAt),
                title: 'Checkup appointment request',
                desc: `${u.name || q.name || 'A senior'} requested ${q.service || 'General Consultation'} on ${q.date || 'TBD'} at ${q.time || ''}.`,
                tab: 'health'
            });
        }
    }

    for (const [id, c] of Object.entries(claims)) {
        if (!c || c.status !== 'Pending') continue;
        items.push({
            key: 'claim_' + id, type: 'claim',
            ts: empNotifTimestamp(c.createdAt),
            title: 'Welfare claim submitted',
            desc: `${c.applicantName || 'A senior'} filed a ${(c.serviceType || 'welfare').toUpperCase()} claim for review.`,
            tab: 'process'
        });
    }

    items.sort((a, b) => b.ts - a.ts);
    return items.slice(0, 60);
}

const EMP_NOTIF_TYPE_META = {
    verify: { icon: 'fa-user-plus',          cls: 'ni-type-verify' },
    kyc:    { icon: 'fa-id-card',            cls: 'ni-type-kyc'    },
    appt:   { icon: 'fa-calendar-check',     cls: 'ni-type-appt'   },
    claim:  { icon: 'fa-hand-holding-heart', cls: 'ni-type-claim'  }
};

window.renderEmployeeNotifications = function() {
    const feedEl = document.getElementById('notifFeedContainer');
    if (!feedEl) return;

    const items   = collectEmployeeNotifications();
    const readSet = getEmpNotifReadSet();
    const unread  = items.filter(i => !readSet.has(i.key));

    // Nav badge + header indicators
    const badge = document.getElementById('empNotifBadge');
    if (badge) badge.style.display = unread.length > 0 ? 'block' : 'none';
    const countPill = document.getElementById('empNotifUnreadCount');
    if (countPill) {
        countPill.textContent = unread.length + (unread.length === 1 ? ' unread' : ' unread');
        countPill.style.display = unread.length > 0 ? 'inline-block' : 'none';
    }
    const markAllBtn = document.getElementById('empNotifMarkAllBtn');
    if (markAllBtn) markAllBtn.style.display = unread.length > 0 ? 'inline-flex' : 'none';

    const filtered = empNotifFilter === 'all'
        ? items
        : items.filter(i => EMP_NOTIF_TYPE_META[empNotifFilter] && i.type === empNotifFilter);

    if (filtered.length === 0) {
        const msg = empNotifFilter === 'all'
            ? 'You&rsquo;re all caught up. New registrations, appointments and claims will appear here in real time.'
            : 'No notifications in this category right now.';
        feedEl.innerHTML = `<div class="notif-empty"><i class="far fa-bell-slash"></i>${msg}</div>`;
        return;
    }

    feedEl.innerHTML = filtered.map(i => {
        const meta  = EMP_NOTIF_TYPE_META[i.type] || EMP_NOTIF_TYPE_META.verify;
        const isNew = !readSet.has(i.key);
        return `
        <div class="notif-item ${isNew ? 'unread' : ''}" onclick="window.openEmpNotification('${i.key}', '${i.tab}')">
            <div class="ni-icon ${meta.cls}"><i class="fas ${meta.icon}"></i></div>
            <div style="flex:1; min-width:0;">
                <h5 class="ni-title">${escHtml(i.title)}${isNew ? '<span class="notif-new-tag">NEW</span>' : ''}</h5>
                <p class="ni-desc">${escHtml(i.desc)}</p>
            </div>
            <span class="ni-time">${notifRelativeTime(i.ts)}</span>
            <span class="${isNew ? 'ni-unread-dot' : 'ni-dot-hidden'}"></span>
        </div>`;
    }).join('');
};

window.setEmpNotifFilter = function(filter) {
    empNotifFilter = filter;
    document.querySelectorAll('#empNotifFilters .notif-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.filter === filter);
    });
    window.renderEmployeeNotifications();
};

window.openEmpNotification = function(key, tab) {
    markEmpNotifItemsRead([key]);
    window.renderEmployeeNotifications();
    const pillIndex = ({ verify: 2, process: 3, health: 4 })[tab] || 2;
    const pill = document.querySelectorAll('.emp-nav-pill')[pillIndex];
    if (typeof switchEmpTab === 'function' && pill) switchEmpTab(tab, pill);
};

window.markAllEmpNotificationsRead = function() {
    const items = collectEmployeeNotifications();
    markEmpNotifItemsRead(items.map(i => i.key));
    window.renderEmployeeNotifications();
    scNotify('info', 'All notifications marked as read.');
};

// ── Reminder composer helpers (redesigned Send Reminders) ────────────────────
const REMINDER_TEMPLATES = [
    'Reminder: The monthly pension payout is scheduled this Friday at the OSCA office. Please bring your QR Digital ID and a valid ID.',
    'Please bring your Senior Citizen ID and QR Digital ID when visiting the OSCA office. Thank you!',
    'Friendly reminder: please take your maintenance medicines on time and attend your scheduled check-up. Stay healthy!'
];

window.useReminderTemplate = function(i) {
    const ta = document.getElementById('reminderMessage');
    if (!ta) return;
    ta.value = REMINDER_TEMPLATES[i] || '';
    ta.dispatchEvent(new Event('input'));
    ta.focus();
};

(function initReminderComposer() {
    const ta = document.getElementById('reminderMessage');
    const counter = document.getElementById('reminderCharCount');
    if (ta && counter) {
        const update = () => { counter.textContent = `${ta.value.length} / ${ta.maxLength || 300}`; };
        ta.addEventListener('input', update);
        update();
    }
})();

// ── Update Health Records notification indicator badge ──────────────────────
// Red dot = pending senior appointment requests (checkups awaiting approval).
// Also drives the Health Records overview stat cards, so every data update
// keeps the whole tab in sync.
function updateHealthTabBadge() {
    const empHealthBadge = document.getElementById('empHealthBadge');
    const users = window.lastUsersData || {};
    // Archive Function: archived seniors never appear in health workflows
    const isListed = (u) => u && u.role === 'senior' && !isArchivedSenior(u);

    const appts = Object.values(window.lastQueuesData || {})
        .filter(q => q && q.uid && isListed(users[q.uid] || {}));
    const pendingApptCount = appts.filter(q => ['Pending', 'Rescheduled'].includes(q.status)).length;
    const approvedApptCount = appts.filter(q => q.status === 'Approved').length;

    if (empHealthBadge) {
        // Only show red dot badge if Health tab is not currently active
        const isHealthTabActive = document.getElementById('tab-health')?.style.display === 'block';
        empHealthBadge.style.display = (pendingApptCount > 0 && !isHealthTabActive) ? 'block' : 'none';
    }

    // ── Health Records overview cards ──────────────────────────────────────
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('healthStatPendingAppt', pendingApptCount);
    setText('healthStatUpcomingAppt', approvedApptCount);

    const pillAppt = document.getElementById('healthSubTabCountAppointments');
    if (pillAppt) {
        pillAppt.textContent = pendingApptCount;
        pillAppt.style.display = pendingApptCount > 0 ? 'inline-block' : 'none';
    }
}

// The Illness & Priority sub-tab was removed — the Health Records tab is now
// appointment requests only. These shims stay so the remaining overview cards
// (and any cached page) keep working without JS errors.

// ── Health Records sub-tab switching ───────────────────────────────────────
// The Illness & Priority workflow was removed; the Health Records tab now
// shows only the Appointment Requests list. This shim keeps the overview
// cards (and any cached page) working without JS errors.
window.switchHealthSubTab = function (section) {
    const apptWrap = document.getElementById('healthSubAppointments');
    if (apptWrap) apptWrap.style.display = 'block';
    const apptBtn = document.getElementById('healthSubTabBtnAppointments');
    if (apptBtn) apptBtn.style.cssText = 'border: none; background: #1e293b; color: #ffffff; font-weight: 700; font-size: 0.85rem; padding: 9px 18px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 8px;';
};

// The Certifications-to-Review / High-Priority shortcut cards were removed
// with the Illness & Priority section. Kept as a no-op so nothing breaks.
window.jumpToHealthFilter = function (filter) {
    return;
};

// ── Archive Function helpers ────────────────────────────────────────────────
// Records marked Inactive, Deceased, Transferred (or already Archived) are
// "archived": they are moved out of the main dashboard and ALL processing
// lists so that only ACTIVE senior citizens appear there.
const ARCHIVED_STATUSES = ['Inactive', 'Deceased', 'Transferred', 'Archived'];

function getSeniorStatus(u) {
    return String((u && (u.lifeStatus || u.status)) || 'Active');
}

function isArchivedSenior(u) {
    return !!u && u.role === 'senior' && ARCHIVED_STATUSES.includes(getSeniorStatus(u));
}

function isActiveSenior(u) {
    return !!u && u.role === 'senior' && !ARCHIVED_STATUSES.includes(getSeniorStatus(u));
}

document.addEventListener('DOMContentLoaded', () => {
    if (window.location.pathname !== '/employee') return;



    // Logout handler
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try {
                sessionStorage.removeItem('sc_2fa_verified');
                sessionStorage.removeItem('sc_2fa_pending');
                await auth.signOut();
                localStorage.removeItem('userRole');
                window.location.replace('/');
            } catch (err) {
                console.error('Logout error:', err);
            }
        });
    }

    auth.onAuthStateChanged(async (user) => {
        if (!user) {
            window.location.replace('/');
            return;
        }
        // The explicitly provisioned admin and default employee accounts do not require OTP.
        if (!isOtpExemptEmail(user.email) && sessionStorage.getItem('sc_2fa_verified') !== user.uid) {
            sessionStorage.removeItem('sc_2fa_pending');
            try { await auth.signOut(); } catch (err) { console.error(err); }
            window.location.replace('/');
            return;
        }
        if (user) {
            // Set greeting
            const userSnap = await get(ref(db, 'users/' + user.uid));
            let staffName = 'Staff';
            if (userSnap.exists()) {
                staffName = userSnap.val().name;
                document.getElementById('employeeGreeting').textContent = `Welcome, ${staffName}!`;
            } else {
                document.getElementById('employeeGreeting').textContent = `Welcome, Staff!`;
            }
            window.currentStaffName = staffName;

            // Real-time MAINTENANCE MODE watcher
            onValue(ref(db, 'system/settings/maintenanceMode'), async (snap) => {
                if (snap.exists() && snap.val() === true) {
                    showMaintenanceOverlay();
                    setTimeout(async () => {
                        await auth.signOut();
                        localStorage.removeItem('userRole');
                        window.location.href = '/';
                    }, 3000);
                }
            });

            // Real-time users listener — drives all tabs
            onValue(ref(db, 'users'), (snapshot) => {
                const data = snapshot.exists() ? snapshot.val() : {};
                renderEmployeeDashboard(data);
                // Process Benefits "Generate Reports" totals live-update here
                if (window.updatePbReportStats) window.updatePbReportStats();
                if (window.renderEmployeeNotifications) window.renderEmployeeNotifications();
            });

            // Real-time welfare claims listener
            onValue(ref(db, 'claims'), (snapshot) => {
                const claimsData = snapshot.exists() ? snapshot.val() : {};
                window.lastClaimsData = claimsData;
                renderClaimsDashboard(claimsData);
                renderEmpOverviewDashboard();
                renderPrioritySeniorsDashboard();
                // Process Benefits "Generate Reports" totals live-update here
                if (window.updatePbReportStats) window.updatePbReportStats();
                if (window.renderEmployeeNotifications) window.renderEmployeeNotifications();
            });

            // Real-time appointments queue listener — drives Dashboard pending count
            onValue(ref(db, 'queue'), (snapshot) => {
                window.lastQueuesData = snapshot.exists() ? snapshot.val() : {};
                renderEmpOverviewDashboard();
                renderPrioritySeniorsDashboard();
                // Senior appointment requests (Health Records tab) live-update here
                if (window.lastUsersData) {
                    renderSeniorAppointmentRequests(window.lastUsersData, window.lastQueuesData);
                }
                // Process Benefits "Generate Reports" totals live-update here
                if (window.updatePbReportStats) window.updatePbReportStats();
                updateHealthTabBadge();
                if (window.renderEmployeeNotifications) window.renderEmployeeNotifications();
            });

            // Real-time transactions listener — drives Seniors-by-Priority profile modal
            // (recent transactions + full transaction history per senior).
            onValue(ref(db, 'transactions'), (snapshot) => {
                window.lastTransactionsData = snapshot.exists() ? snapshot.val() : {};
                renderPrioritySeniorsDashboard();
                if (window._prioritySeniorUid) window.openPrioritySeniorModal(window._prioritySeniorUid);
            });



        }
    });

    // Close Claim details modal
    const closeClaimModal = document.getElementById('closeClaimModal');
    const claimDetailsModal = document.getElementById('claimDetailsModal');
    if (closeClaimModal && claimDetailsModal) {
        closeClaimModal.addEventListener('click', () => {
            claimDetailsModal.style.display = 'none';
        });
    }

    // ── Walk-in Senior Registration ──────────────────────────────────────────
    const startRegBtn = document.getElementById('startRegBtn');
    const cancelRegBtn = document.getElementById('cancelRegBtn');
    const registerCTA = document.getElementById('registerCTA');
    const registerFormContent = document.getElementById('registerFormContent');
    const empRegisterForm = document.getElementById('empRegisterForm');

    // Face scan elements
    const regScanFaceBtn = document.getElementById('regScanFaceBtn');
    const regRetakeBtn = document.getElementById('regRetakeBtn');
    const regVideo = document.getElementById('regVideo');
    const regCanvas = document.getElementById('regCanvas');
    const regCameraPlaceholder = document.getElementById('regCameraPlaceholder');
    const regFaceGuide = document.getElementById('regFaceGuide');
    const regCaptureFlash = document.getElementById('regCaptureFlash');
    const regCapturedPreview = document.getElementById('regCapturedPreview');
    const regFaceStatus = document.getElementById('regFaceStatus');

    let regStream = null;
    let regCapturedFaceData = null;

    if (startRegBtn) {
        startRegBtn.addEventListener('click', () => {
            registerCTA.style.display = 'none';
            registerFormContent.style.display = 'block';
        });
    }

    if (cancelRegBtn) {
        cancelRegBtn.addEventListener('click', () => {
            registerFormContent.style.display = 'none';
            registerCTA.style.display = 'block';
            if (empRegisterForm) empRegisterForm.reset();
            stopRegCamera();
            regCapturedFaceData = null;
            resetRegFaceUI();
        });
    }

    function stopRegCamera() {
        if (regStream) {
            regStream.getTracks().forEach(t => t.stop());
            regStream = null;
        }
        if (regVideo) regVideo.srcObject = null;
    }

    function resetRegFaceUI() {
        if (regVideo) regVideo.style.display = 'none';
        if (regCameraPlaceholder) regCameraPlaceholder.style.display = 'flex';
        if (regFaceGuide) regFaceGuide.style.display = 'none';
        if (regCapturedPreview) { regCapturedPreview.style.display = 'none'; regCapturedPreview.src = ''; }
        if (regRetakeBtn) regRetakeBtn.style.display = 'none';
        if (regScanFaceBtn) {
            regScanFaceBtn.innerHTML = 'Start Camera & Scan Face';
            regScanFaceBtn.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)';
            regScanFaceBtn.disabled = false;
            regScanFaceBtn.style.display = '';
        }
        if (regFaceStatus) {
            regFaceStatus.innerHTML = 'Face scan is required before submitting';
            regFaceStatus.style.color = '#ef4444';
        }
        regCapturedFaceData = null;
    }

    // ── Camera helper: retries with simpler constraints when device is busy ──
    function getCameraErrorMessage(err) {
        switch (err && err.name) {
            case 'NotAllowedError':
            case 'SecurityError':
                return 'Camera access denied. Please allow camera permissions in your browser (click the camera icon in the address bar).';
            case 'NotFoundError':
            case 'DevicesNotFoundError':
                return 'No camera was found on this device. Please connect a camera and try again.';
            case 'NotReadableError':
            case 'TrackStartError':
            case 'AbortError':
                return 'Camera is busy or unavailable. Close other apps using the camera (Zoom, Teams, Windows Camera, or another browser tab) and try again.';
            default:
                return 'Unable to start camera: ' + ((err && err.message) || 'unknown error');
        }
    }

    async function requestRegCamera() {
        // Release any streams this app may still hold so the device isn't busy
        stopRegCamera();
        if (typeof window.qrScannerStop === 'function') window.qrScannerStop(false);

        // Progressive fallback: full constraints → facingMode only → bare video
        const attempts = [
            { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
            { video: { facingMode: 'user' }, audio: false },
            { video: true, audio: false }
        ];
        let lastErr = null;
        for (let i = 0; i < attempts.length; i++) {
            try {
                return await navigator.mediaDevices.getUserMedia(attempts[i]);
            } catch (err) {
                lastErr = err;
                // Fail fast on errors a retry cannot fix
                if (['NotAllowedError', 'SecurityError', 'NotFoundError', 'DevicesNotFoundError'].includes(err.name)) throw err;
                // NotReadableError/AbortError: device busy — wait for the OS to release it, then retry simpler constraints
                if (i < attempts.length - 1) await new Promise(r => setTimeout(r, 500));
            }
        }
        throw lastErr;
    }

    // Face scan button logic
    if (regScanFaceBtn) {
        regScanFaceBtn.addEventListener('click', async () => {
            // If face already captured, do nothing (retake handles it)
            if (regCapturedFaceData) return;

            // If camera is streaming, capture the frame
            if (regStream) {
                await captureRegFace();
                return;
            }

            // Start camera
            regScanFaceBtn.disabled = true;
            regScanFaceBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting Camera...';

            try {
                regStream = await requestRegCamera();
                regVideo.srcObject = regStream;
                regVideo.style.display = 'block';
                regCameraPlaceholder.style.display = 'none';
                if (regFaceGuide) { regFaceGuide.style.display = 'flex'; }

                regScanFaceBtn.disabled = false;
                regScanFaceBtn.innerHTML = 'Tap to Capture';
                regScanFaceBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
            } catch (err) {
                scNotify('error', getCameraErrorMessage(err));
                console.error('Camera error:', err);
                regScanFaceBtn.disabled = false;
                regScanFaceBtn.innerHTML = 'Start Camera & Scan Face';
            }
        });
    }

    // Retake button
    if (regRetakeBtn) {
        regRetakeBtn.addEventListener('click', () => {
            regCapturedFaceData = null;
            if (regCapturedPreview) { regCapturedPreview.style.display = 'none'; regCapturedPreview.src = ''; }
            if (regRetakeBtn) regRetakeBtn.style.display = 'none';
            if (regScanFaceBtn) {
                regScanFaceBtn.style.display = '';
                regScanFaceBtn.innerHTML = 'Start Camera & Scan Face';
                regScanFaceBtn.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)';
                regScanFaceBtn.disabled = false;
            }
            if (regFaceStatus) {
                regFaceStatus.innerHTML = 'Face scan is required before submitting';
                regFaceStatus.style.color = '#ef4444';
            }
        });
    }

    async function captureRegFace() {
        if (!regStream || !regVideo || !regCanvas) return;

        regCanvas.width = regVideo.videoWidth;
        regCanvas.height = regVideo.videoHeight;
        const ctx = regCanvas.getContext('2d');
        ctx.drawImage(regVideo, 0, 0);

        // Flash effect
        if (regCaptureFlash) {
            regCaptureFlash.style.opacity = '0.7';
            setTimeout(() => { regCaptureFlash.style.opacity = '0'; }, 200);
        }

        // Show detecting state
        regScanFaceBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Detecting face...';
        regScanFaceBtn.disabled = true;

        // ── Face Detection ──
        let faceDetected = false;

        try {
            if ('FaceDetector' in window) {
                const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
                const faces = await detector.detect(regCanvas);
                if (faces.length === 1) {
                    const faceArea = faces[0].boundingBox.width * faces[0].boundingBox.height;
                    const imageArea = regCanvas.width * regCanvas.height;
                    faceDetected = (faceArea / imageArea) > 0.04;
                } else if (faces.length > 1) {
                    scNotify('warning', 'Multiple faces detected. Please ensure only the senior\'s face is in the frame.');
                    regScanFaceBtn.innerHTML = 'Tap to Capture';
                    regScanFaceBtn.disabled = false;
                    return;
                }
            }

            // Fallback: skin-tone analysis
            if (!faceDetected) {
                const imageData = ctx.getImageData(0, 0, regCanvas.width, regCanvas.height);
                const data = imageData.data;
                let skinPixels = 0;
                const startX = Math.floor(regCanvas.width * 0.2);
                const endX = Math.floor(regCanvas.width * 0.8);
                const startY = Math.floor(regCanvas.height * 0.1);
                const endY = Math.floor(regCanvas.height * 0.7);
                let sampledPixels = 0;

                for (let y = startY; y < endY; y += 2) {
                    for (let x = startX; x < endX; x += 2) {
                        const idx = (y * regCanvas.width + x) * 4;
                        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
                        const isSkin = (
                            r > 60 && g > 40 && b > 20 &&
                            r > g && r > b &&
                            (r - g) > 10 &&
                            Math.abs(r - g) < 130 &&
                            (r + g + b) > 150 && (r + g + b) < 700
                        );
                        if (isSkin) skinPixels++;
                        sampledPixels++;
                    }
                }
                const skinRatio = skinPixels / sampledPixels;
                faceDetected = skinRatio > 0.12 && skinRatio < 0.80;
            }
        } catch (err) {
            console.warn('Face detection error:', err);
            const imageData = ctx.getImageData(0, 0, regCanvas.width, regCanvas.height);
            const data = imageData.data;
            let totalBrightness = 0;
            const pixelCount = data.length / 4;
            for (let i = 0; i < data.length; i += 16) {
                totalBrightness += (data[i] + data[i+1] + data[i+2]) / 3;
            }
            const avgBrightness = totalBrightness / (pixelCount / 4);
            faceDetected = avgBrightness > 30 && avgBrightness < 240;
        }

        if (!faceDetected) {
            scNotify('warning', 'No face detected! Please position the senior\'s face clearly within the frame and try again.');
            regScanFaceBtn.innerHTML = 'Tap to Capture';
            regScanFaceBtn.disabled = false;
            return;
        }

        // ── Face validated ──
        regCapturedFaceData = regCanvas.toDataURL('image/jpeg', 0.7);

        // Stop camera
        stopRegCamera();
        if (regFaceGuide) regFaceGuide.style.display = 'none';

        // Show preview
        if (regCapturedPreview) {
            regCapturedPreview.src = regCapturedFaceData;
            regCapturedPreview.style.display = 'block';
        }

        // Update UI
        regScanFaceBtn.style.display = 'none';
        if (regRetakeBtn) regRetakeBtn.style.display = 'block';
        if (regFaceStatus) {
            regFaceStatus.innerHTML = 'Face captured successfully';
            regFaceStatus.style.color = '#22c55e';
        }
    }

    // Form submit
    if (empRegisterForm) {
        empRegisterForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            // Require face scan
            if (!regCapturedFaceData) {
                scNotify('warning', 'Face scan is required! Please capture the senior\'s face before submitting.');
                return;
            }

            const email = document.getElementById('regEmail').value.trim();
            const password = document.getElementById('regPassword').value;
            const confirmPassword = document.getElementById('regConfirmPassword').value;
            const lastName = document.getElementById('regLastName').value.trim();
            const firstName = document.getElementById('regFirstName').value.trim();
            const middleName = document.getElementById('regMiddleName').value.trim();
            const extension = document.getElementById('regExtension').value.trim();
            const seniorId = document.getElementById('regSeniorId').value.trim();
            const dob = document.getElementById('regDob').value;
            const sex = document.getElementById('regSex').value;
            const civilStatus = document.getElementById('regCivil').value;
            const address = document.getElementById('regAddress').value.trim();
            const barangay = document.getElementById('regBarangay').value.trim();
            const city = document.getElementById('regCity').value.trim();
            const province = document.getElementById('regProvince').value.trim();
            const postalCode = document.getElementById('regPostalCode').value.trim();
            const citizenship = document.getElementById('regCitizenship').value;
            const cpNumber = document.getElementById('regCpNumber').value.trim();
            const submitBtn = document.getElementById('submitRegBtn');

            // Build full name from parts
            const fullname = [firstName, middleName, lastName]
                .filter(Boolean).join(' ') + (extension ? ` ${extension}` : '');

            // Validate
            if (password !== confirmPassword) {
                scNotify('warning', 'Passwords do not match. Please re-enter.');
                return;
            }
            if (password.length < 6) {
                scNotify('warning', 'Password must be at least 6 characters.');
                return;
            }

            const originalText = submitBtn.innerHTML;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating Account...';
            submitBtn.disabled = true;

            try {
                const token = await auth.currentUser.getIdToken();
                const response = await fetch('/api/register-senior', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({
                        email,
                        password,
                        fullname,
                        firstName,
                        middleName,
                        lastName,
                        extension,
                        seniorId,
                        address,
                        barangay,
                        city,
                        province,
                        postalCode,
                        citizenship,
                        cpNumber,
                        dob,
                        sex,
                        civilStatus,
                        faceImage: regCapturedFaceData,
                        registeredBy: window.currentStaffName || 'Employee'
                    })
                });

                const data = await response.json();

                if (data.success) {
                    scNotify('success', `Senior account for "${fullname}" created successfully! They can now login with their email and password.`);
                    empRegisterForm.reset();
                    regCapturedFaceData = null;
                    resetRegFaceUI();
                    registerFormContent.style.display = 'none';
                    registerCTA.style.display = 'block';
                } else {
                    scNotify('error', data.message || 'Failed to create account.');
                }
            } catch (err) {
                console.error('Registration error:', err);
                scNotify('error', 'Network error. Please check your connection and try again.');
            } finally {
                submitBtn.innerHTML = originalText;
                submitBtn.disabled = false;
            }
        });
    }
});

// ── Maintenance overlay ──────────────────────────────────────────────────────
function showMaintenanceOverlay() {
    if (document.getElementById('maintenanceOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'maintenanceOverlay';
    overlay.style.cssText = `
        position:fixed;inset:0;z-index:9999;
        background:rgba(15,23,42,0.92);
        display:flex;flex-direction:column;
        justify-content:center;align-items:center;
        backdrop-filter:blur(8px);`;
    overlay.innerHTML = `
        <div style="background:#1e293b;border:1px solid #334155;border-radius:20px;
                    padding:50px 60px;text-align:center;max-width:500px;
                    box-shadow:0 25px 50px rgba(0,0,0,0.5);">
            <div style="font-size:2.5rem;margin-bottom:20px;">⚠️</div>
            <h2 style="color:#f8fafc;font-size:1.8rem;margin-bottom:12px;">System Under Maintenance</h2>
            <p style="color:#94a3b8;line-height:1.7;margin-bottom:25px;">
                The administrator has temporarily taken SilverCare offline.<br>You will be logged out automatically.
            </p>
            <span style="color:#f59e0b;font-weight:700;">🔄 Signing you out in 3 seconds...</span>
        </div>`;
    document.body.appendChild(overlay);
}

// ── Dashboard renderer ───────────────────────────────────────────────────────
function renderEmployeeDashboard(usersData) {
    const verifyContainer  = document.getElementById('verifyListContainer');
    const processContainer = document.getElementById('processListContainer');
    if (!verifyContainer) return;

    verifyContainer.innerHTML  = '';
    if (processContainer) processContainer.innerHTML = '';
    
    const selectUserList = document.getElementById('selectUserList');
    if (selectUserList) selectUserList.innerHTML = '';

    let pendingCount = 0;
    let activeCount  = 0;
    const now = new Date();
    const thisMonthCount = { val: 0 };

    for (const [uid, user] of Object.entries(usersData)) {
        if (user.role !== 'senior') continue;
        // Archive Function: archived records never reach the processing lists
        if (isArchivedSenior(user)) continue;

        const initial  = user.name ? user.name.charAt(0).toUpperCase() : '?';
        const avatarColors = ['avatar-blue', 'avatar-lightblue', 'avatar-bluegreen'];
        const avatarClass  = avatarColors[Math.abs(uid.charCodeAt(0)) % avatarColors.length];

        // Count registrations this month
        if (user.createdAt) {
            const created = new Date(user.createdAt);
            if (created.getMonth() === now.getMonth() && created.getFullYear() === now.getFullYear()) {
                thisMonthCount.val++;
            }
        }

        if (user.status === 'Pending') {
            pendingCount++;
            verifyContainer.innerHTML += `
                <div class="list-row">
                    <div class="list-row-left">
                        <div class="list-info">
                            <h4>${user.name}</h4>
                            <p>${user.email} &bull; Submitted for verification</p>
                        </div>
                    </div>
                    <div class="list-actions">
                        <button class="btn-outline-green" data-uid="${uid}" data-action="approve">Approve</button>
                        <button class="btn-outline-red"  data-uid="${uid}" data-action="reject">Reject</button>
                    </div>
                </div>`;

        } else if (user.status === 'Active') {
            activeCount++;
            if (processContainer) {
                processContainer.innerHTML += `
                    <div class="list-row">
                        <div class="list-row-left">
                            <div class="list-info">
                                <h4>${user.name}</h4>
                                <p>Senior ID: ${user.seniorId || 'Unassigned'}</p>
                            </div>
                        </div>
                        <div class="list-actions">
                            <span class="badge-green">Active</span>
                            <button class="btn-solid-blue" data-uid="${uid}" data-action="process">Process</button>
                        </div>
                    </div>`;
            }


            if (selectUserList) {
                selectUserList.innerHTML += `
                    <label style="display: flex; align-items: center; justify-content: space-between; padding: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; transition: all 0.2s;">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <input type="checkbox" class="senior-reminder-checkbox" value="${uid}" style="width: 18px; height: 18px; cursor: pointer;">
                            <div style="display: flex; flex-direction: column;">
                                <span style="font-weight: 600; color: #1e293b; font-size: 0.95rem;">${user.name}</span>
                                <span style="font-size: 0.8rem; color: #64748b;">${user.email || 'No email provided'}</span>
                            </div>
                        </div>
                    </label>`;
            }
        }
    }

    // ── Empty states ──────────────────────────────────────────────────────────
    if (pendingCount === 0) {
        verifyContainer.innerHTML = `
            <div style="text-align:center;color:#64748b;padding:40px 20px;">
                No pending verifications at this time.
            </div>`;
    }
    if (activeCount === 0) {
        if (processContainer) {
            processContainer.innerHTML = `
                <div style="text-align:center;color:#64748b;padding:40px 20px;">
                    No active seniors to process.
                </div>`;
        }
    }

    // ── Update stat boxes ─────────────────────────────────────────────────────
    const elMonth = document.getElementById('statThisMonth');
    const elTotal = document.getElementById('statTotalRegistered');
    const elPend  = document.getElementById('statPending');
    if (elMonth) elMonth.textContent = thisMonthCount.val;
    if (elTotal) elTotal.textContent = activeCount + pendingCount;
    if (elPend)  elPend.textContent  = pendingCount;

    // ── Badge: Red dot on Verify tab when there are pending registrations ────
    const empVerifyBadge = document.getElementById('empVerifyBadge');

    // ── KYC Identity Verification Renderer ──────────────────────────────────
    const kycContainer = document.getElementById('kycVerifyListContainer');
    const kycCountBadge = document.getElementById('kycPendingCount');
    let kycPendingCount = 0;

    if (kycContainer) {
        kycContainer.innerHTML = '';
        for (const [uid, user] of Object.entries(usersData)) {
            if (user.role !== 'senior' || user.kycStatus !== 'Pending' || isArchivedSenior(user)) continue;
            kycPendingCount++;

            const initial = user.name ? user.name.charAt(0).toUpperCase() : '?';
            const submittedAt = user.kycSubmittedAt ? new Date(user.kycSubmittedAt).toLocaleString() : 'N/A';
            const kycDobPretty = kycFormatDob(user.dob);
            const prioLevel = String(user.priorityLevel || '');
            const prioColor = prioLevel === 'High' ? '#b91c1c' : prioLevel === 'Medium' ? '#b45309' : '#16a34a';

            kycContainer.innerHTML += `
                <div style="border: 1px solid #e2e8f0; border-radius: 14px; padding: 24px; margin-bottom: 20px; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.03);">
                    <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #f1f5f9;">
                        <div style="width: 48px; height: 48px; border-radius: 50%; background: #e0e7ff; color: #4f46e5; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.2rem;">${initial}</div>
                        <div>
                            <h4 style="margin: 0 0 2px; color: #1e293b; font-size: 1.1rem; font-weight: 700;">${user.name || 'N/A'}</h4>
                            <p style="margin: 0; color: #64748b; font-size: 0.85rem;">${user.email || 'No email'} &bull; OSCA ID: ${user.seniorId || 'N/A'} &bull; Submitted: ${submittedAt}</p>
                        </div>
                    </div>

                    ${hasReportedIllness(user) ? `
                    <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:10px; padding:12px 16px; margin-bottom:16px; color:#991b1b; font-size:0.85rem; font-weight:600; line-height:1.5;">
                        <i class="fas fa-heart-pulse"></i> <strong>Health Condition Reported:</strong> ${escHtml(user.healthCondition || user.condition || user.illness)} — this senior is automatically <strong>HIGH PRIORITY</strong> regardless of age. Please review the reported illness carefully during verification.
                    </div>` : ''}

                    <div style="display: flex; gap: 24px; margin-bottom: 20px;">
                        <div style="flex: 1;">
                            <h5 style="font-size: 0.85rem; font-weight: 700; color: #1e293b; margin: 0 0 4px;"><i class="fas fa-clipboard-list" style="margin-right:6px;color:#4f46e5;"></i>Senior's Filled-Up KYC Form</h5>
                            <p style="margin: 0 0 10px; font-size: 0.75rem; color: #64748b;">Everything below is exactly what the senior submitted during verification. Review each field against the uploaded ID before approving.</p>
                            <table style="width:100%; border-collapse: collapse; font-size: 0.9rem;">
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600; width: 150px;">First Name</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.firstName || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Middle Name</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.middleName || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Last Name</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.lastName || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Extension</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.extension || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Date of Birth</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(kycDobPretty || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Age</td><td style="padding: 6px 0; color: #1e293b;">${user.age ? escHtml(String(user.age)) + ' years old' : 'N/A'}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Sex</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.sex || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Civil Status</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.civilStatus || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Address</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.address || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Province</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.province || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Barangay</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.barangay || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">City</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.city || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Citizenship</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.citizenship || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Cellphone No.</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.cpNumber || 'N/A')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Health Condition / Illness</td><td style="padding: 6px 0; font-weight:700; color: ${hasReportedIllness(user) ? '#b91c1c' : '#16a34a'};">${escHtml(user.healthCondition || user.condition || user.illness || 'None reported')}</td></tr>
                                ${(hasReportedIllness(user) && user.illnessDetails && user.illnessDetails !== (user.healthCondition || user.condition || user.illness)) ? `<tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Illness Details</td><td style="padding: 6px 0; color: #1e293b;">${escHtml(user.illnessDetails)}</td></tr>` : ''}
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Senior Category</td><td style="padding: 6px 0; font-weight:600; color: #6d28d9;">${escHtml(user.seniorCategory || 'None')}</td></tr>
                                <tr><td style="padding: 6px 8px 6px 0; color: #64748b; font-weight: 600;">Suggested Priority Level</td><td style="padding: 6px 0; font-weight: 800; color: ${prioColor};">${escHtml(prioLevel || 'Low')}</td></tr>
                            </table>
                            <p style="margin: 8px 0 0; font-size: 0.72rem; color: #94a3b8;"><i class="fas fa-circle-info" style="margin-right:4px;"></i>The Senior Category and Priority Level are system-suggested from the senior's age and health answers — OSCA staff make the final decision when approving.</p>
                        </div>
                        <div style="width: 280px; flex-shrink: 0;">
                            <h5 style="font-size: 0.85rem; font-weight: 700; color: #1e293b; margin: 0 0 12px;">Face Scan</h5>
                            <div style="background: #0f172a; border-radius: 12px; overflow: hidden; border: 2px solid #e2e8f0; aspect-ratio: 4/3; display: flex; align-items: center; justify-content: center;">
                                ${user.kycFaceImage
                                    ? `<img src="${user.kycFaceImage}" alt="Face" style="width:100%;height:100%;object-fit:cover;">`
                                    : `<span style="color:#64748b;font-size:0.85rem;">No Image</span>`
                                }
                            </div>
                        </div>
                    </div>

                    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-bottom:16px;">
                        <h5 style="font-size:0.85rem; font-weight:700; color:#1e293b; margin:0 0 12px;">Senior ID — Back-to-Back <span style="font-weight:400; color:#ef4444;">* required</span></h5>
                        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                            <div>
                                <div style="font-size:0.75rem; font-weight:700; color:#475569; text-transform:uppercase; margin-bottom:6px;">Senior ID No.</div>
                                <div style="background:#f8fafc; border-radius:10px; border:1px solid #e2e8f0; padding:10px 12px; font-weight:700; color:#0f172a;">${escHtml(user.verificationSeniorId || user.seniorId || '—')}</div>
                            </div>
                            <div>
                                <div style="font-size:0.75rem; font-weight:700; color:#475569; text-transform:uppercase; margin-bottom:6px;">Medical Certification</div>
                                <div style="background:#f8fafc; border-radius:10px; border:1px solid #e2e8f0; padding:10px 12px; font-size:0.8rem; color:#334155;">${kycMedCertAvailable(user) ? ('Attached: ' + escHtml(user.kycMedCertName || 'file') + ' <span style="color:#15803d; font-weight:700;">(click to view below)</span>') : 'None attached'}</div>
                            </div>
                        </div>
                        <div style="display:flex; gap:14px; flex-wrap:wrap; margin-top:12px;">
                            <div>
                                <div style="font-size:0.75rem; font-weight:700; color:#475569; text-transform:uppercase; margin-bottom:6px;">Front Side</div>
                                <div style="width:150px; aspect-ratio:1.4/1; background:#0f172a; border-radius:10px; overflow:hidden; border:2px solid ${user.kycIdFrontImage ? '#22c55e' : '#fecaca'}; display:flex; align-items:center; justify-content:center;">
                                    ${user.kycIdFrontImage
                                        ? `<img src="${user.kycIdFrontImage}" alt="ID Front" style="width:100%;height:100%;object-fit:cover; cursor:zoom-in;" onclick="window.openDocViewer(this.src, 'Senior ID — Front', 'image')" title="Click to view full size">`
                                        : `<span style="color:#f87171;font-size:0.78rem; text-align:center; padding:12px;">Missing — No Front Image</span>`
                                    }
                                </div>
                            </div>
                            <div>
                                <div style="font-size:0.75rem; font-weight:700; color:#475569; text-transform:uppercase; margin-bottom:6px;">Back Side</div>
                                <div style="width:150px; aspect-ratio:1.4/1; background:#0f172a; border-radius:10px; overflow:hidden; border:2px solid ${user.kycIdBackImage ? '#22c55e' : '#fecaca'}; display:flex; align-items:center; justify-content:center;">
                                    ${user.kycIdBackImage
                                        ? `<img src="${user.kycIdBackImage}" alt="ID Back" style="width:100%;height:100%;object-fit:cover; cursor:zoom-in;" onclick="window.openDocViewer(this.src, 'Senior ID — Back', 'image')" title="Click to view full size">`
                                        : `<span style="color:#f87171;font-size:0.78rem; text-align:center; padding:12px;">Missing — No Back Image</span>`
                                    }
                                </div>
                            </div>
                            ${kycMedCertAvailable(user) ? `
                            <div>
                                <div style="font-size:0.75rem; font-weight:700; color:#166534; text-transform:uppercase; margin-bottom:6px;">Medical Certification</div>
                                <div style="width:150px; aspect-ratio:1.4/1; background:#0f172a; border-radius:10px; overflow:hidden; border:2px solid #22c55e; display:flex; align-items:center; justify-content:center; cursor:zoom-in;" onclick="window.openKycMedCert('${escapeHtmlAttr(uid)}')" title="Click to view full size">
                                    ${(/pdf/i.test(String(user.kycMedCertType || '')) || (user.kycMedCertImage && /^data:application\/pdf/i.test(String(user.kycMedCertImage))))
                                        ? `<span style="color:#4ade80; font-size:0.75rem; text-align:center; padding:10px;"><i class="fas fa-file-pdf" style="font-size:1.6rem; display:block; margin-bottom:6px;"></i>PDF document</span>`
                                        : (user.kycMedCertImage
                                            ? `<img src="${user.kycMedCertImage}" alt="Medical certification" style="width:100%;height:100%;object-fit:cover;">`
                                            : `<span style="color:#4ade80; font-size:0.75rem; text-align:center; padding:10px;"><i class="fas fa-file-medical" style="font-size:1.6rem; display:block; margin-bottom:6px;"></i>Stored copy</span>`)
                                    }
                                </div>
                            </div>` : ''}
                        </div>
                        ${(!kycMedCertAvailable(user) && hasReportedIllness(user)) ? `<div style="margin-top:10px; padding:8px 12px; background:#fef2f2; border:1px solid #fecaca; color:#991b1b; border-radius:8px; font-size:0.8rem; font-weight:600;">No medical certification is currently available for this senior even though an illness was reported. Please ask the senior to re-submit before approving.</div>` : ''}
                        ${(!user.kycIdFrontImage || !user.kycIdBackImage) ? `<div style="margin-top:10px; padding:8px 12px; background:#fef2f2; border:1px solid #fecaca; color:#991b1b; border-radius:8px; font-size:0.8rem; font-weight:600;">Incomplete ID — both front and back are required. Please reject if not provided.</div>` : `<div style="margin-top:8px; font-size:0.72rem; color:#64748b;">Click a thumbnail to view it fully (X button to close). Verify that the ID is clear, readable, and matches the submitted personal info.</div>`}
                    </div>

                    <div style="display: flex; gap: 10px; justify-content: flex-end; border-top: 1px solid #f1f5f9; padding-top: 16px;">
                        <button class="btn-outline-red" data-uid="${uid}" data-action="kyc-reject" style="padding: 10px 24px; border-radius: 8px;">
                            Reject
                        </button>
                        <button class="btn-outline-green" data-uid="${uid}" data-action="kyc-approve" style="padding: 10px 24px; border-radius: 8px;">
                            Approve Verification
                        </button>
                    </div>
                </div>`;
        }

        if (kycPendingCount === 0) {
            kycContainer.innerHTML = `
                <div style="text-align:center;color:#64748b;padding:40px 20px;">
                    No pending KYC submissions at this time.
                </div>`;
        }

        if (kycCountBadge) {
            kycCountBadge.textContent = kycPendingCount;
            kycCountBadge.style.display = kycPendingCount > 0 ? 'inline-block' : 'none';
        }
    }

    // ── Update badge to cover both account + KYC pending ─────────────────────
    if (empVerifyBadge) {
        empVerifyBadge.style.display = (pendingCount + kycPendingCount) > 0 ? 'block' : 'none';
    }

    // Cache users data for history toggle re-renders + the health review list
    window.lastUsersData = usersData;

    // Re-render Process Benefits claims when user data changes (e.g. a senior's
    // approval notification just landed) so the claim list stays in sync.
    if (window.lastClaimsData) renderClaimsDashboard(window.lastClaimsData);

    // ── Update Health Records notification indicator badge ──────────────────
    // (pending appointment requests + certifications awaiting staff review)
    updateHealthTabBadge();

    // ── Render Senior Appointment Requests (Approve / Decline) ────────────
    renderSeniorAppointmentRequests(usersData, window.lastQueuesData || {});

    // ── Render Senior Illness & Priority Management (Health Records tab) ───
    // Lists every verified senior with the illness / medical certification
    // they uploaded so staff can set the official health + priority level.
    if (window.renderHealthRequests) window.renderHealthRequests();

    // ── Render Dual Pension Setup (Process Benefits) ──────────────────────────
    initPensionSettingsEditor();
    ensureVerifiedSeniorsHavePension(usersData);
    renderPensionSetup(usersData);

    // ── Dashboard overview (stat cards + charts) ──────────────────────────
    renderEmpOverviewDashboard();

    // ── Seniors by Priority Level section (dashboard) ─────────────────────
    renderPrioritySeniorsDashboard();

    // ── Archive tab (archived records, integrity scan, backup status) ──────
    renderArchiveDashboard();

    // ── Attach button listeners ───────────────────────────────────────────────
    attachButtonListeners();
}

// ── Employee Dashboard Overview: stat cards + Pie / Bar charts ───────────
// Sources (all realtime):
//   users  -> window.lastUsersData  (Total Seniors, Total Registered, verify pie, regs bar)
//   claims -> window.lastClaimsData (Pending Assistance)
//   queue  -> window.lastQueuesData (Pending Appointments)
// ── Registrations per Month: custom date-range filter (state + helpers) ───
// window._empRegsRange: null = default (last 6 months up to the current
// month); otherwise { fy, fm, ty, tm } — calendar-month bounds (fm/tm are
// 0-based). The chart counts registrations per month within this range.
window._empRegsRange = null;
const REGS_MAX_MONTHS = 24; // cap the span so the bar chart stays readable

function regsMonthsInRange() {
    const nowD = new Date();
    let fy, fm, ty, tm;
    if (window._empRegsRange) {
        fy = window._empRegsRange.fy; fm = window._empRegsRange.fm;
        ty = window._empRegsRange.ty; tm = window._empRegsRange.tm;
        const nowKey = nowD.getFullYear() * 12 + nowD.getMonth();
        // "To" cannot be in the future (no registrations exist yet)
        if (ty * 12 + tm > nowKey) { ty = nowD.getFullYear(); tm = nowD.getMonth(); }
        // Reversed order (From after To) → swap the bounds
        if (fy * 12 + fm > ty * 12 + tm) {
            const sy = fy, sm = fm; fy = ty; fm = tm; ty = sy; tm = sm;
        }
        // Enforce the maximum span
        if ((ty * 12 + tm) - (fy * 12 + fm) + 1 > REGS_MAX_MONTHS) {
            fy = ty; fm = tm - (REGS_MAX_MONTHS - 1);
            while (fm < 0) { fm += 12; fy -= 1; }
        }
    } else {
        ty = nowD.getFullYear(); tm = nowD.getMonth();
        fy = ty; fm = tm - 5;
        while (fm < 0) { fm += 12; fy -= 1; }
    }
    const months = [];
    const total = (ty * 12 + tm) - (fy * 12 + fm) + 1;
    for (let i = 0; i < total; i++) {
        const m = fm + i, y = fy + Math.floor(m / 12);
        months.push({ y, m: m % 12 });
    }
    return months;
}

// Bind the date inputs (From / To / Reset) exactly once — safe to call on
// every render because of the guard.
window._bindRegsDateFilter = function () {
    if (window._regsFilterBound) return;
    const fromEl = document.getElementById('regsFilterFrom');
    const toEl = document.getElementById('regsFilterTo');
    const resetEl = document.getElementById('regsFilterReset');
    if (!fromEl || !toEl) return;
    window._regsFilterBound = true;

    const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD (local)
    fromEl.max = todayStr;
    toEl.max = todayStr;

    function parseVal(v) {
        if (!v) return null;
        const p = String(v).split('-').map(Number);
        if (p.length < 3 || p.some(n => isNaN(n))) return null;
        return { y: p[0], m: p[1] - 1, d: p[2] };
    }

    function apply() {
        let fv = parseVal(fromEl.value);
        let tv = parseVal(toEl.value);
        if (!fv && !tv) return; // nothing selected yet — keep the current view
        if (fv && !tv) { // only "From" picked → range ends today
            toEl.value = todayStr;
            tv = parseVal(todayStr);
        } else if (tv && !fv) { // only "To" picked → 5-month window ending there
            fromEl.value = new Date(tv.y, tv.m - 5, 1).toLocaleDateString('en-CA');
            fv = parseVal(fromEl.value);
        }
        window._empRegsRange = { fy: fv.y, fm: fv.m, ty: tv.y, tm: tv.m };
        if (resetEl) resetEl.style.display = '';
        renderEmpOverviewDashboard();
    }

    fromEl.addEventListener('change', apply);
    toEl.addEventListener('change', apply);
    if (resetEl) {
        resetEl.addEventListener('click', () => {
            fromEl.value = '';
            toEl.value = '';
            window._empRegsRange = null;
            resetEl.style.display = 'none';
            renderEmpOverviewDashboard();
        });
    }
};

function renderEmpOverviewDashboard() {
    const elTotal = document.getElementById('dashTotalSeniors');
    if (!elTotal) return; // not on employee page / dashboard tab missing
    window._bindRegsDateFilter();
    const usersData = window.lastUsersData || {};
    const claimsData = window.lastClaimsData || {};
    const queuesData = window.lastQueuesData || {};

    const allSeniors = Object.values(usersData).filter(u => u && u.role === 'senior');
    // Archive Function: only ACTIVE senior citizens are counted in the main
    // dashboard; archived records are shown separately in the Archive tab.
    const seniors = allSeniors.filter(u => isActiveSenior(u));
    const archivedSeniorsCount = allSeniors.length - seniors.length;
    const totalSeniors = seniors.length;
    const totalRegistered = seniors.filter(s => getSeniorStatus(s) === 'Active').length;
    const pendingAssistance = Object.values(claimsData).filter(c => c && c.status === 'Pending').length;
    const pendingQueue = Object.values(queuesData).filter(q => q && (q.status === 'Pending' || q.status === 'Rescheduled')).length;
    const pendingAppointments = pendingQueue;

    elTotal.textContent = totalSeniors;
    const elReg = document.getElementById('dashTotalRegistered');
    if (elReg) elReg.textContent = totalRegistered;
    const elAppt = document.getElementById('dashPendingAppointments');
    if (elAppt) elAppt.textContent = pendingAppointments;
    const elAssist = document.getElementById('dashPendingAssistance');
    if (elAssist) elAssist.textContent = pendingAssistance;

    // ── Archived Records stat card (links to the Archive tab) ──
    const elArchived = document.getElementById('dashArchivedCount');
    if (elArchived) elArchived.textContent = archivedSeniorsCount;

    // ── Documents to Verify: seniors with KYC pending review ──
    const docsToVerify = seniors.filter(s => s.kycStatus === 'Pending').length;
    const elDocs = document.getElementById('dashDocsToVerify');
    if (elDocs) elDocs.textContent = docsToVerify;
    const elDocsDot = document.getElementById('empVerifyBadge');
    if (elDocsDot) elDocsDot.style.display = docsToVerify > 0 ? 'block' : 'none';

    // ── Priority breakdown strip — age solely determines the category:
    //   age <= 89 → Low   |   age 90-99 → Medium   |   age >= 100 → High
    let highCount = 0, mediumCount = 0, lowCount = 0;
    seniors.forEach(s => {
        const lvl = (typeof calculatePriorityLevel === 'function') ? calculatePriorityLevel(s) : 'Low';
        if (lvl === 'High') highCount++;
        else if (lvl === 'Medium') mediumCount++;
        else lowCount++;
    });
    const elHigh = document.getElementById('dashHighCount');
    if (elHigh) elHigh.textContent = highCount;
    const elMed = document.getElementById('dashMediumCount');
    if (elMed) elMed.textContent = mediumCount;
    const elLow = document.getElementById('dashLowCount');
    if (elLow) elLow.textContent = lowCount;

    // ── Verification split (shared by donut chart + HTML legend) ───────────
    let verified = 0, kycPending = 0, unverified = 0;
    seniors.forEach(s => {
        if (s.kycStatus === 'Verified') verified++;
        else if (s.kycStatus === 'Pending') kycPending++;
        else unverified++;
    });
    const totalVerify = verified + kycPending + unverified;
    const pct1 = n => totalVerify > 0 ? (n / totalVerify * 100).toFixed(1) + '%' : '0.0%';
    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setTxt('dashVerifyTotalPill', 'Total: ' + totalVerify);
    setTxt('legendVerifiedCount', verified);     setTxt('legendVerifiedPct', pct1(verified));
    setTxt('legendPendingCount', kycPending);    setTxt('legendPendingPct', pct1(kycPending));
    setTxt('legendUnverifiedCount', unverified); setTxt('legendUnverifiedPct', pct1(unverified));

    // ── Registrations per month (respects the custom date filter) ──────────
    const regsMonths = regsMonthsInRange();
    const multiYear = regsMonths[0].y !== regsMonths[regsMonths.length - 1].y;
    const monthLabels = regsMonths.map(r => {
        const lbl = new Date(r.y, r.m, 1).toLocaleDateString('en-US', { month: 'short' });
        return multiYear ? lbl + " '" + String(r.y).slice(2) : lbl;
    });
    const monthCounts = regsMonths.map(() => 0);
    const regsStartKey = regsMonths[0].y * 12 + regsMonths[0].m;
    seniors.forEach(s => {
        if (!s.createdAt) return;
        const c = new Date(Number(s.createdAt));
        if (isNaN(c.getTime())) return;
        const idx = (c.getFullYear() * 12 + c.getMonth()) - regsStartKey;
        if (idx >= 0 && idx < regsMonths.length) monthCounts[idx]++;
    });

    // Chart subtitle reflects the active date range
    const regsSub = document.getElementById('regsChartSub');
    if (regsSub) {
        const fromLbl = new Date(regsMonths[0].y, regsMonths[0].m, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        const lastM = regsMonths[regsMonths.length - 1];
        const toLbl = new Date(lastM.y, lastM.m, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        regsSub.textContent = (window._empRegsRange
            ? 'New senior accounts from ' + fromLbl + ' to ' + toLbl
            : 'New senior accounts in the last 6 months') + ' \u2192 click a month to view seniors';
    }

    if (typeof Chart === 'undefined') return; // CDN blocked — stats still show
    window._empCharts = window._empCharts || {};
    function drawChart(id, config) {
        const canvas = document.getElementById(id);
        if (!canvas) return;
        if (window._empCharts[id]) {
            try { window._empCharts[id].destroy(); } catch (e) {}
        }
        try { window._empCharts[id] = new Chart(canvas, config); } catch (e) { console.warn('Chart render skipped (' + id + '):', e.message); }
    }

    // Plugin: total count in the middle of the donut
    const donutCenterText = {
        id: 'donutCenterText',
        afterDraw(chart) {
            const meta = chart.getDatasetMeta(0);
            if (!meta.data.length) return;
            const { x, y } = meta.data[0];
            const { ctx } = chart;
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '700 26px Inter, sans-serif';
            ctx.fillStyle = '#0f172a';
            ctx.fillText(String(chart.data.datasets[0].data.reduce((a, b) => a + b, 0)), x, y - 8);
            ctx.font = '500 12px Inter, sans-serif';
            ctx.fillStyle = '#64748b';
            ctx.fillText('Total', x, y + 14);
            ctx.restore();
        }
    };

    // Plugin: % labels drawn on donut segments (skip slices < 5%)
    const donutSegLabels = {
        id: 'donutSegLabels',
        afterDatasetsDraw(chart) {
            const data = chart.data.datasets[0].data;
            const total = data.reduce((a, b) => a + b, 0);
            if (!total) return;
            const { ctx } = chart;
            const meta = chart.getDatasetMeta(0);
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '700 11px Inter, sans-serif';
            meta.data.forEach((arc, i) => {
                if (!data[i] || (data[i] / total * 100) < 5) return;
                const r = (arc.innerRadius + arc.outerRadius) / 2;
                const ang = (arc.startAngle + arc.endAngle) / 2;
                ctx.fillStyle = '#ffffff';
                ctx.fillText((data[i] / total * 100).toFixed(1) + '%', arc.x + Math.cos(ang) * r, arc.y + Math.sin(ang) * r);
            });
            ctx.restore();
        }
    };

    // 1) Donut: seniors by verification status (HTML legend handles labels)
    drawChart('chartVerifyPie', {
        type: 'doughnut',
        data: { labels: ['Verified', 'Pending Review', 'Unverified'], datasets: [{ data: [verified, kycPending, unverified], backgroundColor: ['#22c55e', '#f59e0b', '#94a3b8'], borderWidth: 2, borderColor: '#ffffff', hoverOffset: 6 }] },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '68%',
            plugins: { legend: { display: false } },
            onClick: (evt, elements) => {
                if (evt && evt.native && evt.native.stopPropagation) evt.native.stopPropagation();
                if (elements && elements.length > 0) {
                    const idx = elements[0].index;
                    if (idx === 0) window.openSeniorListModal('verification', 'Verified');
                    else if (idx === 1) window.openSeniorListModal('verification', 'Pending');
                    else window.openSeniorListModal('verification', 'Unverified');
                }
            }
        },
        plugins: [donutCenterText, donutSegLabels]
    });

    // Plugin: value labels above each bar
    const barValueLabels = {
        id: 'barValueLabels',
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            const meta = chart.getDatasetMeta(0);
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.font = '700 11px Inter, sans-serif';
            ctx.fillStyle = '#334155';
            meta.data.forEach((bar, i) => {
                ctx.fillText(String(chart.data.datasets[0].data[i]), bar.x, bar.y - 4);
            });
            ctx.restore();
        }
    };

    // 2) Bar: registrations per month (blue→purple gradient bars)
    drawChart('chartRegsBar', {
        type: 'bar',
        data: { labels: monthLabels, datasets: [{
            label: 'New seniors',
            data: monthCounts,
            backgroundColor: (ctx2) => {
                const { chart } = ctx2;
                const { ctx, chartArea } = chart;
                if (!chartArea) return '#6366f1';
                const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                g.addColorStop(0, '#3b82f6');
                g.addColorStop(1, '#8b5cf6');
                return g;
            },
            borderRadius: 8,
            borderSkipped: false,
            barPercentage: 0.55,
            categoryPercentage: 0.7
        }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            layout: { padding: { top: 18 } },
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, ticks: { precision: 0, color: '#64748b', font: { size: 11 } }, grid: { color: '#eef2f7' }, border: { display: false } },
                x: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { display: false }, border: { display: false } }
            },
            onClick: (evt, elements) => {
                if (evt && evt.native && evt.native.stopPropagation) evt.native.stopPropagation();
                if (elements && elements.length > 0) {
                    const idx = elements[0].index; // 0 = oldest month in the active range
                    const r = regsMonths[idx];
                    if (r) window.openSeniorListModal('month', r.y + '-' + r.m);
                }
            }
        },
        plugins: [barValueLabels]
    });
    // Keep Seniors-by-Priority counts in sync whenever charts re-render
    // (charts return early when the Chart.js CDN is blocked).
    renderPrioritySeniorsDashboard();
}

// ── Seniors by Priority Level: cards grid ─────────────────────────────────
function renderPrioritySeniorsDashboard() {
    const grid = document.getElementById('prioritySeniorsGrid');
    if (!grid) return; // not on employee page
    const usersData = window.lastUsersData || {};
    const seniors = Object.entries(usersData)
        .filter(([, u]) => u && u.role === 'senior' && isActiveSenior(u))
        .map(([uid, u]) => ({ uid, ...(u || {}) }));
    const withLevel = seniors.map(s => ({
        ...s,
        _level: calculatePriorityLevel(s),
        _age: prioritySeniorAge(s)
    }));
    const counts = {
        All: withLevel.length,
        High: withLevel.filter(s => s._level === 'High').length,
        Medium: withLevel.filter(s => s._level === 'Medium').length,
        Low: withLevel.filter(s => s._level === 'Low').length
    };
    const setCount = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setCount('prioCountAll', counts.All);
    setCount('prioCountHigh', counts.High);
    setCount('prioCountMedium', counts.Medium);
    setCount('prioCountLow', counts.Low);
    const totalPill = document.getElementById('prioritySeniorsTotalPill');
    if (totalPill) totalPill.textContent = 'Total: ' + counts.All;
    const filter = window._prioritySeniorFilter || 'All';
    const term = (window._prioritySeniorSearch || '').toLowerCase();
    let list = withLevel.filter(s => filter === 'All' || s._level === filter);
    if (term) {
        list = list.filter(s =>
            String(s.name || '').toLowerCase().includes(term) ||
            String(s.seniorId || '').toLowerCase().includes(term) ||
            String(s.email || '').toLowerCase().includes(term));
    }
    const rank = { High: 0, Medium: 1, Low: 2 };
    list.sort((a, b) => ((rank[a._level] ?? 3) - (rank[b._level] ?? 3)) ||
        String(a.name || '').localeCompare(String(b.name || '')));
    if (list.length === 0) {
        grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#64748b; padding:30px 20px; border:1px dashed #cbd5e1; border-radius:12px; font-size:0.88rem;">' +
            (counts.All === 0 ? 'No active senior accounts yet.' : 'No seniors match this priority filter / search.') + '</div>';
        return;
    }
    grid.innerHTML = list.map(s => {
        const meta = priorityMeta(s._level);
        const initial = String(s.name || '?').charAt(0).toUpperCase();
        const claims = prioritySeniorClaims(s.uid);
        const appts = prioritySeniorAppointments(s.uid);
        const txs = prioritySeniorTransactions(s.uid, s);
        const pendingReqs = claims.filter(c => c.status === 'Pending').length +
            appts.filter(q => ['Pending', 'Rescheduled'].includes(q.status)).length;
        const recent = txs[0];
        const recentTxt = recent
            ? (String(recent.type || 'Transaction') + ' - ' + priorityFmtDate(recent.createdAt))
            : 'No transactions yet';
        const kyc = s.kycStatus || 'Unverified';
        const kycColor = kyc === 'Verified' ? '#166534' : (kyc === 'Pending' ? '#92400e' : '#64748b');
        return '<div class="emp-prio-card" style="--pc:' + meta.dot + ';" onclick="window.openPrioritySeniorModal(\'' + String(s.uid).replace(/'/g, '') + '\')" title="View profile, transactions, requests and history">' +
            '<div style="display:flex; align-items:center; gap:12px; margin-bottom:10px;">' +
            '<div style="width:44px; height:44px; border-radius:50%; background:' + meta.bg + '; color:' + meta.color + '; border:1px solid ' + meta.bd + '; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:1.05rem; flex-shrink:0;">' + escHtml(initial) + '</div>' +
            '<div style="min-width:0; flex:1;"><div style="font-weight:700; color:#0f172a; font-size:0.95rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + escHtml(s.name || 'Senior Citizen') + '</div>' +
            '<div style="font-size:0.76rem; color:#64748b;">OSCA ID: <strong style="color:#334155;">' + escHtml(s.seniorId || 'N/A') + '</strong>' + (s._age != null ? ' &bull; ' + escHtml(String(s._age)) + ' yrs old' : '') + '</div></div>' +
            '<span style="font-size:0.68rem; font-weight:800; color:' + meta.color + '; background:' + meta.bg + '; border:1px solid ' + meta.bd + '; padding:4px 10px; border-radius:999px; white-space:nowrap;">' + escHtml(s._level).toUpperCase() + '</span></div>' +
            '<div style="display:flex; gap:14px; flex-wrap:wrap; font-size:0.76rem; color:#64748b; margin-bottom:8px;">' +
            '<span>Verification: <strong style="color:' + kycColor + ';">' + escHtml(kyc) + '</strong></span>' +
            '<span>Requests: <strong style="color:#0f172a;">' + (claims.length + appts.length) + '</strong>' + (pendingReqs > 0 ? ' <span style="color:#b45309; font-weight:800;">(' + pendingReqs + ' pending)</span>' : '') + '</span>' +
            '<span>Transactions: <strong style="color:#0f172a;">' + txs.length + '</strong></span></div>' +
            '<div style="font-size:0.76rem; color:#64748b; border-top:1px dashed #e2e8f0; padding-top:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Recent: <span style="color:#334155; font-weight:600;">' + escHtml(recentTxt) + '</span></div>' +
            '<div style="margin-top:8px; font-size:0.78rem; font-weight:700; color:#2563eb;">View profile and history &rarr;</div></div>';
    }).join('');
}

// ── Senior Accounts List Modal (dashboard chart drill-down) ───────────────────
window.openSeniorListModal = function(mode, value) {
    const modal = document.getElementById('seniorListModal');
    const titleEl = document.getElementById('seniorListTitle');
    const subEl = document.getElementById('seniorListSub');
    const content = document.getElementById('seniorListContent');
    if (!modal || !content) return;

    const usersData = window.lastUsersData || {};
    // Archive Function: archived records are excluded from the default views;
    // they are listed via the dedicated 'archived' mode instead.
    const seniors = Object.values(usersData).filter(u => u && u.role === 'senior' && !isArchivedSenior(u));

    let list = seniors;
    let title = 'All Senior Accounts';
    let sub = seniors.length + ' senior account(s)';

    if (mode === 'archived') {
        list = Object.values(usersData).filter(u => u && u.role === 'senior' && isArchivedSenior(u));
        title = 'Archived Records';
        sub = list.length + ' archived senior record(s) — Inactive, Deceased or Transferred (see Archive tab)';
    } else if (mode === 'verification') {
        list = seniors.filter(s => {
            const kyc = s.kycStatus || '';
            if (value === 'Verified') return kyc === 'Verified';
            if (value === 'Pending') return kyc === 'Pending';
            return kyc !== 'Verified' && kyc !== 'Pending';
        });
        title = value === 'Pending' ? 'Seniors — Pending Review' : 'Seniors — ' + value;
        sub = list.length + ' senior account(s) with verification status: ' + value;
    } else if (mode === 'month') {
        // value = 'YYYY-M' (M is 0-based) — an exact calendar month, so this
        // works for any custom date range on the registrations chart.
        const parts = String(value).split('-');
        const y = Number(parts[0]);
        const m = Number(parts[1]);
        list = seniors.filter(s => {
            if (!s.createdAt) return false;
            const c = new Date(Number(s.createdAt));
            if (isNaN(c.getTime())) return false;
            return c.getFullYear() === y && c.getMonth() === m;
        });
        const label = new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        title = 'Seniors Registered — ' + label;
        sub = list.length + ' senior account(s) registered in ' + label;
    }

    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = sub;

    if (list.length === 0) {
        content.innerHTML = `
            <div style="text-align:center; color:#71717a; padding:36px 20px; border:1px dashed #d4d4d8; border-radius:4px;">
                No senior accounts found for this filter.
            </div>`;
    } else {
        const sorted = [...list].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        content.innerHTML = `
            <table style="width:100%; border-collapse:collapse; font-size:0.88rem;">
                <thead>
                    <tr style="border-bottom:2px solid #1e293b; color:#52525b; text-align:left;">
                        <th style="padding:8px 10px; font-weight:600;">Senior Name</th>
                        <th style="padding:8px 10px; font-weight:600;">OSCA ID</th>
                        <th style="padding:8px 10px; font-weight:600;">Age</th>
                        <th style="padding:8px 10px; font-weight:600;">Email</th>
                        <th style="padding:8px 10px; font-weight:600;">Verification</th>
                        <th style="padding:8px 10px; font-weight:600;">Account Status</th>
                        <th style="padding:8px 10px; font-weight:600;">Priority</th>
                    </tr>
                </thead>
                <tbody>
                ${sorted.map(s => {
                    const age = Number(s.age) || (s.dob ? Math.max(0, new Date().getFullYear() - new Date(s.dob).getFullYear()) : '');
                    const kyc = s.kycStatus || 'Unverified';
                    const priority = (typeof calculatePriorityLevel === 'function') ? calculatePriorityLevel(s) : 'Low';
                    const kycColor = kyc === 'Verified' ? '#166534' : (kyc === 'Pending' ? '#92400e' : '#52525b');
                    return `
                    <tr style="border-bottom:1px solid #e4e4e7;">
                        <td style="padding:9px 10px; font-weight:600; color:#1e293b;">${escHtml(s.name || 'Senior Citizen')}</td>
                        <td style="padding:9px 10px; color:#3f3f46;">${escHtml(s.seniorId || 'N/A')}</td>
                        <td style="padding:9px 10px; color:#3f3f46;">${escHtml(String(age || 'N/A'))}</td>
                        <td style="padding:9px 10px; color:#3f3f46;">${escHtml(s.email || 'N/A')}</td>
                        <td style="padding:9px 10px; font-weight:600; color:${kycColor};">${escHtml(kyc)}</td>
                        <td style="padding:9px 10px; color:#3f3f46;">${escHtml(getSeniorStatus(s))}</td>
                        <td style="padding:9px 10px; font-weight:600; color:${priority === 'High' ? '#b91c1c' : (priority === 'Medium' ? '#b45309' : '#1d4ed8')};">${escHtml(priority)}</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>`;
    }

    modal.style.display = 'flex';
};

// ── Senior Profile Modal: profile + transactions + requests + history ────
// mode: open from the Seniors-by-Priority cards. Shows recent transactions,
// all requests (assistance claims + appointments), assistance received,
// the full transaction history, assistance received, account creation date
// and verification date for the selected senior.
window.openPrioritySeniorModal = function(uid) {
    const usersData = window.lastUsersData || {};
    const senior = usersData[uid];
    const modal = document.getElementById('prioritySeniorModal');
    const titleEl = document.getElementById('prioritySeniorTitle');
    const subEl = document.getElementById('prioritySeniorSub');
    const content = document.getElementById('prioritySeniorContent');
    if (!modal || !content) return;
    if (!senior) return;
    window._prioritySeniorUid = uid;
    const level = calculatePriorityLevel(senior);
    const meta = priorityMeta(level);
    const age = prioritySeniorAge(senior);
    const kyc = senior.kycStatus || 'Unverified';
    const kycColor = kyc === 'Verified' ? '#166534' : (kyc === 'Pending' ? '#92400e' : '#64748b');
    const acctStatus = getSeniorStatus(senior);
    if (titleEl) titleEl.textContent = senior.name || 'Senior Citizen';
    if (subEl) subEl.textContent = 'OSCA ID: ' + (senior.seniorId || 'N/A') + ' - ' + level + ' priority - ' + kyc;
    let html = '';
    html += '<div style="display:flex; align-items:center; gap:14px; background:' + meta.bg + '; border:1px solid ' + meta.bd + '; border-radius:12px; padding:14px 16px; margin-bottom:16px; flex-wrap:wrap;">';
    html += '<div style="width:52px; height:52px; border-radius:50%; background:white; color:' + meta.color + '; border:1px solid ' + meta.bd + '; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:1.3rem;">' + escHtml(String(senior.name || '?').charAt(0).toUpperCase()) + '</div>';
    html += '<div style="flex:1; min-width:220px;"><div style="font-weight:800; color:#0f172a; font-size:1.02rem;">' + escHtml(senior.name || 'Senior Citizen') + '</div>';
    html += '<div style="font-size:0.8rem; color:#475569; margin-top:2px;">' + escHtml(senior.email || 'No email') + ' &bull; OSCA ID: <strong>' + escHtml(senior.seniorId || 'N/A') + '</strong>' + (age != null ? ' &bull; ' + escHtml(String(age)) + ' yrs old' : '') + '</div></div>';
    html += '<span style="font-size:0.72rem; font-weight:800; color:' + meta.color + '; background:white; border:1px solid ' + meta.bd + '; padding:6px 14px; border-radius:999px;">' + escHtml(level).toUpperCase() + ' PRIORITY</span></div>';
    html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px;">';
    html += '<div style="border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px; font-size:0.85rem;">';
    html += '<h4 style="margin:0 0 8px; font-size:0.9rem; color:#0f172a;">Profile and Account</h4>';
    html += '<div>Full name: <strong>' + escHtml(senior.name || 'N/A') + '</strong></div>';
    html += '<div>OSCA ID: <strong>' + escHtml(senior.seniorId || 'N/A') + '</strong></div>';
    html += '<div>Email: ' + escHtml(senior.email || 'N/A') + '</div>';
    html += '<div>Age: ' + (age != null ? escHtml(String(age)) + ' years old' : 'N/A') + (senior.dob ? ' (DOB: ' + escHtml(senior.dob) + ')' : '') + '</div>';
    html += '<div>Sex: ' + escHtml(senior.sex || 'N/A') + ' &bull; Civil status: ' + escHtml(senior.civilStatus || 'N/A') + '</div>';
    html += '<div>Address: ' + escHtml(senior.address || senior.barangay || 'N/A') + '</div>';
    html += '<div>Contact: ' + escHtml(senior.cpNumber || 'N/A') + '</div>';
    html += '</div>';
    html += '<div style="border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px; font-size:0.85rem;">';
    html += '<h4 style="margin:0 0 8px; font-size:0.9rem; color:#0f172a;">Verification and Status</h4>';
    html += '<div>Verification: <strong style="color:' + kycColor + ';">' + escHtml(kyc) + '</strong></div>';
    html += '<div>Account status: ' + escHtml(acctStatus) + '</div>';
    html += '<div>Priority level: <strong style="color:' + meta.color + ';">' + escHtml(level) + '</strong></div>';
    html += '<div>Account created: <strong>' + escHtml(priorityFmtDateTime(senior.createdAt)) + '</strong></div>';
    html += '<div>Account verified: <strong>' + escHtml(senior.kycVerifiedAt ? priorityFmtDateTime(senior.kycVerifiedAt) : 'Not yet verified') + '</strong></div>';
    html += '<div>Verified by: ' + escHtml(senior.verifiedBy || (kyc === 'Verified' ? 'OSCA staff' : 'N/A')) + '</div>';
    html += '</div></div>';
    content.innerHTML = html;
    modal.style.display = 'flex';
    renderPrioritySeniorSections(uid);
};

// ── Senior Profile Modal sections (requests + transactions + history) ────
function renderPrioritySeniorSections(uid) {
    const usersData = window.lastUsersData || {};
    const senior = usersData[uid];
    const content = document.getElementById('prioritySeniorContent');
    if (!senior || !content) return;
    const claims = prioritySeniorClaims(uid);
    const appts = prioritySeniorAppointments(uid);
    const txs = prioritySeniorTransactions(uid, senior);
    const recentTxs = txs.slice(0, 3);
    let sec = '';
    sec += '<div style="border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px; margin-bottom:16px;">';
    sec += '<h4 style="margin:0 0 4px; font-size:0.9rem; color:#0f172a;">Recent Transactions (' + recentTxs.length + ' of ' + txs.length + ')</h4>';
    if (recentTxs.length === 0) {
        sec += '<div style="text-align:center; color:#94a3b8; font-size:0.84rem; padding:14px; border:1px dashed #e2e8f0; border-radius:10px;">No transactions recorded for this senior yet.</div>';
    } else {
        recentTxs.forEach(t => {
            sec += '<div style="border:1px solid #f1f5f9; border-radius:10px; padding:9px 12px; margin-bottom:8px; font-size:0.82rem; display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">';
            sec += '<div><strong>' + escHtml(t.type || 'Transaction') + '</strong>' + (t.refNumber ? ' <span style="font-family:monospace; font-size:0.72rem; color:#2563eb;">' + escHtml(t.refNumber) + '</span>' : '') + '<div style="color:#64748b; margin-top:2px;">' + escHtml(priorityFmtDateTime(t.createdAt)) + (t.processedBy ? ' &bull; by ' + escHtml(t.processedBy) : '') + '</div></div>';
            sec += '<div style="font-weight:800;">' + (t.amount !== undefined && t.amount !== null && t.amount !== '' ? 'PHP ' + escHtml(String(t.amount)) : '') + '</div></div>';
        });
    }
    sec += '</div>';
    content.innerHTML += sec;
    renderPrioritySeniorRequests(uid, claims, appts);
}

// ── Senior Profile Modal: requests + assistance + full history ────────────
function renderPrioritySeniorRequests(uid, claims, appts) {
    const usersData = window.lastUsersData || {};
    const senior = usersData[uid];
    const content = document.getElementById('prioritySeniorContent');
    if (!senior || !content) return;
    claims = claims || prioritySeniorClaims(uid);
    appts = appts || prioritySeniorAppointments(uid);
    const txs = prioritySeniorTransactions(uid, senior);
    let h = '';
    h += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px;">';
    h += '<div style="border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px;">';
    h += '<h4 style="margin:0 0 4px; font-size:0.9rem; color:#0f172a;">Assistance Requests (' + claims.length + ')</h4>';
    if (claims.length === 0) {
        h += '<div style="text-align:center; color:#94a3b8; font-size:0.84rem; padding:14px; border:1px dashed #e2e8f0; border-radius:10px;">No assistance requests filed.</div>';
    } else {
        claims.forEach(c => {
            h += '<div style="border:1px solid #f1f5f9; border-radius:10px; padding:9px 12px; margin-bottom:8px; font-size:0.81rem;">';
            h += '<div><strong>' + escHtml((c.serviceType || 'Assistance').toUpperCase()) + '</strong> — ' + escHtml(c.status || 'Pending') + '</div>';
            h += '<div style="color:#64748b; margin-top:2px;">Filed: ' + escHtml(priorityFmtDate(c.createdAt)) + (c.refNumber ? ' &bull; Ref: ' + escHtml(c.refNumber) : '') + (c.paidAmount ? ' &bull; PHP ' + escHtml(String(c.paidAmount)) : '') + '</div></div>';
        });
    }
    h += '</div>';
    h += '<div style="border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px;">';
    h += '<h4 style="margin:0 0 4px; font-size:0.9rem; color:#0f172a;">Appointment Requests (' + appts.length + ')</h4>';
    if (appts.length === 0) {
        h += '<div style="text-align:center; color:#94a3b8; font-size:0.84rem; padding:14px; border:1px dashed #e2e8f0; border-radius:10px;">No appointment requests booked.</div>';
    } else {
        appts.forEach(q => {
            h += '<div style="border:1px solid #f1f5f9; border-radius:10px; padding:9px 12px; margin-bottom:8px; font-size:0.81rem;">';
            h += '<div><strong>' + escHtml(q.service || 'General Consultation') + '</strong> — ' + escHtml(q.status || 'Pending') + '</div>';
            h += '<div style="color:#64748b; margin-top:2px;">' + (q.date ? escHtml(q.date) : escHtml(priorityFmtDate(q.scheduledAt))) + (q.time ? ' at ' + escHtml(q.time) : '') + (q.queueNumber ? ' &bull; ' + escHtml(q.queueNumber) : '') + '</div></div>';
        });
    }
    h += '</div></div>';
    content.innerHTML += h;
    renderPrioritySeniorHistory(uid, txs);
}

// ── Senior Profile Modal: assistance received + full history ──────────────
function renderPrioritySeniorHistory(uid, txs) {
    const usersData = window.lastUsersData || {};
    const senior = usersData[uid];
    const content = document.getElementById('prioritySeniorContent');
    if (!senior || !content) return;
    txs = txs || prioritySeniorTransactions(uid, senior);
    const benefits = senior.benefits && typeof senior.benefits === 'object' ? Object.values(senior.benefits) : [];
    const claimedTxs = txs.filter(t => /claim|paid|payout|approved/i.test(String(t.type || '')));
    let h = '';
    h += '<div style="border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px; margin-bottom:16px;">';
    h += '<h4 style="margin:0 0 4px; font-size:0.9rem; color:#0f172a;">Assistance Received (' + (benefits.length + claimedTxs.length) + ')</h4>';
    if (benefits.length === 0 && claimedTxs.length === 0) {
        h += '<div style="text-align:center; color:#94a3b8; font-size:0.84rem; padding:14px; border:1px dashed #e2e8f0; border-radius:10px;">No assistance received yet.</div>';
    } else {
        benefits.forEach(b => {
            h += '<div style="border:1px solid #f1f5f9; border-radius:10px; padding:9px 12px; margin-bottom:8px; font-size:0.81rem; display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">';
            h += '<div><strong>' + escHtml(b.title || 'Benefit') + '</strong> — ' + escHtml(b.status || 'Posted') + '<div style="color:#64748b; margin-top:2px;">' + (b.approvedAt ? escHtml(priorityFmtDate(b.approvedAt)) : '') + (b.refNumber ? ' &bull; Ref: ' + escHtml(b.refNumber) : '') + '</div></div>';
            h += '<div style="font-weight:800; color:#166534;">' + escHtml(b.amount || '') + '</div></div>';
        });
        claimedTxs.forEach(t => {
            h += '<div style="border:1px solid #f1f5f9; border-radius:10px; padding:9px 12px; margin-bottom:8px; font-size:0.81rem; display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">';
            h += '<div><strong>' + escHtml(t.type || 'Payout') + '</strong><div style="color:#64748b; margin-top:2px;">' + escHtml(priorityFmtDateTime(t.createdAt)) + (t.refNumber ? ' &bull; Ref: ' + escHtml(t.refNumber) : '') + '</div></div>';
            h += '<div style="font-weight:800;">' + (t.amount ? 'PHP ' + escHtml(String(t.amount)) : '') + '</div></div>';
        });
    }
    h += '</div>';
    h += '<div style="border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px;">';
    h += '<h4 style="margin:0 0 4px; font-size:0.9rem; color:#0f172a;">Full Transaction History (' + txs.length + ')</h4>';
    if (txs.length === 0) {
        h += '<div style="text-align:center; color:#94a3b8; font-size:0.84rem; padding:14px; border:1px dashed #e2e8f0; border-radius:10px;">No transaction history for this senior.</div>';
    } else {
        txs.forEach(t => {
            h += '<div style="border:1px solid #f1f5f9; border-radius:10px; padding:9px 12px; margin-bottom:8px; font-size:0.82rem; display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">';
            h += '<div><strong>' + escHtml(t.type || 'Transaction') + '</strong>' + (t.refNumber ? ' <span style="font-family:monospace; font-size:0.72rem; color:#2563eb;">' + escHtml(t.refNumber) + '</span>' : '') + '<div style="color:#64748b; margin-top:2px;">' + escHtml(priorityFmtDateTime(t.createdAt)) + (t.processedBy ? ' &bull; by ' + escHtml(t.processedBy) : '') + (t.reason ? ' &bull; ' + escHtml(t.reason) : '') + '</div></div>';
            h += '<div style="font-weight:800;">' + (t.amount !== undefined && t.amount !== null && t.amount !== '' ? 'PHP ' + escHtml(String(t.amount)) : '') + '</div></div>';
        });
    }
    h += '</div>';
    content.innerHTML += h;
}

// ── Helper: effective priority for a senior's work item ─────────────────────
// Human decision wins: staffPriorityLevel (set by OSCA staff after reviewing
// the medical certification) → else computed level (illness + age rule).
// Never guesses — falls back to the same approved `calculatePriorityLevel`.
// Returns one of 'High' | 'Medium' | 'Low'.
function effectiveSeniorPriority(user) {
    if (!user) return 'Low';
    const staff = String(user.staffPriorityLevel || '').trim();
    if (staff === 'High' || staff === 'Medium' || staff === 'Low') return staff;
    try {
        if (typeof calculatePriorityLevel === 'function') return calculatePriorityLevel(user) || 'Low';
    } catch (e) { /* fall through */ }
    return 'Low';
}

function priorityRank(level) {
    return level === 'High' ? 0 : (level === 'Medium' ? 1 : 2);
}

/** Small colored pill used on Pension / Claims / Appointment rows. */
function priorityPillHtml(level) {
    const map = {
        High: 'background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5;',
        Medium: 'background:#fef3c7; color:#b45309; border:1px solid #fcd34d;',
        Low: 'background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe;'
    };
    return `<span style="font-size:0.7rem; font-weight:700; padding:2px 10px; border-radius:20px; white-space:nowrap; ${map[level] || map.Low}">${level} Priority</span>`;
}

// ── Helper: Priority Level (single definition — age + illness override) ────
function hasReportedIllness(user) {
    if (!user) return false;
    const cond = String(user.healthCondition || user.condition || user.illness || user.preExistingConditions || '').trim();
    if (!cond) return false;
    return !/^none$/i.test(cond) && !/^none reported$/i.test(cond) && !/^no illness/i.test(cond) && !/^healthy/i.test(cond);
}

function calculatePriorityLevel(user) {
    // Illness override — any reported illness → High priority regardless of age
    if (hasReportedIllness(user)) return 'High';
    let age = Number(user.age) || 0;
    if (!age && user.dob) {
        const birthDate = new Date(user.dob);
        const today = new Date();
        age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
    }
    // The senior's age solely determines the category — a stale stored
    // priorityLevel can never override it:
    //   age <= 89 → Low   |   age 90-99 → Medium   |   age >= 100 → High
    if (age >= 100) return 'High';
    if (age >= 90) return 'Medium';
    return 'Low';
}

// ── Seniors by Priority Level (Dashboard section state) ─────────────────────
window._prioritySeniorFilter = window._prioritySeniorFilter || 'All';
window._prioritySeniorSearch = window._prioritySeniorSearch || '';
window._prioritySeniorUid = window._prioritySeniorUid || null;

function prioritySeniorAge(s) {
    if (!s) return null;
    const n = Number(s.age);
    if (n > 0) return n;
    if (s.dob) {
        const b = new Date(s.dob);
        if (!isNaN(b.getTime())) {
            const t = new Date();
            let a = t.getFullYear() - b.getFullYear();
            const m = t.getMonth() - b.getMonth();
            if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
            if (a > 0) return a;
        }
    }
    return null;
}

function priorityFmtDate(ts) {
    if (ts === null || ts === undefined || ts === '') return 'N/A';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function priorityFmtDateTime(ts) {
    if (ts === null || ts === undefined || ts === '') return 'N/A';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function priorityMeta(level) {
    if (level === 'High') return { color: '#b91c1c', bg: '#fef2f2', bd: '#fecaca', dot: '#ef4444' };
    if (level === 'Medium') return { color: '#b45309', bg: '#fffbeb', bd: '#fde68a', dot: '#f59e0b' };
    return { color: '#1d4ed8', bg: '#eff6ff', bd: '#bfdbfe', dot: '#22c55e' };
}

function prioritySeniorTxMatches(tx, uid, senior) {
    if (!tx) return false;
    if (uid && (tx.seniorUid === uid || tx.uid === uid)) return true;
    if (senior) {
        const sName = String(senior.name || '').trim().toLowerCase();
        const sEmail = String(senior.email || '').trim().toLowerCase();
        if (sName && String(tx.seniorName || '').trim().toLowerCase() === sName) return true;
        if (sEmail && String(tx.email || '').trim().toLowerCase() === sEmail) return true;
    }
    return false;
}

function prioritySeniorClaims(uid) {
    const arr = Object.entries(window.lastClaimsData || {})
        .map(([id, c]) => ({ id, ...(c || {}) }))
        .filter(c => c && (c.uid === uid || c.seniorUid === uid));
    arr.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    return arr;
}

function prioritySeniorAppointments(uid) {
    const arr = Object.entries(window.lastQueuesData || {})
        .map(([id, q]) => ({ id, ...(q || {}) }))
        .filter(q => q && q.uid === uid);
    arr.sort((a, b) => (Number(b.createdAt || b.scheduledAt) || 0) - (Number(a.createdAt || a.scheduledAt) || 0));
    return arr;
}

function prioritySeniorTransactions(uid, senior) {
    const arr = Object.entries(window.lastTransactionsData || {})
        .map(([id, t]) => ({ id, ...(t || {}) }))
        .filter(t => prioritySeniorTxMatches(t, uid, senior));
    arr.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    return arr;
}

window.setPrioritySeniorFilter = function(level, btn) {
    window._prioritySeniorFilter = level || 'All';
    document.querySelectorAll('#priorityFilterChips .emp-prio-chip').forEach(ch => {
        ch.classList.toggle('active', ch.dataset.prioFilter === window._prioritySeniorFilter);
    });
    if (btn) btn.classList.add('active');
    renderPrioritySeniorsDashboard();
};

window.setPrioritySeniorSearch = function(val) {
    window._prioritySeniorSearch = String(val || '').trim().toLowerCase();
    renderPrioritySeniorsDashboard();
};

window.closePrioritySeniorModal = function() {
    window._prioritySeniorUid = null;
    const modal = document.getElementById('prioritySeniorModal');
    if (modal) modal.style.display = 'none';
};

// ── Senior pension decision notices (in-app + e-mail + SMS) ──────────────────
// Staff pension actions (set / change / remove) now reach the senior three ways:
//   1. an in-app notification on their portal,
//   2. the official status e-mail via /api/send-status-email, and
//   3. an official SMS via /api/send-status-sms (TextBee) to the CP number
//      saved in the senior's own profile (users/{uid}/cpNumber).
// All three are best-effort and non-blocking — a failed e-mail or an offline
// SMS gateway never blocks the pension save.
//   - granted / changed  -> 'pension_approved'
//   - payout preparing   -> 'pension_releasing'
//   - payout handed over -> 'pension_released'
//   - setup removed      -> 'pension_declined'
const SMS_PENSION_TYPES = ['pension_approved', 'pension_releasing', 'pension_released', 'pension_declined'];

function sendSeniorPensionStatus(seniorsArr, uid, seniorName, pension, type) {
    try {
        const p = pension && typeof pension === 'object' ? pension : {};
        const local = Math.max(0, Number(p.localAmount) || 0);
        const national = Math.max(0, Number(p.nationalAmount) || 0);
        const quarterly = Math.max(0, Number(p.quarterlyTotal) || (local * 3 + national));
        // Optional payout window (e.g. "2026-09") used by the releasing/released notices.
        const smsPeriod = typeof p.period === 'string' ? p.period : '';
        // A senior may receive Local only, National only, or both — only
        // mention the components that were actually granted.
        const amountParts = [
            local > 0 ? `Local PHP ${local.toLocaleString()}/month` : '',
            national > 0 ? `National PHP ${national.toLocaleString()}/quarter` : ''
        ].filter(Boolean);
        const amountLabel = amountParts.length
            ? `${amountParts.join(' + ')} (quarterly total PHP ${quarterly.toLocaleString()})`
            : 'your pension setup';
        // In-app wording per decision — the e-mail and SMS use their own templates.
        const pensionWindow = smsPeriod ? ` for ${smsPeriod}` : '';
        const notice = type === 'pension_releasing'
            ? { title: 'Pension Releasing', description: `Your pension payout${pensionWindow} is now being released. Wait for the release confirmation before going to the OSCA office.` }
            : (type === 'pension_released'
                ? { title: 'Pension Released ✓', description: `Your pension payout${pensionWindow} has been released. Present your OSCA ID or QR Digital ID at the OSCA Magalang office to claim.` }
                : (type === 'pension_approved'
                    ? { title: 'Pension Setup Approved', description: `Your pension setup has been approved by OSCA staff: ${amountLabel}. Please check your email and SMS for the official notice.` }
                    : { title: 'Pension Setup Removed', description: 'Your Local/National pension setup was removed by OSCA staff. Please visit the OSCA Magalang office for assistance.' }));
        update(ref(db, `users/${uid}/notifications/notif_${Date.now()}`), {
            title: notice.title,
            description: notice.description,
            createdAt: Date.now()
        }).catch(console.error);

        const senior = (seniorsArr || []).find(s => s && s.uid === uid);
        if (senior && senior.email) {
            auth.currentUser.getIdToken().then(token => {
                return fetch('/api/send-status-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({
                        email: senior.email,
                        name: seniorName,
                        amount: String(quarterly || 0),
                        localAmount: String(local || 0),
                        nationalAmount: String(national || 0),
                        quarterlyTotal: String(quarterly || 0),
                        type
                    })
                });
            }).catch(console.error);
        }

        // 3. Official SMS (TextBee). The server reads the CP number from the
        //    senior's own profile, so only the uid + decision travel from here.
        //    Best-effort: a silent gateway never blocks the pension save.
        if (auth.currentUser) {
            auth.currentUser.getIdToken().then(token => {
                return fetch('/api/send-status-sms', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({
                        uid,
                        type: SMS_PENSION_TYPES.includes(type) ? type : 'pension_approved',
                        amount: String(quarterly || 0),
                        localAmount: String(local || 0),
                        nationalAmount: String(national || 0),
                        quarterlyTotal: String(quarterly || 0),
                        period: smsPeriod
                    })
                });
            }).catch(console.error);
        }
    } catch (e) {
        console.error('Pension status notify error:', e);
    }
}

// ── Dual Pension Setup (Process Benefits) ──
// Local: monthly (₱1,000 default). National: quarterly (₱3,000 default).
// One quarter = Local x 3 + National = ₱6,000.
// Global amounts: pensionSettings/{local, national}. Saving updates ALL seniors.
// Verified seniors auto-receive both pensions (auto-grant on verify + on load).
const DEFAULT_LOCAL_PENSION = 1000;
const DEFAULT_NATIONAL_PENSION = 3000;
let pensionSettingsCache = { local: 1000, national: 3000 };

function getLocalPensionOf(u) {
    if (!u) return 0;
    if (Number(u.pensionLocalAmount) > 0) return Number(u.pensionLocalAmount);
    if (Number(u.pensionAmount) > 0) return Number(u.pensionAmount);
    return 0;
}
function getNationalPensionOf(u) {
    if (!u) return 0;
    if (Number(u.pensionNationalAmount) > 0) return Number(u.pensionNationalAmount);
    return 0;
}
// A senior does NOT need both pensions — some qualify for Local only,
// National only, or both. Any component > 0 counts as "pension granted".
function hasPension(u) { return getLocalPensionOf(u) > 0 || getNationalPensionOf(u) > 0; }
function quarterTotalOf(u) { return getLocalPensionOf(u) * 3 + getNationalPensionOf(u); }
function refreshPensionSettingsPreview() {
    const li = document.getElementById('pensionLocalInput');
    const ni = document.getElementById('pensionNationalInput');
    const local = Math.max(0, Math.round(Number(li && li.value) || 0));
    const nat = Math.max(0, Math.round(Number(ni && ni.value) || 0));
    const lq = document.getElementById('pensionLocalQtrPreview');
    const gq = document.getElementById('pensionQuarterGrandPreview');
    const mini = document.getElementById('pbMiniPensionSettings');
    if (lq) lq.textContent = '₱' + (local * 3).toLocaleString();
    if (gq) gq.textContent = '₱' + (local * 3 + nat).toLocaleString();
    if (mini) mini.textContent = 'Local ₱' + local.toLocaleString() + '/mo · National ₱' + nat.toLocaleString() + '/quarter';
}

function initPensionSettingsEditor() {
    if (initPensionSettingsEditor._done) { refreshPensionSettingsPreview(); return; }
    initPensionSettingsEditor._done = true;
    try {
        onValue(ref(db, 'pensionSettings'), (snap) => {
            const v = snap.exists() ? snap.val() : {};
            const L = Number(v.local) > 0 ? Math.round(Number(v.local)) : 1000;
            const N = Number(v.national) > 0 ? Math.round(Number(v.national)) : 3000;
            pensionSettingsCache = { local: L, national: N };
            const li = document.getElementById('pensionLocalInput');
            const ni = document.getElementById('pensionNationalInput');
            if (li && document.activeElement !== li) li.value = L;
            if (ni && document.activeElement !== ni) ni.value = N;
            refreshPensionSettingsPreview();
        });
    } catch (e) { console.warn('Pension settings skipped:', e.message); }
    const li = document.getElementById('pensionLocalInput');
    const ni = document.getElementById('pensionNationalInput');
    if (li) li.addEventListener('input', refreshPensionSettingsPreview);
    if (ni) ni.addEventListener('input', refreshPensionSettingsPreview);
    const sb = document.getElementById('pensionSettingsSaveBtn');
    if (sb) sb.addEventListener('click', savePensionSettingsGlobal);
    refreshPensionSettingsPreview();
}
async function savePensionSettingsGlobal() {
    const li = document.getElementById('pensionLocalInput');
    const ni = document.getElementById('pensionNationalInput');
    const st = document.getElementById('pensionSettingsStatus');
    const sb = document.getElementById('pensionSettingsSaveBtn');
    const local = Math.round(Number(li && li.value));
    const national = Math.round(Number(ni && ni.value));
    if (!(local > 0) || !(national > 0)) {
        scNotify('error', 'Enter valid amounts greater than 0 for both pensions.');
        return;
    }
    const by = (window.currentStaffName || '').trim() || 'OSCA Staff';
    const qtr = local * 3 + national;
    confirmAction('Save changes? Local ₱' + local.toLocaleString() + '/mo + National ₱' + national.toLocaleString() + '/qtr. This updates ALL seniors.', async () => {
        try {
            if (sb) { sb.disabled = true; sb.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }
            if (st) st.textContent = 'Saving — updating all senior accounts...';
            await update(ref(db, 'pensionSettings'), { local, national, updatedAt: Date.now(), updatedBy: by });
            pensionSettingsCache = { local, national };
            const data = window.lastUsersData || {};
            const ups = {};
            Object.entries(data).forEach(([uid, u]) => {
                if (!u || u.role !== 'senior' || isArchivedSenior(u)) return;
                ups[`users/${uid}/pensionLocalAmount`] = local;
                ups[`users/${uid}/pensionNationalAmount`] = national;
                ups[`users/${uid}/pensionAmount`] = local;
                ups[`users/${uid}/pensionQuarterlyTotal`] = qtr;
                ups[`users/${uid}/pensionSetAt`] = Date.now();
                ups[`users/${uid}/pensionSetBy`] = by;
            });
            if (Object.keys(ups).length) await update(ref(db), ups);
            logPensionAudit('PENSION_SETTINGS_UPDATED', null, 'All seniors', qtr, 'Global pension updated by ' + by);
            scNotify('success', 'Saved. All pensions now Local ₱' + local.toLocaleString() + '/mo + National ₱' + national.toLocaleString() + '/qtr.');
            if (st) st.textContent = 'Saved — quarterly total ₱' + qtr.toLocaleString() + '.';
            refreshPensionSettingsPreview();
        } catch (err) {
            scNotify('error', 'Failed to save: ' + err.message);
            if (st) st.textContent = 'Save failed. Try again.';
        } finally {
            if (sb) { sb.disabled = false; sb.innerHTML = '<i class="fas fa-save" style="margin-right:6px;"></i>Save changes'; }
        }
    });
}
async function ensureVerifiedSeniorsHavePension(usersData) {
    try {
        const ups = {};
        const now = Date.now();
        const by = (window.currentStaffName || '').trim() || 'OSCA Staff';
        Object.entries(usersData || {}).forEach(([uid, u]) => {
            if (!u || u.role !== 'senior' || isArchivedSenior(u)) return;
            if (!isVerified(u) || hasPension(u)) return;
            const L = Math.round(Number(pensionSettingsCache.local)) || 1000;
            const N = Math.round(Number(pensionSettingsCache.national)) || 3000;
            ups[`users/${uid}/pensionLocalAmount`] = L;
            ups[`users/${uid}/pensionNationalAmount`] = N;
            ups[`users/${uid}/pensionAmount`] = L;
            ups[`users/${uid}/pensionQuarterlyTotal`] = L * 3 + N;
            ups[`users/${uid}/pensionSetAt`] = now;
            ups[`users/${uid}/pensionSetBy`] = by;
        });
        if (Object.keys(ups).length) await update(ref(db), ups);
    } catch (e) { console.warn('Auto-grant skipped:', e.message); }
}

function renderPensionSetup(usersData) {
    const setupContainer = document.getElementById('pensionSetupContainer');
    if (!setupContainer) return;
    const configuredContainer = document.getElementById('pensionConfiguredContainer');
    const badge = document.getElementById('pensionSetupBadge');

    // Preserve any custom amounts already typed into the pending table so a
    // live data refresh (another senior verifying, etc.) does not wipe them
    // before the staff clicks "Grant Pension".
    const customAmounts = {};
    setupContainer.querySelectorAll('.pension-grant-local, .pension-grant-national').forEach(inp => {
        const inpUid = inp.dataset.uid;
        if (!inpUid) return;
        if (!customAmounts[inpUid]) customAmounts[inpUid] = {};
        customAmounts[inpUid][inp.classList.contains('pension-grant-local') ? 'local' : 'national'] = inp.value.trim();
    });
    const grantLocalValue = (uid) => {
        const v = customAmounts[uid] && customAmounts[uid].local;
        return (v !== undefined && v !== '') ? v : (Math.round(Number(pensionSettingsCache.local)) || DEFAULT_LOCAL_PENSION);
    };
    const grantNationalValue = (uid) => {
        const v = customAmounts[uid] && customAmounts[uid].national;
        return (v !== undefined && v !== '') ? v : (Math.round(Number(pensionSettingsCache.national)) || DEFAULT_NATIONAL_PENSION);
    };

    const seniors = Object.entries(usersData)
        .filter(([, u]) => u && u.role === 'senior' && !isArchivedSenior(u))
        .map(([uid, u]) => ({ uid, ...u }));
    const isVerified = s => s.kycStatus === 'Verified' || !!s.kycVerifiedAt;

    const awaiting = seniors
        .filter(s => isVerified(s) && !hasPension(s))
        // High priority seniors first so their pension setup is seen fastest,
        // then Medium, then Low; ties keep alphabetical order (no guessing).
        .map(s => ({ ...s, _prio: effectiveSeniorPriority(s) }))
        .sort((a, b) => (priorityRank(a._prio) - priorityRank(b._prio))
            || String(a.name || '').localeCompare(String(b.name || '')));
    const configured = seniors
        .filter(s => hasPension(s))
        .map(s => ({ ...s, _prio: effectiveSeniorPriority(s) }))
        .sort((a, b) => (priorityRank(a._prio) - priorityRank(b._prio))
            || String(a.name || '').localeCompare(String(b.name || '')));

    if (badge) {
        badge.textContent = awaiting.length;
        badge.style.display = awaiting.length > 0 ? 'inline-block' : 'none';
    }

    if (awaiting.length === 0) {
        setupContainer.innerHTML = `
            <div style="text-align:center; color:#71717a; padding:20px; border:1px dashed #d4d4d8; border-radius:4px;">
                All verified senior accounts already have a Local and/or National pension.
            </div>`;
    } else {
        setupContainer.innerHTML = `
            <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
                <thead>
                    <tr style="border-bottom:1px solid #d4d4d8; color:#52525b; text-align:left;">
                        <th style="padding:8px 10px; font-weight:600;">Senior Name</th>
                        <th style="padding:8px 10px; font-weight:600;">OSCA ID</th>
                        <th style="padding:8px 10px; font-weight:600;">Priority</th>
                        <th style="padding:8px 10px; font-weight:600;">Age</th>
                        <th style="padding:8px 10px; font-weight:600;">Pension <span style="font-weight:400; color:#71717a; font-size:0.78rem;">(custom amount)</span></th>
                        <th style="padding:8px 10px; font-weight:600; width:130px;"></th>
                    </tr>
                </thead>
                <tbody>
                ${awaiting.map(s => `
                    <tr style="border-bottom:1px solid #e4e4e7; ${s._prio === 'High' ? 'background:#fef2f2;' : ''}">
                        <td style="padding:10px; font-weight:600; color:#1e293b;">${escHtml(s.name || 'Senior Citizen')}</td>
                        <td style="padding:10px; color:#3f3f46;">${escHtml(s.seniorId || 'N/A')}</td>
                        <td style="padding:10px;">${priorityPillHtml(s._prio)}</td>
                        <td style="padding:10px; color:#3f3f46;">${escHtml(String(s.age ?? 'N/A'))}</td>
                        <td style="padding:10px;">
                            <div style="display:flex; flex-direction:column; gap:8px; min-width:170px;">
                                <label style="display:block; font-size:0.68rem; font-weight:700; color:#475569; text-transform:uppercase; letter-spacing:0.3px;">
                                    Local (₱/mo)
                                    <input type="number" min="0" step="1" inputmode="numeric" class="pension-grant-local" data-uid="${s.uid}"
                                        value="${grantLocalValue(s.uid)}"
                                        style="margin-top:3px; width:100%; padding:6px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.85rem; font-weight:700; color:#166534; box-sizing:border-box;">
                                </label>
                                <label style="display:block; font-size:0.68rem; font-weight:700; color:#475569; text-transform:uppercase; letter-spacing:0.3px;">
                                    National (₱/qtr)
                                    <input type="number" min="0" step="1" inputmode="numeric" class="pension-grant-national" data-uid="${s.uid}"
                                        value="${grantNationalValue(s.uid)}"
                                        style="margin-top:3px; width:100%; padding:6px 8px; border:1px solid #cbd5e1; border-radius:6px; font-size:0.85rem; font-weight:700; color:#1d4ed8; box-sizing:border-box;">
                                </label>
                            </div>
                        </td>
                        <td style="padding:10px;">
                            <button style="background:#166534; color:#ffffff; border:none; padding:8px 16px; border-radius:4px; font-weight:600; font-size:0.85rem; cursor:pointer;"
                                data-action="pension-grant" data-uid="${s.uid}" data-seniorname="${escHtml(s.name || '')}">Grant Pension</button>
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
    }

    if (configuredContainer) {
        if (configured.length === 0) {
            configuredContainer.innerHTML = `<div style="text-align:center; color:#71717a; padding:14px; border:1px dashed #d4d4d8; border-radius:4px;">No pensions configured yet. Verified seniors appear here once granted.</div>`;
        } else {
            configuredContainer.innerHTML = `
                <table style="width:100%; border-collapse:collapse; font-size:0.9rem;">
                    <thead>
                        <tr style="border-bottom:1px solid #d4d4d8; color:#52525b; text-align:left;">
                            <th style="padding:8px 10px; font-weight:600;">Senior Name</th>
                            <th style="padding:8px 10px; font-weight:600;">OSCA ID</th>
                            <th style="padding:8px 10px; font-weight:600;">Priority</th>
                            <th style="padding:8px 10px; font-weight:600;">Local (Monthly)</th>
                            <th style="padding:8px 10px; font-weight:600;">National (Quarterly)</th>
                            <th style="padding:8px 10px; font-weight:600;">Quarterly Total</th>
                            <th style="padding:8px 10px; font-weight:600;">Set On</th>
                            <th style="padding:8px 10px; font-weight:600;">Set By</th>
                            <th style="padding:8px 10px; font-weight:600; width:90px;"></th>
                        </tr>
                    </thead>
                    <tbody>
                    ${configured.map(s => { const _l = getLocalPensionOf(s); const _n = getNationalPensionOf(s); const _q = _l * 3 + _n; return `
                        <tr style="border-bottom:1px solid #e4e4e7; ${s._prio === 'High' ? 'background:#fef2f2;' : ''}">
                            <td style="padding:10px; font-weight:600; color:#1e293b;">${escHtml(s.name || 'Senior Citizen')}</td>
                            <td style="padding:10px; color:#3f3f46;">${escHtml(s.seniorId || 'N/A')}</td>
                            <td style="padding:10px;">${priorityPillHtml(s._prio)}</td>
                            <td style="padding:10px; font-weight:700; color:${_l > 0 ? '#166534' : '#a1a1aa'};">${_l > 0 ? '₱' + Number(_l).toLocaleString() : '—'}</td>
                            <td style="padding:10px; font-weight:700; color:${_n > 0 ? '#1d4ed8' : '#a1a1aa'};">${_n > 0 ? '₱' + Number(_n).toLocaleString() : '—'}</td>
                            <td style="padding:10px; font-weight:800; color:#1e293b;">₱${Number(_q).toLocaleString()}</td>
                            <td style="padding:10px; color:#3f3f46;">${s.pensionSetAt ? new Date(Number(s.pensionSetAt)).toLocaleDateString() : '—'}</td>
                            <td style="padding:10px; color:#3f3f46;">${s.pensionSetBy ? escHtml(s.pensionSetBy) : '—'}</td>
                            <td style="padding:10px; white-space:nowrap;">
                                <button style="background:#ffffff; color:#b91c1c; border:1px solid #b91c1c; padding:6px 12px; border-radius:4px; font-weight:600; font-size:0.82rem; cursor:pointer;"
                                    data-action="pension-remove" data-uid="${s.uid}" data-seniorname="${escHtml(s.name || '')}" title="Remove pension setup">Remove</button>
                            </td>
                        </tr>`; }).join('')}
                    </tbody>
                </table>`;
        }
    }

    // Grant pension (pending -> grant the amount entered for this senior).
    // The amount is customisable per senior — Local (monthly) and/or National
    // (quarterly) — and defaults to the current global pension settings.
    document.querySelectorAll('[data-action="pension-grant"]').forEach(btn => {
        btn.onclick = async () => {
            const uid = btn.dataset.uid;
            const seniorName = btn.dataset.seniorname || 'senior';
            const row = btn.closest('tr');
            const localInput = row ? row.querySelector('.pension-grant-local') : null;
            const nationalInput = row ? row.querySelector('.pension-grant-national') : null;
            const local = Math.round(Number(localInput ? localInput.value : pensionSettingsCache.local)) || 0;
            const national = Math.round(Number(nationalInput ? nationalInput.value : pensionSettingsCache.national)) || 0;
            // At least ONE pension component must be granted. A senior may be
            // eligible for Local only, National only, or both — never require both.
            if (!(local > 0) && !(national > 0)) {
                scNotify('error', 'Please enter a valid pension amount — at least one of Local (₱/month) or National (₱/quarter) must be greater than 0.');
                const focusEl = !(local > 0) ? (localInput || nationalInput) : nationalInput;
                if (focusEl) focusEl.focus();
                return;
            }
            const qtr = local * 3 + national;
            // Describe only what is actually being granted (one or both).
            const grantParts = [
                local > 0 ? `Local ₱${local.toLocaleString()}/month` : '',
                national > 0 ? `National ₱${national.toLocaleString()}/quarter` : ''
            ].filter(Boolean).join(' + ');
            const actorName = (window.currentStaffName || '').trim() || 'OSCA Staff';
            confirmAction(`Grant pension to ${seniorName}? ${grantParts}.`, async () => {
                try {
                    // Deceased gate: an archived Deceased senior must never be
                    // granted pension again (re-check the live record in case it
                    // was archived after the board rendered).
                    let seniorNow = null;
                    try {
                        const seniorSnap = await get(ref(db, 'users/' + uid));
                        if (seniorSnap.exists()) seniorNow = seniorSnap.val() || null;
                    } catch (gateErr) { /* fall through to server-side rules */ }
                    if (seniorNow && (String(seniorNow.lifeStatus || '') === 'Deceased' || String(seniorNow.status || '') === 'Deceased')) {
                        scNotify('error', 'This senior have passed away, please go to OSCA if you think this is an error');
                        return;
                    }
                    await update(ref(db, `users/${uid}`), {
                        pensionLocalAmount: local,
                        pensionNationalAmount: national,
                        pensionAmount: local,
                        pensionQuarterlyTotal: qtr,
                        pensionSetAt: Date.now(),
                        pensionSetBy: actorName
                    });
                    logPensionAudit('PENSION_SET', uid, seniorName, qtr,
                        `Granted pension to ${seniorName}: ${grantParts}`);
                    scNotify('success', `Pension granted to ${seniorName} (quarterly total ₱${qtr.toLocaleString()}).`);
                    sendSeniorPensionStatus(seniors, uid, seniorName, { localAmount: local, nationalAmount: national, quarterlyTotal: qtr }, 'pension_approved');
                } catch (err) {
                    console.error('Pension grant error:', err);
                    scNotify('error', 'Failed to grant pension: ' + err.message);
                }
            });
        };
    });

    // Remove pension handlers (clears Local + National + legacy fields)
    document.querySelectorAll('[data-action="pension-remove"]').forEach(btn => {
        btn.onclick = () => {
            const uid = btn.dataset.uid;
            const seniorName = btn.dataset.seniorname;
            confirmAction(`Remove the pension setup for ${seniorName}? They will move back to "Pending Account".`, async () => {
                try {
                    await update(ref(db, `users/${uid}`), {
                        pensionLocalAmount: null,
                        pensionNationalAmount: null,
                        pensionAmount: null,
                        pensionQuarterlyTotal: null,
                        pensionSetAt: null,
                        pensionSetBy: null
                    });
                    logPensionAudit('PENSION_REMOVED', uid, seniorName, 0,
                        `Removed pension setup for ${seniorName}`);
                    scNotify('success', `Pension setup removed for ${seniorName}.`);
                    // Notify the senior in-app + official e-mail (best-effort)
                    sendSeniorPensionStatus(seniors, uid, seniorName, 0, 'pension_declined');
                } catch (err) {
                    console.error('Pension removal error:', err);
                    scNotify('error', 'Failed to remove pension: ' + err.message);
                }
            });
        };
    });

    // NOTE: per-senior "Change Amount" removed by design — amounts are global.
    // Employees change Local / National once at the top; Save applies to ALL.
}

// ── Claims Renderer (Real System Look) ─────────────────────────────────────────
// Builds one read-only history row for the "History of Claim" table.
function claimHistoryRowHtml(claim, ts, serviceLabelOf) {
    const dateStr = ts ? new Date(ts).toLocaleDateString() : '—';
    const isRejected = claim.status === 'Rejected';
    const amount = claim.paidAmount
        ? `PHP ${Number(claim.paidAmount).toLocaleString()}`
        : (isRejected ? '—' : `PHP ${Number(claim.serviceType === 'burial' ? 10000 : (claim.serviceType === 'bedridden' ? 1500 : 100000)).toLocaleString()}`);
    const statusPill = isRejected
        ? `<span style="background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; padding:2px 10px; border-radius:3px; font-weight:600; font-size:0.78rem;">Rejected</span>`
        : `<span style="background:#f0fdf4; color:#166534; border:1px solid #86efac; padding:2px 10px; border-radius:3px; font-weight:600; font-size:0.78rem;">${escHtml(claim.status)}</span>`;
    return `
        <tr style="border-bottom:1px solid #e4e4e7;">
            <td style="padding:10px; color:#3f3f46;">${dateStr}</td>
            <td style="padding:10px; font-weight:600; color:#1e293b;">${escHtml(claim.applicantName || 'Senior Citizen')}</td>
            <td style="padding:10px; color:#3f3f46;">${serviceLabelOf(claim.serviceType)}</td>
            <td style="padding:10px; font-weight:600; ${isRejected ? 'color:#71717a;' : 'color:#166534;'}">${amount}</td>
            <td style="padding:10px; color:#3f3f46;">${claim.refNumber ? escHtml(claim.refNumber) : '—'}</td>
            <td style="padding:10px;">${statusPill}</td>
        </tr>`;
}

function renderClaimsDashboard(claimsData) {
    const claimsContainer = document.getElementById('claimsListContainer');
    if (!claimsContainer) return;

    const claimsPayoutContainer = document.getElementById('claimsPayoutContainer');
    const claimsClaimedContainer = document.getElementById('claimsClaimedContainer');
    const claimsHistoryContainer = document.getElementById('claimsHistoryContainer');
    if (claimsPayoutContainer) claimsPayoutContainer.innerHTML = '';
    if (claimsClaimedContainer) claimsClaimedContainer.innerHTML = '';
    if (claimsHistoryContainer) claimsHistoryContainer.innerHTML = '';

    const empProcessBadge = document.getElementById('empProcessBadge');
    const approvedClaimsBadge = document.getElementById('approvedClaimsBadge');

    let pendingClaimsCount = 0;
    let notClaimedCount = 0;

    // Human-friendly welfare service label (bedridden & burial/death requests)
    const serviceLabelOf = (t) => (String(t || '').toLowerCase() === 'burial'
        ? 'Burial (Death)'
        : (t ? String(t).toUpperCase() : 'WELFARE'));

    // Senior lookup for priority sorting (claims store uid/seniorUid +
    // applicantName — reuse the single approved priority rule, never guess).
    const _usersForPrio = (typeof window !== 'undefined' && window.lastUsersData) || {};
    const _seniorOfClaim = (claim) => {
        const key = (claim && (claim.seniorUid || claim.uid)) || '';
        return (key && _usersForPrio[key]) || null;
    };
    const _prioOfClaim = (claim) => effectiveSeniorPriority(_seniorOfClaim(claim));
    const _claimPrioSort = (aE, bE) => {
        const a = aE[1] || {}, b = bE[1] || {};
        const pr = priorityRank(_prioOfClaim(a)) - priorityRank(_prioOfClaim(b));
        if (pr !== 0) return pr;
        const au = a.urgentRequest ? 0 : 1, bu = b.urgentRequest ? 0 : 1;
        if (au !== bu) return au - bu;
        return (a.createdAt || 0) - (b.createdAt || 0);
    };
    const _entries = Object.entries(claimsData || {});
    // Deceased accounts stop receiving pension — never list their claims in the
    // processing queues (burial help for a deceased senior's family is filed by
    // relatives, not on the archived senior account itself).
    const _isDeceasedClaimSenior = (c) => {
        const s = _seniorOfClaim(c);
        return !!s && (String(s.lifeStatus || '') === 'Deceased' || String(s.status || '') === 'Deceased');
    };
    const _pendingEntries = _entries.filter(([, c]) => c && c.status === 'Pending' && !_isDeceasedClaimSenior(c)).sort(_claimPrioSort);
    // Not Claimed Yet: approved by staff, waiting for payout / release
    const _notClaimedEntries = _entries.filter(([, c]) => c && ['Approved_Pending_Payout', 'Approved'].includes(c.status) && !_isDeceasedClaimSenior(c)).sort(_claimPrioSort);
    // Claimed: released to the senior (marked claimed / paid)
    const _claimedEntries = _entries.filter(([, c]) => c && ['Claimed', 'Paid'].includes(c.status)).sort(_claimPrioSort);
    // History of Claim: every claim that reached a final state (Claimed / Paid / Rejected)
    const _histTs = (c) => Number((c && (c.paidAt || c.rejectedAt || c.approvedAt || c.createdAt)) || 0);
    const _historyEntries = _entries.filter(([, c]) => c && ['Claimed', 'Paid', 'Rejected'].includes(c.status))
        .sort((aE, bE) => _histTs(bE[1]) - _histTs(aE[1]));

    for (const [claimId, claim] of _pendingEntries) {
        {
            pendingClaimsCount++;
            const dateStr = claim.createdAt ? new Date(claim.createdAt).toLocaleDateString() : 'N/A';
            const serviceLabel = serviceLabelOf(claim.serviceType);
            const claimPrio = _prioOfClaim(claim);

            if (pendingClaimsCount === 1) {
                claimsContainer.innerHTML += `
                    <div style="display:grid; grid-template-columns: minmax(140px,2fr) minmax(90px,1fr) minmax(90px,1fr) auto; gap:10px; padding:8px 10px; border-bottom:2px solid #1e293b; color:#52525b; font-size:0.82rem; font-weight:600; text-transform:uppercase; letter-spacing:0.03em;">
                        <span>Senior Name</span><span>Benefit</span><span>Submitted</span><span></span>
                    </div>`;
            }

            claimsContainer.innerHTML += `
                <div style="display:grid; grid-template-columns: minmax(140px,2fr) minmax(90px,1fr) minmax(90px,1fr) auto; gap:10px; padding:10px; border-bottom:1px solid #e4e4e7; align-items:center; font-size:0.9rem; min-width:0; ${claim.urgentRequest || claimPrio === 'High' ? 'background:#fff5f5;' : ''}">
                    <span style="font-weight:600; color:#1e293b; min-width:0; overflow:hidden; text-overflow:ellipsis;">${claim.applicantName} ${claim.urgentRequest ? '<span style="background:#dc2626; color:white; font-size:0.68rem; font-weight:800; padding:2px 6px; border-radius:4px; margin-left:6px;"><i class="fas fa-triangle-exclamation"></i> URGENT</span>' : ''}<span style="margin-left:6px;">${priorityPillHtml(claimPrio)}</span></span>
                    <span style="color:#3f3f46;">${serviceLabel}</span>
                    <span style="color:#3f3f46;">${dateStr}</span>
                    <span style="text-align:right; white-space:nowrap;">
                        <span style="background:#fef3c7; color:#92400e; border:1px solid #fcd34d; padding:2px 10px; border-radius:3px; font-weight:600; font-size:0.78rem;">Pending</span>
                        <button data-claimid="${claimId}" data-action="view-claim" style="background:#1e293b; color:#ffffff; border:none; padding:7px 14px; border-radius:4px; font-weight:600; font-size:0.85rem; cursor:pointer; margin-left:8px;">View Details</button>
                    </span>
                </div>`;
        }
    }
    // ── Not Claimed Yet: approved claims waiting for payout / release ──────────
    for (const [claimId, claim] of _notClaimedEntries) {
        {
            notClaimedCount++;
            if (claimsPayoutContainer) {
                const defaultAmount = claim.paidAmount || (claim.serviceType === 'burial' ? 10000 : (claim.serviceType === 'bedridden' ? 1500 : 100000));
                const approvedDateStr = claim.approvedAt ? new Date(claim.approvedAt).toLocaleDateString() : (claim.createdAt ? new Date(claim.createdAt).toLocaleDateString() : 'Recently');
                const claimPrio = _prioOfClaim(claim);
                const statusBadgeHtml = `<span style="background:#eff6ff; color:#1e40af; border:1px solid #93c5fd; padding:2px 10px; border-radius:3px; font-weight:600; font-size:0.78rem;">Awaiting Payout</span>`;

                claimsPayoutContainer.innerHTML += `
                    <div data-claim-card="${claimId}" style="border:1px solid ${claimPrio === 'High' ? '#fca5a5' : '#e4e4e7'}; ${claimPrio === 'High' ? 'background:#fff7f7;' : ''} border-radius:4px; padding:14px 16px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap;">
                        <div>
                            <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px; flex-wrap:wrap;">
                                <span style="color:#1e293b; font-size:1rem; font-weight:700;">${claim.applicantName}</span>
                                ${statusBadgeHtml}
                                ${priorityPillHtml(claimPrio)}
                            </div>
                            <p style="font-size:0.86rem; color:#52525b; margin:2px 0; word-break:break-word;">${serviceLabelOf(claim.serviceType)} &bull; Approved: ${approvedDateStr}</p>
                            <p style="margin:6px 0 0; font-size:0.86rem; color:#52525b; word-break:break-word;">
                                Claim Reference:
                                <span class="pb-claim-ref" style="font-family:monospace; font-weight:800; color:#1e40af; letter-spacing:0.5px;">${escHtml(claim.refNumber || '—')}</span>
                            </p>
                            <p style="margin:6px 0 0; font-size:0.9rem; font-weight:600; color:#1e293b;">
                                Payout Amount:
                                <span class="payout-amount-display" data-amount="${defaultAmount}" style="font-weight:700; color:#166534;">PHP ${Number(defaultAmount).toLocaleString()}</span>
                            </p>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <button data-claimid="${claimId}" data-senioruid="${claim.uid}" data-servicetype="${claim.serviceType}" data-seniorname="${claim.applicantName}" data-action="claim-mark-claimed" style="background: #166534; color: white; border: none; padding:8px 16px; border-radius:4px; font-weight:600; font-size:0.85rem; cursor: pointer;">
                                Mark as Claimed
                            </button>
                            <button data-claimid="${claimId}" data-senioruid="${claim.uid}" data-servicetype="${claim.serviceType}" data-seniorname="${claim.applicantName}" data-action="claim-delete" style="background:#ffffff; color:#b91c1c; border:1px solid #b91c1c; padding:8px 14px; border-radius:4px; font-weight:600; font-size:0.85rem; cursor:pointer;">
                                Delete
                            </button>
                        </div>
                    </div>`;
            }
        }
    }

    // ── Claimed: released to the senior ─────────────────────────────────────────
    if (claimsClaimedContainer) {
        for (const [claimId, claim] of _claimedEntries) {
            const defaultAmount = claim.paidAmount || (claim.serviceType === 'burial' ? 10000 : (claim.serviceType === 'bedridden' ? 1500 : 100000));
            const claimedDateStr = claim.paidAt ? new Date(claim.paidAt).toLocaleDateString() : (claim.approvedAt ? new Date(claim.approvedAt).toLocaleDateString() : 'Recently');
            const claimPrio = _prioOfClaim(claim);
            const isPaid = claim.status === 'Paid';
            const refStr = claim.refNumber ? escHtml(claim.refNumber) : '—';

            claimsClaimedContainer.innerHTML += `
                <div style="border:1px solid #e4e4e7; border-radius:4px; padding:14px 16px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap;">
                    <div>
                        <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px; flex-wrap:wrap;">
                            <span style="color:#1e293b; font-size:1rem; font-weight:700;">${claim.applicantName}</span>
                            <span style="background:#f0fdf4; color:#166534; border:1px solid #86efac; padding:2px 10px; border-radius:3px; font-weight:600; font-size:0.78rem;">${isPaid ? 'Paid' : 'Claimed'}</span>
                            ${priorityPillHtml(claimPrio)}
                        </div>
                        <p style="font-size:0.86rem; color:#52525b; margin:2px 0; word-break:break-word;">${serviceLabelOf(claim.serviceType)} &bull; Claimed: ${claimedDateStr} &bull; Ref: ${refStr}</p>
                        <p style="margin:6px 0 0; font-size:0.9rem; font-weight:600; color:#1e293b;">
                            Payout Amount:
                            <span style="font-weight:700; color:#166534;">PHP ${Number(defaultAmount).toLocaleString()}</span>
                        </p>
                    </div>
                    <div style="display:flex; gap:8px; align-items:center;">
                        <button data-claimid="${claimId}" data-senioruid="${claim.uid}" data-servicetype="${claim.serviceType}" data-seniorname="${claim.applicantName}" data-action="claim-delete" style="background:#ffffff; color:#b91c1c; border:1px solid #b91c1c; padding:8px 14px; border-radius:4px; font-weight:600; font-size:0.85rem; cursor:pointer;">
                            Delete
                        </button>
                    </div>
                </div>`;
        }
    }

    // ── History of Claim: read-only log of every finished claim ─────────────────
    if (claimsHistoryContainer) {
        if (_historyEntries.length === 0) {
            claimsHistoryContainer.innerHTML = `
                <div style="text-align:center; color:#71717a; padding:20px; border:1px dashed #d4d4d8; border-radius:4px;">
                    No claim history yet.
                </div>`;
        } else {
            claimsHistoryContainer.innerHTML = `
                <table style="width:100%; border-collapse:collapse; font-size:0.88rem;">
                    <thead>
                        <tr style="border-bottom:2px solid #1e293b; color:#52525b; text-align:left;">
                            <th style="padding:8px 10px; font-weight:600;">Date</th>
                            <th style="padding:8px 10px; font-weight:600;">Senior Name</th>
                            <th style="padding:8px 10px; font-weight:600;">Benefit</th>
                            <th style="padding:8px 10px; font-weight:600;">Payout Amount</th>
                            <th style="padding:8px 10px; font-weight:600;">Reference #</th>
                            <th style="padding:8px 10px; font-weight:600;">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                    ${_historyEntries.map(([claimId, claim]) => claimHistoryRowHtml(claim, _histTs(claim), serviceLabelOf)).join('')}
                    </tbody>
                </table>`;
        }
    }

    // Update Process Benefits Badges
    if (approvedClaimsBadge) {
        approvedClaimsBadge.textContent = notClaimedCount;
        approvedClaimsBadge.style.display = notClaimedCount > 0 ? 'inline-block' : 'none';
    }
    if (empProcessBadge) {
        empProcessBadge.style.display = (notClaimedCount > 0 || pendingClaimsCount > 0) ? 'block' : 'none';
    }

    if (pendingClaimsCount === 0) {
        claimsContainer.innerHTML = `
            <div style="text-align:center;color:#71717a;padding:28px 20px;border:1px dashed #d4d4d8;border-radius:4px;">
                No pending welfare assistance claims at this time.
            </div>`;
    }

    if (notClaimedCount === 0 && claimsPayoutContainer) {
        claimsPayoutContainer.innerHTML = `
            <div style="text-align:center;color:#71717a;padding:28px 20px;border:1px dashed #d4d4d8;border-radius:4px;">
                No approved assistance claims waiting for payout.<br>
                <span style="font-size:0.85rem;">A senior appears here only after they submit a Bedridden or Burial (Death) assistance request from their portal and staff accept it &mdash; verification alone does not create a claim.</span>
            </div>`;
    }

    if (_claimedEntries.length === 0 && claimsClaimedContainer) {
        claimsClaimedContainer.innerHTML = `
            <div style="text-align:center;color:#71717a;padding:28px 20px;border:1px dashed #d4d4d8;border-radius:4px;">
                No claimed assistance claims yet.
            </div>`;
    }

    // Attach View details click listeners
    document.querySelectorAll('[data-action="view-claim"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const claimId = btn.dataset.claimid;
            openClaimDetailsModal(claimId, claimsData[claimId]);
        });
    });

    // Attach Claimed Button click listener (With "Are you sure?" confirmation)
    document.querySelectorAll('[data-action="claim-mark-claimed"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetBtn = e.target.closest('[data-action="claim-mark-claimed"]') || btn;
            if (targetBtn.disabled) return;

            // Find the payout amount shown in the same claim row (walk up from
            // the button until an ancestor contains the amount display)
            let scope = targetBtn.parentElement;
            let amountDisplay = null;
            while (scope && scope !== document.body && !amountDisplay) {
                amountDisplay = scope.querySelector('.payout-amount-display');
                if (!amountDisplay) scope = scope.parentElement;
            }
            const amount = amountDisplay ? (amountDisplay.dataset.amount || '10000') : '10000';
            const claimId = targetBtn.dataset.claimid;
            const uid = targetBtn.dataset.senioruid;
            const serviceType = targetBtn.dataset.servicetype;
            const seniorName = targetBtn.dataset.seniorname;
            const serviceTitle = `${serviceType ? (serviceType.charAt(0).toUpperCase() + serviceType.slice(1)) : 'Welfare'} Assistance`;

            confirmAction(`Are you sure you want to mark this assistance as CLAIMED for ${seniorName}?`, async () => {
                targetBtn.disabled = true;
                targetBtn.style.cursor = 'not-allowed';
                targetBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';

                try {
                    // Deceased gate: a senior archived as Deceased must never
                    // receive a payout, even if the claim was approved earlier.
                    let seniorNow = null;
                    try {
                        const seniorSnap = await get(ref(db, 'users/' + uid));
                        if (seniorSnap.exists()) seniorNow = seniorSnap.val() || null;
                    } catch (gateErr) { /* fall through to server / write rules */ }
                    if (seniorNow && (String(seniorNow.lifeStatus || '') === 'Deceased' || String(seniorNow.status || '') === 'Deceased')) {
                        targetBtn.disabled = false;
                        targetBtn.style.cursor = 'pointer';
                        targetBtn.innerHTML = 'Mark as Claimed';
                        scNotify('error', 'This senior have passed away, please go to OSCA if you think this is an error');
                        return;
                    }
                    // Use the SAME reference number the senior already received in
                    // their approval notification — never generate a new one here.
                    // (Generated fresh ONLY for legacy claims approved before refs existed.)
                    const existingClaim = (claimsData && claimsData[claimId])
                        || ((window.lastClaimsData || {})[claimId])
                        || {};
                    const refNum = existingClaim.refNumber || generateReferenceNumber('CLM');
                    const now = Date.now();

                    // 1. Update claim status to Claimed (keeps the approval refNumber)
                    await update(ref(db, `claims/${claimId}`), { 
                        status: 'Claimed', 
                        paidAmount: amount, 
                        paidAt: now, 
                        refNumber: refNum 
                    });

                    // 2. Send notification to senior (same ref for confirmation)
                    const notifKey = 'notif_' + now;
                    await update(ref(db, `users/${uid}/notifications/${notifKey}`), {
                        title: `${(serviceType || 'ASSISTANCE').toUpperCase()} Assistance Claimed 🟢`,
                        description: `Your ${serviceTitle} of PHP ${Number(amount).toLocaleString()} has been processed and marked as CLAIMED! Status is updated on your dashboard. Ref: ${refNum}`,
                        refNumber: refNum,
                        createdAt: now
                    });
                    
                    // 3. Update senior's benefits node (Auto-updates Senior Dashboard UI!)
                    const benefitKey = 'claim_' + claimId;
                    await update(ref(db, `users/${uid}/benefits/${benefitKey}`), {
                        title: serviceTitle,
                        amount: `PHP ${Number(amount).toLocaleString()}`,
                        status: 'Claimed',
                        refNumber: refNum,
                        approvedAt: now
                    });

                    // 4. Log transaction
                    await logTransaction('Claim Approved & Paid', seniorName, uid, amount, refNum);

                    // 5. Send status email if user has email
                    const userSnapshot = await get(ref(db, `users/${uid}`));
                    if (userSnapshot.exists() && userSnapshot.val().email) {
                        const userData = userSnapshot.val();
                        const emailToken = await auth.currentUser.getIdToken();
                        fetch('/api/send-status-email', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + emailToken },
                            body: JSON.stringify({ email: userData.email, name: seniorName, amount: amount, type: 'claim_approved', refNumber: refNum, serviceType: serviceType })
                        }).catch(console.error);
                    }

                    // 6. Official release SMS (TextBee). The server reads the CP
                    //    number from the senior's profile — best-effort, so a
                    //    sleeping gateway never blocks the "Claimed" update.
                    if (auth.currentUser) {
                        auth.currentUser.getIdToken().then(smsToken => {
                            return fetch('/api/send-status-sms', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + smsToken },
                                body: JSON.stringify({
                                    uid,
                                    type: /pension/i.test(String(serviceType || '')) ? 'pension_released' : 'claim_released',
                                    amount: String(amount || ''),
                                    serviceType: serviceType,
                                    refNumber: refNum
                                })
                            });
                        }).catch(err => console.warn('Release SMS skipped:', err.message));
                    }

                    scNotify('success', `Assistance for ${seniorName} marked as CLAIMED! Senior dashboard updated.`);
                } catch (err) {
                    targetBtn.disabled = false;
                    targetBtn.innerHTML = 'Claimed';
                    scNotify('error', 'Error marking claim as claimed: ' + err.message);
                }
            });
        });
    });

    // Attach Delete Button click listener (With "Are you sure?" confirmation)
    document.querySelectorAll('[data-action="claim-delete"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetBtn = e.target.closest('[data-action="claim-delete"]') || btn;
            const claimId = targetBtn.dataset.claimid;
            const uid = targetBtn.dataset.senioruid;
            const serviceType = targetBtn.dataset.servicetype;
            const seniorName = targetBtn.dataset.seniorname;
            const serviceTitle = `${serviceType ? (serviceType.charAt(0).toUpperCase() + serviceType.slice(1)) : 'Welfare'} Assistance`;

            confirmAction(`Are you sure you want to DELETE this assistance claim for ${seniorName}?`, async () => {
                targetBtn.disabled = true;
                targetBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';

                try {
                    const now = Date.now();

                    // 1. Remove claim record from database
                    await remove(ref(db, `claims/${claimId}`));

                    // 2. Remove benefit node from senior's profile if present
                    const benefitKey = 'claim_' + claimId;
                    await remove(ref(db, `users/${uid}/benefits/${benefitKey}`));

                    // 3. Notify senior
                    const notifKey = 'notif_' + now;
                    await update(ref(db, `users/${uid}/notifications/${notifKey}`), {
                        title: `${(serviceType || 'ASSISTANCE').toUpperCase()} Assistance Removed`,
                        description: `Your claim for ${serviceTitle} has been removed by OSCA staff. Contact office for inquiries.`,
                        createdAt: now
                    });

                    // 4. Log transaction
                    await logTransaction('Claim Deleted', seniorName, uid, '0', 'N/A', `Assistance claim ${claimId} deleted by employee.`);

                    scNotify('warning', `Assistance claim for ${seniorName} has been deleted. Senior dashboard updated.`);
                } catch (err) {
                    targetBtn.disabled = false;
                    targetBtn.innerHTML = 'Delete';
                    scNotify('error', 'Error deleting assistance claim: ' + err.message);
                }
            });
        });
    });
}



// ── Open claim modal details ──────────────────────────────────────────────────
function openClaimDetailsModal(claimId, claim) {
    const modal = document.getElementById('claimDetailsModal');
    const title = document.getElementById('modalClaimTitle');
    const content = document.getElementById('modalClaimContent');
    const approveBtn = document.getElementById('modalApproveBtn');
    const rejectBtn = document.getElementById('modalRejectBtn');

    if (!modal || !title || !content || !approveBtn || !rejectBtn) return;

    title.textContent = `Claim Form Details: ${(claim.serviceType || 'ASSISTANCE').toUpperCase()}`;
    
    // Format form data dynamically based on service
    const statusLabel = claim.status === 'Pending'
        ? '<span style="color:#d97706; font-weight:700;">Pending Review — review everything below before accepting or rejecting</span>'
        : `<span style="font-weight:700;">${escHtml(claim.status || 'Pending')}</span>`;
    let detailsHtml = `
        <div style="display:grid; grid-template-columns: 120px 1fr; gap:8px 15px; border-bottom:1px dashed #e2e8f0; padding-bottom:15px;">
            <strong>Senior Name:</strong> <span>${claim.applicantName}</span>
            <strong>Status:</strong> <span>${statusLabel}</span>
            <strong>Date Sent:</strong> <span>${new Date(claim.createdAt).toLocaleString()}</span>
            ${claim.urgentRequest ? `<strong>Request Type:</strong> <span style="color:#dc2626; font-weight:800;"><i class="fas fa-triangle-exclamation"></i> EMERGENCY / URGENT — review this request FIRST</span>` : ''}
        </div>
        <div style="display:flex; flex-direction:column; gap:12px; margin-top:5px;">
            <h4 style="color:#1e3a8a; font-size:0.95rem; text-transform:uppercase; letter-spacing:0.5px; border-left:3px solid #3b82f6; padding-left:8px;">Form Submissions:</h4>
    `;

    for (const [key, val] of Object.entries(claim.formData || {})) {
        if (key === 'cashUtilization' && Array.isArray(val)) {
            detailsHtml += `<p style="margin:0;"><strong>Utilization Plans:</strong> ${val.join(', ')}</p>`;
        } else {
            // Humanize keys (e.g. deceasedName -> Deceased Name)
            const humanKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
            detailsHtml += `<p style="margin:0;"><strong>${humanKey}:</strong> ${val}</p>`;
        }
    }

    detailsHtml += `</div>`;

    // ── Documents submitted by the senior (review BEFORE accepting / rejecting) ──
    const seniorRec = (typeof window !== 'undefined' && window.lastUsersData && window.lastUsersData[claim.uid]) || null;
    const noDoc = (icon, text) => `<span style="color:#94a3b8; font-size:0.78rem; text-align:center; padding:10px;"><i class="fas ${icon}" style="font-size:1.6rem; display:block; margin-bottom:6px; opacity:0.6;"></i>${text}</span>`;
    const docCard = (label, inner) => `
        <div style="flex:1; min-width:150px;">
            <h5 style="font-size:0.8rem; font-weight:700; color:#1e293b; margin:0 0 10px;">${label}</h5>
            <div style="background:#0f172a; border-radius:10px; overflow:hidden; border:2px solid #e2e8f0; aspect-ratio:4/3; display:flex; align-items:center; justify-content:center;">${inner}</div>
        </div>`;
    const imgThumb = (src, alt) => `<img src="${src}" alt="${alt}" data-action="view-doc-image" title="Click to view the full document" style="width:100%; height:100%; object-fit:cover; cursor:zoom-in;" />`;
    const medCertInner = (seniorRec && seniorRec.kycMedCertImage)
        ? imgThumb(seniorRec.kycMedCertImage, 'Medical certification')
        : ((seniorRec && seniorRec.kycMedCertPath)
            ? `<button data-action="view-stored-medcert" data-uid="${claim.uid}" style="margin:10px; padding:8px 14px; background:#1e293b; color:#ffffff; border:none; border-radius:6px; font-weight:600; font-size:0.8rem; cursor:pointer;"><i class="fas fa-file-medical"></i> Open Stored Copy</button>`
            : noDoc('fa-file-medical', 'Not on file'));

    detailsHtml += `
        <div style="margin-top:5px;">
            <h4 style="color:#1e3a8a; font-size:0.95rem; text-transform:uppercase; letter-spacing:0.5px; border-left:3px solid #3b82f6; padding-left:8px; margin-bottom:12px;">Documents Submitted (click a document to view it fully):</h4>
            <div style="display:flex; gap:16px; flex-wrap:wrap;">
                ${docCard('OSCA / Senior ID — Front', seniorRec && seniorRec.kycIdFrontImage ? imgThumb(seniorRec.kycIdFrontImage, 'ID front') : noDoc('fa-id-card', 'No image submitted'))}
                ${docCard('OSCA / Senior ID — Back', seniorRec && seniorRec.kycIdBackImage ? imgThumb(seniorRec.kycIdBackImage, 'ID back') : noDoc('fa-id-card', 'No image submitted'))}
                ${docCard('Medical Certification', medCertInner)}
            </div>
            <p style="margin:12px 0 0; font-size:0.82rem; color:#64748b;">Please review all submitted documents and every form answer above before accepting or rejecting this request.</p>
        </div>`;

    content.innerHTML = detailsHtml;

    // Document view handlers (full-size image + stored medical certification copy)
    content.querySelectorAll('[data-action="view-doc-image"]').forEach(img => {
        img.addEventListener('click', () => {
            if (img.src) window.open(img.src, '_blank');
        });
    });
    content.querySelectorAll('[data-action="view-stored-medcert"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Opening...';
            try {
                const token = await auth.currentUser.getIdToken();
                const res = await fetch(`/api/kyc-medcert/view/${uid}`, { headers: { 'Authorization': 'Bearer ' + token } });
                const data = await res.json();
                if (data && data.success && data.viewUrl) {
                    window.open(data.viewUrl, '_blank');
                } else {
                    scNotify('error', (data && data.message) || 'Unable to open the medical certification.');
                }
            } catch (e) {
                scNotify('error', 'Failed to open the medical certification.');
            }
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-file-medical"></i> Open Stored Copy';
        });
    });

    // Approve button click handler
    approveBtn.onclick = async () => {
        try {
            // Deceased gate: never release a pension/benefit payout to an account
            // OSCA staff archived as Deceased (burial claims for the family are
            // filed by relatives, not approved on the deceased senior's account).
            const seniorUidPre = claim.uid;
            let seniorPre = null;
            try {
                const preSnap = await get(ref(db, 'users/' + seniorUidPre));
                if (preSnap.exists()) seniorPre = preSnap.val() || null;
            } catch (preErr) { /* fall through to server / write-rule enforcement */ }
            if (seniorPre && (String(seniorPre.lifeStatus || '') === 'Deceased' || String(seniorPre.status || '') === 'Deceased')) {
                scNotify('error', 'This senior have passed away, please go to OSCA if you think this is an error');
                return;
            }
            const now = Date.now();
            const refNum = generateReferenceNumber('CLM');
            const seniorUid = claim.uid;
            const serviceType = claim.serviceType || 'burial';
            const serviceTitle = `${serviceType.charAt(0).toUpperCase() + serviceType.slice(1)} Assistance`;

            await update(ref(db, `claims/${claimId}`), { 
                status: 'Approved_Pending_Payout',
                approvedAt: now,
                refNumber: refNum
            });
            
            const benefitKey = 'claim_' + claimId;
            await update(ref(db, `users/${seniorUid}/benefits/${benefitKey}`), {
                title: serviceTitle,
                amount: `PHP 10,000`,
                status: 'Approved_Pending_Payout',
                refNumber: refNum,
                approvedAt: now
            });
            
            // Add notification to the senior's user node.
            // refNumber is stored as a STRUCTURED field (not only inside the
            // description text) so Process Benefits can verify live that the
            // reference shown on the claim is the same one the senior received.
            const notifKey = 'notif_' + now;
            await update(ref(db, `users/${seniorUid}/notifications/${notifKey}`), {
                title: `${serviceType.toUpperCase()} Approved by Staff`,
                description: `Your ${serviceTitle} claim has been approved! It is now sent to Process Benefits for final payout processing. Ref: ${refNum}`,
                refNumber: refNum,
                claimId: claimId,
                createdAt: now
            });

            // Send the official approval e-mail to the senior (best-effort,
            // non-blocking) — same unified endpoint the decline flow uses.
            try {
                const userSnapshot = await get(ref(db, `users/${seniorUid}`));
                if (userSnapshot.exists() && userSnapshot.val().email) {
                    const userData = userSnapshot.val();
                    const emailToken = await auth.currentUser.getIdToken();
                    fetch('/api/send-status-email', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + emailToken },
                        body: JSON.stringify({ email: userData.email, name: claim.applicantName, amount: '10000', type: 'claim_approved', refNumber: refNum, serviceType: serviceType })
                    }).catch(console.error);
                }
            } catch (emailErr) { console.error('Claim approval e-mail error:', emailErr); }

            // Official approval SMS (TextBee): pension approve vs assistance
            // approved. Best-effort — the approval is already saved, so a
            // sleeping gateway can never fail this modal action.
            try {
                if (auth.currentUser) {
                    const smsToken = await auth.currentUser.getIdToken();
                    fetch('/api/send-status-sms', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + smsToken },
                        body: JSON.stringify({
                            uid: seniorUid,
                            type: /pension/i.test(String(serviceType || '')) ? 'pension_approved' : 'claim_approved',
                            amount: String(claim.paidAmount || claim.amount || ''),
                            localAmount: String(claim.paidAmount || claim.amount || ''),
                            nationalAmount: '',
                            quarterlyTotal: String(claim.paidAmount || claim.amount || ''),
                            serviceType: serviceType,
                            refNumber: refNum
                        })
                    }).catch(console.error);
                }
            } catch (smsErr) { console.warn('Approval SMS skipped:', smsErr.message); }

            modal.style.display = 'none';
            scNotify('success', 'Claim Approved! Senior notified in-app, by e-mail & SMS.');

        } catch (e) {
            scNotify('error', 'Approval failed: ' + e.message);
        }
    };

    // Decline button click handler
    rejectBtn.onclick = async () => {
        try {
            const refNum = generateReferenceNumber('DEC');
            const now = Date.now();
            await update(ref(db, `claims/${claimId}`), { status: 'Rejected', rejectedAt: now, refNumber: refNum });
            
            // Generate rejected notification for senior
            const seniorUid = claim.uid;
            const notifKey = 'notif_' + now;
            await update(ref(db, `users/${seniorUid}/notifications/${notifKey}`), {
                title: `${claim.serviceType.toUpperCase()} Request Declined`,
                description: `Your welfare claim request was declined. Ref: ${refNum}. Please visit OSCA office with your documents.`,
                createdAt: now
            });

            // Log to admin
            await logTransaction('Claim Declined', claim.applicantName, seniorUid, '0', refNum, 'Claim verification failed.');

            // Send decline email
            const userSnapshot = await get(ref(db, `users/${seniorUid}`));
            if (userSnapshot.exists() && userSnapshot.val().email) {
                const userData = userSnapshot.val();
                const emailToken = await auth.currentUser.getIdToken();
                fetch('/api/send-status-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + emailToken },
                    body: JSON.stringify({ email: userData.email, name: claim.applicantName, type: 'claim_declined', serviceType: claim.serviceType, refNumber: refNum })
                }).catch(console.error);
            }

            // Decline SMS (TextBee) — the CP number is read from the senior's
            // profile on the server. Best-effort: the rejection is already saved.
            try {
                if (auth.currentUser) {
                    const smsToken = await auth.currentUser.getIdToken();
                    fetch('/api/send-status-sms', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + smsToken },
                        body: JSON.stringify({
                            uid: seniorUid,
                            type: 'claim_declined',
                            serviceType: claim.serviceType,
                            refNumber: refNum,
                            reason: 'Please visit the OSCA Magalang office with your documents.'
                        })
                    }).catch(console.error);
                }
            } catch (smsErr) { console.warn('Decline SMS skipped:', smsErr.message); }

            modal.style.display = 'none';
            scNotify('warning', `Claim Declined. Senior notified in-app, by e-mail & SMS. Ref: ${refNum}`);
        } catch (e) {
            scNotify('error', 'Decline failed: ' + e.message);
        }
    };

    modal.style.display = 'flex';
}

// ── Button wiring ────────────────────────────────────────────────────────────
function attachButtonListeners() {
    // Verify tab — Approve / Reject
    document.querySelectorAll('[data-action="approve"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            try {
                await update(ref(db, 'users/' + uid), { status: 'Active' });
                scNotify('success', 'Senior account approved and activated!');
            } catch (e) {
                scNotify('error', 'Failed to approve: ' + e.message);
            }
        });
    });

    document.querySelectorAll('[data-action="reject"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            try {
                await update(ref(db, 'users/' + uid), { status: 'Rejected' });
                scNotify('error', 'Senior account rejected.');
            } catch (e) {
                scNotify('error', 'Failed to reject: ' + e.message);
            }
        });
    });

    // Process tab — Process button
    document.querySelectorAll('[data-action="process"]').forEach(btn => {
        btn.addEventListener('click', () => {
            scNotify('info', 'Benefits processing initiated for this senior.');
        });
    });

    // ── KYC Approve ──────────────────────────────────────────────────────────
    document.querySelectorAll('[data-action="kyc-approve"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            const card = btn.closest('div[style*="border: 1px"]');
            // Enforce Senior ID number + back-to-back requirement (Step 4)
            const targetKycUser = (window.lastUsersData && window.lastUsersData[uid]) || null;
            if (!targetKycUser || !(targetKycUser.verificationSeniorId || targetKycUser.seniorId) || !targetKycUser.kycIdFrontImage || !targetKycUser.kycIdBackImage) {
                scNotify('error', 'Cannot approve: Senior ID is incomplete. ID number + both front and back images are required. Please ask the senior to re-submit or reject.');
                return;
            }
            try {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';

                const now = Date.now();
                const notifKey = 'notif_' + now;
                const employeeName = window.currentStaffName || 'Staff Member';
                const employeeUid = auth.currentUser ? auth.currentUser.uid : '';
                const employeeEmail = auth.currentUser ? auth.currentUser.email : '';
                await update(ref(db, 'users/' + uid), {
                    kycStatus: 'Verified',
                    kycVerifiedAt: now,
                    verifiedBy: employeeName,
                    verifiedByUid: employeeUid,
                    verifiedByEmail: employeeEmail,
                    pensionLocalAmount: Math.round(Number(pensionSettingsCache.local)) || 1000,
                    pensionNationalAmount: Math.round(Number(pensionSettingsCache.national)) || 3000,
                    pensionAmount: Math.round(Number(pensionSettingsCache.local)) || 1000,
                    pensionQuarterlyTotal: (Math.round(Number(pensionSettingsCache.local)) || 1000) * 3 + (Math.round(Number(pensionSettingsCache.national)) || 3000),
                    pensionSetAt: now,
                    pensionSetBy: employeeName
                });
                await update(ref(db, `users/${uid}/notifications/${notifKey}`), {
                    title: 'Identity Verified ✓',
                    description: 'Congratulations! Your identity has been verified. Your Local (monthly) + National (quarterly) pension is now active — check your dashboard.',
                    createdAt: now
                });

                if (card) card.style.display = 'none';
                scNotify('success', 'Senior identity verified successfully!');

                // Pension-approved SMS (TextBee): verification auto-activates the
                // Local + National pension, so the senior is texted the pension
                // approval notice (not a plain "verified" message). The server
                // reads the CP number from this senior's profile. Best-effort —
                // the verification is already saved, so a sleeping gateway must
                // never surface an error to the staff member.
                if (auth.currentUser) {
                    auth.currentUser.getIdToken().then(token => {
                        const localAmt = Math.round(Number(pensionSettingsCache.local)) || 1000;
                        const natAmt = Math.round(Number(pensionSettingsCache.national)) || 3000;
                        return fetch('/api/send-status-sms', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                            body: JSON.stringify({
                                uid,
                                type: 'pension_approved',
                                localAmount: String(localAmt),
                                nationalAmount: String(natAmt),
                                quarterlyTotal: String(localAmt * 3 + natAmt)
                            })
                        });
                    }).catch(err => console.warn('Pension approval SMS skipped:', err.message));
                }

                // Mirror the verified senior to the Supabase data store (best-effort)
                if (auth.currentUser) {
                    const token = await auth.currentUser.getIdToken();
                    fetch('/api/supabase/sync-senior', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify({ uid })
                    }).catch(err => console.warn('Supabase mirror skipped:', err.message));
                }
            } catch (e) {
                btn.disabled = false;
                btn.innerHTML = 'Verify';
                scNotify('error', 'KYC verification failed: ' + e.message);
            }
        });
    });

    // ── KYC Reject ───────────────────────────────────────────────────────────
    document.querySelectorAll('[data-action="kyc-reject"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uid = btn.dataset.uid;
            const card = btn.closest('div[style*="border: 1px"]');
            try {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rejecting...';

                const now = Date.now();
                const notifKey = 'notif_' + now;
                await update(ref(db, 'users/' + uid), {
                    kycStatus: 'Rejected',
                    kycRejectedAt: now,
                    kycFaceImage: null,
                    kycIdFrontImage: null,
                    kycIdBackImage: null,
                    kycMedCertImage: null,
                    kycMedCertName: '',
                    kycMedCertType: ''
                });
                await update(ref(db, `users/${uid}/notifications/${notifKey}`), {
                    title: 'Verification Rejected',
                    description: 'Your identity verification was rejected. Please re-submit with clear and valid information.',
                    createdAt: now
                });

                if (card) card.style.display = 'none';
                scNotify('warning', 'KYC rejected. Senior notified to re-submit.');

                // Keep the Supabase mirror in sync (kycStatus -> Rejected, face cleared)
                if (auth.currentUser) {
                    const token = await auth.currentUser.getIdToken();
                    fetch('/api/supabase/sync-senior', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify({ uid })
                    }).catch(err => console.warn('Supabase mirror skipped:', err.message));
                }
            } catch (e) {
                btn.disabled = false;
                btn.innerHTML = 'Reject';
                scNotify('error', 'KYC rejection failed: ' + e.message);
            }
        });
    });
}

// ── Global function for Send Reminder ──────────────────────────────────────────
// Two-legged delivery, so a reminder is never limited to the portal:
//   1) in-app notification  -> users/{uid}/notifications (every senior)
//   2) SMS (TextBee)        -> /api/send-announcement-sms, one text per senior
//                             whose profile carries a usable CP number.
// Leg 1 completes first; leg 2 is best-effort and reports how many were actually
// texted. Recipients are always resolved server-side from senior profiles.
window.sendReminderToAll = async function() {
    const msgEl = document.getElementById('reminderMessage');
    const msg = (msgEl ? msgEl.value : '').trim();
    if (!msg) {
        scNotify('warning', 'Please enter a message first.');
        return;
    }

    try {
        const usersSnap = await get(ref(db, 'users'));
        if (usersSnap.exists()) {
            const updates = {};
            const now = Date.now();
            usersSnap.forEach(childSnap => {
                const uid = childSnap.key;
                const user = childSnap.val();
                if (user.role === 'senior') {
                    const notifKey = 'notif_' + now;
                    updates[`users/${uid}/notifications/${notifKey}`] = {
                        title: 'Important Reminder',
                        description: msg,
                            createdAt: now
                    };
                }
            });
            await update(ref(db), updates);

            // Second leg of the same reminder: the identical text also goes out
            // as an SMS to every senior with a CP number on file, so seniors who
            // never open the portal still receive it. Recipients are resolved
            // server-side from senior profiles, never from this request.
            // Best-effort by design — the in-app write above already succeeded,
            // so a sleeping gateway is reported, never treated as a failure.
            let smsNote = 'SMS could not be sent.';
            try {
                smsNote = smsOutcomeLine(await postAnnouncementSms({ broadcast: true, message: msg }));
            } catch (smsErr) {
                console.warn('Reminder SMS broadcast skipped:', smsErr.message);
            }

            scNotify('success', `Reminder sent to all seniors in-app. ${smsNote}`);
            if (msgEl) msgEl.value = '';
        }
    } catch (e) {
        scNotify('error', 'Failed to send reminders: ' + e.message);
    }
}

// ── Announcement / custom SMS to one senior or to everyone ───────────────────
// Staff-composed message box -> /api/send-announcement-sms. Recipients are
// always resolved server-side from senior profiles (users/{uid}/cpNumber).
//   sendAnnouncementSmsToSenior(uid, message)  -> one specific senior
//   sendAnnouncementSmsBroadcast(message)      -> every senior (broadcast:true)
// Both are best-effort: the server answers 200 with sent/skipped counts.
async function postAnnouncementSms(payload) {
    const token = await getStaffIdToken();
    const resp = await fetch('/api/send-announcement-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false) {
        throw new Error((data && data.message) || `Announcement SMS failed (HTTP ${resp.status}).`);
    }
    return data;
}

// Staff-facing one-liner for an /api/send-announcement-sms reply. The route
// answers 200 even when the Android gateway is asleep or a senior has no CP
// number, so the sent/skipped split is the only honest signal of how many
// seniors were actually texted.
function smsOutcomeLine(data) {
    const sent = Number(data && data.sent) || 0;
    const skipped = Number(data && data.skipped) || 0;
    let line = `SMS sent to ${sent} senior${sent === 1 ? '' : 's'}`;
    if (skipped) line += `, ${skipped} skipped (no CP number on file or gateway offline)`;
    return line;
}

window.sendAnnouncementSmsToSenior = async function(uid, message) {
    const text = String(message || '').trim();
    if (!uid || !text) {
        scNotify('warning', 'Select a senior and enter a message first.');
        return;
    }
    try {
        const data = await postAnnouncementSms({ uid, message: text.slice(0, 300) });
        scNotify('success', data.message || 'Announcement SMS sent.');
    } catch (e) {
        scNotify('error', 'Announcement SMS not sent: ' + e.message);
    }
};

window.sendAnnouncementSmsBroadcast = async function(message) {
    const box = document.getElementById('reminderMessage');
    const text = String(message !== undefined ? message : (box ? box.value : '')).trim();
    if (!text) {
        scNotify('warning', 'Please enter a message first.');
        return;
    }
    try {
        const data = await postAnnouncementSms({ broadcast: true, message: text.slice(0, 300) });
        scNotify('success', data.message || 'Announcement SMS broadcast sent.');
        if (message === undefined && box) box.value = '';
    } catch (e) {
        scNotify('error', 'Announcement SMS broadcast failed: ' + e.message);
    }
};

// ── Senior Appointment Requests (Checkups) Renderer ───────────────────────────
// Lists every appointment booked by seniors (queue node) inside the Health
// Records tab so staff can Approve or Decline each request in real time.
function apptReqStatusBadge(status) {
    const s = status || 'Pending';
    const map = {
        'Pending':     'background:#e0f2fe; color:#0369a1;',
        'Rescheduled': 'background:#ffedd5; color:#c2410c;',
        'Approved':    'background:#dcfce7; color:#15803d;',
        'Attended':    'background:#dcfce7; color:#15803d;',
        'Declined':    'background:#fee2e2; color:#b91c1c;',
        'Missed':      'background:#fee2e2; color:#b91c1c;',
        'Cancelled':   'background:#f1f5f9; color:#64748b;'
    };
    return `<span style="padding:4px 10px; border-radius:12px; font-weight:700; font-size:0.8rem; ${map[s] || map['Pending']}">${escHtml(s)}</span>`;
}

function renderSeniorAppointmentRequests(usersData, queuesData) {
    const container = document.getElementById('seniorApptRequestsContainer');
    const countPill = document.getElementById('seniorApptPendingCount');
    if (!container) return;

    const requests = Object.entries(queuesData || {})
        .map(([id, q]) => ({ id, ...(q || {}) }))
        .filter(q => q && q.uid)
        // Archive Function: requests of archived seniors are hidden from the
        // processing list — only ACTIVE seniors appear here.
        .filter(q => !isArchivedSenior((usersData || {})[q.uid] || {}));

    // Pending / rescheduled requests first (High priority seniors first inside
    // each status so employees see their appointment requests fastest),
    // then approved, then decided history.
    const groupOf = (s) => (['Pending', 'Rescheduled'].includes(s) ? 0 : (s === 'Approved' ? 1 : 2));
    requests.sort((a, b) => {
        const ga = groupOf(a.status || 'Pending');
        const gb = groupOf(b.status || 'Pending');
        if (ga !== gb) return ga - gb;
        // Same queue status → High → Medium → Low (approved human decision
        // first, else illness + age rule — never guessed).
        const pa = priorityRank(effectiveSeniorPriority((usersData || {})[a.uid] || {}));
        const pb = priorityRank(effectiveSeniorPriority((usersData || {})[b.uid] || {}));
        if (pa !== pb) return pa - pb;
        if (ga === 2) return (b.scheduledAt || 0) - (a.scheduledAt || 0);
        return (a.scheduledAt || 0) - (b.scheduledAt || 0);
    });

    const pendingCount = requests.filter(q => ['Pending', 'Rescheduled'].includes(q.status)).length;
    if (countPill) {
        countPill.textContent = `${pendingCount} pending approval`;
        countPill.style.display = pendingCount > 0 ? 'inline-block' : 'none';
    }

    if (requests.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; color:#94a3b8; padding:30px;">
                No appointment requests booked by seniors yet.
            </div>`;
        return;
    }

    container.innerHTML = '';
    // High-priority section headers so each category stays manageable:
    // "Needs Action First — High Priority" → Medium → Low, then the rest.
    let _lastApptHeader = '';
    const _apptHeaderFor = (q, user) => {
        const needsAction = ['Pending', 'Rescheduled'].includes(q.status);
        const prio = effectiveSeniorPriority(user);
        if (needsAction) {
            if (prio === 'High') return 'Needs Action — High Priority First';
            if (prio === 'Medium') return 'Needs Action — Medium Priority';
            return 'Needs Action — Low Priority';
        }
        if (q.status === 'Approved') return 'Approved — Awaiting Visit (High Priority First)';
        return 'History — Decided Requests';
    };
    const _apptHeaderStyle = (label) => label.startsWith('Needs Action — High')
        ? 'background:#fef2f2; border:1px solid #fecaca; color:#b91c1c;'
        : (label.startsWith('Needs Action')
            ? 'background:#fffbeb; border:1px solid #fde68a; color:#92400e;'
            : 'background:#f8fafc; border:1px solid #e2e8f0; color:#475569;');
    requests.forEach(q => {
        const user = (usersData || {})[q.uid] || {};
        const qPrio = effectiveSeniorPriority(user);
        const headerLabel = _apptHeaderFor(q, user);
        if (headerLabel !== _lastApptHeader) {
            _lastApptHeader = headerLabel;
            const h = document.createElement('div');
            h.style.cssText = `font-size:0.8rem; font-weight:800; letter-spacing:0.02em; padding:8px 14px; border-radius:8px; ${_apptHeaderStyle(headerLabel)}`;
            h.textContent = headerLabel;
            container.appendChild(h);
        }
        const name = user.name || q.name || 'Senior Citizen';
        const seniorId = user.seniorId || q.seniorId || 'N/A';
        const initial = name.charAt(0).toUpperCase();
        const isHigh = qPrio === 'High';
        const needsActionCard = ['Pending', 'Rescheduled'].includes(q.status);
        const canAct = ['Pending', 'Rescheduled'].includes(q.status);
        // Approved visits can be marked as done (Attended) once the checkup is
        // finished — this frees the senior to book a new appointment.
        const canMarkDone = q.status === 'Approved';
        const seniorNote = q.note ? `<div style="font-size:0.8rem; color:#64748b; margin-top:2px;">Senior's note: ${escHtml(q.note)}</div>` : '';
        const decisionNote = q.decisionNote ? `<div style="font-size:0.8rem; color:#64748b; margin-top:2px;">Staff note: ${escHtml(q.decisionNote)}</div>` : '';

        const card = document.createElement('div');
        card.style.cssText = `display:flex; justify-content:space-between; align-items:center; background:${isHigh && needsActionCard ? '#fff7f7' : 'white'}; border:1px solid ${isHigh && needsActionCard ? '#fca5a5' : '#e2e8f0'}; ${isHigh && needsActionCard ? 'border-left:4px solid #dc2626;' : ''} border-radius:12px; padding:16px 20px; gap:15px; flex-wrap:wrap;`;
        card.innerHTML = `
            <div style="display:flex; align-items:center; gap:15px; flex:1; min-width:250px;">
                <div style="width:44px; height:44px; border-radius:50%; background:${isHigh ? '#fee2e2' : '#e0f2fe'}; color:${isHigh ? '#b91c1c' : '#0284c7'}; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:1.1rem; flex-shrink:0;">${escHtml(initial)}</div>
                <div>
                    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:3px;">
                        <h4 style="margin:0; color:#1e293b; font-size:1rem; font-weight:700;">${escHtml(name)}</h4>
                        ${apptReqStatusBadge(q.status)}
                        ${priorityPillHtml(qPrio)}
                    </div>
                    <div style="font-size:0.85rem; color:#64748b;">
                        Senior ID: ${escHtml(String(seniorId))} &bull; Queue: ${escHtml(q.queueNumber || 'N/A')}
                    </div>
                    <div style="font-size:0.88rem; color:#334155; margin-top:3px;">
                        <strong>${escHtml(q.service || 'General Consultation')}</strong> &mdash; ${escHtml(q.date || 'TBD')} at ${escHtml(q.time || '')}
                    </div>
                    ${seniorNote}
                    ${decisionNote}
                </div>
            </div>

            <div style="display:flex; align-items:center; gap:10px; flex-shrink:0;">
                ${canAct ? `
                    <button data-appt-act="approve" data-id="${escHtml(q.id)}" data-name="${escHtml(name)}" style="padding:8px 16px; border:none; border-radius:8px; background:#16a34a; color:white; font-weight:700; font-size:0.82rem; cursor:pointer;">Approve</button>
                    <button data-appt-act="decline" data-id="${escHtml(q.id)}" data-name="${escHtml(name)}" style="padding:8px 16px; border:1px solid #fca5a5; border-radius:8px; background:#fee2e2; color:#b91c1c; font-weight:700; font-size:0.82rem; cursor:pointer;">Decline</button>
                ` : canMarkDone ? `
                    <button data-appt-act="done" data-id="${escHtml(q.id)}" data-name="${escHtml(name)}" title="Mark this visit as completed so the senior can book a new appointment" style="padding:8px 16px; border:none; border-radius:8px; background:#2563eb; color:white; font-weight:700; font-size:0.82rem; cursor:pointer;">Mark as Done</button>
                ` : `<span style="font-size:0.78rem; color:#94a3b8; font-style:italic;">No action needed</span>`}
            </div>`;
        container.appendChild(card);
    });

    // Attach Approve / Decline / Mark-as-Done click listeners
    container.querySelectorAll('button[data-appt-act]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const name = btn.dataset.name;
            if (btn.dataset.apptAct === 'approve') approveSeniorAppointment(id, name);
            else if (btn.dataset.apptAct === 'done') markAppointmentDone(id, name);
            else declineSeniorAppointment(id, name);
        });
    });
}

// ── Approve / Decline handlers for senior appointment requests ────────────────
async function setSeniorAppointmentStatus(queueId, status, seniorName) {
    try {
        const token = await auth.currentUser.getIdToken();
        const res = await fetch(`/api/queue/${encodeURIComponent(queueId)}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ status })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || 'Failed to update the appointment.');
        scNotify('success', status === 'Approved'
            ? `Appointment approved for ${seniorName}. The senior has been notified.`
            : status === 'Attended'
                ? `Visit marked as done for ${seniorName}. They can now book a new appointment.`
                : `Appointment declined for ${seniorName}. The senior has been notified.`);
    } catch (err) {
        console.error('Update senior appointment status error:', err);
        scNotify('error', 'Failed to update appointment: ' + err.message);
    }
}

function approveSeniorAppointment(queueId, seniorName) {
    confirmAction(
        `Approve ${seniorName}'s checkup appointment? The senior will be notified that their request is confirmed.`,
        () => setSeniorAppointmentStatus(queueId, 'Approved', seniorName)
    );
}

function declineSeniorAppointment(queueId, seniorName) {
    confirmAction(
        `Decline ${seniorName}'s checkup appointment? The senior will be notified and may book a new schedule.`,
        () => setSeniorAppointmentStatus(queueId, 'Declined', seniorName)
    );
}

// ── Mark as Done (Attended) for approved senior appointments ──────────────────
// Staff clicks this once the senior's checkup visit is finished. The appointment
// becomes "Attended" (terminal), which frees the senior to book a new checkup.
function markAppointmentDone(queueId, seniorName) {
    confirmAction(
        `Mark ${seniorName}'s visit as done? The senior will be notified that the visit is completed and can book a new appointment.`,
        () => setSeniorAppointmentStatus(queueId, 'Attended', seniorName)
    );
}

window.toggleSelectAllSeniors = function(source) {
    const checkboxes = document.querySelectorAll('.senior-reminder-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = source.checked;
    });
};

window.sendSelectedReminders = async function() {
    const msg = document.getElementById('reminderMessage').value.trim();
    if (!msg) {
        scNotify('warning', 'Please enter a message first.');
        return;
    }

    const checkboxes = document.querySelectorAll('.senior-reminder-checkbox:checked');
    if (checkboxes.length === 0) {
        scNotify('warning', 'Please select at least one senior.');
        return;
    }

    const btn = document.querySelector('#selectUserModal .btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = 'Sending...';
    btn.disabled = true;

    try {
        const updates = {};
        const now = Date.now();
        const selectedUids = Array.from(checkboxes).map(cb => cb.value).filter(Boolean);

        checkboxes.forEach(cb => {
            const uid = cb.value;
            const notifKey = 'notif_' + now + '_' + Math.floor(Math.random()*1000);
            updates[`users/${uid}/notifications/${notifKey}`] = {
                title: 'Important Direct Reminder',
                description: msg,
                createdAt: now
            };
        });

        await update(ref(db), updates);

        // Same second leg as "Send to everyone": text the very same seniors
        // through /api/send-announcement-sms (uids array) so a targeted reminder
        // reaches them by SMS too. Best-effort — the in-app write already landed.
        let smsNote = 'SMS could not be sent.';
        try {
            smsNote = smsOutcomeLine(await postAnnouncementSms({ uids: selectedUids, message: msg }));
        } catch (smsErr) {
            console.warn('Reminder SMS skipped:', smsErr.message);
        }

        scNotify('success', `Direct reminder sent successfully to ${selectedUids.length} seniors in-app. ${smsNote}`);
        document.getElementById('reminderMessage').value = '';
        document.getElementById('selectUserModal').style.display = 'none';
        
        // Reset checkboxes
        document.querySelectorAll('.senior-reminder-checkbox').forEach(cb => cb.checked = false);
        const selectAllCb = document.getElementById('selectAllSeniorsCheckbox');
        if (selectAllCb) selectAllCb.checked = false;

    } catch (e) {
        scNotify('error', 'Failed to send reminders: ' + e.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// ── QR Digital ID Scanner & Verification (Employee) ──────────────────────────
// Reads the senior's QR code (Senior Portal > Profile) or a manually-entered
// Senior ID and calls /api/verify-qr for instant identity verification with a
// real-time eligibility check and duplicate-claim awareness.
let qrStream = null;
let qrScanActive = false;
let qrLastScanTime = 0;

function escHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

window.qrScannerStop = function(resetUi = true) {
    qrScanActive = false;
    if (qrStream) {
        qrStream.getTracks().forEach(track => track.stop());
        qrStream = null;
    }
    if (resetUi) {
        const video = document.getElementById('qrScanVideo');
        const placeholder = document.getElementById('qrScanPlaceholder');
        const guide = document.getElementById('qrScanGuide');
        const startBtn = document.getElementById('startQrScanBtn');
        const stopBtn = document.getElementById('stopQrScanBtn');
        if (video) { video.srcObject = null; video.style.display = 'none'; }
        if (placeholder) placeholder.style.display = 'flex';
        if (guide) guide.style.display = 'none';
        if (startBtn) startBtn.style.display = 'flex';
        if (stopBtn) stopBtn.style.display = 'none';
    }
};

window.startQrScan = async function() {
    const video = document.getElementById('qrScanVideo');
    const placeholder = document.getElementById('qrScanPlaceholder');
    const guide = document.getElementById('qrScanGuide');
    const startBtn = document.getElementById('startQrScanBtn');
    const stopBtn = document.getElementById('stopQrScanBtn');
    const status = document.getElementById('qrVerifyStatus');
    if (!video) return;

    try {
        qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } });
        video.srcObject = qrStream;
        video.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
        if (guide) guide.style.display = 'block';
        if (startBtn) startBtn.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'flex';
        if (status) status.textContent = "Scanning... Point the camera at the senior's QR code.";

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        qrScanActive = true;

        const tick = () => {
            if (!qrScanActive || !qrStream) return;
            if (video.readyState === video.HAVE_ENOUGH_DATA) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const code = window.jsQR ? window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' }) : null;
                if (code && code.data) {
                    const now = Date.now();
                    // Debounce: don't re-verify the same code more than once every 4 seconds
                    if (now - qrLastScanTime > 4000) {
                        qrLastScanTime = now;
                        window.verifyQrCode(code.data);
                    }
                }
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    } catch (err) {
        console.error('QR camera error:', err);
        window.qrScannerStop(true);
        if (status) status.innerHTML = '<span style="color:#ef4444; font-weight:600;">Camera unavailable: ' + escHtml(err.message) + '. Use manual entry below.</span>';
    }
};

window.verifyQrCode = async function(rawCode) {
    const code = String(rawCode || '').trim();
    const status = document.getElementById('qrVerifyStatus');
    const result = document.getElementById('qrVerifyResult');
    const manualBtn = document.getElementById('qrManualVerifyBtn');
    if (!code) {
        if (status) status.innerHTML = '<span style="color:#f59e0b; font-weight:600;">Scan a QR code or enter a Senior ID first.</span>';
        return;
    }

    try {
        if (status) {
            status.innerHTML = '<i class="fas fa-spinner fa-spin" style="color:#2563eb;"></i> <span style="font-weight:600;">Verifying...</span>';
        }
        if (manualBtn) manualBtn.disabled = true;

        const token = await auth.currentUser.getIdToken();
        const res = await fetch('/api/verify-qr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ code })
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
            if (result) result.innerHTML = `
                <div style="background:#fef2f2; border:2px solid #ef4444; border-radius:12px; padding:20px 24px;">
                    <div style="display:flex; align-items:center; gap:10px; color:#b91c1c; font-weight:800; font-size:1rem;">
                        VERIFICATION FAILED
                    </div>
                    <p style="color:#7f1d1d; margin:10px 0 0; font-size:0.9rem;">${escHtml(data.message || 'Verification failed.')}</p>
                </div>`;
            if (status) status.innerHTML = '<span style="color:#ef4444; font-weight:600;">Verification failed. See details below.</span>';
            scNotify('error', data.message || 'QR verification failed.');
            return;
        }

        renderQrVerifyResult(data);
        const vStatus = (data.senior && data.senior.verificationStatus) || 'Not yet verified';
        const isEligible = data.eligibility && data.eligibility.eligible;
        if (status) {
            if (vStatus === 'Verified') {
                status.innerHTML = `<span style="color:#16a34a; font-weight:700;">Senior Verified${isEligible ? ' — Eligible for benefits.' : ' — See eligibility details below.'}</span>`;
            } else if (vStatus === 'Pending') {
                status.innerHTML = '<span style="color:#d97706; font-weight:700;">Senior Found — Pending Verification.</span>';
            } else {
                status.innerHTML = '<span style="color:#64748b; font-weight:700;">Senior Found — Not Yet Verified.</span>';
            }
        }
        scNotify(vStatus === 'Verified' ? 'success' : 'info', `Senior account found: ${data.senior.name || 'Senior Citizen'} (${vStatus})`);
    } catch (err) {
        console.error('Verify QR error:', err);
        if (status) status.innerHTML = '<span style="color:#ef4444; font-weight:600;">Verification error: ' + escHtml(err.message) + '</span>';
        scNotify('error', 'QR verification failed: ' + err.message);
    } finally {
        if (manualBtn) manualBtn.disabled = false;
    }
};

function renderQrVerifyResult(data) {
    const result = document.getElementById('qrVerifyResult');
    if (!result) return;

    const s = data.senior || {};
    const eligibility = data.eligibility || { eligible: false, checks: [] };
    const eligible = !!eligibility.eligible;
    const claimedThisPeriod = data.claimedThisPeriod || [];
    const vStatus = s.verificationStatus || 'Not yet verified';

    // ── Safety net: the senior's AGE solely determines the priority category
    // (OSCA milestone rule) — guards against stale server responses:
    //   age <= 89 → Low   |   age 90-99 → Medium   |   age >= 100 → High
    let sAge = Number(s.age) || 0;
    if (!sAge && s.dob) {
        const b = new Date(s.dob);
        if (!isNaN(b.getTime())) {
            const t = new Date();
            sAge = t.getFullYear() - b.getFullYear();
            const m = t.getMonth() - b.getMonth();
            if (m < 0 || (m === 0 && t.getDate() < b.getDate())) sAge--;
        }
    }
    let pLevel = sAge >= 100 ? 'High' : sAge >= 90 ? 'Medium' : 'Low';

    // Status verification badge styling
    let statusBadgeHtml = '';
    if (vStatus === 'Verified') {
        statusBadgeHtml = `<span style="background:#dcfce7; color:#15803d; border:1px solid #86efac; padding:4px 12px; border-radius:20px; font-weight:700; font-size:0.82rem; display:inline-flex; align-items:center; gap:5px;">Verified</span>`;
    } else if (vStatus === 'Pending') {
        statusBadgeHtml = `<span style="background:#fef3c7; color:#b45309; border:1px solid #fcd34d; padding:4px 12px; border-radius:20px; font-weight:700; font-size:0.82rem; display:inline-flex; align-items:center; gap:5px;">Pending</span>`;
    } else {
        statusBadgeHtml = `<span style="background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; padding:4px 12px; border-radius:20px; font-weight:700; font-size:0.82rem; display:inline-flex; align-items:center; gap:5px;">Not Yet Verified</span>`;
    }

    // Priority level badge styling — level only (age-based), no numeric score
    let priorityBadgeHtml = '';
    if (pLevel === 'High') {
        priorityBadgeHtml = `<span style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; padding:4px 12px; border-radius:20px; font-weight:700; font-size:0.82rem; display:inline-flex; align-items:center; gap:5px;">High Priority</span>`;
    } else if (pLevel === 'Medium') {
        priorityBadgeHtml = `<span style="background:#fef3c7; color:#b45309; border:1px solid #fcd34d; padding:4px 12px; border-radius:20px; font-weight:700; font-size:0.82rem; display:inline-flex; align-items:center; gap:5px;">Medium Priority</span>`;
    } else {
        priorityBadgeHtml = `<span style="background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; padding:4px 12px; border-radius:20px; font-weight:700; font-size:0.82rem; display:inline-flex; align-items:center; gap:5px;">Low Priority</span>`;
    }

    // Account status badge styling
    const accStatus = s.accountStatus || 'Active';
    const accBadgeHtml = `<span style="background:${accStatus === 'Active' ? '#f0fdf4' : '#f8fafc'}; color:${accStatus === 'Active' ? '#166534' : '#64748b'}; border:1px solid ${accStatus === 'Active' ? '#bbf7d0' : '#cbd5e1'}; padding:3px 10px; border-radius:12px; font-weight:600; font-size:0.78rem;">${escHtml(accStatus)}</span>`;

    const identityRows = [
        ['Name', `<strong>${escHtml(s.name || 'N/A')}</strong>`],
        ['Senior / OSCA ID', `<span style="font-family:monospace; font-weight:700; background:#f1f5f9; padding:2px 8px; border-radius:4px;">${escHtml(s.seniorId || 'N/A')}</span>`],
        ['Account / Email', escHtml(s.email || 'N/A')],
        ['Address', escHtml(s.address || s.barangay || 'N/A')],
        ['Barangay', escHtml(s.barangay || 'N/A')],
        ['Age', (s.age != null && s.age !== '') ? `${escHtml(String(s.age))} years old ${s.dob ? `<span style="color:#64748b; font-size:0.8rem;">(DOB: ${escHtml(s.dob)})</span>` : ''}` : 'N/A'],
        ['Priority Level', priorityBadgeHtml],
        ['Status Verification', statusBadgeHtml],
        ['Account Status', accBadgeHtml],
        ['Life Status', escHtml(s.lifeStatus || 'Active')],
        ['Health Condition', escHtml(s.healthCondition || 'None reported')]
    ].map(([k, v]) => `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid #f1f5f9; font-size:0.85rem;">
            <span style="color:#64748b; font-weight:600;">${escHtml(k)}</span>
            <span style="color:#1e293b; text-align:right;">${v}</span>
        </div>`).join('');

    const checksHtml = (eligibility.checks || []).map(c => `
        <div style="display:flex; align-items:flex-start; gap:8px; padding:7px 0; border-bottom:1px solid #f1f5f9;">
            <span style="color:${c.passed ? '#16a34a' : '#b91c1c'}; font-weight:700; margin-top:1px;">${c.passed ? '✓' : '✗'}</span>
            <div>
                <div style="font-weight:600; color:#1e293b; font-size:0.85rem;">${escHtml(c.label)}</div>
                <div style="font-size:0.78rem; color:#64748b;">${escHtml(c.detail || '')}</div>
            </div>
        </div>`).join('');

    const claimedHtml = claimedThisPeriod.length > 0
        ? `<div style="background:#fef3c7; border:1px solid #fde68a; border-radius:10px; padding:12px 16px; margin-top:14px;">
               <div style="font-weight:700; color:#92400e; font-size:0.85rem;">Duplicate-claim warning</div>
               <div style="font-size:0.82rem; color:#a16207; margin-top:4px;">
                   Already claimed for the current period (${escHtml(data.period || '')}): ${claimedThisPeriod.map(escHtml).join(', ')}.
               </div>
           </div>`
        : `<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:12px 16px; margin-top:14px;">
               <div style="font-weight:700; color:#166534; font-size:0.85rem;">No claims recorded for the current period (${escHtml(data.period || '')})</div>
           </div>`;

    const recentClaimsHtml = (data.recentClaims || []).length > 0
        ? `<div style="margin-top:14px;">
               <div style="font-weight:700; color:#475569; font-size:0.85rem; margin-bottom:8px;">Recent claim history</div>
               ${data.recentClaims.map(c => `
                   <div style="display:flex; justify-content:space-between; gap:10px; padding:8px 0; border-bottom:1px solid #f1f5f9; font-size:0.82rem; color:#475569; flex-wrap:wrap;">
                       <span><strong>${escHtml(c.benefitType || 'Benefit')}</strong></span>
                       <span>${escHtml(String(c.amount || ''))}</span>
                       <span>${escHtml(c.period || '')}</span>
                       <span>${c.releasedAt ? new Date(c.releasedAt).toLocaleDateString() : ''}</span>
                   </div>`).join('')}
           </div>`
        : '';

    // Header theme based on verification status
    let headerBorderColor = '#cbd5e1';
    let headerBgColor = '#ffffff';
    let headerTitleColor = '#1e293b';
    let headerTitle = 'Senior Account Information';

    if (vStatus === 'Verified') {
        headerBorderColor = eligible ? '#16a34a' : '#2563eb';
        headerBgColor = eligible ? '#f0fdf4' : '#eff6ff';
        headerTitleColor = eligible ? '#166534' : '#1e40af';
        headerTitle = eligible ? 'VERIFIED CITIZEN — ELIGIBLE FOR BENEFITS' : 'VERIFIED CITIZEN — NOT CURRENTLY ELIGIBLE FOR CLAIMS';
    } else if (vStatus === 'Pending') {
        headerBorderColor = '#f59e0b';
        headerBgColor = '#fffbeb';
        headerTitleColor = '#92400e';
        headerTitle = 'SENIOR RECORD FOUND — PENDING VERIFICATION';
    } else {
        headerBorderColor = '#94a3b8';
        headerBgColor = '#f8fafc';
        headerTitleColor = '#334155';
        headerTitle = 'SENIOR RECORD FOUND — NOT YET VERIFIED';
    }

    result.innerHTML = `
        <div style="background:${headerBgColor}; border:2px solid ${headerBorderColor}; border-radius:14px; padding:24px; box-shadow: 0 4px 12px rgba(0,0,0,0.03);">
            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:20px; border-bottom:1px solid rgba(0,0,0,0.06); padding-bottom:16px;">
                <div>
                    <div style="font-weight:800; font-size:1.05rem; color:${headerTitleColor}; letter-spacing:0.3px;">
                        ${headerTitle}
                    </div>
                    <div style="font-size:0.8rem; color:#64748b;">Lookup completed at ${new Date().toLocaleTimeString()}</div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${statusBadgeHtml}
                    ${priorityBadgeHtml}
                </div>
            </div>

            <div style="display:flex; gap:24px; flex-wrap:wrap;">
                <div style="flex:1.2; min-width:300px; background:white; border-radius:12px; padding:18px 20px; border:1px solid #e2e8f0;">
                    <div style="font-weight:700; color:#1e293b; font-size:0.92rem; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
                        Senior Account Information
                    </div>
                    ${identityRows}
                </div>
                <div style="flex:1; min-width:280px; background:white; border-radius:12px; padding:18px 20px; border:1px solid #e2e8f0;">
                    <div style="font-weight:700; color:#1e293b; font-size:0.92rem; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
                        Eligibility Requirements
                    </div>
                    ${checksHtml}
                    ${claimedHtml}
                </div>
            </div>
            ${recentClaimsHtml}
        </div>`;
}

// Wire up the scanner UI (Verify tab)
document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startQrScanBtn');
    const stopBtn = document.getElementById('stopQrScanBtn');
    const manualBtn = document.getElementById('qrManualVerifyBtn');
    const manualInput = document.getElementById('qrManualInput');

    if (startBtn) startBtn.addEventListener('click', () => window.startQrScan());
    if (stopBtn) stopBtn.addEventListener('click', () => window.qrScannerStop(true));
    if (manualBtn) {
        manualBtn.addEventListener('click', () => window.verifyQrCode(manualInput ? manualInput.value : ''));
    }
    if (manualInput) {
        manualInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') window.verifyQrCode(manualInput.value);
        });
    }

    // Release the camera when the page is closed
    window.addEventListener('beforeunload', () => window.qrScannerStop(false));
});
// Main Archive tab renderer — live-updates with the users listener
function renderArchiveDashboard() {
    const listContainer = document.getElementById('archiveListContainer');
    if (!listContainer) return; // not on employee page

    const { archived } = getSeniorRecords();

    // Summary chips
    const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setTxt('archTotalCount', archived.length);
    setTxt('archInactiveCount', archived.filter(s => getSeniorStatus(s) === 'Inactive').length);
    setTxt('archDeceasedCount', archived.filter(s => getSeniorStatus(s) === 'Deceased').length);
    setTxt('archTransferredCount', archived.filter(s => ['Transferred', 'Archived'].includes(getSeniorStatus(s))).length);

    renderArchiveList();

    // Re-render cached integrity results (records changed after archive/delete actions)
    if (window._integrityResults) {
        renderIntegrityResults(window._integrityResults);
    }
}

// Renders the archived records list, honouring the search box
window.renderArchiveList = function() {
    const listContainer = document.getElementById('archiveListContainer');
    if (!listContainer) return;
    const { archived } = getSeniorRecords();
    const searchEl = document.getElementById('archiveSearchInput');
    const term = String((searchEl && searchEl.value) || '').trim().toLowerCase();

    const rows = archived
        .filter(s => !term ||
            String(s.name || '').toLowerCase().includes(term) ||
            String(s.seniorId || '').toLowerCase().includes(term) ||
            String(s.email || '').toLowerCase().includes(term) ||
            getSeniorStatus(s).toLowerCase().includes(term))
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    if (rows.length === 0) {
        listContainer.innerHTML = `
            <div style="text-align:center; color:#71717a; padding:36px 20px; border:1px dashed #d4d4d8; border-radius:8px; font-size:0.9rem;">
                ${archived.length === 0
                    ? 'No archived records — every senior citizen record is currently ACTIVE.'
                    : 'No archived records match your search.'}
            </div>`;
        return;
    }

    listContainer.innerHTML = rows.map(s => {
        const status = getSeniorStatus(s);
        const initial = (s.name || '?').charAt(0).toUpperCase();
        const archiveLine = s.archivedAt
            ? `Archived ${new Date(s.archivedAt).toLocaleDateString()}${s.archivedBy ? ' by ' + escHtml(s.archivedBy) : ''}`
            : '';
        const reason = s.archivedReason || (status !== 'Active' ? `Marked ${status}` : '');
        return `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:15px; flex-wrap:wrap; background:#fafafa; border:1px solid #e4e4e7; border-radius:12px; padding:16px 20px; margin-bottom:12px;">
            <div style="display:flex; align-items:center; gap:15px; flex:1; min-width:260px;">
                <div style="width:46px; height:46px; border-radius:50%; background:#fef3c7; color:#92400e; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:1.1rem; flex-shrink:0;">${escHtml(initial)}</div>
                <div>
                    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:2px;">
                        <h4 style="margin:0; color:#1e293b; font-size:1rem; font-weight:700;">${escHtml(s.name || 'Unnamed Record')}</h4>
                        ${archiveStatusBadgeHtml(status)}
                    </div>
                    <div style="font-size:0.83rem; color:#64748b;">
                        OSCA ID: ${escHtml(s.seniorId || 'N/A')} &bull; ${escHtml(s.email || 'No email')}
                    </div>
                    <div style="font-size:0.8rem; color:#94a3b8; margin-top:2px;">
                        ${reason ? escHtml(reason) : ''}${reason && archiveLine ? ' • ' : ''}${archiveLine}
                    </div>
                </div>
            </div>
            <div style="display:flex; gap:10px; flex-shrink:0;">
                <button onclick="restoreArchivedSenior('${s.uid}')"
                    style="background:#16a34a; color:white; border:none; padding:8px 18px; border-radius:8px; font-weight:700; font-size:0.82rem; cursor:pointer;">
                    <i class="fas fa-rotate-left" style="margin-right:5px;"></i>Restore to Active
                </button>
            </div>
        </div>`;
    }).join('');
};

// Prints the official list of ALL deceased senior citizens (Archive tab → Print).
// Table columns: ID No, Name, Barangay (taken from the senior's profile), Reason.
window.printDeceasedSeniors = function () {
    try {
        const { archived } = getSeniorRecords();
        const deceased = archived
            .filter(s => getSeniorStatus(s) === 'Deceased')
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

        if (deceased.length === 0) {
            scNotify('warning', 'No deceased senior citizen records to print.');
            return;
        }

        const w = window.open('', '_blank', 'width=1100,height=750');
        if (!w) {
            scNotify('warning', 'Please allow pop-ups to print the deceased seniors list.');
            return;
        }

        let html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>SilverCare — Deceased Senior Citizens</title>';
        html += '<style>body{font-family:Arial,sans-serif;color:#1e293b;padding:26px;}h1{font-size:19px;margin:0;}p.meta{color:#64748b;font-size:12px;}table{width:100%;border-collapse:collapse;margin-top:14px;font-size:11.5px;}th{background:#1e293b;color:#fff;padding:7px 8px;border:1px solid #1e293b;text-align:left;}td{padding:6px 8px;border:1px solid #cbd5e1;}@media print{tr{page-break-inside:avoid;}}</style>';
        html += '</head><body>';
        html += '<h1>SilverCare — OSCA Magalang · Deceased Senior Citizens</h1>';
        html += `<p class="meta">Generated: ${escHtml(new Date().toLocaleString())} · ${deceased.length} deceased record(s) · Source: Archived Senior Citizen Records</p>`;
        html += '<table><thead><tr><th>ID No</th><th>Name</th><th>Barangay</th><th>Reason</th></tr></thead><tbody>';
        deceased.forEach(s => {
            html += `<tr><td>${escHtml(s.seniorId || s.verificationSeniorId || 'N/A')}</td><td>${escHtml(s.name || 'Unnamed Record')}</td><td>${escHtml(s.barangay || 'N/A')}</td><td>Deceased</td></tr>`;
        });
        html += '</tbody></table></body></html>';
        w.document.write(html);
        w.document.close();
        w.focus();
        setTimeout(() => { try { w.print(); } catch (e) { /* user can print manually */ } }, 350);
        scNotify('success', `Printing the list of ${deceased.length} deceased senior citizen record(s).`);
    } catch (err) {
        console.error('Deceased seniors print error:', err);
        scNotify('error', 'Print failed. Please try again.');
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// ARCHIVE FUNCTION
// ─ Records marked Inactive / Deceased / Transferred are moved to the
//   Archive tab so ONLY ACTIVE seniors appear in the main dashboard and
//   processing lists.
// ─ Duplicate & fragmented records are detected via the integrity scan and
//   eliminated (archive merge or removal) — one clean record per senior.
// ═══════════════════════════════════════════════════════════════════════════

function getSeniorRecords() {
    const usersData = window.lastUsersData || {};
    const all = Object.entries(usersData)
        .filter(([, u]) => u && u.role === 'senior')
        .map(([uid, u]) => ({ uid, ...u }));
    return {
        all,
        active: all.filter(u => isActiveSenior(u)),
        archived: all.filter(u => isArchivedSenior(u))
    };
}

function archiveStatusBadgeHtml(status) {
    const styles = {
        'Inactive':    'background:#fef2f2; color:#991b1b; border:1px solid #fecaca;',
        'Deceased':    'background:#e2e8f0; color:#1e293b; border:1px solid #cbd5e1;',
        'Transferred': 'background:#fef3c7; color:#92400e; border:1px solid #fde68a;',
        'Archived':    'background:#fef3c7; color:#92400e; border:1px solid #fde68a;'
    };
    return `<span style="${styles[status] || 'background:#f1f5f9; color:#475569; border:1px solid #e2e8f0;'} padding:3px 12px; border-radius:12px; font-weight:700; font-size:0.75rem;">${escHtml(status)}</span>`;
}

// Best-effort mirror of archive status changes to the Supabase mirror
async function syncArchiveMirror(uid) {
    try {
        const token = await auth.currentUser.getIdToken();
        await fetch('/api/supabase/sync-senior', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ uid })
        });
    } catch (e) { /* mirror is optional — ignore failures */ }
}

// Restore an archived record back to the active roster
window.restoreArchivedSenior = function(uid) {
    const rec = getSeniorRecords().all.find(s => s.uid === uid) || {};
    const name = rec.name || 'this senior';
    confirmAction(
        `Restore ${name} to ACTIVE? The record will immediately reappear in the main dashboard and all processing lists.`,
        async () => {
            try {
                await update(ref(db, 'users/' + uid), {
                    lifeStatus: 'Active',
                    status: 'Active',
                    restoredAt: Date.now(),
                    restoredBy: window.currentStaffName || 'Staff',
                    // Clearing the Deceased pension stop (set by Manage Seniors →
                    // Deceased) keeps the record coherent once it is active again.
                    pensionSuspended: false,
                    pensionSuspendedAt: null,
                    pensionSuspendedReason: null
                });
                scNotify('success', `${name} has been restored to ACTIVE.`);
                syncArchiveMirror(uid);
            } catch (err) {
                console.error('Restore error:', err);
                scNotify('error', 'Failed to restore record: ' + err.message);
            }
        }
    );
};

// Move a record into the archive (duplicate merge, or fragmented cleanup).
// keeperUid is optional — when provided, the archive reason references the kept record.
window.archiveDuplicateRecord = function(uid, keeperUid) {
    const recs = getSeniorRecords().all;
    const rec = recs.find(s => s.uid === uid) || {};
    const keeper = keeperUid ? recs.find(s => s.uid === keeperUid) : null;
    const name = rec.name || 'this record';
    const message = keeper
        ? `Move ${name} to the archive as a DUPLICATE of ${keeper.name || 'the kept record'}? Archived records disappear from the main dashboard and processing lists but remain recoverable.`
        : `Move ${name} to the archive? Archived records disappear from the main dashboard and processing lists but remain recoverable.`;
    confirmAction(message, async () => {
        try {
            const updates = {
                lifeStatus: 'Archived',
                status: 'Archived',
                archivedAt: Date.now(),
                archivedBy: window.currentStaffName || 'Staff',
                archivedReason: keeper
                    ? `Duplicate record merged into ${keeper.name || 'kept record'}`
                    : 'Fragmented / incomplete record cleaned up'
            };
            if (keeper) updates.duplicateOf = keeper.uid;
            await update(ref(db, 'users/' + uid), updates);
            scNotify('success', `${name} was moved to the archive.`);
            syncArchiveMirror(uid);
        } catch (err) {
            console.error('Archive record error:', err);
            scNotify('error', 'Failed to archive record: ' + err.message);
        }
    });
};

// Permanently delete a fragmented record (only offered for non-verified records)
window.deleteFragmentedRecord = function(uid) {
    const rec = getSeniorRecords().all.find(s => s.uid === uid) || {};
    const name = rec.name || 'this record';
    confirmAction(
        `PERMANENTLY DELETE ${name}'s fragmented record? This cannot be undone from the dashboard (daily backups remain available for recovery).`,
        async () => {
            try {
                await remove(ref(db, 'users/' + uid));
                scNotify('success', `${name}'s fragmented record was permanently deleted.`);
            } catch (err) {
                console.error('Delete fragmented record error:', err);
                scNotify('error', 'Failed to delete record: ' + err.message);
            }
        }
    );
};

function renderIntegrityResults(results) {
    const container = document.getElementById('integrityResultsContainer');
    if (!container || !results) return;
    const { duplicateGroups, fragmented, scannedAt, scannedTotal } = results;

    const duplicateCount = duplicateGroups.reduce((n, g) => n + g.duplicates.filter(d => !isArchivedSenior(d)).length, 0);
    const fragmentedCount = fragmented.filter(f => !isArchivedSenior(f.record)).length;
    const issues = duplicateCount + fragmentedCount;

    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; background:${issues > 0 ? '#fef2f2' : '#f0fdf4'}; border:1px solid ${issues > 0 ? '#fecaca' : '#bbf7d0'}; border-radius:8px; padding:10px 14px; margin-bottom:14px; font-size:0.83rem;">
            <span style="font-weight:700; color:${issues > 0 ? '#991b1b' : '#166534'};">
                ${issues > 0 ? `${issues} record issue(s) need attention` : 'No unresolved duplicate or fragmented records'}
            </span>
            <span style="color:#64748b; flex-shrink:0;">${scannedTotal} record(s) scanned</span>
        </div>`;

    if (duplicateGroups.length > 0) {
        html += `<div style="font-weight:700; color:#1e293b; font-size:0.85rem; margin:10px 0 8px;"><i class="fas fa-clone" style="color:#b91c1c; margin-right:6px;"></i>Duplicate record groups</div>`;
        duplicateGroups.forEach(group => {
            html += `
            <div style="border:1px solid #e4e4e7; border-radius:8px; padding:12px 14px; margin-bottom:10px; background:#fafafa;">
                <div style="font-size:0.78rem; color:#92400e; font-weight:700; margin-bottom:8px;">Matched by ${escHtml(group.matchedBy)}</div>
                <div style="font-size:0.82rem; color:#166534; font-weight:600; margin-bottom:8px;">
                    <i class="fas fa-check-circle" style="margin-right:5px;"></i>Keep: ${escHtml(group.keeper.name || 'Unnamed')} (${escHtml(group.keeper.seniorId || 'No OSCA ID')})
                </div>
                ${group.duplicates.map(d => {
                    const alreadyArchived = isArchivedSenior(d);
                    return `
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; background:white; border:1px solid #e4e4e7; border-radius:8px; padding:8px 12px; margin-bottom:6px;">
                        <div style="font-size:0.82rem; color:#3f3f46; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                            <strong>${escHtml(d.name || 'Unnamed')}</strong> &bull; ${escHtml(d.seniorId || 'No OSCA ID')} ${archiveStatusBadgeHtml(getSeniorStatus(d))}
                        </div>
                        ${alreadyArchived
                            ? `<span style="font-size:0.75rem; color:#94a3b8; font-style:italic; flex-shrink:0;">Already archived</span>`
                            : `<button onclick="archiveDuplicateRecord('${d.uid}', '${group.keeper.uid}')" style="background:#fef3c7; color:#92400e; border:1px solid #fde68a; padding:6px 12px; border-radius:6px; font-weight:700; font-size:0.78rem; cursor:pointer; flex-shrink:0;">Archive duplicate</button>`}
                    </div>`;
                }).join('')}
            </div>`;
        });
    }

    if (fragmented.length > 0) {
        html += `<div style="font-weight:700; color:#1e293b; font-size:0.85rem; margin:14px 0 8px;"><i class="fas fa-file-circle-xmark" style="color:#b91c1c; margin-right:6px;"></i>Fragmented / incomplete records</div>`;
        fragmented.forEach(({ record, missing }) => {
            const canDelete = record.kycStatus !== 'Verified'; // verified records are never deletable — archive only
            html += `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; background:#fafafa; border:1px solid #e4e4e7; border-radius:8px; padding:8px 12px; margin-bottom:6px;">
                <div style="font-size:0.82rem; color:#3f3f46; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <strong>${escHtml(record.name || 'Unnamed record')}</strong>
                    <span style="color:#991b1b; font-weight:600;">— missing: ${missing.map(m => escHtml(m)).join(', ')}</span>
                    ${archiveStatusBadgeHtml(getSeniorStatus(record))}
                </div>
                <div style="display:flex; gap:6px; flex-shrink:0;">
                    ${!isArchivedSenior(record) ? `<button onclick="archiveDuplicateRecord('${record.uid}', '')" style="background:#fef3c7; color:#92400e; border:1px solid #fde68a; padding:6px 12px; border-radius:6px; font-weight:700; font-size:0.78rem; cursor:pointer;">Archive</button>` : ''}
                    ${canDelete ? `<button onclick="deleteFragmentedRecord('${record.uid}')" style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; padding:6px 12px; border-radius:6px; font-weight:700; font-size:0.78rem; cursor:pointer;">Delete</button>` : ''}
                </div>
            </div>`;
        });
    }

    container.innerHTML = html;
}

// ── Data integrity scan: duplicate + fragmented record detection ────────────
function normalizeNameKey(s) {
    return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

function findIntegrityIssues() {
    const { all } = getSeniorRecords();

    // Duplicates: same OSCA ID / same normalized name + birthdate / same email
    const buckets = new Map(); // key -> { matchedBy, records: [] }
    const addTo = (key, matchedBy, rec) => {
        if (!key) return;
        const k = matchedBy + '|' + key;
        if (!buckets.has(k)) buckets.set(k, { matchedBy, records: [] });
        buckets.get(k).records.push(rec);
    };
    all.forEach(r => {
        const sid = String(r.seniorId || '').trim().toUpperCase();
        if (sid) addTo(sid, 'OSCA Senior ID', r);
        const normName = normalizeNameKey(r.name);
        const dob = String(r.dob || '').trim();
        if (normName && dob) addTo(normName + '|' + dob, 'Name + Birthdate', r);
        const email = String(r.email || '').trim().toLowerCase();
        if (email) addTo(email, 'Email address', r);
    });

    const duplicateGroups = [];
    buckets.forEach(group => {
        if (group.records.length < 2) return;
        // Keep the oldest ACTIVE record; every other record is a duplicate
        const activeSorted = group.records.filter(r => isActiveSenior(r))
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.name || '').localeCompare(String(b.name || '')));
        const keeper = activeSorted[0] || group.records[0];
        const duplicates = group.records.filter(r => r.uid !== keeper.uid);
        duplicateGroups.push({ matchedBy: group.matchedBy, keeper, duplicates });
    });

    // Fragmented records: missing critical identity fields
    const fragmented = all.filter(r => {
        return !String(r.name || '').trim() ||
               !String(r.dob || '').trim() ||
               !String(r.seniorId || '').trim();
    }).map(r => {
        const missing = [];
        if (!String(r.name || '').trim()) missing.push('Name');
        if (!String(r.dob || '').trim()) missing.push('Birthdate');
        if (!String(r.seniorId || '').trim()) missing.push('OSCA Senior ID');
        return { record: r, missing };
    });

    return { duplicateGroups, fragmented, scannedAt: Date.now(), scannedTotal: all.length };
}

window.runIntegrityScan = function() {
    const container = document.getElementById('integrityResultsContainer');
    if (!container) return;
    container.innerHTML = `<div style="text-align:center; color:#64748b; padding:16px;"><i class="fas fa-spinner fa-spin" style="margin-right:8px;"></i>Scanning senior records...</div>`;
    // Let the spinner paint before the (synchronous) scan runs
    setTimeout(() => {
        window._integrityResults = findIntegrityIssues();
        renderIntegrityResults(window._integrityResults);
    }, 60);
};


// ── Automatic Daily Backup panel code removed ───────────────────────────────
// The backup status panel / manual backup buttons were removed from the
// Employee Archive tab. Server-side scheduled backups in server.js are
// unaffected and continue to run every 24 hours.

// ════════════════════════════════════════════════════════════════════════════
// MANAGE SENIOR ILLNESS (Health Records tab)
// Verified seniors upload a medical certification + describe their illness.
// Staff open the submission, VIEW the uploaded certification through a
// short-lived signed link, then SET the official health condition and the
// priority level (Low / Medium / High) based on the illness. The priority
// level is a HUMAN decision — the automatic suggestion is only a guide.
// ════════════════════════════════════════════════════════════════════════════

const HEALTH_PRIORITY_LEVELS = ['Low', 'Medium', 'High'];

// Keyword guides used ONLY to pre-fill a suggestion for staff review.
const HEALTH_CRITICAL_KEYWORDS = ['bedridden', 'stroke', 'heart disease', 'heart failure', 'cancer', 'dementia', 'alzheimer', 'paralyzed', 'paralysed', 'kidney failure', 'dialysis', 'critical', 'emphysema', 'copd'];
const HEALTH_CHRONIC_KEYWORDS = ['hypertension', 'diabetes', 'asthma', 'arthritis', 'chronic', 'tuberculosis', 'epilepsy', 'gout', 'thyroid', 'ulcer'];

function healthFormatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
}

function healthFormatDate(ts) {
    if (!ts) return '—';
    try {
        return new Date(ts).toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return new Date(ts).toLocaleDateString();
    }
}

function healthPriorityChip(level) {
    const map = {
        High: 'background:#fee2e2; color:#b91c1c; border:1px solid #fecaca;',
        Medium: 'background:#ffedd5; color:#c2410c; border:1px solid #fed7aa;',
        Low: 'background:#dcfce7; color:#15803d; border:1px solid #bbf7d0;'
    };
    const lvl = HEALTH_PRIORITY_LEVELS.includes(level) ? level : 'Low';
    return `<span style="font-size:0.7rem; padding:3px 10px; border-radius:12px; font-weight:700; ${map[lvl]}">${lvl}</span>`;
}

function healthStatusChip(status) {
    const s = status || 'Pending Review';
    const map = {
        'Pending Review': 'background:#e0f2fe; color:#0284c7;',
        'Reviewed': 'background:#dcfce7; color:#15803d;',
        'Rejected': 'background:#fee2e2; color:#b91c1c;'
    };
    return `<span style="font-size:0.7rem; padding:3px 10px; border-radius:12px; font-weight:700; ${map[s] || map['Pending Review']}">${escHtml(s)}</span>`;
}

/** Rule-based guide derived from the reported illness keywords (never auto-applied). */
function suggestPriorityFromIllness(text) {
    const t = String(text || '').toLowerCase();
    if (!t || /^none/.test(t) || /healthy/.test(t) || /no illness/.test(t)) return 'Low';
    if (HEALTH_CRITICAL_KEYWORDS.some(k => t.includes(k))) return 'High';
    if (HEALTH_CHRONIC_KEYWORDS.some(k => t.includes(k))) return 'Medium';
    return 'Medium';
}

/** Flattens every health report of every senior into one reviewable list. */
function collectHealthSubmissions() {
    const users = window.lastUsersData || {};
    const rows = [];
    for (const [uid, u] of Object.entries(users)) {
        if (!u || u.role !== 'senior') continue;
        const isVerified = u.kycStatus === 'Verified' || !!u.kycVerifiedAt;
        const reports = u.healthReports || {};
        const activePriority = String(u.staffPriorityLevel || '').trim() ||
            (typeof calculatePriorityLevel === 'function' ? calculatePriorityLevel(u) : 'Low');
        for (const [reportId, r] of Object.entries(reports)) {
            if (!r) continue;
            rows.push({
                reportId: reportId,
                uid: uid,
                seniorName: r.name || u.name || 'Senior Citizen',
                seniorId: r.seniorId || u.seniorId || 'N/A',
                age: u.age || null,
                kycVerified: isVerified,
                illness: r.illness || 'Not specified',
                description: r.description || '',
                hasCertification: !!r.hasCertification,
                fileName: r.fileName || null,
                mimeType: r.mimeType || null,
                size: r.size || null,
                status: r.status || 'Pending Review',
                submittedAt: r.submittedAt || 0,
                reviewedIllness: r.reviewedIllness || null,
                priorityLevel: r.priorityLevel || null,
                reviewNotes: r.reviewNotes || null,
                reviewedByName: r.reviewedByName || null,
                reviewedAt: r.reviewedAt || null,
                seniorPriority: activePriority,
                // Single effective band for sorting/grouping: staff decision →
                // else the same approved illness + age rule (never guessed).
                effectivePriority: activePriority,
                // The identity-verification certification can be re-opened by
                // staff while a copy (inline or stored) is still available.
                kycMedCertAvailable: !!(u.kycMedCertImage || u.kycMedCertPath)
            });
        }
    }
    return rows;
}

/** Active filter chip of the "Senior Illness & Priority Management" section. */
let healthMgmtFilter = 'all';

/** Switches the filter chip of the illness-management section. */
window.setHealthMgmtFilter = function (filter, el) {
    healthMgmtFilter = filter || 'all';
    document.querySelectorAll('.health-filter-chip').forEach(chip => {
        const on = chip === el;
        chip.classList.toggle('active', on);
        chip.style.background = on ? '#2563eb' : '#ffffff';
        chip.style.color = on ? '#ffffff' : '#334155';
        chip.style.borderColor = on ? '#2563eb' : '#cbd5e1';
    });
    window.renderHealthRequests();
};

/**
 * Renders the "Senior Illness & Priority Management" list inside the
 * Health Records tab. The section lists her/his uploaded medical certification,
 * the illness reported, and the priority level set by staff.
 * Requirement: VERIFIED senior accounts only.
 */
window.renderHealthRequests = function () {
    const container = document.getElementById('seniorHealthListContainer');
    if (!container) return;

    // One-time wiring of the filter chips + live search (elements exist by now).
    if (!window.__healthMgmtWired) {
        window.__healthMgmtWired = true;
        document.querySelectorAll('.health-filter-chip').forEach(chip => {
            chip.addEventListener('click', () => window.setHealthMgmtFilter(chip.dataset.healthFilter || 'all', chip));
        });
        const searchEl = document.getElementById('healthSearchInput');
        if (searchEl) searchEl.addEventListener('input', () => window.renderHealthRequests());
        const firstChip = document.querySelector('.health-filter-chip.active');
        if (firstChip) window.setHealthMgmtFilter(firstChip.dataset.healthFilter || 'all', firstChip);
    }

    const pendingBadge = document.getElementById('healthCertPendingBadge');
    const searchEl = document.getElementById('healthSearchInput');
    const q = (searchEl ? searchEl.value : '').trim().toLowerCase();
    const filter = healthMgmtFilter;

    // Only verified senior accounts are managed in this section.
    let rows = collectHealthSubmissions().filter(r => r.kycVerified);

    const totalPending = rows.filter(r => r.status === 'Pending Review').length;
    if (pendingBadge) {
        pendingBadge.textContent = `${totalPending} certification(s) awaiting review`;
        pendingBadge.style.display = totalPending > 0 ? 'inline-block' : 'none';
    }

    if (filter === 'pending') rows = rows.filter(r => r.status === 'Pending Review');
    else if (filter === 'illness') rows = rows.filter(r => r.illness && !/^none/i.test(String(r.illness)));
    else if (filter === 'high') rows = rows.filter(r => (r.effectivePriority || r.priorityLevel || r.seniorPriority) === 'High');

    if (q) {
        rows = rows.filter(r =>
            String(r.seniorName).toLowerCase().includes(q) ||
            String(r.seniorId).toLowerCase().includes(q) ||
            String(r.illness).toLowerCase().includes(q)
        );
    }

    // Manageable + categorized: High priority seniors first so their requested
    // appointments and records are seen fastest, then Medium, then Low —
    // Pending Review still floats above decided items inside each band.
    rows.sort((a, b) => {
        const ra = priorityRank(a.effectivePriority || 'Low');
        const rb = priorityRank(b.effectivePriority || 'Low');
        if (ra !== rb) return ra - rb;
        const pa = a.status === 'Pending Review' ? 0 : 1;
        const pb = b.status === 'Pending Review' ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return (b.submittedAt || 0) - (a.submittedAt || 0);
    });

    if (!rows.length) {
        const msg = filter === 'pending'
            ? 'No medical certification is waiting for review right now.'
            : 'No senior health submissions match the current search or filter.';
        container.innerHTML = `<div style="text-align: center; color: #71717a; padding: 30px; font-size: 0.9rem;">${msg}</div>`;
        return;
    }

    // Group headers keep the long list scannable: one labeled band per
    // priority in High → Medium → Low order (bands use only real data).
    let _lastHealthBand = '';
    let html = '';
    const _bandStyle = (band) => band === 'High'
        ? 'background:#fef2f2; border:1px solid #fecaca; color:#b91c1c;'
        : (band === 'Medium'
            ? 'background:#fffbeb; border:1px solid #fde68a; color:#92400e;'
            : 'background:#f8fafc; border:1px solid #e2e8f0; color:#475569;');
    for (const r of rows) {
        const band = r.effectivePriority || 'Low';
        if (band !== _lastHealthBand) {
            _lastHealthBand = band;
            html += `<div style="font-size:0.8rem; font-weight:800; letter-spacing:0.02em; padding:8px 14px; border-radius:8px; ${_bandStyle(band)}">${escHtml(band)} Priority Seniors</div>`;
        }
        html += buildHealthRequestCard(r);
    }
    container.innerHTML = html;
};
/** One illness-submission card (rendered inside renderHealthRequests). */
function buildHealthRequestCard(r) {
    const isPending = r.status === 'Pending Review';
    // High-priority accounts stay visually highlighted in the records list.
    const band = r.effectivePriority || r.priorityLevel || r.seniorPriority || 'Low';
    const accent = band === 'High' && isPending ? '#dc2626' : (isPending ? '#0ea5e9' : (r.status === 'Reviewed' ? '#16a34a' : '#ef4444'));
    const priorityForDisplay = band;
    const verifyChip = r.kycVerified
        ? '<span style="font-size: 0.68rem; font-weight: 700; color: #166534; background: #dcfce7; border: 1px solid #bbf7d0; padding: 2px 8px; border-radius: 10px;">VERIFIED</span>'
        : '<span style="font-size: 0.68rem; font-weight: 700; color: #b91c1c; background: #fee2e2; border: 1px solid #fecaca; padding: 2px 8px; border-radius: 10px;">NOT VERIFIED</span>';
    const certLine = r.hasCertification
        ? `<span style="font-weight: 600; color: #334155; word-break: break-all;">${escHtml(r.fileName || 'Medical certification')}</span>${r.size ? ` <span style="color: #94a3b8;">(${healthFormatBytes(r.size)})</span>` : ''}`
        : '<span style="color: #b45309; font-weight: 600;">No certification attached</span>';
    const tailNote = r.status === 'Reviewed'
        ? `<span style="margin-left: auto; font-size: 0.74rem; color: #15803d;"><i class="fas fa-check-circle" style="margin-right: 4px;"></i>${escHtml(r.priorityLevel || '')} priority${r.reviewedByName ? ' by ' + escHtml(r.reviewedByName) : ''}</span>`
        : (r.status === 'Rejected' && r.reviewNotes
            ? `<span style="margin-left: auto; font-size: 0.74rem; color: #b91c1c;">${escHtml(r.reviewNotes)}</span>`
            : '');
    // Re-open the KYC medical certification (durable stored copy) even after
    // the senior has already been verified — available while it exists.
    const kycCertBtn = (r.kycMedCertAvailable)
        ? `<button type="button" onclick="window.openKycMedCert('${escapeHtmlAttr(r.uid)}')"
            style="border: 1px solid #0ea5e9; background: #f0f9ff; color: #0369a1; font-size: 0.72rem; font-weight: 700; padding: 5px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;"
            title="Re-open the medical certification submitted during identity verification">
            <i class="fas fa-folder-open" style="margin-right: 5px;"></i>View KYC Medical Certification
        </button>`
        : '';

    return `
    <div style="border: 1px solid ${band === 'High' && isPending ? '#fca5a5' : (isPending ? '#bae6fd' : '#e2e8f0')}; border-left: 4px solid ${accent}; border-radius: 8px; padding: 16px 18px; background: ${band === 'High' && isPending ? '#fff7f7' : (isPending ? '#f8fcff' : 'white')};">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap;">
            <div style="min-width: 0;">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                    <strong style="font-size: 0.95rem; color: #1e293b;">${escHtml(r.seniorName)}</strong>
                    ${verifyChip}
                    ${healthStatusChip(r.status)}
                    ${healthPriorityChip(priorityForDisplay)}
                </div>
                <div style="font-size: 0.78rem; color: #64748b; margin-top: 5px;">
                    OSCA ID: <strong>${escHtml(r.seniorId)}</strong>${r.age ? ` &middot; Age ${escHtml(String(r.age))}` : ''} &middot; Submitted ${healthFormatDate(r.submittedAt)}
                </div>
            </div>
            <button type="button" onclick="window.openHealthReview('${escapeHtmlAttr(r.uid)}','${escapeHtmlAttr(r.reportId)}')"
                style="border: 1px solid #2563eb; background: ${isPending ? '#2563eb' : '#eff6ff'}; color: ${isPending ? 'white' : '#1d4ed8'}; font-size: 0.8rem; font-weight: 700; padding: 9px 16px; border-radius: 8px; cursor: pointer; white-space: nowrap;">
                <i class="fas fa-clipboard-check" style="margin-right: 6px;"></i>${isPending ? 'Review &amp; Set Priority' : 'Open Record'}
            </button>
        </div>

        <div style="margin-top: 12px; background: white; border: 1px solid #f1f5f9; border-radius: 6px; padding: 12px 14px;">
            <div style="font-size: 0.82rem; color: #334155; line-height: 1.55;">
                <span style="color: #64748b; font-weight: 600;">Illness reported:</span> <strong>${escHtml(r.illness)}</strong>
                ${r.description ? `<div style="margin-top: 5px; color: #475569;">${escHtml(r.description)}</div>` : ''}
            </div>
            <div style="margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 0.78rem; color: #64748b;">
                <i class="fas fa-file-medical" style="color: #0ea5e9;"></i>
                ${certLine}
                ${kycCertBtn}
                ${tailNote}
            </div>
        </div>
    </div>`;
}

// ════════════════════════════════════════════════════════════════════════════
// STAFF REVIEW MODAL — view the uploaded certification, then SET the official
// health condition + priority level (Low / Medium / High) of the senior.
// The priority level is always a HUMAN decision; the keyword suggestion shown
// in the modal is only a guide for the reviewing employee.
// ════════════════════════════════════════════════════════════════════════════
let currentHealthReview = null;   // { uid, reportId, report, senior }
let currentHealthCertLink = null; // short-lived signed URL of the certification

function healthNotice(kind, message) {
    const box = document.getElementById('healthReviewNotice');
    if (!box) return;
    const styles = {
        success: 'background:#f0fdf4; border:1px solid #bbf7d0; color:#166534;',
        error: 'background:#fef2f2; border:1px solid #fecaca; color:#991b1b;',
        info: 'background:#f0f9ff; border:1px solid #bae6fd; color:#075985;'
    };
    box.style.cssText = `display:block; margin-top:14px; border-radius:8px; padding:11px 14px; font-size:0.82rem; line-height:1.5; ${styles[kind] || styles.info}`;
    box.innerHTML = message;
}

function clearHealthNotice() {
    const box = document.getElementById('healthReviewNotice');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}

/** Visual state of the three priority cards (radio buttons stay native). */
function paintPriorityOptions() {
    document.querySelectorAll('.health-priority-opt').forEach(el => {
        const radio = el.querySelector('input[type="radio"]');
        const on = !!(radio && radio.checked);
        el.style.borderColor = on ? '#2563eb' : '#cbd5e1';
        el.style.boxShadow = on ? '0 0 0 3px rgba(37,99,235,0.12)' : 'none';
        el.style.background = on ? '#f8fbff' : '#ffffff';
    });
}

// Delegated listener so the cards highlight no matter how they are clicked.
document.addEventListener('change', (e) => {
    if (e.target && e.target.name === 'healthPriorityRadio') paintPriorityOptions();
});

function selectedHealthPriority() {
    const checked = document.querySelector('input[name="healthPriorityRadio"]:checked');
    return checked ? checked.value : '';
}

/**
 * Loads the uploaded medical certification through the backend. The file lives
 * in a PRIVATE bucket, so the browser only ever receives a 5-minute signed URL.
 */
async function loadHealthCertificationPreview() {
    const wrap = document.getElementById('healthReviewCertWrap');
    const note = document.getElementById('healthReviewLinkNote');
    if (!wrap || !currentHealthReview) return;

    currentHealthCertLink = null;
    wrap.innerHTML = `<div style="text-align: center; color: #64748b; font-size: 0.85rem; padding: 24px;">
        <i class="fas fa-spinner fa-spin" style="font-size: 1.5rem; display: block; margin-bottom: 10px;"></i>
        Opening the protected certification...
    </div>`;
    if (note) note.textContent = '';

    try {
        const token = await getStaffIdToken();
        const { uid, reportId } = currentHealthReview;
        const res = await fetch(`/api/health-report/view/${encodeURIComponent(uid)}/${encodeURIComponent(reportId)}`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error((data && data.message) || 'The certification could not be opened.');

        currentHealthCertLink = data.signedUrl;
        const mime = (currentHealthReview.report.mimeType || '').toLowerCase();

        if (mime.startsWith('image/')) {
            wrap.innerHTML = `<img src="${escapeHtmlAttr(data.signedUrl)}" alt="Uploaded medical certification"
                style="max-width: 100%; max-height: 420px; border-radius: 6px; object-fit: contain;">`;
        } else if (mime === 'application/pdf') {
            wrap.innerHTML = `<iframe src="${escapeHtmlAttr(data.signedUrl)}" title="Medical certification PDF"
                style="width: 100%; height: 420px; border: none; border-radius: 6px;"></iframe>`;
        } else {
            wrap.innerHTML = `<div style="text-align: center; color: #475569; font-size: 0.85rem; padding: 24px;">
                <i class="fas fa-file-medical" style="font-size: 1.8rem; display: block; margin-bottom: 10px; color: #0ea5e9;"></i>
                Preview is not available for this file type.<br>Use “Open Full Certification” below.
            </div>`;
        }
        if (note) note.textContent = `Secure link valid for ${Math.round((data.expiresIn || 300) / 60)} minute(s).`;
    } catch (err) {
        console.error('Load certification error:', err);
        wrap.innerHTML = `<div style="text-align: center; color: #b91c1c; font-size: 0.85rem; padding: 24px;">
            <i class="fas fa-triangle-exclamation" style="font-size: 1.5rem; display: block; margin-bottom: 10px;"></i>
            ${escHtml(err.message)}
        </div>`;
    }
}

/** Opens the certified file in a new browser tab (fresh short-lived link). */
window.openHealthCertification = async function () {
    if (currentHealthCertLink) {
        window.open(currentHealthCertLink, '_blank', 'noopener');
        return;
    }
    if (!currentHealthReview || !currentHealthReview.report.hasCertification) {
        scNotify('warning', 'This health update has no stored medical certification.');
        return;
    }
    try {
        const token = await getStaffIdToken();
        const { uid, reportId } = currentHealthReview;
        const res = await fetch(`/api/health-report/view/${encodeURIComponent(uid)}/${encodeURIComponent(reportId)}`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error((data && data.message) || 'The certification could not be opened.');
        currentHealthCertLink = data.signedUrl;
        window.open(data.signedUrl, '_blank', 'noopener');
    } catch (err) {
        console.error('Open certification error:', err);
        scNotify('error', err.message);
    }
};

// ── Health Report Review Modal handlers ─────────────────────────────────────
/** Summary panel: what the senior reported + the current official record. */
function renderHealthReviewReportBox(senior, report) {
    const box = document.getElementById('healthReviewReportBox');
    if (!box) return;
    const currentPriority = String((senior && senior.staffPriorityLevel) || '').trim() ||
        (typeof calculatePriorityLevel === 'function' ? calculatePriorityLevel(senior || {}) : 'Low');
    box.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center;">
            <span style="font-weight:700; color:#1e293b;">Reported illness</span>
            ${healthStatusChip(report.status)}
        </div>
        <div style="margin-top:6px;"><strong>${escHtml(report.illness || 'Not specified')}</strong></div>
        ${report.description ? `<div style="margin-top:6px; color:#475569;">${escHtml(report.description)}</div>` : ''}
        <div style="margin-top:10px; padding-top:10px; border-top:1px dashed #e2e8f0; font-size:0.8rem; color:#475569;">
            <div><span style="color:#64748b; font-weight:600;">Submitted:</span> ${healthFormatDate(report.submittedAt)}</div>
            <div style="margin-top:4px;"><span style="color:#64748b; font-weight:600;">Current official condition:</span> ${escHtml((senior && (senior.healthCondition || senior.condition)) || 'None reported')}</div>
            <div style="margin-top:6px; display:flex; align-items:center; gap:8px;">
                <span style="color:#64748b; font-weight:600;">Current priority level:</span> ${healthPriorityChip(currentPriority)}
            </div>
        </div>`;
}

/** Opens the review modal for one senior health submission. */
window.openHealthReview = async function (uid, reportId) {
    const senior = (window.lastUsersData || {})[uid] || {};
    const report = ((senior.healthReports || {})[reportId]) || null;
    if (!report) {
        scNotify('error', 'This health update could not be found.');
        return;
    }
    currentHealthReview = { uid: uid, reportId: reportId, report: report, senior: senior };

    const modal = document.getElementById('healthReviewModal');
    if (!modal) return;
    modal.style.display = 'flex';
    clearHealthNotice();

    const nameEl = document.getElementById('healthReviewSeniorName');
    const metaEl = document.getElementById('healthReviewSeniorMeta');
    if (nameEl) nameEl.textContent = report.name || senior.name || 'Senior Citizen';
    if (metaEl) {
        const bits = [];
        bits.push('OSCA ID: ' + ((report.seniorId || senior.seniorId) || 'N/A'));
        if (senior.age) bits.push('Age ' + senior.age);
        if (senior.email) bits.push(senior.email);
        bits.push(report.status || 'Pending Review');
        metaEl.textContent = bits.join('  ·  ');
    }

    renderHealthReviewReportBox(senior, report);

    // Pre-fill the assessment with what the senior reported. Every field stays
    // editable — the final health record is the staff member's decision.
    const conditionEl = document.getElementById('healthReviewCondition');
    const detailsEl = document.getElementById('healthReviewDetails');
    const notesEl = document.getElementById('healthReviewNotes');
    if (conditionEl) conditionEl.value = report.illness || senior.healthCondition || senior.condition || '';
    if (detailsEl) detailsEl.value = report.description || senior.illnessDetails || '';
    if (notesEl) notesEl.value = '';

    // Already-decided records are read-only: no re-submission of the review.
    const isPending = (report.status || 'Pending Review') === 'Pending Review';
    const saveBtn = document.getElementById('healthReviewSaveBtn');
    const rejectBtn = document.getElementById('healthReviewRejectBtn');
    if (saveBtn) saveBtn.style.display = isPending ? '' : 'none';
    if (rejectBtn) rejectBtn.style.display = isPending ? '' : 'none';

    // Suggested priority level — a guide only; staff may override it.
    applyHealthPrioritySuggestion(conditionEl ? conditionEl.value : '');

    // Reset the radio group and pre-select the senior's current priority level.
    document.querySelectorAll('input[name="healthPriorityRadio"]').forEach(r => { r.checked = false; });
    const preset = String(report.priorityLevel || senior.staffPriorityLevel || '').trim();
    if (HEALTH_PRIORITY_LEVELS.includes(preset)) {
        const presetRadio = document.querySelector(`input[name="healthPriorityRadio"][value="${preset}"]`);
        if (presetRadio) presetRadio.checked = true;
    }
    paintPriorityOptions();

    // The certificate lives in a PRIVATE bucket, so only a short-lived signed
    // URL is ever fetched for the reviewing employee.
    currentHealthCertLink = null;
    if (report.hasCertification) {
        await loadHealthCertificationPreview();
    } else {
        const wrap = document.getElementById('healthReviewCertWrap');
        const note = document.getElementById('healthReviewLinkNote');
        if (wrap) {
            wrap.innerHTML = `<div style="text-align: center; color: #b45309; font-size: 0.85rem; padding: 24px;">
                <i class="fas fa-file-circle-xmark" style="font-size: 1.6rem; display: block; margin-bottom: 10px;"></i>
                This health update has no attached medical certification.
            </div>`;
        }
        if (note) note.textContent = '';
    }
};

/**
 * Refreshes the priority guide shown inside the review modal. The employee is
 * always free to override the suggestion before saving.
 */
function applyHealthPrioritySuggestion(text) {
    const box = document.getElementById('healthPrioritySuggestion');
    if (!box) return;
    const guess = suggestPriorityFromIllness(text);
    const effective = HEALTH_PRIORITY_LEVELS.includes(guess) ? guess : 'Medium';
    const tone = {
        High: 'background:#fef2f2; border:1px solid #fecaca; color:#991b1b;',
        Medium: 'background:#fff7ed; border:1px solid #fed7aa; color:#9a3412;',
        Low: 'background:#f0fdf4; border:1px solid #bbf7d0; color:#166534;'
    };
    box.style.cssText = `border-radius:8px; padding:11px 14px; margin-bottom:14px; font-size:0.8rem; line-height:1.55; ${tone[effective]}`;
    box.innerHTML = `<i class="fas fa-lightbulb" style="margin-right:7px;"></i>
        Based on the reported illness, the suggested priority level is <strong>${effective}</strong>.
        ${effective === 'High' ? 'Please verify the certification carefully &mdash; the illness appears serious or urgent.'
            : effective === 'Medium' ? 'This illness usually needs regular monitoring or ongoing medication.'
            : 'This appears to be a mild or well-controlled condition.'}
        This is only a guide &mdash; set the final level yourself.`;
}

// Live guide update: retype the condition and the suggestion follows.
document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'healthReviewCondition') applyHealthPrioritySuggestion(e.target.value);
});

/** Closes the review modal and clears the sensitive preview + state. */
window.closeHealthReviewModal = function () {
    const modal = document.getElementById('healthReviewModal');
    if (modal) modal.style.display = 'none';
    const wrap = document.getElementById('healthReviewCertWrap');
    if (wrap) wrap.innerHTML = '<div style="text-align: center; color: #64748b; font-size: 0.85rem; padding: 24px;">Select a senior health record to view the uploaded medical certification here.</div>';
    const note = document.getElementById('healthReviewLinkNote');
    if (note) note.textContent = '';
    currentHealthReview = null;
    currentHealthCertLink = null;
    clearHealthNotice();
};

/**
 * Saves the staff decision for one senior health update.
 *   decision = 'Reviewed' -> the certification is accepted, and the entered
 *                           health condition + priority level become official.
 *   decision = 'Rejected' -> the certification is discarded and the senior is notified.
 * The backend (POST /api/health-report/:uid/:reportId/review) moves the file
 * between the private vault folders, writes the official record to Firebase,
 * and notifies the senior. The priority level is ALWAYS the staff decision.
 */
window.submitHealthReview = async function (decision) {
    if (!currentHealthReview) { scNotify('error', 'No health update is selected.'); return; }
    const { uid, reportId, report, senior } = currentHealthReview;
    const seniorLabel = report.name || senior.name || 'this senior';

    const conditionEl = document.getElementById('healthReviewCondition');
    const detailsEl = document.getElementById('healthReviewDetails');
    const notesEl = document.getElementById('healthReviewNotes');
    const condition = (conditionEl ? conditionEl.value : '').trim();
    const details = (detailsEl ? detailsEl.value : '').trim();
    const notes = (notesEl ? notesEl.value : '').trim();
    const priority = decision === 'Reviewed' ? selectedHealthPriority() : '';

    if (decision === 'Reviewed') {
        if (!priority) {
            healthNotice('error', '<strong>Please select a priority level</strong> (Low, Medium or High) before saving.');
            return;
        }
        if (condition.length < 2) {
            healthNotice('error', '<strong>Please enter the official health condition / illness</strong> of the senior before saving.');
            return;
        }
    }

    const confirmText = decision === 'Reviewed'
        ? `Accept this medical certification, set "${condition}" as the official health condition and "${priority}" as the priority level of ${seniorLabel}?`
        : `Reject the medical certification of ${seniorLabel}? The uploaded file will be discarded and the senior will be asked to submit a clearer one.`;
    if (!window.confirm(confirmText)) return;

    const saveBtn = document.getElementById('healthReviewSaveBtn');
    const rejectBtn = document.getElementById('healthReviewRejectBtn');
    const originalSave = saveBtn ? saveBtn.innerHTML : '';
    const originalReject = rejectBtn ? rejectBtn.innerHTML : '';
    if (saveBtn) {
        saveBtn.disabled = true;
        if (decision === 'Reviewed') saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i>Saving...';
    }
    if (rejectBtn) {
        rejectBtn.disabled = true;
        if (decision === 'Rejected') rejectBtn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i>Rejecting...';
    }
    clearHealthNotice();

    try {
        const token = await getStaffIdToken();
        const res = await fetch(`/api/health-report/${encodeURIComponent(uid)}/${encodeURIComponent(reportId)}/review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({
                decision: decision,
                healthCondition: condition,
                illnessDetails: details,
                priorityLevel: priority,
                notes: notes
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error((data && data.message) || 'The review could not be saved.');

        scNotify('success', data.message || (decision === 'Reviewed'
            ? 'Health record updated and priority level set. The senior has been notified.'
            : 'Medical certification rejected. The senior has been notified.'));

        window.closeHealthReviewModal();
    } catch (err) {
        console.error('submitHealthReview error:', err);
        healthNotice('error', `<strong>Could not save the review:</strong> ${escHtml(err.message)}`);
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = originalSave; }
        if (rejectBtn) { rejectBtn.disabled = false; rejectBtn.innerHTML = originalReject; }
    }
};
