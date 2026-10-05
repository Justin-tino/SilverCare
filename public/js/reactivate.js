// ============================================================
// SilverCare — Inactive Account Reactivation via Face Scan
// Step 1: find the senior account by OSCA / Senior Citizen ID →
// Step 2: face match against the stored registration/KYC face
// photo (same face-api.js library + models as the KYC tab).
// Step 3: the senior waits on this page while OSCA staff review
// the request — the screen polls the server and updates itself
// as soon as the request is approved (or not approved).
// ============================================================
(function () {
    'use strict';

    const MODEL_BASES = [
        '/models',
        'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights',
        'https://justadudewhohacks.github.io/face-api.js/models',
        'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights'
    ];
    const MODEL_BASE_TIMEOUT_MS = 20000; // don't hang forever on slow mobile data
    const FACE_LIB_URLS = [
        'https://cdnjs.cloudflare.com/ajax/libs/face-api.js/0.22.2/face-api.min.js',
        'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js',
        'https://unpkg.com/face-api.js@0.22.2/dist/face-api.min.js'
    ];
    // Smaller + far more tolerant on slow phones than the big 68-point net.
    // Full 68-point net is only tried as a last resort.
    let landmarkNetName = 'faceLandmark68TinyNet';
    const MATCH_THRESHOLD = 0.6;

    let seniorId = '';
    let token = '';
    let modelsLoaded = false;
    let modelsLoading = null;       // in-flight model load promise (dedupes retries)
    let referenceDescriptor = null; // cached — the stored photo never changes during the session
    let stream = null;
    let preferredFacing = 'user'; // senior can toggle front/rear via Switch Camera
    let lastDistance = null;
    let lastSnapshot = '';

    const $ = (id) => document.getElementById(id);

    function showStep(n) {
        [1, 2, 3].forEach(i => {
            const panel = $('step' + i);
            const dot = $('dot' + i);
            if (panel) panel.classList.toggle('show', i === n);
            if (dot) dot.classList.toggle('on', i === n);
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function setMsg(id, type, text) {
        const el = $(id);
        if (!el) return;
        el.className = 'msg' + (type ? ' ' + type : '');
        el.textContent = text || '';
        if (text) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function setBusy(btn, busy, label) {
        if (!btn) return;
        btn.disabled = !!busy;
        // Keep the FontAwesome icon — only swap the text node that follows it.
        const icon = btn.querySelector('i');
        if (label !== undefined) {
            if (icon && icon.nextSibling) {
                icon.nextSibling.textContent = ' ' + label;
            } else {
                btn.textContent = label;
            }
            delete btn.dataset.label;
        } else if (busy) {
            btn.dataset.label = (icon && icon.nextSibling ? icon.nextSibling.textContent : btn.textContent).trim();
            if (icon && icon.nextSibling) icon.nextSibling.textContent = ' Please wait…';
            else btn.textContent = 'Please wait…';
        } else if (btn.dataset.label) {
            if (icon && icon.nextSibling) icon.nextSibling.textContent = ' ' + btn.dataset.label;
            else btn.textContent = btn.dataset.label;
            delete btn.dataset.label;
        }
    }

    async function postJson(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        let data = {};
        try { data = await res.json(); } catch (e) { /* keep {} */ }
        if (!res.ok) {
            const err = new Error((data && data.message) || 'Request failed. Please try again.');
            if (data && data.reason) err.reason = data.reason; // e.g. ALREADY_ACTIVE
            throw err;
        }
        return data;
    }

    // ---- Step 1: find the senior account by OSCA / Senior ID ----
    // Flow: senior types OSCA ID → server says ACTIVE (→ login, no face
    // scan) or INACTIVE (→ ask for a face scan, then proceed to reactivation).
    const findAccountBtn = $('findAccountBtn');
    function showActiveAccount(boxId) {
        const el = $(boxId);
        if (!el) return;
        el.className = 'msg info';
        el.innerHTML = '';
        const span = document.createElement('span');
        span.textContent = 'This account is still active, please proceed to login ';
        const link = document.createElement('a');
        link.href = '/';
        link.textContent = 'Go to Login';
        link.style.fontWeight = '800';
        link.style.color = '#065f46';
        el.appendChild(span);
        el.appendChild(link);
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    async function findAccount() {
        const input = $('reactSeniorId');
        seniorId = (input && input.value ? input.value : '').trim();
        if (!seniorId) {
            setMsg('msg1', 'err', 'Please type your OSCA / Senior Citizen ID number.');
            return;
        }
        setBusy(findAccountBtn, true);
        setMsg('msg1', 'info', 'Looking up your account…');
        try {
            let data = null;
            try {
                data = await postJson('/api/reactivation/start', { seniorId });
            } catch (lookupErr) {
                // Active accounts must NOT do a face scan — send them to login.
                if ((lookupErr && lookupErr.reason) === 'ALREADY_ACTIVE' ||
                    /still active/i.test(String((lookupErr && lookupErr.message) || ''))) {
                    showActiveAccount('msg1');
                } else {
                    setMsg('msg1', 'err', (lookupErr && lookupErr.message) || 'Could not find your account. Please try again.');
                }
                return;
            }
            token = data.token || '';
            if (!token) throw new Error('Could not start the face scan. Please try again.');
            referenceDescriptor = null; // new senior ID → drop any cached face
            lastDistance = null;
            lastSnapshot = '';
            if ($('scanBtn')) $('scanBtn').disabled = true;
            if ($('submitBtn')) $('submitBtn').disabled = true;
            if (data.name || data.seniorId) {
                $('faceHint').innerHTML = 'Hello, <strong>' + escapeHtml(data.name || 'Senior Citizen') + '</strong>! (OSCA ID ' +
                    escapeHtml(data.seniorId || seniorId) + ') This account is <strong>inactive</strong>. ' +
                    'Please scan your face to confirm it is really you, then press <strong>Send Reactivation Request</strong>.';
            }
            setMsg('msg1', 'ok', 'Account found! This account is inactive — please continue to the face scan.');
            // Move on right away — face recognition loads in the background on Step 2.
            showStep(2);
            setMsg('msg2', 'info', 'Loading face recognition… please wait a moment.');
            loadModelsInBackground();
            // Auto-open the FRONT camera so the senior only has to look + scan.
            startCamera(true);
        } catch (err) {
            setMsg('msg1', 'err', err.message);
        } finally {
            setBusy(findAccountBtn, false, 'Continue to Face Scan');
        }
    }
    if (findAccountBtn) findAccountBtn.addEventListener('click', findAccount);
    // Pressing Enter in the OSCA ID field should do the same as clicking Continue.
    const seniorIdInput = $('reactSeniorId');
    if (seniorIdInput) seniorIdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); findAccount(); }
    });

    // ---- face-api.js helpers ----
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector('script[data-faceapi="' + src + '"]')) return resolve();
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.setAttribute('data-faceapi', src);
            s.onload = () => resolve();
            s.onerror = () => { s.remove(); reject(new Error('script:' + src)); };
            document.head.appendChild(s);
        });
    }
    // The face-api.js script tag loads from a CDN — it may not be ready the
    // moment Step 2 shows, so wait for the global to appear before giving up.
    function waitForFaceApi(timeoutMs) {
        return new Promise((resolve, reject) => {
            const started = Date.now();
            (function check() {
                if (typeof faceapi !== 'undefined') return resolve();
                if (Date.now() - started > timeoutMs) return reject(new Error('library'));
                setTimeout(check, 250);
            })();
        });
    }

    async function ensureFaceApiLoaded() {
        if (typeof faceapi !== 'undefined') return;
        try { await waitForFaceApi(4000); return; } catch (e) { /* try mirrors */ }
        let lastErr = null;
        for (const url of FACE_LIB_URLS) {
            try { await loadScriptOnce(url); await waitForFaceApi(12000); return; }
            catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('library');
    }

    function withTimeout(promise, ms, label) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout:' + (label || 'load'))), ms || MODEL_BASE_TIMEOUT_MS))
        ]);
    }
    async function tryLoadModelsFrom(base) {
        await withTimeout(faceapi.nets.tinyFaceDetector.loadFromUri(base), MODEL_BASE_TIMEOUT_MS, base);
        landmarkNetName = 'faceLandmark68TinyNet';
        if (faceapi.nets.faceLandmark68TinyNet) {
            try { await withTimeout(faceapi.nets.faceLandmark68TinyNet.loadFromUri(base), MODEL_BASE_TIMEOUT_MS, base); }
            catch (e) {
                await withTimeout(faceapi.nets.faceLandmark68Net.loadFromUri(base), MODEL_BASE_TIMEOUT_MS, base);
                landmarkNetName = 'faceLandmark68Net';
            }
        } else {
            await withTimeout(faceapi.nets.faceLandmark68Net.loadFromUri(base), MODEL_BASE_TIMEOUT_MS, base);
            landmarkNetName = 'faceLandmark68Net';
        }
        await withTimeout(faceapi.nets.faceRecognitionNet.loadFromUri(base), MODEL_BASE_TIMEOUT_MS, base);
    }

    async function loadModelsInBackground() {
        if (modelsLoaded) { setMsg('msg2', '', ''); return true; }
        if (modelsLoading) { try { await modelsLoading; } catch (e) { /* handled */ } return modelsLoaded; }
        modelsLoading = (async () => {
            setMsg('msg2', 'info', 'Loading face recognition… this takes a few seconds on first use. Please keep this page open.');
            await ensureFaceApiLoaded();
            let lastErr = null;
            for (const base of MODEL_BASES) {
                try {
                    await tryLoadModelsFrom(base);
                    modelsLoaded = true;
                    setMsg('msg2', 'info', 'Ready! Look straight at the front camera with good light, then press Scan My Face.');
                    return true;
                } catch (e) {
                    lastErr = e;
                    console.warn('Face models failed from ' + base + ':', e);
                }
            }
            throw lastErr || new Error('models');
        })();
        try {
            await modelsLoading;
        } catch (err) {
            console.error('Face model load failed:', err);
            setMsg('msg2', 'err', 'Face recognition could not load (internet is needed to load it once). Press "Scan My Face" to try again — or visit the OSCA office for help.');
            return false;
        } finally {
            modelsLoading = null; // allow retry via Scan My Face
        }
        return modelsLoaded;
    }

    function stopCamera() {
        if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* noop */ } stream = null; }
        const v = $('liveVideo');
        if (v) { try { v.pause(); } catch (e) { /* noop */ } v.srcObject = null; }
    }

    // Always prefer the FRONT (selfie) camera, with a Switch Camera toggle so
    // a senior stuck on the wrong lens (like the screenshot) can flip it.
    async function startCamera(silent) {
        if (!silent) setMsg('msg2', '', '');
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('This device or browser does not support camera access. Please use a phone or computer with a camera.');
            }
            stopCamera();
            const want = preferredFacing === 'environment' ? 'environment' : 'user';
            const attempts = want === 'environment' ? [
                { video: { facingMode: { exact: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
                { video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
                { video: { facingMode: 'environment' }, audio: false },
                { video: true, audio: false }
            ] : [
                { video: { facingMode: { exact: 'user' }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
                { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
                { video: { facingMode: 'user' }, audio: false },
                { video: true, audio: false }
            ];
            let lastErr = null;
            for (const constraints of attempts) {
                try { stream = await navigator.mediaDevices.getUserMedia(constraints); lastErr = null; break; }
                catch (e) { lastErr = e; }
            }
            if (!stream) throw lastErr || new Error('Camera unavailable.');
            const video = $('liveVideo');
            video.muted = true;
            video.setAttribute('playsinline', 'true');
            // Mirror is OFF on purpose: seniors were confused because the
            // preview moved the opposite way. Show the true camera image.
            video.style.transform = 'none';
            video.srcObject = stream;
            try { await video.play(); } catch (e) { /* autoplay policy */ }
            await new Promise((resolve) => {
                if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
                const to = setTimeout(resolve, 2500);
                video.addEventListener('loadeddata', () => { clearTimeout(to); resolve(); }, { once: true });
            });
            if ($('scanBtn')) $('scanBtn').disabled = false;
            if ($('switchCamBtn')) $('switchCamBtn').style.display = 'block';
            setMsg('msg2', 'info', want === 'environment'
                ? 'Rear camera is on. If you see your fingers or the room instead of your face, press Switch Camera to use the front camera, then press Scan My Face.'
                : 'Front camera is on. Look straight at the camera with good light on your face, then press Scan My Face.');
            return true;
        } catch (err) {
            console.error('Camera error:', err);
            const blocked = err && err.name === 'NotAllowedError';
            setMsg('msg2', 'err', blocked
                ? 'Camera permission was blocked. Please tap the lock/camera icon in your browser address bar, allow the camera, then press Start Camera again.'
                : 'Could not open the ' + (preferredFacing === 'environment' ? 'rear' : 'front') + ' camera. Please allow camera permission in your browser, try Switch Camera, or visit the OSCA office for help.');
            return false;
        }
    }
    // Backwards-compatible alias (older cached HTML may call startFrontCamera).
    function startFrontCamera(silent) { return startCamera(silent); }

    const startCamBtn = $('startCamBtn');
    if (startCamBtn) startCamBtn.addEventListener('click', () => startCamera(false));
    const switchCamBtn = $('switchCamBtn');
    if (switchCamBtn) switchCamBtn.addEventListener('click', () => {
        preferredFacing = preferredFacing === 'environment' ? 'user' : 'environment';
        startCamera(false);
    });

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    function formatPercent(distance) {
        const pct = Math.max(0, Math.min(100, Math.round((1 - distance) * 100)));
        return pct + '%';
    }

    // ---- Step 2: scan + submit ----
    // Two-pass detector: first a fast/small pass (works on slow phones and
    // small faces), then the precise pass only if the first misses.
    function detectorOptionsList() {
        return [
            new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }),
            new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }),
            new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.35 })
        ];
    }
    function withLandmarks(detection) {
        if (landmarkNetName === 'faceLandmark68TinyNet' && typeof detection.withFaceLandmarks === 'function') {
            try { return detection.withFaceLandmarks(true); } catch (e) { /* fall through */ }
        }
        return detection.withFaceLandmarks();
    }

    async function detectFaceWithDescriptors(input) {
        const list = detectorOptionsList();
        for (const opts of list) {
            try {
                const det = await withLandmarks(faceapi.detectSingleFace(input, opts)).withFaceDescriptor();
                if (det) return det;
            } catch (e) { /* try next detector size */ }
        }
        return null;
    }
    function detectorOptions() { return detectorOptionsList()[1]; }

    function hidePhotoPreview() {
        const wrap = $('photoPreviewWrap');
        if (wrap) wrap.classList.remove('show');
        const img = $('photoPreviewImg');
        if (img) img.removeAttribute('src');
        const m = $('photoPreviewMatch');
        if (m) m.textContent = '';
    }
    function showPhotoPreview(dataUrl, pctText) {
        const wrap = $('photoPreviewWrap');
        const img = $('photoPreviewImg');
        const m = $('photoPreviewMatch');
        // The saved photo is never mirrored — show exactly what staff gets.
        if (img) img.src = dataUrl;
        if (m) m.textContent = pctText || '';
        if (wrap) {
            wrap.classList.add('show');
            wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    const submitBtn = $('submitBtn');
    const retakeBtn = $('retakeBtn');
    if (retakeBtn) retakeBtn.addEventListener('click', () => {
        lastDistance = null;
        lastSnapshot = '';
        hidePhotoPreview();
        if (submitBtn) submitBtn.style.display = 'none';
        if ($('matchText')) $('matchText').textContent = '';
        if ($('matchFill')) $('matchFill').style.width = '0';
        if ($('scanBtn')) $('scanBtn').disabled = false;
        setMsg('msg2', 'info', 'Photo discarded. Look straight at the camera with good light, then press Scan My Face again.');
    });

    // True when the server already holds a request for this senior. A dropped
    // or timed-out response can hide a request the server already stored, so we
    // check before telling the senior to start over.
    async function reactivationRequestAlreadyStored() {
        if (!seniorId) return false;
        try {
            const res = await fetch('/api/reactivation/status?seniorId=' + encodeURIComponent(seniorId));
            const data = await res.json().catch(() => ({}));
            return !!(res.ok && data.success && data.status && data.status !== 'None');
        } catch (e) { return false; }
    }

    // Sends the matched scan to OSCA staff. Called automatically the moment the
    // face matches, and again from the retry button if that send failed.
    async function sendReactivationRequest() {
        if (!token || lastDistance === null || !lastSnapshot) {
            setMsg('msg2', 'err', 'Please scan your face successfully first.');
            return false;
        }
        if (submitBtn) submitBtn.style.display = 'none';
        setMsg('msg2', 'info', 'Sending your face scan to OSCA staff…');
        try {
            await postJson('/api/reactivation/submit', { token, distance: lastDistance, liveImage: lastSnapshot });
        } catch (err) {
            console.error('sendReactivationRequest error:', err);
            // The request may have been stored even though the reply never
            // reached us — in that case staff already see it, so move on.
            if (await reactivationRequestAlreadyStored()) {
                if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
                $('scanBtn').disabled = true;
                enterWaitingStep();
                return true;
            }
            setMsg('msg2', 'err', (err && err.message) || 'Could not send your request. Please try again.');
            if (submitBtn) {
                submitBtn.style.display = 'block';
                setBusy(submitBtn, false, 'Retry Sending');
            }
            return false;
        }
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        $('scanBtn').disabled = true;
        enterWaitingStep();
        return true;
    }

    const scanBtn = $('scanBtn');
    if (scanBtn) scanBtn.addEventListener('click', async () => {
        if (!token) { setMsg('msg2', 'err', 'Your session expired. Please start over.'); return; }
        const video = $('liveVideo');
        if (!video || !video.srcObject) { setMsg('msg2', 'err', 'Please press Start Camera first.'); return; }
        if (typeof faceapi === 'undefined' || !modelsLoaded) {
            // Not loaded yet — kick off a retry instead of dead-ending.
            setMsg('msg2', 'info', 'Face recognition is still loading — trying to finish loading it now…');
            await loadModelsInBackground();
            if (!modelsLoaded) return;
        }

        setBusy(scanBtn, true);
        setMsg('msg2', 'info', 'Scanning your face… please stay still and look at the camera.');
        $('matchText').textContent = '';
        $('matchFill').style.width = '0';
        if (submitBtn) submitBtn.style.display = 'none';
        hidePhotoPreview();
        lastDistance = null;

        try {
            // 1) Load the stored registration/KYC face photo (token-gated).
            //    It never changes during the session, so detect it only once
            //    and reuse the descriptor — repeat scans become much faster.
            if (!referenceDescriptor) {
                const refRes = await fetch('/api/reactivation/reference/' + encodeURIComponent(token));
                const refData = await refRes.json().catch(() => ({}));
                if (!refRes.ok) throw new Error((refData && refData.message) || 'Could not load your stored photo.');
                const refImg = await loadImage(refData.referenceImage);
                let refDet = null;
                for (const opts of detectorOptionsList()) {
                    try {
                        refDet = await withLandmarks(faceapi.detectSingleFace(refImg, opts)).withFaceDescriptor();
                        if (refDet) break;
                    } catch (e) { /* try next detector size */ }
                }
                if (!refDet) throw new Error('We could not read your stored photo. Please visit the OSCA office for help.');
                referenceDescriptor = refDet.descriptor;
            }

            // 2) Wait until the camera actually produces frames before detecting.
            if (!video.videoWidth) {
                await new Promise((resolve) => {
                    if (video.videoWidth) return resolve();
                    video.addEventListener('loadeddata', () => resolve(), { once: true });
                    setTimeout(resolve, 3000); // don't hang forever
                });
            }

            // 3) Detect the live face from the camera (retry once — a single
            //    frame can catch a blink, a motion blur or a half-turned head).
            let liveDet = await detectFaceWithDescriptors(video);
            if (!liveDet) {
                setMsg('msg2', 'info', 'Didn\u2019t catch your face yet — hold still, facing the light…');
                await new Promise((r) => setTimeout(r, 700));
                liveDet = await detectFaceWithDescriptors(video);
            }
            if (!liveDet) {
                setMsg('msg2', 'err', 'No face detected. Please move closer, face the light, remove sunglasses/mask, and try again.');
                return;
            }

            // 4) Compare.
            const distance = faceapi.euclideanDistance(referenceDescriptor, liveDet.descriptor);
            lastDistance = distance;
            const pct = formatPercent(distance);
            $('matchFill').style.width = pct;
            if (distance <= MATCH_THRESHOLD) {
                $('matchText').textContent = 'Match: ' + pct + ' — sending to OSCA staff.';
                // Snapshot the live frame for staff review. Never mirrored,
                // so the preview, the saved photo, and the camera all match.
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth || 640;
                canvas.height = video.videoHeight || 480;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                lastSnapshot = canvas.toDataURL('image/jpeg', 0.75);
                // Show the senior their own photo, then send it right away.
                // A successful scan must never depend on the senior finding a
                // second button — that is how requests went missing before.
                showPhotoPreview(lastSnapshot, 'Face matched your registration photo (' + pct + ').');
                setMsg('msg2', 'info', 'We found your face (' + pct + '). Sending your request to OSCA staff now…');
                await sendReactivationRequest();
            } else {
                $('matchText').textContent = 'Match: ' + pct + ' — too low, please try again.';
                setMsg('msg2', 'err', 'Face did not match (' + pct + '). Face the camera clearly with good light and try again — or visit the OSCA office for help.');
            }
        } catch (err) {
            console.error('Face scan error:', err);
            setMsg('msg2', 'err', err.message || 'Face scan failed. Please try again.');
        } finally {
            setBusy(scanBtn, false, 'Scan My Face');
        }
    });

    // The request is sent automatically on a successful scan. This button is
// therefore only a retry, and stays hidden until a send actually fails.
    if (submitBtn) submitBtn.addEventListener('click', async () => {
        if (submitBtn.disabled) return;
        setBusy(submitBtn, true, 'Sending…');
        await sendReactivationRequest();
    });

    // ---- Step 3: wait for OSCA staff review (auto-updating screen) ----
    let pollTimer = null;
    const POLL_INTERVAL_MS = 10000;

    function enterWaitingStep() {
        showStep(3);
        $('waitBox').style.display = 'block';
        $('approvedBox').style.display = 'none';
        $('rejectedBox').style.display = 'none';
        const now = new Date();
        $('waitSince').textContent = 'Sent today at ' +
            now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(pollReactivationStatus, POLL_INTERVAL_MS);
        pollReactivationStatus(); // first check right away
    }

    async function pollReactivationStatus() {
        if (!seniorId) return;
        try {
            const res = await fetch('/api/reactivation/status?seniorId=' + encodeURIComponent(seniorId));
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) return; // transient issue — keep waiting
            if (data.status === 'Approved') stopPolling('approved');
            else if (data.status === 'Rejected') stopPolling('rejected', data.reviewNote || '');
        } catch (e) { /* network hiccup — keep polling */ }
    }

    function stopPolling(outcome, note) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        $('waitBox').style.display = 'none';
        if (outcome === 'approved') {
            $('approvedBox').style.display = 'block';
        } else if (outcome === 'rejected') {
            $('rejectedBox').style.display = 'block';
            $('rejectedReason').textContent = note
                ? 'OSCA staff note: ' + note + ' Please visit the OSCA Magalang office with a valid ID for assistance.'
                : 'OSCA staff could not approve your request. Please visit the OSCA Magalang office with a valid ID for assistance.';
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    const waitCheckBtn = $('waitCheckBtn');
    if (waitCheckBtn) waitCheckBtn.addEventListener('click', () => pollReactivationStatus());

    window.addEventListener('pagehide', () => {
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    });
})();
