require('dotenv').config();
const path = require('path');
const admin = require('firebase-admin');
const fs = require('fs');

// Load service account - use path relative to project root
const rootDir = path.join(__dirname, '..');
let serviceAccount;
if (fs.existsSync(path.join(rootDir, 'serviceAccountKey.json'))) {
    serviceAccount = require(path.join(rootDir, 'serviceAccountKey.json'));
} else if (process.env.SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
} else {
    console.error('No service account credentials found.');
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
});

// ─────────────────────────────────────────────────────────────────────────────
// Reset ALL data for one senior account (default: justinofloki@gmail.com).
//
// Keeps:    the Firebase Auth account, role, profile/identity fields
//           (name, dob, address, contact, seniorId, ...) so the senior can
//           still log in and redo the flow.
//
// Resets:
//   users/{uid}:
//     - kycStatus -> 'Not Verified'
//     - removes KYC submission/verification artifacts
//       (kycFaceImage, kycIdFront/BackImage, kycSubmittedAt, kycVerifiedAt,
//        verifiedBy*, seniorCategory*, kycRejected*, verificationToken,
//        verificationSeniorId)
//     - clears activity data: benefits, health (logs), notifications,
//       medicationRequests
//     - clears pension setup: pensionLocalAmount, pensionNationalAmount,
//       pensionQuarterlyTotal, legacy pensionAmount/SetAt/SetBy,
//       lastPensionMonth, lastPensionStatus, priorityLevel
//   Global nodes (entries belonging to this senior are deleted):
//     - claims, queue, appointmentRequests, checkups/{uid}, transactions
//
// Kept: auditLogs (system history) and the account itself.
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_EMAIL = (process.argv[2] || 'justinofloki@gmail.com').toLowerCase();

async function resetSeniorAccount() {
    const db = admin.database();

    // 1) Locate the senior by email
    const usersSnap = await db.ref('users').once('value');
    let uid = null;
    let user = null;
    usersSnap.forEach(child => {
        const v = child.val();
        if (v && String(v.email || '').toLowerCase() === TARGET_EMAIL) {
            uid = child.key;
            user = v;
        }
    });

    if (!uid) {
        console.error(`❌ No user found with email ${TARGET_EMAIL}. Nothing to reset.`);
        return false;
    }

    console.log(`\n=== Resetting data for ${TARGET_EMAIL} (uid: ${uid}) ===`);
    console.log(`Current kycStatus: ${user.kycStatus || 'N/A'} | role: ${user.role} | seniorId: ${user.seniorId || 'N/A'}`);

    const updates = {};

    // 2) Reset KYC / verification state on the user record
    updates[`users/${uid}/kycStatus`] = 'Not Verified';
    [
        'kycFaceImage', 'kycIdFrontImage', 'kycIdBackImage', 'kycSubmittedAt',
        'kycVerifiedAt', 'verifiedBy', 'verifiedByEmail', 'verifiedByUid',
        'seniorCategory', 'seniorCategoryAssignedAt', 'kycRejectedAt',
        'kycRejectedReason', 'verificationToken', 'verificationSeniorId'
    ].forEach(k => { updates[`users/${uid}/${k}`] = null; });

    // 3) Clear activity data on the user record
    [
        'benefits', 'health', 'notifications', 'medicationRequests',
        'pensionLocalAmount', 'pensionNationalAmount', 'pensionQuarterlyTotal',
        'pensionAmount', 'pensionSetAt', 'pensionSetBy',
        'lastPensionMonth', 'lastPensionStatus', 'priorityLevel'
    ].forEach(k => { updates[`users/${uid}/${k}`] = null; });

    updates[`users/${uid}/status`] = 'Active';

    // 4) Wipe this senior's entries in global nodes
    const belongsToSenior = (v) => v && (
        v.uid === uid || v.seniorUid === uid ||
        String(v.email || '').toLowerCase() === TARGET_EMAIL
    );

    for (const node of ['claims', 'queue', 'appointmentRequests', 'transactions']) {
        const snap = await db.ref(node).once('value');
        if (!snap.exists()) continue;
        snap.forEach(child => {
            if (belongsToSenior(child.val())) {
                updates[`${node}/${child.key}`] = null;
                console.log(`  - ${node}/${child.key} removed`);
            }
        });
    }

    // checkups are keyed directly by uid
    const checkupSnap = await db.ref(`checkups/${uid}`).once('value');
    if (checkupSnap.exists()) {
        updates[`checkups/${uid}`] = null;
        console.log(`  - checkups/${uid} removed`);
    }

    await db.ref().update(updates);

    console.log(`\n✅ Account data for ${TARGET_EMAIL} has been fully reset.`);
    console.log('   Login, role and profile info were kept. KYC status is now "Not Verified".');
    return true;
}

resetSeniorAccount()
    .then(ok => process.exit(ok ? 0 : 1))
    .catch(err => {
        console.error('\n❌ Failed to reset senior account:', err.message);
        process.exit(1);
    });
