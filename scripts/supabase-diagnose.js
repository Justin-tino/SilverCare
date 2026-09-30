#!/usr/bin/env node
// scripts/supabase-diagnose.js — checks Supabase tables + storage contents.
// Run: node scripts/supabase-diagnose.js
require('dotenv').config();

async function main() {
    const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!url || !key) { console.error('Missing SUPABASE_URL / SERVICE_ROLE_KEY in .env'); process.exit(1); }
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(url, key, { auth: { persistSession: false } });

    console.log('── Supabase diagnosis ──');
    console.log('Project:', url);

    // Buckets + file counts (recursive, depth-limited)
    const { data: buckets, error: bErr } = await sb.storage.listBuckets();
    if (bErr) { console.error('listBuckets failed:', bErr.message); }
    else {
        console.log(`Buckets: ${(buckets || []).map(b => `${b.name}${b.public ? ' (PUBLIC!)' : ' (private)'}`).join(', ') || '(none)'}`);
        for (const b of (buckets || [])) {
            const files = await listAll(sb, b.name, '', 0);
            console.log(`  ${b.name}: ${files.length} file(s)${files.length ? '' : ' — EMPTY'}`);
            files.slice(0, 15).forEach(f => console.log(`    - ${f}`));
            if (files.length > 15) console.log(`    ... +${files.length - 15} more`);
        }
    }

    // Tables of interest (head query; missing table => error message)
    // Note: "photos" is a Storage bucket (checked above), not a table.
    for (const t of ['seniors', 'profiles', 'records']) {
        const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
        if (error) console.log(`  table ${t}: MISSING (${error.message})`);
        else console.log(`  table ${t}: ${count || 0} row(s)`);
    }
}

async function listAll(sb, bucket, prefix, depth) {
    const out = [];
    if (depth > 5) return out;
    const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 100 });
    if (error || !data) return out;
    for (const item of data) {
        const p = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id === null || item.id === undefined) {
            // Heuristic: storage list marks folders with null id
            const sub = await listAll(sb, bucket, p, depth + 1);
            if (sub.length) out.push(...sub);
            else {
                // could be empty folder OR 0-byte file; probe deeper failed => treat as folder
            }
        } else out.push(p);
    }
    return out;
}

main().catch(e => { console.error('diagnose failed:', e.message); process.exit(1); });
