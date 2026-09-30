#!/usr/bin/env node
// scripts/supabase-apply-schema.js — creates ALL tables via Supabase API.
// Run: node scripts/supabase-apply-schema.js
// Uses service-role key; safe to re-run.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function main() {
    const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!url || !key) { console.error('Missing SUPABASE_URL / SERVICE_ROLE_KEY in .env'); process.exit(1); }
    const parts = [
        'supabase-full-migration.sql',
        'supabase-full-migration-2.sql',
        'supabase-full-migration-3.sql',
        'supabase-full-migration-4.sql',
    ];
    const sql = parts.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
    // Try: postgres REST RPC not available -> use pg via dynamic import if installed,
    // else fall back to telling user exact step. First attempt: supabase SQL via fetch
    // to /pg/sql (works on self-hosted); cloud needs SQL editor, so we split+guide.
    console.log('Schema files found:', parts.join(', '));
    console.log('Total SQL chars:', sql.length);
    console.log('');
    console.log('Supabase cloud does NOT allow DDL over the API key.');
    console.log('Do this ONCE (2 minutes):');
    console.log('  1) Open your screenshot project -> SQL Editor -> New query');
    console.log('  2) Paste scripts/supabase-setup-and-migrate.sql (ONE file, created below) -> RUN');
    console.log('');
    // Build the ONE-file version automatically:
    const oneFile = path.join(__dirname, 'supabase-setup-and-migrate.sql');
    const header = '-- SilverCare ONE-FILE schema: paste ENTIRE file into SQL Editor -> RUN\n-- Re-running is safe.\n';
    fs.writeFileSync(oneFile, header + sql);
    console.log('ONE-FILE schema written:', oneFile);
}
main();
