require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const idVault = require('./lib/supabaseStorage');
const medicalVault = require('./lib/medicalVault');
const seniorStore = require('./lib/supabaseDatabase');
const priorityEngine = require('./public/js/priority-engine');

// Initialize Firebase Admin
const fs = require('fs');
let serviceAccount;
if (fs.existsSync('./serviceAccountKey.json')) {
    serviceAccount = require('./serviceAccountKey.json');
} else if (process.env.SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
    console.error('No service account credentials found. Set SERVICE_ACCOUNT_JSON env var or place serviceAccountKey.json.');
    process.exit(1);
}
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
});

// Auto-sync security rules to Firebase Realtime Database on startup
if (fs.existsSync('./database.rules.json')) {
    try {
        const rulesStr = fs.readFileSync('./database.rules.json', 'utf8');
        admin.database().setRules(rulesStr)
            .then(() => console.log('Firebase Database Security Rules synced successfully.'))
            .catch(err => console.error('Failed to sync Firebase security rules:', err.message));
    } catch (e) {
        console.error('Error reading database.rules.json:', e.message);
    }
}

const app = express();
app.set('trust proxy', 1); // Railway terminates TLS at its proxy — needed for correct req.protocol/host
const PORT = process.env.PORT || 3000;

// --- Healthcheck endpoint for Railway (no auth) ---
app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'silvercare', time: new Date().toISOString() });
});

// --- E-mail provider status (no auth, no secrets) ---
// Open https://YOUR-APP.up.railway.app/api/email-status in a browser to
// instantly see which e-mail provider is active and which keys are set.
app.get('/api/email-status', (req, res) => {
    res.json(emailStatusPayload());
});

// --- SMS provider status (no auth, no secrets) ---
// Same idea for text messages: open /api/sms-status in a browser to see
// whether the TextBee gateway is armed. The API key is never returned.
app.get('/api/sms-status', (req, res) => {
    res.json(smsStatusPayload());
});

// --- Disable caching for HTML responses to prevent BFCache security issues ---
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

// --- CORS: same-origin app + configured deployment domains ---
// Railway automatically injects RAILWAY_PUBLIC_DOMAIN for the service.
// PUBLIC_BASE_URL / ALLOWED_ORIGINS (comma-separated) cover custom domains.
// NOTE: localhost entries are ONLY added outside production so no deployed
// feature can ever depend on or leak a localhost origin.
const allowedOrigins = new Set();
if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.add(`http://localhost:${PORT}`);
    allowedOrigins.add(`http://127.0.0.1:${PORT}`);
}
if (process.env.PUBLIC_BASE_URL) {
    allowedOrigins.add(String(process.env.PUBLIC_BASE_URL).trim().replace(/\/+$/, ''));
}
if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    allowedOrigins.add(`https://${String(process.env.RAILWAY_PUBLIC_DOMAIN).trim()}`);
}
if (process.env.ALLOWED_ORIGINS) {
    String(process.env.ALLOWED_ORIGINS).split(',').forEach(o => {
        const v = o.trim().replace(/\/+$/, '');
        if (v) allowedOrigins.add(v);
    });
}
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (same-origin, Postman, server-to-server)
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        callback(new Error('Not allowed by CORS: ' + origin));
    }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Express 5 safety net: req.body is undefined (not {}) when a request has no
// JSON/urlencoded payload. Several public endpoints destructure req.body BEFORE
// their try/catch (e.g. /api/forgot-password), which would crash with a 500.
// This middleware guarantees req.body is always at least an empty object.
app.use((req, res, next) => {
    if (req.body === undefined || req.body === null) req.body = {};
    next();
});

// --- Serve Firebase Config dynamically BEFORE static files ---
// This route takes precedence over the hardcoded public/js/firebase-config.js
app.get('/js/firebase-config.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`export const firebaseConfig = {
    apiKey: "${process.env.FIREBASE_API_KEY}",
    authDomain: "${process.env.FIREBASE_AUTH_DOMAIN}",
    projectId: "${process.env.FIREBASE_PROJECT_ID}",
    storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET}",
    messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID}",
    appId: "${process.env.FIREBASE_APP_ID}",
    measurementId: "${process.env.FIREBASE_MEASUREMENT_ID}",
    databaseURL: "${process.env.FIREBASE_DATABASE_URL}"
};`);
});

app.use(express.static(path.join(__dirname, 'public'), {
    // HTML + JS must always revalidate so frontend fixes are picked up
    // immediately (no stale-cache surprises like an old KYC validator).
    etag: true,
    setHeaders: (res, filePath) => {
        if (/\.(html|js|mjs|css)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
    }
}));

// --- OTP In-Memory Store ---
const otpStore = new Map(); // email -> { pin, expiresAt }
const otpAttempts = new Map(); // email -> { count, lockedUntil }

// --- Reactivation start rate limiting (prevents OSCA ID enumeration) ---
const REACTIVATION_START_WINDOW_MS = 10 * 60 * 1000;
const REACTIVATION_START_MAX = 15;
const reactivationStartHits = new Map(); // ip -> { count, resetAt }

function reactivationStartRateLimited(ip) {
    const now = Date.now();
    const rec = reactivationStartHits.get(ip);
    if (!rec || now > rec.resetAt) {
        reactivationStartHits.set(ip, { count: 1, resetAt: now + REACTIVATION_START_WINDOW_MS });
        return false;
    }
    rec.count += 1;
    return rec.count > REACTIVATION_START_MAX;
}

// --- E-mail delivery (SMTP locally, HTTPS API on Railway) ---
// Railway blocks outbound SMTP (ports 25/465/587) on Free/Trial/Hobby
// plans — Gmail via nodemailer will ALWAYS time out there, no matter how
// correct EMAIL_USER/EMAIL_PASS are. The fix is an HTTPS email API
// (Brevo or Resend), which uses port 443 and works on every Railway plan.
// Priority: BREVO_API_KEY (recommended, free 300/day, Gmail sender OK) >
// RESEND_API_KEY > Gmail SMTP fallback (local dev / Railway Pro only).
const EMAIL_PROVIDER = process.env.BREVO_API_KEY ? 'brevo'
    : (process.env.RESEND_API_KEY ? 'resend' : 'smtp');
console.log(`E-mail provider: ${EMAIL_PROVIDER}`);

// --- Nodemailer Transporter (SMTP fallback: local dev / Railway Pro) ---
// Timeouts added so email hangs can never leave a frontend fetch pending
// forever (e.g. stuck "Sending Code..." button).
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    connectionTimeout: 15000, // 15s to establish the SMTP connection
    greetingTimeout: 10000,   // 10s for the SMTP greeting
    socketTimeout: 20000      // 20s of inactivity = give up
});

// Verify the SMTP connection at startup ONLY when SMTP is the active
// provider. On Railway free plans the verify would always fail (blocked
// ports) and only add noise — the HTTPS API needs no verification.
if (EMAIL_PROVIDER === 'smtp') {
    transporter.verify()
        .then(() => console.log('SMTP transporter verified — e-mails can be sent.'))
        .catch(err => console.error('SMTP transporter verification FAILED (OTP/reset e-mails will fail):', err.message));
} else {
    console.log(`SMTP verification skipped (using ${EMAIL_PROVIDER} HTTPS API).`);
}

// Unified e-mail sender — every route MUST use this, never transporter directly.
async function sendEmail({ to, subject, html }) {
    const fromName = 'SilverCare OSCA (No-Reply)';
    const fromAddr = process.env.EMAIL_USER || 'noreply@silvercare.com';

    // --- Brevo HTTPS API (recommended for Railway free) ---
    if (process.env.BREVO_API_KEY) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        try {
            const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'content-type': 'application/json',
                    'api-key': process.env.BREVO_API_KEY
                },
                body: JSON.stringify({
                    sender: { name: fromName, email: process.env.BREVO_SENDER || fromAddr },
                    to: [{ email: to }],
                    replyTo: { email: 'noreply@silvercare.com' },
                    subject,
                    htmlContent: html
                }),
                signal: ctrl.signal
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                throw new Error(data.message || `Brevo API error (HTTP ${resp.status})`);
            }
            return data;
        } catch (e) {
            if (e && e.name === 'AbortError') throw new Error('Email provider timed out (15s). Please try again.');
            throw e;
        } finally {
            clearTimeout(t);
        }
    }

    // --- Resend HTTPS API (alternative) ---
    if (process.env.RESEND_API_KEY) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        try {
            const resp = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    from: process.env.RESEND_FROM || `${fromName} <onboarding@resend.dev>`,
                    to: [to],
                    subject,
                    html
                }),
                signal: ctrl.signal
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                throw new Error(data.message || `Resend API error (HTTP ${resp.status})`);
            }
            return data;
        } catch (e) {
            if (e && e.name === 'AbortError') throw new Error('Email provider timed out (15s). Please try again.');
            throw e;
        } finally {
            clearTimeout(t);
        }
    }

    // --- Gmail SMTP fallback (local dev / Railway Pro with SMTP) ---
    return transporter.sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        replyTo: 'noreply@silvercare.com',
        to,
        subject,
        html
    });
}

// Public (unauthenticated) status endpoint — reports WHICH provider is
// active and whether its key is present. No secrets are ever returned.
// Open /api/email-status in a browser to instantly see why mail fails.
function emailStatusPayload() {
    return {
        ok: true,
        provider: EMAIL_PROVIDER,
        brevoConfigured: Boolean(process.env.BREVO_API_KEY),
        resendConfigured: Boolean(process.env.RESEND_API_KEY),
        gmailConfigured: Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS)
    };
}

// --- SMS delivery (TextBee — the OSCA Android phone becomes the SMS gateway) ---
// Railway blocks outbound SMTP, but TextBee is a plain HTTPS API (port 443), so
// it works on every Railway plan. TextBee queues each message to the Android
// phone paired with TEXTBEE_API_KEY and that phone sends it through its own
// SIM — no per-message gateway fees. Each senior receives the text on the
// mobile number saved in their OWN profile (users/{uid}/cpNumber).
//   TEXTBEE_API_KEY    (required) API key from the TextBee dashboard
//   TEXTBEE_DEVICE_ID  (optional) pin the sending phone if several are paired
//   TEXTBEE_BASE_URL   (optional) override for a self-hosted TextBee instance
// API reference: https://textbee.dev/docs/api-reference
const SMS_PROVIDER = process.env.TEXTBEE_API_KEY ? 'textbee' : 'disabled';
console.log(`SMS provider: ${SMS_PROVIDER}`);

const TEXTBEE_BASE_URL = String(process.env.TEXTBEE_BASE_URL || 'https://api.textbee.dev/api/v1')
    .trim().replace(/\/+$/, '');

// Hard cap so one notice can never turn into a wall of text on a senior's
// phone (every 160 GSM characters is a separate billed message).
const SMS_MAX_LENGTH = 480;

// Events a senior can be texted about. Anything outside this list is rejected,
// so the gateway can never be used as an open SMS relay.
const SMS_NOTIFICATION_TYPES = [
    'pension_approved', 'pension_releasing', 'pension_released', 'pension_declined',
    'claim_approved', 'claim_releasing', 'claim_released', 'claim_declined',
    'appointment_booked',
    'announcement'
];

// Mobile numbers are stored exactly as typed ("0917 123 4567",
// "+63 917 123 4567", "9171234567"). TextBee expects E.164, so normalise to
// +639XXXXXXXXX. Anything that is not a PH mobile number returns '' and the
// caller skips the send instead of spending an API call on a broken number.
function normalizePhMobile(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('63') && digits.length > 10) digits = digits.slice(2); // 639171234567
    digits = digits.replace(/^0+/, '');                                          // 09171234567
    if (!/^9\d{9}$/.test(digits)) return '';                                     // PH mobile = 9XXXXXXXXX
    return `+63${digits}`;
}

// Never write a senior's full mobile number into logs or audit entries.
function maskMobile(raw) {
    const e164 = normalizePhMobile(raw);
    if (!e164) return '****' + String(raw || '').replace(/\D/g, '').slice(-3);
    return `${e164.slice(0, 6)}****${e164.slice(-3)}`;
}

// Values embedded in an SMS: no control characters (an SMS cannot render
// them), no newlines, and bounded length so one field cannot flood the text.
function smsSafe(str, max) {
    return String(str === null || str === undefined ? '' : str)
        .replace(/[\u0000-\u001F\u007F]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, max || 120);
}

// Unified SMS sender — every route MUST use this, never call TextBee directly.
async function sendSms({ to, message }) {
    if (!process.env.TEXTBEE_API_KEY) {
        throw new Error('SMS is not configured. Ask the administrator to set TEXTBEE_API_KEY.');
    }
    const recipient = normalizePhMobile(to);
    if (!recipient) {
        throw new Error('No valid PH mobile number on file.');
    }
    const text = String(message || '').trim().slice(0, SMS_MAX_LENGTH);
    if (!text) throw new Error('SMS message is empty.');

    const payload = { recipients: [recipient], message: text };
    // Pin the sending phone when the OSCA account pairs more than one device.
    if (process.env.TEXTBEE_DEVICE_ID) payload.deviceId = String(process.env.TEXTBEE_DEVICE_ID).trim();

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
        const resp = await fetch(`${TEXTBEE_BASE_URL}/gateway/send-sms`, {
            method: 'POST',
            headers: {
                'x-api-key': process.env.TEXTBEE_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: ctrl.signal
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.success === false) {
            throw new Error((data && (data.error || data.message)) || `TextBee API error (HTTP ${resp.status})`);
        }
        if (data.data && data.data.success === false) {
            throw new Error(data.data.message || 'TextBee rejected the message.');
        }
        return data;
    } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('SMS gateway timed out (20s). Please try again.');
        throw e;
    } finally {
        clearTimeout(t);
    }
}

// Public (unauthenticated) status endpoint — reports WHICH SMS provider is
// active and whether its key is present. No secrets are ever returned.
function smsStatusPayload() {
    return {
        ok: true,
        provider: SMS_PROVIDER,
        textbeeConfigured: Boolean(process.env.TEXTBEE_API_KEY),
        devicePinned: Boolean(process.env.TEXTBEE_DEVICE_ID),
        baseUrl: TEXTBEE_BASE_URL,
        enabledTypes: SMS_NOTIFICATION_TYPES
    };
}

// Short, GSM-7 friendly notice per event. Plain "PHP" instead of "₱" and no
// emoji on purpose: those symbols force UCS-2 encoding, which halves the
// characters that fit in one SMS segment.
function buildStatusSms({ type, name, amount, localAmount, nationalAmount, quarterlyTotal, refNumber, serviceType, reason, period, message }) {
    const who = smsSafe(name, 40) || 'Senior Citizen';
    const peso = v => Number(String(v === null || v === undefined ? '' : v).replace(/[^\d.]/g, '')) || 0;
    const php = v => `PHP ${peso(v).toLocaleString()}`;
    const whenPeriod = period ? ` for ${smsSafe(period, 20)}` : '';
    const repo = refNumber ? ` Ref: ${smsSafe(refNumber, 24)}.` : '';
    const svc = smsSafe(serviceType, 40).toUpperCase();
    const tail = ' -OSCA Magalang';

    switch (type) {
        case 'pension_approved': {
            // A senior may be granted Local only, National only, or both.
            const _l = peso(localAmount), _n = peso(nationalAmount);
            const parts = [];
            if (_l > 0) parts.push(`Local ${php(_l)} per month`);
            if (_n > 0) parts.push(`National ${php(_n)} per quarter`);
            const _q = peso(quarterlyTotal || amount) || (_l * 3 + _n);
            // Never announce a PHP 0 amount; fall back to a plain approval line.
            const detail = parts.length
                ? `${parts.join(' + ')}, quarterly total ${php(_q)}`
                : 'your pension setup is now active';
            return `SilverCare OSCA: Good news ${who}! Your pension is APPROVED - ${detail}. Bring your OSCA ID when claiming.${tail}`;
        }

        case 'pension_releasing':
            return `SilverCare OSCA: ${who}, your pension payout of ${php(amount)} is now being RELEASED${whenPeriod}. Wait for our release confirmation before going to the OSCA office.${repo}${tail}`;

        case 'pension_released':
            return `SilverCare OSCA: ${who}, your pension payout of ${php(amount)} has been RELEASED${whenPeriod}. Present your OSCA ID or QR Digital ID at the OSCA Magalang office to claim.${repo}${tail}`;

        case 'pension_declined':
            return `SilverCare OSCA: ${who}, your pension ${smsSafe(reason, 120) || 'payout was not approved'}. Please visit the OSCA Magalang office with your OSCA ID for assistance.${tail}`;

        case 'claim_approved':
        case 'claim_releasing':
            return `SilverCare OSCA: ${who}, your ${svc || 'ASSISTANCE'} request of ${php(amount)} is APPROVED and now being RELEASED. Bring your OSCA ID and claim reference when you go to the OSCA Magalang office.${repo}${tail}`;

        case 'claim_released':
            return `SilverCare OSCA: ${who}, your ${svc || 'ASSISTANCE'} of ${php(amount)} has been RELEASED. Present your OSCA ID or QR Digital ID at the OSCA Magalang office to claim.${repo}${tail}`;

        case 'claim_declined':
            return `SilverCare OSCA: ${who}, your ${svc || 'ASSISTANCE'} request was DECLINED. ${smsSafe(reason, 110) || 'Please visit the OSCA Magalang office with your documents.'}${repo}${tail}`;

        case 'appointment_booked':
            return `SilverCare OSCA: ${who}, your request has been received. Please visit the OSCA office within working days to process your request.${tail}`;

        case 'announcement': {
            const custom = smsSafe(message, 300);
            if (!custom) return `SilverCare OSCA: ${who}, there is an announcement from the OSCA Magalang office. Please open your portal or visit the office.${tail}`;
            return `SilverCare OSCA: ${who}, ${custom}${tail}`;
        }

        default:
            return `SilverCare OSCA: ${who}, there is an update on your SilverCare account. Please open your portal or visit the OSCA Magalang office.${tail}`;
    }
}

// Best-effort SMS to a senior. The mobile number is ALWAYS read from the
// senior's own profile (users/{uid}/cpNumber) — a caller can never aim a text
// at an arbitrary number through the OSCA gateway. This function never throws:
// a sleeping Android phone must not roll back a pension approval or a payout
// that is already saved — it only records the skip in the audit trail.
async function notifySeniorSms(uid, type, extra) {
    const systemActor = { uid: 'system', role: 'system', name: 'System' };
    try {
        if (!SMS_NOTIFICATION_TYPES.includes(type)) {
            return { sent: false, reason: 'Unknown SMS notification type.' };
        }
        const snap = await admin.database().ref(`users/${uid}`).once('value');
        if (!snap.exists()) return { sent: false, reason: 'Senior record not found.' };
        const user = snap.val() || {};
        const phone = String(user.cpNumber || '').trim();

        if (!phone) {
            await writeAuditLog('SMS_SKIPPED_NO_NUMBER', systemActor, uid, null,
                `No mobile number on file — "${type}" SMS not sent to ${user.name || uid}.`);
            return { sent: false, reason: 'This senior has no mobile (CP) number on file.' };
        }
        if (!normalizePhMobile(phone)) {
            await writeAuditLog('SMS_SKIPPED_INVALID_NUMBER', systemActor, uid, null,
                `Unusable mobile number on file for ${user.name || uid} — "${type}" SMS not sent.`);
            return { sent: false, reason: 'The CP number on file is not a valid PH mobile number.' };
        }

        const message = buildStatusSms({ type, name: user.name, ...(extra || {}) });
        await sendSms({ to: phone, message });
        await writeAuditLog('SMS_STATUS_SENT', systemActor, uid, null,
            `"${type}" SMS sent to ${user.name || uid} (${maskMobile(phone)}).`);
        return { sent: true, to: maskMobile(phone), type, message };
    } catch (e) {
        console.error('Senior SMS notification failed:', e.message);
        await writeAuditLog('SMS_STATUS_FAILED', systemActor, uid, null,
            `"${type}" SMS failed for ${uid}: ${e.message}`);
        return { sent: false, reason: e.message };
    }
}

// --- Server-side operation timeouts ---
// The Firebase Admin SDK's RTDB/Auth calls and outbound HTTP requests have NO
// default timeout. A slow or unreachable backend kept the request — and every
// client awaiting it — pending for minutes (e.g. staff login stuck on
// "Authenticating..." because the 2FA audit write never settled). Every network
// operation on a request's critical path is now hard-capped so the server
// ALWAYS answers within a bounded time.
function withServerTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error((label || 'Operation') + ' timed out after ' + ms + 'ms.')), ms);
    });
    // Swallow late rejections of the abandoned operation so a timed-out promise
    // can never surface as an unhandled rejection (which crashes Node 15+).
    promise.catch(() => {});
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

// Budgets chosen so the worst case (token verify + profile read + e-mail
// provider + audit write) stays below the browser's 45s patience on /api/2fa/start:
// 10s + 10s + 15s + 4s = 39s.
const AUTH_VERIFY_TIMEOUT_MS = 10000;  // Google ID-token verification
const AUTH_PROFILE_TIMEOUT_MS = 10000; // users/{uid} read
const AUDIT_LOG_TIMEOUT_MS = 4000;     // auditLogs push (must never stall a response)

// --- Security: Auth Middleware ---
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    try {
        const idToken = authHeader.split('Bearer ')[1];
        const decoded = await withServerTimeout(admin.auth().verifyIdToken(idToken), AUTH_VERIFY_TIMEOUT_MS, 'Token verification');
        const userSnap = await withServerTimeout(admin.database().ref(`users/${decoded.uid}`).once('value'), AUTH_PROFILE_TIMEOUT_MS, 'User profile read');
        if (!userSnap.exists()) {
            return res.status(403).json({ success: false, message: 'User profile not found.' });
        }
        req.authUser = { uid: decoded.uid, ...userSnap.val() };
        next();
    } catch (error) {
        // A hung backend is NOT a credential problem — report it as such
        // instead of the misleading "Invalid or expired token" (which used to
        // leave users re-typing correct passwords).
        if (/timed out after/.test(String((error && error.message) || ''))) {
            console.error('requireAuth backend timeout:', error.message);
            return res.status(503).json({ success: false, message: 'Authentication service is temporarily unavailable. Please try again in a moment.' });
        }
        return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.authUser || !roles.includes(req.authUser.role)) {
            return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
        }
        next();
    };
}

// --- Security: HTML Sanitizer for email content ---
function sanitizeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// --- API: Reset Pending Registration (delete pending Firebase Auth + RTDB if same email re-registers) ---
app.post('/api/reset-pending-email', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    try {
        let uid = null;
        try {
            const userRecord = await admin.auth().getUserByEmail(email);
            uid = userRecord.uid;
        } catch (err) {
            // Not in Firebase Auth — nothing to reset
            return res.json({ success: true, message: 'OK' });
        }

        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) {
            await admin.auth().deleteUser(uid);
            return res.json({ success: true });
        }

        const userData = userSnap.val();
        if (userData.status === 'Pending') {
            await admin.database().ref(`users/${uid}`).remove();
            await admin.auth().deleteUser(uid);
            return res.json({ success: true, message: 'Pending registration reset.' });
        }

        return res.json({ success: false, message: 'Email already registered with an active account. Please log in.', canReset: false });
    } catch (error) {
        console.error('Error resetting pending email:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// --- API: Send OTP ---
// NOTE: the e-mail send is wrapped in a 25s timeout race so a hung SMTP
// connection can NEVER leave the frontend stuck on "Sending Code..." with
// no error. On timeout the request fails cleanly and the button restores.
app.post('/api/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    // Generate 6-digit PIN
    const pin = Math.floor(100000 + Math.random() * 900000).toString();

    // Store with 5-minute expiry
    otpStore.set(email, {
        pin: pin,
        expiresAt: Date.now() + 5 * 60 * 1000
    });

    // Professional HTML Email Template
    const htmlEmail = `
    <div style="font-family: 'Inter', Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
        <div style="background: linear-gradient(135deg, #3b82f6, #2563eb); padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 1.5rem;">SilverCare</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0; font-size: 0.9rem;">Senior Citizen Welfare Platform</p>
        </div>
        <div style="padding: 30px;">
            <h2 style="color: #1e293b; margin-top: 0;">Email Verification</h2>
            <p style="color: #64748b; line-height: 1.6;">Hello! You are creating an account on SilverCare. Use the verification code below to complete your registration:</p>
            <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; text-align: center; margin: 25px 0;">
                <span style="font-size: 2.5rem; font-weight: 700; letter-spacing: 8px; color: #1e293b;">${pin}</span>
            </div>
            <p style="color: #94a3b8; font-size: 0.85rem;">This code expires in <strong>5 minutes</strong>. If you did not request this, you can safely ignore this email.</p>
        </div>
        <div style="background: #f8fafc; padding: 15px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="color: #94a3b8; font-size: 0.75rem; margin: 0;">© 2026 SilverCare - OSCA Magalang</p>
        </div>
    </div>`;

    try {
        // sendEmail() picks Brevo/Resend HTTPS API on Railway, Gmail SMTP locally.
        const sendPromise = sendEmail({
            to: email,
            subject: 'SilverCare - Your Verification Code',
            html: htmlEmail
        });
        // 25s ceiling — if Gmail never answers, fail cleanly instead of
        // leaving the browser's fetch pending until it gives up on its own.
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Email provider timed out (25s). Please try again.')), 25000)
        );
        await Promise.race([sendPromise, timeoutPromise]);

        console.log(`OTP sent to ${email}`);
        res.json({ success: true, message: 'Verification code sent.' });
    } catch (error) {
        console.error('Email send error:', error);
        const isTimeout = /timed out/i.test(error.message || '');
        res.status(isTimeout ? 504 : 500).json({ success: false, message: isTimeout ? 'Email provider timed out. Please try again.' : 'Failed to send email. Check server email config.' });
    }
}); // end /api/send-otp

// --- API: Verify OTP ---
app.post('/api/verify-otp', (req, res) => {
    const { email, pin } = req.body;
    if (!email || !pin) return res.status(400).json({ success: false, message: 'Email and PIN are required.' });

    // --- Brute-force protection ---
    const attempts = otpAttempts.get(email);
    if (attempts && attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
        const remainSec = Math.ceil((attempts.lockedUntil - Date.now()) / 1000);
        return res.status(429).json({ success: false, message: `Too many failed attempts. Please wait ${remainSec} seconds.` });
    }

    const stored = otpStore.get(email);

    if (!stored) {
        return res.status(400).json({ success: false, message: 'No verification code found. Please request a new one.' });
    }

    if (Date.now() > stored.expiresAt) {
        otpStore.delete(email);
        return res.status(400).json({ success: false, message: 'Verification code has expired. Please request a new one.' });
    }

    if (stored.pin !== pin) {
        // Track failed attempts
        const current = otpAttempts.get(email) || { count: 0 };
        current.count += 1;
        if (current.count >= 5) {
            current.lockedUntil = Date.now() + 5 * 60 * 1000; // lock for 5 minutes
            current.count = 0;
            otpStore.delete(email);
        }
        otpAttempts.set(email, current);
        return res.status(400).json({ success: false, message: 'Invalid verification code. Please check and try again.' });
    }

    // Valid — clear it
    otpStore.delete(email);
    otpAttempts.delete(email);
    res.json({ success: true, message: 'Email verified successfully.' });
});

// --- API: Change User Password (Admin) ---
app.post('/api/change-user-password', requireAuth, requireRole('admin'), async (req, res) => {
    const { uid, newPassword } = req.body;
    if (!uid || !newPassword) {
        return res.status(400).json({ success: false, message: 'UID and new password are required.' });
    }

    try {
        await admin.auth().updateUser(uid, {
            password: newPassword
        });
        res.json({ success: true, message: 'User password updated successfully.' });
    } catch (error) {
        console.error('Error changing user password:', error);
        res.status(500).json({ success: false, message: 'Failed to update user password: ' + error.message });
    }
});

// --- API: Send Unified Status Notification Email ---
app.post('/api/send-status-email', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { email, type } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    // Sanitize all user-supplied values to prevent HTML injection in emails
    const name = sanitizeHtml(req.body.name);
    const amount = sanitizeHtml(req.body.amount);
    const localAmount = sanitizeHtml(req.body.localAmount);
    const nationalAmount = sanitizeHtml(req.body.nationalAmount);
    const quarterlyTotal = sanitizeHtml(req.body.quarterlyTotal);
    const refNumber = sanitizeHtml(req.body.refNumber);
    const reason = sanitizeHtml(req.body.reason);
    const serviceType = sanitizeHtml(req.body.serviceType);

    let title = '';
    let subtitle = '';
    let statusTitle = '';
    let statusText = '';
    let isApproved = type.includes('approved');
    let colorThemeGrad = isApproved ? 'linear-gradient(135deg, #16a34a, #15803d)' : 'linear-gradient(135deg, #ef4444, #dc2626)';
    let sectionHtml = '';

    if (type === 'pension_approved') {
        // A senior may receive Local only, National only, or both. Never
        // print a fabricated amount when a component is 0 or missing.
        const _peso = v => Number(String(v === null || v === undefined ? '' : v).replace(/[^\d.]/g, '')) || 0;
        const _l = _peso(localAmount), _n = _peso(nationalAmount);
        const _parts = [];
        if (_l > 0) _parts.push(`Local pension: PHP ${_l.toLocaleString()} per month`);
        if (_n > 0) _parts.push(`National pension: PHP ${_n.toLocaleString()} per quarter`);
        const _breakdown = _parts.length ? _parts.join('. ') : 'Your pension setup';
        const _total = _peso(quarterlyTotal) || _peso(amount) || (_l * 3 + _n);
        const _lines = [];
        if (_l > 0) _lines.push(`<p style="font-size: 1.05rem; color: #166534; margin: 4px 0; font-weight: 700;">Local: PHP ${_l.toLocaleString()} / month</p>`);
        if (_n > 0) _lines.push(`<p style="font-size: 1.05rem; color: #1d4ed8; margin: 4px 0; font-weight: 700;">National: PHP ${_n.toLocaleString()} / quarter</p>`);
        // Release schedule bullets must match the granted components only.
        const _schedule = [];
        if (_l > 0) _schedule.push('Your Local pension is released monthly.');
        if (_n > 0) _schedule.push('Your National pension is released every three months.');
        const _subLabel = _l > 0 && _n > 0 ? 'Local + National' : (_l > 0 ? 'Local' : 'National');
        title = 'Pension Payout Approved';
        subtitle = `Official ${_subLabel} Pension Disbursement Notice`;
        statusTitle = 'Payout Status: Approved & Active';
        statusText = `Your pension setup has been officially approved and activated by the OSCA administration. ${_breakdown}. Your quarterly pension total is PHP ${_total.toLocaleString()}.`;
        sectionHtml = `
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 20px; text-align: center; margin: 25px 0;">
                <p style="color: #166534; font-size: 0.9rem; margin: 0 0 8px 0; font-weight: 600;">Approved Pension Setup</p>
                ${_lines.join('\n                ')}
                <p style="font-size: 1.35rem; color: #15803d; margin: 10px 0 0; font-weight: 800;">Quarterly total: PHP ${_total.toLocaleString()}</p>
            </div>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 25px; margin-top: 20px;">
                <h3 style="color: #0f172a; margin-top: 0; font-size: 1.05rem;">What Happens Next:</h3>
                <ul style="color: #475569; padding-left: 20px; font-size: 0.95rem; line-height: 1.6; margin-bottom: 0;">
                    <li>${_schedule.join(' ')}</li>
                    <li>Each pension payout will be announced through your SilverCare portal notifications and e-mail.</li>
                    <li>To receive a payout, present your physical <strong>OSCA Identification Card</strong> at the designated OSCA Magalang Distribution Center.</li>
                    <li>For questions about the release schedule, please visit or contact the OSCA Magalang office.</li>
                </ul>
            </div>`;
    } else if (type === 'pension_declined') {
        title = 'Pension Payout Declined';
        subtitle = 'Local + National Pension Status Update';
        statusTitle = 'Payout Status: Declined / Suspended';
        statusText = `We regret to inform you that your Local/National pension payout for this period was not approved during our verification process.`;
        sectionHtml = `
            <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 20px; margin: 25px 0;">
                <p style="color: #991b1b; font-size: 0.95rem; margin: 0 0 5px 0; font-weight: 700;">Reason for Decline:</p>
                <p style="color: #ef4444; font-size: 0.95rem; margin: 0; line-height: 1.5;">${reason || 'Document verification discrepancy or account status mismatch. Please visit the local OSCA office.'}</p>
            </div>
            <p style="color: #64748b; font-size: 0.9rem; line-height: 1.6;">If you believe this was an error, please visit the OSCA Magalang center with your physical OSCA ID card and latest proof of residency.</p>`;
    } else if (type === 'claim_approved') {
        const sType = serviceType ? serviceType.toUpperCase() : 'WELFARE ASSISTANCE';
        title = `${sType} Request Approved`;
        subtitle = 'Official Welfare Assistance Payout Notice';
        statusTitle = 'Request Status: Approved & Released';
        statusText = `We are pleased to inform you that your requested welfare assistance claim for <strong>${sType}</strong> has been reviewed and officially approved by the OSCA administration.`;
        sectionHtml = `
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 20px; text-align: center; margin: 25px 0;">
                <p style="color: #166534; font-size: 0.9rem; margin: 0 0 5px 0; font-weight: 600;">Approved Assistance Amount</p>
                <span style="font-size: 2.2rem; font-weight: 800; color: #15803d; letter-spacing: -1px;">PHP ${amount || '10,000'}</span>
            </div>
            <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0;">
                <p style="color: #1e3a8a; font-size: 0.9rem; margin: 0 0 5px 0; font-weight: 600;">OFFICIAL CLAIM REFERENCE NUMBER</p>
                <span style="font-size: 1.6rem; font-weight: 800; color: #2563eb; letter-spacing: 2px;">${refNumber || 'REF-8263A2'}</span>
            </div>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 25px; margin-top: 20px;">
                <h3 style="color: #0f172a; margin-top: 0; font-size: 1.05rem;">Instructions to Claim Assistance Payout:</h3>
                <ul style="color: #475569; padding-left: 20px; font-size: 0.95rem; line-height: 1.6; margin-bottom: 0;">
                    <li>Please bring your physical <strong>OSCA Identification Card</strong>.</li>
                    <li>Present your <strong>Official Claim Reference Number (${refNumber || 'REF-8263A2'})</strong>.</li>
                    <li>Proceed to the OSCA Magalang Central Office.</li>
                    <li>Ensure you have the registered claimant's proof of relationship if claiming on behalf of a senior.</li>
                </ul>
            </div>`;
    } else if (type === 'claim_declined') {
        const sType = serviceType ? serviceType.toUpperCase() : 'WELFARE ASSISTANCE';
        title = `${sType} Request Declined`;
        subtitle = 'Welfare Assistance Status Update';
        statusTitle = 'Request Status: Declined / Rejected';
        statusText = `We regret to inform you that your requested welfare assistance claim for <strong>${sType}</strong> was not approved during our verification and review process.`;
        sectionHtml = `
            <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 20px; margin: 25px 0;">
                <p style="color: #991b1b; font-size: 0.95rem; margin: 0 0 5px 0; font-weight: 700;">Reason for Decline:</p>
                <p style="color: #ef4444; font-size: 0.95rem; margin: 0; line-height: 1.5;">${reason || 'Required documentation was missing or could not be verified by the local OSCA officers.'}</p>
            </div>
            <p style="color: #64748b; font-size: 0.9rem; line-height: 1.6;">If you have further questions or wish to appeal this decision, please bring your physical OSCA ID card along with all relevant documents to the OSCA Magalang office.</p>`;
    }

    const htmlEmail = `
    <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
        <div style="background: ${colorThemeGrad}; padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 1.5rem;">SilverCare Welfare Division</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0; font-size: 0.9rem;">Office of the Senior Citizens Affairs (OSCA)</p>
        </div>
        <div style="padding: 30px;">
            <h2 style="color: #1e293b; margin-top: 0; font-size: 1.3rem;">${title}</h2>
            <p style="color: #475569; line-height: 1.6;">Dear <strong>${name || 'Senior Citizen'}</strong>,</p>
            <p style="color: #475569; line-height: 1.6;">${statusText}</p>
            
            ${sectionHtml}
        </div>
        <div style="background: #f1f5f9; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="color: #64748b; font-size: 0.8rem; margin: 0; font-weight: 500;">© 2026 SilverCare System - OSCA Magalang Official Communication</p>
            <p style="color: #94a3b8; font-size: 0.75rem; margin: 5px 0 0 0;">This is an automated message. Please do not reply.</p>
        </div>
    </div>`;

    try {
        await sendEmail({
            to: email,
            subject: `Official Notice: ${title}`,
            html: htmlEmail
        });
        res.json({ success: true, message: 'Status notification email sent successfully.' });
    } catch (error) {
        console.error('Email send error:', error);
        res.status(500).json({ success: false, message: 'Failed to send status email.' });
    }
});

// --- API: Send Unified Status Notification SMS (TextBee) ---
// Staff-triggered twin of /api/send-status-email. The recipient is resolved
// from the senior's PROFILE (users/{uid}/cpNumber) and never from the request
// body, so a staff account can never text an arbitrary number through the
// OSCA gateway. Best-effort by design: when the senior has no usable number
// (or the Android gateway is offline) the route answers 200 + skipped:true
// instead of failing an action the staff member already completed.
app.post('/api/send-status-sms', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const body = req.body || {};
    const uid = smsSafe(body.uid, 64);
    const type = smsSafe(body.type, 40);

    if (!uid) return res.status(400).json({ success: false, message: 'Senior uid is required.' });
    if (!SMS_NOTIFICATION_TYPES.includes(type)) {
        return res.status(400).json({ success: false, message: 'Unknown SMS notification type.' });
    }

    // Only these display-safe values may end up inside the text message.
    const extra = {
        amount: smsSafe(body.amount, 20),
        localAmount: smsSafe(body.localAmount, 20),
        nationalAmount: smsSafe(body.nationalAmount, 20),
        quarterlyTotal: smsSafe(body.quarterlyTotal, 20),
        refNumber: smsSafe(body.refNumber, 24),
        serviceType: smsSafe(body.serviceType, 40),
        reason: smsSafe(body.reason, 120),
        period: smsSafe(body.period, 20),
        message: smsSafe(body.message, 300)
    };

    const result = await notifySeniorSms(uid, type, extra);
    if (result.sent) {
        return res.json({ success: true, message: 'Status SMS sent to the senior.', to: result.to, type: type });
    }
    res.json({ success: true, skipped: true, message: result.reason || 'SMS not sent.', type: type });
});

// --- API: Send Announcement / Custom SMS (TextBee) ---
// Staff-composed notice to ONE senior (uid) or EVERYONE (broadcast=true).
// The text always comes from the staff message box; recipients are always
// resolved from senior profiles (users/{uid}/cpNumber) — never from the
// request body — so the gateway can never text an arbitrary number.
// Supported:
//   POST { uid, message }                 -> one specific senior
//   POST { uids: [uid...], message }      -> a specific set of seniors
//   POST { broadcast: true, message }     -> every senior with a valid number
// Best-effort: answers 200 with per-recipient sent/skipped counts. A sleeping
// Android gateway or missing CP numbers never fail the request.
app.post('/api/send-announcement-sms', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const body = req.body || {};
    const message = smsSafe(body.message, 300);
    if (!message) return res.status(400).json({ success: false, message: 'A message is required (max 300 characters).' });

    const broadcast = body.broadcast === true || body.broadcast === 'true';
    let uids = [];
    if (broadcast) {
        try {
            const snap = await admin.database().ref('users').once('value');
            const users = snap.val() || {};
            uids = Object.entries(users)
                .filter(([, u]) => u && u.role === 'senior' && String(u.status || '') !== 'Rejected' &&
                    !['Deceased', 'Transferred', 'Archived'].includes(String(u.lifeStatus || '')))
                .map(([uid]) => uid);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Could not load senior records: ' + e.message });
        }
    } else if (Array.isArray(body.uids)) {
        uids = body.uids.map(v => smsSafe(v, 64)).filter(Boolean).slice(0, 500);
    } else if (body.uid) {
        uids = [smsSafe(body.uid, 64)].filter(Boolean);
    }
    if (!uids.length) {
        return res.status(400).json({ success: false, message: 'Provide a senior uid, a uids array, or broadcast:true for everyone.' });
    }

    const extra = {
        amount: smsSafe(body.amount, 20),
        localAmount: smsSafe(body.localAmount, 20),
        nationalAmount: smsSafe(body.nationalAmount, 20),
        quarterlyTotal: smsSafe(body.quarterlyTotal, 20),
        refNumber: smsSafe(body.refNumber, 24),
        serviceType: smsSafe(body.serviceType, 40),
        reason: smsSafe(body.reason, 120),
        period: smsSafe(body.period, 20),
        message
    };

    const results = [];
    for (const uid of uids) {
        // Sequential sends: one TextBee HTTP call per senior, so the gateway
        // phone is never flooded with a parallel burst.
        // eslint-disable-next-line no-await-in-loop
        const r = await notifySeniorSms(uid, 'announcement', extra);
        results.push({ uid, sent: r.sent, to: r.to || null, reason: r.sent ? null : (r.reason || 'SMS not sent.') });
    }
    const sent = results.filter(r => r.sent).length;
    const skipped = results.length - sent;
    await writeAuditLog('SMS_ANNOUNCEMENT_SENT', req.authUser, null, null,
        `Announcement SMS ("${message.slice(0, 120)}") — ${sent} sent, ${skipped} skipped out of ${results.length}.`);
    res.json({ success: true, message: `Announcement SMS processed: ${sent} sent, ${skipped} skipped.`, sent, skipped, total: results.length, results });
});

// ============================================================
// Two-Factor Authentication (2FA) for Admin & OSCA Staff ONLY.
// Kind of 2FA used: E-mail One-Time PIN (6-digit, single-use,
// 5-minute expiry, bound to the authenticated uid, with brute-
// force lockout). Senior citizens intentionally use simplified
// login (panel requirement — 2FA must NOT burden seniors).
// ============================================================
const twoFAStore = new Map(); // uid -> { code, expiresAt, attempts, lastSentAt }
const TWOFA_TTL_MS = 5 * 60 * 1000;
const TWOFA_RESEND_MS = 30 * 1000;
const TWOFA_MAX_ATTEMPTS = 5;
const OTP_EXEMPT_EMAILS = new Set([
    'admin@silvercare.com',
    'employee@silvercare.com'
]);

function isOtpExemptEmail(email) {
    return OTP_EXEMPT_EMAILS.has(String(email || '').trim().toLowerCase());
}

function twoFAEmailTemplate(pin) {
    return `
    <div style="font-family: 'Inter', Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
        <div style="background: linear-gradient(135deg, #1e3a8a, #2563eb); padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 1.5rem;">SilverCare</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0; font-size: 0.9rem;">OSCA Magalang — Staff Portal</p>
        </div>
        <div style="padding: 30px;">
            <h2 style="color: #1e293b; margin-top: 0;">Two-Factor Authentication</h2>
            <p style="color: #64748b; line-height: 1.6;">Use the security code below to finish signing in to your staff account:</p>
            <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; text-align: center; margin: 25px 0;">
                <span style="font-size: 2.5rem; font-weight: 700; letter-spacing: 8px; color: #1e293b;">${pin}</span>
            </div>
            <p style="color: #94a3b8; font-size: 0.85rem;">This code expires in <strong>5 minutes</strong> and can only be used once. If you did not attempt to sign in, please change your password immediately.</p>
        </div>
        <div style="background: #f8fafc; padding: 15px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="color: #94a3b8; font-size: 0.75rem; margin: 0;">© 2026 SilverCare - OSCA Magalang</p>
        </div>
    </div>`;
}

// --- API: Start 2FA challenge (admin/staff, authenticated with a valid Firebase ID token) ---
app.post('/api/2fa/start', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const actor = req.authUser;

        // Explicitly provisioned master/default staff accounts are exempt from e-mail OTP.
        if (isOtpExemptEmail(actor.email)) {
            return res.json({ success: true, message: 'Two-factor authentication is not required for this account.' });
        }

        const existing = twoFAStore.get(actor.uid);

        // Rate-limit resend attempts
        if (existing && existing.lastSentAt && (Date.now() - existing.lastSentAt) < TWOFA_RESEND_MS) {
            const waitSec = Math.ceil((TWOFA_RESEND_MS - (Date.now() - existing.lastSentAt)) / 1000);
            return res.status(429).json({ success: false, message: `Please wait ${waitSec}s before requesting a new code.` });
        }

        const code = String(Math.floor(100000 + Math.random() * 900000));
        twoFAStore.set(actor.uid, {
            code: code,
            expiresAt: Date.now() + TWOFA_TTL_MS,
            attempts: 0,
            lastSentAt: Date.now()
        });

        await sendEmail({
            to: actor.email,
            subject: 'SilverCare Staff Sign-In — Security Code',
            html: twoFAEmailTemplate(code)
        });

        const masked = String(actor.email).replace(/^(.).*(@.*)$/, '$1*****$2');
        await writeAuditLog('LOGIN_2FA_STARTED', actor, actor.uid, null, `2FA code e-mailed to ${masked}`);
        res.json({ success: true, message: `A 6-digit security code was sent to ${masked}.` });
    } catch (error) {
        console.error('2FA start error:', error);
        res.status(500).json({ success: false, message: 'Failed to send the security code. Please try again.' });
    }
});

// --- API: Verify 2FA challenge (admin/staff). Single-use, bound to uid. ---
app.post('/api/2fa/verify', requireAuth, requireRole('admin', 'employee'), (req, res) => {
    const actor = req.authUser;

    // Explicitly provisioned master/default staff accounts are exempt from e-mail OTP.
    if (isOtpExemptEmail(actor.email)) {
        writeAuditLog('LOGIN_2FA_SUCCESS', actor, actor.uid, null, 'Provisioned staff sign-in (2FA-exempt)');
        return res.json({ success: true, message: 'Two-factor authentication verified.' });
    }

    const code = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ success: false, message: 'Enter the 6-digit security code.' });
    }

    const entry = twoFAStore.get(actor.uid);
    if (!entry) {
        return res.status(400).json({ success: false, message: 'No security code requested. Please request a new one.' });
    }
    if (Date.now() > entry.expiresAt) {
        twoFAStore.delete(actor.uid);
        return res.status(400).json({ success: false, message: 'Security code expired. Please request a new one.' });
    }
    if (entry.attempts >= TWOFA_MAX_ATTEMPTS) {
        twoFAStore.delete(actor.uid);
        return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
    }

    if (entry.code !== code) {
        entry.attempts += 1;
        return res.status(400).json({
            success: false,
            message: `Incorrect code. ${TWOFA_MAX_ATTEMPTS - entry.attempts} attempt(s) remaining.`
        });
    }

    // Success — single use
    twoFAStore.delete(actor.uid);
    writeAuditLog('LOGIN_2FA_SUCCESS', actor, actor.uid, null, 'Staff sign-in completed with 2FA');
    res.json({ success: true, message: 'Two-factor authentication verified.' });
});

// ============================================================
// Password Reset via E-mailed Link (ADMIN accounts only).
// A single-use, 15-minute reset token is e-mailed to the
// admin's registered address. The link opens /reset-password
// where a new password is set through the Firebase Admin SDK.
// The link base prefers PUBLIC_BASE_URL (your Railway public URL);
// otherwise it uses the request host (works behind Railway's proxy
// thanks to `trust proxy`). No localhost is ever used in production.
// ============================================================
// Canonical public base URL of this deployment (no trailing slash).
// Set PUBLIC_BASE_URL on Railway to https://<your-app>.up.railway.app
function getPublicBaseUrl(req) {
    const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    return `${req.protocol}://${req.get('host')}`;
}
const passwordResetStore = new Map();  // token -> { uid, email, expiresAt }
const resetRequestStore = new Map();   // email -> lastSentAt (request rate limit)
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const RESET_REQUEST_COOLDOWN_MS = 60 * 1000;

function passwordResetEmailTemplate(resetLink) {
    return `
    <div style="font-family: 'Inter', Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
        <div style="background: linear-gradient(135deg, #1e3a8a, #2563eb); padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 1.5rem;">SilverCare</h1>
            <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0; font-size: 0.9rem;">OSCA Magalang — Admin Portal</p>
        </div>
        <div style="padding: 30px;">
            <h2 style="color: #1e293b; margin-top: 0;">Password Reset Request</h2>
            <p style="color: #64748b; line-height: 1.6;">We received a request to reset the password for your SilverCare admin account. Click the button below to choose a new password:</p>
            <div style="text-align: center; margin: 25px 0;">
                <a href="${resetLink}" style="background: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-weight: 600; display: inline-block;">Reset Password</a>
            </div>
            <p style="color: #94a3b8; font-size: 0.85rem;">This link expires in <strong>15 minutes</strong> and can only be used once. If you did not request a password reset, you can safely ignore this email — your current password remains unchanged.</p>
        </div>
        <div style="background: #f8fafc; padding: 15px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="color: #94a3b8; font-size: 0.75rem; margin: 0;">© 2026 SilverCare - OSCA Magalang</p>
        </div>
    </div>`;
}

// ============================================================
// Facial Recognition — Inactive Account Reactivation
// Lets seniors reactivate an inactive account: they enter the
// OSCA / Senior Citizen ID from their registration, then match a
// live face scan against the face photo stored at registration.
// The scanned face is attached to that account's review request
// for OSCA staff, who give the final approval.
// ============================================================
const reactivationChallenges = new Map(); // token -> { uid, email, expiresAt, attempts }
const REACTIVATION_TOKEN_TTL_MS = 10 * 60 * 1000;
const REACTIVATION_MAX_ATTEMPTS = 5;
const REACTIVATION_MATCH_THRESHOLD = 0.6; // face descriptor euclidean distance (lower = closer match)

setInterval(() => {
    const now = Date.now();
    for (const [token, c] of reactivationChallenges) {
        if (!c || now > c.expiresAt) reactivationChallenges.delete(token);
    }
}, 5 * 60 * 1000);

function getReactivationChallenge(token) {
    if (!token || typeof token !== 'string') return null;
    const c = reactivationChallenges.get(token);
    if (!c) return null;
    if (Date.now() > c.expiresAt) { reactivationChallenges.delete(token); return null; }
    return c;
}

// Shared eligibility check — returns { ok, code, message, user, uid }
async function checkReactivationEligibility(u, uid) {
    const status = u.status || '';
    const life = u.lifeStatus || '';
    if (u.role !== 'senior') {
        return { ok: false, code: 400, message: 'Face-scan reactivation is available for senior citizen accounts only.' };
    }
    if (life === 'Deceased' || status === 'Deceased') {
        return { ok: false, code: 400, message: 'This senior have passed away, please go to OSCA if you think this is an error', reason: 'DECEASED' };
    }
    if (['Transferred', 'Archived'].includes(life)) {
        return { ok: false, code: 400, message: 'This record is archived and cannot be reactivated online. Please visit the OSCA office.' };
    }
    if (status === 'Pending') {
        return { ok: false, code: 400, message: 'Your registration is still pending review. Please wait for OSCA staff approval.' };
    }
    if (status === 'Rejected') {
        return { ok: false, code: 400, message: 'Your registration was not approved. Please visit the OSCA office for help.' };
    }
    if (status === 'Active' && (!life || life === 'Active')) {
        return { ok: false, code: 400, message: 'This account is still active, please proceed to login', reason: 'ALREADY_ACTIVE' };
    }
    if (!(status === 'Inactive' || life === 'Inactive')) {
        return { ok: false, code: 400, message: 'This account is still active, please proceed to login', reason: 'ALREADY_ACTIVE' };
    }
    if (!u.kycFaceImage) {
        return { ok: false, code: 400, message: 'No face scan is on file for this account. Please visit the OSCA office for assisted reactivation.' };
    }
    const reqSnap = await admin.database().ref(`reactivationRequests/${uid}`).once('value');
    if (reqSnap.exists() && reqSnap.val() && reqSnap.val().status === 'Pending') {
        return { ok: false, code: 400, message: 'You already have a pending reactivation request. Please wait for OSCA staff to review it.' };
    }
    return { ok: true, user: u, uid };
}

// --- API: Start face-scan reactivation — find the account by OSCA / Senior ID (public) ---
app.post('/api/reactivation/start', async (req, res) => {
    const { seniorId } = req.body || {};
    const cleanId = String(seniorId || '').trim();
    if (!cleanId) return res.status(400).json({ success: false, message: 'Please type your OSCA / Senior Citizen ID number.' });
    if (reactivationStartRateLimited(req.ip)) {
        return res.status(429).json({ success: false, message: 'Too many attempts. Please wait a few minutes and try again, or visit the OSCA office.' });
    }
    try {
        // Find the senior account whose registered OSCA ID matches the one typed.
        const snap = await admin.database().ref('users').orderByChild('role').equalTo('senior').once('value');
        const users = snap.val() || {};
        const normId = cleanId.toUpperCase();
        let uid = '';
        let u = null;
        for (const [key, rec] of Object.entries(users)) {
            if (String(rec.seniorId || '').trim().toUpperCase() === normId) { uid = key; u = rec; break; }
        }
        if (!u) {
            return res.status(404).json({ success: false, message: 'No senior record matches that OSCA ID. Please check the ID given at registration, or visit the OSCA office for help.' });
        }
        const check = await checkReactivationEligibility(u, uid);
        if (!check.ok) return res.status(check.code).json({ success: false, message: check.message, reason: check.reason || 'NOT_ELIGIBLE' });

        // Issue a short-lived token bound to that account — the face scan and the
        // resulting staff review request are attached to this exact senior record.
        const token = crypto.randomBytes(24).toString('hex');
        reactivationChallenges.set(token, { uid, email: String(u.email || '').toLowerCase(), expiresAt: Date.now() + REACTIVATION_TOKEN_TTL_MS, attempts: 0 });
        await writeAuditLog('ACCOUNT_REACTIVATION_ID_LOOKUP', { uid: 'system', role: 'system', name: 'System' }, uid, null, `Face-scan reactivation started using OSCA ID ${u.seniorId || cleanId}. Awaiting face scan.`);
        return res.json({ success: true, token, name: u.name || 'Senior Citizen', seniorId: u.seniorId || cleanId });
    } catch (err) {
        console.error('Reactivation start error:', err);
        return res.status(500).json({ success: false, message: 'Could not start the face scan. Please try again.' });
    }
});

// --- API: Fetch stored face photo for comparison (token-gated, public) ---
app.get('/api/reactivation/reference/:token', async (req, res) => {
    try {
        const c = getReactivationChallenge(req.params.token);
        if (!c) return res.status(401).json({ success: false, message: 'Your session expired. Please start over.' });
        const snap = await admin.database().ref(`users/${c.uid}/kycFaceImage`).once('value');
        if (!snap.exists() || !snap.val()) return res.status(400).json({ success: false, message: 'No face scan on file. Please visit the OSCA office.' });
        return res.json({ success: true, referenceImage: snap.val() });
    } catch (err) {
        console.error('Reactivation reference error:', err);
        return res.status(500).json({ success: false, message: 'Could not load the stored face photo. Please try again.' });
    }
});

// --- API: Submit face-match result — creates a staff review request (token-gated, public) ---
app.post('/api/reactivation/submit', async (req, res) => {
    const { token, distance, liveImage } = req.body || {};
    try {
        const c = getReactivationChallenge(token);
        if (!c) return res.status(401).json({ success: false, message: 'Your session expired. Please start over.' });
        c.attempts += 1;
        if (c.attempts > REACTIVATION_MAX_ATTEMPTS) {
            reactivationChallenges.delete(token);
            return res.status(429).json({ success: false, message: 'Too many attempts. Please start over or visit the OSCA office.' });
        }
        const dist = Number(distance);
        if (!Number.isFinite(dist)) return res.status(400).json({ success: false, message: 'Face scan result is missing. Please scan your face again.' });
        if (dist > REACTIVATION_MATCH_THRESHOLD) {
            return res.status(400).json({ success: false, message: 'Face did not match our records. Please face the camera clearly and try again.' });
        }
        if (!liveImage || typeof liveImage !== 'string' || !liveImage.startsWith('data:image') || liveImage.length > 500000) {
            return res.status(400).json({ success: false, message: 'Live photo is missing or too large. Please scan your face again.' });
        }

        const userSnap = await admin.database().ref(`users/${c.uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Account record not found.' });
        const u = userSnap.val() || {};
        if (String(u.lifeStatus || '') === 'Deceased' || String(u.status || '') === 'Deceased') {
            reactivationChallenges.delete(token);
            return res.status(400).json({ success: false, message: 'This senior have passed away, please go to OSCA if you think this is an error', reason: 'DECEASED' });
        }
        if ((u.status || '') === 'Active' && (!u.lifeStatus || u.lifeStatus === 'Active')) {
            reactivationChallenges.delete(token);
            return res.status(400).json({ success: false, message: 'This account is still active, please proceed to login', reason: 'ALREADY_ACTIVE' });
        }
        const existing = await admin.database().ref(`reactivationRequests/${c.uid}`).once('value');
        if (existing.exists() && existing.val() && existing.val().status === 'Pending') {
            reactivationChallenges.delete(token);
            return res.status(400).json({ success: false, message: 'You already have a pending reactivation request.' });
        }

        const confidence = Math.max(0, Math.min(100, Math.round((1 - dist) * 100)));
        await admin.database().ref(`reactivationRequests/${c.uid}`).set({
            uid: c.uid, email: c.email, name: u.name || 'Senior Citizen', seniorId: u.seniorId || 'N/A',
            barangay: u.barangay || '', liveImage, referenceImage: u.kycFaceImage || '',
            distance: dist, confidence, status: 'Pending', requestedAt: Date.now()
        });
        reactivationChallenges.delete(token);

        await notifyStaff('Account Reactivation Request', `${u.name || 'A senior'} (${u.seniorId || c.email}) requested account reactivation via face scan (match ${confidence}%). Please review it in the Archive tab.`);
        await writeAuditLog('ACCOUNT_REACTIVATION_REQUESTED', { uid: 'system', role: 'system', name: 'System' }, c.uid, null, `Face-scan reactivation requested with match confidence ${confidence}%. Awaiting staff review.`);
        return res.json({ success: true, message: 'Face scan matched! Your request was sent. OSCA staff will review it — please check back later or log in once approved.' });
    } catch (err) {
        console.error('Reactivation submit error:', err);
        return res.status(500).json({ success: false, message: 'Could not submit your request. Please try again.' });
    }
});

// --- API: List reactivation requests (staff only) ---
app.get('/api/reactivation/requests', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const snap = await admin.database().ref('reactivationRequests').once('value');
        const list = [];
        if (snap.exists()) {
            snap.forEach(child => { list.push({ id: child.key, ...child.val() }); });
        }
        list.sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
        return res.json({ success: true, requests: list.slice(0, 100) });
    } catch (err) {
        console.error('Reactivation list error:', err);
        return res.status(500).json({ success: false, message: 'Failed to load reactivation requests.' });
    }
});

// --- API: Approve / reject a reactivation request (staff only — final human decision) ---
app.post('/api/reactivation/requests/:uid/review', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const targetUid = req.params.uid;
        const { approve, note } = req.body || {};
        const reqSnap = await admin.database().ref(`reactivationRequests/${targetUid}`).once('value');
        if (!reqSnap.exists() || !reqSnap.val()) {
            return res.status(404).json({ success: false, message: 'Request not found.' });
        }
        const rec = reqSnap.val();
        if (rec.status !== 'Pending') {
            return res.status(400).json({ success: false, message: 'This request was already reviewed.' });
        }

        const actor = req.authUser;
        if (approve === true || approve === 'true') {
            const userSnap = await admin.database().ref(`users/${targetUid}`).once('value');
            if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior record not found.' });
            const u = userSnap.val() || {};
            if (['Deceased', 'Transferred', 'Archived'].includes(u.lifeStatus || '')) {
                const isDec = String(u.lifeStatus || '') === 'Deceased' || String(u.status || '') === 'Deceased';
                await admin.database().ref(`reactivationRequests/${targetUid}`).update({ status: 'Rejected', reviewedBy: actor.name || actor.email, reviewedAt: Date.now(), reviewNote: ((note || '') + ' [Auto-note: record is archived; office visit required.]').slice(0, 500) });
                return res.status(400).json({ success: false, message: isDec ? 'This senior have passed away, please go to OSCA if you think this is an error' : 'Cannot reactivate — this record is archived. The senior must visit the OSCA office.' });
            }
            const updates = { status: 'Active' };
            if ((u.lifeStatus || '') === 'Inactive') updates.lifeStatus = 'Active';
            await admin.database().ref(`users/${targetUid}`).update(updates);
            await admin.database().ref(`reactivationRequests/${targetUid}`).update({ status: 'Approved', reviewedBy: actor.name || actor.email, reviewedAt: Date.now(), reviewNote: note || '' });
            await admin.database().ref(`users/${targetUid}/notifications`).push({
                title: 'Account Reactivated',
                message: 'Good news! Your SilverCare account is active again. You can now log in. — OSCA Magalang',
                createdAt: Date.now(), read: false, type: 'account'
            });
            await writeAuditLog('ACCOUNT_REACTIVATION_APPROVED', actor, targetUid, null, `Face-scan reactivation approved (match ${rec.confidence || '?'}%). Account reactivated by staff.`);
            return res.json({ success: true, message: 'Account reactivated. The senior can now log in.' });
        }

        await admin.database().ref(`reactivationRequests/${targetUid}`).update({ status: 'Rejected', reviewedBy: actor.name || actor.email, reviewedAt: Date.now(), reviewNote: note || '' });
        await admin.database().ref(`users/${targetUid}/notifications`).push({
            title: 'Reactivation Request Not Approved',
            message: (note ? note + ' ' : '') + 'Please visit the OSCA office for assistance. — OSCA Magalang',
            createdAt: Date.now(), read: false, type: 'account'
        });
        await writeAuditLog('ACCOUNT_REACTIVATION_REJECTED', actor, targetUid, null, `Face-scan reactivation rejected. Note: ${(note || 'none').slice(0, 200)}`);
        return res.json({ success: true, message: 'Request rejected. The senior has been notified.' });
    } catch (err) {
        console.error('Reactivation review error:', err);
        return res.status(500).json({ success: false, message: 'Failed to review the request.' });
    }
});

// --- API: Senior polls their reactivation request status (public — minimal safe fields) ---
// The waiting screen calls this every few seconds after submitting the face scan,
// so the senior sees the staff decision (approved / not approved) without refreshing.
app.get('/api/reactivation/status', async (req, res) => {
    try {
        const seniorId = String((req.query && req.query.seniorId) || '').trim();
        if (!seniorId) return res.status(400).json({ success: false, message: 'Senior ID is required.' });
        const usersSnap = await admin.database().ref('users').orderByChild('role').equalTo('senior').once('value');
        const users = usersSnap.val() || {};
        const normId = seniorId.toUpperCase();
        let uid = '';
        for (const [key, rec] of Object.entries(users)) {
            if (String(rec.seniorId || '').trim().toUpperCase() === normId) { uid = key; break; }
        }
        if (!uid) return res.json({ success: true, status: 'None' });
        const snap = await admin.database().ref(`reactivationRequests/${uid}`).once('value');
        if (!snap.exists() || !snap.val()) return res.json({ success: true, status: 'None' });
        const rec = snap.val();
        return res.json({
            success: true,
            status: rec.status || 'Pending',
            requestedAt: rec.requestedAt || null,
            reviewedAt: rec.reviewedAt || null,
            reviewNote: rec.status === 'Rejected' ? (rec.reviewNote || '') : ''
        });
    } catch (err) {
        console.error('Reactivation status error:', err);
        return res.status(500).json({ success: false, message: 'Failed to check reactivation status.' });
    }
});

// --- API: Request a password reset link (public — no authentication) ---

// --- API: Request a password reset link (public — no authentication) ---
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    // Identical response whether or not the account exists (prevents account enumeration)
    const generic = { success: true, message: 'If an admin account with this email exists, a password reset link has been sent. Please check your inbox.' };

    try {
        const normEmail = String(email).trim().toLowerCase();

        // Rate-limit reset requests per email
        const lastSent = resetRequestStore.get(normEmail);
        if (lastSent && (Date.now() - lastSent) < RESET_REQUEST_COOLDOWN_MS) {
            const waitSec = Math.ceil((RESET_REQUEST_COOLDOWN_MS - (Date.now() - lastSent)) / 1000);
            return res.status(429).json({ success: false, message: `Please wait ${waitSec}s before requesting another reset link.` });
        }

        // Look up the account — reset links are only issued to ADMIN accounts
        const snap = await admin.database().ref('users').once('value');
        const users = snap.val() || {};
        let targetUid = null, targetEmail = null;
        for (const [uid, u] of Object.entries(users)) {
            if (u && u.role === 'admin' && String(u.email || '').trim().toLowerCase() === normEmail) {
                targetUid = uid;
                targetEmail = String(u.email).trim();
                break;
            }
        }

        if (!targetUid) return res.json(generic);

        // Issue a single-use reset token
        const token = crypto.randomBytes(32).toString('hex');
        passwordResetStore.set(token, { uid: targetUid, email: targetEmail, expiresAt: Date.now() + RESET_TOKEN_TTL_MS });
        resetRequestStore.set(normEmail, Date.now());

        const resetLink = `${getPublicBaseUrl(req)}/reset-password?token=${token}`;

        await sendEmail({
            to: targetEmail,
            subject: 'SilverCare Admin — Password Reset Link',
            html: passwordResetEmailTemplate(resetLink)
        });

        await writeAuditLog('PASSWORD_RESET_REQUESTED', { uid: targetUid, role: 'admin', email: targetEmail }, targetUid, null, 'Password reset link e-mailed');
        res.json(generic);
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ success: false, message: 'Failed to send the reset link. Please try again.' });
    }
});

// --- API: Validate a reset token (used by the /reset-password page on load) ---
app.get('/api/reset-password/validate', (req, res) => {
    const token = String(req.query.token || '');
    const entry = passwordResetStore.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
        if (entry) passwordResetStore.delete(token);
        return res.json({ valid: false, message: 'This reset link is invalid or has expired. Please request a new one.' });
    }
    res.json({ valid: true, email: entry.email });
});

// --- API: Complete the password reset with a valid token ---
app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ success: false, message: 'Reset token and new password are required.' });
    if (String(newPassword).length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });

    try {
        const entry = passwordResetStore.get(String(token));
        if (!entry || Date.now() > entry.expiresAt) {
            if (entry) passwordResetStore.delete(String(token));
            return res.status(400).json({ success: false, message: 'This reset link is invalid or has expired. Please request a new one.' });
        }

        // Update the password through the Firebase Admin SDK
        await admin.auth().updateUser(entry.uid, { password: String(newPassword) });
        passwordResetStore.delete(String(token)); // single use

        await writeAuditLog('PASSWORD_RESET_COMPLETED', { uid: entry.uid, role: 'admin', email: entry.email }, entry.uid, null, 'Password changed via e-mailed reset link');

        // Best-effort confirmation email (non-blocking)
        sendEmail({
            to: entry.email,
            subject: 'SilverCare Admin — Your Password Was Changed',
            html: `<div style="font-family:'Inter',Arial,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                <div style="background: linear-gradient(135deg, #1e3a8a, #2563eb); padding: 25px; text-align: center;">
                    <h1 style="color: white; margin: 0; font-size: 1.3rem;">SilverCare</h1>
                </div>
                <div style="padding: 25px;">
                    <h2 style="color: #1e293b; margin-top: 0;">Password Updated</h2>
                    <p style="color: #64748b; line-height: 1.6;">Your SilverCare admin account password was changed successfully. If this was not you, please contact the OSCA office immediately.</p>
                    <p style="color: #94a3b8; font-size: 0.8rem;">${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} (Philippine Standard Time)</p>
                </div>
            </div>`
        }).catch(err => console.error('Password-changed email failed:', err && err.message ? err.message : err));

        res.json({ success: true, message: 'Your password has been updated. You can now log in with your new password.' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'Failed to update the password. Please try again.' });
    }
});

// ============================================================
// Duplicate Record Detection
// A senior is considered a duplicate when the SAME Senior ID
// already exists, OR the same normalized first+last name AND
// date of birth already exist. Prevents double registration so
// each senior citizen is listed only once in the system.
// ============================================================
function normalizeNameStr(s) {
    return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

async function findDuplicateSeniorRecord({ seniorId, firstName, lastName, dob }) {
    const normId = String(seniorId || '').trim().toUpperCase();
    const normFirst = normalizeNameStr(firstName);
    const normLast = normalizeNameStr(lastName);
    const normDob = String(dob || '').trim();

    if (!normId && !(normFirst && normLast && normDob)) return null;

    const snap = await admin.database().ref('users').orderByChild('role').equalTo('senior').once('value');
    const users = snap.val() || {};
    for (const [uid, u] of Object.entries(users)) {
        if (normId && String(u.seniorId || '').trim().toUpperCase() === normId) {
            return { uid, matchedBy: 'seniorId', name: u.name || 'Unknown', seniorId: u.seniorId };
        }
        if (normFirst && normLast && normDob &&
            normalizeNameStr(u.firstName) === normFirst &&
            normalizeNameStr(u.lastName) === normLast &&
            String(u.dob || '').trim() === normDob) {
            return { uid, matchedBy: 'name+dob', name: u.name || 'Unknown', seniorId: u.seniorId || '' };
        }
    }
    return null;
}

// --- API: Live duplicate check used by the registration form ---
app.post('/api/check-senior-duplicate', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const dup = await findDuplicateSeniorRecord(req.body || {});
        if (dup) {
            return res.json({
                success: true,
                duplicate: true,
                matchedBy: dup.matchedBy,
                existingName: dup.name,
                existingSeniorId: dup.seniorId || ''
            });
        }
        res.json({ success: true, duplicate: false });
    } catch (error) {
        console.error('Duplicate check error:', error);
        res.status(500).json({ success: false, message: 'Failed to run duplicate check.' });
    }
});

// --- Senior ID uniqueness helper (shared by both duplicate checks) ---
// Case/whitespace-insensitive match on seniorId AND verificationSeniorId
// (the latter catches IDs still going through verification).
async function isSeniorIdTaken(normId, ignoreUid) {
    const id = String(normId || '').trim().toUpperCase();
    if (!id) return false;
    const snap = await admin.database().ref('users').orderByChild('role').equalTo('senior').once('value');
    const users = snap.val() || {};
    for (const [uid, u] of Object.entries(users)) {
        if (ignoreUid && uid === ignoreUid) continue;
        if (String(u.seniorId || '').trim().toUpperCase() === id) return true;
        if (String(u.verificationSeniorId || '').trim().toUpperCase() === id) return true;
    }
    return false;
}

// --- API: Senior self-check — is this Senior ID already used by someone else? ---
// Senior role may call this during verification. Returns ONLY a boolean —
// never the other account's name, uid, or any personal detail.
app.post('/api/check-senior-id', requireAuth, requireRole('senior'), async (req, res) => {
    try {
        const normId = String((req.body || {}).seniorId || '').trim().toUpperCase();
        if (!normId) return res.json({ success: true, taken: false });
        const taken = await isSeniorIdTaken(normId, req.authUser.uid);
        res.json({ success: true, taken });
    } catch (error) {
        console.error('Senior ID check error:', error);
        res.status(500).json({ success: false, message: 'Failed to check Senior ID.' });
    }
});

// --- API: Public duplicate Senior ID check (used by the signup form) ---
// A senior is NOT logged in yet at signup, so this endpoint is public.
// It answers taken:true/false ONLY and is rate-limited per IP so valid
// Senior IDs cannot simply be enumerated.
const ID_CHECK_WINDOW_MS = 60 * 1000;
const ID_CHECK_LIMIT = 20;
const idCheckBuckets = new Map();
function idCheckAllowed(ip) {
    const now = Date.now();
    const key = String(ip || 'unknown');
    const recent = (idCheckBuckets.get(key) || []).filter(t => now - t < ID_CHECK_WINDOW_MS);
    recent.push(now);
    idCheckBuckets.set(key, recent);
    return recent.length <= ID_CHECK_LIMIT;
}
app.post('/api/check-senior-id-public', async (req, res) => {
    try {
        const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
        if (!idCheckAllowed(ip)) {
            return res.status(429).json({ success: false, message: 'Too many checks. Please wait a moment and try again.' });
        }
        const normId = String((req.body || {}).seniorId || '').trim().toUpperCase();
        if (!normId) return res.json({ success: true, taken: false });
        const taken = await isSeniorIdTaken(normId, null);
        res.json({ success: true, taken });
    } catch (error) {
        console.error('Public Senior ID check error:', error);
        res.status(500).json({ success: false, message: 'Failed to check Senior ID.' });
    }
});

// --- API: Verify Login (server-side user data lookup) ---
app.post('/api/verify-login', async (req, res) => {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ success: false, message: 'ID token is required.' });

    try {
        // Verify the Firebase ID token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodedToken.uid;

        // Read user profile from RTDB using Admin SDK (bypasses security rules)
        const userSnap = await admin.database().ref(`users/${uid}`).once('value');

        if (!userSnap.exists()) {
            return res.json({ success: false, message: 'Your user profile was not found in the database. Please contact an administrator.', code: 'profile-not-found' });
        }

        const userData = userSnap.val() || {};

        // Deceased gate: the archived account of a senior who passed away can
        // never log in again, even with a still-valid token. The message below
        // is shown by the login screen (see public/js/main.js).
        if (String(userData.lifeStatus || '') === 'Deceased' || String(userData.status || '') === 'Deceased') {
            return res.json({ success: false, message: 'This senior have passed away, please go to OSCA if you think this is an error', code: 'account-deceased' });
        }

        // Check maintenance mode for non-admins
        let maintenanceMode = false;
        if (userData.role !== 'admin') {
            const maintenanceSnap = await admin.database().ref('system/settings/maintenanceMode').once('value');
            maintenanceMode = maintenanceSnap.exists() && maintenanceSnap.val() === true;
        }

        res.json({
            success: true,
            user: {
                uid: uid,
                email: userData.email,
                name: userData.name,
                role: userData.role,
                status: userData.status
            },
            maintenanceMode: maintenanceMode
        });
    } catch (error) {
        console.error('Verify login error:', error);
        res.status(401).json({ success: false, message: 'Invalid or expired authentication token.' });
    }
});

// --- Manual Senior Registration (Employee-assisted) ---
app.post('/api/register-senior', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const { email, password, fullname, firstName, middleName, lastName, extension, seniorId, address, barangay, postalCode, citizenship, cpNumber, dob, sex, civilStatus, faceImage, registeredBy } = req.body;
        // Fixed service area: Magalang, Pampanga only.
        const city = 'Magalang';
        const province = 'Pampanga';
        const MAGALANG_BARANGAYS = ['AYALA','BUCANAN','CAMIAS','DOLORES','ESCALER','LAPAZ','NAVALING','SAN AGUSTIN','SAN ANTONIO','SAN FRANCISCO','SAN ILDEFONSO','SAN ISIDRO','SAN JOSE','SAN MIGUEL','SAN NICOLAS 1','SAN NICOLAS 2','SAN PABLO','SAN PEDRO 1','SAN PEDRO 2','SAN ROQUE','SAN VICENTE','STA. CRUZ','STA. LUCIA','STA. MARIA','STO. NIÑO','STO. ROSARIO','TURU'];
        if (!barangay || !MAGALANG_BARANGAYS.includes(String(barangay).trim())) {
            return res.json({ success: false, message: 'Please select a valid Magalang barangay.' });
        }

        if (!email || !password || !firstName || !lastName || !seniorId) {
            return res.json({ success: false, message: 'Email, password, first name, last name, and Senior ID are required.' });
        }

        if (!faceImage) {
            return res.json({ success: false, message: 'Face scan image is required.' });
        }

        if (password.length < 6) {
            return res.json({ success: false, message: 'Password must be at least 6 characters.' });
        }

        // Duplicate record detection — each senior may be registered only once.
        const duplicate = await findDuplicateSeniorRecord({ seniorId, firstName, lastName, dob });
        if (duplicate) {
            const reason = duplicate.matchedBy === 'seniorId'
                ? `A senior citizen with Senior ID "${seniorId}" is already registered`
                : `A senior citizen with the same name and date of birth is already registered`;
            return res.json({
                success: false,
                duplicate: true,
                message: `${reason} (${duplicate.name}${duplicate.seniorId ? ', ID ' + duplicate.seniorId : ''}). Duplicate records are not allowed.`
            });
        }

        // Create Firebase Auth account using Admin SDK
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            displayName: fullname || `${firstName} ${lastName}`
        });

        // Derive age from DOB and assign the age-based milestone senior category ONLY
        // at the exact milestone ages (80/85 Octogenarian, 90/95 Nonagenarian,
        // 100 Centenarian) — matching the senior self-KYC flow. Any other age is
        // registered as a plain verified senior with no category.
        const derivedAge = computeAgeFromDob(dob);
        const seniorCategory = (derivedAge === 80 || derivedAge === 85) ? 'Octogenarian'
            : (derivedAge === 90 || derivedAge === 95) ? 'Nonagenarian'
            : (derivedAge === 100) ? 'Centenarian'
            : '';

        // Save to Realtime Database as Active (no approval needed — employee-registered)
        await admin.database().ref('users/' + userRecord.uid).set({
            email: email,
            name: fullname || `${firstName} ${lastName}`,
            firstName: firstName || '',
            middleName: middleName || '',
            lastName: lastName || '',
            extension: extension || '',
            role: 'senior',
            status: 'Active',
            seniorId: seniorId,
            address: address || '',
            barangay: String(barangay).trim(),
            city: city || '',
            province: province || '',
            postalCode: postalCode || '',
            citizenship: citizenship || '',
            cpNumber: cpNumber || '',
            dob: dob || '',
            age: derivedAge || '',
            seniorCategory: seniorCategory || '',
            seniorCategoryAssignedAt: seniorCategory ? Date.now() : null,
            sex: sex || '',
            civilStatus: civilStatus || '',
            kycFaceImage: faceImage,
            kycStatus: 'Verified',
            kycVerifiedAt: Date.now(),
            verifiedBy: registeredBy || 'Employee',
            emailVerified: true,
            registeredBy: registeredBy || 'Employee',
            registrationMethod: 'walk-in',
            createdAt: Date.now()
        });

        // Accountability: record WHO registered this senior.
        await writeAuditLog('REGISTER_SENIOR_RECORD', req.authUser, userRecord.uid, null,
            `Registered senior "${fullname || `${firstName} ${lastName}`}" (Senior ID: ${seniorId}) via walk-in registration`);

        // Mirror the senior's identity data to the Supabase store
        // (username, senior ID, face image, ID number). Best-effort:
        // Firebase RTDB remains the source of truth if Supabase is down.
        if (seniorStore.isSyncEnabled()) {
            seniorStore.syncSeniorRecord(userRecord.uid, {
                email,
                name: fullname || `${firstName} ${lastName}`,
                firstName, lastName, seniorId,
                verificationSeniorId: seniorId,
                cpNumber, address, barangay, city, province,
                dob, sex, civilStatus,
                kycStatus: 'Verified',
                lifeStatus: 'Active',
                registeredBy: registeredBy || 'Employee'
            }, faceImage).then(result => {
                if (result && result.synced) console.log(`Senior "${seniorId}" mirrored to Supabase (face: ${result.facePath || 'n/a'}).`);
            }).catch(err => console.error('Supabase senior mirror failed (registration):', err.message));
        }

        // Pension approval SMS (TextBee): a walk-in account is created already
        // VERIFIED with an auto-activated pension, so the senior is told about
        // the pension approval right away. Read the live global amounts so the
        // notice matches what was actually applied (never announce a pension
        // the senior is not receiving). Fire-and-forget — the gateway is
        // best-effort and must never delay or break the creation.
        let smsLocal = '1000', smsNational = '3000';
        try {
            const settingsSnap = await admin.database().ref('pensionSettings').once('value');
            const s = settingsSnap.exists() ? (settingsSnap.val() || {}) : {};
            smsLocal = String(Math.round(Number(s.local)) || 1000);
            smsNational = String(Math.round(Number(s.national)) || 3000);
        } catch (settingsErr) {
            console.warn('Pension settings unavailable for walk-in SMS, using defaults:', settingsErr.message);
        }
        notifySeniorSms(userRecord.uid, 'pension_approved', {
            localAmount: smsLocal,
            nationalAmount: smsNational,
            quarterlyTotal: String((Number(smsLocal) || 0) * 3 + (Number(smsNational) || 0))
        }).catch(err => console.warn('Pension approval SMS skipped:', err.message));

        res.json({ success: true, message: 'Senior citizen account created successfully.', uid: userRecord.uid });
    } catch (error) {
        console.error('Register senior error:', error);
        let msg = 'Failed to create account.';
        if (error.code === 'auth/email-already-exists') {
            msg = 'This email address is already registered in the system.';
        } else if (error.code === 'auth/invalid-email') {
            msg = 'The email address format is invalid.';
        } else if (error.code === 'auth/weak-password') {
            msg = 'Password is too weak. Use at least 6 characters.';
        }
        res.json({ success: false, message: msg });
    }
});

// ============================================================
// Supabase Senior Data Mirror
// Firebase RTDB = single source of truth. This endpoint mirrors a
// senior's core identity data (username, senior ID, face image, ID
// number) into the Supabase "seniors" table + private face bucket.
//   - admin/employee : may sync any senior record
//   - senior         : may sync only their OWN record
// Used by client-side flows that write to RTDB directly (admin
// quick face-register, senior self-KYC, employee KYC review).
// ============================================================
app.post('/api/supabase/sync-senior', requireAuth, async (req, res) => {
    const { uid, faceImage, idFrontImage, idBackImage, medCertImage, medCertName, medCertType, healthCondition } = req.body || {};
    const actor = req.authUser;
    try {
        if (!uid) return res.status(400).json({ success: false, message: 'uid is required.' });
        if (actor.role === 'senior' && actor.uid !== uid) {
            return res.status(403).json({ success: false, message: 'You may only sync your own record.' });
        }
        if (!['admin', 'employee', 'senior'].includes(actor.role)) {
            return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
        }
        if (!seniorStore.isSyncEnabled()) {
            return res.status(503).json({
                success: false,
                disabled: true,
                message: 'Supabase is not configured. Ask the administrator to set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
            });
        }

        const snap = await admin.database().ref(`users/${uid}`).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Senior record not found.' });
        const user = snap.val();
        if (user.role && user.role !== 'senior') {
            return res.status(400).json({ success: false, message: 'Only senior citizen records are mirrored to Supabase.' });
        }

        const face = faceImage || user.kycFaceImage || user.faceImage || null;
        const front = idFrontImage || user.kycIdFrontImage || null;
        const back = idBackImage || user.kycIdBackImage || null;
        const result = await seniorStore.syncSeniorRecord(uid, user, face, front, back, { medCertImage: medCertImage || user.kycMedCertImage || null, medCertName: medCertName || user.kycMedCertName || '', medCertType: medCertType || user.kycMedCertType || '', healthCondition: healthCondition || user.healthCondition || '' });
        await writeAuditLog('SUPABASE_SENIOR_MIRRORED', actor, uid, null,
            `Senior record mirrored to Supabase (face: ${result.facePath || 'none'}, ID front: ${result.idFrontPath || 'none'}, ID back: ${result.idBackPath || 'none'}, med-cert: ${result.medCertPath || 'none'})`);
        // Persist the durable storage path back to the Firebase record so the
        // medical certification can still be re-opened by staff later, even
        // after the bulky base64 copy (kycMedCertImage) is removed.
        if (result && result.medCertPath && result.medCertPath !== user.kycMedCertPath) {
            try {
                await admin.database().ref(`users/${uid}/kycMedCertPath`).set(result.medCertPath);
            } catch (e) { console.warn('kycMedCertPath write-back skipped:', e.message); }
        }
        res.json({ success: true, facePath: result.facePath, idFrontPath: result.idFrontPath, idBackPath: result.idBackPath, medCertPath: result.medCertPath, migratedHint: result.migratedHint || null, message: 'Senior record mirrored to Supabase (personal info + face + health + Senior ID back-to-back + med cert).' + (result.migratedHint ? ' Note: ' + result.migratedHint : '') });
    } catch (error) {
        console.error('Supabase senior mirror error:', error);
        res.status(500).json({ success: false, message: 'Failed to mirror senior record to Supabase: ' + error.message });
    }
});
// ============================================================
// Health Records (Consent-Gated / RBAC / Audit-Trail)
// Per Data Privacy Act of 2012 (RA 10173):
//   - Health records are highly sensitive personal information.
//   - Access is ONLY granted after the senior (or authorized
//     guardian) has explicitly granted consent via the client.
//   - Only admin/staff may write; seniors may only read their
//     OWN records. Viewing or editing is always logged.
//   - Recovery plan status is tracked per senior for continuity
//     of care across all affiliated Barangay Health Centers.
// Firebase RTDB = single source of truth.
// ============================================================
const DEFAULT_HEALTH_CONSENT_MESSAGE =
    'I hereby give my consent for SilverCare / OSCA Magalang to ' +
    'collect, store, and securely share my personal health records ' +
    'with authorized Barangay Health Center personnel for the purpose ' +
    'of medical assistance, health monitoring, and continuity of care. ' +
    'I understand that I may withdraw this consent at any time.';

// --- API: Get health records (consent-gated; seniors read-only own) ---
app.get('/api/health-records/:uid', requireAuth, async (req, res) => {
    const { uid } = req.params;
    const actor = req.authUser;
    try {
        if (actor.role === 'senior' && actor.uid !== uid) {
            return res.status(403).json({ success: false, message: 'You may only view your own health records.' });
        }
        const actorRole = actor.role;
        if (actorRole !== 'admin' && actorRole !== 'employee' && actorRole !== 'senior') {
            return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
        }

        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior citizen record not found.' });
        const user = userSnap.val();

        const hasConsent = !!(user.healthConsent && user.healthConsent.granted);
        if (!hasConsent) {
            await writeAuditLog('HEALTH_ACCESS_DENIED_NO_CONSENT', actor, uid, null,
                `Attempted access to health records — consent not granted`);
            return res.status(403).json({
                success: false,
                message: 'Health records are blocked until the senior citizen has granted consent.',
                requiresConsent: true
            });
        }

        await writeAuditLog('HEALTH_RECORDS_VIEWED', actor, uid, null,
            `Health records viewed by ${actorRole} ${actor.name || actor.email || 'Unknown'}`);

        const recordsSnap = await admin.database().ref(`users/${uid}/healthRecords`).once('value');
        const records = recordsSnap.val() || {};

        const out = {
            success: true,
            consent: user.healthConsent || null,
            records: Object.entries(records).map(([key, r]) => ({ id: key, ...r })),
            affiliatedCenters: (user.affiliatedHealthCenters || []),
            recoveryPlan: (user.recoveryPlan || null)
        };
        res.json(out);
    } catch (error) {
        console.error('Health records error:', error);
        res.status(500).json({ success: false, message: 'Failed to load health records.' });
    }
});

// Basic routing for pages

// ============================================================
// --- API: Add a health record (admin/staff only; consent must exist) ---
app.post('/api/health-records/add', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid, type, title, description, provider, recordedAt, attachments } = req.body;
    const actor = req.authUser;
    try {
        if (!uid || !type) return res.status(400).json({ success: false, message: 'uid and type are required.' });
        const validTypes = ['checkup', 'diagnosis', 'medication', 'vaccination', 'lab_result', 'referral', 'treatment', 'vitals', 'other'];
        const typeLower = String(type).toLowerCase();
        if (!validTypes.includes(typeLower)) return res.status(400).json({ success: false, message: 'Invalid health record type. Allowed: ' + validTypes.join(', ') });

        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior citizen record not found.' });
        const user = userSnap.val();

        const hasConsent = !!(user.healthConsent && user.healthConsent.granted);
        if (!hasConsent) {
            return res.status(403).json({ success: false, message: 'Cannot add health records — senior has not granted consent.' });
        }

        const recordRef = admin.database().ref(`users/${uid}/healthRecords`).push();
        const record = {
            id: recordRef.key,
            type: typeLower,
            title: String(title || '').slice(0, 120) || type,
            description: String(description || '').slice(0, 2000) || null,
            provider: String(provider || '').slice(0, 120) || null,
            recordedAt: recordedAt ? Number(recordedAt) : Date.now(),
            attachments: Array.isArray(attachments) ? attachments.slice(0, 10) : [],
            recordedBy: actor.uid,
            recordedByName: actor.name || actor.email || 'OSCA Staff',
            recordedAt: Date.now()
        };
        await recordRef.set(record);
        await writeAuditLog('HEALTH_RECORD_ADDED', actor, uid, recordRef.key,
            `Added ${type} record: ${record.title}`);

        res.json({ success: true, message: 'Health record added.', recordId: recordRef.key });
    } catch (error) {
        console.error('Add health record error:', error);
        res.status(500).json({ success: false, message: 'Failed to add health record.' });
    }
});

// --- API: Update a health record (admin/staff only; audit-logged) ---
app.put('/api/health-records/:uid/:recordId', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid, recordId } = req.params;
    const { title, description, provider, recordedAt, status } = req.body;
    const actor = req.authUser;
    try {
        const recordRef = admin.database().ref(`users/${uid}/healthRecords/${recordId}`);
        const snap = await recordRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Health record not found.' });

        const updates = {};
        if (title !== undefined) updates.title = String(title).slice(0, 120);
        if (description !== undefined) updates.description = String(description).slice(0, 2000);
        if (provider !== undefined) updates.provider = String(provider).slice(0, 120);
        if (recordedAt !== undefined) updates.recordUpdatedAt = Number(recordedAt);
        if (status !== undefined) updates.status = String(status).slice(0, 40);

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ success: false, message: 'No fields to update.' });
        }
        updates.editedBy = actor.uid;
        updates.editedByName = actor.name || actor.email || 'OSCA Staff';
        updates.editedAt = Date.now();

        await recordRef.update(updates);
        await writeAuditLog('HEALTH_RECORD_EDITED', actor, uid, recordId,
            `Edited health record: ${updates.title || '(title unchanged)'}`);

        res.json({ success: true, message: 'Health record updated.' });
    } catch (error) {
        console.error('Edit health record error:', error);
        res.status(500).json({ success: false, message: 'Failed to update health record.' });
    }
});

// --- API: Grant / withdraw health consent (senior only, on own account) ---
app.post('/api/health-consent', requireAuth, requireRole('senior'), async (req, res) => {
    const { grant, message } = req.body;
    const actor = req.authUser;
    try {
        const grantBool = grant === true || grant === 'true' || grant === 1;
        const updates = {
            'healthConsent.granted': grantBool,
            'healthConsent.seniorUid': actor.uid,
            'healthConsent.grantedAt': Date.now(),
            'healthConsent.message': String(message || DEFAULT_HEALTH_CONSENT_MESSAGE).slice(0, 2000),
            'healthConsent.withdrawnAt': grantBool ? null : Date.now()
        };
        await admin.database().ref(`users/${actor.uid}`).update(updates);
        const action = grantBool ? 'HEALTH_CONSENT_GRANTED' : 'HEALTH_CONSENT_WITHDRAWN';
        await writeAuditLog(action, actor, actor.uid, null,
            grantBool ? 'Senior granted consent to share health records' : 'Senior withdrew consent for health records');

        res.json({ success: true, message: grantBool ? 'Health consent granted.' : 'Health consent withdrawn.' });
    } catch (error) {
        console.error('Health consent error:', error);
        res.status(500).json({ success: false, message: 'Failed to update health consent.' });
    }
});

// --- API: Get health consent status (any authenticated user; own or staff for any) ---
app.get('/api/health-consent/:uid', requireAuth, async (req, res) => {
    const { uid } = req.params;
    const actor = req.authUser;
    try {
        if (actor.role === 'senior' && actor.uid !== uid) {
            return res.status(403).json({ success: false, message: 'You may only check your own consent status.' });
        }
        const snap = await admin.database().ref(`users/${uid}/healthConsent`).once('value');
        if (!snap.exists()) return res.json({ success: true, granted: false });
        res.json({ success: true, granted: snap.val().granted, ...snap.val() });
    } catch (error) {
        console.error('Health consent status error:', error);
        res.status(500).json({ success: false, message: 'Failed to load consent status.' });
    }
});

// --- Seed default health consent disclaimer (no-op if already present) ---
async function seedHealthConsentDefaults() {
    try {
        const snap = await admin.database().ref('system/healthConsentDefaults').once('value');
        if (snap.exists()) return;
        await admin.database().ref('system/healthConsentDefaults').set({
            message: DEFAULT_HEALTH_CONSENT_MESSAGE,
            version: 1,
            policy: 'Data Privacy Act of 2012 (RA 10173)',
            createdAt: Date.now()
        });
    } catch (e) { /* non-fatal */ }
}
seedHealthConsentDefaults();

// --- API: Delete a health record (admin/staff only; soft-audit-logged) ---
app.delete('/api/health-records/:uid/:recordId', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid, recordId } = req.params;
    const actor = req.authUser;
    try {
        const recordRef = admin.database().ref(`users/${uid}/healthRecords/${recordId}`);
        const snap = await recordRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Health record not found.' });
        const record = snap.val();

        await writeAuditLog('HEALTH_RECORD_DELETED', actor, uid, recordId,
            `Deleted health record "${record.title || 'Untitled'}" (type: ${record.type})`);
        await recordRef.remove();

        res.json({ success: true, message: 'Health record removed.' });
    } catch (error) {
        console.error('Delete health record error:', error);
        res.status(500).json({ success: false, message: 'Failed to remove health record.' });
    }
});

// --- API: Get priority score for a senior (decision SUPPORT only)
// Frontend uses the SAME rules as this endpoint for live preview.
// This endpoint is the server-side source of truth for priority.
// NEVER auto-approves or auto-rejects; only computes + explains.
app.get('/api/priority/:uid', requireAuth, async (req, res) => {
    const { uid } = req.params;
    const actor = req.authUser;
    try {
        if (actor.role !== 'admin' && actor.role !== 'employee') {
            return res.status(403).json({ success: false, message: 'Admin or staff only.' });
        }
        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior not found.' });
        const user = userSnap.val();
        const priority = priorityEngine.computePriority(user);
        await writeAuditLog('PRIORITY_SCORE_VIEWED', actor, uid, null,
            `Priority score ${priority.level} (${priority.score}/${priority.weight}) viewed by ${actor.role}`);
        res.json({ success: true, ...priority });
    } catch (error) {
        console.error('Priority score error:', error);
        res.status(500).json({ success: false, message: 'Failed to compute priority score.' });
    }
});

// Senior Citizen ID Document Vault (Supabase Storage)
// Firebase RTDB = source of truth (metadata + status).
// Supabase = private file storage ONLY, two status folders:
//   pending/{seniorUid}/...  -> awaiting OSCA verification
//   verified/{seniorUid}/... -> approved by OSCA staff
// Every access is permission-checked and written to auditLogs.
// ============================================================

async function writeAuditLog(action, actor, targetUid, docId, detail) {
    try {
        // Bounded: a slow/unreachable RTDB must never delay the HTTP response
        // it is attached to (2FA, login, status updates...).
        await withServerTimeout(admin.database().ref('auditLogs').push({
            action: action,
            actorUid: actor.uid,
            actorRole: actor.role,
            actorName: actor.name || actor.email || 'Unknown',
            targetUid: targetUid || null,
            docId: docId || null,
            detail: detail || null,
            timestamp: Date.now()
        }), AUDIT_LOG_TIMEOUT_MS, 'Audit log write');
    } catch (e) {
        console.error('Audit log write failed:', e.message);
    }
}

function vaultDisabled(res) {
    return res.status(503).json({ success: false, message: 'ID document vault is not configured. Ask the administrator to set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
}

// --- Upload a Senior ID document (senior uploads own; staff may upload on behalf) ---
app.post('/api/senior-id/upload', requireAuth, async (req, res) => {
    if (!idVault.isVaultEnabled()) return vaultDisabled(res);
    try {
        const { targetUid, fileName, mimeType, fileBase64 } = req.body;
        const actor = req.authUser;

        // Determine the owning senior. Seniors may only upload for themselves.
        let ownerUid;
        if (actor.role === 'senior') {
            if (targetUid && targetUid !== actor.uid) {
                return res.status(403).json({ success: false, message: 'You can only upload documents for your own account.' });
            }
            ownerUid = actor.uid;
        } else if (actor.role === 'admin' || actor.role === 'employee') {
            if (!targetUid) return res.status(400).json({ success: false, message: 'targetUid of the senior citizen is required.' });
            ownerUid = targetUid;
        } else {
            return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
        }

        if (!fileName || !mimeType || !fileBase64) {
            return res.status(400).json({ success: false, message: 'fileName, mimeType, and fileBase64 are required.' });
        }

        // The owner must be an existing senior record.
        const ownerSnap = await admin.database().ref(`users/${ownerUid}`).once('value');
        if (!ownerSnap.exists() || ownerSnap.val().role !== 'senior') {
            return res.status(404).json({ success: false, message: 'Senior citizen account not found.' });
        }

        const decoded = idVault.decodeDocumentPayload(mimeType, fileBase64);
        if (decoded.error) return res.status(400).json({ success: false, message: decoded.error });

        const docId = admin.database().ref(`users/${ownerUid}/idDocuments`).push().key;
        const storagePath = idVault.buildStoragePath('pending', ownerUid, docId, fileName);

        // 1) Store the physical file first (Supabase, private bucket, pending folder)
        await idVault.uploadDocument(storagePath, decoded.buffer, mimeType);

        // 2) Mirror the metadata into Firebase (source of truth)
        await admin.database().ref(`users/${ownerUid}/idDocuments/${docId}`).set({
            docId: docId,
            storagePath: storagePath,
            folder: 'pending',
            originalName: String(fileName).slice(0, 120),
            mimeType: mimeType,
            size: decoded.buffer.length,
            status: 'Pending',
            uploadedBy: actor.uid,
            uploadedByName: actor.name || actor.email || 'Unknown',
            uploadedAt: Date.now()
        });

        await writeAuditLog('UPLOAD_ID_DOCUMENT', actor, ownerUid, docId, `File "${fileName}" uploaded to pending/`);

        res.json({ success: true, message: 'ID document uploaded and is now pending verification.', docId: docId });
    } catch (error) {
        console.error('Senior ID upload error:', error);
        res.status(500).json({ success: false, message: 'Failed to upload the ID document: ' + error.message });
    }
});

// --- Review a Senior ID document (approve = move pending/ -> verified/, reject = delete file) ---
app.post('/api/senior-id/review', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    if (!idVault.isVaultEnabled()) return vaultDisabled(res);
    try {
        const { targetUid, docId, decision, notes } = req.body;
        const actor = req.authUser;

        if (!targetUid || !docId || !['Verified', 'Rejected'].includes(decision)) {
            return res.status(400).json({ success: false, message: 'targetUid, docId, and decision (Verified | Rejected) are required.' });
        }

        const docRef = admin.database().ref(`users/${targetUid}/idDocuments/${docId}`);
        const docSnap = await docRef.once('value');
        if (!docSnap.exists()) {
            return res.status(404).json({ success: false, message: 'ID document not found.' });
        }
        const doc = docSnap.val();
        if (doc.status !== 'Pending') {
            return res.status(409).json({ success: false, message: `This document was already reviewed (${doc.status}).` });
        }

        if (decision === 'Verified') {
            // Move the physical file to the verified folder BEFORE touching Firebase.
            const verifiedPath = idVault.buildStoragePath('verified', targetUid, docId, doc.originalName);
            await idVault.moveDocument(doc.storagePath, verifiedPath);
            await docRef.update({
                status: 'Verified',
                folder: 'verified',
                storagePath: verifiedPath,
                reviewedBy: actor.uid,
                reviewedByName: actor.name || actor.email || 'Unknown',
                reviewedAt: Date.now(),
                reviewNotes: notes || null
            });
        } else {
            // Rejected: remove the sensitive file entirely, keep only the audit trail.
            await idVault.deleteDocument(doc.storagePath);
            await docRef.update({
                status: 'Rejected',
                folder: null,
                storagePath: null,
                reviewedBy: actor.uid,
                reviewedByName: actor.name || actor.email || 'Unknown',
                reviewedAt: Date.now(),
                reviewNotes: notes || null
            });
        }

        await writeAuditLog('REVIEW_ID_DOCUMENT', actor, targetUid, docId, `Decision: ${decision}${notes ? ' — ' + notes : ''}`);

        res.json({ success: true, message: `Document ${decision.toLowerCase()} successfully.` });
    } catch (error) {
        console.error('Senior ID review error:', error);
        res.status(500).json({ success: false, message: 'Failed to review the ID document: ' + error.message });
    }
});

// --- View a Senior ID document (owner or staff) via short-lived signed URL ---
app.get('/api/senior-id/view/:uid/:docId', requireAuth, async (req, res) => {
    if (!idVault.isVaultEnabled()) return vaultDisabled(res);
    try {
        const { uid, docId } = req.params;
        const actor = req.authUser;

        const isOwner = actor.uid === uid;
        const isStaff = actor.role === 'admin' || actor.role === 'employee';
        if (!isOwner && !isStaff) {
            return res.status(403).json({ success: false, message: 'You are not allowed to view this document.' });
        }

        const docSnap = await admin.database().ref(`users/${uid}/idDocuments/${docId}`).once('value');
        if (!docSnap.exists() || !docSnap.val().storagePath) {
            return res.status(404).json({ success: false, message: 'ID document not found or no longer stored.' });
        }
        const doc = docSnap.val();

        const signedUrl = await idVault.createViewLink(doc.storagePath);

        // Privacy compliance: record WHO viewed WHICH senior's ID and WHEN.
        await writeAuditLog('VIEW_ID_DOCUMENT', actor, uid, docId, `Viewed "${doc.originalName}" (${doc.status})`);

        res.json({
            success: true,
            signedUrl: signedUrl,
            expiresIn: idVault.SIGNED_URL_TTL_SECONDS,
            document: {
                docId: doc.docId,
                originalName: doc.originalName,
                mimeType: doc.mimeType,
                status: doc.status,
                uploadedAt: doc.uploadedAt,
                verifiedAt: doc.reviewedAt || null
            }
        });
    } catch (error) {
        console.error('Senior ID view error:', error);
        res.status(500).json({ success: false, message: 'Failed to open the ID document: ' + error.message });
    }
});

// ============================================================
// Health / Illness Management with Medical Certification
// (Supabase Storage — private bucket "medical-certifications")
//
// Firebase RTDB stays the single source of truth:
//   users/{uid}/healthReports/{reportId}  -> every health update submitted by a senior
//   users/{uid}/healthManagement          -> OSCA staff decision (health + priority)
//   users/{uid}/healthCondition           -> the OFFICIAL condition shown app-wide
//
// Flow (per thesis: the system assists, staff decide):
//   1) A VERIFIED senior citizen opens Profile -> "Update Health", describes
//      the illness and uploads a medical certification. The file is stored in
//      the PRIVATE bucket folder pending/{uid}/... and the metadata is written
//      to Firebase with status "Pending Review".
//   2) OSCA staff open the employee "Senior Illness & Priority Management"
//      section, view the senior account + the uploaded certification through a
//      short-lived signed URL, then give the FINAL human decision: the updated
//      health condition and the priority level (Low / Medium / High) based on
//      the illness. Accepted certifications move to reviewed/{uid}/...,
//      rejected ones are deleted so no sensitive data is kept needlessly.
//   3) The senior is notified in the portal about the decision.
// Every access is permission-checked and written to auditLogs (RA 10173).
// ============================================================

const HEALTH_PRIORITY_LEVELS = ['Low', 'Medium', 'High'];

/** Health Update / illness management is available to VERIFIED seniors only. */
function isVerifiedSeniorAccount(user) {
    return !!(user && (user.kycStatus === 'Verified' || user.kycVerifiedAt));
}

function medicalVaultDisabled(res) {
    return res.status(503).json({ success: false, message: 'Medical certification vault is not configured. Ask the administrator to set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
}

/** Tells the senior (portal notification) that a decision was made on their health update. */
async function notifySeniorHealthDecision(uid, title, description) {
    try {
        const now = Date.now();
        await admin.database().ref(`users/${uid}/notifications/notif_${now}`).set({
            title: title,
            description: description,
            createdAt: now
        });
    } catch (e) {
        console.warn('Health decision notification skipped:', e.message);
    }
}

// --- API: Senior submits a Health Update with a medical certification ---
// Verified senior accounts ONLY (the feature is locked for unverified accounts).
app.post('/api/health-report/submit', requireAuth, requireRole('senior'), async (req, res) => {
    const { illness, description, fileName, mimeType, fileBase64 } = req.body;
    const actor = req.authUser;
    try {
        if (!isVerifiedSeniorAccount(actor)) {
            await writeAuditLog('HEALTH_UPDATE_BLOCKED_UNVERIFIED', actor, actor.uid, null,
                `Blocked health update — KYC status: ${actor.kycStatus || 'Not Verified'}`);
            return res.status(403).json({
                success: false,
                message: 'Only verified senior accounts can send a health update. Please complete the "Get Verified" step first.'
            });
        }

        const illnessText = String(illness || '').trim().slice(0, 160);
        if (!illnessText) {
            return res.status(400).json({ success: false, message: 'Please describe your illness or health condition.' });
        }

        const wantsFile = !!(fileName || mimeType || fileBase64);
        if (wantsFile && (!fileName || !mimeType || !fileBase64)) {
            return res.status(400).json({
                success: false,
                message: 'The medical certification upload is incomplete — fileName, mimeType and fileBase64 are all required.'
            });
        }

        const reportRef = admin.database().ref(`users/${actor.uid}/healthReports`).push();
        const reportId = reportRef.key;

        // 1) Store the physical certification first (private bucket, pending
        //    folder). The folder is keyed by the senior's UNIQUE OSCA ID
        //    number — only senior certifications ever live in this vault.
        let storagePath = null;
        let fileSize = null;
        let certFolderKey = null;
        if (wantsFile) {
            if (!medicalVault.isVaultEnabled()) return medicalVaultDisabled(res);
            const decoded = medicalVault.decodeDocumentPayload(mimeType, fileBase64);
            if (decoded.error) return res.status(400).json({ success: false, message: decoded.error });
            fileSize = decoded.buffer.length;
            certFolderKey = medicalVault.resolveSeniorFolderKey(actor);
            storagePath = medicalVault.buildStoragePath('pending', certFolderKey, reportId, fileName);
            await medicalVault.uploadDocument(storagePath, decoded.buffer, mimeType);
        }

        // 2) Mirror the metadata into Firebase (source of truth)
        await reportRef.set({
            reportId: reportId,
            uid: actor.uid,
            name: actor.name || 'Senior Citizen',
            seniorId: actor.seniorId || null,
            illness: illnessText,
            description: String(description || '').trim().slice(0, 1500) || null,
            hasCertification: wantsFile,
            fileName: wantsFile ? String(fileName).slice(0, 120) : null,
            mimeType: wantsFile ? mimeType : null,
            size: fileSize,
            storagePath: storagePath,
            certFolderKey: certFolderKey,
            folder: wantsFile ? 'pending' : null,
            status: 'Pending Review',
            submittedBy: actor.uid,
            submittedByName: actor.name || actor.email || 'Senior Citizen',
            submittedAt: Date.now()
        });

        // The self-reported update is queued for staff review. The OFFICIAL health
        // condition + priority are only changed by OSCA staff after reviewing the
        // medical certification (human decision, not automatic).
        await admin.database().ref(`users/${actor.uid}`).update({
            healthConditionLatest: illnessText,
            healthUpdatePending: true,
            healthUpdateLastSubmittedAt: Date.now()
        });

        await writeAuditLog('HEALTH_REPORT_SUBMITTED', actor, actor.uid, reportId,
            `Health update submitted — illness: ${illnessText}${wantsFile ? ' (medical certification attached)' : ' (no certification attached)'}`);

        res.json({
            success: true,
            message: 'Health update submitted. OSCA staff will review your medical certification and update your health record.',
            reportId: reportId
        });
    } catch (error) {
        console.error('Health report submit error:', error);
        res.status(500).json({ success: false, message: 'Failed to submit the health update: ' + error.message });
    }
});

// --- API: View a medical certification (owner senior or OSCA staff) via short-lived signed URL ---
app.get('/api/health-report/view/:uid/:reportId', requireAuth, async (req, res) => {
    const { uid, reportId } = req.params;
    const actor = req.authUser;
    try {
        const isOwner = actor.uid === uid;
        const isStaff = actor.role === 'admin' || actor.role === 'employee';
        if (!isOwner && !isStaff) {
            return res.status(403).json({ success: false, message: 'You are not allowed to view this medical certification.' });
        }
        if (!medicalVault.isVaultEnabled()) return medicalVaultDisabled(res);

        const snap = await admin.database().ref(`users/${uid}/healthReports/${reportId}`).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Health update not found.' });
        const report = snap.val();
        if (!report.storagePath) {
            return res.status(404).json({ success: false, message: 'This health update has no stored medical certification.' });
        }

        const signedUrl = await medicalVault.createViewLink(report.storagePath);

        // Privacy compliance: record WHO viewed WHICH senior's certification and WHEN.
        await writeAuditLog('VIEW_MEDICAL_CERTIFICATION', actor, uid, reportId,
            `Viewed "${report.fileName || 'medical certification'}" (${report.status})`);

        res.json({
            success: true,
            signedUrl: signedUrl,
            expiresIn: medicalVault.SIGNED_URL_TTL_SECONDS,
            report: {
                reportId: report.reportId || reportId,
                illness: report.illness || null,
                description: report.description || null,
                fileName: report.fileName || null,
                mimeType: report.mimeType || null,
                size: report.size || null,
                status: report.status || 'Pending Review',
                submittedAt: report.submittedAt || null
            }
        });
    } catch (error) {
        console.error('Medical certification view error:', error);
        res.status(500).json({ success: false, message: 'Failed to open the medical certification: ' + error.message });
    }
});

// --- View the KYC medical certification (owner or staff) -------------------
// The certification a senior uploaded during identity verification. Two
// copies may exist:
//   1) kycMedCertImage (data URL) in Firebase — removed after a rejection,
//   2) the durable file mirrored to the private Supabase "seniors" bucket,
//      pointed to by users/{uid}/kycMedCertPath.
// Staff (and the owning senior) can always re-open the document as long as a
// copy is available; access is permission-checked and audited (RA 10173).
app.get('/api/kyc-medcert/view/:uid', requireAuth, async (req, res) => {
    const { uid } = req.params;
    const actor = req.authUser;
    try {
        const isOwner = actor.uid === uid;
        const isStaff = actor.role === 'admin' || actor.role === 'employee';
        if (!isOwner && !isStaff) {
            return res.status(403).json({ success: false, message: 'You are not allowed to view this medical certification.' });
        }

        const snap = await admin.database().ref(`users/${uid}`).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Senior record not found.' });
        const user = snap.val();
        if (user.role && user.role !== 'senior') {
            return res.status(404).json({ success: false, message: 'No medical certification was submitted for this account.' });
        }

        // Preferred: the durable private-bucket copy (survives verification).
        if (user.kycMedCertPath) {
            if (!seniorStore.isSyncEnabled()) {
                return res.status(503).json({ success: false, message: 'Supabase is not configured, so the stored medical certification cannot be opened.' });
            }
            try {
                const signedUrl = await seniorStore.createMedCertViewLink(user.kycMedCertPath);
                await writeAuditLog('VIEW_KYC_MEDICAL_CERTIFICATION', actor, uid, null,
                    `Viewed KYC medical certification "${user.kycMedCertName || 'file'}" (stored copy)`);
                return res.json({
                    success: true,
                    viewUrl: signedUrl,
                    source: 'storage',
                    expiresIn: seniorStore.MED_CERT_VIEW_TTL_SECONDS,
                    file: { name: user.kycMedCertName || 'Medical certification', mimeType: user.kycMedCertType || null }
                });
            } catch (e) {
                console.error('KYC med-cert signed URL failed:', e.message);
                // fall through to the inline copy below, if any
            }
        }

        // Fallback: the inline data-URL copy in Firebase (pending submissions).
        if (user.kycMedCertImage) {
            await writeAuditLog('VIEW_KYC_MEDICAL_CERTIFICATION', actor, uid, null,
                `Viewed KYC medical certification "${user.kycMedCertName || 'file'}" (submitted copy)`);
            return res.json({
                success: true,
                viewUrl: user.kycMedCertImage,
                source: 'inline',
                file: { name: user.kycMedCertName || 'Medical certification', mimeType: user.kycMedCertType || null }
            });
        }

        return res.status(404).json({
            success: false,
            message: 'No medical certification is available for this senior. The senior can submit one through the portal, or ask OSCA staff to check the archive copy.'
        });
    } catch (error) {
        console.error('KYC medical certification view error:', error);
        res.status(500).json({ success: false, message: 'Failed to open the medical certification: ' + error.message });
    }
});

// --- API: Staff review of a submitted health update / medical certification ---
// decision = 'Reviewed'  -> accept the certification, SET the official health condition
//                           and the priority level (Low / Medium / High) based on the illness
// decision = 'Rejected'  -> the certification is deleted and the senior is notified
app.post('/api/health-report/:uid/:reportId/review', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid, reportId } = req.params;
    const { decision, healthCondition, illnessDetails, priorityLevel, notes } = req.body;
    const actor = req.authUser;
    try {
        if (!['Reviewed', 'Rejected'].includes(decision)) {
            return res.status(400).json({ success: false, message: 'decision must be either "Reviewed" or "Rejected".' });
        }

        const reportRef = admin.database().ref(`users/${uid}/healthReports/${reportId}`);
        const snap = await reportRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Health update not found.' });
        const report = snap.val();
        if (report.status !== 'Pending Review') {
            return res.status(409).json({ success: false, message: `This health update was already reviewed (${report.status}).` });
        }

        // Seniors only — the medical-certification vault must never hold
        // files for any other account type.
        const ownerSnap = await admin.database().ref(`users/${uid}`).once('value');
        const owner = ownerSnap.val() || null;
        if (!owner || (owner.role && owner.role !== 'senior')) {
            return res.status(404).json({ success: false, message: 'No senior account was found for this health update.' });
        }

        const actorName = actor.name || actor.email || 'OSCA Staff';
        const cleanNotes = String(notes || '').trim().slice(0, 500) || null;

        if (decision === 'Rejected') {
            // Rejected: remove the sensitive file entirely, keep only the audit trail.
            if (report.storagePath) {
                try { await medicalVault.deleteDocument(report.storagePath); }
                catch (e) { console.warn('Medical certification delete skipped:', e.message); }
            }
            await reportRef.update({
                status: 'Rejected',
                folder: null,
                storagePath: null,
                reviewedBy: actor.uid,
                reviewedByName: actorName,
                reviewedAt: Date.now(),
                reviewNotes: cleanNotes
            });
            await admin.database().ref(`users/${uid}`).update({
                healthUpdatePending: false,
                healthUpdateLastReviewedAt: Date.now()
            });
            await writeAuditLog('HEALTH_REPORT_REJECTED', actor, uid, reportId,
                `Medical certification rejected${cleanNotes ? ' — ' + cleanNotes : ''}`);
            await notifySeniorHealthDecision(uid, 'Health Update Needs Attention',
                `Your health update${report.illness ? ' for "' + report.illness + '"' : ''} was not accepted by OSCA staff.${cleanNotes ? ' Reason: ' + cleanNotes : ''} You may submit a clearer certification.`);
            return res.json({ success: true, message: 'Health update rejected. The senior has been notified.' });
        }

        // ── Accepted: the staff decision becomes the official health + priority ──
        const priority = String(priorityLevel || '');
        if (!HEALTH_PRIORITY_LEVELS.includes(priority)) {
            return res.status(400).json({ success: false, message: 'A priority level (Low, Medium or High) is required to complete the review.' });
        }
        const condition = String(healthCondition || report.illness || '').trim().slice(0, 160);
        if (!condition) {
            return res.status(400).json({ success: false, message: 'Please provide the updated health condition / illness of the senior.' });
        }
        const details = String(illnessDetails || report.description || '').trim().slice(0, 1500) || null;

        // Move the accepted certification to the reviewed folder BEFORE touching Firebase.
        let reviewedPath = report.storagePath || null;
        if (report.storagePath) {
            const target = medicalVault.buildStoragePath('reviewed', report.certFolderKey || medicalVault.resolveSeniorFolderKey(owner), reportId, report.fileName || 'certification');
            try {
                await medicalVault.moveDocument(report.storagePath, target);
                reviewedPath = target;
            } catch (e) {
                console.warn('Medical certification move skipped (metadata still updated):', e.message);
            }
        }

        const now = Date.now();
        await reportRef.update({
            status: 'Reviewed',
            folder: reviewedPath ? 'reviewed' : null,
            storagePath: reviewedPath,
            reviewedIllness: condition,
            reviewedDetails: details,
            priorityLevel: priority,
            reviewNotes: cleanNotes,
            reviewedBy: actor.uid,
            reviewedByName: actorName,
            reviewedAt: now
        });

        await admin.database().ref(`users/${uid}`).update({
            healthCondition: condition,
            illnessDetails: details || condition,
            illnessReportedAt: now,
            healthUpdatePending: false,
            healthUpdateLastReviewedAt: now,
            staffPriorityLevel: priority,
            staffPrioritySetAt: now,
            staffPrioritySetBy: actor.uid,
            staffPrioritySetByName: actorName,
            staffPriorityNotes: cleanNotes,
            'healthManagement/healthCondition': condition,
            'healthManagement/illnessDetails': details,
            'healthManagement/priorityLevel': priority,
            'healthManagement/prioritySource': 'OSCA staff review (medical certification)',
            'healthManagement/prioritySetAt': now,
            'healthManagement/prioritySetBy': actor.uid,
            'healthManagement/prioritySetByName': actorName,
            'healthManagement/lastReportId': reportId,
            'healthManagement/lastReviewedAt': now,
            'healthManagement/lastReviewedByName': actorName,
            'healthManagement/notes': cleanNotes
        });

        await writeAuditLog('HEALTH_REPORT_REVIEWED', actor, uid, reportId,
            `Medical certification reviewed — health: ${condition}, priority: ${priority}${cleanNotes ? ' — ' + cleanNotes : ''}`);
        await notifySeniorHealthDecision(uid, 'Health Update Recorded',
            `OSCA staff updated your health record from your submitted certification. Condition: ${condition}. Priority level: ${priority}.`);

        res.json({
            success: true,
            message: `Health record updated successfully — priority set to ${priority}.`,
            healthCondition: condition,
            priorityLevel: priority
        });
    } catch (error) {
        console.error('Health report review error:', error);
        res.status(500).json({ success: false, message: 'Failed to review the health update: ' + error.message });
    }
});

// --- API: Staff directly updates a senior's health + priority (no pending certification needed) ---
app.post('/api/health-management/:uid/update', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid } = req.params;
    const { healthCondition, illnessDetails, priorityLevel, notes } = req.body;
    const actor = req.authUser;
    try {
        const priority = String(priorityLevel || '');
        if (!HEALTH_PRIORITY_LEVELS.includes(priority)) {
            return res.status(400).json({ success: false, message: 'priorityLevel must be one of: ' + HEALTH_PRIORITY_LEVELS.join(', ') + '.' });
        }
        const condition = String(healthCondition || '').trim().slice(0, 160);
        if (!condition) {
            return res.status(400).json({ success: false, message: 'Please provide the senior\'s health condition / illness.' });
        }

        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists() || userSnap.val().role !== 'senior') {
            return res.status(404).json({ success: false, message: 'Senior citizen account not found.' });
        }
        const user = userSnap.val();
        if (!isVerifiedSeniorAccount(user)) {
            return res.status(403).json({ success: false, message: 'Illness management is only available for verified senior accounts.' });
        }

        const actorName = actor.name || actor.email || 'OSCA Staff';
        const details = String(illnessDetails || '').trim().slice(0, 1500) || null;
        const cleanNotes = String(notes || '').trim().slice(0, 500) || null;
        const now = Date.now();

        await admin.database().ref(`users/${uid}`).update({
            healthCondition: condition,
            illnessDetails: details || condition,
            illnessReportedAt: now,
            staffPriorityLevel: priority,
            staffPrioritySetAt: now,
            staffPrioritySetBy: actor.uid,
            staffPrioritySetByName: actorName,
            staffPriorityNotes: cleanNotes,
            'healthManagement/healthCondition': condition,
            'healthManagement/illnessDetails': details,
            'healthManagement/priorityLevel': priority,
            'healthManagement/prioritySource': 'OSCA staff (manual illness assessment)',
            'healthManagement/prioritySetAt': now,
            'healthManagement/prioritySetBy': actor.uid,
            'healthManagement/prioritySetByName': actorName,
            'healthManagement/notes': cleanNotes
        });

        await writeAuditLog('HEALTH_PRIORITY_UPDATED', actor, uid, null,
            `Health updated manually — condition: ${condition}, priority: ${priority}${cleanNotes ? ' — ' + cleanNotes : ''}`);
        await notifySeniorHealthDecision(uid, 'Health Record Updated',
            `OSCA staff updated your health record. Condition: ${condition}. Priority level: ${priority}.`);

        res.json({ success: true, message: `Health updated — priority set to ${priority}.`, healthCondition: condition, priorityLevel: priority });
    } catch (error) {
        console.error('Health management update error:', error);
        res.status(500).json({ success: false, message: 'Failed to update the health record: ' + error.message });
    }
});

// ============================================================
// QR-Based Digital ID Verification, Benefits Eligibility
// Engine, Duplicate-Claim Prevention & Budget Management.
//
// Design notes (security first):
//  - Every senior gets a server-generated verification token.
//    The QR code encodes  SC1|<uid>|<token>  and is useless
//    without staff verification against the server.
//  - Claim recording is ONLY possible via this trusted backend:
//    eligibility is evaluated server-side, duplicate claims of
//    the same benefit within the same month are rejected, and
//    every release is checked against the remaining budget.
//  - The system assists staff; it never releases benefits
//    automatically — each claim is recorded by an authenticated
//    staff member and written to the audit trail.
// ============================================================

const BENEFIT_TYPES = [
    'Monthly Social Pension',
    'Death Benefit Assistance',
    'Medical Assistance',
    'Burial Assistance',
    'Financial Assistance',
    'Food / Relief Goods'
];

function computeAgeFromDob(dob) {
    if (!dob) return null;
    const birthDate = new Date(dob);
    if (isNaN(birthDate.getTime())) return null;
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }
    return age >= 0 ? age : null;
}

function currentClaimPeriod() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function generateVerificationToken() {
    return crypto.randomBytes(12).toString('hex'); // 24 hex chars
}

// --- Benefits Eligibility Engine (server-side, single source of truth) ---
function evaluateEligibility(user) {
    const idDocs = user.idDocuments ? Object.values(user.idDocuments) : [];
    const hasPendingDocs = idDocs.some(d => d.status === 'Pending');

    const checks = [
        {
            id: 'lifeStatus',
            label: 'Life status is Active',
            passed: (user.lifeStatus || 'Active') === 'Active',
            detail: user.lifeStatus || 'Active'
        },
        {
            id: 'accountStatus',
            label: 'Account status is Active',
            passed: user.status === 'Active',
            detail: user.status || 'Unknown'
        },
        {
            id: 'kyc',
            label: 'Identity verified (KYC)',
            passed: user.kycStatus === 'Verified' || !!user.kycVerifiedAt,
            detail: user.kycStatus || (user.kycVerifiedAt ? 'Verified' : 'Not verified')
        },
        {
            id: 'seniorId',
            label: 'Valid Senior Citizen ID on record',
            passed: !!String(user.seniorId || '').trim(),
            detail: user.seniorId || 'Missing'
        },
        {
            id: 'documents',
            label: 'No pending ID document requirements',
            passed: !hasPendingDocs,
            detail: hasPendingDocs ? 'Pending document(s) under review' : 'Complete'
        }
    ];

    return { eligible: checks.every(c => c.passed), checks };
}

// --- API: Get or create the senior's own QR verification token ---
app.get('/api/senior/verification-token', requireAuth, requireRole('senior'), async (req, res) => {
    try {
        const actor = req.authUser;
        let token = actor.verificationToken;
        if (!token) {
            token = generateVerificationToken();
            await admin.database().ref(`users/${actor.uid}/verificationToken`).set(token);
        }
        // Full offline-verifiable payload scanned by staff: SC1|<uid>|<token>
        const payload = `SC1|${actor.uid}|${token}`;
        let qrImage = null;
        try {
            qrImage = await QRCode.toDataURL(payload, {
                errorCorrectionLevel: 'M',
                margin: 2,
                width: 320,
                color: { dark: '#0f172a', light: '#ffffff' }
            });
        } catch (qrErr) {
            console.error('QR render error:', qrErr.message); // non-fatal: payload still returned
        }
        res.json({ success: true, token, payload, qrImage });
    } catch (error) {
        console.error('Verification token error:', error);
        res.status(500).json({ success: false, message: 'Failed to prepare your QR digital ID.' });
    }
});

// --- API: Staff scans/enters a QR digital ID → identity + eligibility + claim history ---
app.post('/api/verify-qr', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const raw = String(req.body.code || '').trim();
        let uid = null, token = null;

        // Accept the exact QR payload SC1|uid|token, or a manual Senior ID / Account lookup.
        if (/^SC1\|/.test(raw)) {
            const parts = raw.split('|');
            if (parts.length !== 3) return res.status(400).json({ success: false, message: 'Malformed QR code payload.' });
            uid = parts[1];
            token = parts[2];
        } else if (raw) {
            const snap = await admin.database().ref('users').orderByChild('role').equalTo('senior').once('value');
            const users = snap.val() || {};
            const cleanRaw = raw.trim().toUpperCase();
            const cleanRawDigits = cleanRaw.replace(/\D/g, '');
            const target = Object.entries(users).find(([k, u]) => {
                if (!u) return false;
                const sId = String(u.seniorId || '').trim().toUpperCase();
                const oscaId = String(u.oscaId || '').trim().toUpperCase();
                const email = String(u.email || '').trim().toUpperCase();
                const sIdDigits = sId.replace(/\D/g, '');
                return (
                    k === raw ||
                    sId === cleanRaw ||
                    oscaId === cleanRaw ||
                    email === cleanRaw ||
                    (cleanRawDigits && cleanRawDigits.length >= 4 && sIdDigits === cleanRawDigits)
                );
            });
            if (!target) return res.status(404).json({ success: false, message: `No senior citizen found with ID or account "${raw}".` });
            uid = target[0];
        } else {
            return res.status(400).json({ success: false, message: 'Scan a QR code or enter a Senior ID or account.' });
        }

        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior citizen record not found.' });
        const user = userSnap.val();

        // Token integrity: a scanned QR must carry the exact server-issued token.
        if (token && user.verificationToken && user.verificationToken !== token) {
            await writeAuditLog('QR_VERIFY_FAILED', req.authUser, uid, null, 'Presented QR token did not match the issued token');
            return res.status(403).json({ success: false, message: 'Invalid QR code — token mismatch. Possible forged or outdated ID.' });
        }

        const eligibility = evaluateEligibility(user);

        // Claim history for the current period (duplicate-claim awareness).
        const period = currentClaimPeriod();
        const claimsSnap = await admin.database().ref('claims').orderByChild('uid').equalTo(uid).once('value');
        const allClaims = claimsSnap.val() || {};
        const periodClaims = Object.values(allClaims).filter(c => c.period === period);
        const recentClaims = Object.values(allClaims)
            .sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0)).slice(0, 5)
            .map(c => ({ benefitType: c.benefitType, amount: c.amount, period: c.period, releasedAt: c.releasedAt, releasedByName: c.releasedByName }));

        // Priority calculation
        const priority = priorityEngine.computePriority(user);
        const ageVal = computeAgeFromDob(user.dob) ?? (user.age ? Number(user.age) : null);

        // Verification status determination (Verified, Pending, or Not yet verified)
        let verificationStatus = 'Not yet verified';
        if (user.kycStatus === 'Verified' || user.kycVerifiedAt) {
            verificationStatus = 'Verified';
        } else if (user.kycStatus === 'Pending' || user.status === 'Pending') {
            verificationStatus = 'Pending';
        } else if (user.kycStatus === 'Rejected') {
            verificationStatus = 'Rejected';
        } else {
            verificationStatus = 'Not yet verified';
        }

        const fullAddress = user.address || [user.barangay, user.city, user.province].filter(Boolean).join(', ') || user.barangay || 'N/A';

        await writeAuditLog('QR_VERIFY_SUCCESS', req.authUser, uid, null,
            `Verified identity via QR${token ? '' : '/Senior ID'} — verification: ${verificationStatus}, eligibility: ${eligibility.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}`);

        res.json({
            success: true,
            senior: {
                uid: uid,
                name: user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Senior Citizen',
                email: user.email || 'N/A',
                seniorId: user.seniorId || 'N/A',
                address: fullAddress,
                barangay: user.barangay || 'N/A',
                dob: user.dob || 'N/A',
                age: ageVal,
                priorityLevel: priority.level || 'Low',
                priorityScore: priority.score || 0,
                priorityBreakdown: priority.breakdown || {},
                priorityReasons: priority.reasons || [],
                verificationStatus: verificationStatus,
                lifeStatus: user.lifeStatus || 'Active',
                accountStatus: user.status || 'Active',
                kycStatus: user.kycStatus || (user.kycVerifiedAt ? 'Verified' : 'Not verified'),
                healthCondition: user.healthCondition || user.condition || user.preExistingConditions || 'None reported'
            },
            eligibility: eligibility,
            period: period,
            claimedThisPeriod: periodClaims.map(c => c.benefitType),
            recentClaims: recentClaims
        });
    } catch (error) {
        console.error('Verify QR error:', error);
        res.status(500).json({ success: false, message: 'Verification failed: ' + error.message });
    }
});

// --- Helper: notify all staff (admin + employee) in-app (Automated Notifications) ---
async function notifyStaff(title, description) {
    try {
        const snap = await admin.database().ref('users').once('value');
        const users = snap.val() || {};
        const now = Date.now();
        const updates = {};
        Object.entries(users).forEach(([uid, u]) => {
            if (u && (u.role === 'admin' || u.role === 'employee')) {
                updates[`users/${uid}/notifications/notif_${now}_${uid.slice(0, 6)}`] = {
                    title,
                    description,
                    createdAt: now
                };
            }
        });
        if (Object.keys(updates).length > 0) {
            await admin.database().ref().update(updates);
        }
    } catch (err) {
        console.error('notifyStaff error:', err.message); // non-fatal
    }
}

// --- API: Senior submits an assistance/benefit request from the portal ---
// Replaces the legacy direct-to-RTDB claim push. Server enforces identity
// (uid is ALWAYS the authenticated senior), duplicate-request prevention
// per service + claim period, sanitization, and audit logging.
app.post('/api/claims/request', requireAuth, requireRole('senior'), async (req, res) => {
    const { serviceType, formData, urgentRequest } = req.body;
    const actor = req.authUser;
    try {
        if (!serviceType) return res.status(400).json({ success: false, message: 'serviceType is required.' });
        const type = String(serviceType).trim();
        if (type.length > 80) return res.status(400).json({ success: false, message: 'serviceType is too long.' });

        // ── KYC GATE: only fully Verified seniors may request services ──
        // Re-check the live record (not the token claims) so a Pending /
        // Not Verified / Rejected account can never submit a request,
        // even via direct API calls.
        const freshUserSnap = await admin.database().ref(`users/${actor.uid}`).once('value');
        const freshUser = freshUserSnap.val() || {};
        // ── DECEASED GATE: an account archived as Deceased can never request a
        // pension/benefit payout, even with a token issued before the archive.
        if (String(freshUser.lifeStatus || '') === 'Deceased' || String(freshUser.status || '') === 'Deceased') {
            await writeAuditLog('CLAIM_REQUEST_BLOCKED_DECEASED', actor, actor.uid, null,
                `Blocked ${type} request — account is marked Deceased (archived).`);
            return res.status(403).json({
                success: false,
                message: 'This senior have passed away, please go to OSCA if you think this is an error'
            });
        }
        if (freshUser.kycStatus !== 'Verified') {
            await writeAuditLog('CLAIM_REQUEST_BLOCKED_UNVERIFIED', actor, actor.uid, null,
                `Blocked ${type} request — KYC status: ${freshUser.kycStatus || 'Not Verified'}`);
            return res.status(403).json({
                success: false,
                message: 'Your account is not verified yet. Please complete the Get Verified process before requesting services.'
            });
        }

        // Sanitize formData: plain string map only, bounded sizes.
        const cleanForm = {};
        if (formData && typeof formData === 'object' && !Array.isArray(formData)) {
            const keys = Object.keys(formData).slice(0, 40);
            for (const k of keys) {
                const safeKey = String(k).replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 60);
                if (!safeKey) continue;
                const v = formData[k];
                if (Array.isArray(v)) {
                    cleanForm[safeKey] = v.slice(0, 6).map(x => String(x).slice(0, 300));
                } else if (v !== null && v !== undefined && typeof v !== 'object') {
                    cleanForm[safeKey] = String(v).slice(0, 2000);
                }
            }
        }

        const serviceMonth = currentClaimPeriod();

        // Duplicate-request prevention: same senior + same service + same period.
        const dupSnap = await admin.database().ref('claims')
            .orderByChild('uid').equalTo(actor.uid).once('value');
        const existing = dupSnap.val() || {};
        const dup = Object.entries(existing).find(([, c]) => (
            c && (c.serviceType === type) && (c.serviceMonth === serviceMonth) &&
            ['Pending', 'Processing', 'Approved'].includes(c.status)
        ));
        if (dup) {
            await writeAuditLog('CLAIM_REQUEST_DUPLICATE', actor, actor.uid, dup[0],
                `Duplicate ${type} request for ${serviceMonth}`);
            return res.status(409).json({
                success: false,
                message: `You already have a ${type} request for ${serviceMonth} (status: ${dup[1].status}). Please wait for it to be processed.`
            });
        }

        const claimRef = admin.database().ref('claims').push();
        const claim = {
            uid: actor.uid,                    // legacy field used by staff dashboards
            seniorUid: actor.uid,              // canonical field
            applicantName: actor.name || actor.email || 'Senior Citizen',
            serviceType: type,
            serviceMonth,
            formData: cleanForm,
            // Emergency Urgent Request flag ("Request only" toggle on the senior form)
            urgentRequest: urgentRequest === true || urgentRequest === 'true',
            urgentRequestedAt: (urgentRequest === true || urgentRequest === 'true') ? Date.now() : null,
            status: 'Pending',
            source: 'senior-portal',
            createdAt: Date.now()
        };
        await claimRef.set(claim);

        await writeAuditLog('CLAIM_REQUEST_SUBMITTED', actor, actor.uid, claimRef.key,
            `Submitted ${type} request for ${serviceMonth}`);
        await notifyStaff('New Assistance Request',
            `${claim.applicantName} submitted a ${type} request. Please review it in the Process tab.`);

        res.json({ success: true, message: 'Request submitted.', claimId: claimRef.key });
    } catch (error) {
        console.error('Claim request error:', error);
        res.status(500).json({ success: false, message: 'Failed to submit request.' });
    }
});

// --- API: Senior lists own submitted claims ---
app.get('/api/claims/request/mine', requireAuth, requireRole('senior'), async (req, res) => {
    const actor = req.authUser;
    try {
        const snap = await admin.database().ref('claims')
            .orderByChild('uid').equalTo(actor.uid).once('value');
        const items = snap.val() || {};
        const claims = Object.entries(items)
            .map(([id, c]) => ({ id, ...c }))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, 50);
        res.json({ success: true, claims });
    } catch (error) {
        console.error('My claims error:', error);
        res.status(500).json({ success: false, message: 'Failed to load your requests.' });
    }
});

// --- API: Staff records a benefit release/claim (decision-support workflow) ---
app.post('/api/claims/record', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const { uid, benefitType, amount, notes } = req.body;
        const actor = req.authUser;

        if (!uid || !benefitType) return res.status(400).json({ success: false, message: 'Senior and benefit type are required.' });
        if (!BENEFIT_TYPES.includes(benefitType)) return res.status(400).json({ success: false, message: 'Unknown benefit type.' });

        const amountNum = Number(amount);
        if (!Number.isFinite(amountNum) || amountNum < 0) return res.status(400).json({ success: false, message: 'Invalid amount.' });

        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior citizen record not found.' });
        const user = userSnap.val();

        // Deceased gate: an archived Deceased senior must never receive a
        // payout, even through a direct API call with a stale dashboard.
        if (String(user.lifeStatus || '') === 'Deceased' || String(user.status || '') === 'Deceased') {
            await writeAuditLog('BENEFIT_RELEASE_BLOCKED_DECEASED', actor, uid, null,
                `Blocked "${benefitType}" release — account is marked Deceased (archived).`);
            return res.status(403).json({
                success: false,
                message: 'This senior have passed away, please go to OSCA if you think this is an error'
            });
        }

        // 1) Eligibility gate — the system only ASSISTS; ineligible seniors are blocked here
        //    and the final release is always performed by the staff member.
        const eligibility = evaluateEligibility(user);
        if (!eligibility.eligible) {
            const failed = eligibility.checks.filter(c => !c.passed).map(c => c.label).join('; ');
            return res.status(409).json({ success: false, message: `Senior is NOT eligible: ${failed}.`, eligibility });
        }

        // 2) Duplicate-claim prevention — one release per benefit type per period.
        const period = currentClaimPeriod();
        const claimsSnap = await admin.database().ref('claims').orderByChild('uid').equalTo(uid).once('value');
        const allClaims = claimsSnap.val() || {};
        const alreadyClaimed = Object.values(allClaims).some(c =>
            c.period === period && c.benefitType === benefitType && c.status !== 'Void');
        if (alreadyClaimed) {
            return res.status(409).json({
                success: false,
                duplicateClaim: true,
                message: `DUPLICATE CLAIM BLOCKED: "${benefitType}" was already released to ${user.name} for ${period}. A senior citizen is only entitled to each benefit once per release period.`
            });
        }

        // 3) Budget gate — releases cannot exceed the allocated budget.
        const budgetSnap = await admin.database().ref('system/budget').once('value');
        const budget = budgetSnap.val() || { totalAllocated: 0 };
        const releasedTotal = Object.values(allClaims).reduce((s, c) => s + (Number(c.amount) || 0), 0);
        const remaining = (Number(budget.totalAllocated) || 0) - releasedTotal;
        if (remaining < amountNum) {
            return res.status(409).json({
                success: false,
                budgetExceeded: true,
                message: `INSUFFICIENT BUDGET: remaining allocation is ₱${remaining.toLocaleString()} but the release needs ₱${amountNum.toLocaleString()}. Ask the administrator to adjust the budget.`
            });
        }

        // 4) Record the claim — human-authorized release with full accountability.
        const claimRef = admin.database().ref('claims').push();
        const claim = {
            uid: uid,
            seniorId: user.seniorId || '',
            name: user.name || 'Unknown',
            barangay: user.barangay || 'Unassigned',
            benefitType: benefitType,
            amount: amountNum,
            notes: String(notes || '').slice(0, 300) || null,
            period: period,
            status: 'Released',
            releasedBy: actor.uid,
            releasedByName: actor.name || actor.email || 'OSCA Staff',
            releasedByRole: actor.role,
            releasedAt: Date.now()
        };
        await claimRef.set(claim);

        await writeAuditLog('RECORD_BENEFIT_CLAIM', actor, uid, claimRef.key,
            `Released "${benefitType}" (₱${amountNum.toLocaleString()}) for period ${period}${notes ? ' — ' + notes : ''}`);

        // Notify the senior citizen
        const notifKey = 'notif_' + Date.now();
        await admin.database().ref(`users/${uid}/notifications/${notifKey}`).set({
            title: `${benefitType} Released ✓`,
            description: `Your ${benefitType} of ₱${amountNum.toLocaleString()} has been officially released by ${claim.releasedByName}. Present your QR Digital ID when claiming. Ref: ${claimRef.key.slice(-8).toUpperCase()}`,
            createdAt: Date.now(),
            type: 'benefit'
        });

        // Official release SMS (TextBee) — same event the portal notification
        // announces, now sent to the senior's mobile number. Best-effort:
        // never awaited, so a sleeping gateway cannot delay the staff member.
        notifySeniorSms(uid, /pension/i.test(benefitType) ? 'pension_released' : 'claim_released', {
            amount: String(amountNum),
            serviceType: benefitType,
            refNumber: claimRef.key.slice(-8).toUpperCase(),
            period: period
        }).catch(err => console.warn('Release SMS skipped:', err.message));

        res.json({
            success: true,
            message: `${benefitType} of ₱${amountNum.toLocaleString()} recorded for ${user.name}.`,
            claimId: claimRef.key,
            budgetRemaining: remaining - amountNum
        });
    } catch (error) {
        console.error('Record claim error:', error);
        res.status(500).json({ success: false, message: 'Failed to record the claim: ' + error.message });
    }
});

// --- API: Budget summary (staff) / set allocation (admin) ---
app.get('/api/budget', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const budgetSnap = await admin.database().ref('system/budget').once('value');
        const budget = budgetSnap.val() || { totalAllocated: 0 };
        const claimsSnap = await admin.database().ref('claims').once('value');
        const claims = claimsSnap.val() || {};

        let released = 0;
        const byBarangay = {};
        const byBenefit = {};
        for (const c of Object.values(claims)) {
            const amt = Number(c.amount) || 0;
            released += amt;
            const b = c.barangay || 'Unassigned';
            byBarangay[b] = (byBarangay[b] || 0) + amt;
            byBenefit[c.benefitType || 'Unknown'] = (byBenefit[c.benefitType || 'Unknown'] || 0) + amt;
        }

        res.json({
            success: true,
            totalAllocated: Number(budget.totalAllocated) || 0,
            released: released,
            remaining: (Number(budget.totalAllocated) || 0) - released,
            updatedAt: budget.updatedAt || null,
            updatedByName: budget.updatedByName || null,
            byBarangay: byBarangay,
            byBenefit: byBenefit,
            claimCount: Object.keys(claims).length
        });
    } catch (error) {
        console.error('Budget summary error:', error);
        res.status(500).json({ success: false, message: 'Failed to load budget summary.' });
    }
});

app.post('/api/budget/set', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { totalAllocated } = req.body;
        const value = Number(totalAllocated);
        if (!Number.isFinite(value) || value < 0) {
            return res.status(400).json({ success: false, message: 'Budget must be a non-negative number.' });
        }
        const actor = req.authUser;
        await admin.database().ref('system/budget').set({
            totalAllocated: value,
            updatedAt: Date.now(),
            updatedBy: actor.uid,
            updatedByName: actor.name || actor.email || 'Administrator'
        });
        await writeAuditLog('SET_BUDGET_ALLOCATION', actor, null, null, `Total benefits budget set to ₱${value.toLocaleString()}`);
        res.json({ success: true, message: `Benefits budget set to ₱${value.toLocaleString()}.` });
    } catch (error) {
        console.error('Budget set error:', error);
        res.status(500).json({ success: false, message: 'Failed to update the budget.' });
    }
});

// --- API: Edit logs / audit trail viewer (admin only) ---
app.get('/api/audit-logs', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
        const snap = await admin.database().ref('auditLogs').limitToLast(limit).once('value');
        const logs = snap.val() || {};
        const list = Object.entries(logs)
            .map(([key, log]) => ({ id: key, ...log }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json({ success: true, logs: list });
    } catch (error) {
        console.error('Audit logs error:', error);
        res.status(500).json({ success: false, message: 'Failed to load audit logs.' });
    }
});

// --- Affiliated Health Centers directory (seeded on first run; staff-manageable) ---
const DEFAULT_HEALTH_CENTERS = [
    { name: 'OSCA Magalang Main Office Clinic', type: 'OSCA Clinic', barangay: 'Poblacion', contact: '', hours: 'Mon-Fri 8:00 AM - 5:00 PM' },
    { name: 'Magalang Rural Health Unit', type: 'Rural Health Unit', barangay: 'Poblacion', contact: '', hours: 'Mon-Fri 8:00 AM - 5:00 PM' },
    { name: 'Balucuc Barangay Health Center', type: 'Barangay Health Center', barangay: 'Balucuc', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'Camias Barangay Health Center', type: 'Barangay Health Center', barangay: 'Camias', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'San Francisco Barangay Health Center', type: 'Barangay Health Center', barangay: 'San Francisco', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'San Nicolas Barangay Health Center', type: 'Barangay Health Center', barangay: 'San Nicolas', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'San Vicente Barangay Health Center', type: 'Barangay Health Center', barangay: 'San Vicente', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'Santo Domingo Barangay Health Center', type: 'Barangay Health Center', barangay: 'Santo Domingo', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' },
    { name: 'Santo Niño Barangay Health Center', type: 'Barangay Health Center', barangay: 'Santo Niño', contact: '', hours: 'Mon-Fri 8:00 AM - 4:00 PM' }
];

async function seedHealthCenters() {
    try {
        const snap = await admin.database().ref('healthCenters').once('value');
        if (snap.exists()) return;
        await admin.database().ref('healthCenters').set(DEFAULT_HEALTH_CENTERS);
        console.log('Seeded default affiliated health centers directory.');
    } catch (e) {
        console.warn('Could not seed health centers:', e.message);
    }
}
seedHealthCenters();

// ============================================================
// Phase 2: Barangay Mapping
// Per thesis: each senior is mapped to a barangay; the system
// tracks distribution by barangay for reports and budget.
// Shares the same app, admin, and writeAuditLog as server.js.
// ============================================================

// --- API: Get barangays (any authenticated; optional filter) ---
app.get('/api/barangays', requireAuth, async (req, res) => {
    const { region, district } = req.query;
    try {
        const snap = await admin.database().ref('barangays').once('value');
        let items = snap.val() || {};
        items = Object.entries(items).map(([k, v]) => ({ id: k, ...v }));
        if (region) items = items.filter(b => (b.region || '').toLowerCase() === region.toLowerCase());
        if (district) items = items.filter(b => (b.district || '').toLowerCase() === district.toLowerCase());
        items.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        res.json({ success: true, barangays: items });
    } catch (error) {
        console.error('Barangays error:', error);
        res.status(500).json({ success: false, message: 'Failed to load barangays.' });
    }
});

// --- API: Get barangay mapping of a senior (senior: own; staff: any) ---
app.get('/api/barangay/:uid', requireAuth, async (req, res) => {
    const { uid } = req.params;
    const actor = req.authUser;
    try {
        if (actor.role === 'senior' && actor.uid !== uid) {
            return res.status(403).json({ success: false, message: 'You may only view your own barangay mapping.' });
        }
        const snap = await admin.database().ref(`users/${uid}`).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'User not found.' });
        const user = snap.val();
        const bId = user.barangayId || null;
        let barangay = null;
        if (bId) {
            const bSnap = await admin.database().ref(`barangays/${bId}`).once('value');
            if (bSnap.exists()) barangay = { id: bId, ...bSnap.val() };
        }
        res.json({
            success: true,
            uid,
            barangayId: bId,
            barangay,
            mappedAt: user.barangayMappedAt || null,
            mappedByName: user.barangayMappedByName || null
        });
    } catch (error) {
        console.error('Barangay mapping error:', error);
        res.status(500).json({ success: false, message: 'Failed to load barangay mapping.' });
    }
});

// --- API: Map senior to barangay (admin/staff only) ---
app.post('/api/barangay/map', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid, barangayId } = req.body;
    const actor = req.authUser;
    try {
        if (!uid || !barangayId) return res.status(400).json({ success: false, message: 'uid and barangayId are required.' });
        const userSnap = await admin.database().ref(`users/${uid}`).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior citizen not found.' });
        const bSnap = await admin.database().ref(`barangays/${barangayId}`).once('value');
        if (!bSnap.exists()) return res.status(400).json({ success: false, message: 'Barangay not found.' });

        await admin.database().ref(`users/${uid}`).update({
            barangayId,
            barangayMappedAt: Date.now(),
            barangayMappedBy: actor.uid,
            barangayMappedByName: actor.name || actor.email || ''
        });
        await writeAuditLog('BARANGAY_MAPPED', actor, uid, barangayId,
            `Mapped senior to barangay ${bSnap.val().name || barangayId}`);
        res.json({ success: true, message: 'Barangay mapping updated.' });
    } catch (error) {
        console.error('Map barangay error:', error);
        res.status(500).json({ success: false, message: 'Failed to map barangay.' });
    }
});

// --- API: Count seniors per barangay (admin/staff only; for reports) ---
app.get('/api/barangay/counts', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const [usersSnap, barangaysSnap] = await Promise.all([
            admin.database().ref('users').once('value'),
            admin.database().ref('barangays').once('value')
        ]);
        const users = usersSnap.val() || {};
        const counts = {};
        Object.values(users).forEach(u => {
            if (u.role !== 'senior') return;
            const key = u.barangayId || 'unmapped';
            counts[key] = (counts[key] || 0) + 1;
        });
        const barangays = barangaysSnap.val() || {};
        const result = Object.entries(barangays).map(([id, b]) => ({
            id,
            name: b.name,
            seniors: counts[id] || 0
        }));
        if (counts['unmapped']) result.push({ id: null, name: '(Unmapped)', seniors: counts['unmapped'] });
        result.sort((a, b) => b.seniors - a.seniors);
        res.json({ success: true, counts: result });
    } catch (error) {
        console.error('Barangay counts error:', error);
        res.status(500).json({ success: false, message: 'Failed to compute barangay counts.' });
    }
});

// --- API: Add / update barangay (admin only) ---
app.post('/api/barangays', requireAuth, requireRole('admin'), async (req, res) => {
    const { id, name, region, district, municipality, population } = req.body;
    const actor = req.authUser;
    try {
        if (!id || !name) return res.status(400).json({ success: false, message: 'id and name are required.' });
        const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
        const data = {
            name: String(name).slice(0, 80),
            region: String(region || '').slice(0, 60),
            district: String(district || '').slice(0, 60),
            municipality: String(municipality || '').slice(0, 80),
            population: Number(population) || 0,
            updatedBy: actor.uid,
            updatedByName: actor.name || actor.email || '',
            updatedAt: Date.now()
        };
        await admin.database().ref(`barangays/${safeId}`).set(data);
        await writeAuditLog('BARANGAY_SAVED', actor, null, safeId,
            `Saved barangay ${data.name} (${safeId})`);
        res.json({ success: true, message: 'Barangay saved.', id: safeId });
    } catch (error) {
        console.error('Save barangay error:', error);
        res.status(500).json({ success: false, message: 'Failed to save barangay.' });
    }
});

// Basic routing for pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/reset-password', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'views', 'admin.html'));
});

app.get('/employee', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'views', 'employee.html'));
});

app.get('/senior', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'views', 'senior.html'));
});

app.get('/user-manual', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'user-manual.html'));
});

app.get('/reactivate', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'reactivate.html'));
});

// ============================================================
// Queue / Appointment / Attendance system (Phase 1 - Server)
// Per thesis:
//  - Seniors book appointments -> get queue number
//  - Frontend shows queue position
//  - Employee reviews requests in Health Records: Pending -> Approved / Declined
//  - Attendance: Approved / Pending -> Attended / Missed / Rescheduled
//  - All operations RBAC-guarded + audit logged
// Firebase RTDB = single source of truth
// ============================================================

// --- API: List queues (admin/staff only; optional filter) ---
app.get('/api/queues', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { status, date } = req.query;
    const actor = req.authUser;
    try {
        const ref = admin.database().ref('queue');
        const snap = await ref.once('value');
        const all = snap.val() || {};
        const result = [];
        Object.values(all).forEach(q => {
            if (status && q.status !== status) return;
            if (date && new Date(q.scheduledAt).toDateString() !== new Date(date).toDateString()) return;
            result.push(q);
        });
        result.sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
        res.json({ success: true, queues: result });
    } catch (error) {
        console.error('List queues error:', error);
        res.status(500).json({ success: false, message: 'Failed to load queues.' });
    }
});

// --- API: Get my queue slots (senior: own; staff: all) ---
app.get('/api/queues/:uid', requireAuth, async (req, res) => {
    const { uid } = req.params;
    const actor = req.authUser;
    try {
        if (actor.role === 'senior' && actor.uid !== uid) {
            return res.status(403).json({ success: false, message: 'You may only view your own queue slots.' });
        }
        const ref = admin.database().ref('queue');
        const snap = await ref.orderByChild('uid').equalTo(uid).once('value');
        const items = snap.val() || {};
        const result = Object.values(items)
            .map(q => ({ id: q.id, ...q }))
            .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
        res.json({ success: true, queues: result });
    } catch (error) {
        console.error('My queues error:', error);
        res.status(500).json({ success: false, message: 'Failed to load your queue slots.' });
    }
});

// --- API: Book a queue appointment (senior only; own) ---
// --- Appointment working days: Monday to Thursday only ---
// Thursday–Sunday are closed (office hours). Returns a friendly message so
// both the API and the UI can tell the senior which days to pick.
function isWorkingDay(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
    if (!m) return { ok: false, message: 'Invalid visit date.' };
    // Build a LOCAL date so getDay() reflects the actual calendar day and is
    // never shifted by UTC parsing.
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const day = d.getDay(); // 0 Sun ... 6 Sat
    if (day < 1 || day > 4) {
        return { ok: false, message: 'OSCA Magalang is open Monday to Thursday only. Please pick a Monday, Tuesday, Wednesday or Thursday visit date.' };
    }
    return { ok: true, weekday: day };
}

app.post('/api/queue/book', requireAuth, requireRole('senior'), async (req, res) => {
    const { date, time, service, note } = req.body;
    const actor = req.authUser;
    try {
        if (!date || !time) return res.status(400).json({ success: false, message: 'date and time are required.' });
        const workDay = isWorkingDay(date);
        if (!workDay.ok) return res.status(400).json({ success: false, message: workDay.message });
        const scheduledAt = new Date(`${date}T${time}`).getTime();
        if (isNaN(scheduledAt)) return res.status(400).json({ success: false, message: 'Invalid date/time format.' });
        if (scheduledAt < Date.now()) return res.status(400).json({ success: false, message: 'Cannot book a past appointment.' });

        // One customer = one active/pending appointment at a time.
        // A senior with a Pending/Rescheduled booking must reschedule or
        // cancel it before booking a new one.
        const existingSnap = await admin.database().ref('queue')
            .orderByChild('uid').equalTo(actor.uid)
            .once('value');
        if (existingSnap.exists()) {
            const existing = existingSnap.val();
            const conflict = Object.values(existing).find(q => {
                return !['Cancelled', 'Missed', 'Attended', 'Declined'].includes(q.status);
            });
            if (conflict) {
                const hint = conflict.status === 'Approved'
                    ? 'It is already approved and can no longer be rescheduled — cancel it first if you wish to book a new schedule.'
                    : 'Please reschedule or cancel it before booking a new one.';
                return res.status(409).json({ success: false, message: `You still have an active booking (${conflict.queueNumber || 'no queue no.'} — ${conflict.service || 'visit'} on ${conflict.date || ''} at ${conflict.time || ''}). ${hint}` });
            }
        }

        // Automatic queue number generation — sequential per visit date
        // Format: Q-YYYYMMDD-### (e.g. Q-20260913-001). Keeps lines short,
        // avoids overcrowding, and makes the daily schedule trivial to manage.
        const dateKey = String(date).replace(/-/g, '');
        const daySnap = await admin.database().ref('queue')
            .orderByChild('date').equalTo(date)
            .once('value');
        const dayCount = daySnap.exists() ? Object.keys(daySnap.val()).length : 0;
        const seq = String(dayCount + 1).padStart(3, '0');
        const queueNumber = `Q-${dateKey}-${seq}`;

        const id = admin.database().ref('queue').push().key;
        const queueRef = admin.database().ref(`queue/${id}`);
        const queueData = {
            id,
            uid: actor.uid,
            name: actor.name || actor.email || '',
            seniorId: actor.seniorId || 'N/A',
            date,
            time,
            scheduledAt,
            queueNumber,
            service: String(service || 'General Consultation').slice(0, 80),
            note: String(note || '').slice(0, 300),
            status: 'Pending',
            createdAt: Date.now(),
            createdBy: actor.uid
        };
        await queueRef.set(queueData);
        await writeAuditLog('QUEUE_APPOINTMENT_BOOKED', actor, actor.uid, id,
            `Booked ${queueData.service} on ${date} at ${time} — queue ${queueNumber}`);

        // Attendance tracking starts at Pending; mirror a health log + notification
        // so the senior sees the booking without polling.
        try {
            const logKey = 'log_' + Date.now();
            await admin.database().ref(`users/${actor.uid}/health/logs/${logKey}`).set({
                type: 'checkup',
                title: 'Appointment Booked',
                description: `${queueData.service} on ${date} at ${time}. Queue ${queueNumber}.`,
                createdAt: Date.now(),
                status: 'Pending'
            });
            const notifKey = 'notif_' + Date.now();
            await admin.database().ref(`users/${actor.uid}/notifications/${notifKey}`).set({
                title: 'Appointment Booked — Queue ' + queueNumber,
                description: `Your ${queueData.service} visit is set for ${date} at ${time}. Queue number ${queueNumber}. Please arrive 15 minutes early.`,
                createdAt: Date.now()
            });
        } catch (e) { console.warn('Booking mirror skipped:', e.message); }

        // SMS confirmation to the senior's own CP number (best-effort — never
        // rolls back a booking that is already saved).
        try {
            const sms = await notifySeniorSms(actor.uid, 'appointment_booked');
            console.log(sms.sent
                ? `Appointment SMS sent to ${sms.to} for queue ${queueNumber}.`
                : `Appointment SMS skipped: ${sms.reason}`);
        } catch (e) { console.warn('Appointment SMS skipped:', e.message); }

        res.json({ success: true, message: 'Appointment booked.', queueId: id, queueNumber, smsSent: true });
    } catch (error) {
        console.error('Book queue error:', error);
        res.status(500).json({ success: false, message: 'Failed to book appointment.' });
    }
});

// --- API: Reschedule my queue appointment (senior only; own) ---
// Seniors pick a new slot; status is reset to Pending and the booking is
// marked Rescheduled so staff can see the history in the daily schedule.
app.put('/api/queue/:queueId/reschedule', requireAuth, requireRole('senior'), async (req, res) => {
    const { queueId } = req.params;
    const { date, time } = req.body;
    const actor = req.authUser;
    try {
        if (!date || !time) return res.status(400).json({ success: false, message: 'date and time are required.' });
        const scheduledAt = new Date(`${date}T${time}`).getTime();
        if (isNaN(scheduledAt)) return res.status(400).json({ success: false, message: 'Invalid date/time format.' });
        if (scheduledAt < Date.now()) return res.status(400).json({ success: false, message: 'Cannot reschedule to a past slot.' });
        const workDay = isWorkingDay(date);
        if (!workDay.ok) return res.status(400).json({ success: false, message: workDay.message });
        const queueRef = admin.database().ref(`queue/${queueId}`);
        const snap = await queueRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Queue appointment not found.' });
        const q = snap.val();
        if (q.uid !== actor.uid) return res.status(403).json({ success: false, message: 'You may only reschedule your own appointments.' });
        if (['Attended', 'Missed', 'Declined', 'Cancelled', 'Approved'].includes(q.status)) {
            const msg = q.status === 'Declined'
                ? 'This appointment request was declined and can no longer be rescheduled. Please book a new schedule.'
                : q.status === 'Cancelled'
                    ? 'This appointment was cancelled and can no longer be rescheduled. Please book a new schedule.'
                    : q.status === 'Approved'
                        ? 'This appointment is already approved and can no longer be rescheduled. You may cancel it and book a new schedule.'
                        : 'Completed visits can no longer be rescheduled.';
            return res.status(400).json({ success: false, message: msg });
        }

        // Regenerate the queue number for the new visit date so each daily
        // schedule stays sequential.
        const dateKey = String(date).replace(/-/g, '');
        const daySnap = await admin.database().ref('queue')
            .orderByChild('date').equalTo(date)
            .once('value');
        const seq = String((daySnap.exists() ? Object.keys(daySnap.val()).length : 0) + 1).padStart(3, '0');

        await queueRef.update({
            date, time, scheduledAt,
            queueNumber: `Q-${dateKey}-${seq}`,
            status: 'Rescheduled',
            rescheduledAt: Date.now(),
            updatedBy: actor.uid,
            updatedAt: Date.now()
        });
        await writeAuditLog('QUEUE_APPOINTMENT_RESCHEDULED', actor, actor.uid, queueId,
            `Rescheduled to ${date} at ${time}`);
        res.json({ success: true, message: 'Appointment rescheduled.', queueNumber: `Q-${dateKey}-${seq}` });
    } catch (error) {
        console.error('Reschedule queue error:', error);
        res.status(500).json({ success: false, message: 'Failed to reschedule appointment.' });
    }
});

// --- API: Cancel my queue appointment (senior only; own; pending only) ---
app.delete('/api/queue/:queueId', requireAuth, requireRole('senior'), async (req, res) => {
    const { queueId } = req.params;
    const actor = req.authUser;
    try {
        const queueRef = admin.database().ref(`queue/${queueId}`);
        const snap = await queueRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Queue appointment not found.' });
        const q = snap.val();
        if (q.uid !== actor.uid) return res.status(403).json({ success: false, message: 'You may only cancel your own appointments.' });
        if (!['Pending', 'Rescheduled', 'Approved'].includes(q.status)) return res.status(400).json({ success: false, message: 'Only pending, rescheduled or approved appointments can be cancelled.' });

        await writeAuditLog('QUEUE_APPOINTMENT_CANCELLED', actor, actor.uid, queueId,
            `Cancelled appointment on ${q.date} at ${q.time}`);
        await queueRef.remove();

        res.json({ success: true, message: 'Appointment cancelled.' });
    } catch (error) {
        console.error('Cancel queue error:', error);
        res.status(500).json({ success: false, message: 'Failed to cancel appointment.' });
    }
});

// --- API: Update queue status (admin/staff only) ---
// Employees may Approve / Decline senior-booked checkup appointments from the
// Health Records tab. Approving/Declining mirrors a notification + health log
// entry so the senior instantly sees the decision on their portal.
app.put('/api/queue/:queueId/status', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { queueId } = req.params;
    const { status, attendedAt, note } = req.body;
    const actor = req.authUser;
    try {
        const validStatuses = ['Pending', 'Attended', 'Missed', 'Rescheduled', 'Approved', 'Declined'];
        if (!validStatuses.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status. Allowed: ' + validStatuses.join(', ') });

        const queueRef = admin.database().ref(`queue/${queueId}`);
        const snap = await queueRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Queue appointment not found.' });
        const q = snap.val();

        const updates = { status };
        if (status === 'Attended') updates.attendedAt = attendedAt ? Number(attendedAt) : Date.now();
        if (note) updates.decisionNote = String(note).slice(0, 300);
        updates.updatedBy = actor.uid;
        updates.updatedByName = actor.name || actor.email || '';
        updates.updatedAt = Date.now();
        // Preserve WHO made each type of decision. updatedByName is overwritten on
        // every status change, so these per-decision fields keep the full history
        // (e.g. who approved a visit even after another staff member marks it done).
        if (status === 'Approved') {
            updates.approvedBy = actor.uid;
            updates.approvedByName = actor.name || actor.email || '';
            updates.approvedAt = Date.now();
        } else if (status === 'Declined') {
            updates.declinedBy = actor.uid;
            updates.declinedByName = actor.name || actor.email || '';
            updates.declinedAt = Date.now();
        } else if (status === 'Attended') {
            updates.attendedBy = actor.uid;
            updates.attendedByName = actor.name || actor.email || '';
        }

        await queueRef.update(updates);

        const auditAction = status === 'Approved' ? 'QUEUE_APPOINTMENT_APPROVED'
            : status === 'Declined' ? 'QUEUE_APPOINTMENT_DECLINED'
            : 'QUEUE_APPOINTMENT_STATUS_UPDATED';
        await writeAuditLog(auditAction, actor, q.uid, queueId,
            `Marked as ${status} (service: ${q.service || 'N/A'})`);

        // Mirror the decision to the senior (notification + health log) so it
        // shows up on their portal without polling — same pattern as booking.
        if (status === 'Approved' || status === 'Declined' || status === 'Attended') {
            try {
                const now = Date.now();
                const approved = status === 'Approved';
                const attended = status === 'Attended';
                const reason = updates.decisionNote ? ` Reason: ${updates.decisionNote}` : '';
                const mirrorTitle = attended ? 'Visit Completed ✅'
                    : approved ? 'Appointment Approved ✅' : 'Appointment Declined ❌';
                const mirrorDesc = attended
                    ? `Your ${q.service || 'appointment'} visit on ${q.date} at ${q.time} (queue ${q.queueNumber || 'N/A'}) has been marked as done. You may now book a new appointment anytime.`
                    : approved
                        ? `Your ${q.service || 'appointment'} request on ${q.date} at ${q.time} (queue ${q.queueNumber || 'N/A'}) has been approved. Please arrive 15 minutes early.${reason}`
                        : `Sorry, your ${q.service || 'appointment'} request on ${q.date} at ${q.time} (queue ${q.queueNumber || 'N/A'}) was declined. You may book a new schedule anytime.${reason}`;
                await admin.database().ref(`users/${q.uid}/notifications/notif_${now}`).set({
                    title: mirrorTitle,
                    description: mirrorDesc,
                    createdAt: now
                });
                await admin.database().ref(`users/${q.uid}/health/logs/log_${now}`).set({
                    type: 'checkup',
                    title: attended ? 'Visit Completed' : approved ? 'Appointment Approved' : 'Appointment Declined',
                    description: attended
                        ? `${q.service || 'Appointment'} on ${q.date} at ${q.time} completed. Queue ${q.queueNumber || 'N/A'}.`
                        : `${q.service || 'Appointment'} on ${q.date} at ${q.time}. Queue ${q.queueNumber || 'N/A'}.${reason}`,
                    createdAt: now,
                    status
                });
            } catch (e) { console.warn('Decision mirror skipped:', e.message); }
        }

        res.json({ success: true, message: `Appointment marked as ${status}.` });
    } catch (error) {
        console.error('Update queue status error:', error);
        res.status(500).json({ success: false, message: 'Failed to update appointment status.' });
    }
});

// --- API: Log attendance (admin/staff only) ---
app.post('/api/attendance/log', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { queueId, status, attendedAt, note } = req.body;
    const actor = req.authUser;
    try {
        if (!queueId) return res.status(400).json({ success: false, message: 'queueId is required.' });
        const validStatuses = ['Attended', 'Missed', 'Rescheduled'];
        if (!validStatuses.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status. Allowed: ' + validStatuses.join(', ') });

        const queueRef = admin.database().ref(`queue/${queueId}`);
        const snap = await queueRef.once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Queue appointment not found.' });
        const q = snap.val();

        const attRef = admin.database().ref('attendance').push();
        const attData = {
            id: attRef.key,
            queueId,
            uid: q.uid,
            name: q.name || '',
            date: q.date,
            time: q.time,
            service: q.service || '',
            status,
            attendedAt: attendedAt ? Number(attendedAt) : Date.now(),
            note: String(note || '').slice(0, 300),
            recordedBy: actor.uid,
            recordedByName: actor.name || actor.email || '',
            recordedAt: Date.now()
        };
        await attRef.set(attData);

        const queueUpdates = { status };
        if (status === 'Attended') queueUpdates.attendedAt = Date.now();
        queueUpdates.updatedBy = actor.uid;
        queueUpdates.updatedByName = actor.name || actor.email || '';
        queueUpdates.updatedAt = Date.now();
        // Per-decision actor tracking (see PUT /api/queue/:queueId/status)
        if (status === 'Attended') {
            queueUpdates.attendedBy = actor.uid;
            queueUpdates.attendedByName = actor.name || actor.email || '';
        }
        await queueRef.update(queueUpdates);

        await writeAuditLog('ATTENDANCE_LOGGED', actor, q.uid, attRef.key,
            `Attendance logged: ${status} for ${q.service || 'appointment'} on ${q.date}`);

        res.json({ success: true, message: 'Attendance logged.', attendanceId: attRef.key });
    } catch (error) {
        console.error('Log attendance error:', error);
        res.status(500).json({ success: false, message: 'Failed to log attendance.' });
    }
});

// --- API: Get announcements (all authenticated; read-only) ---
app.get('/api/announcements', requireAuth, async (req, res) => {
    const actor = req.authUser;
    try {
        const snap = await admin.database().ref('announcements').once('value');
        const items = snap.val() || {};
        const result = Object.values(items)
            .sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0))
            .slice(0, 50);
        await writeAuditLog('ANNOUNCEMENTS_VIEWED', actor, null, null,
            `Viewed announcements (${result.length} items)`);
        res.json({ success: true, announcements: result });
    } catch (error) {
        console.error('Announcements error:', error);
        res.status(500).json({ success: false, message: 'Failed to load announcements.' });
    }
});

// --- API: Create announcement (admin only) ---
app.post('/api/announcements', requireAuth, requireRole('admin'), async (req, res) => {
    const { title, message, priority, target } = req.body;
    const actor = req.authUser;
    try {
        if (!title || !message) return res.status(400).json({ success: false, message: 'title and message are required.' });
        const id = admin.database().ref('announcements').push().key;
        const data = {
            id,
            title: String(title).slice(0, 120),
            message: String(message).slice(0, 2000),
            priority: ['high', 'normal', 'low'].includes(priority) ? priority : 'normal',
            target: target || 'all',
            postedBy: actor.uid,
            postedByName: actor.name || actor.email || '',
            postedAt: Date.now()
        };
        await admin.database().ref(`announcements/${id}`).set(data);
        await writeAuditLog('ANNOUNCEMENT_POSTED', actor, null, id,
            `Posted announcement: ${data.title}`);

        try {
            await admin.database().ref(`notifications/ann_${id}`).set({
                type: 'announcement',
                title: data.title,
                message: data.message,
                priority: data.priority,
                target: data.target,
                createdAt: Date.now()
            });
        } catch (e) { /* non-fatal */ }

        res.json({ success: true, message: 'Announcement posted.', announcementId: id });
    } catch (error) {
        console.error('Create announcement error:', error);
        res.status(500).json({ success: false, message: 'Failed to post announcement.' });
    }
});

// --- API: Get attendance log (admin/staff only) ---
app.get('/api/attendance', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { status, date } = req.query;
    const actor = req.authUser;
    try {
        const ref = admin.database().ref('attendance');
        const snap = await ref.once('value');
        const all = snap.val() || {};
        const result = [];
        Object.values(all).forEach(a => {
            if (status && a.status !== status) return;
            if (date && new Date(a.attendedAt).toDateString() !== new Date(date).toDateString()) return;
            result.push(a);
        });
        result.sort((a, b) => (b.attendedAt || 0) - (a.attendedAt || 0));
        res.json({ success: true, attendance: result });
    } catch (error) {
        console.error('Attendance list error:', error);
        res.status(500).json({ success: false, message: 'Failed to load attendance.' });
    }
});

// ============================================================
// Phase 2: Benefits Backend - Eligibility Engine
// Barangay Mapping + Budget Guard + QR Verification
// Per thesis requirements
// Firebase RTDB = single source of truth
// ============================================================

// --- Helper: verify QR token ---
function verifyQRToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('|');
    if (parts.length !== 3) return null;
    const [prefix, uid, hash] = parts;
    if (prefix !== 'SC1') return null;
    const secret = process.env.QR_SECRET || 'silvercare-default-secret';
    const expected = crypto.createHash('sha256')
        .update(uid + '|' + secret)
        .digest('hex').slice(0, 16);
    if (hash !== expected) return null;
    return { uid, valid: true };
}

// --- Helper: check duplicate claim ---
async function checkDuplicateClaim(seniorUid, benefitId, serviceMonth) {
    const ref = admin.database().ref('claims');
    const snap = await ref.orderByChild('seniorUid').equalTo(seniorUid).once('value');
    const claims = snap.val() || {};
    for (const key of Object.keys(claims)) {
        const c = claims[key];
        if (c.benefitId === benefitId && c.serviceMonth === serviceMonth &&
            (c.status === 'Approved' || c.status === 'Processing')) {
            return { duplicate: true, claimId: key, existing: c };
        }
    }
    return { duplicate: false };
}

// --- Helper: get benefit budget ---
async function getBenefitBudget(benefitId) {
    const snap = await admin.database().ref('benefits/' + benefitId).once('value');
    if (!snap.exists()) return null;
    return snap.val();
}

// --- Helper: check budget available ---
async function checkBudgetAvailable(benefitId, serviceMonth) {
    const benefit = await getBenefitBudget(benefitId);
    if (!benefit) return { available: false, reason: 'Benefit not found' };
    const claimedSnap = await admin.database().ref('claims')
        .orderByChild('benefitId').equalTo(benefitId).once('value');
    let claimed = 0;
    const claims = claimedSnap.val() || {};
    for (const key of Object.keys(claims)) {
        const c = claims[key];
        const cMonth = c.serviceMonth || (c.claimYear + '-' + String(c.serviceMonth || 0).padStart(2, '0'));
        if (c.status === 'Approved' && cMonth === serviceMonth) {
            claimed += (Number(c.amount) || 0);
        }
    }
    const budget = Number(benefit.monthlyBudget) || 0;
    const remaining = Math.max(0, budget - claimed);
    return { available: remaining > 0, claimed, budget, remaining };
}

// --- API: Generate QR code for senior ---
app.post('/api/qr/generate', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid } = req.body;
    const actor = req.authUser;
    try {
        if (!uid) return res.status(400).json({ success: false, message: 'uid is required.' });
        const userSnap = await admin.database().ref('users/' + uid).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior not found.' });
        
        const existingSnap = await admin.database().ref('qrCodes/' + uid).once('value');
        if (existingSnap.exists()) {
            const existing = existingSnap.val();
            res.json({ success: true, qrCode: existing, message: 'QR code already exists for this senior.' });
            return;
        }
        
        const secret = process.env.QR_SECRET || 'silvercare-default-secret';
        const hash = crypto.createHash('sha256')
            .update(uid + '|' + secret)
            .digest('hex').slice(0, 16);
        
        const qrCode = {
            uid: uid,
            token: 'SC1|' + uid + '|' + hash,
            generatedBy: actor.uid,
            generatedByName: actor.name || actor.email || '',
            generatedAt: Date.now(),
            lastUsed: null,
            usageCount: 0
        };
        
        await admin.database().ref('qrCodes/' + uid).set(qrCode);
        await writeAuditLog('QR_GENERATED', actor, uid, null, 'QR code generated for senior citizen');
        
        res.json({ success: true, qrCode: qrCode, message: 'QR code generated successfully.' });
    } catch (error) {
        console.error('QR generation error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate QR code.' });
    }
});

// --- API: Verify QR code ---
app.post('/api/qr/verify', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { token } = req.body;
    const actor = req.authUser;
    try {
        if (!token) return res.status(400).json({ success: false, message: 'token is required.' });
        
        const result = verifyQRToken(token);
        if (!result) {
            await writeAuditLog('QR_VERIFY_FAILED', actor, null, null, 'Invalid QR token verification attempt');
            return res.status(400).json({ success: false, message: 'Invalid QR code.', verified: false });
        }
        
        const qrSnap = await admin.database().ref('qrCodes/' + result.uid).once('value');
        if (!qrSnap.exists()) {
            await writeAuditLog('QR_VERIFY_FAILED', actor, result.uid, null, 'QR code not found in system');
            return res.status(404).json({ success: false, message: 'QR code not found in system.', verified: false });
        }
        
        const qrCode = qrSnap.val();
        const userSnap = await admin.database().ref('users/' + result.uid).once('value');
        const user = userSnap.val() || {};
        
        qrCode.lastUsed = Date.now();
        qrCode.usageCount = (qrCode.usageCount || 0) + 1;
        await admin.database().ref('qrCodes/' + result.uid).update(qrCode);
        
        await writeAuditLog('QR_VERIFIED', actor, result.uid, null, 'QR code verified successfully');
        
        res.json({
            success: true,
            verified: true,
            senior: {
                uid: result.uid,
                name: user.name || '',
                age: user.age || null,
                status: user.status || 'Unknown',
                barangayId: user.barangayId || null,
                benefitsEligible: user.benefitsEligible || false,
                registrationDate: user.registrationDate || null
            },
            qrCode: {
                token: qrCode.token,
                usageCount: qrCode.usageCount,
                lastUsed: qrCode.lastUsed,
                generatedAt: qrCode.generatedAt
            }
        });
    } catch (error) {
        console.error('QR verification error:', error);
        res.status(500).json({ success: false, message: 'Failed to verify QR code.' });
    }
});

// --- API: Check eligibility for benefits ---
app.post('/api/eligibility/check', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid, benefitId } = req.body;
    const actor = req.authUser;
    try {
        if (!uid) return res.status(400).json({ success: false, message: 'uid is required.' });
        
        const userSnap = await admin.database().ref('users/' + uid).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior not found.' });
        const user = userSnap.val();
        
        const eligibility = {
            uid: uid,
            name: user.name || '',
            age: user.age || null,
            status: user.status || 'Unknown',
            barangayId: user.barangayId || null,
            benefitsEligible: false,
            eligibleBenefits: [],
            ineligibleBenefits: [],
            checkedAt: Date.now(),
            checkedBy: actor.uid
        };
        
        if (user.status !== 'Active' || String(user.lifeStatus || 'Active') !== 'Active') {
            eligibility.reason = (String(user.lifeStatus || '') === 'Deceased' || String(user.status || '') === 'Deceased')
                ? 'Senior is marked Deceased — account archived, no pension or benefit'
                : 'Senior status is not Active';
            return res.json({ success: true, eligibility: eligibility });
        }
        
        const benefitsSnap = await admin.database().ref('benefits').once('value');
        const benefits = benefitsSnap.val() || {};
        
        for (const [bid, benefit] of Object.entries(benefits)) {
            const b = benefit || {};
            let eligible = true;
            let reasons = [];
            
            if (b.ageMin && user.age && user.age < b.ageMin) {
                eligible = false;
                reasons.push('Age requirement not met (min: ' + b.ageMin + ')');
            }
            if (b.ageMax && user.age && user.age > b.ageMax) {
                eligible = false;
                reasons.push('Age requirement exceeded (max: ' + b.ageMax + ')');
            }
            
            if (b.barangayId && user.barangayId !== b.barangayId) {
                eligible = false;
                reasons.push('Barangay mismatch');
            }
            
            if (b.requiredDocuments && Array.isArray(b.requiredDocuments)) {
                const docsRef = admin.database().ref('users/' + uid + '/documents');
                const docsSnap = await docsRef.once('value');
                const docs = docsSnap.val() || {};
                const hasAllDocs = b.requiredDocuments.every(doc => docs[doc]);
                if (!hasAllDocs) {
                    eligible = false;
                    const missing = b.requiredDocuments.filter(doc => !docs[doc]);
                    reasons.push('Missing documents: ' + missing.join(', '));
                }
            }
            
            const result = {
                benefitId: bid,
                name: b.name || bid,
                eligible: eligible,
                reasons: reasons
            };
            
            if (eligible) {
                eligibility.eligibleBenefits.push(result);
            } else {
                eligibility.ineligibleBenefits.push(result);
            }
        }
        
        eligibility.benefitsEligible = eligibility.eligibleBenefits.length > 0;
        
        await writeAuditLog('ELIGIBILITY_CHECKED', actor, uid, null, 'Eligibility check completed for ' + eligibility.eligibleBenefits.length + ' benefits');
        
        res.json({ success: true, eligibility: eligibility });
    } catch (error) {
        console.error('Eligibility check error:', error);
        res.status(500).json({ success: false, message: 'Failed to check eligibility.' });
    }
});

// --- API: Submit claim for benefit ---
app.post('/api/claims/submit', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid, benefitId, serviceMonth, amount, documents, notes } = req.body;
    const actor = req.authUser;
    try {
        if (!uid || !benefitId || !serviceMonth) {
            return res.status(400).json({ success: false, message: 'uid, benefitId, and serviceMonth are required.' });
        }
        
        const userSnap = await admin.database().ref('users/' + uid).once('value');
        if (!userSnap.exists()) return res.status(404).json({ success: false, message: 'Senior not found.' });
        const user = userSnap.val();

        // Deceased gate: an archived Deceased senior must never have a new claim
        // filed against their record, even through a direct API call with a
        // stale dashboard (the UI already hides these seniors).
        if (String(user.lifeStatus || '') === 'Deceased' || String(user.status || '') === 'Deceased') {
            await writeAuditLog('CLAIM_SUBMIT_BLOCKED_DECEASED', actor, uid, null,
                `Blocked claim submission for ${user.name || uid} — account is marked Deceased (archived).`);
            return res.status(403).json({
                success: false,
                message: 'This senior have passed away, please go to OSCA if you think this is an error'
            });
        }

        const duplicateCheck = await checkDuplicateClaim(uid, benefitId, serviceMonth);
        if (duplicateCheck.duplicate) {
            await writeAuditLog('CLAIM_DUPLICATE', actor, uid, duplicateCheck.claimId, 
                'Duplicate claim attempt for benefit ' + benefitId + ' month ' + serviceMonth);
            return res.status(409).json({ 
                success: false, 
                message: 'Duplicate claim detected. Existing claim ID: ' + duplicateCheck.claimId,
                duplicateClaimId: duplicateCheck.claimId 
            });
        }
        
        const budgetCheck = await checkBudgetAvailable(benefitId, serviceMonth);
        if (!budgetCheck.available) {
            await writeAuditLog('CLAIM_BUDGET_EXCEEDED', actor, uid, null, 
                'Claim rejected - budget exceeded for benefit ' + benefitId + ' month ' + serviceMonth);
            return res.status(400).json({ 
                success: false, 
                message: 'Monthly budget exceeded for this benefit.',
                budgetInfo: budgetCheck 
            });
        }
        
        const claimRef = admin.database().ref('claims').push();
        const claimId = claimRef.key;
        
        const claimData = {
            id: claimId,
            uid: uid,
            beneficiaryName: user.name || '',
            benefitId: benefitId,
            benefitName: '',
            serviceMonth: serviceMonth,
            claimYear: parseInt(serviceMonth.split('-')[0]) || new Date().getFullYear(),
            amount: Number(amount) || 0,
            documents: documents || {},
            notes: notes || '',
            status: 'Processing',
            submittedBy: actor.uid,
            submittedByName: actor.name || actor.email || '',
            submittedAt: Date.now(),
            processedBy: null,
            processedByName: null,
            processedAt: null,
            approvalNotes: null,
            rejectionReason: null
        };
        
        const benefitSnap = await admin.database().ref('benefits/' + benefitId).once('value');
        if (benefitSnap.exists()) {
            claimData.benefitName = (benefitSnap.val() || {}).name || benefitId;
        }
        
        await claimRef.set(claimData);
        
        await writeAuditLog('CLAIM_SUBMITTED', actor, uid, claimId, 
            'Claim submitted for benefit ' + benefitId);
        
        res.json({ 
            success: true, 
            message: 'Claim submitted successfully.', 
            claimId: claimId,
            status: 'Processing'
        });
    } catch (error) {
        console.error('Claim submission error:', error);
        res.status(500).json({ success: false, message: 'Failed to submit claim.' });
    }
});

// --- API: List claims ---
app.get('/api/claims', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { uid, benefitId, status, month, limit } = req.query;
    const actor = req.authUser;
    try {
        const ref = admin.database().ref('claims');
        const snap = await ref.once('value');
        let claims = snap.val() || {};
        claims = Object.entries(claims).map(([k, v]) => ({ id: k, ...v }));
        
        if (uid) claims = claims.filter(c => c.uid === uid);
        if (benefitId) claims = claims.filter(c => c.benefitId === benefitId);
        if (status) claims = claims.filter(c => c.status === status);
        if (month) claims = claims.filter(c => c.serviceMonth === month);
        
        claims.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
        
        if (limit) claims = claims.slice(0, parseInt(limit));
        
        res.json({ success: true, claims: claims, total: claims.length });
    } catch (error) {
        console.error('Claims list error:', error);
        res.status(500).json({ success: false, message: 'Failed to list claims.' });
    }
});

// --- API: Get my claims (senior only) ---
app.get('/api/claims/my', requireAuth, requireRole('senior'), async (req, res) => {
    const actor = req.authUser;
    try {
        const ref = admin.database().ref('claims');
        const snap = await ref.orderByChild('uid').equalTo(actor.uid).once('value');
        const claims = snap.val() || {};
        const result = Object.entries(claims).map(([k, v]) => ({ id: k, ...v }));
        result.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
        
        await writeAuditLog('MY_CLAIMS_VIEWED', actor, actor.uid, null, 'Senior viewed own claims');
        
        res.json({ success: true, claims: result });
    } catch (error) {
        console.error('My claims error:', error);
        res.status(500).json({ success: false, message: 'Failed to load your claims.' });
    }
});

// --- API: Get claim details ---
app.get('/api/claims/:claimId', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { claimId } = req.params;
    const actor = req.authUser;
    try {
        const snap = await admin.database().ref('claims/' + claimId).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Claim not found.' });
        const claim = snap.val();
        
        await writeAuditLog('CLAIM_VIEWED', actor, claim.uid, claimId, 'Claim details viewed');
        
        res.json({ success: true, claim: claim });
    } catch (error) {
        console.error('Claim details error:', error);
        res.status(500).json({ success: false, message: 'Failed to get claim details.' });
    }
});

// --- API: Update claim status ---
app.put('/api/claims/:claimId/status', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { claimId } = req.params;
    const { status, notes, rejectionReason } = req.body;
    const actor = req.authUser;
    try {
        const validStatuses = ['Processing', 'Approved', 'Rejected', 'Paid'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status.' });
        }
        
        const snap = await admin.database().ref('claims/' + claimId).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Claim not found.' });
        const claim = snap.val();
        
        const updates = {
            status: status,
            processedBy: actor.uid,
            processedByName: actor.name || actor.email || '',
            processedAt: Date.now()
        };
        
        if (status === 'Approved') {
            updates.approvalNotes = notes || '';
        } else if (status === 'Rejected') {
            updates.rejectionReason = rejectionReason || notes || 'No reason provided';
        }
        
        await admin.database().ref('claims/' + claimId).update(updates);

        // Official status SMS (TextBee) — best-effort and never awaited, so a
        // sleeping gateway can never delay the staff member's status change:
        //   Approved / Processing -> "releasing" (payout is being prepared)
        //   Paid                  -> "released"  (money handed to the senior)
        //   Rejected              -> declined notice, with the stated reason
        const claimLabel = String(claim.serviceType || claim.benefitType || 'Assistance');
        const isPensionClaim = /pension/i.test(claimLabel);
        const smsUid = claim.uid || claim.seniorUid;
        const smsCommon = {
            amount: String(claim.amount || claim.paidAmount || ''),
            serviceType: claimLabel,
            refNumber: claim.refNumber || String(claimId).slice(-8).toUpperCase()
        };
        if (smsUid && (status === 'Approved' || status === 'Processing')) {
            notifySeniorSms(smsUid, isPensionClaim ? 'pension_releasing' : 'claim_releasing', smsCommon)
                .catch(err => console.warn('Releasing SMS skipped:', err.message));
        } else if (smsUid && status === 'Paid') {
            notifySeniorSms(smsUid, isPensionClaim ? 'pension_released' : 'claim_released', smsCommon)
                .catch(err => console.warn('Released SMS skipped:', err.message));
        } else if (smsUid && status === 'Rejected') {
            notifySeniorSms(smsUid, 'claim_declined', { ...smsCommon, reason: updates.rejectionReason })
                .catch(err => console.warn('Decline SMS skipped:', err.message));
        }
        
        await writeAuditLog('CLAIM_STATUS_UPDATED', actor, claim.uid, claimId, 
            'Claim ' + status);
        
        res.json({ success: true, message: 'Claim status updated to ' + status });
    } catch (error) {
        console.error('Claim status update error:', error);
        res.status(500).json({ success: false, message: 'Failed to update claim status.' });
    }
});

// --- API: Get budget status for benefit ---
app.get('/api/budget/:benefitId', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const { benefitId } = req.params;
    const { month } = req.query;
    const actor = req.authUser;
    try {
        const benefit = await getBenefitBudget(benefitId);
        if (!benefit) return res.status(404).json({ success: false, message: 'Benefit not found.' });
        
        const serviceMonth = month || (new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0'));
        const budgetCheck = await checkBudgetAvailable(benefitId, serviceMonth);
        
        res.json({
            success: true,
            benefitId: benefitId,
            benefitName: benefit.name || benefitId,
            serviceMonth: serviceMonth,
            monthlyBudget: benefit.monthlyBudget || 0,
            totalClaimed: budgetCheck.claimed || 0,
            remainingBudget: budgetCheck.remaining || 0,
            budgetAvailable: budgetCheck.available
        });
    } catch (error) {
        console.error('Budget check error:', error);
        res.status(500).json({ success: false, message: 'Failed to check budget.' });
    }
});

// --- API: Manage benefits (CRUD) ---
app.get('/api/benefits', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const actor = req.authUser;
    try {
        const snap = await admin.database().ref('benefits').once('value');
        const benefits = snap.val() || {};
        const result = Object.entries(benefits).map(([k, v]) => ({ id: k, ...v }));
        res.json({ success: true, benefits: result });
    } catch (error) {
        console.error('Benefits list error:', error);
        res.status(500).json({ success: false, message: 'Failed to list benefits.' });
    }
});

app.post('/api/benefits', requireAuth, requireRole('admin'), async (req, res) => {
    const { id, name, description, amount, monthlyBudget, ageMin, ageMax, barangayId, requiredDocuments } = req.body;
    const actor = req.authUser;
    try {
        if (!id || !name) return res.status(400).json({ success: false, message: 'id and name are required.' });
        
        const benefitData = {
            id: id,
            name: String(name).slice(0, 100),
            description: String(description || '').slice(0, 500),
            amount: Number(amount) || 0,
            monthlyBudget: Number(monthlyBudget) || 0,
            ageMin: Number(ageMin) || null,
            ageMax: Number(ageMax) || null,
            barangayId: barangayId || null,
            requiredDocuments: Array.isArray(requiredDocuments) ? requiredDocuments : [],
            createdAt: Date.now(),
            createdBy: actor.uid,
            createdByName: actor.name || actor.email || '',
            updatedAt: Date.now(),
            updatedBy: actor.uid,
            updatedByName: actor.name || actor.email || ''
        };
        
        await admin.database().ref('benefits/' + id).set(benefitData);
        await writeAuditLog('BENEFIT_CREATED', actor, null, id, 'Benefit created: ' + name);
        
        res.json({ success: true, message: 'Benefit created successfully.', benefitId: id });
    } catch (error) {
        console.error('Benefit creation error:', error);
        res.status(500).json({ success: false, message: 'Failed to create benefit.' });
    }
});

app.put('/api/benefits/:benefitId', requireAuth, requireRole('admin'), async (req, res) => {
    const { benefitId } = req.params;
    const { name, description, amount, monthlyBudget, ageMin, ageMax, barangayId, requiredDocuments } = req.body;
    const actor = req.authUser;
    try {
        const snap = await admin.database().ref('benefits/' + benefitId).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Benefit not found.' });
        
        const updates = {
            updatedAt: Date.now(),
            updatedBy: actor.uid,
            updatedByName: actor.name || actor.email || ''
        };
        
        if (name !== undefined) updates.name = String(name).slice(0, 100);
        if (description !== undefined) updates.description = String(description || '').slice(0, 500);
        if (amount !== undefined) updates.amount = Number(amount);
        if (monthlyBudget !== undefined) updates.monthlyBudget = Number(monthlyBudget);
        if (ageMin !== undefined) updates.ageMin = ageMin ? Number(ageMin) : null;
        if (ageMax !== undefined) updates.ageMax = ageMax ? Number(ageMax) : null;
        if (barangayId !== undefined) updates.barangayId = barangayId || null;
        if (requiredDocuments !== undefined) updates.requiredDocuments = Array.isArray(requiredDocuments) ? requiredDocuments : [];
        
        await admin.database().ref('benefits/' + benefitId).update(updates);
        await writeAuditLog('BENEFIT_UPDATED', actor, null, benefitId, 'Benefit updated');
        
        res.json({ success: true, message: 'Benefit updated successfully.' });
    } catch (error) {
        console.error('Benefit update error:', error);
        res.status(500).json({ success: false, message: 'Failed to update benefit.' });
    }
});

app.delete('/api/benefits/:benefitId', requireAuth, requireRole('admin'), async (req, res) => {
    const { benefitId } = req.params;
    const actor = req.authUser;
    try {
        const snap = await admin.database().ref('benefits/' + benefitId).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Benefit not found.' });
        
        await admin.database().ref('benefits/' + benefitId).remove();
        await writeAuditLog('BENEFIT_DELETED', actor, null, benefitId, 'Benefit deleted');
        
        res.json({ success: true, message: 'Benefit deleted successfully.' });
    } catch (error) {
        console.error('Benefit deletion error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete benefit.' });
    }
});

// --- API: Get document requirements for benefit ---
app.get('/api/benefits/:benefitId/requirements', requireAuth, requireRole('admin', 'employee', 'senior'), async (req, res) => {
    const { benefitId } = req.params;
    const actor = req.authUser;
    try {
        const snap = await admin.database().ref('benefits/' + benefitId).once('value');
        if (!snap.exists()) return res.status(404).json({ success: false, message: 'Benefit not found.' });
        const benefit = snap.val();
        
        res.json({
            success: true,
            benefitId: benefitId,
            benefitName: benefit.name || benefitId,
            requiredDocuments: benefit.requiredDocuments || [],
            ageMin: benefit.ageMin || null,
            ageMax: benefit.ageMax || null,
            barangayId: benefit.barangayId || null
        });
    } catch (error) {
        console.error('Requirements error:', error);
        res.status(500).json({ success: false, message: 'Failed to get requirements.' });
    }
});

// ============================================================
// ARCHIVE FUNCTION — Automatic Daily Backup & Data Recovery Plan
// ------------------------------------------------------------
// Every 24 hours the database is exported NODE BY NODE (never as one giant
// ref('/') payload) and the `system/backups` subtree is EXCLUDED — the old
// implementation exported the whole database, including its own previous
// snapshots, back into system/backups/snapshots, so the archive doubled
// every day until root reads failed with "The specified payload is too
// large". In-database snapshots are pruned to BACKUP_RETENTION_DAYS via the
// tiny metadata index at system/backups/index.
// ON RAILWAY (or any host with an ephemeral filesystem) the snapshot is
// stored durably in Firebase itself at system/backups/snapshots/<fileName>
// and mirrored to system/backups/lastBackup so the Employee dashboard
// Archive tab can display recovery status. Locally (persistent disk) the
// snapshot is ALSO written to the local /backups folder (kept: newest 30)
// and can be downloaded from disk.
// ============================================================
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_RETENTION_DAYS = 30;
const BACKUP_FILENAME_PREFIX = 'silvercare-backup-';
const ARCHIVED_RECORD_STATUSES = ['Inactive', 'Deceased', 'Transferred', 'Archived'];
// Railway (and most container hosts) have an ephemeral filesystem: files
// written to disk vanish on redeploy/restart. Railway injects
// RAILWAY_ENVIRONMENT, so use that to detect it.
const IS_EPHEMERAL_FS = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN);

// Top nodes used when the shallow REST listing is unavailable (older Node
// without global fetch). Mirrors the live schema; unknown NEW nodes are
// still picked up automatically whenever shallow listing works.
const BACKUP_FALLBACK_TOP_NODES = ['users', 'auditLogs', 'claims', 'transactions', 'queue',
    'healthCenters', 'pensionSettings', 'notifications', 'appointments', 'appointmentRequests',
    'checkups', 'benefits', 'pensions', 'doctors', 'barangays', 'qrCodes', 'budget',
    'medicationRequests', 'reactivationRequests', 'attendance', 'idDocuments', 'records'];

// Shallow (keys-only) REST read — the Admin SDK cannot list children without
// downloading their payloads, and this database must never again be read as
// one giant payload.
async function shallowChildKeys(path) {
    const base = String(admin.app().options.databaseURL || '').replace(/\/+$/, '');
    if (!base || typeof fetch !== 'function') throw new Error('shallow read unavailable');
    const { access_token } = await admin.app().options.credential.getAccessToken();
    const clean = String(path || '').replace(/^\/+|\/+$/g, '');
    const res = await fetch(`${base}/${clean}.json?shallow=true&access_token=${encodeURIComponent(access_token)}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Object.keys((await res.json()) || {});
}

function listBackupFiles() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith(BACKUP_FILENAME_PREFIX) && f.endsWith('.json'))
        .sort(); // ascending — timestamp is embedded in the file name
}

async function runDatabaseBackup(trigger = 'automatic') {
    const startedAt = Date.now();

    // Export NODE BY NODE — never ref('/') (see comment above). The
    // `system/backups` subtree is skipped so snapshots can never nest inside
    // snapshots again. A node that fails to read is recorded as skipped
    // instead of failing the whole export.
    const data = {};
    const skipped = [];
    let topNodes;
    try {
        topNodes = await shallowChildKeys('');
    } catch (e) {
        console.warn('[Backup] shallow root listing unavailable, using fallback node list:', e.message);
        topNodes = BACKUP_FALLBACK_TOP_NODES;
    }
    for (const node of topNodes) {
        if (node === 'system') {
            let systemKeys;
            try { systemKeys = await shallowChildKeys('system'); }
            catch (e) { systemKeys = ['settings', 'healthConsentDefaults']; }
            for (const key of systemKeys) {
                if (key === 'backups') continue; // NEVER back up the backups
                try {
                    const s = await admin.database().ref(`system/${key}`).once('value');
                    if (s.exists()) { data.system = data.system || {}; data.system[key] = s.val(); }
                } catch (e) { skipped.push(`system/${key}`); }
            }
            continue;
        }
        try {
            const s = await admin.database().ref(node).once('value');
            if (s.exists()) data[node] = s.val();
        } catch (e) {
            skipped.push(node);
            console.warn(`[Backup] node "${node}" could not be exported:`, e.message);
        }
    }
    const users = data.users || {};
    const seniorList = Object.values(users).filter(u => u && u.role === 'senior');
    const archivedSeniors = seniorList.filter(u => ARCHIVED_RECORD_STATUSES.includes(String(u.lifeStatus || u.status || 'Active'))).length;
    const counts = {
        users: Object.keys(users).length,
        seniors: seniorList.length,
        activeSeniors: seniorList.length - archivedSeniors,
        archivedSeniors: archivedSeniors,
        claims: Object.keys(data.claims || {}).length,
        transactions: Object.keys(data.transactions || {}).length
    };

    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `${BACKUP_FILENAME_PREFIX}${stamp}.json`;
    const payload = JSON.stringify({
        meta: {
            createdAt: new Date(startedAt).toISOString(),
            trigger: trigger,
            retentionDays: BACKUP_RETENTION_DAYS,
            counts: counts,
            skipped: skipped
        },
        data: data
    });
    const sizeBytes = Buffer.byteLength(payload, 'utf8');

    // 1) Durable copy: store the snapshot IN Firebase itself so it survives
    //    Railway redeploys/restarts. Chunked into ~500 KB pieces to stay
    //    safely under RTDB per-write limits.
    const chunks = [];
    for (let i = 0; i < payload.length; i += 500000) chunks.push(payload.slice(i, i + 500000));
    const snapshotRef = admin.database().ref(`system/backups/snapshots/${fileName.replace(/\.json$/, '')}`);
    await snapshotRef.set({
        file: fileName,
        createdAt: startedAt,
        trigger: trigger,
        sizeBytes: sizeBytes,
        chunkCount: chunks.length,
        counts: counts
    });
    for (let i = 0; i < chunks.length; i++) {
        await snapshotRef.child(`chunks/${i}`).set(chunks[i]);
    }

    // Small metadata index (system/backups/index) — the only thing retention
    // ever lists, so pruning never downloads snapshot chunks.
    const snapshotId = fileName.replace(/\.json$/, '');
    await admin.database().ref(`system/backups/index/${snapshotId}`).set({
        file: fileName, createdAt: startedAt, trigger: trigger,
        sizeBytes: sizeBytes, chunkCount: chunks.length
    });

    // Prune old in-database snapshots (same 30-snapshot policy as local disk).
    try {
        const idxSnap = await admin.database().ref('system/backups/index').once('value');
        const ids = Object.keys(idxSnap.val() || {}).sort(); // names embed a sortable ISO timestamp
        const excess = ids.slice(0, Math.max(0, ids.length - BACKUP_RETENTION_DAYS));
        for (const id of excess) {
            await admin.database().ref(`system/backups/snapshots/${id}`).remove();
            await admin.database().ref(`system/backups/index/${id}`).remove();
        }
        if (excess.length) console.log(`[Backup] pruned ${excess.length} old snapshot(s).`);
    } catch (e) { console.warn('[Backup] snapshot retention skipped:', e.message); }

    // 2) Local disk copy (persistent locally; best-effort on ephemeral hosts)
    if (!IS_EPHEMERAL_FS) {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        fs.writeFileSync(path.join(BACKUP_DIR, fileName), payload, 'utf8');

        // Retention policy — keep only the newest N snapshots
        const files = listBackupFiles();
        while (files.length > BACKUP_RETENTION_DAYS) {
            const oldest = files.shift();
            try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)); } catch (e) { /* ignore */ }
        }
    }

    // Mirror backup status into the database for dashboard display
    await admin.database().ref('system/backups/lastBackup').set({
        at: startedAt,
        file: fileName,
        trigger: trigger,
        sizeBytes: sizeBytes,
        counts: counts,
        durationMs: Date.now() - startedAt
    });

    console.log(`[Backup] ${trigger} database backup created: ${fileName} (${(sizeBytes / 1024).toFixed(1)} KB)`);
    return { file: fileName, sizeBytes, counts, at: startedAt, trigger };
}

// Runs a backup whenever the most recent snapshot is older than 24h.
// Checked at boot and then every 30 minutes — this guarantees the
// "automatic daily backup" even if the server restarts mid-day.
function scheduleDailyBackups() {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const check = async () => {
        try {
            const snap = await admin.database().ref('system/backups/lastBackup/at').once('value');
            const last = snap.val() || 0;
            if (Date.now() - last >= DAY_MS) {
                const result = await runDatabaseBackup('automatic-daily');
                await writeAuditLog('DATABASE_BACKUP_CREATED',
                    { uid: 'system', role: 'system', name: 'Daily Backup Scheduler' },
                    null, result.file,
                    `Automatic daily backup created (${(result.sizeBytes / 1024).toFixed(1)} KB, ${result.counts.seniors} seniors)`);
            }
        } catch (e) {
            console.error('[Backup] scheduled backup failed:', e.message);
        }
    };
    setTimeout(check, 20000);           // shortly after boot
    setInterval(check, 30 * 60 * 1000); // re-check every 30 minutes
}
scheduleDailyBackups();

// --- API: Backup status for the Employee dashboard Archive tab ---
app.get('/api/archive/backup-status', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    try {
        const snap = await admin.database().ref('system/backups/lastBackup').once('value');
        const lastBackup = snap.val() || null;
        const files = listBackupFiles();
        const backups = files.slice(-10).reverse().map(f => {
            let st = { size: 0, mtimeMs: 0 };
            try { st = fs.statSync(path.join(BACKUP_DIR, f)); } catch (e) { /* ignore */ }
            return { file: f, sizeBytes: st.size, createdAt: st.mtimeMs };
        });
        res.json({
            success: true,
            lastBackup: lastBackup,
            fileCount: files.length,
            retentionDays: BACKUP_RETENTION_DAYS,
            backupIntervalHours: 24,
            backups: backups,
            nextRunInMs: lastBackup ? Math.max(0, (lastBackup.at || 0) + 24 * 60 * 60 * 1000 - Date.now()) : 0
        });
    } catch (error) {
        console.error('Backup status error:', error);
        res.status(500).json({ success: false, message: 'Failed to read backup status.' });
    }
});

// --- API: Trigger an immediate (manual) backup ---
app.post('/api/archive/backup-now', requireAuth, requireRole('admin', 'employee'), async (req, res) => {
    const actor = req.authUser;
    try {
        const result = await runDatabaseBackup('manual: ' + (actor.name || actor.email || actor.uid));
        await writeAuditLog('DATABASE_BACKUP_CREATED', actor, actor.uid, result.file,
            `Manual backup created (${(result.sizeBytes / 1024).toFixed(1)} KB, ${result.counts.seniors} seniors)`);
        res.json({ success: true, message: 'Backup created successfully.', backup: result });
    } catch (error) {
        console.error('Manual backup error:', error);
        res.status(500).json({ success: false, message: 'Failed to create backup: ' + error.message });
    }
});

// --- API: Download a backup snapshot (defaults to the most recent) ---
app.get('/api/archive/backup/download', requireAuth, requireRole('admin', 'employee'), (req, res) => {
    try {
        const requested = String(req.query.file || '');
        let fileName = requested;
        if (!fileName) {
            const files = listBackupFiles();
            if (files.length === 0) return res.status(404).json({ success: false, message: 'No backup files exist yet. Run a backup first.' });
            fileName = files[files.length - 1];
        }
        // Path-traversal guard — only plain backup file names are allowed
        if (!fileName.startsWith(BACKUP_FILENAME_PREFIX) || !fileName.endsWith('.json') ||
            fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            return res.status(400).json({ success: false, message: 'Invalid backup file name.' });
        }
        const filePath = path.join(BACKUP_DIR, fileName);
        if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Backup file not found.' });
        res.download(filePath, fileName);
    } catch (error) {
        console.error('Backup download error:', error);
        res.status(500).json({ success: false, message: 'Failed to download backup.' });
    }
});

// --- API: Full raw export of Firebase + Supabase (admin only) ---
// Powers the "Download Full Backup (ZIP)" button in Admin -> Settings.
// Uses the Admin SDK, which bypasses Realtime Database security rules —
// the browser cannot read the root node directly, but the server can.
app.get('/api/admin/backup/full-export', requireAuth, requireRole('admin'), async (req, res) => {
    const actor = req.authUser;
    try {
        // 1) Entire Firebase Realtime Database (every top-level node)
        const snap = await admin.database().ref('/').once('value');
        const firebase = snap.val() || {};

        // 2) Supabase mirror (seniors table rows + storage file inventory)
        let supabase;
        try {
            supabase = await seniorStore.exportAllData();
        } catch (err) {
            console.error('Supabase export failed:', err.message);
            supabase = { enabled: false, error: err.message };
        }

        await writeAuditLog('DATABASE_FULL_EXPORT', actor, actor.uid, null,
            `Full backup export downloaded (firebase nodes: ${Object.keys(firebase).length}, supabase: ${supabase.enabled ? 'included' : 'unavailable'})`);

        res.json({
            success: true,
            generatedAt: new Date().toISOString(),
            firebase: firebase,
            supabase: supabase
        });
    } catch (error) {
        console.error('Full export error:', error);
        res.status(500).json({ success: false, message: 'Failed to export database: ' + error.message });
    }
});

// Warn when the QR signing secret is left on the insecure default
if (!process.env.QR_SECRET) {
    console.warn('WARNING: QR_SECRET is not set - QR verification codes fall back to an insecure default. Set QR_SECRET in your deployment environment.');
}

// Fail-fast check for required production env vars.
// Locally these come from .env / serviceAccountKey.json; on Railway they
// MUST be set as service Variables or the deploy will crash-loop otherwise.
{
    const missing = [];
    if (!process.env.SERVICE_ACCOUNT_JSON && !fs.existsSync('./serviceAccountKey.json')) missing.push('SERVICE_ACCOUNT_JSON');
    if (!process.env.EMAIL_USER) missing.push('EMAIL_USER');
    if (!process.env.EMAIL_PASS) missing.push('EMAIL_PASS');
    if (!process.env.FIREBASE_API_KEY) missing.push('FIREBASE_API_KEY');
    if (!process.env.FIREBASE_AUTH_DOMAIN) missing.push('FIREBASE_AUTH_DOMAIN');
    if (!process.env.FIREBASE_PROJECT_ID) missing.push('FIREBASE_PROJECT_ID');
    if (!process.env.FIREBASE_STORAGE_BUCKET) missing.push('FIREBASE_STORAGE_BUCKET');
    if (!process.env.FIREBASE_MESSAGING_SENDER_ID) missing.push('FIREBASE_MESSAGING_SENDER_ID');
    if (!process.env.FIREBASE_APP_ID) missing.push('FIREBASE_APP_ID');
    if (!process.env.FIREBASE_DATABASE_URL) missing.push('FIREBASE_DATABASE_URL'); // REQUIRED: RTDB is in asia-southeast1 — the default-region fallback URL would be wrong
    if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (missing.length) {
        console.error('Missing required environment variables: ' + missing.join(', '));
        if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN) process.exit(1);
        else console.warn('Continuing locally — set these in .env (see .env.example).');
    }
}

app.listen(PORT, () => {
    console.log(`SilverCare Server running on port ${PORT}`);
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        console.log(`Public URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
    }
});

