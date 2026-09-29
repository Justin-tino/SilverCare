require('dotenv').config();
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

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

const DEFAULT_EMPLOYEE = Object.freeze({
    email: 'employee@silvercare.com',
    password: 'employee123',
    role: 'employee',
    name: 'OSCA Employee',
    status: 'Active',
    emailVerified: true
});

async function provisionDefaultEmployee() {
    const db = admin.database();
    const auth = admin.auth();
    const email = DEFAULT_EMPLOYEE.email.toLowerCase();

    try {
        let userRecord;
        try {
            userRecord = await auth.getUserByEmail(email);
        } catch (error) {
            if (error.code !== 'auth/user-not-found') throw error;
        }

        if (userRecord) {
            userRecord = await auth.updateUser(userRecord.uid, {
                email: DEFAULT_EMPLOYEE.email,
                password: DEFAULT_EMPLOYEE.password,
                emailVerified: true,
                displayName: DEFAULT_EMPLOYEE.name
            });
            console.log(`Updated existing Firebase Auth user: ${email}`);
        } else {
            userRecord = await auth.createUser({
                email: DEFAULT_EMPLOYEE.email,
                password: DEFAULT_EMPLOYEE.password,
                emailVerified: true,
                displayName: DEFAULT_EMPLOYEE.name
            });
            console.log(`Created Firebase Auth user: ${email}`);
        }

        const userRef = db.ref(`users/${userRecord.uid}`);
        const existing = (await userRef.once('value')).val() || {};
        await userRef.set({
            uid: userRecord.uid,
            email: DEFAULT_EMPLOYEE.email,
            name: DEFAULT_EMPLOYEE.name,
            role: DEFAULT_EMPLOYEE.role,
            status: DEFAULT_EMPLOYEE.status,
            emailVerified: true,
            createdAt: existing.createdAt || Date.now(),
            updatedAt: Date.now()
        });

        console.log(`Default employee profile ready (uid: ${userRecord.uid}).`);
        console.log('OTP is disabled for this explicitly provisioned employee account.');
        return userRecord.uid;
    } catch (error) {
        console.error('Failed to provision default employee:', error.message || error);
        throw error;
    }
}

provisionDefaultEmployee()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
