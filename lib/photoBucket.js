/**
 * lib/photoBucket.js
 * ---------------------------------------------------------------
 * Single-image-bucket rule for SilverCare:
 *
 *     Storage > bucket "photos" > {ID-number} > face.jpg, ...
 *
 * ALL images (face captures, senior IDs, medical certifications,
 * reactivation live/reference shots, and any future senior image
 * input) live ONLY in the private "photos" bucket. Text data lives
 * in Postgres tables — never base64 inside the database.
 *
 * Layout (manageable filing cabinet, keyed by senior ID number,
 * falling back to Firebase uid only while OSCA-PENDING):
 *
 *     photos/
 *       {ID-number}/
 *         face.jpg                     -> face capture (one per senior)
 *         senior-id/{docId}_{file}     -> senior ID front/back + extras
 *         medical/{reportId}_{file}    -> health certifications
 *         reactivation/{uid}_{kind}.jpg-> reactivation live/reference
 *         name/name.txt                -> senior complete name
 *         information/information.json -> all senior information
 *
 * Buckets "seniors" / "senior-ids" / "medical-certifications" are
 * LEGACY: readable for migration, but all NEW uploads go to photos.
 * ---------------------------------------------------------------
 */

const { createClient } = require('@supabase/supabase-js');

const PHOTOS_BUCKET = 'photos';
const LEGACY_BUCKETS = ['seniors', 'senior-ids', 'medical-certifications'];

let supabase = null;
let photosReady = false;

const rawUrl = (process.env.SUPABASE_URL || '').trim();
const rawKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const urlLooksValid = /^https?:\/\/.+/i.test(rawUrl) && !/YOUR_SUPABASE/i.test(rawUrl);

if (urlLooksValid && rawKey && !/YOUR_SUPABASE/i.test(rawKey)) {
    try {
        supabase = createClient(rawUrl, rawKey, { auth: { persistSession: false } });
    } catch (err) {
        console.warn('Supabase client could not be created (photoBucket):', err.message);
        supabase = null;
    }
}

function sanitizeKey(key) {
    return String(key || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'unknown';
}

/**
 * Folder key for ONE senior: UNIQUE OSCA ID NUMBER, fallback to uid
 * only while no OSCA ID issued yet (OSCA-PENDING / N/A / NONE).
 */
function seniorFolderKey(user) {
    const sid = String((user && (user.seniorId || user.oscaId)) || '').trim();
    const usable = sid && !/^(OSCA[-_ ]?PENDING|N\/?A|PENDING|NONE)$/i.test(sid);
    return sanitizeKey(usable ? sid : ((user && user.uid) || 'unknown'));
}

/** Creates the private "photos" bucket on first use (no-op if exists). */
async function ensurePhotosBucket() {
    if (!supabase || photosReady) return photosReady;
    try {
        const { data, error } = await supabase.storage.getBucket(PHOTOS_BUCKET);
        if (error) {
            const { error: createError } = await supabase.storage.createBucket(PHOTOS_BUCKET, { public: false });
            if (createError) throw createError;
            console.log(`Supabase storage bucket "${PHOTOS_BUCKET}" created (private).`);
        } else if (data && data.public === true) {
            console.warn(`Supabase bucket "${PHOTOS_BUCKET}" is PUBLIC — set it to private in the Supabase dashboard!`);
        }
        photosReady = true;
    } catch (err) {
        console.error('Supabase "photos" bucket initialization failed:', err.message);
    }
    return photosReady;
}

/** Upload (upsert) one file into photos/. Returns the storage path. */
async function uploadPhoto(storagePath, buffer, mimeType) {
    if (!(await ensurePhotosBucket())) throw new Error('Supabase "photos" bucket unavailable.');
    const { error } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(storagePath, buffer, { contentType: mimeType || 'image/jpeg', upsert: true });
    if (error) throw new Error(error.message);
    return storagePath;
}

/** Short-lived (5 min) private view link for a photo. */
async function createPhotoViewLink(storagePath, ttlSeconds = 300) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data, error } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .createSignedUrl(storagePath, ttlSeconds);
    if (error) throw new Error(error.message);
    return data.signedUrl;
}

module.exports = {
    PHOTOS_BUCKET,
    LEGACY_BUCKETS,
    seniorFolderKey,
    sanitizeKey,
    ensurePhotosBucket,
    uploadPhoto,
    createPhotoViewLink,
};
