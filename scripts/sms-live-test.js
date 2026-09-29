// Live TextBee check — talks to the REAL gateway with your REAL API key.
// Run with:
//   npm run test:sms:live                 -> validate the key + list paired phones
//   npm run test:sms:live -- 09171234567  -> also send one real test SMS
//
// Unlike scripts/sms-selftest.js (offline, mocked, no credentials needed),
// this hits https://api.textbee.dev for real. The helpers are extracted
// straight out of server.js, so the phone-number normalisation, the endpoint
// and the headers are exactly the ones the running app uses — if this passes,
// the deployment will send too.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// --- pull the production SMS helpers out of server.js ------------------------
function extract(name) {
    const fnStart = src.indexOf(`function ${name}(`);
    if (fnStart === -1) throw new Error('not found in server.js: ' + name);
    // Keep the leading "async" so awaited functions stay valid JavaScript.
    const asyncPrefix = src.slice(Math.max(0, fnStart - 6), fnStart);
    const start = /\basync\s$/.test(asyncPrefix) ? fnStart - 6 : fnStart;
    // Skip the parameter list (it may be a destructuring pattern with braces),
    // then walk the body braces to find the matching closing brace.
    let paren = 0, bodyStart = -1;
    for (let i = src.indexOf('(', fnStart); i < src.length; i++) {
        if (src[i] === '(') paren++;
        else if (src[i] === ')') { paren--; if (paren === 0) { bodyStart = src.indexOf('{', i); break; } }
    }
    if (bodyStart === -1) throw new Error('no body found for: ' + name);
    let depth = 0;
    for (let j = bodyStart; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error('unbalanced braces in: ' + name);
}

const constSrc = [
    src.slice(src.indexOf('const TEXTBEE_BASE_URL'), src.indexOf(';', src.indexOf('const TEXTBEE_BASE_URL')) + 1),
    src.slice(src.indexOf('const SMS_MAX_LENGTH'), src.indexOf(';', src.indexOf('const SMS_MAX_LENGTH')) + 1)
].join('\n');

const api = new Function(
    `${constSrc}\n${extract('normalizePhMobile')}\n${extract('maskMobile')}\n${extract('sendSms')}; return { normalizePhMobile, maskMobile, sendSms };`
)();

// Same expression server.js uses to build the base URL.
const BASE = String(process.env.TEXTBEE_BASE_URL || 'https://api.textbee.dev/api/v1')
    .trim().replace(/\/+$/, '');

function maskKey(key) {
    if (!key) return '(not set)';
    return key.length <= 12 ? key.slice(0, 4) + '...' : `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function line(label, value) {
    console.log(String(label).padEnd(22) + ': ' + value);
}

async function getJson(url) {
    const resp = await fetch(url, { headers: { 'x-api-key': process.env.TEXTBEE_API_KEY } });
    const body = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, body };
}

// --- 1. configuration --------------------------------------------------------
function checkConfig() {
    console.log('\n=== 1. Configuration ===');
    line('Base URL', BASE);
    line('API key', maskKey(process.env.TEXTBEE_API_KEY));
    line('Device pin', process.env.TEXTBEE_DEVICE_ID || '(none - the default phone sends)');
    if (!process.env.TEXTBEE_API_KEY) {
        console.log('\nFAIL: TEXTBEE_API_KEY is not set.');
        console.log('Add it to .env (local) or Railway > Service > Variables, then re-run.');
        return false;
    }
    return true;
}

// --- 2. does the gateway accept the key? -------------------------------------
async function checkStats() {
    console.log('\n=== 2. Account (GET /gateway/stats) ===');
    const r = await getJson(`${BASE}/gateway/stats`);
    if (!r.ok) {
        console.log(`FAIL: HTTP ${r.status} - ${(r.body && (r.body.error || r.body.message)) || 'no detail returned'}`);
        if (r.status === 401) console.log('The API key is wrong, mistyped or revoked. Create a new one in the TextBee dashboard.');
        return null;
    }
    const d = r.body.data || {};
    line('Messages sent', d.totalSentSMSCount ?? 0);
    line('Messages received', d.totalReceivedSMSCount ?? 0);
    line('Devices on account', d.totalDeviceCount ?? 0);
    line('API keys', d.totalApiKeyCount ?? 0);
    return d;
}

// --- 3. is an Android phone paired, enabled and awake? -----------------------
async function checkDevices() {
    console.log('\n=== 3. Paired phones (GET /gateway/devices) ===');
    const r = await getJson(`${BASE}/gateway/devices`);
    if (!r.ok) {
        console.log(`FAIL: HTTP ${r.status} - ${(r.body && (r.body.error || r.body.message)) || 'no detail returned'}`);
        return [];
    }
    const devices = r.body.data || [];
    if (!devices.length) {
        console.log('FAIL: no Android phone is paired with this account.');
        console.log('Install the TextBee app on the phone, sign in, and pair it (dashboard > Devices).');
        return [];
    }
    devices.forEach((dev, i) => {
        console.log(`\n  [${i + 1}] ${dev.name || dev.model || dev.brand || 'Android device'}`);
        line('    deviceId', dev._id);
        line('    enabled', dev.enabled === false ? 'NO - sending to this phone will fail!' : 'yes');
        line('    default', dev.isDefault ? 'yes' : 'no');
        line('    model', `${dev.brand || ''} ${dev.model || ''}`.trim() || 'unknown');
        line('    android', `${dev.os || 'Android'} ${dev.osVersion || ''}`.trim());
        line('    app version', dev.appVersionName || 'unknown');
        line('    sent so far', dev.sentSMSCount ?? 0);
    });
    const usable = devices.filter(d => d.enabled !== false);
    console.log('');
    if (!usable.length) {
        console.log('FAIL: every paired phone is disabled - enable one in the TextBee dashboard.');
    } else if (!process.env.TEXTBEE_DEVICE_ID && !devices.some(d => d.isDefault)) {
        console.log('WARNING: no default device and no TEXTBEE_DEVICE_ID set -');
        console.log('sends may be rejected. Set TEXTBEE_DEVICE_ID to one of the deviceIds above.');
    }
    return devices;
}

// --- 3b. can the phone ACTUALLY send? (health, not just presence) ------------
async function checkHealth(devices) {
    console.log('\n=== 3b. Phone health (GET /gateway/devices/{id}) ===');
    const warnings = [];
    const blockers = [];
    for (const dev of devices) {
        if (dev.enabled === false) continue;
        const r = await getJson(`${BASE}/gateway/devices/${dev._id}`);
        const d = r.body.data || {};
        const app = d.appStateInfo || {};
        const ageMin = d.lastHeartbeat
            ? Math.round((Date.now() - new Date(d.lastHeartbeat).getTime()) / 60000)
            : null;
        const appAgeMin = app.lastUpdated
            ? Math.round((Date.now() - new Date(app.lastUpdated).getTime()) / 60000)
            : null;
        const sim = ((d.simInfo && d.simInfo.sims) || [])[0] || {};
        const net = d.networkInfo || {};
        const pw = d.powerInfo || {};
        const bat = d.batteryInfo || {};

        console.log(`\n  ${dev.name || dev.model || dev._id}`);
        line('    last heartbeat', ageMin === null ? 'never' : `${ageMin} min ago (every ${d.heartbeatIntervalMinutes || 30} min)`);
        line('    network', net.networkType || 'unknown');
        line('    sim / carrier', `${sim.carrierName || 'unknown'} (${sim.serviceState || 'unknown'}, signal ${sim.signalLevel ?? '?'}/4)`);
        line('    battery', `${bat.percentage ?? '?'}%${bat.isCharging ? ', charging' : ''}`);
        line('    sms send delay', `${d.smsSendDelaySeconds ?? '?'}s`);
        // The phone only re-sends this report on its heartbeat, so a fresh
        // permission change stays invisible here until the app checks in. A
        // stale report is a hint, never proof - the real send below decides.
        const stale = appAgeMin !== null && appAgeMin > (d.heartbeatIntervalMinutes || 30);
        line('    permission reported', appAgeMin === null ? 'never' : `${appAgeMin} min ago${stale ? ' - STALE, may be out of date' : ''}`);
        line('    SMS send permission', app.hasSendSmsPermission === true ? 'granted' : `NOT GRANTED${stale ? ' (per the stale report)' : ''}`);
        line('    SMS receive permission', app.hasReceiveSmsPermission === true ? 'granted' : 'not granted (sending unaffected)');

        // Hard blocker: without Android's SMS send permission the API still
        // queues fine, but the phone rejects every message with
        // PERMISSION_DENIED ("SMS permission not granted").
        if (app.hasSendSmsPermission !== true) {
            blockers.push(`The TextBee app on "${dev.name || dev.model}" does NOT have the SMS SEND permission. Every message will fail with PERMISSION_DENIED.`);
        }
        // Android kills background apps: the common cause of late sends.
        if (ageMin !== null && ageMin > (d.heartbeatIntervalMinutes || 30) * 2) {
            warnings.push(`"${dev.name || dev.model}" looks OFFLINE (last heartbeat ${ageMin} min ago). Keep the phone on and the TextBee app open.`);
        }
        if (pw.isIgnoringBatteryOptimizations === false) {
            warnings.push(`Android may PAUSE the TextBee app on "${dev.name || dev.model}". Set battery usage to "Unrestricted".`);
        }
        if (pw.isPowerSaveMode === true) warnings.push('Battery saver is ON - it can delay or block sends.');
        if (pw.isDeviceIdleMode === true) warnings.push('The phone was in Doze at the last heartbeat.');
        if (net.networkType === 'none') warnings.push('The phone has NO network connection right now.');
        if (sim.serviceState && sim.serviceState !== 'IN_SERVICE') {
            warnings.push(`The SIM reports ${sim.serviceState} - it cannot send until it is back IN_SERVICE.`);
        }
    }
    console.log('');
    blockers.forEach(b => console.log('BLOCKER: ' + b));
    warnings.forEach(w => console.log('WARNING: ' + w));
    if (!blockers.length && !warnings.length) console.log('Phone health looks good.');
    if (blockers.length) {
        console.log('');
        console.log('HOW TO FIX (on the Android phone itself, not in TextBee):');
        console.log('  1. Android Settings > Apps > (See all apps) > TextBee > Permissions');
        console.log('  2. Find SMS and choose ALLOW.');
        console.log('  3. Open the TextBee app once so it re-reports the new permission.');
        console.log('  4. Run this test again.');
        console.log('Android stops showing the permission popup after two refusals, so the');
        console.log('app cannot ask again on its own - the toggle MUST be set in Settings.');
    }
    return { warnings, blockers };
}

// --- 4. optional: send one real SMS through the production code path ---------
async function sendTest(toRaw) {
    console.log('\n=== 4. Real send (POST /gateway/send-sms) ===');
    const e164 = api.normalizePhMobile(toRaw);
    line('You typed', toRaw);
    line('Normalised to', e164 || 'INVALID - not a PH mobile number');
    if (!e164) {
        console.log('\nFAIL: the gateway was never called (the app rejects this number the same way).');
        return false;
    }
    const message = 'SilverCare OSCA: TEST message - your SMS notifications are working. Please ignore.';
    line('Message', message);
    line('Length', `${message.length} chars (${Math.ceil(message.length / 160)} SMS part)`);
    line('Sending to', api.maskMobile(toRaw));

    const started = Date.now();
    let batchId = null;
    try {
        const out = await api.sendSms({ to: toRaw, message });
        const d = (out && out.data) || {};
        batchId = d.smsBatchId || null;
        console.log('\nOK - TextBee queued the message.');
        line('Batch id', batchId || '(not returned)');
        line('Recipients', d.recipientCount ?? 1);
        line('Round trip', `${Date.now() - started} ms`);
    } catch (e) {
        console.log('\nFAIL: ' + e.message);
        return { ok: false, status: 'rejected', batchId: null, errorCode: '', errorMessage: e.message };
    }
    if (!batchId) {
        console.log('\nNo batch id returned, so the delivery result cannot be checked.');
        return { ok: true, status: 'unknown', batchId: null, errorCode: '', errorMessage: '' };
    }
    return await waitForResult(batchId);
}

// --- 5. did the phone ACTUALLY send it? --------------------------------------
// A 200 from /send-sms only means "queued". A sleeping phone or a missing
// Android permission only shows up here, on the message status.
async function waitForResult(batchId, budgetMs) {
    console.log(`\n=== 5. Delivery result (batch ${batchId}) ===`);
    const deadline = Date.now() + (budgetMs || 45000);
    let last = 'pending';
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const r = await getJson(`${BASE}/gateway/messages?smsBatchId=${batchId}`);
        const m = (r.body.data || [])[0];
        if (!m) continue;
        if (m.status !== last) {
            console.log(`  ${new Date().toISOString().slice(11, 19)}  status: ${last} -> ${m.status}`);
            last = m.status;
        }
        if (['sent', 'delivered', 'failed', 'delivery_failed'].includes(m.status)) {
            if (m.status === 'sent' || m.status === 'delivered') {
                console.log('\nSUCCESS - the phone handed the message to the carrier.');
                console.log('(sent = carrier accepted it, delivered = handset confirmed it.');
                console.log(' Many carriers send no delivery report, so sent is a pass.)');
            } else {
                console.log('\nFAILED on the phone - the message never left the handset.');
                line('  errorCode', m.errorCode || '(none)');
                line('  errorMessage', m.errorMessage || '(none)');
                line('  failedAt', m.failedAt || '?');
                if (String(m.errorCode).includes('PERMISSION')) {
                    console.log('\n  FIX: the TextBee app is missing the SMS permission.');
                    console.log('  On the Android phone: Settings > Apps > textbee > Permissions');
                    console.log('  > SMS > Allow. Then run this test again.');
                } else if (String(m.errorCode).startsWith('FCM')) {
                    console.log('\n  FIX: the push never reached the phone. Open the TextBee app');
                    console.log('  on the phone and make sure it is connected.');
                }
            }
            return {
                ok: m.status === 'sent' || m.status === 'delivered',
                status: m.status, batchId,
                errorCode: m.errorCode || '', errorMessage: m.errorMessage || ''
            };
        }
    }
    console.log(`\nStill "${last}" after ${Math.round((budgetMs || 45000) / 1000)}s.`);
    console.log('The phone has not picked the message up. Keep the TextBee app open,');
    console.log('the phone online, then send again.');
    return { ok: false, status: last, batchId, errorCode: '', errorMessage: 'Timed out waiting for the phone.' };
}

(async () => {
    console.log('==================================================');
    console.log(' TextBee live check - SilverCare OSCA');
    console.log('==================================================');

    if (!checkConfig()) process.exit(1);

    let stats = null;
    try {
        stats = await checkStats();
    } catch (e) {
        console.log('FAIL: could not reach TextBee - ' + e.message);
        console.log('Check the internet connection on this machine.');
    }
    if (!stats) process.exit(1);

    let devices = [];
    try {
        devices = await checkDevices();
    } catch (e) {
        console.log('FAIL: ' + e.message);
    }
    const usable = devices.filter(d => d.enabled !== false);

    let health = { warnings: [], blockers: [] };
    if (usable.length) {
        try {
            health = await checkHealth(usable);
        } catch (e) {
            console.log('FAIL: ' + e.message);
        }
    }

    // First CLI argument that looks like a phone number.
    const arg = process.argv.slice(2).find(a => /\d/.test(a));
    let sent = null;
    if (arg) {
        sent = await sendTest(arg);
    } else {
        console.log('\n=== 4. Real send ===');
        console.log('Skipped - pass a number to prove delivery end to end:');
        console.log('  npm run test:sms:live -- 09171234567');
    }

    console.log('\n==================================================');
    console.log(' RESULT');
    console.log('==================================================');
    line('API key', 'valid');
    line('Phones paired', devices.length);
    line('Phones usable', usable.length);
    if (health.blockers.length) line('Phone blockers', health.blockers.length);
    if (health.warnings.length) line('Phone warnings', health.warnings.length);
    if (sent) line('Test SMS', sent.ok ? `SENT (${sent.status})` : `FAILED (${sent.status})`);
    if (sent && sent.errorMessage) line('Gateway said', sent.errorMessage);

    if (!usable.length) {
        console.log('\nNOT READY: pair or enable an Android phone in TextBee.');
        process.exit(1);
    }
    // A delivered message beats a stale permission report - the phone only
    // re-sends its permission state on the heartbeat, so the report above can
    // still read "NOT GRANTED" minutes after it was granted.
    if (sent && sent.ok) {
        console.log('\nREADY: the test message went out, so the phone can send.');
        if (health.blockers.length) {
            console.log('The permission report above is stale - it refreshes on the phone');
            console.log('heartbeat, so it will flip to "granted" shortly. Ignore it.');
        }
        if (health.warnings.length) {
            console.log('Still fix the warnings so Android does not pause the app later.');
        }
        process.exit(0);
    }
    if (health.blockers.length) {
        console.log('\nNOT READY: the phone itself is blocking sends - see the BLOCKER above.');
        console.log('Fix that on the Android phone, then run this test again.');
        process.exit(1);
    }
    if (sent && !sent.ok) {
        console.log('\nNOT READY: the app will queue messages but the phone will NOT send');
        console.log('them until the problem above is fixed.');
        process.exit(1);
    }
    if (!sent && health.warnings.length) {
        console.log('\nMOSTLY READY: the key and the phone work, but fix the warnings above');
        console.log('so Android does not pause the TextBee app.');
    }
    console.log('\nREADY: account verification, pension approve/release/released and');
    console.log('claim updates will text the senior on the CP number in their profile.');
    process.exit(0);
})();
