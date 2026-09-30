// scripts/supabase-import-users.js — users -> seniors table + photos bucket.
const base = require('./supabase-import-all');
const PHOTOS_BUCKET = 'photos';
async function importUsers() {
    const { admin, supabase, DRY_RUN, stats, failures, toBuffer, skey, seniorFolder, putFile, upsert } = base;
    const strip = base.strip || require('./supabase-import-nodes').strip;
    const snap = await admin.database().ref('users').once('value');
    const users = snap.val() || {};
    console.log(`users: ${Object.keys(users).length} account(s)`);
    for (const [uid, u0] of Object.entries(users)) {
        try {
            const u = { ...(u0 || {}), uid };
            const folder = seniorFolder(u);
            let facePath = null, idFPath = null, idBPath = null, medPath = null, medName = null;
            const face = toBuffer(u.kycFaceImage || u.faceImage);
            if (face) { facePath = await putFile(PHOTOS_BUCKET, `${folder}/face/face.jpg`, face.buffer, face.mimeType); stats.images++; }
            const idF = toBuffer(u.kycIdFrontImage || (u.kycIdImages && u.kycIdImages.front));
            if (idF) { idFPath = await putFile(PHOTOS_BUCKET, `${folder}/senior-id/id-front.jpg`, idF.buffer, idF.mimeType); stats.images++; }
            const idB = toBuffer(u.kycIdBackImage || (u.kycIdImages && u.kycIdImages.back));
            if (idB) { idBPath = await putFile(PHOTOS_BUCKET, `${folder}/senior-id/id-back.jpg`, idB.buffer, idB.mimeType); stats.images++; }
            const med = toBuffer(u.medCertImage || u.medicalCertImage);
            if (med) {
                medName = String(u.medCertName || u.medicalCertName || 'medical-cert.jpg').slice(0, 80);
                medPath = await putFile(PHOTOS_BUCKET, `${folder}/medical/${skey(medName)}`, med.buffer, med.mimeType);
                stats.images++;
            }
            for (const [docId, d] of Object.entries(u.idDocuments || {})) {
                if (!d || !d.storagePath) continue;
                try {
                    const dl = await supabase.storage.from('senior-ids').download(d.storagePath);
                    if (!dl.error && dl.data) {
                        const buf = Buffer.from(await dl.data.arrayBuffer());
                        await putFile(PHOTOS_BUCKET, `${folder}/senior-id/${skey(docId)}_${skey(d.originalName || 'id.jpg')}`, buf, d.mimeType || 'image/jpeg');
                        stats.images++;
                    }
                } catch {}
            }
            for (const [repId, r] of Object.entries(u.healthReports || {})) {
                const fb = toBuffer(r && (r.fileBase64 || r.fileData));
                if (fb) {
                    await putFile(PHOTOS_BUCKET, `${folder}/medical/${skey(repId)}_${skey((r && r.fileName) || 'cert.jpg')}`, fb.buffer, fb.mimeType || 'image/jpeg');
                    stats.images++;
                }
            }
            const { kycFaceImage, faceImage, kycIdFrontImage, kycIdBackImage, kycIdImages, medCertImage, medicalCertImage, password, passwordHash, otp, otpCode, verificationCode, resetToken, ...rest } = u;
            const name = u.name || [u.firstName, u.middleName, u.lastName].filter(Boolean).join(' ') || null;
            await upsert('seniors', {
                uid, username: u.username || u.email || null, full_name: name || 'Unnamed Senior',
                senior_id: u.seniorId || null, id_number: u.idNumber || null, face_path: facePath,
                email: u.email || null, cp_number: u.cpNumber || null, address: u.address || null,
                barangay: u.barangay || null, city: u.city || null, province: u.province || null,
                dob: u.dob || u.birthDate || null, sex: u.sex || null, civil_status: u.civilStatus || null,
                kyc_status: u.kycStatus || 'Pending', life_status: u.lifeStatus || 'Active',
                registered_by: u.registeredBy || null,
                health_condition: (u.health && u.health.condition) || u.healthCondition || null,
                id_front_path: idFPath, id_back_path: idBPath, med_cert_path: medPath, med_cert_name: medName,
                synced_at: new Date().toISOString()
            }, 'uid');
            stats.tables.seniors = (stats.tables.seniors || 0) + 1;
            console.log(`  seniors <- ${name || uid} [${folder}] face:${facePath ? 'yes' : 'no'}`);
        } catch (err) { stats.failed++; failures.push(`${uid}: ${err.message}`); }
    }
}
module.exports.importUsers = importUsers;
