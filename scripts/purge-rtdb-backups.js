#!/usr/bin/env node
// scripts/purge-rtdb-backups.js
// ---------------------------------------------------------------
// Removes the runaway `system/backups/snapshots` archive from the
// production Realtime Database.
//
// Why: the old daily-backup job exported the WHOLE database with
// ref('/') — including its own previous snapshots — and stored the
// result back under system/backups/snapshots. The archive therefore
// doubled every day (~950 MB after ~10 days) until (a) root reads
// failed with "The specified payload is too large" and (b) the huge
// in-flight reads starved all other operations (login profile reads
// timed out -> "Authentication service is temporarily unavailable").
//
// Nothing in the app READS individual snapshots (only the tiny
// system/backups/lastBackup metadata is displayed), and each newer
// snapshot is a superset of the older ones, so deleting the archive
// loses no unique data. A fresh LEAN export of the current database
// (without the backups subtree) is written to backups/ FIRST as a
// safety copy.
//
// Usage:
//   node scripts/purge-rtdb-backups.js            (dry run — lists only)
//   node scripts/purge-rtdb-backups.js --confirm  (performs the purge)
"use strict";
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
const CONFIRM = process.argv.includes('--confirm');

async function shallowKeys(p) {
    const { access_token } = await admin.app().options.credential.getAccessToken();
    const clean = String(p || '').replace(/^\/+|\/+$/g, '');
    const res = await fetch(`${dbUrl}/${clean}.json?shallow=true&access_token=${encodeURIComponent(access_token)}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Object.keys((await res.json()) || {});
}

(async () => {
    console.log(`Database: ${dbUrl}`);

    // 1) Inventory (names + per-snapshot size from tiny meta reads)
    let names = [];
    try { names = await shallowKeys('system/backups/snapshots'); } catch (e) { console.log('shallow list failed:', e.message); }
    let total = 0;
    for (const n of names.sort()) {
        const s = await db.ref(`system/backups/snapshots/${n}/sizeBytes`).once('value');
        const bytes = Number(s.val() || 0);
        total += bytes;
        console.log(`  ${n}: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    }
    console.log(`Snapshots: ${names.length}, total ${(total / 1024 / 1024).toFixed(1)} MB`);

    if (!CONFIRM) {
        console.log('\nDRY RUN — nothing deleted. Re-run with --confirm to purge.');
        process.exit(0);
    }

    // 2) Safety copy FIRST: lean export of the current DB minus the archive
    const tops = (await shallowKeys('')).filter(t => t !== 'system');
    let systemKeys = [];
    try { systemKeys = (await shallowKeys('system')).filter(k => k !== 'backups'); } catch (e) { /* ignore */ }
    const data = {};
    for (const t of tops) {
        const s = await db.ref(t).once('value');
        if (s.exists()) data[t] = s.val();
    }
    if (systemKeys.length) {
        data.system = {};
        for (const k of systemKeys) {
            const s = await db.ref(`system/${k}`).once('value');
            if (s.exists()) data.system[k] = s.val();
        }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(rootDir, 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `manual-pre-purge-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({
        meta: { createdAt: new Date().toISOString(), reason: 'pre-purge safety export (system/backups excluded)' },
        data
    }), 'utf8');
    console.log(`Safety export written: ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);

    // 3) The purge — one atomic delete of the whole archive (server-side)
    console.log('Deleting system/backups/snapshots ...');
    await db.ref('system/backups/snapshots').remove();
    await db.ref('system/backups/index').remove();
    console.log('Deleted.');

    // 4) Verify
    const left = await shallowKeys('system/backups/snapshots');
    console.log(`Verify: ${left.length} snapshot(s) remain.`);
    const t0 = Date.now();
    try {
        await db.ref('/').once('value');
        console.log(`Verify: full root read OK in ${Date.now() - t0}ms`);
    } catch (e) {
        console.log(`Verify: root read FAILED: ${e.message}`);
    }
    process.exit(0);
})().catch(e => { console.error('fatal:', e); process.exit(1); });
