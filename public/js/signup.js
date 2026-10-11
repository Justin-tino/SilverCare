import { auth, db } from './firebase-init.js';
import { createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-auth.js";
import { ref, set } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-database.js";

document.addEventListener('DOMContentLoaded', () => {

    // --- Custom Modal Helpers (no more alert()) ---
    function showWarning(message) {
        document.getElementById('warningMessage').textContent = message;
        document.getElementById('warningModal').style.display = 'flex';
    }

    function showError(message) {
        document.getElementById('errorMessage').textContent = message;
        document.getElementById('errorModal').style.display = 'flex';
    }

    // Close modal buttons
    const closeErrorModal = document.getElementById('closeErrorModal');
    if (closeErrorModal) {
        closeErrorModal.addEventListener('click', () => {
            document.getElementById('errorModal').style.display = 'none';
        });
    }

    const closeWarningModal = document.getElementById('closeWarningModal');
    if (closeWarningModal) {
        closeWarningModal.addEventListener('click', () => {
            document.getElementById('warningModal').style.display = 'none';
        });
    }

    // --- Store form data temporarily (create account AFTER OTP, not before) ---
    let pendingSignup = null;

    // ── Duplicate Senior ID helpers (signup form) ──
    // Returns true (taken), false (free), or null (check failed → caller blocks).
    async function isSeniorIdTakenPublic(seniorId) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            let res;
            try {
                res = await fetch('/api/check-senior-id-public', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ seniorId }),
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timer);
            }
            const data = await res.json();
            if (data && data.success) return !!data.taken;
            return null;
        } catch (err) {
            console.warn('Senior ID check failed:', err);
            return null;
        }
    }
    function showSeniorIdTaken(inputId, errId, message) {
        const err = document.getElementById(errId);
        if (err) { err.textContent = message; err.style.display = 'block'; }
        const field = document.getElementById(inputId);
        if (field) { field.style.borderColor = '#dc2626'; field.style.boxShadow = '0 0 0 3px rgba(220, 38, 38, 0.1)'; field.focus(); }
    }
    function clearSeniorIdTaken(inputId, errId) {
        const err = document.getElementById(errId);
        if (err) err.style.display = 'none';
        const field = document.getElementById(inputId);
        if (field) { field.style.borderColor = ''; field.style.boxShadow = ''; }
    }

    // Live re-check when the senior edits the ID again (typing clears the warning).
    const signupSeniorIdField = document.getElementById('seniorId');
    if (signupSeniorIdField) {
        let blurCheck = null;
        const liveCheck = async () => {
            const v = signupSeniorIdField.value.trim();
            if (!v) { clearSeniorIdTaken('seniorId', 'seniorIdTakenError'); return; }
            blurCheck = await isSeniorIdTakenPublic(v);
            if (blurCheck === true) {
                showSeniorIdTaken('seniorId', 'seniorIdTakenError',
                    'This Senior ID number is already in use. Please check the number on your ID card.');
            } else if (blurCheck === false) {
                clearSeniorIdTaken('seniorId', 'seniorIdTakenError');
            }
        };
        signupSeniorIdField.addEventListener('input', () => clearSeniorIdTaken('seniorId', 'seniorIdTakenError'));
        signupSeniorIdField.addEventListener('change', liveCheck);
        signupSeniorIdField.addEventListener('blur', liveCheck);
    }

    // --- Signup Form Submission ---
    const signupForm = document.getElementById('signupForm');
    if (signupForm) {
        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const role = document.getElementById('signupRole').value;
            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            const fullname = document.getElementById('fullname').value.trim();
            const btn = signupForm.querySelector('.btn-primary');
            
            // Validate password match
            if (password !== confirmPassword) {
                showWarning("Passwords do not match! Please make sure both passwords are the same.");
                return;
            }

            // Validate password length
            if (password.length < 6) {
                showWarning("Password must be at least 6 characters long.");
                return;
            }

            // Senior Validation
            let seniorId = null;
            if (role === 'senior') {
                seniorId = document.getElementById('seniorId').value.trim();
                if (!seniorId) {
                    showWarning("Please enter your Senior Citizen ID Number.");
                    return;
                }
            }

            // ── Duplicate Senior ID check (BLOCKING) ──
            // Public endpoint (not signed in yet). Boolean-only answer — never
            // names the existing account. If the check cannot be completed we
            // BLOCK rather than letting a duplicate through.
            if (role === 'senior') {
                const taken = await isSeniorIdTakenPublic(seniorId);
                if (taken) {
                    showSeniorIdTaken('seniorId', 'seniorIdTakenError',
                        'This Senior ID number is already in use. Please check the number on your ID card, or visit the OSCA Magalang office for help.');
                    return;
                }
                if (taken === null) {
                    showError('We could not verify your Senior ID right now. Please try again in a moment.');
                    return;
                }
            }

            // Store form data — DO NOT create account yet
            pendingSignup = {
                role: role,
                email: email,
                password: password,
                fullname: fullname,
                seniorId: seniorId
            };

            // Disable button while sending OTP
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending Code...';
            btn.disabled = true;

            try {
                // Check if email already has a pending registration — if so, reset it
                // (30s client timeout so a hung request restores the button + shows an error)
                const resetController = new AbortController();
                const resetTimer = setTimeout(() => resetController.abort(), 30000);
                let resetRes;
                try {
                    resetRes = await fetch('/api/reset-pending-email', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email }),
                        signal: resetController.signal
                    });
                } finally {
                    clearTimeout(resetTimer);
                }
                const resetData = await resetRes.json();
                if (!resetData.success) {
                    showError(resetData.message);
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                    return;
                }

                // Call backend to send real OTP email
                // (60s client timeout — server fails at 25s, but never hang forever)
                const otpController = new AbortController();
                const otpTimer = setTimeout(() => otpController.abort(), 60000);
                let response;
                try {
                    response = await fetch('/api/send-otp', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: email }),
                        signal: otpController.signal
                    });
                } finally {
                    clearTimeout(otpTimer);
                }

                const data = await response.json();

                if (data.success) {
                    // Show user email in OTP modal
                    document.getElementById('otpEmailDisplay').textContent = email;

                    // Clear any previous OTP inputs
                    document.querySelectorAll('.otp-input').forEach(input => input.value = '');

                    // Show OTP modal
                    document.getElementById('otpModal').style.display = 'flex';

                    // Focus first OTP input
                    const firstInput = document.querySelector('.otp-input');
                    if (firstInput) firstInput.focus();
                } else {
                    showError(data.message || 'Failed to send verification code.');
                }
            } catch (error) {
                console.error('OTP error:', error);
                // AbortError = our client-side timeout fired (request hung)
                showError((error && error.name === 'AbortError') ? 'The request timed out. Please check your connection and try again.' : 'Could not send verification code. Please check your connection and try again.');
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        });
    }

    // --- OTP Verification & Account Creation ---
    const verifyOtpBtn = document.getElementById('verifyOtpBtn');
    const successModal = document.getElementById('successModal');

    if (verifyOtpBtn) {
        verifyOtpBtn.addEventListener('click', async () => {
            const inputs = document.querySelectorAll('.otp-input');
            let pin = '';
            inputs.forEach(input => pin += input.value);
            
            if (pin.length !== 6) {
                showWarning("Please enter a valid 6-digit PIN.");
                return;
            }

            if (!pendingSignup) {
                showError("Session expired. Please fill out the form again.");
                document.getElementById('otpModal').style.display = 'none';
                return;
            }

            const originalText = verifyOtpBtn.innerHTML;
            verifyOtpBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
            verifyOtpBtn.disabled = true;

            try {
                // 1. Verify OTP with backend first
                const otpResponse = await fetch('/api/verify-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: pendingSignup.email, pin: pin })
                });

                const otpData = await otpResponse.json();

                if (!otpData.success) {
                    verifyOtpBtn.innerHTML = originalText;
                    verifyOtpBtn.disabled = false;
                    showWarning(otpData.message || 'Invalid verification code.');
                    return;
                }

                // 2. OTP verified! Now create Firebase account
                const userCredential = await createUserWithEmailAndPassword(
                    auth, 
                    pendingSignup.email, 
                    pendingSignup.password
                );
                const user = userCredential.user;

                // 3. Save to Realtime Database with PENDING status
                const userData = {
                    email: pendingSignup.email,
                    name: pendingSignup.fullname,
                    role: pendingSignup.role,
                    status: 'Pending',
                    emailVerified: true,
                    createdAt: Date.now()
                };

                if (pendingSignup.role === 'senior') {
                    userData.seniorId = pendingSignup.seniorId;
                }

                await set(ref(db, 'users/' + user.uid), userData);

                // 4. Force Sign Out (since they need admin approval)
                await signOut(auth);

                // 5. Clear pending data
                pendingSignup = null;

                // 6. Hide OTP, Show Success
                document.getElementById('otpModal').style.display = 'none';
                successModal.style.display = 'flex';

            } catch (error) {
                verifyOtpBtn.innerHTML = originalText;
                verifyOtpBtn.disabled = false;

                // Handle specific Firebase errors with friendly messages
                let friendlyMessage = "Something went wrong. Please try again.";
                
                if (error.code === 'auth/email-already-in-use') {
                    friendlyMessage = "This email address is already registered. Please use a different email or go back to the login page.";
                } else if (error.code === 'auth/weak-password') {
                    friendlyMessage = "Password is too weak. Please use at least 6 characters.";
                } else if (error.code === 'auth/invalid-email') {
                    friendlyMessage = "The email address is not valid. Please check and try again.";
                } else if (error.code === 'auth/network-request-failed') {
                    friendlyMessage = "Network error. Please check your internet connection and try again.";
                }

                document.getElementById('otpModal').style.display = 'none';
                showError(friendlyMessage);
            }
        });
        
        // Auto-advance OTP inputs
        const inputs = document.querySelectorAll('.otp-input');
        inputs.forEach((input, index) => {
            input.addEventListener('input', () => {
                // Only allow numbers
                input.value = input.value.replace(/[^0-9]/g, '');
                if (input.value.length === 1 && index < inputs.length - 1) {
                    inputs[index + 1].focus();
                }
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && input.value === '' && index > 0) {
                    inputs[index - 1].focus();
                }
            });
            // Handle paste (paste full 6-digit code)
            input.addEventListener('paste', (e) => {
                e.preventDefault();
                const pastedData = e.clipboardData.getData('text').replace(/[^0-9]/g, '');
                if (pastedData.length === 6) {
                    inputs.forEach((inp, i) => {
                        inp.value = pastedData[i] || '';
                    });
                    inputs[5].focus();
                }
            });
        });
    }
});
