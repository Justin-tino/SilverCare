// PART 4/6: health + comms + reactivation (images -> Storage).
async function migrateHealthComms(deps, users) {
    const { admin, toBuffer, skey, seniorFolder, putFile, upsert, stats, failures, strip } = deps;
    const notifSnap = await admin.database().ref('notifications').once('value');
    const notifs = notifSnap.val() || {};
    console.log(`notifications: ${Object.keys(notifs).length}`);
    for (const [k, n] of Object.entries(notifs)) {
        try {
            await upsert('notifications', {
                id: String((n && n.id) || k), scope: 'global', uid: (n && n.uid) || null,
                title: (n && (n.title || n.name)) || null, body: (n && (n.body || n.message || n.description)) || null,
                read: !!(n && n.read), created_at_ms: (n && (n.createdAt || n.timestamp)) || null
            }, 'id');
            stats.rows.notifications = (stats.rows.notifications || 0) + 1;
        } catch (e) { stats.failed++; failures.push({ uid: `notifications/${k}`, reason: e.message }); }
    }
    for (const [uid, u0] of Object.entries(users)) {
        const u = u0 || {};
        for (const [k, n] of Object.entries(u.notifications || {})) {
            try {
                await upsert('notifications', {
                    id: `${uid}_${k}`, scope: 'user', uid, title: n.title || null,
                    body: n.body || n.message || n.description || null,
                    read: !!n.read, created_at_ms: n.createdAt || n.timestamp || null
                }, 'id');
                stats.rows.notifications = (stats.rows.notifications || 0) + 1;
            } catch (e) { stats.failed++; }
        }
        for (const [k, r] of Object.entries(u.healthRecords || {})) {
            try {
                await upsert('health_records', {
                    id: `${uid}_${k}`, uid, title: r.title || null, record_type: r.type || null,
                    description: r.description || null, recorded_at_ms: r.createdAt || r.recordedAt || null,
                    data: strip(r)
                }, 'id');
                stats.rows.health_records = (stats.rows.health_records || 0) + 1;
            } catch (e) { stats.failed++; }
        }
        for (const [k, r] of Object.entries(u.healthReports || {})) {
            try {
                const fb = toBuffer(r.fileBase64 || r.fileData);
                let fpath = r.storagePath || r.filePath || null;
                if (fb) {
                    const folder = seniorFolder({ ...u, uid });
                    fpath = await putFile('seniors', `${folder}/medical/${skey(k)}_${skey(r.fileName || 'cert.jpg')}`, fb.buffer, fb.mimeType || 'image/jpeg');
                    stats.images++;
                }
                await upsert('health_reports', {
                    id: `${uid}_${k}`, uid, title: r.title || null, report_type: r.type || r.reportType || null,
                    status: r.status || null, file_path: fpath, file_name: r.fileName || null,
                    mime_type: r.mimeType || null, created_at_ms: r.createdAt || r.uploadedAt || null,
                    data: strip(r)
                }, 'id');
                stats.rows.health_reports = (stats.rows.health_reports || 0) + 1;
            } catch (e) { stats.failed++; }
        }
    }
}
module.exports.migrateHealthComms = migrateHealthComms;
