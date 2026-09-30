// PART 5/6: leftovers -> records fallback + runner.
async function migrateLeftovers(deps) {
    const { admin, upsert, stats, strip } = deps;
    const leftovers = ['pensionSettings', 'system', 'checkups', 'qrCodes', 'budget',
        'healthCenters', 'medicationRequests', 'reactivationRequests', 'idDocuments'];
    for (const node of leftovers) {
        try {
            const snap = await admin.database().ref(node).once('value');
            const obj = snap.val() || {};
            if (!Object.keys(obj).length) { console.log(`${node}: 0`); continue; }
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                for (const [k, v] of Object.entries(obj)) {
                    await upsert('records', { node, key: String(k), data: strip(v) }, 'node,key');
                    stats.fallback++;
                }
            } else {
                await upsert('records', { node, key: 'root', data: strip(obj) }, 'node,key');
                stats.fallback++;
            }
            console.log(`${node}: ${Object.keys(obj).length} -> records fallback`);
        } catch (e) { console.warn(`${node} skipped: ${e.message}`); }
    }
}
async function runMigration(deps) {
    const { admin, supabase, DRY_RUN, BUCKETS, ensureBucket, stats, failures } = deps;
    console.log(`-- SilverCare FULL migration ${DRY_RUN ? '(DRY RUN)' : ''} --`);
    for (const b of BUCKETS) await ensureBucket(b);
    const { migrateUserImages } = require('./migrate-users-images');
    const { migrateUserRows } = require('./migrate-users-rows');
    const { migrateCoreTables } = require('./migrate-core-tables');
    const { migrateCatalogTables } = require('./migrate-catalog-tables');
    const { migrateHealthComms } = require('./migrate-health-comms');
    const usersSnap = await admin.database().ref('users').once('value');
    const users = usersSnap.val() || {};
    console.log(`users: ${Object.keys(users).length} account(s)`);
    const imgMap = await migrateUserImages(deps, users);
    await migrateUserRows(deps, users, imgMap);
    await migrateCoreTables(deps);
    await migrateCatalogTables(deps);
    await migrateHealthComms(deps, users);
    await migrateLeftovers(deps);
    if (!DRY_RUN) {
        await supabase.from('migration_runs').insert({
            finished_at: new Date().toISOString(), dry_run: false, stats
        });
    }
    console.log('---- DONE ----');
    console.log(JSON.stringify(stats, null, 2));
    if (failures.length) { console.log('Failures:'); failures.slice(0, 50).forEach(f => console.log(` - ${f.uid}: ${f.reason}`)); }
}
module.exports.migrateLeftovers = migrateLeftovers;
module.exports.runMigration = runMigration;
