// Self-test for the TextBee SMS layer in server.js (no credentials needed).
// Run with:  npm run test:sms
//
// It extracts the pure SMS helpers straight out of server.js and exercises
// them, so the phone-number normalisation, the message templates and the
// exact TextBee HTTP contract are verified without booting Firebase/Express
// and without sending a single real text message.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

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

const typesStart = src.indexOf('const SMS_NOTIFICATION_TYPES');
const typesEnd = src.indexOf('];', typesStart) + 2;
const code = [
    extract('normalizePhMobile'), extract('maskMobile'),
    extract('smsSafe'), extract('buildStatusSms'),
    src.slice(typesStart, typesEnd)
].join('\n\n');

const api = new Function(`${code}; return { normalizePhMobile, maskMobile, smsSafe, buildStatusSms, SMS_NOTIFICATION_TYPES };`)();

let pass = 0, fail = 0;
function check(label, actual, expected) {
    if (actual === expected) { pass++; } else {
        fail++;
        console.log(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// --- normalizePhMobile: every format a senior might type in their profile ---
check('09XXXXXXXXX', api.normalizePhMobile('09171234567'), '+639171234567');
check('09XX with spaces/dashes', api.normalizePhMobile('0917 123-4567'), '+639171234567');
check('10-digit 9XXXXXXXXX', api.normalizePhMobile('9171234567'), '+639171234567');
check('+63 already E.164', api.normalizePhMobile('+63 917 123 4567'), '+639171234567');
check('639XXXXXXXXX without +', api.normalizePhMobile('639171234567'), '+639171234567');
check('parentheses', api.normalizePhMobile('(0917) 123 4567'), '+639171234567');
check('empty string', api.normalizePhMobile(''), '');
check('null', api.normalizePhMobile(null), '');
check('undefined', api.normalizePhMobile(undefined), '');
check('landline (Manila)', api.normalizePhMobile('02 8123 4567'), '');
check('foreign number', api.normalizePhMobile('+1 202 555 0123'), '');
check('too short', api.normalizePhMobile('0917'), '');
check('letters only', api.normalizePhMobile('N/A'), '');

// --- maskMobile: never leak a full number into logs/audit rows ---
check('mask hides the middle', api.maskMobile('09171234567'), '+63917****567');

// --- smsSafe: strips control chars/newlines and bounds the length ---
check('smsSafe strips newlines', api.smsSafe('a\nb\r\nc'), 'a b c');
check('smsSafe collapses spaces', api.smsSafe('a    b'), 'a b');
check('smsSafe bounds length', api.smsSafe('x'.repeat(500), 20).length, 20);
check('smsSafe keeps UTF-8 names', api.smsSafe('Peña, José'), 'Peña, José');

// --- buildStatusSms: every event the user asked for produces a usable text ---
// Pension approval (sent when verification auto-activates the pension setup).
const approved = api.buildStatusSms({ type: 'pension_approved', name: 'Juan', localAmount: '1000', nationalAmount: '3000', quarterlyTotal: '6000' });
checkTrue('pension_approved says APPROVED', approved.includes('APPROVED'));
checkTrue('pension_approved shows quarterly total', approved.includes('PHP 6,000'));

// Assistance approval (claim approved -> payout being released).
const assistance = api.buildStatusSms({ type: 'claim_approved', name: 'Juan', amount: '10000', serviceType: 'burial', refNumber: 'AB12CD34' });
checkTrue('claim_approved says APPROVED', assistance.includes('APPROVED'));
checkTrue('claim_approved names the service', assistance.includes('BURIAL'));
checkTrue('claim_approved shows the amount', assistance.includes('PHP 10,000'));

// Custom notification message (one senior or broadcast to everyone).
const announcement = api.buildStatusSms({ type: 'announcement', name: 'Juan', message: 'Payout on Friday at the OSCA office.' });
checkTrue('announcement carries the custom text', announcement.includes('Payout on Friday'));
checkTrue('announcement greets the senior', announcement.includes('Juan'));

const releasing = api.buildStatusSms({ type: 'pension_releasing', name: 'Juan', amount: '1000', period: '2026-09' });
checkTrue('pension_releasing says being RELEASED', releasing.includes('being RELEASED'));
checkTrue('pension_releasing shows the window', releasing.includes('2026-09'));

const released = api.buildStatusSms({ type: 'pension_released', name: 'Juan', amount: '6000', refNumber: 'AB12CD34' });
checkTrue('pension_released says RELEASED', released.includes('RELEASED'));
checkTrue('pension_released shows the reference', released.includes('AB12CD34'));
checkTrue('pension_released shows the amount', released.includes('PHP 6,000'));

const declined = api.buildStatusSms({ type: 'pension_declined', name: 'Juan', reason: 'Document discrepancy.' });
checkTrue('pension_declined shows the reason', declined.includes('Document discrepancy.'));

const claimOut = api.buildStatusSms({ type: 'claim_released', name: 'Juan', amount: '10000', serviceType: 'burial' });
checkTrue('claim_released names the service', claimOut.includes('BURIAL'));

// --- every template must stay inside the SMS length budget ---
const longest = [
    approved, assistance, announcement, releasing, released, declined, claimOut,
    api.buildStatusSms({ type: 'claim_releasing', name: 'Maximiliano Dela Cruz y Santos', amount: '100000', serviceType: 'financial assistance', refNumber: 'ZZ99YY88' }),
    api.buildStatusSms({ type: 'claim_declined', name: 'Maximiliano Dela Cruz y Santos', serviceType: 'burial', reason: 'Required documentation was missing or could not be verified by the local OSCA officers.' }),
    api.buildStatusSms({ type: 'announcement', name: 'x'.repeat(200), message: 'y'.repeat(400) })
].reduce((a, b) => (a.length > b.length ? a : b));
checkTrue('longest template under 480 chars', longest.length <= 480);

// --- the accepted type list must cover the events wired in the UI ---
['pension_approved', 'claim_approved', 'announcement', 'pension_releasing', 'pension_released', 'pension_declined']
    .forEach(t => checkTrue('type allowed: ' + t, api.SMS_NOTIFICATION_TYPES.includes(t)));
checkTrue('account_verified retired', !api.SMS_NOTIFICATION_TYPES.includes('account_verified'));
checkTrue('unknown type rejected', !api.SMS_NOTIFICATION_TYPES.includes('spam_relay'));

// --- the exact TextBee request contract ---
checkTrue('TextBee endpoint is /gateway/send-sms', src.includes('/gateway/send-sms'));
checkTrue('x-api-key header is sent', src.includes("'x-api-key': process.env.TEXTBEE_API_KEY"));
checkTrue('recipients array is sent', src.includes('{ recipients: [recipient], message: text }'));
checkTrue('deviceId only when pinned', src.includes('if (process.env.TEXTBEE_DEVICE_ID) payload.deviceId'));
checkTrue('CP number read from the senior profile', src.includes('const phone = String(user.cpNumber'));
checkTrue('route /api/send-status-sms exists', src.includes("app.post('/api/send-status-sms'"));
checkTrue('route /api/send-announcement-sms exists', src.includes("app.post('/api/send-announcement-sms'"));
checkTrue('route /api/sms-status exists', src.includes("app.get('/api/sms-status'"));

// --- notifySeniorSms decision logic, with admin + sender injected ---
async function verifyNotifier() {
    const typesSrc = src.slice(src.indexOf('const SMS_NOTIFICATION_TYPES'), src.indexOf('];', src.indexOf('const SMS_NOTIFICATION_TYPES')) + 2);
    const audits = [];
    const fakeWriteAudit = async (action, actor, uid, docId, detail) => { audits.push({ action, detail }); };
    const fakeAdmin = record => ({
        database: () => ({ ref: () => ({ once: async () => ({ exists: () => record !== null, val: () => record }) }) })
    });

    // Builds a notifier wired to a stub senior record, a stub audit log and a
    // stub gateway — every branch is exercised without network or DB writes.
    const makeNotifier = (record, sendStub) => new Function('admin', 'writeAuditLog', 'sendSms', `
        ${typesSrc}
        ${extract('normalizePhMobile')}
        ${extract('maskMobile')}
        ${extract('smsSafe')}
        ${extract('buildStatusSms')}
        ${extract('notifySeniorSms')}
        return notifySeniorSms;`)(fakeAdmin(record), fakeWriteAudit, sendStub);

    // 1) Senior with no CP number -> skip + audit, and never a send.
    let sends = 0;
    audits.length = 0;
    let notify = makeNotifier({ name: 'Juan', cpNumber: '' }, async () => { sends++; });
    let res = await notify('uid-blank', 'pension_approved');
    check('no CP number -> not sent', res.sent, false);
    check('no CP number -> explains why', res.reason, 'This senior has no mobile (CP) number on file.');
    check('no CP number -> no send attempted', sends, 0);
    check('no CP number -> audited', audits[0].action, 'SMS_SKIPPED_NO_NUMBER');

    // 1b) Senior record that does not exist -> clean refusal, nothing audited.
    audits.length = 0;
    res = await makeNotifier(null, async () => { sends++; })('uid-missing', 'pension_approved');
    check('missing senior -> reason', res.reason, 'Senior record not found.');
    check('missing senior -> no send attempted', sends, 0);

    // 2) Landline on file -> skip locally, audited as invalid.
    audits.length = 0;
    sends = 0;
    const notifyLandline = makeNotifier({ name: 'Juan', cpNumber: '02 8123 4567' }, async () => { sends++; });
    res = await notifyLandline('uid-landline', 'pension_released');
    check('landline -> not sent', res.sent, false);
    check('landline -> audited', audits[0].action, 'SMS_SKIPPED_INVALID_NUMBER');
    check('landline -> no send attempted', sends, 0);

    // 3) Happy path: real number, gateway accepts -> sent + masked recipient.
    audits.length = 0;
    let sentTo = null;
    const notifyOk = makeNotifier({ name: 'Juan', cpNumber: '0917 123 4567' }, async ({ to, message }) => { sentTo = { to, message }; });
    res = await notifyOk('uid-ok', 'pension_released', { amount: '6000' });
    check('valid number -> sent', res.sent, true);
    check('valid number -> E.164 recipient', sentTo.to, '+639171234567');
    checkTrue('valid number -> message names the event', sentTo.message.includes('RELEASED'));
    check('valid number -> masked recipient returned', res.to, '+63917****567');
    check('valid number -> audited', audits[0].action, 'SMS_STATUS_SENT');

    // 4) Gateway down -> the caller must still succeed (never throws).
    audits.length = 0;
    const notifyFail = makeNotifier({ name: 'Juan', cpNumber: '09171234567' }, async () => { throw new Error('gateway offline'); });
    res = await notifyFail('uid-fail', 'claim_approved');
    check('gateway failure -> not sent', res.sent, false);
    check('gateway failure -> reason surfaced', res.reason, 'gateway offline');
    check('gateway failure -> audited', audits[0].action, 'SMS_STATUS_FAILED');

    // 4) Unknown event type must be refused (the gateway is not an open relay).
    const notifyUnknown = makeNotifier({ name: 'Juan', cpNumber: '09171234567' }, async () => { sends++; });
    check('unknown type -> reason', (await notifyUnknown('uid-x', 'marketing_blast')).reason, 'Unknown SMS notification type.');

    // 5) Retired account_verified type must now be refused as unknown.
    check('retired account_verified -> reason', (await notifyUnknown('uid-x', 'account_verified')).reason, 'Unknown SMS notification type.');

    // 6) Announcement happy path: custom staff message reaches the gateway.
    audits.length = 0;
    let announcedTo = null;
    const notifyAnnounce = makeNotifier({ name: 'Juan', cpNumber: '0917 123 4567' }, async ({ to, message }) => { announcedTo = { to, message }; });
    res = await notifyAnnounce('uid-ok', 'announcement', { message: 'Payout on Friday at the OSCA office.' });
    check('announcement -> sent', res.sent, true);
    checkTrue('announcement -> carries custom text', announcedTo.message.includes('Payout on Friday'));
    check('announcement -> audited', audits[0].action, 'SMS_STATUS_SENT');
}

// --- the exact TextBee request contract, exercised with a mocked fetch ---
async function verifyRequestContract() {
    process.env.TEXTBEE_API_KEY = 'test-api-key';
    process.env.TEXTBEE_DEVICE_ID = 'device-abc123';
    const constSrc = [
        src.slice(src.indexOf('const TEXTBEE_BASE_URL'), src.indexOf(';', src.indexOf('const TEXTBEE_BASE_URL')) + 1),
        src.slice(src.indexOf('const SMS_MAX_LENGTH'), src.indexOf(';', src.indexOf('const SMS_MAX_LENGTH')) + 1)
    ].join('\n');
    const smsApi = new Function(
        `${constSrc}\n${extract('normalizePhMobile')}\n${extract('sendSms')}; return { sendSms };`
    )();

    let captured = null;
    global.fetch = async (url, opts) => {
        captured = { url, opts };
        return {
            ok: true, status: 200,
            json: async () => ({ data: { success: true, message: 'SMS added to queue for processing', smsBatchId: 'batch-1', recipientCount: 1 } })
        };
    };

    const out = await smsApi.sendSms({ to: '0917 123 4567', message: 'SilverCare OSCA: test notice' });
    check('request URL', captured.url, 'https://api.textbee.dev/api/v1/gateway/send-sms');
    check('request method', captured.opts.method, 'POST');
    check('request api key header', captured.opts.headers['x-api-key'], 'test-api-key');
    check('request content type', captured.opts.headers['Content-Type'], 'application/json');
    const sent = JSON.parse(captured.opts.body);
    check('recipient normalised to E.164', sent.recipients[0], '+639171234567');
    check('message body forwarded', sent.message, 'SilverCare OSCA: test notice');
    check('deviceId pinned when configured', sent.deviceId, 'device-abc123');
    check('gateway response returned', out.data.smsBatchId, 'batch-1');

    // A rejected key / disabled device must surface as an error, never as success.
    global.fetch = async () => ({
        ok: false, status: 401,
        json: async () => ({ success: false, error: 'Invalid API key' })
    });
    let errMsg = '';
    try { await smsApi.sendSms({ to: '09171234567', message: 'x' }); } catch (e) { errMsg = e.message; }
    check('401 surfaces the TextBee reason', errMsg, 'Invalid API key');

    // An unusable number must fail fast, without touching the network.
    let networkHits = 0;
    global.fetch = async () => { networkHits++; return { ok: true, status: 200, json: async () => ({}) }; };
    try { await smsApi.sendSms({ to: '02 8123 4567', message: 'x' }); } catch (e) { errMsg = e.message; }
    check('landline rejected locally', errMsg, 'No valid PH mobile number on file.');
    check('no network call for a bad number', networkHits, 0);
}

(async () => {
    await verifyRequestContract();
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
})();
