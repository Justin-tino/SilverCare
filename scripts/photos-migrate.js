#!/usr/bin/env node
// scripts/photos-migrate.js — move legacy bucket files into photos/.
// Copies seniors/* + senior-ids/verified/* + medical-certifications/*
// into: photos/{ID-number}/... (face.jpg, senior-id/*, medical/*).
// Safe to re-run (upsert). Run: node scripts/photos-migrate.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { seniorFolderKey } = require('../lib/photoBucket');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

async function listAll(sb, bucket, prefix, depth = 0, out = []) {
    if (depth > 6 || out.length >= 10000) return out;
    const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error || !data) return out;
    for (const item of data) {
        const p = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id === null) await listAll(sb, bucket, p, depth + 1, out);
        else out.push(p);
    }
    return out;
}

async function main() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    await supabase.storage.createBucket('photos', { public: false }).then(() => {}, () => {});
    // Map uid -> senior folder via Firebase (for verified/pending uid paths)
    const rootDir = path.join(__dirname, '..');
    const sa = fs.existsSync(path.join(rootDir, 'serviceAccountKey.json'))
        ? require(path.join(rootDir, 'serviceAccountKey.json')) : JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    try { admin.app(); } catch {
        admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com` });
    }
    const users = (await admin.database().ref('users').once('value')).val() || {};
    const uidToFolder = {};
    for (const [uid, u] of Object.entries(users)) uidToFolder[uid] = seniorFolderKey({ ...(u || {}), uid });

    let copied = 0;
    // 1) seniors/{folder}/... -> photos/{folder}/... (same relative path)
    for (const p of await listAll(supabase, 'seniors', '')) {
        const { data, error } = await supabase.storage.from('seniors').download(p);
        if (error || !data) continue;
        const buf = Buffer.from(await data.arrayBuffer());
        const { error: upErr } = await supabase.storage.from('photos').upload(p, buf, { upsert: true });
        if (!upErr) copied++;
    }
    // 2) senior-ids verified/pending {uid}/... -> photos/{ID}/senior-id/...
    for (const p of await listAll(supabase, 'senior-ids', '')) {
        const m = /^(verified|pending)\/([^/]+)\/(.+)$/.exec(p);
        if (!m) continue;
        const folder = uidToFolder[m[2]] || m[2];
        const dest = `${folder}/senior-id/${m[3]}`;
        const { data, error } = await supabase.storage.from('senior-ids').download(p);
        if (error || !data) continue;
        const buf = Buffer.from(await data.arrayBuffer());
        const { error: upErr } = await supabase.storage.from('photos').upload(dest, buf, { upsert: true });
        if (!upErr) copied++;
    }
    // 3) medical-certifications pending|reviewed {key}/... -> photos/{ID}/medical/...
    for (const p of await listAll(supabase, 'medical-certifications', '')) {
        const m = /^(pending|reviewed)\/([^/]+)\/(.+)$/.exec(p);
        if (!m) continue;
        const folder = uidToFolder[m[2]] || m[2];
        const dest = `${folder}/medical/${m[3]}`;
        const { data, error } = await supabase.storage.from('medical-certifications').download(p);
        if (error || !data) continue;
        const buf = Buffer.from(await data.arrayBuffer());
        const { error: upErr } = await supabase.storage.from('photos').upload(dest, buf, { upsert: true });
        if (!upErr) copied++;
    }
    console.log(`photos migration done. copied: ${copied}`);
    console.log('Verify: Storage > photos > {ID-number} > face.jpg');
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
