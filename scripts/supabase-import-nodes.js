// scripts/supabase-import-nodes.js — every other text node -> records.
function strip(v) {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
        const o = {};
        for (const [k, val] of Object.entries(v)) {
            if (/^(password|passwordHash|otp|otpCode|verificationCode|resetToken|fileBase64|fileData|kycFaceImage|faceImage|kycIdFrontImage|kycIdBackImage|medCertImage|medicalCertImage|liveImage|referenceImage)$/i.test(k)) continue;
            o[k] = strip(val);
        }
        return o;
    }
    return (typeof v === 'string' && v.length > 20000) ? v.slice(0, 20000) : v;
}
async function dumpNode(deps, node) {
    const { admin, stats, failures, upsert } = deps;
    const snap = await admin.database().ref(node).once('value');
    const obj = snap.val() || {};
    const keys = Object.keys(obj);
    if (!keys.length) { console.log(`${node}: 0`); return; }
    console.log(`${node}: ${keys.length} -> records`);
    for (const k of keys) {
        try {
            await upsert('records', { node, key: String(k), data: strip(obj[k]) }, 'node,key');
            stats.tables.records = (stats.tables.records || 0) + 1;
        } catch (e) { stats.failed++; failures.push(`${node}/${k}: ${e.message}`); }
    }
}
async function runAll(deps) {
    const { supabase, DRY_RUN, stats, failures } = deps;
    if (!DRY_RUN) {
        for (const name of ['photos']) {
            const { error } = await supabase.storage.getBucket(name);
            if (error) await supabase.storage.createBucket(name, { public: false });
        }
    }
    const { importUsers } = require('./supabase-import-users');
    await importUsers();
    for (const node of ['claims', 'pensions', 'transactions', 'queue', 'appointmentRequests', 'appointments', 'checkups', 'doctors', 'healthCenters', 'barangays', 'benefits', 'attendance', 'notifications', 'auditLogs', 'qrCodes', 'budget', 'system', 'reactivationRequests', 'pensionSettings', 'medicationRequests', 'idDocuments']) {
        await dumpNode(deps, node);
    }
    console.log('---- DONE ----');
    console.log(JSON.stringify(stats, null, 2));
    if (failures.length) failures.slice(0, 30).forEach(f => console.log(' - ' + f));
}
module.exports.strip = strip;
module.exports.dumpNode = dumpNode;
module.exports.runAll = runAll;
if (require.main === module) {
    const deps = { ...require('./supabase-import-all'), strip };
    deps.strip = strip;
    runAll(deps).then(() => process.exit(0)).catch(e => { console.error('Import failed:', e.message); process.exit(1); });
}
