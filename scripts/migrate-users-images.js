// PART 2a/6: users pass 1 — images OUT of DB into photos bucket.
const PHOTOS_BUCKET = 'photos';
async function migrateUserImages(deps, users) {
    const { supabase, toBuffer, skey, seniorFolder, putFile, stats } = deps;
    const out = {};
    for (const [uid, u0] of Object.entries(users)) {
        const u = { ...(u0 || {}), uid };
        const folder = seniorFolder(u);
        const rec = { folder, facePath: null, idFrontPath: null, idBackPath: null, medPath: null, medName: null };
        const face = toBuffer(u.kycFaceImage || u.faceImage);
        if (face) { rec.facePath = await putFile(PHOTOS_BUCKET, `${folder}/face/face.jpg`, face.buffer, face.mimeType); stats.images++; }
        const idF = toBuffer(u.kycIdFrontImage || (u.kycIdImages && u.kycIdImages.front));
        if (idF) { rec.idFrontPath = await putFile(PHOTOS_BUCKET, `${folder}/senior-id/id-front.jpg`, idF.buffer, idF.mimeType); stats.images++; }
        const idB = toBuffer(u.kycIdBackImage || (u.kycIdImages && u.kycIdImages.back));
        if (idB) { rec.idBackPath = await putFile(PHOTOS_BUCKET, `${folder}/senior-id/id-back.jpg`, idB.buffer, idB.mimeType); stats.images++; }
        const med = toBuffer(u.medCertImage || u.medicalCertImage);
        if (med) {
            rec.medName = String(u.medCertName || u.medicalCertName || 'medical-cert.jpg').slice(0, 80);
            rec.medPath = await putFile(PHOTOS_BUCKET, `${folder}/medical/${skey(rec.medName)}`, med.buffer, med.mimeType); stats.images++;
        }
        for (const [docId, d] of Object.entries(u.idDocuments || {})) {
            if (!d || d.status !== 'Verified' || !d.storagePath) continue;
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
        out[uid] = rec;
    }
    return out;
}
module.exports.migrateUserImages = migrateUserImages;
