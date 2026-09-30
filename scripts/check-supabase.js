#!/usr/bin/env node
/**
 * scripts/check-supabase.js
 * ---------------------------------------------------------------
 * Verifies the SilverCare × Supabase connection:
 *   1. Credentials present in .env
 *   2. Project reachable with the service-role key
 *   3. "seniors" table exists (mirrored senior data)
 *   4. Private bucket "photos" ({ID-number}/face.jpg layout)
 *
 * Usage:  node scripts/check-supabase.js
 * ---------------------------------------------------------------
 */
require('dotenv').config();

async function main() {
    const url = (process.env.SUPABASE_URL || '').trim();
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

    console.log('── SilverCare × Supabase connection check ──');

    // 1) Credentials
    if (!url || /YOUR_SUPABASE/i.test(url) || !key || /YOUR_SUPABASE/i.test(key)) {
        console.error('✗  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in .env');
        console.error('   Supabase Dashboard > Project Settings > API:');
        console.error('     • copy the "Project URL"       -> SUPABASE_URL');
        console.error('     • copy the "service_role" key  -> SUPABASE_SERVICE_ROLE_KEY');
        process.exit(1);
    }
    console.log(`✓  Credentials found (${url})`);

    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(url, key, { auth: { persistSession: false } });

    // 2) Reachable?
    const { error: listError } = await supabase.storage.listBuckets();
    if (listError) {
        console.error('✗  Could not reach the project:', listError.message);
        console.error('   Check the project is active (not paused) and the keys are correct.');
        process.exit(1);
    }
    console.log('✓  Connection OK — service-role key accepted');

    // 3) seniors table — verified through the published REST schema.
    //    (A head/count query on a MISSING table returns an empty 404 that
    //    the client library reports as "no error", so we list the tables
    //    the API actually exposes instead.)
    const specRes = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    const spec = await specRes.json();
    if (!spec.definitions || !spec.definitions.seniors) {
        console.error('✗  Table "seniors" does not exist (or is not exposed to the API).');
        console.error('   Fix: Dashboard → SQL Editor → New query → paste scripts/supabase-setup.sql → RUN');
        process.exit(1);
    }
    const { count, error: countError } = await supabase
        .from('seniors')
        .select('uid', { count: 'exact' })
        .limit(1);
    if (countError) {
        console.error('✗  Table "seniors" exists but cannot be queried:', countError.message);
        console.error('   Check Dashboard → Project Settings → API → "Exposed schemas" includes "public".');
        process.exit(1);
    }
    console.log(`✓  Table "seniors" ready (${count || 0} senior record${(count || 0) === 1 ? '' : 's'} mirrored so far)`);

    // 4) Buckets — single image bucket "photos" (+ legacy read sources)
    const { data: buckets } = await supabase.storage.listBuckets();
    for (const name of ['photos', 'seniors', 'senior-ids', 'medical-certifications']) {
        const bucket = (buckets || []).find(b => b.name === name);
        if (!bucket) {
            console.warn(`⚠  Bucket "${name}" does not exist yet — it is created automatically on first use.`);
        } else if (bucket.public) {
            console.warn(`⚠  Bucket "${name}" is PUBLIC — set it to private in the Supabase dashboard!`);
        } else {
            console.log(`✓  Bucket "${name}" ready (private)`);
        }
    }

    console.log('── All good! Senior data will be mirrored to Supabase. ──');
}

main().catch(err => {
    console.error('✗  Unexpected error:', err.message);
    process.exit(1);
});
