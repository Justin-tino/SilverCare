#!/usr/bin/env node
// scripts/supabase-import-all.js (part 1/2: bootstrap + users)
// ONE import: Firebase RTDB text -> Supabase tables,
//             Firebase base64    -> Storage files (private buckets).
// Layout: seniors/{ID-number}/face.jpg (+ senior-id/*, medical/*).
// Usage: node scripts/supabase-import-all.js --dry-run | (real)
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
} else { console.error('Missing serviceAccountKey.json'); process.exit(1); }
try { admin.app(); } catch {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
    });
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const stats = { tables: {}, images: 0, skipped: 0, failed: 0 };
const failures = [];
function toBuffer(payload) {
    if (!payload || typeof payload !== 'string' || payload.length < 100) return null;
    let mime = 'image/jpeg', b64 = payload;
    const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(payload);
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
module.exports = { admin, supabase, DRY_RUN, stats, failures, toBuffer, skey, seniorFolder, putFile, upsert };
