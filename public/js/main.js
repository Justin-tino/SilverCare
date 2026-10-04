import { auth, db } from './firebase-init.js';
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-auth.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-database.js";

// ============================================================
// Two-Factor Authentication (E-mail OTP) for Admin & OSCA Staff.
// Flow: password login -> server e-mails a 6-digit OTP via Gmail
// SMTP (/api/2fa/start) -> the user MUST verify (/api/2fa/verify)
// before the dashboard unlocks. No OTP = no login. Senior citizens
// intentionally keep the simplified login (panel requirement).
// ============================================================

const PENDING_KEY = 'sc_2fa_pending';   // JSON { uid, role, email } while the OTP challenge is open
const VERIFIED_KEY = 'sc_2fa_verified'; // uid that completed 2FA in this tab
const LOGIN_NOTICE_KEY = 'sc_login_notice'; // one-shot message handed to the login page (e.g. deceased account)
const RESEND_COOLDOWN_S = 30;           // mirrors TWOFA_RESEND_MS on the server
const DEFAULT_ADMIN_EMAIL = 'admin@silvercare.com'; // Master Admin — exempt from OTP
const DEFAULT_EMPLOYEE_EMAIL = 'employee@silvercare.com'; // Default OSCA employee — exempt from OTP
const OTP_EXEMPT_EMAILS = new Set([DEFAULT_ADMIN_EMAIL, DEFAULT_EMPLOYEE_EMAIL]);

function isOtpExemptEmail(email) {
    return OTP_EXEMPT_EMAILS.has(String(email || '').trim().toLowerCase());
}

// Never leave the UI on "Authenticating..." forever: any await that never
// settles (blocked RTDB websocket, hung SMTP, stalled fetch) is converted
// into a catchable error after `ms` so the button restores and the user
// sees a message instead of an infinite spinner.
function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error((label || 'Request') + ' timed out after ' + ms + 'ms.')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function fetchWithTimeout(url, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || 25000);
    const opts = Object.assign({}, options || {}, { signal: ctrl.signal });
    return fetch(url, opts).finally(() => clearTimeout(timer));
}

const ROLE_UI = {
    admin:    { title: 'Admin Login', icon: 'fas fa-shield-alt', iconColor: '#3b82f6', buttonBg: '#3b82f6' },
    employee: { title: 'OSCA Login',  icon: 'fas fa-users-cog',  iconColor: '#4a5568', buttonBg: '#4a5568' }
};

function readPending2FA() {
    try {
        const raw = sessionStorage.getItem(PENDING_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return (parsed && parsed.uid && parsed.role) ? parsed : null;
    } catch (err) {
        return null;
    }
}

function writePending2FA(state) {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ uid: state.uid, role: state.role, email: state.email || '' }));
}

function clearPending2FA() {
    sessionStorage.removeItem(PENDING_KEY);
}

function is2FAVerified(uid) {
    return sessionStorage.getItem(VERIFIED_KEY) === uid;
}

let resendTimer = null;
function startResendCooldown(seconds = RESEND_COOLDOWN_S) {
    const link = document.getElementById('resendOtpLink');
    if (!link) return;
    if (resendTimer) clearInterval(resendTimer);
    let remaining = seconds;
    const tick = () => {
        if (remaining <= 0) {
            clearInterval(resendTimer);
            resendTimer = null;
            link.textContent = 'Resend';
            link.style.pointerEvents = 'auto';
            link.style.opacity = '1';
            return;
        }
        link.textContent = `Resend (${remaining}s)`;
        remaining -= 1;
    };
    link.style.pointerEvents = 'none';
    link.style.opacity = '0.5';
    tick();
    resendTimer = setInterval(tick, 1000);
}

document.addEventListener('DOMContentLoaded', () => {
    // Message handed over by another page (e.g. the Senior portal signing out an
    // account that OSCA staff just marked deceased) — show it once, then clear it.
    try {
        const rawNotice = sessionStorage.getItem(LOGIN_NOTICE_KEY);
        if (rawNotice) {
            sessionStorage.removeItem(LOGIN_NOTICE_KEY);
            const notice = JSON.parse(rawNotice);
            if (notice && notice.message) scNotify(notice.type || 'error', notice.message, notice.title || 'Notice');
        }
    } catch (err) { /* malformed notice — ignore */ }

    const loginForm = document.getElementById('loginForm');
    const roleSelection = document.getElementById('roleSelection');
    const loginFormContainer = document.getElementById('loginFormContainer');
    const twoFAContainer = document.getElementById('twoFAContainer');
    const forgotPwContainer = document.getElementById('forgotPwContainer');
    const privacyContainer = document.getElementById('privacyContainer');

    function showScreen(which) {
        if (roleSelection) roleSelection.style.display = which === 'roles' ? 'block' : 'none';
        if (privacyContainer) privacyContainer.style.display = which === 'privacy' ? 'block' : 'none';
        if (loginFormContainer) loginFormContainer.style.display = which === 'login' ? 'block' : 'none';
        if (twoFAContainer) twoFAContainer.style.display = which === 'otp' ? 'block' : 'none';
        if (forgotPwContainer) forgotPwContainer.style.display = which === 'forgot' ? 'block' : 'none';
    }

    function resetOtpInputs(focusFirst = true) {
        const inputs = document.querySelectorAll('.otp-input');
        inputs.forEach(input => input.value = '');
        if (focusFirst && inputs.length) inputs[0].focus();
    }

    function open2FAScreen(state, { autoCooldown = true } = {}) {
        const ui = ROLE_UI[state.role] || ROLE_UI.admin;
        const icon = document.getElementById('otpRoleIcon');
        const title = document.getElementById('otpRoleTitle');
        const emailText = document.getElementById('otpSentEmail');
        const verifyBtn = document.getElementById('verifyOtpBtn');
        if (icon) { icon.className = ui.icon; icon.style.color = ui.iconColor; }
        if (title) title.textContent = ui.title;
        if (emailText) emailText.textContent = state.email || '';
        if (verifyBtn) verifyBtn.style.background = ui.buttonBg;
        resetOtpInputs();
        showScreen('otp');
        if (autoCooldown) startResendCooldown();
    }
    
    // Auth state observer — drives redirects AND restores an in-progress 2FA challenge
    auth.onAuthStateChanged(async (user) => {
        if (!user) {
            clearPending2FA();
            if (window.location.pathname === '/') showScreen('roles');
            return;
        }
        if (window.location.pathname !== '/') return;

        const pending = readPending2FA();
        if (pending && pending.uid === user.uid) {
            // Page reloaded mid-challenge — restore the OTP screen (no duplicate e-mail)
            open2FAScreen(pending, { autoCooldown: false });
            return;
        }
        if (pending && pending.uid !== user.uid) clearPending2FA();

        // The explicitly provisioned admin and default employee accounts are exempt from 2FA.
        if (!is2FAVerified(user.uid) && !isOtpExemptEmail(user.email)) {
            return; // admin/staff must finish 2FA first (dashboards enforce this too)
        }

        try {
            const userSnap = await withTimeout(get(ref(db, 'users/' + user.uid)), 20000, 'Profile lookup');
            if (userSnap.exists()) {
                const snapData = userSnap.val() || {};
                // Deceased gate (Archive Function): a senior marked Deceased must
                // never land on a dashboard even through an existing session —
                // kick them back to the landing login with the OSCA message.
                if (String(snapData.lifeStatus || '') === 'Deceased' || String(snapData.status || '') === 'Deceased') {
                    clearPending2FA();
                    try { sessionStorage.setItem(LOGIN_NOTICE_KEY, JSON.stringify({ type: 'error', title: 'Account Deceased', message: 'This senior have passed away, please go to OSCA if you think this is an error' })); } catch (e) {}
                    try { await auth.signOut(); } catch (e) {}
                    localStorage.removeItem('userRole');
                    if (window.location.pathname === '/') showScreen('roles');
                    else window.location.replace('/');
                    return;
                }
                const role = snapData.role;
                localStorage.setItem('userRole', role);
                if (role === 'admin') window.location.href = '/admin';
                else if (role === 'employee') window.location.href = '/employee';
                else window.location.href = '/senior';
            }
        } catch (err) {
            console.error("Auth check redirect error:", err);
        }
    });

    // Clear login credentials if navigated via back button
    window.addEventListener('pageshow', () => {
        if (loginForm) {
            loginForm.reset();
            const emailInput = document.getElementById('email');
            const passInput = document.getElementById('password');
            if (emailInput) emailInput.value = '';
            if (passInput) passInput.value = '';
        }
    });

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const btn = loginForm.querySelector('.btn-primary');
            
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Authenticating...';
            btn.disabled = true;

            try {
                // Standard Login for all users
                const userCredential = await withTimeout(signInWithEmailAndPassword(auth, email, password), 25000, 'Sign-in');

                const user = userCredential.user;

                // Check Database Role and Status (bounded: a blocked RTDB
                // websocket must time out into the catch below, never hang
                // the "Authenticating..." button forever).
                const userRef = ref(db, 'users/' + user.uid);
                const snapshot = await withTimeout(get(userRef), 20000, 'Profile lookup');
                
                if (snapshot.exists()) {
                    const userData = snapshot.val();

                    if (userData.status === 'Pending') {
                        await auth.signOut();
                        scNotify('warning', 'Your account is still awaiting admin approval. You will be notified once approved.', 'Account Pending');
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                        return;
                    }

                    if (userData.status === 'Rejected') {
                        await auth.signOut();
                        scNotify('error', 'Your account request has been rejected. Please contact an administrator for assistance.', 'Account Rejected');
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                        return;
                    }

                    // Deceased gate (Archive Function): the account of a senior who
                    // has passed away is archived by OSCA staff — it can never be
                    // signed in again and no longer receives pension or benefits.
                    const isDeceasedSenior = String(userData.role || '') === 'senior'
                        && (String(userData.lifeStatus || '') === 'Deceased' || String(userData.status || '') === 'Deceased');
                    if (isDeceasedSenior) {
                        await auth.signOut();
                        localStorage.removeItem('userRole');
                        scNotify('error', 'This senior have passed away, please go to OSCA if you think this is an error', 'Account Deceased');
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                        return;
                    }

                    if (userData.status !== 'Active') {
                        await auth.signOut();
                        const isInactiveSenior = (userData.role === 'senior') && ((userData.status || '') === 'Inactive' || (userData.lifeStatus || '') === 'Inactive');
                        scNotify('error', isInactiveSenior
                            ? 'Your account is currently inactive. You can reactivate it yourself with a face scan — choose "Account inactive? Reactivate with Face Scan" on the Senior login screen, or visit the OSCA office.'
                            : 'Your account is currently inactive. Please contact an administrator.', 'Account Inactive');
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                        return;
                    }

                    localStorage.setItem('userRole', userData.role);
                    
                    // Check maintenance mode for non-admins (bounded — same hang guard)
                    if (userData.role !== 'admin') {
                        const maintenanceSnap = await withTimeout(get(ref(db, 'system/settings/maintenanceMode')), 15000, 'Maintenance check');
                        if (maintenanceSnap.exists() && maintenanceSnap.val() === true) {
                            await auth.signOut();
                            localStorage.removeItem('userRole');
                            scNotify('warning', 'The system is currently under maintenance. Please try again later.', 'System Maintenance');
                            btn.innerHTML = originalText;
                            btn.disabled = false;
                            return;
                        }
                    }

                    // --- Provisioned staff account exemption: sign straight in, no OTP ---
                    if (isOtpExemptEmail(userData.email)) {
                        sessionStorage.removeItem(VERIFIED_KEY);
                        clearPending2FA();

                        // Reset login form fields before redirecting
                        const exemptEmailInput = document.getElementById('email');
                        const exemptPassInput = document.getElementById('password');
                        if (exemptEmailInput) exemptEmailInput.value = '';
                        if (exemptPassInput) exemptPassInput.value = '';
                        if (loginForm) loginForm.reset();

                        if (userData.role === 'admin') window.location.href = '/admin';
                        else if (userData.role === 'employee') window.location.href = '/employee';
                        else window.location.href = '/senior';
                        return;
                    }

                    // --- Two-Factor Authentication gate (Admin & OSCA Staff only) ---
                    if (userData.role === 'admin' || userData.role === 'employee') {
                        // Every fresh login must pass a brand-new OTP challenge
                        sessionStorage.removeItem(VERIFIED_KEY);
                        clearPending2FA();

                        try {
                            const token = await withTimeout(user.getIdToken(), 20000, 'Session token');
                            // 45s budget: the server's own ops are capped at ~39s worst case
                            // (token verify 10s + profile read 10s + e-mail 15s + audit 4s), so this
                            // client must outlive that — otherwise a slow mail provider/DB shows a
                            // false "timed out" even though the code e-mail was actually sent.
                            const startRes = await fetchWithTimeout('/api/2fa/start', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
                            }, 45000);
                            const startData = await startRes.json().catch(() => ({}));

                            if (!startRes.ok && startRes.status !== 429) {
                                // Could not e-mail the OTP — refuse the login (no OTP, no login)
                                await auth.signOut();
                                localStorage.removeItem('userRole');
                                scNotify('error', startData.message || 'Failed to send the security code to your email. Please try again.', '2FA Required');
                                btn.innerHTML = originalText;
                                btn.disabled = false;
                                return;
                            }

                            // OTP e-mailed (or a resend is still cooling down) — open the 2FA screen
                            const pendingState = { uid: user.uid, role: userData.role, email: userData.email || email };
                            writePending2FA(pendingState);

                            // Reset login form fields before switching screens
                            const emailInput = document.getElementById('email');
                            const passInput = document.getElementById('password');
                            if (emailInput) emailInput.value = '';
                            if (passInput) passInput.value = '';
                            if (loginForm) loginForm.reset();

                            open2FAScreen(pendingState);
                            if (startRes.status === 429) {
                                scNotify('warning', startData.message || 'A code was just sent. Please wait before requesting another.', 'Code Already Sent');
                            }
                            btn.innerHTML = originalText;
                            btn.disabled = false;
                            return; // Stay here until the OTP is verified
                        } catch (err) {
                            console.error('2FA start error:', err);
                            await auth.signOut();
                            localStorage.removeItem('userRole');
                            const rawStartMsg = String((err && err.message) || '') + ' ' + String(err.code || '');
                            const startTimedOut = /timed out after|AbortError|aborted/i.test(rawStartMsg);
                            scNotify('error', startTimedOut
                                ? 'The security-code email timed out. If the code e-mail already arrived, sign in again to enter it. Otherwise check your connection (and that /api/email-status shows Ready), then try again. (' + (err.message || err.code || 'timeout') + ')'
                                : 'Failed to start two-factor authentication. Please try again.', '2FA Required');
                            btn.innerHTML = originalText;
                            btn.disabled = false;
                            return;
                        }
                    }

                    // Seniors: simplified login (no 2FA, per panel requirement)
                    // Reset login form fields before redirecting
                    const emailInput = document.getElementById('email');
                    const passInput = document.getElementById('password');
                    if (emailInput) emailInput.value = '';
                    if (passInput) passInput.value = '';
                    if (loginForm) loginForm.reset();

                    // Redirect based on role
                    if (userData.role === 'admin') window.location.href = '/admin';
                    else if (userData.role === 'employee') window.location.href = '/employee';
                    else window.location.href = '/senior';
                } else {
                    scNotify('error', 'Your user profile was not found in the database. Please contact an administrator.', 'Profile Not Found');
                    await auth.signOut();
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                }

            } catch (error) {
                console.error("Login error:", error);
                let friendlyMessage = 'An unexpected error occurred. Please try again. (' + (error.code || error.message || 'Unknown error') + ')';
                const rawMsg = String((error && error.message) || '') + ' ' + String(error.code || '');
                if (/timed out after|AbortError|aborted/i.test(rawMsg)) {
                    friendlyMessage = 'The request timed out (network or database is slow/blocked). Check your connection, disable ad-blocker/Brave Shields for this site, then try again. (' + (error.message || error.code || 'timeout') + ')';
                } else if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-login-credentials') {
                    friendlyMessage = 'Invalid email or password. Please check your credentials and try again.';
                } else if (error.code === 'auth/user-not-found') {
                    friendlyMessage = 'No account found with this email. Please sign up first.';
                } else if (error.code === 'auth/too-many-requests') {
                    friendlyMessage = 'Too many failed login attempts. Please wait a few minutes before trying again.';
                } else if (error.code === 'auth/network-request-failed') {
                    friendlyMessage = 'Network error. Please check your internet connection.';
                }

                scNotify('error', friendlyMessage, 'Login Failed');
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        });
    }

    // --- 2FA OTP input behavior: auto-advance, backspace, paste, enter ---
    const otpForm = document.getElementById('otpForm');
    const otpGroup = document.querySelector('.otp-group');
    const otpInputs = Array.from(document.querySelectorAll('.otp-input'));

    // Clicking anywhere in the pill focuses the first EMPTY slot so digits
    // never land mid-string — keeps the code perfectly centered as a group.
    if (otpGroup) {
        otpGroup.addEventListener('click', (e) => {
            if (e.target.classList && e.target.classList.contains('otp-input')) return;
            const firstEmpty = otpInputs.find(i => !i.value) || otpInputs[otpInputs.length - 1];
            if (firstEmpty) firstEmpty.focus();
        });
    }

    otpInputs.forEach((input, index) => {
        input.addEventListener('input', () => {
            input.value = input.value.replace(/\D/g, '').slice(-1);
            if (input.value && index < otpInputs.length - 1) otpInputs[index + 1].focus();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !input.value && index > 0) otpInputs[index - 1].focus();
            if (e.key === 'Enter' && otpForm) otpForm.requestSubmit();
        });
        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, otpInputs.length);
            digits.split('').forEach((d, i) => { otpInputs[i].value = d; });
            otpInputs[Math.min(digits.length, otpInputs.length - 1)].focus();
        });
    });

    // --- 2FA: Verify & Login ---
    if (otpForm) {
        otpForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const verifyBtn = document.getElementById('verifyOtpBtn');
            const code = otpInputs.map(i => i.value).join('');
            if (!/^\d{6}$/.test(code)) {
                scNotify('warning', 'Enter the complete 6-digit code sent to your email.', 'Incomplete Code');
                return;
            }
            const originalText = verifyBtn.innerHTML;
            verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
            verifyBtn.disabled = true;
            try {
                const token = await withTimeout(auth.currentUser.getIdToken(), 20000, 'Session token');
                const res = await fetchWithTimeout('/api/2fa/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ code })
                }, 30000);
                const data = await res.json().catch(() => ({}));
                if (data.success) {
                    // OTP accepted — unlock the dashboard for this tab
                    const pending = readPending2FA();
                    const uid = pending ? pending.uid : (auth.currentUser ? auth.currentUser.uid : '');
                    sessionStorage.setItem(VERIFIED_KEY, uid);
                    clearPending2FA();
                    const role = (pending && pending.role) || localStorage.getItem('userRole');
                    if (role === 'admin') window.location.href = '/admin';
                    else if (role === 'employee') window.location.href = '/employee';
                    else window.location.href = '/';
                } else {
                    scNotify('error', data.message || 'Invalid security code.', 'Verification Failed');
                    resetOtpInputs();
                    verifyBtn.innerHTML = originalText;
                    verifyBtn.disabled = false;
                }
            } catch (err) {
                console.error('2FA verify error:', err);
                const rawVerifyMsg = String((err && err.message) || '') + ' ' + String(err.code || '');
                const verifyTimedOut = /timed out after|AbortError|aborted/i.test(rawVerifyMsg);
                scNotify('error', verifyTimedOut
                    ? 'Verification timed out. Check your connection, then re-enter the code or resend it. (' + (err.message || err.code || 'timeout') + ')'
                    : 'Verification failed. Please try again.', 'Verification Failed');
                verifyBtn.innerHTML = originalText;
                verifyBtn.disabled = false;
            }
        });
    }

    // --- 2FA: Resend code (server enforces a 30s cooldown) ---
    const resendLink = document.getElementById('resendOtpLink');
    if (resendLink) {
        resendLink.addEventListener('click', async (e) => {
            e.preventDefault();
            const pending = readPending2FA();
            const currentUser = auth.currentUser;
            if (!pending || !currentUser) return;
            try {
                const token = await withTimeout(currentUser.getIdToken(), 20000, 'Session token');
                const res = await fetchWithTimeout('/api/2fa/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
                }, 45000);
                const data = await res.json().catch(() => ({}));
                if (data.success) {
                    scNotify('success', data.message || 'A new security code was sent to your email.', 'Code Sent');
                    startResendCooldown();
                    resetOtpInputs();
                } else {
                    scNotify('warning', data.message || 'Please wait before requesting a new code.', 'Please Wait');
                    startResendCooldown();
                }
            } catch (err) {
                console.error('2FA resend error:', err);
                scNotify('error', 'Failed to resend the code. Please try again.', 'Error');
            }
        });
    }

    // --- 2FA: Back to role selection (aborts the challenge) ---
    const otpBackBtn = document.getElementById('otpBackBtn');
    if (otpBackBtn) {
        otpBackBtn.addEventListener('click', async () => {
            clearPending2FA();
            try { await auth.signOut(); } catch (err) { console.error(err); }
            showScreen('roles');
        });
    }

    // --- Forgot Password (Admin accounts): request a reset link ---
    const forgotPwLink = document.getElementById('forgotPwLink');
    const forgotPwForm = document.getElementById('forgotPwForm');
    const forgotPwBackBtn = document.getElementById('forgotPwBackBtn');

    if (forgotPwLink) {
        forgotPwLink.addEventListener('click', (e) => {
            e.preventDefault();
            const loginEmail = document.getElementById('email');
            const forgotEmail = document.getElementById('forgotPwEmail');
            if (loginEmail && forgotEmail && loginEmail.value) forgotEmail.value = loginEmail.value.trim();
            showScreen('forgot');
        });
    }

    if (forgotPwBackBtn) {
        forgotPwBackBtn.addEventListener('click', () => showScreen('roles'));
    }

    if (forgotPwForm) {
        forgotPwForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('forgotPwEmail').value.trim();
            const sendBtn = document.getElementById('sendResetBtn');
            const originalText = sendBtn.innerHTML;
            sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
            sendBtn.disabled = true;
            try {
                const res = await fetch('/api/forgot-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                const data = await res.json().catch(() => ({}));
                if (data.success) {
                    scNotify('success', data.message, 'Check Your Email');
                    showScreen('roles');
                } else {
                    scNotify('warning', data.message || 'Please try again.', 'Reset Link');
                }
            } catch (err) {
                console.error('Forgot password error:', err);
                scNotify('error', 'Failed to send the reset link. Please try again.', 'Error');
            } finally {
                sendBtn.innerHTML = originalText;
                sendBtn.disabled = false;
            }
        });
    }

    // Handle logout
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                sessionStorage.removeItem(VERIFIED_KEY);
                clearPending2FA();
                await auth.signOut();
                localStorage.removeItem('userRole');
                window.location.replace('/');
            } catch (err) {
                scNotify('error', 'Failed to log out. Please try again.', 'Logout Error');
            }
        });
    }
});
