#!/usr/bin/env node
// scripts/migrate-firebase-to-supabase.js — PART 1/3: bootstrap+helpers
// FULL one-time Firebase RTDB -> Supabase migration.
//
//  WHAT IT MOVES:
//   users/*            -> profiles (+ seniors mirror) + seniors/{ID}/face.jpg etc.
//   claims/pensions/transactions/queue/appointmentRequests/appointments/
//   checkups/doctors/healthCenters/barangays/benefits/attendance/
//   notifications/auditLogs/qrCodes/budget/system/reactivationRequests
//                      -> matching Supabase tables (typed) or records fallback
//   ALL base64 images  -> private Storage buckets as REAL files:
//     seniors/{ID}/face.jpg, seniors/{ID}/senior-id/*,
//     silvercare-archive/{node}/{key}/{field}.bin (text info as .json)
//  WHAT IT NEVER MOVES: passwords, OTP/email codes, password-reset tokens.
//
//  NEVER DELETES from Firebase (safe re-runnable import).
//  Firebase Auth (login) + Nodemailer/Brevo (email) stay untouched.
//
// Usage:
//   node scripts/migrate-firebase-to-supabase.js --dry-run   # preview only
//   node scripts/migrate-firebase-to-supabase.js             # real import
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');
const rootDir = path.join(__dirname, '..');
let serviceAccount;
if (fs.existsSync(path.join(rootDir, 'serviceAccountKey.json'))) {
    serviceAccount = require(path.join(rootDir, 'serviceAccountKey.json'));
} else if (process.env.SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else { console.error('Missing serviceAccountKey.json / SERVICE_ACCOUNT_JSON'); process.exit(1); }

try { admin.app(); } catch {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
    });
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const BUCKETS = ['seniors', 'senior-ids', 'medical-certifications', 'silvercare-archive'];
async function ensureBucket(name) {
    if (DRY_RUN) return true;
    const { error } = await supabase.storage.getBucket(name);
    if (error) {
        const { error: cErr } = await supabase.storage.createBucket(name, { public: false });
        if (cErr && !/already exists/i.test(cErr.message)) throw new Error(`bucket ${name}: ${cErr.message}`);
    }
    return true;
}

// ---- image helpers: base64/dataURL -> Buffer (never stored as text)
const DATA_URL_RE = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/;
function toBuffer(payload) {
    if (!payload || typeof payload !== 'string' || payload.length < 100) return null;
    let mime = 'image/jpeg', b64 = payload;
    const m = DATA_URL_RE.exec(payload);
    if (m) { mime = m[1].toLowerCase(); b64 = m[2]; }
    if (!/^(image\/(jpeg|jpg|png|webp)|application\/pdf)$/i.test(mime)) return null;
    try {
        const buf = Buffer.from(b64.replace(/\s/g, ''), 'base64');
        if (!buf.length || buf.length > 7 * 1024 * 1024) return null;
        return { buffer: buf, mimeType: mime === 'image/jpg' ? 'image/jpeg' : mime };
    } catch { return null; }
}
const skey = (v) => String(v == null ? '' : v).trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'unknown';
function seniorFolder(u) {
    const sid = String((u && (u.seniorId || u.oscaId)) || '').trim();
    const usable = sid && !/^(OSCA[-_ ]?PENDING|N\/?A|PENDING|NONE)$/i.test(sid);
    return skey(usable ? sid : (u && u.uid) || 'unknown');
}
async function putFile(bucket, storagePath, buffer, mimeType) {
    if (DRY_RUN) return storagePath;
    const { error } = await supabase.storage.from(bucket).upload(storagePath, buffer, { contentType: mimeType, upsert: true });
    if (error) throw new Error(error.message);
    return storagePath;
}
async function upsert(table, row, onConflict) {
    if (DRY_RUN) return;
    const { error } = await supabase.from(table).upsert(row, { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
}
const stats = { profiles: 0, seniorsMirror: 0, images: 0, textFiles: 0, rows: {}, fallback: 0, skipped: 0, failed: 0 };
const failures = [];
const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
        const o = {};
        for (const [k, val] of Object.entries(v)) {
            if (/^(password|passwordHash|otp|otpCode|verificationCode|resetToken|fileBase64|fileData|kycFaceImage|faceImage|kycIdFrontImage|kycIdBackImage|medCertImage|liveImage|referenceImage)$/i.test(k)) continue;
            o[k] = strip(val);
        }
        return o;
    }
    return (typeof v === 'string' && v.length > 20000) ? v.slice(0, 20000) : v;
};
module.exports = { admin, supabase, DRY_RUN, BUCKETS, ensureBucket, toBuffer, skey, seniorFolder, putFile, upsert, stats, failures, strip };
if (require.main === module) {
    const { runMigration } = require('./migrate-runner');
    const deps = { ...module.exports };
    runMigration(deps).then(() => process.exit(0)).catch((err) => {
        console.error('Migration failed:', err.message);
        process.exit(1);
    });
}

