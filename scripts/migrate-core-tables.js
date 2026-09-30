// PART 3a/6: claims/pensions/queue/appointments -> tables.
async function migrateCoreTables(deps) {
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
    await tableNode('claims', 'claims', async (k, c) => ({
        id: String(c.id || k), uid: c.uid || null, beneficiary_name: c.beneficiaryName || null,
        benefit_id: c.benefitId || null, benefit_name: c.benefitName || null,
        service_month: c.serviceMonth || null, claim_year: c.claimYear || null,
        amount: Number(c.amount || 0), notes: c.notes || null, status: c.status || 'Processing',
        submitted_by: c.submittedBy || null, submitted_by_name: c.submittedByName || null,
        submitted_at: c.submittedAt || null, processed_by: c.processedBy || null,
        processed_by_name: c.processedByName || null, processed_at: c.processedAt || null,
        approval_notes: c.approvalNotes || null, rejection_reason: c.rejectionReason || null,
        documents: strip(c.documents || {})
    }), 'id');
    await tableNode('pensions', 'pensions', async (k, p) => ({
        id: String(p.id || k), uid: p.uid || null, senior_name: p.seniorName || p.name || null,
        senior_id: p.seniorId || null, amount: Number(p.amount || 0), month: p.month || null,
        year: p.year || null, status: p.status || 'Pending', distribution_date: p.distributionDate || null,
        distributed_at: p.distributedAt || null, distributed_by: p.distributedBy || null,
        distributed_by_name: p.distributedByName || null, notes: p.notes || null
    }), 'id');
    await tableNode('queue', 'queue', async (k, q) => ({
        id: String(q.id || k), uid: q.uid || null, name: q.name || null, senior_id: q.seniorId || null,
        service: q.service || null, date: q.date || null, time: q.time || null,
        queue_number: q.queueNumber || null, status: q.status || 'Pending', priority: q.priority || null,
        notes: q.notes || q.note || null, created_by: q.createdBy || q.bookedBy || null,
        created_at_ms: q.createdAt || q.bookedAt || null, data: strip(q)
    }), 'id');
    await tableNode('appointmentRequests', 'appointment_requests', async (k, a) => ({
        id: String(a.id || k), uid: a.uid || null, name: a.name || null, service: a.service || null,
        date: a.date || null, time: a.time || null, status: a.status || 'Pending',
        notes: a.notes || null, created_at_ms: a.createdAt || a.requestedAt || null, data: strip(a)
    }), 'id');
    await tableNode('appointments', 'appointments', async (k, a) => ({
        id: String(a.id || k), uid: a.uid || null, name: a.name || null, service: a.service || null,
        date: a.date || null, time: a.time || null, status: a.status || 'Pending',
        notes: a.notes || null, created_at_ms: a.createdAt || null, data: strip(a)
    }), 'id');
}
module.exports.migrateCoreTables = migrateCoreTables;
