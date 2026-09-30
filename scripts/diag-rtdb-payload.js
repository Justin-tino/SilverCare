#!/usr/bin/env node
// scripts/diag-rtdb-payload.js — READ-ONLY diagnostics for the
// "The specified payload is too large" errors on the production RTDB.
// Reports top-level node sizes/read-times, per-user node sizes (finds the
// accounts whose profile read blows the limit or the server's 10s budget)
// and the backup snapshot inventory. NOTHING is written.
// Run: node scripts/diag-rtdb-payload.js
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const rootDir = path.join(__dirname, '..');
let serviceAccount;
if (fs.existsSync(path.join(rootDir, 'serviceAccountKey.json'))) {
    serviceAccount = require(path.join(rootDir, 'serviceAccountKey.json'));
} else if (process.env.SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
    console.error('No service account credentials found.');
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
});

const db = admin.database();
const dbUrl = String(admin.app().options.databaseURL || '').replace(/\/+$/, '');

const sizeOf = v => { try { return Buffer.byteLength(JSON.stringify(v === undefined ? null : v), 'utf8'); } catch (e) { return -1; } };
const kb = n => (n < 0 ? 'n/a' : (n / 1024).toFixed(1) + ' KB');

async function timedRead(p) {
    const t0 = Date.now();
    try {
        const snap = await db.ref(p).once('value');
        return { ok: true, ms: Date.now() - t0, bytes: sizeOf(snap.val()), exists: snap.exists() };
    } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) };
    }
}

// REST shallow read — lists child keys WITHOUT downloading their payloads.
async function restShallow(p) {
    const { access_token } = await admin.app().options.credential.getAccessToken();
    const url = `${dbUrl}/${p}.json?shallow=true&access_token=${encodeURIComponent(access_token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
}

(async () => {
    console.log(`Database: ${dbUrl}`);

    // 1) Top-level keys via shallow read (tiny payload)
    let tops = [];
    try {
        const root = await restShallow('');
        tops = Object.keys(root || {});
        console.log(`Top-level nodes (${tops.length}): ${tops.join(', ')}`);
    } catch (e) {
        console.log('shallow root read failed:', e.message);
    }

    // 2) Full-read test per top-level node (skip system/backups payloads)
    console.log('\n-- full read test per top node (size + time) --');
    for (const t of tops) {
        if (t === 'system' || t === 'users') continue; // handled separately
        const r = await timedRead(t);
        console.log(r.ok
            ? `${t.padEnd(24)} ${r.exists ? kb(r.bytes) : '(empty)'} in ${r.ms}ms`
            : `${t.padEnd(24)} FAILED after ${r.ms}ms: ${r.error}`);
    }

    // 3) users: shallow list, then per-user full read to find fat/blocked accounts
    let uids = [];
    try {
        const usersShallow = await restShallow('users');
        uids = Object.keys(usersShallow || {});
        console.log(`\nusers: ${uids.length} account(s)`);
    } catch (e) {
        console.log('users shallow read failed:', e.message);
    }
    console.log('-- per-user read test (sorted by size desc) --');
    const results = [];
    for (const uid of uids) {
        const r = await timedRead(`users/${uid}`);
        results.push({ uid, ...r });
    }
    results.sort((a, b) => (b.bytes || (b.ok ? 0 : Number.MAX_SAFE_INTEGER)) - (a.bytes || (a.ok ? 0 : Number.MAX_SAFE_INTEGER)));
    let total = 0;
    for (const r of results) {
        if (r.ok) { total += Math.max(0, r.bytes); console.log(`${r.uid}  ${kb(r.bytes)} in ${r.ms}ms`); }
        else console.log(`${r.uid}  FAILED after ${r.ms}ms: ${r.error}`);
    }
    console.log(`users total (approx): ${kb(total)}`);

    // 4) system: settings + backups summary without reading all chunks
    const sysKeys = await (async () => { try { return Object.keys(await restShallow('system') || {}); } catch (e) { return []; } })();
    console.log(`\nsystem children: ${sysKeys.join(', ')}`);
    const last = await timedRead('system/backups/lastBackup');
    console.log(last.ok ? `system/backups/lastBackup: ${kb(last.bytes)} (${last.ms}ms)` : `system/backups/lastBackup FAILED: ${last.error}`);
    try {
        const snaps = Object.keys(await restShallow('system/backups/snapshots') || {});
        console.log(`system/backups/snapshots: ${snaps.length} snapshot(s)`);
        for (const name of snaps.slice(0, 10)) {
            const meta = await timedRead(`system/backups/snapshots/${name}`);
            console.log(`   ${name}: ${meta.ok ? kb(meta.bytes) + ' (missing chunks?)' : 'FAILED: ' + meta.error}`);
        }
    } catch (e) { console.log('snapshots shallow read failed:', e.message); }

    // 5) targeted big-field sizes for the 5 largest accounts
    console.log('\n-- big fields of the 5 largest accounts (targeted reads) --');
    for (const r of results.slice(0, 5)) {
        if (!r.ok) continue;
        console.log(`users/${r.uid} (total ${kb(r.bytes)}):`);
        for (const f of ['kycFaceImage', 'faceImage', 'kycIdFrontImage', 'kycIdBackImage', 'kycMedCertImage', 'kycIdImages', 'healthReports', 'notifications', 'benefits', 'health']) {
            const fr = await timedRead(`users/${r.uid}/${f}`);
            if (!fr.ok) { console.log(`   ${f}: FAILED after ${fr.ms}ms: ${fr.error}`); continue; }
            if (fr.exists) console.log(`   ${f}: ${kb(fr.bytes)} (${fr.ms}ms)`);
        }
    }

    process.exit(0);
})().catch(e => { console.error('fatal:', e); process.exit(1); });
