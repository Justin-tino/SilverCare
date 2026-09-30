// PART 3b/6: catalog + logs tables.
async function migrateCatalogTables(deps) {
    const { admin, upsert, stats, failures, strip } = deps;
    async function tableNode(node, table, mapFn, idField) {
        const snap = await admin.database().ref(node).once('value');
        const obj = snap.val() || {};
        console.log(`${node}: ${Object.keys(obj).length} -> ${table}`);
        for (const k of Object.keys(obj)) {
            try {
                const row = await mapFn(k, obj[k] || {});
                if (row) { await upsert(table, row, idField); stats.rows[table] = (stats.rows[table] || 0) + 1; }
            } catch (e) { stats.failed++; failures.push({ uid: `${node}/${k}`, reason: e.message }); }
        }
    }
    await tableNode('transactions', 'transactions', async (k, t) => ({
        id: String(t.id || k), uid: t.uid || null, senior_name: t.seniorName || t.name || null,
        type: t.type || null, amount: Number(t.amount || 0), benefit_id: t.benefitId || null,
        claim_id: t.claimId || null, status: t.status || null, created_by: t.createdBy || null,
        created_at_ms: t.createdAt || t.timestamp || null, data: strip(t)
    }), 'id');
    await tableNode('attendance', 'attendance', async (k, a) => ({
        id: String(a.id || k), queue_id: a.queueId || null, uid: a.uid || null, name: a.name || null,
        date: a.date || null, time: a.time || null, service: a.service || null, status: a.status || null,
        attended_at: a.attendedAt || null, note: a.note || null, recorded_by: a.recordedBy || null,
        recorded_by_name: a.recordedByName || null, recorded_at: a.recordedAt || null
    }), 'id');
    await tableNode('benefits', 'benefits', async (k, b) => ({
        id: String(b.id || k), name: b.name || null, description: b.description || null,
        amount: Number(b.amount || 0), frequency: b.frequency || null,
        active: b.active !== false, data: strip(b)
    }), 'id');
    await tableNode('doctors', 'doctors', async (k, d) => ({
        id: String(d.id || k), name: d.name || null, specialty: d.specialty || null,
        schedule: d.schedule || null, contact: d.contact || null,
        active: d.active !== false, data: strip(d)
    }), 'id');
    await tableNode('barangays', 'barangays', async (k, b) => ({
        id: String(b.id || k), name: b.name || null, region: b.region || null,
        district: b.district || null, data: strip(b)
    }), 'id');
    await tableNode('auditLogs', 'audit_logs', async (k, l) => ({
        id: String(l.id || k), action: l.action || null, actor_uid: l.actorUid || l.actor || null,
        actor_name: l.actorName || null, actor_role: l.actorRole || null, target_uid: l.targetUid || null,
        doc_id: l.docId || null, pension: l.pension == null ? null : Number(l.pension),
        detail: String(l.detail || l.message || '').slice(0, 2000),
        timestamp_ms: l.timestamp || l.timestampMs || l.createdAt || null
    }), 'id');
}
module.exports.migrateCatalogTables = migrateCatalogTables;
