// PART 2b/6: users pass 2 — lean text rows (no blobs/secrets).
async function migrateUserRows(deps, users, imgMap) {
    const { putFile, upsert, stats, failures } = deps;
    for (const [uid, u0] of Object.entries(users)) {
        try {
            const u = { ...(u0 || {}), uid };
            const img = imgMap[uid] || {};
            const { kycFaceImage, faceImage, kycIdFrontImage, kycIdBackImage,
                kycIdImages, medCertImage, medicalCertImage, password,
                passwordHash, otp, otpCode, verificationCode,
                resetToken, ...rest } = u;
            const profile = {
                uid, role: String(u.role || 'senior'),
                email: u.email || null, username: u.username || u.email || null,
                name: u.name || [u.firstName, u.middleName, u.lastName].filter(Boolean).join(' ') || null,
                first_name: u.firstName || null, middle_name: u.middleName || null,
                last_name: u.lastName || null, extension: u.extension || null,
                senior_id: u.seniorId || null, osca_id: u.oscaId || null,
                id_number: u.idNumber || null, cp_number: u.cpNumber || null,
                address: u.address || null, barangay: u.barangay || null,
                barangay_id: u.barangayId || null, city: u.city || null,
                province: u.province || null, postal_code: u.postalCode || null,
                citizenship: u.citizenship || null, dob: u.dob || u.birthDate || null,
                sex: u.sex || null, civil_status: u.civilStatus || null,
                kyc_status: u.kycStatus || 'Pending', life_status: u.lifeStatus || 'Active',
                status: u.status || 'Pending', senior_category: u.seniorCategory || null,
                priority_level: u.priorityLevel || null,
                pension_amount: u.pensionAmount == null ? null : Number(u.pensionAmount),
                pension_suspended: !!u.pensionSuspended,
                last_pension_month: u.lastPensionMonth || null,
                last_pension_status: u.lastPensionStatus || null,
                registered_by: u.registeredBy || null, face_path: img.facePath || null,
                id_front_path: img.idFrontPath || null, id_back_path: img.idBackPath || null,
                med_cert_path: img.medPath || null, med_cert_name: img.medName || null,
                health_condition: (u.health && u.health.condition) || u.healthCondition || null,
                verification_token: u.verificationToken || null, duplicate_of: u.duplicateOf || null,
                profile_data: rest, synced_at: new Date().toISOString()
            };
            await upsert('profiles', profile, 'uid');
            stats.profiles++;
            if (profile.role === 'senior') {
                await upsert('seniors', {
                    uid, username: profile.username,
                    full_name: profile.name || 'Unnamed Senior',
                    senior_id: profile.senior_id, id_number: profile.id_number,
                    face_path: img.facePath || null, email: profile.email,
                    cp_number: profile.cp_number, address: profile.address,
                    barangay: profile.barangay, city: profile.city,
                    province: profile.province, dob: profile.dob, sex: profile.sex,
                    civil_status: profile.civil_status, kyc_status: profile.kyc_status,
                    life_status: profile.life_status, registered_by: profile.registered_by,
                    health_condition: profile.health_condition,
                    id_front_path: img.idFrontPath || null, id_back_path: img.idBackPath || null,
                    med_cert_path: img.medPath || null, med_cert_name: img.medName || null,
                    synced_at: new Date().toISOString()
                }, 'uid');
                stats.seniorsMirror++;
            }
            stats.textFiles += 0;
        } catch (err) { stats.failed++; failures.push({ uid, reason: err.message }); }
    }
}
module.exports.migrateUserRows = migrateUserRows;
