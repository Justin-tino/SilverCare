/**
 * lib/supabaseDatabase.js
 * ---------------------------------------------------------------
 * Senior Data Mirror (Supabase Postgres table + Storage bucket).
 *
 * Firebase Realtime Database remains the single source of truth for
 * ALL records. This module MIRRORS every senior citizen's core
 * identity data into the connected Supabase project so it also lives
 * in a real relational database:
 *
 *     table  public.seniors  — one searchable row per senior:
 *         uid, username, full_name, senior_id, id_number, face_path...
 *
 *     bucket "seniors"  — one organized folder per senior, keyed by
 *     SENIOR CITIZEN ID (falls back to uid when no ID is assigned yet):
 *
 *         {seniorId}/
 *             name/name.txt                  -> senior complete name
 *             information/information.json   -> all senior information
 *             face/face.jpg                  -> face capture image
 *             senior-id/{docId}_{file}       -> verified ID document
 *
 * Every write is performed here on the trusted backend with the
 * service-role key — the key NEVER reaches the browser. The table
 * must exist first: run scripts/supabase-setup.sql once in the
 * Supabase SQL editor (Dashboard -> SQL Editor).
 * ---------------------------------------------------------------
 */

const { createClient } = require('@supabase/supabase-js');

const PHOTOS_BUCKET = 'photos';
const SENIORS_TABLE = 'seniors';
const ID_VAULT_BUCKET = 'senior-ids';  // legacy read source only (new uploads go to photos)
const MAX_FACE_BYTES = 5 * 1024 * 1024; // 5 MB — face captures are small JPEGs

let supabase = null;
let seniorsBucketReady = false;

const rawUrl = (process.env.SUPABASE_URL || '').trim();
const rawKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const urlLooksValid = /^https?:\/\/.+/i.test(rawUrl) && !/YOUR_SUPABASE/i.test(rawUrl);

if (urlLooksValid && rawKey && !/YOUR_SUPABASE/i.test(rawKey)) {
    try {
        supabase = createClient(rawUrl, rawKey, { auth: { persistSession: false } });
    } catch (err) {
        console.warn('Supabase client could not be created:', err.message);
        supabase = null;
    }
}

if (!supabase) {
    console.warn('Supabase credentials missing or placeholders not filled (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env). Senior data mirror is DISABLED.');
}

function isSyncEnabled() {
    return supabase !== null;
}

/** Creates the private "photos" bucket on first use (no-op if it exists). */
async function ensureSeniorsBucket() {
    if (!supabase || seniorsBucketReady) return seniorsBucketReady;
    try {
        const { data, error } = await supabase.storage.getBucket(PHOTOS_BUCKET);
        if (error) {
            const { error: createError } = await supabase.storage.createBucket(PHOTOS_BUCKET, { public: false });
            if (createError) throw createError;
            console.log(`Supabase storage bucket "${PHOTOS_BUCKET}" created (private).`);
        } else if (data && data.public === true) {
            console.warn(`Supabase bucket "${PHOTOS_BUCKET}" is PUBLIC — set it to private in the Supabase dashboard!`);
        }
        seniorsBucketReady = true;
    } catch (err) {
        console.error('Supabase "photos" bucket initialization failed:', err.message);
    }
    return seniorsBucketReady;
}

/**
 * Accepts a data URL ("data:image/jpeg;base64,...") or raw base64 and
 * returns { buffer, mimeType } or null when the payload is unusable.
 */
function parseFaceImage(faceImage) {
    if (!faceImage || typeof faceImage !== 'string') return null;
    let mimeType = 'image/jpeg';
    let base64 = faceImage;
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(faceImage);
    if (match) {
        mimeType = match[1];
        base64 = match[2];
    }
    let buffer;
    try {
        buffer = Buffer.from(base64, 'base64');
    } catch (err) {
        return null;
    }
    if (!buffer || buffer.length === 0 || buffer.length > MAX_FACE_BYTES) return null;
    return { buffer, mimeType };
}

/** Strips characters that are unsafe inside a Storage folder/file name. */
function sanitizeFolderKey(key) {
    return String(key || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

/**
 * Storage folder for ONE senior: keyed by the SENIOR CITIZEN ID so the
 * bucket reads like a filing cabinet ({seniorId}/face, /name, /info...).
 * Placeholder IDs (e.g. "OSCA-PENDING") fall back to the Firebase uid.
 */
function resolveFolderKey(uid, user) {
    const sid = String((user && user.seniorId) || '').trim();
    const usable = sid && !/^(OSCA[-_ ]?PENDING|N\/?A|PENDING|NONE)$/i.test(sid);
    return usable ? sanitizeFolderKey(sid) : String(uid);
}

function displayNameOf(user) {
    return String(user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unnamed Senior');
}

/** Whole senior record as JSON, with bulky base64 blobs stripped out. */
function buildInformation(user) {
    const clone = { ...(user || {}) };
    delete clone.kycFaceImage;
    delete clone.faceImage;
    delete clone.kycIdFrontImage;
    delete clone.kycIdBackImage;
    delete clone.kycIdImages;
    delete clone.kycMedCertImage;
    delete clone.medCertImage;
    delete clone.password;
    delete clone.plainPassword;
    return JSON.stringify(clone, null, 2);
}

/** Parses image OR pdf data URLs for the medical-certification upload. */
function splitDataUrl(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    const m = /^data:([a-zA-Z0-9.+\/-]+);base64,([\s\S]*)$/.exec(dataUrl);
    let mimeType = 'application/octet-stream';
    let base64 = dataUrl;
    if (m) { mimeType = m[1]; base64 = m[2]; }
    let buffer = null;
    try { buffer = Buffer.from(base64, 'base64'); } catch (e) { return null; }
    if (!buffer || !buffer.length || buffer.length > 7 * 1024 * 1024) return null;
    return { buffer, mimeType };
}

function faceStoragePath(folderKey, mimeType) {
    const ext = mimeType === 'image/png' ? 'png' : (mimeType === 'image/webp' ? 'webp' : 'jpg');
    return `${folderKey}/face/face.${ext}`;
}

/** Uploads (and overwrites) a small text/JSON file inside the bucket. */
async function uploadTextFile(path, content, mimeType) {
    const { error } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(path, Buffer.from(content, 'utf8'), { contentType: mimeType, upsert: true });
    if (error) throw new Error(error.message);
    return path;
}

/** Uploads (and overwrites) the senior's face capture: {seniorId}/face/face.jpg */
async function uploadFaceImage(folderKey, faceImage) {
    const parsed = parseFaceImage(faceImage);
    if (!parsed) return null;
    if (!(await ensureSeniorsBucket())) throw new Error('Supabase "photos" bucket unavailable.');
    const path = faceStoragePath(folderKey, parsed.mimeType);
    const { error } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(path, parsed.buffer, { contentType: parsed.mimeType, upsert: true });
    if (error) throw new Error(error.message);
    return path;
}

function idFrontStoragePath(folderKey, mimeType) {
    const ext = mimeType === 'image/png' ? 'png' : (mimeType === 'image/webp' ? 'webp' : 'jpg');
    return `${folderKey}/id/front.${ext}`;
}

function idBackStoragePath(folderKey, mimeType) {
    const ext = mimeType === 'image/png' ? 'png' : (mimeType === 'image/webp' ? 'webp' : 'jpg');
    return `${folderKey}/id/back.${ext}`;
}

/** Uploads Senior ID front or back: {seniorId}/id/front.jpg or back.jpg (private) */
async function uploadIdImage(folderKey, imageData, side) {
    const parsed = parseFaceImage(imageData);
    if (!parsed) return null;
    if (!(await ensureSeniorsBucket())) throw new Error('Supabase "photos" bucket unavailable.');
    const path = side === 'back' ? idBackStoragePath(folderKey, parsed.mimeType) : idFrontStoragePath(folderKey, parsed.mimeType);
    const { error } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(path, parsed.buffer, { contentType: parsed.mimeType, upsert: true });
    if (error) throw new Error(error.message);
    return path;
}

/**
 * Maps a Firebase users/{uid} record to a row of public.seniors.
 *   username  = login email (or a readable fallback when the record
 *               was created without one, e.g. "juan.dela.cruz.123456")
 *   senior_id = OSCA senior citizen ID
 *   id_number = verification/government ID number (falls back to senior_id)
 */
function buildSeniorRow(uid, user, facePath) {
    user = user || {};
    const email = String(user.email || '').trim();
    const fallbackUsername = String(user.name || 'senior')
        .toLowerCase().replace(/[^a-z0-9]+/g, '.') + '.' + String(uid).slice(-6);
    const fullName = String(user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unnamed Senior');

    const row = {
        uid: String(uid),
        username: (email && email !== 'N/A' ? email : fallbackUsername),
        full_name: fullName,
        senior_id: String(user.seniorId || '') || null,
        id_number: String(user.verificationSeniorId || user.idNumber || user.seniorId || '') || null,
        face_path: facePath || null,
        email: (email && email !== 'N/A' ? email : null),
        cp_number: String(user.cpNumber || '') || null,
        address: String(user.address || '') || null,
        barangay: String(user.barangay || '') || null,
        city: String(user.city || '') || null,
        province: String(user.province || '') || null,
        dob: String(user.dob || '') || null,
        sex: String(user.sex || '') || null,
        civil_status: String(user.civilStatus || '') || null,
        kyc_status: String(user.kycStatus || 'Pending'),
        life_status: String(user.lifeStatus || 'Active'),
        registered_by: String(user.registeredBy || user.verifiedBy || '') || null,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        health_condition: String(user.healthCondition || user.condition || user.illness || 'No Illness / Healthy').slice(0, 255),
        id_front_path: String(user.idFrontPath || '') || null,
        id_back_path: String(user.idBackPath || '') || null,
        med_cert_path: String(user.medCertPath || user.kycMedCertPath || '') || null,
        med_cert_name: String(user.kycMedCertName || user.medCertName || '') || null
    };
    // Columns above that may not exist yet when scripts/supabase-setup.sql was
    // run before the new migration (see ensureSeniorsColumns()). Strip them
    // when the table is still on the old schema so old projects keep working.
    const optionalCols = ['health_condition', 'id_front_path', 'id_back_path', 'med_cert_path', 'med_cert_name', 'updated_at'];
    for (const col of optionalCols) {
        if (seniorsKnownColumns && !seniorsKnownColumns.has(col)) delete row[col];
    }
    return row;
}

/** Cached set of real columns on public.seniors (null = unknown yet). */
let seniorsKnownColumns = null;

/** Detects the real columns once, so new fields never break old tables. */
async function ensureSeniorsColumns() {
    if (seniorsKnownColumns) return seniorsKnownColumns;
    const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    try {
        const res = await fetch(`${url}/rest/v1/seniors?select=*&limit=1`, {
            headers: { apikey: key, Authorization: 'Bearer ' + key }
        });
        if (res.ok) {
            const rows = await res.json().catch(() => []);
            const first = Array.isArray(rows) ? rows[0] : null;
            if (first && typeof first === 'object') {
                seniorsKnownColumns = new Set(Object.keys(first));
                return seniorsKnownColumns;
            }
        }
        // Empty table: ask PostgREST for the shape via a limit-0 probe.
        const probe = await fetch(`${url}/rest/v1/seniors?select=health_condition,id_front_path,id_back_path,med_cert_path,med_cert_name,updated_at&limit=0`, {
            headers: { apikey: key, Authorization: 'Bearer ' + key }
        });
        if (probe.ok) {
            seniorsKnownColumns = new Set(['uid', 'username', 'full_name', 'senior_id', 'id_number', 'face_path', 'email', 'cp_number', 'address', 'barangay', 'city', 'province', 'dob', 'sex', 'civil_status', 'kyc_status', 'life_status', 'registered_by', 'created_at', 'synced_at', 'health_condition', 'id_front_path', 'id_back_path', 'med_cert_path', 'med_cert_name', 'updated_at']);
        }
    } catch (e) { /* fall through to retry-on-missing-column below */ }
    return seniorsKnownColumns;
}

/** Upserts with graceful fallback when the table misses the new columns. */
async function upsertSeniorRow(uid, user, facePath) {
    await ensureSeniorsColumns();
    let payload = buildSeniorRow(uid, user, facePath);
    let res = await supabase.from(SENIORS_TABLE).upsert(payload, { onConflict: 'uid' });
    if (res.error && /column .* does not exist|Could not find the .* column|schema cache/i.test(res.error.message || '')) {
        const missing = String((res.error.message.match(/["']([a-z_]+)["']/) || [])[1] || '');
        if (seniorsKnownColumns && missing) seniorsKnownColumns.delete(missing);
        else seniorsKnownColumns = new Set(Object.keys(payload).filter(k => k !== missing));
        payload = buildSeniorRow(uid, user, facePath);
        res = await supabase.from(SENIORS_TABLE).upsert(payload, { onConflict: 'uid' });
        if (res.error && /column .* does not exist|Could not find the .* column|schema cache/i.test(res.error.message || '')) {
            // Last resort: core legacy columns only (pre-migration tables).
            const legacy = {};
            for (const k of ['uid', 'username', 'full_name', 'senior_id', 'id_number', 'face_path', 'email', 'cp_number', 'address', 'barangay', 'city', 'province', 'dob', 'sex', 'civil_status', 'kyc_status', 'life_status', 'registered_by', 'synced_at']) {
                if (payload[k] !== undefined) legacy[k] = payload[k];
            }
            res = await supabase.from(SENIORS_TABLE).upsert(legacy, { onConflict: 'uid' });
            if (!res.error) {
                res.migratedHint = 'Table "seniors" is missing the new columns — run scripts/supabase-setup.sql (or scripts/migrate-seniors-columns.sql) in the Supabase SQL editor to store health/ID/med-cert paths in the row. Files are still safe in the "seniors" bucket.';
            }
        }
    }
    return res;
}

/** Copies each VERIFIED ID document from the vault into {seniorId}/senior-id/. */
async function copyVerifiedIdDocuments(folderKey, idDocuments) {
    const docs = Object.values(idDocuments || {}).filter(d => d && d.status === 'Verified' && d.storagePath);
    let copied = 0;
    for (const doc of docs) {
        try {
            const { data, error } = await supabase.storage.from(ID_VAULT_BUCKET).download(doc.storagePath);
            if (error || !data) continue;
            const buffer = Buffer.from(await data.arrayBuffer());
            const fileName = `${doc.docId || 'id'}_${sanitizeFolderKey(doc.originalName || 'senior-id.jpg')}`;
            const { error: upError } = await supabase.storage
                .from(PHOTOS_BUCKET)
                .upload(`${folderKey}/senior-id/${fileName}`, buffer, { contentType: doc.mimeType || 'image/jpeg', upsert: true });
            if (!upError) copied++;
        } catch (err) {
            console.warn(`Supabase ID copy skipped (${folderKey}):`, err.message);
        }
    }
    return copied;
}

/** Recursively deletes every object under a folder prefix. */
async function removeFolderRecursive(prefix) {
    const { data } = await supabase.storage.from(PHOTOS_BUCKET).list(prefix, { limit: 1000 });
    const files = [];
    for (const entry of data || []) {
        const path = `${prefix}/${entry.name}`;
        if (entry.id === null) {
            await removeFolderRecursive(path); // pseudo-folder → walk deeper
        } else {
            files.push(path);
        }
    }
    if (files.length) await supabase.storage.from(PHOTOS_BUCKET).remove(files);
}

/** When a senior's ID changes, remove the folder stored under the old key. */
async function cleanupStaleFolder(folderKey, oldFacePath) {
    try {
        if (!oldFacePath) return;
        const oldPrefix = String(oldFacePath).split('/')[0];
        if (!oldPrefix || oldPrefix === folderKey || oldPrefix === 'faces') return;
        await removeFolderRecursive(oldPrefix);
        console.log(`Supabase: removed stale senior folder "${oldPrefix}/" (senior re-keyed to "${folderKey}").`);
    } catch (err) {
        console.warn('Supabase stale-folder cleanup skipped:', err.message);
    }
}

/**
 * Mirrors a senior record into Supabase:
 *   1. face image         -> {seniorId}/face/face.jpg
 *   2. Senior ID front    -> {seniorId}/id/front.jpg   (back-to-back, required)
 *   3. Senior ID back     -> {seniorId}/id/back.jpg
 *   4. name               -> {seniorId}/name/name.txt
 *   5. information        -> {seniorId}/information/information.json
 *   6. verified ID        -> {seniorId}/senior-id/... (copied from the vault)
 *   7. identity row       -> public.seniors (the searchable table)
 * Throws on failure so callers can log/report; callers decide whether
 * that is fatal (it never should be — Firebase stays the source of truth).
 */
async function syncSeniorRecord(uid, user, faceImage, idFrontImage, idBackImage, extra) {
    if (!supabase) return { skipped: true, reason: 'Supabase is not configured.' };
    if (!(await ensureSeniorsBucket())) throw new Error('Supabase "photos" bucket unavailable.');

    let medCertImage = (extra && extra.medCertImage) || null;
    let medCertName = (extra && extra.medCertName) || '';
    let medCertType = (extra && extra.medCertType) || '';
    let extraHealth = (extra && extra.healthCondition) || '';
    // Support legacy call: syncSeniorRecord(uid, user, faceImage)  and new call with id images
    // Also support object style: faceImage as { faceImage, idFrontImage, idBackImage, medCertImage, ... }
    if (faceImage && typeof faceImage === 'object' && !String(faceImage).startsWith('data:')) {
        const obj = faceImage;
        idBackImage = obj.idBackImage || idBackImage;
        idFrontImage = obj.idFrontImage || idFrontImage;
        medCertImage = obj.medCertImage || medCertImage;
        medCertName = obj.medCertName || medCertName;
        medCertType = obj.medCertType || medCertType;
        extraHealth = obj.healthCondition || extraHealth;
        faceImage = obj.faceImage || null;
    }

    user = user || {};
    const folderKey = resolveFolderKey(uid, user);

    // Remember where the face used to live so renamed IDs can be cleaned up.
    const { data: existing } = await supabase
        .from(SENIORS_TABLE)
        .select('face_path')
        .eq('uid', String(uid))
        .maybeSingle();

    let facePath = (existing && existing.face_path) || user.facePath || null;
    if (faceImage) {
        const uploaded = await uploadFaceImage(folderKey, faceImage);
        if (uploaded) facePath = uploaded;
    }

    // Back-to-back Senior ID — both sides are stored privately alongside the face
    let idFrontPath = null;
    let idBackPath = null;
    // Prefer explicitly passed images, otherwise fall back to what's already on the user record (KYC re-sync)
    const frontSrc = idFrontImage || user.kycIdFrontImage || null;
    const backSrc = idBackImage || user.kycIdBackImage || null;
    if (frontSrc) {
        try { idFrontPath = await uploadIdImage(folderKey, frontSrc, 'front'); } catch (e) { console.warn('Supabase ID front upload failed:', e.message); }
    }
    if (backSrc) {
        try { idBackPath = await uploadIdImage(folderKey, backSrc, 'back'); } catch (e) { console.warn('Supabase ID back upload failed:', e.message); }
    }

    // Medical certification (only when an illness was reported) — stored under
    // seniors/{folderKey}/medical/ so it is tied to THIS senior's record.
    let medCertPath = null;
    const rawMedSrc = medCertImage || user.kycMedCertImage || null;
    if (rawMedSrc) {
        try {
            const parsed = splitDataUrl(String(rawMedSrc));
            if (parsed) {
                const safeMedName = String(medCertName || user.kycMedCertName || 'medical-certification')
                    .replace(/[^a-zA-Z0-9._ -]/g, '').replace(/\s+/g, '_').slice(-80) || 'medical-certification';
                const medPath = `${folderKey}/medical/medcert_${Date.now()}_${safeMedName}`;
                await supabase.storage.from(SENIORS_BUCKET).upload(medPath, parsed.buffer, { contentType: parsed.mimeType, upsert: true });
                medCertPath = medPath;
            }
        } catch (e) { console.warn('Supabase med-cert upload failed:', e.message); }
    }

    const mergedHealth = extraHealth || user.healthCondition || user.condition || user.illness || '';
    if (mergedHealth) user = { ...user, healthCondition: mergedHealth };
    await uploadTextFile(`${folderKey}/name/name.txt`, displayNameOf(user), 'text/plain');
    await uploadTextFile(`${folderKey}/information/information.json`, buildInformation(user), 'application/json');
    const idCopies = await copyVerifiedIdDocuments(folderKey, user.idDocuments);
    await cleanupStaleFolder(folderKey, existing && existing.face_path);

    // Carry storage paths into the row so Supabase knows exactly where this
    // senior's ID front/back + med cert live (all keyed by this uid's folder).
    user = { ...user, idFrontPath, idBackPath, medCertPath, kycMedCertPath: medCertPath || user.kycMedCertPath || null };
    const res = await upsertSeniorRow(uid, user, facePath);
    const { error } = res;
    if (error) {
        if (/does not exist|Could not find the table/i.test(error.message || '')) {
            throw new Error('Table "seniors" does not exist yet — run scripts/supabase-setup.sql in the Supabase SQL editor.');
        }
        throw new Error(error.message);
    }
    if (res.migratedHint) console.warn(res.migratedHint);
    return { synced: true, facePath, idFrontPath, idBackPath, medCertPath, folderKey, idCopies, migratedHint: res.migratedHint || null };
}

/** Removes a senior's mirrored row (face file in the bucket is kept for audit). */
async function removeSeniorRecord(uid) {
    if (!supabase) return;
    const { error } = await supabase.from(SENIORS_TABLE).delete().eq('uid', String(uid));
    if (error) throw new Error(error.message);
}

/** Row count of the seniors table (used by scripts/check-supabase.js). */
async function countSeniors() {
    if (!supabase) return null;
    const { count, error } = await supabase
        .from(SENIORS_TABLE)
        .select('uid', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    return count;
}

const MED_CERT_VIEW_TTL_SECONDS = 300; // 5-minute viewing links (same policy as the other vaults)

/**
 * Short-lived private view link for a stored medical certification file
 * (photos/{folderKey}/medical/...). Nothing is ever publicly accessible;
 * staff re-open the certification through the backend only.
 */
async function createMedCertViewLink(storagePath) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data, error } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .createSignedUrl(storagePath, MED_CERT_VIEW_TTL_SECONDS);
    if (error) throw new Error(error.message);
    return data.signedUrl;
}

/**
 * Full Supabase export used by the admin Settings backup ZIP.
 * Returns every row of the seniors table plus a complete inventory
 * of the storage buckets (file paths, sizes, timestamps — not the
 * binary contents, which live safely in the buckets themselves).
 */
async function listBucketRecursive(bucket, prefix = '', depth = 0, maxFiles = 5000) {
    const out = [];
    if (depth > 4 || out.length >= maxFiles) return out;
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw new Error(error.message);
    for (const item of (data || [])) {
        if (out.length >= maxFiles) break;
        const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id === null) {
            // Folder — recurse
            out.push(...await listBucketRecursive(bucket, itemPath, depth + 1, maxFiles - out.length));
        } else {
            out.push({
                path: itemPath,
                name: item.name,
                sizeBytes: (item.metadata && item.metadata.size) || 0,
                updatedAt: item.updated_at || null
            });
        }
    }
    return out;
}

async function exportAllData() {
    if (!supabase) {
        return { enabled: false, reason: 'Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).' };
    }

    // 1) Every row of the seniors mirror table
    let seniors = [];
    let tableError = null;
    try {
        const { data, error } = await supabase.from(SENIORS_TABLE).select('*');
        if (error) tableError = error.message;
        else seniors = data || [];
    } catch (err) {
        tableError = err.message;
    }

    // 2) File inventory of both storage buckets (paths only, not binaries)
    const storage = {};
    for (const bucket of [PHOTOS_BUCKET, ID_VAULT_BUCKET]) {
        try {
            storage[bucket] = { files: await listBucketRecursive(bucket), fileCount: 0 };
            storage[bucket].fileCount = storage[bucket].files.length;
        } catch (err) {
            storage[bucket] = { error: err.message };
        }
    }

    return {
        enabled: true,
        url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
        table: SENIORS_TABLE,
        rowCount: seniors.length,
        tableError: tableError,
        seniors: seniors,
        storage: storage
    };
}

module.exports = {
    isSyncEnabled,
    ensureSeniorsBucket,
    ensurePhotosBucket: ensureSeniorsBucket,
    uploadFaceImage,
    buildSeniorRow,
    syncSeniorRecord,
    removeSeniorRecord,
    countSeniors,
    exportAllData,
    createMedCertViewLink,
    MED_CERT_VIEW_TTL_SECONDS,
    SENIORS_TABLE,
    PHOTOS_BUCKET,
    SENIORS_BUCKET: PHOTOS_BUCKET,
    ID_VAULT_BUCKET
};

