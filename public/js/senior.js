import { auth, db } from './firebase-init.js';
import { ref, get, set, push, update, remove, onValue, query, orderByChild, equalTo } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-database.js";

document.addEventListener('DOMContentLoaded', () => {
    // If not on the senior page, abort
    if (window.location.pathname !== '/senior') return;

    let currentUserData = null;
    let activeServiceType = '';

    function getRelativeTime(timestamp) {
        if (!timestamp) return 'Just now';
        const now = Date.now();
        const diff = now - timestamp;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        const weeks = Math.floor(days / 7);
        const months = Math.floor(days / 30);

        if (seconds < 60) return 'Just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        if (weeks < 4) return `${weeks}w ago`;
        return `${months}mo ago`;
    }

    function isValidPhone(val) {
        const cleaned = val.replace(/[\s\-\(\)]/g, '');
        return cleaned.length >= 10 && /^\+?\d+$/.test(cleaned);
    }

    // ── Fixed service area: Magalang, Pampanga only ──
    // Province and City/Municipality are locked; Barangay must be one of these 27.
    const FIXED_PROVINCE = 'Pampanga';
    const FIXED_CITY = 'Magalang';
    const FIXED_ZIP = '2011';
    const MAGALANG_BARANGAYS = ['AYALA','BUCANAN','CAMIAS','DOLORES','ESCALER','LAPAZ','NAVALING','SAN AGUSTIN','SAN ANTONIO','SAN FRANCISCO','SAN ILDEFONSO','SAN ISIDRO','SAN JOSE','SAN MIGUEL','SAN NICOLAS 1','SAN NICOLAS 2','SAN PABLO','SAN PEDRO 1','SAN PEDRO 2','SAN ROQUE','SAN VICENTE','STA. CRUZ','STA. LUCIA','STA. MARIA','STO. NIÑO','STO. ROSARIO','TURU'];

    // ── Annex A (A.6/A.7) address lock: Magalang, Pampanga 2011 only ──
    // Barangay mirrors the Step-1 verification selection; all four stay read-only.
    function getStep1Barangay() {
        const v = (document.getElementById('kycBarangay')?.value || '').trim();
        if (v && MAGALANG_BARANGAYS.includes(v)) return v;
        const stored = ((currentUserData && currentUserData.barangay) || '').trim();
        const hit = MAGALANG_BARANGAYS.find(b => b.toUpperCase() === stored.toUpperCase());
        return hit || stored;
    }
    function lockAnnexAAddressFields(root, barangay) {
        if (!root) return;
        const b = (barangay || '').trim();
        root.querySelectorAll('#resBarangay, #permBarangay').forEach(el => { if (b) el.value = b; el.setAttribute('readonly', ''); el.tabIndex = -1; });
        root.querySelectorAll('#resCityMunicipality, #permCityMunicipality').forEach(el => { el.value = FIXED_CITY; el.setAttribute('readonly', ''); el.tabIndex = -1; });
        root.querySelectorAll('#resProvince, #permProvince').forEach(el => { el.value = FIXED_PROVINCE; el.setAttribute('readonly', ''); el.tabIndex = -1; });
        root.querySelectorAll('#resZipCode, #permZipCode').forEach(el => { el.value = FIXED_ZIP; el.setAttribute('readonly', ''); el.tabIndex = -1; });
    }

    // ── Annex A personal-info sync: fill only EMPTY fields from Step 1 ──
    // (already-typed Annex A edits are never overwritten).
    function syncMilestonePersonalInfo(root) {
        if (!root) return;
        const get = (id) => (document.getElementById(id)?.value || '').trim();
        const fill = (sel, val) => { const el = root.querySelector(sel); if (el && !(el.value || '').trim() && val) el.value = val; };
        fill('#lastName', get('kycLastName'));
        fill('#givenName', get('kycFirstName'));
        fill('#middleName', get('kycMiddleName'));
        fill('#dateOfBirth', get('kycDob'));
        fill('#contactNums', get('kycCpNumber'));
    }
    // Copies House No. + Street (+ locked fields) into the permanent address
    // so the senior does not have to type the same address twice.
    function syncSameAsResidential(root) {
        if (!root) return;
        const chk = root.querySelector('.sameAsResidentialChk');
        if (!chk || !chk.checked) return;
        const pairs = [['#resHouseNum', '#permHouseNum'], ['#resStreet', '#permStreet'], ['#resBarangay', '#permBarangay'], ['#resCityMunicipality', '#permCityMunicipality'], ['#resProvince', '#permProvince'], ['#resZipCode', '#permZipCode']];
        pairs.forEach(([from, to]) => {
            const src = root.querySelector(from);
            const dst = root.querySelector(to);
            if (src && dst) dst.value = src.value;
        });
    }
    function wireSameAsResidential(root) {
        if (!root) return;
        const chk = root.querySelector('.sameAsResidentialChk');
        if (!chk || chk.dataset.wired) return;
        chk.dataset.wired = '1';
        const setPermEditable = (locked) => {
            ['#permHouseNum', '#permStreet'].forEach(sel => {
                const el = root.querySelector(sel);
                if (!el) return;
                if (locked) { el.setAttribute('readonly', ''); el.tabIndex = -1; el.style.background = '#e2e8f0'; el.style.color = '#64748b'; el.style.cursor = 'not-allowed'; }
                else { el.removeAttribute('readonly'); el.tabIndex = 0; el.style.background = ''; el.style.color = ''; el.style.cursor = ''; }
            });
        };
        chk.addEventListener('change', () => {
            if (chk.checked) { syncSameAsResidential(root); setPermEditable(true); }
            else setPermEditable(false);
        });
        // Live mirror while the box stays checked
        ['#resHouseNum', '#resStreet'].forEach(sel => {
            const el = root.querySelector(sel);
            if (el) el.addEventListener('input', () => { if (chk.checked) syncSameAsResidential(root); });
        });
    }

    // --- Tab Switching Logic ---
    const navPills = document.querySelectorAll('.nav-pill');
    const tabPanels = document.querySelectorAll('.tab-panel');

    function switchTab(tabId) {
        // Hide all panels
        tabPanels.forEach(panel => panel.classList.remove('active'));
        // Remove active class from pills
        navPills.forEach(pill => pill.classList.remove('active'));

        // Show target panel
        const targetPanel = document.getElementById(`panel-${tabId}`);
        if (targetPanel) {
            targetPanel.classList.add('active');
        }

        // Highlight target pill (if it exists)
        const targetPill = document.querySelector(`.nav-pill[data-tab="${tabId}"]`);
        if (targetPill) {
            targetPill.classList.add('active');
        }

        // Hide notification badge when notifications tab is viewed
        if (tabId === 'notifications') {
            const notifBadge = document.getElementById('notifBadge');
            if (notifBadge) notifBadge.style.display = 'none';
            localStorage.setItem('lastNotifView_' + (currentUserData ? currentUserData.uid : 'guest'), Date.now());
        }
    }
    // Expose switchTab globally for inline onclick handlers
    window.switchTab = switchTab;

    navPills.forEach(pill => {
        pill.addEventListener('click', () => {
            const tabId = pill.getAttribute('data-tab');
            switchTab(tabId);
        });
    });

    // --- Sidebar Link Clicking -> Opens Soft-Filling Form ---
    const sidebarLinks = document.querySelectorAll('.sidebar-link');
    sidebarLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();

            // ── ACCESS GUARD: Block unverified seniors ──
            if (!isServiceAccessAllowed()) {
                showToast('⚠️ You must get verified first before applying for services.');
                // Flash the Get Verified nav pill
                const verifyPill = document.getElementById('navPillVerification');
                if (verifyPill) {
                    verifyPill.style.animation = 'none';
                    void verifyPill.offsetWidth; // trigger reflow
                    verifyPill.style.animation = 'pulse-glow 0.6s ease 3';
                }
                return;
            }

            // Remove active classes
            sidebarLinks.forEach(l => l.classList.remove('active'));
            // Highlight clicked
            link.classList.add('active');

            const service = link.getAttribute('data-service');
            activeServiceType = service;
            openServiceForm(service);
        });
    });

    // ── SERVICE ACCESS GATE (KYC) ──────────────────────────────────────────
    // Seniors may only request services (left sidebar) once their account
    // is fully Verified. 'Pending', 'Not Verified', 'Rejected' or missing
    // KYC status = no access.
    function isServiceAccessAllowed() {
        return !!(currentUserData && currentUserData.kycStatus === 'Verified');
    }

    // Visually locks/unlocks the sidebar service links in real time and
    // pulls the senior out of the service form if access was revoked.
    function updateServiceAccess() {
        const allowed = isServiceAccessAllowed();
        document.querySelectorAll('.sidebar-link').forEach(link => {
            if (allowed) {
                link.classList.remove('locked');
                link.removeAttribute('title');
            } else {
                link.classList.add('locked');
                link.title = 'Get Verified to access this service';
            }
        });

        // If verification was revoked/lost while the service form is open,
        // bounce the senior back to the dashboard.
        const activePanel = document.querySelector('.tab-panel.active');
        if (!allowed && activePanel && activePanel.id === 'panel-service-form') {
            sidebarLinks.forEach(l => l.classList.remove('active'));
            switchTab('dashboard');
        }
    }

    // Back to Dashboard Link
    const formBackBtn = document.getElementById('formBackBtn');
    if (formBackBtn) {
        formBackBtn.addEventListener('click', (e) => {
            e.preventDefault();
            sidebarLinks.forEach(l => l.classList.remove('active'));
            switchTab('dashboard');
        });
    }



    // --- Auth State Observer ---
    auth.onAuthStateChanged(async (user) => {
        if (!user) {
            window.location.replace('/');
            return;
        }

        // Real-time listener for current logged-in user details
        onValue(ref(db, 'users/' + user.uid), (snapshot) => {
            if (snapshot.exists()) {
                currentUserData = snapshot.val();
                currentUserData.uid = user.uid;
                // Deceased gate (Archive Function): OSCA staff marked this account
                // as deceased — it is archived, stops receiving pension/benefits,
                // and must not keep a live session open. The person is sent back
                // to the login page with the OSCA message.
                if (String(currentUserData.lifeStatus || '') === 'Deceased'
                    || String(currentUserData.status || '') === 'Deceased') {
                    if (!window.__scDeceasedKickout) {
                        window.__scDeceasedKickout = true;
                        const deceaseNotice = {
                            type: 'error',
                            title: 'Account Deceased',
                            message: 'This senior have passed away, please go to OSCA if you think this is an error'
                        };
                        try { sessionStorage.setItem('sc_login_notice', JSON.stringify(deceaseNotice)); } catch (e) {}
                        try { if (typeof scNotify === 'function') scNotify('error', deceaseNotice.message, deceaseNotice.title); } catch (e) {}
                        auth.signOut().then(() => window.location.replace('/')).catch(() => window.location.replace('/'));
                    }
                    return;
                }
                populatePortalData(currentUserData);
                populateProfileInputs(currentUserData);
                renderBenefitsAndNotifications(currentUserData);
                renderKycVerificationStatus(currentUserData);
                // Update Health + Medical Certification card (verified accounts only)
                renderHealthUpdateCard(currentUserData);
                // Lock/unlock the sidebar services based on KYC status
                // (real-time: unlocks the moment staff approves verification)
                updateServiceAccess();
                // Re-fetch the senior's own assistance requests (updates the
                // dashboard Request Assistance card when staff acts on them)
                loadMyServiceRequests();
                // Medication reminders listener (panel-requested daily alarms)
                if (typeof window.scListenToMedReminders === 'function') window.scListenToMedReminders();
            } else {
                // If profile not found, populate with Auth details
                currentUserData = {
                    name: user.displayName || 'Senior Citizen',
                    email: user.email,
                    seniorId: 'OSCA-PENDING',
                    status: 'Active'
                };
                populatePortalData(currentUserData);
                populateProfileInputs(currentUserData);
                // No profile / no KYC record -> services stay locked
                updateServiceAccess();
            }
        });

        // Online Appointment queue loader (thesis: Appointment Scheduling & Queuing)
        loadMyAppointments(user.uid);

        // Medication reminders (panel-requested daily alarms) — the
        // functions are declared below; the interval is registered once.
        if (!window.__scMedReminderTimer) {
            window.__scMedReminderTimer = setInterval(() => {
                try { if (typeof window.scCheckMedReminderDue === 'function') window.scCheckMedReminderDue(); } catch (e) { /* silent tick */ }
            }, 30 * 1000);
        }

    });

    // Auto-refresh loops:
    //   1) Re-render date-sensitive dashboard blocks the moment the calendar
    //      day changes, so the monthly pension release window rolls over on
    //      the 1st of the month / account-approval anniversary without reload.
    //   2) Periodically re-fetch the senior's assistance requests so the
    //      dashboard card reflects staff status updates without a reload.
    let lastRenderedDay = new Date().toDateString();
    let minuteTick = 0;
    setInterval(() => {
        minuteTick++;
        const nowDay = new Date().toDateString();
        if (nowDay !== lastRenderedDay) {
            lastRenderedDay = nowDay;
            if (currentUserData) {
                populatePortalData(currentUserData);
                renderBenefitsAndNotifications(currentUserData);
            }
        }
        if (minuteTick % 5 === 0 && currentUserData) {
            loadMyServiceRequests();
        }
    }, 60 * 1000);

    // Mobile Sidebar Toggle
    const mobileMenuToggle = document.getElementById('mobileMenuToggle');
    const sidebar = document.querySelector('.sidebar');
    const sidebarOverlay = document.getElementById('mobileSidebarOverlay');

    window.toggleMobileSidebar = function () {
        const isOpen = sidebar && sidebar.classList.contains('open');
        if (sidebar) sidebar.classList.toggle('open');
        if (sidebarOverlay) sidebarOverlay.classList.toggle('visible');
        if (mobileMenuToggle) {
            mobileMenuToggle.innerHTML = isOpen ? '<i class="fas fa-bars"></i>' : '<i class="fas fa-times"></i>';
        }
    };

    if (mobileMenuToggle) {
        mobileMenuToggle.addEventListener('click', toggleMobileSidebar);
    }
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', toggleMobileSidebar);
    }

    // Auto-close sidebar on link click (mobile)
    document.querySelectorAll('.sidebar-link, .side-nav-link').forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth <= 900) {
                if (sidebar) sidebar.classList.remove('open');
                if (sidebarOverlay) sidebarOverlay.classList.remove('visible');
                if (mobileMenuToggle) mobileMenuToggle.innerHTML = '<i class="fas fa-bars"></i>';
            }
        });
    });

    // Logout Action
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try {
                await auth.signOut();
                localStorage.removeItem('userRole');
                window.location.replace('/');
            } catch (err) {
                console.error("Logout error:", err);
            }
        });
    }

    // — Dual pension helpers: Local (monthly) + National (quarterly) —
    // Local ₱1,000/mo default, National ₱3,000/qtr default.
    // Quarterly total = Local×3 + National = ₱6,000 (sum for the quarter).
    function seniorLocalPension(userData) {
        if (!userData) return 0;
        if (Number(userData.pensionLocalAmount) > 0) return Number(userData.pensionLocalAmount);
        if (Number(userData.pensionAmount) > 0) return Number(userData.pensionAmount);
        return 0;
    }
    function seniorNationalPension(userData) {
        if (!userData) return 0;
        if (Number(userData.pensionNationalAmount) > 0) return Number(userData.pensionNationalAmount);
        return 0;
    }
    function seniorQuarterlyTotal(userData) {
        return seniorLocalPension(userData) * 3 + seniorNationalPension(userData);
    }
    function checkIsPensionApproved(userData) {
        if (!userData) return false;
        const currentMonth = new Date().toISOString().substring(0, 7);
        if (userData.lastPensionMonth === currentMonth) {
            if (userData.lastPensionStatus === 'Approved') return true;
            if (userData.lastPensionStatus === 'Declined') return false;
            if (userData.benefits) {
                return Object.values(userData.benefits).some(b => 
                    (b.title && b.title.includes('Pension')) || (b.refNumber && b.refNumber.startsWith('PEN'))
                );
            }
            return true;
        }
        return false;
    }

    // --- Populate Dashboard Greeting & Stats ---
    function populatePortalData(data) {
        document.getElementById('portalGreeting').textContent = `Welcome, ${data.name}!`;
        const portalAvatar = document.getElementById('portalAvatar');
        if (portalAvatar) portalAvatar.textContent = (data.name || 'S').trim().charAt(0).toUpperCase();

        const dashAccountStatus = document.getElementById('dashAccountStatus');
        if (dashAccountStatus) {
            const kycStatus = data.kycStatus || 'Not Verified';
            if (kycStatus === 'Verified') {
                dashAccountStatus.textContent = 'Verified ✓';
                dashAccountStatus.style.color = '#22c55e';
            } else if (kycStatus === 'Pending') {
                dashAccountStatus.textContent = 'Pending Review';
                dashAccountStatus.style.color = '#f59e0b';
            } else {
                dashAccountStatus.textContent = 'Not Verified';
                dashAccountStatus.style.color = '#ef4444';
            }
        }

        // Senior Category (Octogenarian / Nonagenarian / Centenarian) — shown once verified
        const dashSeniorCategory = document.getElementById('dashSeniorCategory');
        if (dashSeniorCategory) {
            const kycStatusForCategory = data.kycStatus || 'Not Verified';
            const seniorCategory = data.seniorCategory || getKycMilestoneCategory(getSeniorDataAge(data));
            if (kycStatusForCategory === 'Verified' && seniorCategory) {
                dashSeniorCategory.textContent = seniorCategory;
                dashSeniorCategory.style.color = '#16a34a';
                // Persist the derived category on the account the first time it is computed
                if (data.seniorCategory !== seniorCategory) {
                    data.seniorCategory = seniorCategory;
                    update(ref(db, 'users/' + data.uid), { seniorCategory: seniorCategory, seniorCategoryAssignedAt: Date.now() });
                }
            } else {
                // Verified but no milestone category (age isn't 80/85/90/95/100)
                const verifiedNoCategory = kycStatusForCategory === 'Verified';
                dashSeniorCategory.textContent = verifiedNoCategory ? 'Verified Senior' : 'Not Verified';
                dashSeniorCategory.style.color = verifiedNoCategory ? '#16a34a' : '#94a3b8';
            }
        }

        const dashSeniorId = document.getElementById('dashSeniorId');
        if (dashSeniorId) dashSeniorId.textContent = data.seniorId || 'OSCA-PENDING';

        // --- Priority Level — milestone-based (per OSCA reference) ---
        // Age 80-89  = Low  (Octogenarian)
        // Age 90-99  = Medium (Nonagenarian)
        // Age >=100  = High (Centenarian)
        // Age <80    = Low (standard senior)
        function calculatePriorityLevel(userData) {
            if (!userData) return 'Low';
            // Health override: any reported illness → High priority regardless of age
            const cond = String(userData.healthCondition || userData.condition || userData.illness || '').trim();
            const hasIllness = cond && !/^none$/i.test(cond) && !/^none reported$/i.test(cond) && !/^no illness/i.test(cond) && !/^healthy/i.test(cond);
            if (hasIllness) return 'High';
            let age = Number(userData.age) || 0;
            if (!age && userData.dob) {
                const birthDate = new Date(userData.dob);
                if (!isNaN(birthDate.getTime())) {
                    const today = new Date();
                    age = today.getFullYear() - birthDate.getFullYear();
                    const m = today.getMonth() - birthDate.getMonth();
                    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
                        age--;
                    }
                }
            }
            if (age >= 100) return 'High';
            if (age >= 90) return 'Medium';
            if (age >= 80) return 'Low';
            // 60-79 and below: still Low per reference (only 90+ escalates)
            return 'Low';
        }

        const kycStatusForPriority = data.kycStatus || 'Not Verified';
        const dashPriorityLevel = document.getElementById('dashPriorityLevel');
        if (dashPriorityLevel) {
            if (kycStatusForPriority !== 'Verified') {
                dashPriorityLevel.textContent = 'Get Verified to unlock';
                dashPriorityLevel.style.color = '#94a3b8';
                dashPriorityLevel.style.fontSize = '0.85rem';
                dashPriorityLevel.style.fontWeight = '600';
            } else {
                const calculatedPriority = calculatePriorityLevel(data);
                dashPriorityLevel.textContent = calculatedPriority;
                dashPriorityLevel.style.fontSize = '';
                dashPriorityLevel.style.fontWeight = '700';
                if (calculatedPriority === 'High') {
                    dashPriorityLevel.style.color = '#ef4444';
                } else if (calculatedPriority === 'Medium') {
                    dashPriorityLevel.style.color = '#f59e0b';
                } else {
                    dashPriorityLevel.style.color = '#22c55e';
                }
            }
        }

        const dashKycBadge = document.getElementById('dashKycBadge');
        const dashKycMessage = document.getElementById('dashKycMessage');
        const kycStatus = data.kycStatus || 'Not Verified';
        if (dashKycBadge) {
            dashKycBadge.textContent = kycStatus === 'Verified' ? 'Verified ✓' : kycStatus === 'Pending' ? 'Pending Review' : 'Not Verified';
            dashKycBadge.style.background = kycStatus === 'Verified' ? 'rgba(34,197,94,0.3)' : kycStatus === 'Pending' ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.2)';
        }
        if (dashKycMessage) {
            dashKycMessage.textContent = getKycCardMessage(kycStatus);
        }

        const dashMemberSince = document.getElementById('dashMemberSince');
        if (dashMemberSince) {
            const date = data.createdAt ? new Date(data.createdAt) : null;
            dashMemberSince.textContent = date ? date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—';
        }

        const today = new Date();
        // Release window renews automatically every month — anchored to the day
        // the OSCA employee approved (verified) this account; falls back to the
        // regular calendar month (1st to the last day) when no approval date.
        const pensionDateStr = getPensionReleaseWindow(data, today).label;
        
        const dashPensionTitle = document.getElementById('pensionBlockTitle');
        const dashPensionDate = document.getElementById('pensionDate');
        const dashPensionAmount = document.getElementById('pensionAmount');
        const dashPensionIcon = document.getElementById('pensionBlockIcon');
        const isApproved = checkIsPensionApproved(data);
        // Dual pension granted on verification: Local (monthly) + National (quarterly)
        const localPension = seniorLocalPension(data);
        const nationalPension = seniorNationalPension(data);
        const qtrTotal = localPension * 3 + nationalPension;
        const hasAnyPension = localPension > 0 || nationalPension > 0;
        const hasDualPension = localPension > 0 && nationalPension > 0;

        // Check if senior has any approved assistance benefits (e.g., Burial Assistance) that are NOT claimed
        let latestBenefit = null;
        if (data.benefits) {
            const benefitList = Object.values(data.benefits).filter(b => 
                b && b.title && 
                !b.title.toLowerCase().includes('pension') &&
                (b.status === 'Approved' || b.status === 'Approved_Pending_Payout')
            );
            if (benefitList.length > 0) {
                benefitList.sort((a, b) => (b.approvedAt || b.createdAt || 0) - (a.approvedAt || a.createdAt || 0));
                latestBenefit = benefitList[0];
            }
        }

        if (isApproved || hasAnyPension) {
            // Senior has Local + National pension — show both lines + quarterly total
            if (dashPensionTitle) dashPensionTitle.textContent = 'Pension Release';
            if (dashPensionDate) dashPensionDate.textContent = pensionDateStr;
            const dashLocal = document.getElementById('pensionLocalLine');
            const dashNat = document.getElementById('pensionNationalLine');
            if (dashLocal) dashLocal.textContent = localPension > 0
                ? `Local (Monthly): ₱${localPension.toLocaleString()}`
                : 'Local (Monthly): —';
            if (dashNat) dashNat.textContent = nationalPension > 0
                ? `National (Quarterly): ₱${nationalPension.toLocaleString()}`
                : 'National (Quarterly): —';
            if (dashPensionAmount) {
                dashPensionAmount.textContent = qtrTotal > 0
                    ? `Quarterly Total: ₱${qtrTotal.toLocaleString()}${isApproved ? ' (Approved)' : (hasDualPension ? ' (Active)' : ' (Setup incomplete)')}`
                    : 'Amount: To be confirmed by OSCA';
            }
            if (dashPensionIcon) dashPensionIcon.className = 'far fa-calendar-alt block-icon';
        } else if (latestBenefit) {
            // No pension configured — show the latest approved assistance instead
            const dateStr = latestBenefit.approvedAt ? new Date(latestBenefit.approvedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Approved';
            if (dashPensionTitle) dashPensionTitle.textContent = 'Approved Assistance';
            if (dashPensionDate) dashPensionDate.textContent = latestBenefit.amount
                ? `${latestBenefit.title} - ${latestBenefit.amount}`
                : latestBenefit.title;
            if (dashPensionAmount) dashPensionAmount.textContent = `Status: Approved on ${dateStr}`;
            if (dashPensionIcon) dashPensionIcon.className = 'fas fa-hand-holding-heart block-icon';
        } else {
            // No pension and no approved assistance yet
            if (dashPensionTitle) dashPensionTitle.textContent = 'Pension';
            if (dashPensionDate) dashPensionDate.textContent = 'No available pension yet';
            const _dl = document.getElementById('pensionLocalLine');
            const _dn = document.getElementById('pensionNationalLine');
            if (_dl) _dl.textContent = 'Local (Monthly): Awaiting verification';
            if (_dn) _dn.textContent = 'National (Quarterly): Awaiting verification';
            if (dashPensionAmount) dashPensionAmount.textContent = 'Get verified to receive your pension';
            if (dashPensionIcon) dashPensionIcon.className = 'far fa-calendar-alt block-icon';
        }

        // Blue profile card: show the latest Burial / Bedridden assistance
        // request instead of the OSCA ID when one exists.
        updateDashRequestCard();
    }

    // ── Dashboard "Request Assistance" card (Burial / Bedridden) ────────
    // The blue profile card shows the senior's latest Burial or Bedridden
    // assistance request (title + live status) instead of the OSCA ID.
    // If no such request exists, it falls back to the OSCA ID display.
    let myServiceClaims = [];

    function getKycCardMessage(kycStatus) {
        if (kycStatus === 'Verified') return 'You can now access all benefits and services.';
        if (kycStatus === 'Pending') return 'Your verification is being reviewed. You will be notified once approved.';
        return 'Get verified to access all benefits and services.';
    }

    function serviceTitleFromType(serviceType) {
        const t = String(serviceType || '').toLowerCase();
        if (t.includes('burial')) return 'Burial Assistance';
        if (t.includes('bedridden')) return 'Bedridden Assistance';
        return '';
    }

    function serviceRequestMessage(status, refNumber) {
        const s = String(status || 'Pending');
        const map = {
            'Pending': 'Your request is pending review by OSCA staff.',
            'Processing': 'Your request is currently being processed by OSCA.',
            'Approved': 'Request approved! Proceed to the OSCA office to claim.',
            'Approved_Pending_Payout': 'Request approved! Awaiting payout processing.',
            'Claimed': 'Assistance has been released and claimed. Thank you!',
            'Paid': 'Assistance payout completed. Thank you!',
            'Rejected': 'Request was declined. Please visit the OSCA office for details.'
        };
        return (map[s] || `Request status: ${s}.`) + (refNumber ? ` Ref: ${refNumber}.` : '');
    }

    // ── Duplicate-request prevention ─────────────────────────────────────
    // A senior may only have ONE active (not yet decided) request per
    // assistance type (Burial / Bedridden). While that request is Pending or
    // Processing, new requests of the same type are blocked. Once OSCA
    // approves it (Approved / Approved_Pending_Payout / Paid / Claimed /
    // Released) or declines it (Rejected), the senior can request again.
    const BLOCKING_REQUEST_STATUSES = ['Pending', 'Processing'];

    function findActiveRequestForService(serviceType, claimsList) {
        const wanted = serviceTitleFromType(serviceType);
        if (!wanted) return null;
        const list = Array.isArray(claimsList) ? claimsList : Object.values(claimsList || {});
        return list.find(c => (
            c &&
            serviceTitleFromType(c.serviceType) === wanted &&
            BLOCKING_REQUEST_STATUSES.includes(String(c.status || 'Pending'))
        )) || null;
    }

    // Render the blocked/unblocked state of the service form for the given
    // active duplicate request (null = no active request → form usable).
    function renderDuplicateGuard(service, activeRequest) {
        const dupForm = document.getElementById('interactiveServiceForm');
        const dupSubmitBtn = dupForm ? dupForm.querySelector('.form-submit-btn') : null;
        const oldBanner = document.getElementById('duplicateRequestBanner');
        if (oldBanner) oldBanner.remove();

        if (activeRequest) {
            const dupTitle = serviceTitleFromType(activeRequest.serviceType) || service;
            if (dupForm) {
                dupForm.insertAdjacentHTML('afterbegin', `
                    <div id="duplicateRequestBanner" style="display:flex; align-items:flex-start; gap:12px; background:#fef2f2; border:1px solid #fecaca; border-radius:10px; padding:14px 16px; margin-bottom:18px;">
                        <i class="fas fa-circle-exclamation" style="color:#dc2626; font-size:1.1rem; margin-top:2px;"></i>
                        <div style="font-size:0.88rem; color:#7f1d1d; line-height:1.5;">
                            <strong>You already have an active ${dupTitle} request.</strong><br>
                            Its current status is <strong>${String(activeRequest.status)}</strong>. You can submit a new ${dupTitle} request once this one is approved or declined by OSCA staff.
                        </div>
                    </div>`);
            }
            if (dupSubmitBtn) {
                dupSubmitBtn.disabled = true;
                dupSubmitBtn.style.opacity = '0.55';
                dupSubmitBtn.style.cursor = 'not-allowed';
            }
        } else if (dupSubmitBtn) {
            dupSubmitBtn.disabled = false;
            dupSubmitBtn.style.opacity = '';
            dupSubmitBtn.style.cursor = '';
        }
    }

    // Re-verify the duplicate guard against LIVE claim data. The dashboard
    // cache (myServiceClaims) only refreshes every few minutes, so opening
    // the form with a stale cache could wrongly block or wrongly allow.
    async function refreshDuplicateGuardLive(service) {
        try {
            const dupUid = currentUserData ? currentUserData.uid : null;
            if (!dupUid) return;
            const snap = await get(query(ref(db, 'claims'), orderByChild('uid'), equalTo(dupUid)));
            renderDuplicateGuard(service, findActiveRequestForService(service, Object.values(snap.val() || {})));
        } catch (err) {
            console.warn('Live duplicate-request check failed; keeping cached state:', err);
        }
    }

    function updateDashRequestCard() {
        const labelEl = document.getElementById('dashRequestLabel');
        const valueEl = document.getElementById('dashSeniorId');
        const iconEl = document.getElementById('dashRequestIcon');
        const msgEl = document.getElementById('dashKycMessage');
        if (!labelEl || !valueEl) return;

        // Only Burial / Bedridden requests drive the card
        const relevant = (myServiceClaims || []).filter(c => c && serviceTitleFromType(c.serviceType));
        const activeStatuses = ['Pending', 'Processing', 'Approved', 'Approved_Pending_Payout'];
        const active = relevant.filter(c => activeStatuses.includes(String(c.status || 'Pending')));
        const pool = active.length > 0 ? active : relevant;
        const latest = pool.slice().sort((a, b) =>
            (b.createdAt || b.approvedAt || 0) - (a.createdAt || a.approvedAt || 0))[0];

        if (latest) {
            const title = serviceTitleFromType(latest.serviceType);
            labelEl.textContent = 'Request Assistance';
            valueEl.textContent = title;
            if (iconEl) iconEl.className = `fas ${title.indexOf('Burial') === 0 ? 'fa-ribbon' : 'fa-bed'} block-icon`;
            if (msgEl) msgEl.textContent = serviceRequestMessage(latest.status, latest.refNumber);
        } else {
            // Fall back to the regular OSCA ID display
            labelEl.textContent = 'OSCA ID';
            valueEl.textContent = (currentUserData && currentUserData.seniorId) || 'OSCA-PENDING';
            if (iconEl) iconEl.className = 'fas fa-id-card block-icon';
            if (msgEl) msgEl.textContent = getKycCardMessage((currentUserData && currentUserData.kycStatus) || 'Not Verified');
        }
    }

    async function loadMyServiceRequests() {
        try {
            const headers = await seniorAuthHeaders();
            const res = await fetch('/api/claims/request/mine', { headers });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Failed to load requests.');
            myServiceClaims = data.claims || [];
        } catch (err) {
            console.error('Load assistance requests error:', err);
            myServiceClaims = [];
        }
        updateDashRequestCard();
    }

    // ── Monthly pension release window ─────────────────────────────────
    // The window renews automatically every month. It is anchored to the day
    // the OSCA employee approved (verified) the senior's account
    // (kycVerifiedAt) — e.g. approved on the 15th → each window runs from the
    // 15th until the 14th of the following month. Without an approval date it
    // falls back to the regular calendar month (1st to the last day).
    function getPensionReleaseWindow(userData, now) {
        now = now || new Date();
        const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
        const fmtDate = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
        const anchorMs = Number(userData && (userData.kycVerifiedAt || userData.pensionSetAt)) || 0;
        let start, end;

        if (anchorMs > 0) {
            const anchorDay = new Date(anchorMs).getDate();
            const clampedAnchor = (y, m) => new Date(y, m, Math.min(anchorDay, daysInMonth(y, m)));
            const thisMonthAnchor = clampedAnchor(now.getFullYear(), now.getMonth());
            if (thisMonthAnchor.getTime() <= now.getTime()) {
                start = thisMonthAnchor;
            } else {
                const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                start = clampedAnchor(prevMonth.getFullYear(), prevMonth.getMonth());
            }
            const nextMonth = new Date(start.getFullYear(), start.getMonth() + 1, 1);
            const nextAnchor = clampedAnchor(nextMonth.getFullYear(), nextMonth.getMonth());
            end = new Date(nextAnchor.getFullYear(), nextAnchor.getMonth(), nextAnchor.getDate() - 1);
        } else {
            start = new Date(now.getFullYear(), now.getMonth(), 1);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        }
        return { start, end, label: `${fmtDate(start)} - ${fmtDate(end)}` };
    }

    // --- Populate Profile Input Fields ---
    function populateProfileInputs(data) {
        const editName = document.getElementById('editName');
        const editOscaId = document.getElementById('editOscaId');
        const editEmail = document.getElementById('editEmail');
        const editSex = document.getElementById('editSex');
        const editDob = document.getElementById('editDob');
        const editCivil = document.getElementById('editCivil');
        const editAddress = document.getElementById('editAddress');

        if (editName) editName.value = data.name || '';
        if (editOscaId) editOscaId.value = data.seniorId || 'OSCA-PENDING';
        if (editEmail) editEmail.value = data.email || '';
        if (editSex) editSex.value = data.sex || 'Female';
        if (editDob) editDob.value = data.dob || '';
        if (editCivil) editCivil.value = data.civilStatus || 'Married';
        if (editAddress) editAddress.value = data.address || '';

        // Show the senior's real digital ID on the OSCA ID label and load the QR once
        const qrOscaIdLabel = document.getElementById('qrOscaIdLabel');
        if (qrOscaIdLabel) qrOscaIdLabel.textContent = 'OSCA ID: ' + (data.seniorId || 'OSCA-PENDING');
        loadSeniorQrCode();
    }

    // ── QR Digital ID (unique QR linked to this profile, scanned by OSCA staff) ──
    let seniorQrLoaded = false;

    async function loadSeniorQrCode() {
        if (seniorQrLoaded) return;
        seniorQrLoaded = true;

        const img = document.getElementById('seniorQrImage');
        const loadingState = document.getElementById('qrLoadingState');
        const errorState = document.getElementById('qrErrorState');
        if (!img || !loadingState) return;

        try {
            const token = await auth.currentUser.getIdToken();
            const res = await fetch('/api/senior/verification-token', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const data = await res.json();
            if (!data.success || !data.qrImage) {
                throw new Error(data.message || 'Failed to load your QR code.');
            }
            img.src = data.qrImage;
            img.style.display = 'block';
            loadingState.style.display = 'none';
            window._seniorQrPayload = data.payload;
        } catch (err) {
            console.error('QR load error:', err);
            loadingState.style.display = 'none';
            if (errorState) errorState.style.display = 'flex';
            seniorQrLoaded = false; // allow a manual retry
        }
    }

    async function downloadDigitalId() {
        const data = currentUserData || {};
        const img = document.getElementById('seniorQrImage');
        if (!img || !img.src || img.style.display === 'none') {
            showToast('Your QR code is still loading. Please try again in a moment.');
            return;
        }
        try {
            // Download the QR code image directly (no Digital ID card)
            const link = document.createElement('a');
            link.download = 'SilverCare-QR-' + (data.seniorId || String(data.name || 'senior').replace(/\s+/g, '-')) + '.png';
            link.href = img.src;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            showToast('QR Code downloaded! Keep it on your phone or print a copy.');
        } catch (err) {
            console.error('QR download error:', err);
            showToast('Failed to download your QR Code. Please try again.');
        }
    }

    const downloadDigitalIdBtn = document.getElementById('downloadDigitalIdBtn');
    if (downloadDigitalIdBtn) {
        downloadDigitalIdBtn.addEventListener('click', downloadDigitalId);
    }

    const qrRetryBtn = document.getElementById('qrRetryBtn');
    if (qrRetryBtn) {
        qrRetryBtn.addEventListener('click', () => {
            const errorState = document.getElementById('qrErrorState');
            const loadingState = document.getElementById('qrLoadingState');
            if (errorState) errorState.style.display = 'none';
            if (loadingState) loadingState.style.display = 'flex';
            loadSeniorQrCode();
        });
    }

    // --- Profile Form Submit (Save Profile Update) ---
    const profileEditForm = document.getElementById('profileEditForm');
    if (profileEditForm) {
        profileEditForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const saveBtn = profileEditForm.querySelector('.form-submit-btn');
            const originalText = saveBtn.innerHTML;
            saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
            saveBtn.disabled = true;

            const name = document.getElementById('editName').value.trim();
            const sex = document.getElementById('editSex').value;
            const civilStatus = document.getElementById('editCivil').value;
            const address = document.getElementById('editAddress').value.trim();

            // Email, Date of Birth and OSCA ID are read-only (same as OSCA ID) — never updated from profile form
            try {
                // Update profile in database (DO NOT update seniorId, email, or dob)
                await update(ref(db, 'users/' + currentUserData.uid), {
                    name: name,
                    sex: sex,
                    civilStatus: civilStatus,
                    address: address
                });

                showToast("Profile details updated successfully!");
            } catch (err) {
                console.error("Profile update failed:", err);
                alert("Failed to update profile: " + err.message);
            } finally {
                saveBtn.innerHTML = originalText;
                saveBtn.disabled = false;
            }
        });
    }

    // Helper to get dismissed static notifications from localStorage
    function getDismissedNotifs(uid) {
        if (!uid) return [];
        try {
            return JSON.parse(localStorage.getItem('dismissedNotifs_' + uid) || '[]');
        } catch (e) {
            return [];
        }
    }

    function dismissStaticNotif(uid, key) {
        if (!uid || !key) return;
        const dismissed = getDismissedNotifs(uid);
        if (!dismissed.includes(key)) {
            dismissed.push(key);
            localStorage.setItem('dismissedNotifs_' + uid, JSON.stringify(dismissed));
        }
    }

    async function deleteSingleNotification(key, isDynamic) {
        if (!currentUserData) return;
        try {
            if (isDynamic) {
                await remove(ref(db, `users/${currentUserData.uid}/notifications/${key}`));
            } else {
                dismissStaticNotif(currentUserData.uid, key);
                renderBenefitsAndNotifications(currentUserData);
            }
            if (typeof showToast === 'function') {
                showToast("Notification removed");
            }
        } catch (err) {
            console.error("Error removing notification:", err);
            alert("Failed to remove notification: " + err.message);
        }
    }

    // --- Dynamic Rendering of Benefits and Notifications from Database ---
    function renderBenefitsAndNotifications(userData) {
        const today = new Date();
        const monthName = today.toLocaleDateString('en-US', { month: 'long' });
        // Same monthly window as the dashboard block (anchored to the account
        // approval day; falls back to the 1st of the month).
        const pensionDateStr = getPensionReleaseWindow(userData, today).label;

        const isPensionApproved = checkIsPensionApproved(userData);
        const benefitsContainer = document.getElementById('benefitsContainer');
        const dashActiveBenefits = document.getElementById('dashActiveBenefits');

        // ── Benefits Showcase: Local + National Pension + Assistance + Quarterly Total ──
        // Quarterly allocation is shown separately from released history totals.
        // Auto-updates whenever a new pension/assistance is claimed (re-rendered on RTDB onValue).
        function parseBenefitAmount(val) {
            if (val == null) return 0;
            if (typeof val === 'number') return val;
            const cleaned = String(val).replace(/[^0-9.]/g, '');
            const num = parseFloat(cleaned);
            return Number.isFinite(num) ? num : 0;
        }
        function formatPHP(num) {
            return '₱' + Number(num || 0).toLocaleString('en-PH');
        }
        function isCountableBenefit(b) {
            if (!b || !b.title) return false;
            const s = String(b.status || '').toLowerCase();
            if (['declined','rejected','removed','deleted','void'].includes(s)) return false;
            if (s === 'pending') return false;
            return true;
        }
        function benefitIconClass(title) {
            const t = String(title || '').toLowerCase();
            if (t.includes('pension')) return 'pension';
            if (t.includes('burial')) return 'burial';
            if (t.includes('bedridden')) return 'bedridden';
            return 'assistance';
        }
        function benefitFaIcon(title) {
            const t = String(title || '').toLowerCase();
            if (t.includes('pension')) return 'fa-hand-holding-dollar';
            if (t.includes('burial')) return 'fa-ribbon';
            if (t.includes('bedridden')) return 'fa-bed';
            return 'fa-hand-holding-heart';
        }

        const allBenefits = userData.benefits ? Object.entries(userData.benefits).map(([k, v]) => ({ _key: k, ...v })).filter(b => b.title) : [];
        const countable = allBenefits.filter(isCountableBenefit);
        const pensionBenefits = countable.filter(b => b.title.toLowerCase().includes('pension'));
        const assistanceBenefits = countable.filter(b => !b.title.toLowerCase().includes('pension'));

        // Sort by date (approvedAt > createdAt > releasedAt) descending
        function getBenefitDate(b) { return b.approvedAt || b.createdAt || b.releasedAt || b.paidAt || 0; }
        pensionBenefits.sort((a,b) => getBenefitDate(b) - getBenefitDate(a));
        assistanceBenefits.sort((a,b) => getBenefitDate(b) - getBenefitDate(a));
        countable.sort((a,b) => getBenefitDate(a) - getBenefitDate(b));

        // Dual pension granted on verification (Local monthly + National quarterly)
        const cfgLocal = seniorLocalPension(userData);
        const cfgNational = seniorNationalPension(userData);
        const cfgQuarter = cfgLocal * 3 + cfgNational;
        const pensionIsActive = isPensionApproved || cfgLocal > 0 || cfgNational > 0;

        let pensionTotal = 0, assistanceTotal = 0;
        pensionBenefits.forEach(b => { pensionTotal += parseBenefitAmount(b.amount); });
        assistanceBenefits.forEach(b => { assistanceTotal += parseBenefitAmount(b.amount); });
        const lifetimeTotal = pensionTotal + assistanceTotal;
        const activeBenefitsCountNew = (pensionIsActive ? 1 : 0) + assistanceBenefits.filter(b => ['approved','approved_pending_payout','claimed','paid','released'].includes(String(b.status||'').toLowerCase()) || !b.status).length;

        // Keep legacy hidden container in sync (for tests) but don't show old cards
        if (benefitsContainer) { benefitsContainer.innerHTML = ''; }

        // — Summary cards: Local + National + Assistance + Quarterly Total —
        const elLocalAmt = document.getElementById('showcaseLocalAmount');
        const elLocalStatus = document.getElementById('showcaseLocalStatus');
        const elLocalBadge = document.getElementById('showcaseLocalBadge');
        const elNatAmt = document.getElementById('showcaseNationalAmount');
        const elNatStatus = document.getElementById('showcaseNationalStatus');
        const elNatBadge = document.getElementById('showcaseNationalBadge');
        const elPensionAmt = document.getElementById('showcasePensionAmount');
        const elPensionStatus = document.getElementById('showcasePensionStatus');
        const elPensionBadge = document.getElementById('showcasePensionBadge');
        const elAssistanceCount = document.getElementById('showcaseAssistanceCount');
        const elAssistanceTotal = document.getElementById('showcaseAssistanceTotal');
        const elLifetimeTotal = document.getElementById('showcaseLifetimeTotal');
        if (elLocalAmt) elLocalAmt.textContent = cfgLocal > 0 ? formatPHP(cfgLocal) + '/mo' : '—';
        if (elLocalStatus) {
            elLocalStatus.textContent = cfgLocal > 0 ? (isPensionApproved ? 'Approved • Released monthly' : 'Active • Every month') : 'No local pension yet';
        }
        if (elLocalBadge) {
            if (cfgLocal > 0) { elLocalBadge.textContent = isPensionApproved ? 'Approved' : 'Active'; elLocalBadge.className = 'summary-badge badge-approved'; }
            else { elLocalBadge.textContent = 'No record'; elLocalBadge.className = 'summary-badge badge-none'; }
        }
        if (elNatAmt) elNatAmt.textContent = cfgNational > 0 ? formatPHP(cfgNational) + '/qtr' : '—';
        if (elNatStatus) {
            elNatStatus.textContent = cfgNational > 0 ? (isPensionApproved ? 'Approved • Every 3 months' : 'Active • Every 3 months') : 'No national pension yet';
        }
        if (elNatBadge) {
            if (cfgNational > 0) { elNatBadge.textContent = isPensionApproved ? 'Approved' : 'Active'; elNatBadge.className = 'summary-badge badge-approved'; }
            else { elNatBadge.textContent = 'No record'; elNatBadge.className = 'summary-badge badge-none'; }
        }
        if (elPensionAmt) {
            elPensionAmt.textContent = cfgQuarter > 0 ? formatPHP(cfgQuarter) : '—';
        }
        if (elPensionStatus) {
            if (isPensionApproved) {
                const mName = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                elPensionStatus.textContent = 'Approved for ' + mName + ' • Released';
            } else if (cfgQuarter > 0) {
                elPensionStatus.textContent = `Local ₱${cfgLocal.toLocaleString()}/mo + National ₱${cfgNational.toLocaleString()}/qtr • Quarterly total ₱${cfgQuarter.toLocaleString()}`;
            } else if (pensionBenefits.length > 0) {
                const lastDate = pensionBenefits[0] ? new Date(getBenefitDate(pensionBenefits[0])).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '';
                elPensionStatus.textContent = lastDate ? 'Last pension: ' + lastDate + ' • Awaiting next release' : 'No release this month • Awaiting admin';
            } else {
                elPensionStatus.textContent = 'No available pension yet';
            }
        }
        if (elPensionBadge) {
            if (isPensionApproved) { elPensionBadge.textContent = 'Approved'; elPensionBadge.className = 'summary-badge badge-approved'; }
            else if (cfgQuarter > 0) { elPensionBadge.textContent = 'Active'; elPensionBadge.className = 'summary-badge badge-approved'; }
            else if (pensionBenefits.length > 0) { elPensionBadge.textContent = 'Pending'; elPensionBadge.className = 'summary-badge badge-pending'; }
            else { elPensionBadge.textContent = 'No record'; elPensionBadge.className = 'summary-badge badge-none'; }
        }
        if (elAssistanceCount) {
            elAssistanceCount.textContent = String(assistanceBenefits.length);
        }
        if (elAssistanceTotal) {
            elAssistanceTotal.textContent = formatPHP(assistanceTotal) + ' total assistance';
        }
        if (elLifetimeTotal) {
            elLifetimeTotal.textContent = formatPHP(cfgQuarter > 0 ? cfgQuarter : lifetimeTotal);
        }

        // — Pension History List —
        const pensionList = document.getElementById('pensionHistoryList');
        const pensionCountEl = document.getElementById('pensionHistoryCount');
        if (pensionList) {
            if (pensionBenefits.length === 0) {
                pensionList.innerHTML = cfgQuarter > 0
                    ? `<div class="benefits-empty-state"><i class="fas fa-calendar"></i><p>No pension records yet</p><span>Local ₱${cfgLocal.toLocaleString()}/mo + National ₱${cfgNational.toLocaleString()}/qtr — releases will appear here</span></div>`
                    : '<div class="benefits-empty-state"><i class="fas fa-calendar"></i><p>No pension records yet</p><span>Approved pensions will appear here from first to latest</span></div>';
            } else {
                pensionList.innerHTML = pensionBenefits.map(b => {
                    const bAmt = parseBenefitAmount(b.amount);
                    const amt = bAmt > 0 ? formatPHP(bAmt) : '—';
                    const dateVal = getBenefitDate(b);
                    const dateStr = dateVal ? new Date(dateVal).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
                    const status = String(b.status || 'Approved');
                    const ref = b.refNumber || b.ref || '';
                    return `<div class="history-entry">
                        <div class="history-entry-icon pension"><i class="fas ${benefitFaIcon(b.title)}"></i></div>
                        <div class="history-entry-main">
                            <div class="history-entry-title">${escapeHtml(b.title)}</div>
                            <div class="history-entry-meta"><span><span class="history-status-dot dot-approved"></span>${escapeHtml(status)}</span> • <span>${escapeHtml(dateStr)}</span>${ref ? ' • <span style="font-family:monospace; font-weight:700; color:#0f172a;">' + escapeHtml(ref) + '</span>' : ''}</div>
                        </div>
                        <div class="history-entry-amount pension-amt">${escapeHtml(amt)}</div>
                    </div>`;
                }).join('');
            }
        }
        if (pensionCountEl) pensionCountEl.textContent = pensionBenefits.length + (pensionBenefits.length === 1 ? ' record' : ' records');

        // — Assistance History List —
        const assistanceList = document.getElementById('assistanceHistoryList');
        const assistanceCountEl = document.getElementById('assistanceHistoryCount');
        if (assistanceList) {
            if (assistanceBenefits.length === 0) {
                assistanceList.innerHTML = '<div class="benefits-empty-state"><i class="fas fa-hand-holding-heart"></i><p>No assistance records yet</p><span>Approved burial, bedridden & other assistances will appear here</span></div>';
            } else {
                assistanceList.innerHTML = assistanceBenefits.map(b => {
                    const amt = formatPHP(parseBenefitAmount(b.amount));
                    const dateVal = getBenefitDate(b);
                    const dateStr = dateVal ? new Date(dateVal).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
                    const status = String(b.status || 'Approved');
                    const sLower = status.toLowerCase();
                    const dotClass = sLower === 'claimed' || sLower === 'paid' ? 'dot-claimed' : sLower === 'pending' ? 'dot-pending' : 'dot-approved';
                    const ref = b.refNumber || b.ref || '';
                    const iconCls = benefitIconClass(b.title);
                    return `<div class="history-entry">
                        <div class="history-entry-icon ${iconCls}"><i class="fas ${benefitFaIcon(b.title)}"></i></div>
                        <div class="history-entry-main">
                            <div class="history-entry-title">${escapeHtml(b.title)}</div>
                            <div class="history-entry-meta"><span><span class="history-status-dot ${dotClass}"></span>${escapeHtml(status)}</span> • <span>${escapeHtml(dateStr)}</span>${ref ? ' • <span style="font-family:monospace; font-weight:700; color:#0f172a;">' + escapeHtml(ref) + '</span>' : ''}</div>
                        </div>
                        <div class="history-entry-amount">${escapeHtml(amt)}</div>
                    </div>`;
                }).join('');
            }
        }
        if (assistanceCountEl) assistanceCountEl.textContent = assistanceBenefits.length + (assistanceBenefits.length === 1 ? ' record' : ' records');

        if (dashActiveBenefits) {
            dashActiveBenefits.textContent = activeBenefitsCountNew;
        }

        // 2. Load dynamic notifications
        const dashNotificationsList = document.getElementById('dashNotificationsList');
        const allNotificationsList = document.getElementById('allNotificationsList');

        const dismissed = getDismissedNotifs(userData ? userData.uid : null);
        let notifHtml = '';

        if (userData && userData.notifications) {
            const sortedNotifs = Object.entries(userData.notifications).sort((a, b) => b[1].createdAt - a[1].createdAt);

            if (sortedNotifs.length > 0) {
                const latestNotifTime = sortedNotifs[0][1].createdAt;
                const lastViewTime = localStorage.getItem('lastNotifView_' + userData.uid) || 0;
                if (latestNotifTime > lastViewTime) {
                    const notifBadge = document.getElementById('notifBadge');
                    if (notifBadge) notifBadge.style.display = 'block';
                }
            }

            sortedNotifs.forEach(([key, rawNotif]) => {
                const notif = rawNotif || {};
                const notifTitle = notif ? String(notif.title || '') : '';
                const notifDesc = notif ? String(notif.description || '') : '';
                const isScheduled = notifTitle.includes('Scheduled') || notifTitle.includes('Appointment');
                const isApproved = notifTitle.includes('Approved') || notifTitle.includes('Verified');
                let iconColor = 'background:#e0f2fe; color:#0284c7;';
                let icon = 'fa-bell';

                if (isScheduled) {
                    iconColor = 'background:#dbeafe; color:#2563eb;';
                    icon = 'fa-calendar-check';
                } else if (isApproved) {
                    iconColor = 'background:#e6f4ea; color:#137333;';
                    icon = 'fa-check';
                } else if (notifTitle.includes('Declined') || notifTitle.includes('Rejected')) {
                    iconColor = 'background:#fce8e6; color:#c5221f;';
                    icon = 'fa-exclamation-triangle';
                }

                const safeTitle = notifTitle.replace(/"/g, '&quot;');
                const safeDesc = notifDesc.replace(/"/g, '&quot;');
                const timeStr = getRelativeTime(notif.createdAt);

                notifHtml += `
                    <div class="notif-item clickable-notif" data-key="${key}" data-is-dynamic="true" data-title="${safeTitle}" data-desc="${safeDesc}" data-time="${timeStr}" data-icon="${icon}" data-type="${isScheduled ? 'appointment' : 'general'}" style="cursor: pointer;">
                        <div class="notif-left">
                            <div class="notif-icon-circle" style="${iconColor}"><i class="fas ${icon}"></i></div>
                            <div>
                                <div class="notif-title">${notif.title}</div>
                                <div class="notif-desc">${notif.description}</div>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span class="notif-time">${timeStr}</span>
                            <button class="remove-notif-btn" data-key="${key}" data-is-dynamic="true" title="Remove notification" style="background:none; border:none; color:#94a3b8; cursor:pointer; padding:6px 8px; border-radius:6px; font-size:0.85rem; transition:all 0.2s;" onmouseover="this.style.color='#ef4444'; this.style.background='#fee2e2';" onmouseout="this.style.color='#94a3b8'; this.style.background='none';">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                            <i class="fas fa-chevron-right" style="font-size:0.75rem; color:#cbd5e1;"></i>
                        </div>
                    </div>
                `;
            });
        }

        // Static default notifications (if not dismissed)
        let staticNotifs = '';
        const notifLocal = seniorLocalPension(userData);
        const notifNat = seniorNationalPension(userData);
        const notifQtr = notifLocal * 3 + notifNat;
        const pensionNotifDesc = isPensionApproved
            ? `Your Local ₱${notifLocal.toLocaleString()}/month + National ₱${notifNat.toLocaleString()}/quarter will be released on ${pensionDateStr}`
            : (notifQtr > 0
                ? `Local ₱${notifLocal.toLocaleString()}/mo + National ₱${notifNat.toLocaleString()}/qtr. Next release: ${pensionDateStr}.`
                : 'No available pension yet. Get verified to receive your pension.');
        if (!dismissed.includes('static_pension')) {
            staticNotifs += `
                <div class="notif-item clickable-notif" data-key="static_pension" data-is-dynamic="false" data-title="Pension Release" data-desc="${pensionNotifDesc}" data-time="2 hours ago" data-icon="fa-dollar-sign" data-type="benefit" style="cursor: pointer;">
                    <div class="notif-left">
                        <div class="notif-icon-circle" style="${(isPensionApproved || notifQtr > 0) ? 'background:#e6f4ea; color:#137333;' : 'background:#fee2e2; color:#ef4444;'}"><i class="fas fa-dollar-sign"></i></div>
                        <div>
                            <div class="notif-title">Pension Release</div>
                            <div class="notif-desc">${pensionNotifDesc}</div>
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="notif-time">2 hours ago</span>
                        <button class="remove-notif-btn" data-key="static_pension" data-is-dynamic="false" title="Remove notification" style="background:none; border:none; color:#94a3b8; cursor:pointer; padding:6px 8px; border-radius:6px; font-size:0.85rem; transition:all 0.2s;" onmouseover="this.style.color='#ef4444'; this.style.background='#fee2e2';" onmouseout="this.style.color='#94a3b8'; this.style.background='none';">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                        <i class="fas fa-chevron-right" style="font-size:0.75rem; color:#cbd5e1;"></i>
                    </div>
                </div>
            `;
        }
        if (!dismissed.includes('static_health')) {
            staticNotifs += `
                <div class="notif-item clickable-notif" data-key="static_health" data-is-dynamic="false" data-title="Health Reminder" data-desc="Schedule your quarterly check-up with OSCA Health Services" data-time="1 day ago" data-icon="fa-heartbeat" data-type="health" style="cursor: pointer;">
                    <div class="notif-left">
                        <div class="notif-icon-circle" style="background:#fce8e6; color:#c5221f;"><i class="fas fa-heartbeat"></i></div>
                        <div>
                            <div class="notif-title">Health Reminder</div>
                            <div class="notif-desc">Schedule your quarterly check-up</div>
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="notif-time">1 day ago</span>
                        <button class="remove-notif-btn" data-key="static_health" data-is-dynamic="false" title="Remove notification" style="background:none; border:none; color:#94a3b8; cursor:pointer; padding:6px 8px; border-radius:6px; font-size:0.85rem; transition:all 0.2s;" onmouseover="this.style.color='#ef4444'; this.style.background='#fee2e2';" onmouseout="this.style.color='#94a3b8'; this.style.background='none';">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                        <i class="fas fa-chevron-right" style="font-size:0.75rem; color:#cbd5e1;"></i>
                    </div>
                </div>
            `;
        }

        const combinedNotifs = notifHtml + staticNotifs;
        const emptyStateHtml = `
            <div style="text-align: center; padding: 40px 20px; color: #94a3b8;">
                <i class="far fa-bell-slash" style="font-size: 2.5rem; margin-bottom: 12px; opacity: 0.5;"></i>
                <p style="margin: 0; font-size: 0.95rem; font-weight: 600; color: #64748b;">No notifications available</p>
                <span style="font-size: 0.8rem; color: #94a3b8;">You are all caught up!</span>
            </div>
        `;

        if (dashNotificationsList) dashNotificationsList.innerHTML = combinedNotifs || emptyStateHtml;
        if (allNotificationsList) allNotificationsList.innerHTML = combinedNotifs || emptyStateHtml;

        // Attach click handler to notifications
        document.querySelectorAll('.clickable-notif').forEach(item => {
            item.addEventListener('click', () => {
                const key = item.getAttribute('data-key');
                const isDynamic = item.getAttribute('data-is-dynamic') === 'true';
                const title = item.getAttribute('data-title');
                const desc = item.getAttribute('data-desc');
                const time = item.getAttribute('data-time');
                const icon = item.getAttribute('data-icon');
                const type = item.getAttribute('data-type');
                openNotificationModal(key, isDynamic, title, desc, time, icon, type);
            });
        });

        // Attach remove button click handlers
        document.querySelectorAll('.remove-notif-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const key = btn.getAttribute('data-key');
                const isDynamic = btn.getAttribute('data-is-dynamic') === 'true';
                await deleteSingleNotification(key, isDynamic);
            });
        });
    }

    // Modal logic for notifications
    const notifModal = document.getElementById('notificationDetailModal');
    const closeNotifModalBtn = document.getElementById('closeNotifDetailModal');
    const notifModalBtn = document.getElementById('notifModalBtn');
    const notifModalDeleteBtn = document.getElementById('notifModalDeleteBtn');

    let activeModalNotifKey = null;
    let activeModalNotifIsDynamic = false;

    function openNotificationModal(key, isDynamic, title, desc, time, icon, type) {
        if (!notifModal) return;

        activeModalNotifKey = key;
        activeModalNotifIsDynamic = isDynamic;

        document.getElementById('notifModalTitle').textContent = title;
        document.getElementById('notifModalTime').textContent = time;
        document.getElementById('notifModalBody').textContent = desc;

        const iconEl = document.getElementById('notifModalIcon');
        const iconCircle = document.getElementById('notifModalIconCircle');
        if (iconEl) iconEl.className = `fas ${icon}`;

        if (title.includes('Scheduled') || title.includes('Appointment')) {
            if (iconCircle) iconCircle.style.cssText = 'width: 44px; height: 44px; border-radius: 50%; display: flex; justify-content: center; align-items: center; font-size: 1.2rem; flex-shrink: 0; background:#dbeafe; color:#2563eb;';
            if (notifModalBtn) {
                notifModalBtn.style.display = 'flex';
                notifModalBtn.innerHTML = '<i class="fas fa-calendar-check"></i> View Appointments';
                notifModalBtn.onclick = () => {
                    notifModal.style.display = 'none';
                    switchTab('health');
                };
            }
        } else if (type === 'benefit' || title.includes('Pension') || title.includes('Approved')) {
            if (iconCircle) iconCircle.style.cssText = 'width: 44px; height: 44px; border-radius: 50%; display: flex; justify-content: center; align-items: center; font-size: 1.2rem; flex-shrink: 0; background:#e6f4ea; color:#137333;';
            if (notifModalBtn) {
                notifModalBtn.style.display = 'flex';
                notifModalBtn.innerHTML = '<i class="fas fa-gift"></i> View Benefits';
                notifModalBtn.onclick = () => {
                    notifModal.style.display = 'none';
                    switchTab('benefits');
                };
            }
        } else {
            if (iconCircle) iconCircle.style.cssText = 'width: 44px; height: 44px; border-radius: 50%; display: flex; justify-content: center; align-items: center; font-size: 1.2rem; flex-shrink: 0; background:#e0f2fe; color:#0284c7;';
            if (notifModalBtn) {
                notifModalBtn.style.display = 'none';
            }
        }

        notifModal.style.display = 'flex';
    }

    if (notifModalDeleteBtn) {
        notifModalDeleteBtn.onclick = async () => {
            if (activeModalNotifKey) {
                notifModal.style.display = 'none';
                await deleteSingleNotification(activeModalNotifKey, activeModalNotifIsDynamic);
            }
        };
    }

    const clearAllNotificationsBtn = document.getElementById('clearAllNotificationsBtn');
    if (clearAllNotificationsBtn) {
        clearAllNotificationsBtn.onclick = async () => {
            if (!currentUserData) return;
            if (!confirm("Are you sure you want to remove all notifications?")) return;

            try {
                if (currentUserData.notifications) {
                    await remove(ref(db, `users/${currentUserData.uid}/notifications`));
                }
                dismissStaticNotif(currentUserData.uid, 'static_pension');
                dismissStaticNotif(currentUserData.uid, 'static_health');
                renderBenefitsAndNotifications(currentUserData);
                if (typeof showToast === 'function') {
                    showToast("All notifications removed");
                }
            } catch (err) {
                console.error("Failed to clear all notifications:", err);
                alert("Failed to remove notifications: " + err.message);
            }
        };
    }

    if (closeNotifModalBtn) {
        closeNotifModalBtn.onclick = () => {
            notifModal.style.display = 'none';
        };
    }
    if (notifModal) {
        notifModal.addEventListener('click', (e) => {
            if (e.target === notifModal) notifModal.style.display = 'none';
        });
    }

    // --- Dynamic Form Rendering & Templates ---
    const dynamicFormFields = document.getElementById('dynamicFormFields');
    const formTitle = document.getElementById('formTitle');
    const formSubtitle = document.getElementById('formSubtitle');

    function openServiceForm(service) {
        // Switch to service form tab panel
        switchTab('service-form');

        // Reset dynamic fields
        dynamicFormFields.innerHTML = '';

        // Reset the Emergency Urgent Request toggle for every new form
        const urgentToggleReset = document.getElementById('urgentRequestToggle');
        if (urgentToggleReset) urgentToggleReset.checked = false;

        // ── Duplicate-request guard (form open) ──────────────────────────
        // If this senior already has an active (Pending / Processing)
        // request of the same assistance type, show the form in a blocked
        // state: warning banner + disabled submit button. The cache is
        // checked first for instant feedback, then re-verified against live
        // Firebase data (self-corrects a stale cache). A live check also
        // runs on submit (see the submit handler) as the final authority.
        renderDuplicateGuard(service, findActiveRequestForService(service, myServiceClaims));
        refreshDuplicateGuardLive(service);

        // Add official form header with logos
        const formLogoHeader = `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 15px 20px; margin-bottom: 20px; border-bottom: 3px solid #1e40af; background: linear-gradient(135deg, #f8fafc, #eef2ff); border-radius: 10px;">
                <img src="/images/form1.jpg" alt="NCSC Logo" style="height: 70px; width: 70px; object-fit: contain; border-radius: 50%;">
                <div style="text-align: center; flex: 1; padding: 0 15px;">
                    <div style="font-size: 0.7rem; color: #475569; font-weight: 600; letter-spacing: 1px; text-transform: uppercase;">Republic of the Philippines</div>
                    <div style="font-size: 0.95rem; color: #1e293b; font-weight: 800; margin: 3px 0; letter-spacing: 0.5px;">NATIONAL COMMISSION OF SENIOR CITIZENS</div>
                    <div style="font-size: 0.7rem; color: #475569; font-weight: 600; letter-spacing: 0.5px;">Office of the Senior Citizens Affairs (OSCA) — Magalang, Pampanga</div>
                </div>
                <img src="/images/form2.jpg" alt="Bagong Pilipinas Logo" style="height: 70px; width: 70px; object-fit: contain;">
            </div>
        `;

        // Safe Fallbacks
        const defaultName = currentUserData ? currentUserData.name : '';
        const defaultId = currentUserData ? (currentUserData.seniorId || '') : '';
        const defaultEmail = currentUserData ? currentUserData.email : '';
        const defaultAddress = currentUserData ? (currentUserData.address || '') : '';
        const defaultDob = currentUserData ? (currentUserData.dob || '') : '';
        // Annex A name sync: split parts from the verified record (no retyping).
        const defaultFirstName = currentUserData ? (currentUserData.firstName || '') : '';
        const defaultLastName = currentUserData ? (currentUserData.lastName || '') : '';
        const defaultMiddleName = currentUserData ? (currentUserData.middleName || '') : '';
        const defaultCp = currentUserData ? (currentUserData.cpNumber || '') : '';
        const defaultSex = currentUserData ? (currentUserData.sex || 'Female') : 'Female';
        const defaultCivil = currentUserData ? (currentUserData.civilStatus || 'Married') : 'Married';
        // Annex A address lock: verified barangay (canonical casing), Magalang / Pampanga / 2011.
        const _storedBrgy = ((currentUserData && currentUserData.barangay) || '').trim();
        const defaultBarangay = MAGALANG_BARANGAYS.find(b => b.toUpperCase() === _storedBrgy.toUpperCase()) || _storedBrgy;

        if (service === 'burial') {
            formTitle.textContent = 'Burial Assistance Claim Form';
            formSubtitle.textContent = 'Submit a soft copy application for Burial Assistance. OSCA Magalang will generate an endorsement letter for DSWD.';

            dynamicFormFields.innerHTML = formLogoHeader + `
                <div class="form-section-title">A. Deceased Senior Citizen Information</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="deceasedName">Name of Deceased Senior Citizen *</label>
                        <input type="text" id="deceasedName" placeholder="Full Name (Last, Given, Middle)" required>
                    </div>
                    <div class="form-group">
                        <label for="deceasedOscaId">OSCA ID Number *</label>
                        <input type="text" id="deceasedOscaId" placeholder="OSCA ID of Deceased" required>
                    </div>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="dateOfDeath">Date of Death *</label>
                        <input type="date" id="dateOfDeath" required>
                    </div>
                    <div class="form-group">
                        <label for="causeOfDeath">Cause of Death *</label>
                        <input type="text" id="causeOfDeath" placeholder="Cause of Death" required>
                    </div>
                </div>

                <div class="form-section-title">B. Claimant / Beneficiary Information</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="claimantName">Full Name of Claimant *</label>
                        <input type="text" id="claimantName" value="${defaultName}" required>
                    </div>
                    <div class="form-group">
                        <label for="claimantRelationship">Relationship to Deceased *</label>
                        <select id="claimantRelationship" required>
                            <option value="Spouse">Spouse</option>
                            <option value="Child">Child / Daughter / Son</option>
                            <option value="Sibling">Sibling</option>
                            <option value="Relative">Other Relative</option>
                            <option value="Authorized Representative">Authorized Representative</option>
                        </select>
                    </div>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="claimantIdType">Claimant ID Submitted *</label>
                        <input type="text" id="claimantIdType" placeholder="e.g. Driver's License, SSS, OSCA ID" required>
                    </div>
                    <div class="form-group">
                        <label for="claimantContact">Contact Number *</label>
                        <input type="tel" id="claimantContact" placeholder="+63 9xx xxx xxxx" pattern="[0-9\+]+" inputmode="numeric" required>
                    </div>
                </div>

                <div class="form-requirements-checklist">
                    <div class="requirement-checklist-title"><i class="fas fa-file-invoice"></i> Requirements to bring to OSCA Office:</div>
                    <ul class="requirement-list-ul">
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Original Death Certificate</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Barangay Certificate of Indigency (for Burial Assistance)</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Original Senior Citizen ID card of deceased</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Valid Government ID of Claimant</li>
                    </ul>
                </div>
            `;
        }
        else if (service === 'bedridden') {
            formTitle.textContent = 'Bedridden Senior Assistance & Assessment Form';
            formSubtitle.textContent = 'Submit requests for on-site assessment and care packages for bedridden seniors.';

            dynamicFormFields.innerHTML = formLogoHeader + `
                <div class="form-section-title">A. Bedridden Senior Information</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="bedriddenName">Name of Bedridden Senior *</label>
                        <input type="text" id="bedriddenName" value="${defaultName}" required>
                    </div>
                    <div class="form-group">
                        <label for="bedriddenOscaId">OSCA ID Number *</label>
                        <input type="text" id="bedriddenOscaId" value="${defaultId}" required>
                    </div>
                </div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="bedriddenDob">Date of Birth</label>
                        <input type="date" id="bedriddenDob" value="${defaultDob}">
                    </div>
                    <div class="form-group">
                        <label for="bedriddenSex">Sex</label>
                        <select id="bedriddenSex">
                            <option value="Male" ${defaultSex === 'Male' ? 'selected' : ''}>Male</option>
                            <option value="Female" ${defaultSex === 'Female' ? 'selected' : ''}>Female</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="bedriddenCivil">Civil Status</label>
                        <select id="bedriddenCivil">
                            <option value="Single" ${defaultCivil === 'Single' ? 'selected' : ''}>Single</option>
                            <option value="Married" ${defaultCivil === 'Married' ? 'selected' : ''}>Married</option>
                            <option value="Widowed" ${defaultCivil === 'Widowed' ? 'selected' : ''}>Widowed</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label for="bedriddenAddress">Complete Home Address *</label>
                    <input type="text" id="bedriddenAddress" value="${defaultAddress}" required>
                </div>
                <div class="form-group">
                    <label for="bedriddenCondition">Medical Condition / Reason for Bedridden State *</label>
                    <textarea id="bedriddenCondition" rows="3" placeholder="Briefly describe the senior's current condition (e.g. stroke, severe arthritis, paralysis)..." required></textarea>
                </div>

                <div class="form-section-title">B. Primary Caregiver / Claimant Information</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="caregiverName">Name of Caregiver / Claimant *</label>
                        <input type="text" id="caregiverName" placeholder="Full Name" required>
                    </div>
                    <div class="form-group">
                        <label for="caregiverRelationship">Relationship to Senior *</label>
                        <select id="caregiverRelationship" required>
                            <option value="Spouse">Spouse</option>
                            <option value="Child">Child (Daughter/Son)</option>
                            <option value="Grandchild">Grandchild</option>
                            <option value="Relative">Relative</option>
                            <option value="Caregiver">Professional Caregiver</option>
                        </select>
                    </div>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="caregiverContact">Contact Number *</label>
                        <input type="tel" id="caregiverContact" placeholder="Contact number of caregiver" pattern="[0-9\+]+" inputmode="numeric" required>
                    </div>
                    <div class="form-group">
                        <label for="caregiverId">Caregiver ID details *</label>
                        <input type="text" id="caregiverId" placeholder="e.g. SSS, UMID, Voters ID" required>
                    </div>
                </div>

                <div class="form-requirements-checklist">
                    <div class="requirement-checklist-title"><i class="fas fa-images"></i> Requirements to prepare for on-site visit:</div>
                    <ul class="requirement-list-ul">
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Printed picture of the senior showing they are bedridden (proving inability to walk)</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Photocopy of Senior Citizen ID</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Photocopy of Caregiver's Government ID</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> OSCA Personnel on-site medical assessment (filled up during office visit)</li>
                    </ul>
                </div>
            `;
        }
        else if (service === 'octogenarian' || service === 'centarian') {
            formTitle.textContent = 'Octogenarian, Nonagenarian and Centenarian Benefit Program';
            formSubtitle.textContent = 'Application Form — Republic Act (R.A.) No. 11982 (NCSC Annex "A")';

            dynamicFormFields.innerHTML = formLogoHeader + `
                <div class="form-section-title">A. PERSONAL INFORMATION</div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="ncscRrn">NCSC Registration Reference Number (RRN) <span style="color:#94a3b8;font-weight:400;">(Optional)</span></label>
                        <input type="text" id="ncscRrn" placeholder="Optional">
                    </div>
                    <div class="form-group">
                        <label for="oscaIdNum">OSCA ID Number *</label>
                        <input type="text" id="oscaIdNum" value="${defaultId}" required>
                    </div>
                    <div class="form-group">
                        <label for="milestoneAge">Applicant Milestone Age *</label>
                        <select id="milestoneAge" required>
                            <option value="80" ${service === 'octogenarian' ? 'selected' : ''}>80</option>
                            <option value="85">85</option>
                            <option value="90">90</option>
                            <option value="95">95</option>
                            <option value="100" ${service === 'centarian' ? 'selected' : ''}>100</option>
                        </select>
                    </div>
                </div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="lastName" title="Last Name">A.1 LN *</label>
                        <input type="text" id="lastName" placeholder="Last Name" value="${defaultLastName}" required>
                    </div>
                    <div class="form-group">
                        <label for="givenName" title="First Name (Given Name)">A.2 FN *</label>
                        <input type="text" id="givenName" value="${defaultFirstName}" required>
                    </div>
                    <div class="form-group">
                        <label for="middleName" title="Middle Initial">A.3 MI</label>
                        <input type="text" id="middleName" placeholder="Middle Name" value="${defaultMiddleName}">
                    </div>
                </div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="dateOfBirth">A.4 Date of Birth (Month/Day/Year) *</label>
                        <input type="date" id="dateOfBirth" value="${defaultDob}" required>
                    </div>
                    <div class="form-group">
                        <label for="age">A.5 Age *</label>
                        <input type="number" id="age" placeholder="Age" min="60" required>
                    </div>
                    <div class="form-group">
                        <label for="sex">A.8 Sex *</label>
                        <select id="sex" required>
                            <option value="Male" ${defaultSex === 'Male' ? 'selected' : ''}>Male</option>
                            <option value="Female" ${defaultSex === 'Female' ? 'selected' : ''}>Female</option>
                        </select>
                    </div>
                </div>

                <div class="form-group" style="margin-top:8px;">
                    <label style="font-weight:700;">A.6 Residential Address / Address Abroad *</label>
                </div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="resHouseNum">House Number</label>
                        <input type="text" id="resHouseNum" placeholder="House No." required>
                    </div>
                    <div class="form-group">
                        <label for="resStreet">Street</label>
                        <input type="text" id="resStreet" placeholder="Street" required>
                    </div>
                    <div class="form-group">
                        <label for="resBarangay">Barangay</label>
                        <input type="text" id="resBarangay" value="${defaultBarangay}" readonly tabindex="-1" title="Locked to your verified barangay" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                    </div>
                    <div class="form-group">
                        <label for="resCityMunicipality">City/Municipality</label>
                        <input type="text" id="resCityMunicipality" value="Magalang" readonly tabindex="-1" title="Fixed to Magalang" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                    </div>
                    <div class="form-group">
                        <label for="resProvince">Province</label>
                        <input type="text" id="resProvince" value="Pampanga" readonly tabindex="-1" title="Fixed to Pampanga" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                    </div>
                    <div class="form-group">
                        <label for="resZipCode">Zip Code</label>
                        <input type="text" id="resZipCode" value="2011" readonly tabindex="-1" title="Fixed to 2011 (Magalang)" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                    </div>
                </div>

                <div class="form-group" style="margin-top:8px;">
                    <label style="font-weight:700;">A.7 Permanent Address in the Philippines *</label>
                    <label style="display:flex; align-items:center; gap:8px; font-weight:500; font-size:0.85rem; color:#475569; cursor:pointer; margin-top:6px;">
                        <input type="checkbox" class="sameAsResidentialChk" style="width:16px; height:16px; cursor:pointer; accent-color:#2563eb;">
                        Residential address is the same as permanent address
                    </label>
                </div>
                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="permHouseNum">House Number</label>
                        <input type="text" id="permHouseNum" placeholder="House No." required>
                    </div>
                    <div class="form-group">
                        <label for="permStreet">Street</label>
                        <input type="text" id="permStreet" placeholder="Street" required>
                    </div>
                    <div class="form-group">
                        <label for="permBarangay">Barangay</label>
                        <input type="text" id="permBarangay" value="${defaultBarangay}" readonly tabindex="-1" title="Locked to your verified barangay" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                    </div>
                    <div class="form-group">
                        <label for="permCityMunicipality">City/Municipality</label>
                        <input type="text" id="permCityMunicipality" value="Magalang" readonly tabindex="-1" title="Fixed to Magalang" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                    </div>
                    <div class="form-group">
                        <label for="permProvince">Province</label>
                        <input type="text" id="permProvince" value="Pampanga" readonly tabindex="-1" title="Fixed to Pampanga" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                    </div>
                    <div class="form-group">
                        <label for="permZipCode">Zip Code</label>
                        <input type="text" id="permZipCode" value="2011" readonly tabindex="-1" title="Fixed to 2011 (Magalang)" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                    </div>
                </div>

                <div class="form-grid-3">
                    <div class="form-group">
                        <label for="civilStatus">A.9 Civil Status *</label>
                        <select id="civilStatus" required>
                            <option value="Single" ${defaultCivil === 'Single' ? 'selected' : ''}>Single</option>
                            <option value="Married" ${defaultCivil === 'Married' ? 'selected' : ''}>Married</option>
                            <option value="Widowed" ${defaultCivil === 'Widowed' ? 'selected' : ''}>Widowed</option>
                            <option value="Others">Others</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="citizenship">A.10 Citizenship *</label>
                        <select id="citizenship" required>
                            <option value="Filipino">Filipino</option>
                            <option value="Dual Citizen">Dual Citizen</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="dualCitizenDetails">If Dual Citizen, kindly indicate details:</label>
                        <input type="text" id="dualCitizenDetails" placeholder="Specify details">
                    </div>
                </div>

                <div class="form-section-title">B. FAMILY INFORMATION</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="spouseName">B.1 Name of Spouse (Last Name, Given Name, Middle Name, Ext.)</label>
                        <input type="text" id="spouseName" placeholder="Spouse Full Name">
                    </div>
                    <div class="form-group">
                        <label for="spouseCitizenship">B.2 Citizenship</label>
                        <input type="text" id="spouseCitizenship" placeholder="e.g. Filipino">
                    </div>
                </div>
                <div class="form-group" style="margin-top:8px;">
                    <label style="font-weight:700;">B.3 Name of Children (Last Name, Given Name, Middle Name, Ext.)</label>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="child1">1.</label>
                        <input type="text" id="child1" placeholder="Child 1 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child2">2.</label>
                        <input type="text" id="child2" placeholder="Child 2 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child3">3.</label>
                        <input type="text" id="child3" placeholder="Child 3 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child4">4.</label>
                        <input type="text" id="child4" placeholder="Child 4 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child5">5.</label>
                        <input type="text" id="child5" placeholder="Child 5 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child6">6.</label>
                        <input type="text" id="child6" placeholder="Child 6 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child7">7.</label>
                        <input type="text" id="child7" placeholder="Child 7 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child8">8.</label>
                        <input type="text" id="child8" placeholder="Child 8 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child9">9.</label>
                        <input type="text" id="child9" placeholder="Child 9 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="child10">10.</label>
                        <input type="text" id="child10" placeholder="Child 10 Full Name">
                    </div>
                </div>

                <div class="form-group" style="margin-top:8px;">
                    <label style="font-weight:700;">B.4 Authorized Representatives (Last Name, Given Name, Middle Name, Ext.)</label>
                </div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="rep1Name">B.4.1 Name of Representative *</label>
                        <input type="text" id="rep1Name" placeholder="Representative 1 Full Name" required>
                    </div>
                    <div class="form-group">
                        <label for="rep1Relationship">Relationship *</label>
                        <input type="text" id="rep1Relationship" placeholder="e.g. Son, Daughter" required>
                    </div>
                    <div class="form-group">
                        <label for="rep2Name">B.4.2 Name of Representative</label>
                        <input type="text" id="rep2Name" placeholder="Representative 2 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="rep2Relationship">Relationship</label>
                        <input type="text" id="rep2Relationship" placeholder="Relationship">
                    </div>
                    <div class="form-group">
                        <label for="rep3Name">B.4.3 Name of Representative</label>
                        <input type="text" id="rep3Name" placeholder="Representative 3 Full Name">
                    </div>
                    <div class="form-group">
                        <label for="rep3Relationship">Relationship</label>
                        <input type="text" id="rep3Relationship" placeholder="Relationship">
                    </div>
                </div>

                <div class="form-section-title">C. CONTACT INFORMATION</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="contactNums">C.1 Contact Numbers (Telephone and Mobile Numbers) *</label>
                        <input type="tel" id="contactNums" placeholder="e.g. 09171234567" value="${defaultCp}" required>
                    </div>
                    <div class="form-group">
                        <label for="emailAddr">C.2 Email Address</label>
                        <input type="email" id="emailAddr" value="${defaultEmail}">
                    </div>
                </div>

                <div class="form-section-title">D. DESIGNATED BENEFICIARY</div>
                <div class="form-grid-2">
                    <div class="form-group">
                        <label for="primaryBeneficiary">D.1 Primary *</label>
                        <input type="text" id="primaryBeneficiary" placeholder="Full Name" required>
                    </div>
                    <div class="form-group">
                        <label for="primaryBeneficiaryRelationship">D.1.1 Relationship *</label>
                        <input type="text" id="primaryBeneficiaryRelationship" placeholder="e.g. Son, Daughter" required>
                    </div>
                    <div class="form-group">
                        <label for="contingentBeneficiary">D.2 Contingent</label>
                        <input type="text" id="contingentBeneficiary" placeholder="Full Name">
                    </div>
                    <div class="form-group">
                        <label for="contingentBeneficiaryRelationship">D.2.2 Relationship</label>
                        <input type="text" id="contingentBeneficiaryRelationship" placeholder="Relationship">
                    </div>
                </div>

                <div class="form-section-title">E. UTILIZATION OF CASH GIFTS (Select all that apply)</div>
                <div class="form-row-checkboxes">
                    <label class="checkbox-label-wrapper">
                        <input type="checkbox" name="cashUtilization" value="Food" checked> Food
                    </label>
                    <label class="checkbox-label-wrapper">
                        <input type="checkbox" name="cashUtilization" value="Medical check-up"> Medical check-up
                    </label>
                    <label class="checkbox-label-wrapper">
                        <input type="checkbox" name="cashUtilization" value="Medicines/Vitamins" checked> Medicines/Vitamins
                    </label>
                    <label class="checkbox-label-wrapper">
                        <input type="checkbox" name="cashUtilization" value="Livelihood / Entrepreneurial Activities"> Livelihood / Entrepreneurial Activities
                    </label>
                    <label class="checkbox-label-wrapper">
                        <input type="checkbox" name="cashUtilization" value="Others"> Others
                    </label>
                </div>
                <div class="form-group" style="margin-top:6px;">
                    <label for="cashUtilOthersSpecify">If Others, kindly specify:</label>
                    <input type="text" id="cashUtilOthersSpecify" placeholder="Specify other utilization">
                </div>

                <div class="form-requirements-checklist">
                    <div class="requirement-checklist-title"><i class="fas fa-file-signature"></i> G. Documentary Requirements (NCSC Annex A):</div>
                    <ul class="requirement-list-ul">
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Duly accomplished Annex A Application Form</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Certificate of Live Birth duly issued or authenticated by the Philippine Statistics Authority (PSA)</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Photocopy of Philippine Identification System ID card / Philippine ID card / National ID card (original copy must be presented)</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Recent 5.08 cm x 5.08 cm (2" x 2") ID picture</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Full body picture of the applicant printed on an A4 size bond/photo paper</li>
                        <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Applicant's inclusion to the endorsed list for validation issued by the Local Chief Executive</li>
                    </ul>
                </div>
            `;
        }
        // Wire the "same as residential" checkbox when the form has one
        wireSameAsResidential(dynamicFormFields);
    }

    // --- Interactive Form Submit Handler ---
    const interactiveServiceForm = document.getElementById('interactiveServiceForm');
    if (interactiveServiceForm) {
        interactiveServiceForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const submitBtn = interactiveServiceForm.querySelector('.form-submit-btn');
            const originalText = submitBtn.innerHTML;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing Request...';
            submitBtn.disabled = true;

            try {
                // ── ACCESS GUARD: never submit a service request unverified ──
                if (!isServiceAccessAllowed()) {
                    showToast('⚠️ You must get verified first before applying for services.');
                    sidebarLinks.forEach(l => l.classList.remove('active'));
                    switchTab('dashboard');
                    submitBtn.innerHTML = originalText;
                    submitBtn.disabled = false;
                    return;
                }

                // ── DUPLICATE GUARD (submit): one active request per type ────
                // Re-check live claim data (not the dashboard cache) so a
                // senior can never queue a second Burial / Bedridden request
                // while the previous one is still awaiting OSCA approval.
                try {
                    const dupUid = currentUserData ? currentUserData.uid : null;
                    if (dupUid) {
                        const myClaimsSnap = await get(query(ref(db, 'claims'), orderByChild('uid'), equalTo(dupUid)));
                        const dupActive = findActiveRequestForService(activeServiceType, Object.values(myClaimsSnap.val() || {}));
                        if (dupActive) {
                            const dupTitle = serviceTitleFromType(dupActive.serviceType) || activeServiceType;
                            showToast(`⚠️ You already have a ${dupTitle} request (status: ${String(dupActive.status)}). You may submit a new one once it is approved or declined by OSCA.`);
                            submitBtn.innerHTML = originalText;
                            submitBtn.disabled = false;
                            return;
                        }
                    }
                } catch (dupErr) {
                    console.warn('Duplicate-request check failed; allowing submission:', dupErr);
                }

                // Collect all form inputs as a FLAT plain-string map.
                // IMPORTANT: the Firebase RTDB client SDK rejects arrays and
                // empty/invalid keys in push() values ("contains an invalid
                // key (0) in property 'claims.formData'"). So checkbox groups
                // are stored as comma-joined strings (NOT arrays), and
                // unnamed checkboxes like the urgent toggle (handled
                // separately below) are skipped.
                // Re-lock Annex A address to the fixed service area first
                // (Magalang, Pampanga 2011 + verified barangay — tamper-proof).
                syncSameAsResidential(interactiveServiceForm);
                lockAnnexAAddressFields(interactiveServiceForm, ((currentUserData && currentUserData.barangay) || '').trim());
                const formData = {};
                const inputs = interactiveServiceForm.querySelectorAll('input, select, textarea');
                inputs.forEach(input => {
                    if (input.type === 'checkbox') {
                        if (!input.checked) return;
                        const key = (input.name || input.id).trim();
                        if (!key || key === 'urgentRequestToggle') return;
                        formData[key] = formData[key]
                            ? formData[key] + ', ' + input.value
                            : input.value;
                    } else {
                        const key = (input.id || input.name || '').trim();
                        if (!key || key === 'urgentRequestToggle') return;
                        formData[key] = input.value;
                    }
                });

                const phoneFields = ['claimantContact', 'caregiverContact', 'contactNums'];
                for (const fieldId of phoneFields) {
                    const el = document.getElementById(fieldId);
                    if (el && el.value && !isValidPhone(el.value)) {
                        showToast(`⚠️ Please enter a valid contact number in the ${el.closest('.form-group')?.querySelector('label')?.textContent || fieldId} field.`);
                        el.focus();
                        submitBtn.innerHTML = originalText;
                        submitBtn.disabled = false;
                        return;
                    }
                }

                // Emergency Urgent Request ("Request only") — senior must opt in honestly
                const urgentToggleEl = document.getElementById('urgentRequestToggle');
                const isUrgentRequest = !!(urgentToggleEl && urgentToggleEl.checked);

                // Final safety net before pushing to Firebase: force formData
                // into a plain map of string values under valid string keys.
                // Firebase RTDB rejects arrays (numeric keys), undefined/NaN
                // values, and keys containing ".", "#", "$", "/", "[", "]".
                const sanitizeForFirebase = (obj) => {
                    const clean = {};
                    Object.entries(obj || {}).forEach(([k, v]) => {
                        const safeKey = String(k).replace(/[\[\].#$\/\u0000-\u001F]/g, '').trim();
                        if (!safeKey || v === undefined || v === null) return;
                        if (typeof v === 'object') {
                            clean[safeKey] = Array.isArray(v)
                                ? v.map(x => String(x)).join(', ')
                                : JSON.stringify(v);
                        } else if (typeof v === 'number' && !isFinite(v)) {
                            return;
                        } else {
                            clean[safeKey] = String(v);
                        }
                    });
                    return clean;
                };
                const safeFormData = sanitizeForFirebase(formData);

                // Prepare claim structure for Firebase
                const newClaim = {
                    uid: currentUserData ? currentUserData.uid : 'GUEST_UID',
                    applicantName: currentUserData ? currentUserData.name : 'Unknown Applicant',
                    serviceType: activeServiceType,
                    formData: safeFormData,
                    urgentRequest: isUrgentRequest,
                    urgentRequestedAt: isUrgentRequest ? Date.now() : null,
                    status: 'Pending',
                    createdAt: Date.now()
                };

                // Push claim to firebase real-time database
                await push(ref(db, 'claims'), newClaim);

                // Refresh the dashboard Request Assistance card right away
                loadMyServiceRequests();

                // Show Success Notification Toast
                showToast(isUrgentRequest
                    ? `🚨 URGENT ${activeServiceType.toUpperCase()} request submitted! OSCA staff will prioritize it.`
                    : `Assistance request for ${activeServiceType.toUpperCase()} submitted successfully!`);

                // Auto-open the PDF copy for client's record!
                triggerPdfDownload();

                // Go back to dashboard after 2 seconds
                setTimeout(() => {
                    sidebarLinks.forEach(l => l.classList.remove('active'));
                    switchTab('dashboard');
                    submitBtn.innerHTML = originalText;
                    submitBtn.disabled = false;
                }, 2000);

            } catch (err) {
                console.error("Submission failed:", err);
                alert("Failed to submit request: " + err.message);
                submitBtn.innerHTML = originalText;
                submitBtn.disabled = false;
            }
        });
    }

    // --- Download .pdf Button Click ---
    const formDownloadBtn = document.getElementById('formDownloadBtn');
    if (formDownloadBtn) {
        formDownloadBtn.addEventListener('click', (e) => {
            e.preventDefault();
            triggerPdfDownload();
        });
    }

    // --- PDF Form Template Generator & Download (print to PDF, no new dependencies) ---
    function triggerPdfDownload() {
        const service = activeServiceType;
        let filename = 'SilverCare_Application.pdf';
        let docTitle = 'SilverCare Application Form';
        let bodyHtml = '';

        if (service === 'burial') {
            filename = 'SilverCare_Burial_Assistance_Form.pdf';
            docTitle = 'Burial Assistance Claim Form';

            const decName = document.getElementById('deceasedName')?.value || '_______________________';
            const decId = document.getElementById('deceasedOscaId')?.value || '_______________________';
            const deathDate = document.getElementById('dateOfDeath')?.value || '_______________________';
            const causeD = document.getElementById('causeOfDeath')?.value || '_______________________';
            const claimN = document.getElementById('claimantName')?.value || '_______________________';
            const rel = document.getElementById('claimantRelationship')?.value || '_______________________';
            const claimId = document.getElementById('claimantIdType')?.value || '_______________________';
            const contact = document.getElementById('claimantContact')?.value || '_______________________';

            bodyHtml = `
                <div class="title-block">
                    <h2>OFFICE OF THE SENIOR CITIZENS AFFAIRS (OSCA)</h2>
                    <h3>Magalang, Pampanga, Philippines</h3>
                    <h1>BURIAL ASSISTANCE CLAIM APPLICATION</h1>
                </div>

                <div class="section-title">A. DECEASED SENIOR CITIZEN DATA</div>
                <table>
                    <tr>
                        <th width="30%">Deceased Senior Citizen Name</th>
                        <td><strong>${decName.toUpperCase()}</strong></td>
                    </tr>
                    <tr>
                        <th>OSCA Senior Citizen ID Number</th>
                        <td>${decId}</td>
                    </tr>
                    <tr>
                        <th>Date of Death</th>
                        <td>${deathDate}</td>
                    </tr>
                    <tr>
                        <th>Declared Cause of Death</th>
                        <td>${causeD}</td>
                    </tr>
                </table>

                <div class="section-title">B. CLAIMANT & BENEFICIARY INFORMATION</div>
                <table>
                    <tr>
                        <th width="30%">Claimant Full Name</th>
                        <td>${claimN}</td>
                    </tr>
                    <tr>
                        <th>Relationship to Deceased</th>
                        <td>${rel}</td>
                    </tr>
                    <tr>
                        <th>Type of Valid ID Submitted</th>
                        <td>${claimId}</td>
                    </tr>
                    <tr>
                        <th>Contact Number</th>
                        <td>${contact}</td>
                    </tr>
                </table>

                <div class="section-title">C. ELIGIBILITY CHECKS & OSCA ENDORSEMENT</div>
                <p>The claimant certifies under oath that the declared information is completely true and correct. Upon receipt of this form and validation of the original documents listed below, OSCA Magalang will issue a formal <strong>DSWD Endorsement Letter</strong> for social relief disbursement.</p>
                
                <h3>Requirements Submitted:</h3>
                <ul>
                    <li>[ ] Original Certified Death Certificate</li>
                    <li>[ ] Barangay Indigency Certificate of Claimant</li>
                    <li>[ ] Original Senior Citizen ID Card of Deceased</li>
                    <li>[ ] Photocopy of Claimant's Valid ID</li>
                </ul>

                <br><br><br>
                <table style="border:none;">
                    <tr style="border:none;">
                        <td style="border:none; text-align:center;" width="50%">
                            _____________________________________<br>
                            <strong>Signature of Applicant Claimant</strong>
                        </td>
                        <td style="border:none; text-align:center;">
                            _____________________________________<br>
                            <strong>OSCA Officer Validation Signature</strong>
                        </td>
                    </tr>
                </table>
            `;
        }
        else if (service === 'bedridden') {
            filename = 'SilverCare_Bedridden_Assistance_Form.pdf';
            docTitle = 'Bedridden Senior Assessment Form';

            const name = document.getElementById('bedriddenName')?.value || '_______________________';
            const osca = document.getElementById('bedriddenOscaId')?.value || '_______________________';
            const dob = document.getElementById('bedriddenDob')?.value || '_______________________';
            const sex = document.getElementById('bedriddenSex')?.value || '_______________________';
            const civil = document.getElementById('bedriddenCivil')?.value || '_______________________';
            const addr = document.getElementById('bedriddenAddress')?.value || '_______________________';
            const cond = document.getElementById('bedriddenCondition')?.value || '_______________________';
            const cgName = document.getElementById('caregiverName')?.value || '_______________________';
            const cgRel = document.getElementById('caregiverRelationship')?.value || '_______________________';
            const cgCont = document.getElementById('caregiverContact')?.value || '_______________________';
            const cgId = document.getElementById('caregiverId')?.value || '_______________________';

            bodyHtml = `
                <div class="title-block">
                    <h2>OFFICE OF THE SENIOR CITIZENS AFFAIRS (OSCA)</h2>
                    <h3>Magalang, Pampanga, Philippines</h3>
                    <h1>BEDRIDDEN CITIZEN WELFARE ASSESSMENT & AID REQUEST</h1>
                </div>

                <div class="section-title">A. SENIOR PROFILE</div>
                <table>
                    <tr>
                        <th width="30%">Bedridden Senior Name</th>
                        <td><strong>${name.toUpperCase()}</strong></td>
                        <th width="20%">OSCA ID</th>
                        <td>${osca}</td>
                    </tr>
                    <tr>
                        <th>Date of Birth</th>
                        <td>${dob}</td>
                        <th>Sex / Status</th>
                        <td>${sex} / ${civil}</td>
                    </tr>
                    <tr>
                        <th>Complete Address</th>
                        <td colspan="3">${addr}</td>
                    </tr>
                </table>

                <div class="section-title">B. MEDICAL REASONS & DISABILITY DETAILS</div>
                <table>
                    <tr>
                        <th width="30%">Detailed Condition Description</th>
                        <td>${cond}</td>
                    </tr>
                </table>

                <div class="section-title">C. PRIMARY CAREGIVER / REPRESENTATIVE DETAILS</div>
                <table>
                    <tr>
                        <th width="30%">Caregiver Full Name</th>
                        <td>${cgName}</td>
                        <th width="20%">Relationship</th>
                        <td>${cgRel}</td>
                    </tr>
                    <tr>
                        <th>Contact Number</th>
                        <td>${cgCont}</td>
                        <th>Representative ID</th>
                        <td>${cgId}</td>
                    </tr>
                </table>

                <div class="section-title">D. INTERNAL OFFICE ASSESSMENT (FILLED UP BY NCSC STAFF)</div>
                <p>This section is reserved for the OSCA Magalang social assessment and home visit review team.</p>
                <table>
                    <tr>
                        <th width="30%">Date of On-site Visit</th>
                        <td>[ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; / &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; / 2026 ]</td>
                    </tr>
                    <tr>
                        <th>Recommended Action</th>
                        <td>[ &nbsp;&nbsp; ] Approved Care Packages &nbsp;&nbsp;&nbsp;&nbsp; [ &nbsp;&nbsp; ] Secondary Medical Aid &nbsp;&nbsp;&nbsp;&nbsp; [ &nbsp;&nbsp; ] Ineligible</td>
                    </tr>
                    <tr>
                        <th>Assessment Officer Notes</th>
                        <td style="height: 60px;"></td>
                    </tr>
                </table>

                <br><br><br>
                <table style="border:none;">
                    <tr style="border:none;">
                        <td style="border:none; text-align:center;" width="50%">
                            _____________________________________<br>
                            <strong>Signature of Family Representative</strong>
                        </td>
                        <td style="border:none; text-align:center;">
                            _____________________________________<br>
                            <strong>NCSC Magalang Home Visit Inspector</strong>
                        </td>
                    </tr>
                </table>
            `;
        }
        else if (service === 'octogenarian' || service === 'centarian') {
            filename = `SilverCare_${service.toUpperCase()}_Benefit_AnnexA.pdf`;
            docTitle = 'NCSC Annex A Benefit Claim Form';

            const rrn = document.getElementById('ncscRrn')?.value || 'N/A';
            const osca = document.getElementById('oscaIdNum')?.value || '_______________________';
            const milestone = document.getElementById('milestoneAge')?.value || '80';
            const ln = document.getElementById('lastName')?.value || '_______________________';
            const gn = document.getElementById('givenName')?.value || '_______________________';
            const mn = document.getElementById('middleName')?.value || '_______________________';
            const dob = document.getElementById('dateOfBirth')?.value || '_______________________';
            const age = document.getElementById('age')?.value || '____';
            const sex = document.getElementById('sex')?.value || '_______________________';
            const civil = document.getElementById('civilStatus')?.value || '_______________________';
            const citizen = document.getElementById('citizenship')?.value || 'Filipino';
            const rAddr = document.getElementById('residentialAddress')?.value || '_______________________';
            const pAddr = document.getElementById('permanentAddress')?.value || '_______________________';
            const spouse = document.getElementById('spouseName')?.value || 'N/A';
            const spouseCit = document.getElementById('spouseCitizenship')?.value || 'N/A';
            const children = document.getElementById('childrenNames')?.value || 'N/A';
            const rep = document.getElementById('repName')?.value || '_______________________';
            const contacts = document.getElementById('contactNums')?.value || '_______________________';
            const email = document.getElementById('emailAddr')?.value || 'N/A';
            const primBen = document.getElementById('primaryBeneficiary')?.value || '_______________________';
            const contBen = document.getElementById('contingentBeneficiary')?.value || 'N/A';

            // Check checkboxes
            const cbChecked = [];
            document.querySelectorAll('input[name="cashUtilization"]:checked').forEach(cb => {
                cbChecked.push(cb.value);
            });
            const utilizationStr = cbChecked.join(', ') || 'Food, Medicines/Vitamins';

            bodyHtml = `
                <div class="title-block">
                    <h2>Republic of the Philippines<br>Office of the President</h2>
                    <h3>NATIONAL COMMISSION OF SENIOR CITIZENS</h3>
                    <h1>APPLICATION FORM (ANNEX A)</h1>
                    <h3>OCTOGENARIAN, NONAGENARIAN AND CENTENARIAN BENEFIT PROGRAM</h3>
                </div>

                <div class="section-title">ADMINISTRATIVE CLASSIFICATION</div>
                <table>
                    <tr>
                        <th width="35%">NCSC Registration Ref Number (RRN)</th>
                        <td>${rrn}</td>
                        <th width="20%">OSCA ID Number</th>
                        <td><strong>${osca}</strong></td>
                    </tr>
                    <tr>
                        <th>Milestone Claiming Age</th>
                        <td colspan="3"><strong>[ X ] ${milestone} Years Old Milestone</strong></td>
                    </tr>
                </table>

                <div class="section-title">A. PERSONAL INFORMATION</div>
                <table>
                    <tr>
                        <th width="25%">Last Name</th>
                        <td width="25%">${ln.toUpperCase()}</td>
                        <th width="25%">Given Name</th>
                        <td width="25%">${gn.toUpperCase()}</td>
                    </tr>
                    <tr>
                        <th>Middle Name</th>
                        <td>${mn}</td>
                        <th>Date of Birth / Age</th>
                        <td>${dob} / ${age} yrs</td>
                    </tr>
                    <tr>
                        <th>Sex</th>
                        <td>${sex}</td>
                        <th>Civil Status</th>
                        <td>${civil}</td>
                    </tr>
                    <tr>
                        <th>Citizenship</th>
                        <td colspan="3">${citizen}</td>
                    </tr>
                    <tr>
                        <th>Residential Address</th>
                        <td colspan="3">${rAddr}</td>
                    </tr>
                    <tr>
                        <th>Permanent Address</th>
                        <td colspan="3">${pAddr}</td>
                    </tr>
                </table>

                <div class="section-title">B. FAMILY INFORMATION</div>
                <table>
                    <tr>
                        <th width="25%">Spouse Full Name</th>
                        <td>${spouse}</td>
                        <th width="25%">Spouse Citizenship</th>
                        <td>${spouseCit}</td>
                    </tr>
                    <tr>
                        <th>Names of Children</th>
                        <td colspan="3">${children}</td>
                    </tr>
                    <tr>
                        <th>Authorized Representative</th>
                        <td colspan="3">${rep}</td>
                    </tr>
                </table>

                <div class="section-title">C. CONTACT & DESIGNATED BENEFICIARY</div>
                <table>
                    <tr>
                        <th width="25%">Contact Numbers</th>
                        <td>${contacts}</td>
                        <th width="25%">Email Address</th>
                        <td>${email}</td>
                    </tr>
                    <tr>
                        <th>Primary Beneficiary</th>
                        <td colspan="3">${primBen}</td>
                    </tr>
                    <tr>
                        <th>Contingent Beneficiary</th>
                        <td colspan="3">${contBen}</td>
                    </tr>
                </table>

                <div class="section-title">D. UTILIZATION OF CASH GIFTS</div>
                <p>The applicant intends to utilize the cash gifts for: <strong>${utilizationStr}</strong></p>

                <div class="section-title">E. VALIDATION REPORT & OATH STATEMENT</div>
                <p>By signing this application, the applicant or authorized representative swears under penalty of perjury that the foregoing facts are fully true. This document serves as proof of online soft-filling registration under R.A. No. 11982.</p>
                
                <br><br><br>
                <table style="border:none;">
                    <tr style="border:none;">
                        <td style="border:none; text-align:center;" width="50%">
                            _____________________________________<br>
                            <strong>Signature of Senior Applicant</strong>
                        </td>
                        <td style="border:none; text-align:center;">
                            _____________________________________<br>
                            <strong>NCSC Validator Official Signature</strong>
                        </td>
                    </tr>
                </table>
            `;
        }

        // Call helper
        downloadPdfForm(filename, docTitle, bodyHtml);
    }

    // --- Helper: open a print-friendly window so the user saves it as PDF ---
    // Uses the browser print dialog (Destination -> Save as PDF) with zero new
    // dependencies — same pattern as the admin report PDF export.
    function escapeFormHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function downloadPdfForm(filename, title, htmlBody) {
        const w = window.open('', '_blank', 'width=1000,height=750');
        if (!w) {
            showToast('Please allow pop-ups to download the PDF form.');
            return;
        }
        const safeTitle = escapeFormHtml(title);
        const safeFilename = escapeFormHtml(filename);
        const header = `<!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>${safeTitle}</title>
        <style>
            body { font-family: 'Arial', sans-serif; font-size: 11pt; color: #333333; line-height: 1.5; padding: 32px; }
            h1, h2, h3 { color: #1e3a8a; margin-top: 5px; margin-bottom: 5px; }
            h1 { font-size: 16pt; }
            h2 { font-size: 13pt; }
            h3 { font-size: 11pt; }
            table { border-collapse: collapse; width: 100%; margin: 15px 0; }
            th, td { border: 1px solid #cbd5e1; padding: 10px; text-align: left; font-size: 10pt; }
            th { background-color: #f1f5f9; font-weight: bold; color: #1e293b; }
            .title-block { text-align: center; border-bottom: 2px solid #1e3a8a; padding-bottom: 12px; margin-bottom: 25px; }
            .section-title { background-color: #3b82f6; color: white; padding: 8px 12px; font-weight: bold; margin-top: 25px; font-size: 11pt; }
            ul { margin-top: 5px; margin-bottom: 5px; padding-left: 20px; }
            li { font-size: 10pt; line-height: 1.4; margin-bottom: 4px; }
            p { font-size: 10pt; margin-top: 5px; margin-bottom: 10px; }
            .pdf-hint { margin-top: 22px; color: #64748b; font-size: 10pt; }
            @media print {
                .pdf-hint { display: none; }
                body { padding: 0; }
                @page { size: A4; margin: 14mm; }
            }
        </style>
        </head>
        <body>
            ${htmlBody}
            <p class="pdf-hint">In the print dialog, choose <strong>Save as PDF</strong> as the destination to save <strong>${safeFilename}</strong>.</p>
        </body>
        </html>`;

        w.document.write(header);
        w.document.close();
        w.focus();
        try { w.document.title = filename; } catch (e) { /* title hint only */ }
        setTimeout(() => { try { w.print(); } catch (e) { /* user can print manually */ } }, 400);
    }

    // --- Toast Handler ---
    function showToast(message) {
        const toast = document.getElementById('successToast');
        const toastMsg = document.getElementById('toastMessage');
        if (toast && toastMsg) {
            toastMsg.textContent = message;
            toast.classList.add('active');
            setTimeout(() => {
                toast.classList.remove('active');
            }, 3000);
        }
    }
    // ══════════════════════════════════════════════════════════════════
    // ONLINE APPOINTMENT — Scheduling & Queuing (per thesis)
    // Online booking + automatic queue number + attendance
    // (Attended / Missed / Rescheduled) + daily schedule.
    // ══════════════════════════════════════════════════════════════════
    let rescheduleQueueId = null;

    async function seniorAuthHeaders() {
        const user = auth.currentUser;
        if (!user) throw new Error('Not signed in.');
        const token = await user.getIdToken();
        return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
    }

    function apptStatusBadge(status) {
        const s = status || 'Pending';
        const map = {
            'Pending': 'background:#e0f2fe; color:#0284c7;',
            'Rescheduled': 'background:#ffedd5; color:#c2410c;',
            'Approved': 'background:#dcfce7; color:#15803d;',
            'Attended': 'background:#dcfce7; color:#15803d;',
            'Declined': 'background:#fee2e2; color:#b91c1c;',
            'Missed': 'background:#fee2e2; color:#b91c1c;',
            'Cancelled': 'background:#f1f5f9; color:#64748b;'
        };
        return `<span style="font-size:0.75rem; padding:4px 10px; border-radius:12px; font-weight:700; ${map[s] || map['Pending']}">${s}</span>`;
    }

    function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function loadMyAppointments(uid) {
        const listEl = document.getElementById('apptList');
        const badge = document.getElementById('seniorQueueBadge');
        const qNumEl = document.getElementById('seniorQueueNumber');
        const qDetailEl = document.getElementById('seniorQueueDetail');
        const qStatusEl = document.getElementById('seniorQueueStatus');
        try {
            const headers = await seniorAuthHeaders();
            const res = await fetch(`/api/queues/${uid}`, { headers });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Failed to load appointments.');
            renderMyAppointments(data.queues || []);
        } catch (err) {
            console.error('Load appointments error:', err);
            if (listEl) listEl.innerHTML = `<div style="text-align:center; color:#ef4444; padding:24px;">Failed to load your appointments. <button id="apptRetryBtn" style="margin-left:6px; border:1px solid #cbd5e1; background:white; border-radius:8px; padding:6px 12px; cursor:pointer; font-weight:700;">Retry</button></div>`;
            const retry = document.getElementById('apptRetryBtn');
            if (retry) retry.onclick = () => loadMyAppointments(uid);
            if (badge) badge.textContent = 'No Booking';
            if (qNumEl) qNumEl.textContent = '—';
            if (qDetailEl) qDetailEl.textContent = 'No active appointment yet.';
            if (qStatusEl) qStatusEl.innerHTML = '';
        }
    }

    function renderMyAppointments(queues) {
        const listEl = document.getElementById('apptList');
        const badge = document.getElementById('seniorQueueBadge');
        const qNumEl = document.getElementById('seniorQueueNumber');
        const qDetailEl = document.getElementById('seniorQueueDetail');
        const qStatusEl = document.getElementById('seniorQueueStatus');
        if (!listEl) return;

        const sorted = [...queues].sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
        const active = sorted.find(q => ['Pending', 'Rescheduled', 'Approved'].includes(q.status));

        const apptBookBtnEl = document.getElementById('apptBookBtn');
        const apptPendingAlert = document.getElementById('apptPendingAlert');
        const apptPendingAlertText = document.getElementById('apptPendingAlertText');

        if (active) {
            if (badge) {
                badge.textContent = active.queueNumber || 'Booked';
                badge.style.background = '#dcfce7';
                badge.style.color = '#15803d';
            }
            if (qNumEl) qNumEl.textContent = active.queueNumber || '—';
            if (qDetailEl) qDetailEl.textContent = `${active.service || 'Visit'} — ${active.date || ''} at ${active.time || ''}`;
            if (qStatusEl) qStatusEl.innerHTML = apptStatusBadge(active.status);
            if (apptPendingAlert && apptPendingAlertText) {
                apptPendingAlertText.textContent = active.status === 'Approved'
                    ? `Your appointment is approved — ${active.queueNumber || 'your queue'} · ${active.service || 'visit'} on ${active.date || ''} at ${active.time || ''}. Please arrive 15 minutes early.`
                    : `You still have a pending booking — ${active.queueNumber || 'your queue'} · ${active.service || 'visit'} on ${active.date || ''} at ${active.time || ''}. Please reschedule or cancel it before booking a new one.`;
                apptPendingAlert.style.display = 'block';
            }
            if (apptBookBtnEl) {
                apptBookBtnEl.disabled = true;
                apptBookBtnEl.style.opacity = '0.6';
                apptBookBtnEl.style.cursor = 'not-allowed';
                apptBookBtnEl.title = active.status === 'Approved'
                    ? 'You already have an approved appointment — cancel it first to book a new one'
                    : 'You already have a pending booking — reschedule or cancel it first';
            }
        } else {
            if (badge) {
                badge.textContent = 'No Booking';
                badge.style.background = '#e0f2fe';
                badge.style.color = '#0284c7';
            }
            if (qNumEl) qNumEl.textContent = '—';
            if (qDetailEl) qDetailEl.textContent = 'No active appointment yet.';
            if (qStatusEl) qStatusEl.innerHTML = '';
            if (apptPendingAlert) apptPendingAlert.style.display = 'none';
            if (apptBookBtnEl) {
                apptBookBtnEl.disabled = false;
                apptBookBtnEl.style.opacity = '';
                apptBookBtnEl.style.cursor = '';
                apptBookBtnEl.title = '';
            }
        }

        if (sorted.length === 0) {
            listEl.innerHTML = `<div style="text-align:center; color:#94a3b8; padding:30px 0;">
                <i class="fas fa-calendar-check" style="font-size:2rem; margin-bottom:8px; display:block; opacity:0.4;"></i>
                No appointments yet. Book your visit above to get a queue number.
            </div>`;
            return;
        }

        listEl.innerHTML = '';
        sorted.forEach(q => {
            const canResched = ['Pending', 'Rescheduled'].includes(q.status);
            const canCancel = ['Pending', 'Rescheduled', 'Approved'].includes(q.status);
            const row = document.createElement('div');
            row.className = 'health-log-item';
            row.innerHTML = `
                <div class="health-log-left">
                    <div class="health-log-icon-square" style="background:#dbeafe; color:#2563eb;">
                        <i class="fas fa-calendar-check"></i>
                    </div>
                    <div>
                        <div class="health-log-type">${escapeHtml(q.service || 'Visit')} · ${escapeHtml(q.queueNumber || '')}</div>
                        <div class="health-log-meta">${escapeHtml(q.date || '')} at ${escapeHtml(q.time || '')}</div>
                        <div class="health-log-details">${escapeHtml(q.note || 'Please arrive 15 minutes early.')}</div>
                        <div style="margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                            ${apptStatusBadge(q.status)}
                            ${canResched ? `
                                <button data-act="resched" data-id="${escapeHtml(q.id)}" style="border:1px solid #93c5fd; background:#eff6ff; color:#1d4ed8; border-radius:8px; padding:6px 12px; cursor:pointer; font-weight:700; font-size:0.8rem;">Reschedule</button>
                            ` : ''}
                            ${canCancel ? `
                                <button data-act="cancel" data-id="${escapeHtml(q.id)}" style="border:1px solid #fca5a5; background:#fef2f2; color:#b91c1c; border-radius:8px; padding:6px 12px; cursor:pointer; font-weight:700; font-size:0.8rem;">Cancel</button>
                            ` : ''}
                        </div>
                    </div>
                </div>
                <span class="health-log-date">${escapeHtml(q.queueNumber || '')}</span>
            `;
            listEl.appendChild(row);
        });

        listEl.querySelectorAll('button[data-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-id');
                if (btn.getAttribute('data-act') === 'resched') openReschedModal(id);
                else cancelAppointment(id);
            });
        });
    }

    const apptBookBtn = document.getElementById('apptBookBtn');
    if (apptBookBtn) {
        const dateInput = document.getElementById('apptDate');
        if (dateInput) dateInput.min = new Date().toISOString().slice(0, 10);
        apptBookBtn.addEventListener('click', async () => {
            const date = document.getElementById('apptDate')?.value || '';
            const time = document.getElementById('apptTime')?.value || '';
            const service = document.getElementById('apptService')?.value.trim() || '';
            const note = document.getElementById('apptNote')?.value.trim() || '';
            if (!date || !time) { showToast('⚠️ Please select a visit date and time.'); return; }
            if (!service) { showToast('⚠️ Please enter purpose of visit.'); return; }
            if (document.getElementById('apptPendingAlert')?.style.display === 'block') {
                const txt = document.getElementById('apptPendingAlertText')?.textContent || 'You still have a pending booking. Please reschedule or cancel it before booking a new one.';
                showToast('⚠️ ' + txt);
                return;
            }
            apptBookBtn.disabled = true;
            const original = apptBookBtn.innerHTML;
            apptBookBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Booking...';
            try {
                const headers = await seniorAuthHeaders();
                const res = await fetch('/api/queue/book', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ date, time, service, note })
                });
                const data = await res.json();
                if (!data.success) throw new Error(data.message || 'Booking failed.');
                showToast(`Booked! Your queue number is ${data.queueNumber}.`);
                const noteEl = document.getElementById('apptNote');
                if (noteEl) noteEl.value = '';
                if (auth.currentUser) await loadMyAppointments(auth.currentUser.uid);
            } catch (err) {
                console.error('Book appointment error:', err);
                showToast('⚠️ ' + err.message);
                if (err.message && err.message.toLowerCase().includes('still have a pending')) {
                    if (auth.currentUser) loadMyAppointments(auth.currentUser.uid);
                }
            } finally {
                // Re-enable only if no active pending booking is blocking the form;
                // renderMyAppointments will disable it again when needed.
                const alertVisible = document.getElementById('apptPendingAlert')?.style.display !== 'none';
                if (!alertVisible) {
                    apptBookBtn.disabled = false;
                }
                apptBookBtn.innerHTML = original;
            }
        });
    }

    const apptRefreshBtn = document.getElementById('apptRefreshBtn');
    if (apptRefreshBtn) {
        apptRefreshBtn.addEventListener('click', () => {
            if (auth.currentUser) loadMyAppointments(auth.currentUser.uid);
        });
    }

    function openReschedModal(queueId) {
        rescheduleQueueId = queueId;
        const modal = document.getElementById('apptReschedModal');
        const dateEl = document.getElementById('apptReschedDate');
        if (dateEl) dateEl.min = new Date().toISOString().slice(0, 10);
        if (modal) modal.style.display = 'flex';
    }

    const apptReschedClose = document.getElementById('apptReschedClose');
    if (apptReschedClose) {
        apptReschedClose.onclick = () => {
            document.getElementById('apptReschedModal').style.display = 'none';
            rescheduleQueueId = null;
        };
    }

    const apptReschedConfirmBtn = document.getElementById('apptReschedConfirmBtn');
    if (apptReschedConfirmBtn) {
        apptReschedConfirmBtn.addEventListener('click', async () => {
            if (!rescheduleQueueId) return;
            const date = document.getElementById('apptReschedDate')?.value || '';
            const time = document.getElementById('apptReschedTime')?.value || '';
            if (!date || !time) { showToast('⚠️ Please select a new date and time.'); return; }
            apptReschedConfirmBtn.disabled = true;
            try {
                const headers = await seniorAuthHeaders();
                const res = await fetch(`/api/queue/${rescheduleQueueId}/reschedule`, {
                    method: 'PUT',
                    headers,
                    body: JSON.stringify({ date, time })
                });
                const data = await res.json();
                if (!data.success) throw new Error(data.message || 'Reschedule failed.');
                showToast(`Rescheduled! New queue number: ${data.queueNumber}.`);
                document.getElementById('apptReschedModal').style.display = 'none';
                rescheduleQueueId = null;
                if (auth.currentUser) await loadMyAppointments(auth.currentUser.uid);
            } catch (err) {
                console.error('Reschedule error:', err);
                showToast('⚠️ ' + err.message);
            } finally {
                apptReschedConfirmBtn.disabled = false;
            }
        });
    }

    async function cancelAppointment(queueId) {
        if (!confirm('Cancel this appointment?')) return;
        try {
            const headers = await seniorAuthHeaders();
            const res = await fetch(`/api/queue/${queueId}`, { method: 'DELETE', headers });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Cancel failed.');
            showToast('Appointment cancelled.');
            if (auth.currentUser) await loadMyAppointments(auth.currentUser.uid);
        } catch (err) {
            console.error('Cancel error:', err);
            showToast('⚠️ ' + err.message);
        }
    }

    window.openMedicationModal = function () {
        const modal = document.getElementById('medicationRequestModal');
        if (modal) {
            modal.style.display = 'flex';
            listenToSeniorMedicationRequests();
        }
    };

    let seniorMedicationRequestsUnsub = null;
    function listenToSeniorMedicationRequests() {
        if (!currentUserData) return;
        const listContainer = document.getElementById('medicationRequestsList');
        if (!listContainer) return;

        if (seniorMedicationRequestsUnsub) seniorMedicationRequestsUnsub();

        seniorMedicationRequestsUnsub = onValue(ref(db, `users/${currentUserData.uid}/medicationRequests`), (snapshot) => {
            const data = snapshot.exists() ? snapshot.val() : null;
            if (!data) {
                listContainer.innerHTML = `
                    <div style="text-align:center; color:#94a3b8; padding:20px;">
                        <i class="fas fa-pills" style="font-size:1.8rem; margin-bottom:8px; display:block; opacity:0.5;"></i>
                        No refill requests submitted yet.
                    </div>`;
                return;
            }

            const entries = Object.entries(data).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
            listContainer.innerHTML = '';

            entries.forEach(([key, req]) => {
                const status = req.status || 'Pending';
                let statusBadge = '<span style="background: #ffedd5; color: #ea580c; padding: 4px 10px; border-radius: 20px; font-weight: 700; font-size: 0.78rem;">Pending Review</span>';
                let borderLeftColor = '#f59e0b';

                if (status === 'Approved') {
                    statusBadge = '<span style="background: #dcfce7; color: #15803d; padding: 4px 10px; border-radius: 20px; font-weight: 700; font-size: 0.78rem;">Approved ✓</span>';
                    borderLeftColor = '#22c55e';
                } else if (status === 'No Available Pills' || status === 'Unavailable' || status === 'Declined') {
                    statusBadge = '<span style="background: #fee2e2; color: #ef4444; padding: 4px 10px; border-radius: 20px; font-weight: 700; font-size: 0.78rem;">No Available Pills</span>';
                    borderLeftColor = '#ef4444';
                }

                const dateStr = req.createdAt ? new Date(req.createdAt).toLocaleString() : 'Recently';

                listContainer.innerHTML += `
                    <div style="border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; background: #f8fafc; border-left: 4px solid ${borderLeftColor}; display: flex; flex-direction: column; gap: 6px;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                            <h5 style="margin: 0; color: #1e293b; font-size: 0.95rem; font-weight: 700;">${req.medicationName}</h5>
                            ${statusBadge}
                        </div>
                        ${req.notes ? `<p style="margin: 0; color: #64748b; font-size: 0.85rem;">Notes: ${req.notes}</p>` : ''}
                        <span style="font-size: 0.78rem; color: #94a3b8;">Requested: ${dateStr}</span>
                        ${req.responseMessage ? `
                            <div style="margin-top: 4px; padding: 8px 12px; background: #ffffff; border-radius: 8px; border: 1px dashed #cbd5e1; font-size: 0.85rem; color: #334155;">
                                <strong>Message from Staff:</strong> ${req.responseMessage}
                            </div>
                        ` : ''}
                    </div>`;
            });
        });
    }

    // Submit prescription refill request
    const medicationRefillForm = document.getElementById('medicationRefillForm');
    if (medicationRefillForm) {
        medicationRefillForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!currentUserData) return;

            const nameInput = document.getElementById('medicationInputName');
            const notesInput = document.getElementById('medicationInputNotes');

            const name = nameInput ? nameInput.value.trim() : '';
            const notes = notesInput ? notesInput.value.trim() : '';

            if (!name) return;

            try {
                const now = Date.now();
                const reqKey = 'req_' + now;

                await update(ref(db, `users/${currentUserData.uid}/medicationRequests/${reqKey}`), {
                    medicationName: name,
                    notes: notes,
                    status: 'Pending',
                    createdAt: now,
                    seniorName: currentUserData.name || 'Senior Citizen',
                    seniorId: currentUserData.seniorId || 'N/A',
                    seniorUid: currentUserData.uid
                });

                // Add to health log
                const logKey = 'log_' + now;
                await update(ref(db, `users/${currentUserData.uid}/health/logs/${logKey}`), {
                    type: 'medication',
                    title: `Refill Requested: ${name}`,
                    description: `Submitted medication request for ${name}. Waiting for OSCA staff review.`,
                    createdAt: now,
                    status: 'Pending'
                });

                if (typeof scNotify === 'function') scNotify('success', 'Medication refill request submitted!');
                else if (typeof showToast === 'function') showToast('Medication refill request submitted!');

                medicationRefillForm.reset();
            } catch (err) {
                console.error('Failed to submit refill request:', err);
                if (typeof scNotify === 'function') scNotify('error', 'Failed to submit request: ' + err.message);
                else alert('Failed to submit request: ' + err.message);
            }
        });
    }

    // --- Medication Reminders (panel-requested daily alarms) ---
    // Stored under users/{uid}/medicationReminders so each senior owns
    // their own list; the existing refill flow above is untouched.
    // NOTE: declared with `var`-style function hoisting in mind — the
    // auth observer above calls them via window.* wrappers defined here.
    var medRemindersCache = {};
    var medReminderDueQueue = [];
    var medReminderSnoozedUntil = 0;

    window.scListenToMedReminders = function () { listenToMedReminders(); };
    window.scCheckMedReminderDue = function () { checkMedReminderDue(); };

    function medReminderTimesOf(rem) {
        if (Array.isArray(rem.times) && rem.times.length) return rem.times.filter(t => /^\d{2}:\d{2}$/.test(t || ''));
        if (rem.time && /^\d{2}:\d{2}$/.test(rem.time)) return [rem.time];
        return [];
    }

    function medReminderDayLabel(days) {
        const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        if (!Array.isArray(days) || days.length === 0 || days.length === 7) return 'Daily';
        return days.slice().sort().map(d => names[Number(d)] || '').filter(Boolean).join(', ');
    }

    function renderMedReminderList() {
        const list = document.getElementById('medReminderList');
        if (!list) return;
        const entries = Object.entries(medRemindersCache || {}).filter(([, r]) => r && r.enabled !== false && r.status !== 'Deleted');
        if (!entries.length) {
            list.innerHTML = '<div style="text-align:center; color:#94a3b8; padding:20px 0;">'
                + '<i class="fas fa-pills" style="font-size:1.4rem; margin-bottom:8px; display:block; opacity:0.5;"></i>'
                + 'No medication reminders yet. Press <strong>Add Reminder</strong> above.</div>';
            return;
        }
        entries.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
        list.innerHTML = entries.map(([key, r]) => {
            const times = medReminderTimesOf(r);
            const takenToday = r.lastTakenDate === new Date().toDateString();
            return '<div style="border:1px solid #e2e8f0; border-radius:12px; padding:14px; background:#f8fafc; border-left:4px solid ' + (takenToday ? '#22c55e' : '#16a34a') + '; display:flex; flex-direction:column; gap:6px;">'
                + '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">'
                + '<div><h5 style="margin:0; color:#1e293b; font-size:0.98rem; font-weight:700;">' + escapeHtml(r.name || 'Medicine') + '</h5>'
                + (r.dosage ? '<p style="margin:2px 0 0; color:#64748b; font-size:0.84rem;">' + escapeHtml(r.dosage) + '</p>' : '')
                + '<div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">'
                + times.map(t => '<span style="background:#dcfce7; color:#15803d; font-weight:800; font-size:0.82rem; padding:3px 10px; border-radius:999px;"><i class="fas fa-clock" style="margin-right:4px;"></i>' + escapeHtml(t) + '</span>').join('')
                + '<span style="color:#94a3b8; font-size:0.78rem;">' + escapeHtml(medReminderDayLabel(r.days)) + '</span></div></div>'
                + '<span style="background:' + (takenToday ? '#dcfce7; color:#15803d' : '#fef9c3; color:#a16207') + '; padding:4px 10px; border-radius:20px; font-weight:700; font-size:0.76rem; white-space:nowrap;">' + (takenToday ? 'Taken today ✓' : 'Scheduled') + '</span></div>'
                + '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:4px;">'
                + '<button onclick="window.markMedReminderTaken && window.markMedReminderTaken(\'' + key + '\')" style="background:#16a34a; color:white; border:none; padding:8px 14px; border-radius:8px; font-weight:700; font-size:0.82rem; cursor:pointer;"><i class="fas fa-check"></i> Mark as Taken</button>'
                + '<button onclick="window.addMedReminderTime && window.addMedReminderTime(\'' + key + '\')" style="background:white; color:#15803d; border:1px solid #16a34a; padding:8px 14px; border-radius:8px; font-weight:700; font-size:0.82rem; cursor:pointer;"><i class="fas fa-plus"></i> Add Time</button>'
                + '<button onclick="window.openMedReminderForm && window.openMedReminderForm(\'' + key + '\')" style="background:#f1f5f9; color:#475569; border:none; padding:8px 14px; border-radius:8px; font-weight:700; font-size:0.82rem; cursor:pointer;">Edit</button>'
                + '<button onclick="window.deleteMedReminder && window.deleteMedReminder(\'' + key + '\')" style="background:#fee2e2; color:#ef4444; border:none; padding:8px 14px; border-radius:8px; font-weight:700; font-size:0.82rem; cursor:pointer;">Delete</button>'
                + '</div></div>';
        }).join('');
    }

    function listenToMedReminders() {
        if (!currentUserData) return;
        onValue(ref(db, `users/${currentUserData.uid}/medicationReminders`), (snapshot) => {
            medRemindersCache = snapshot.exists() ? (snapshot.val() || {}) : {};
            renderMedReminderList();
            checkMedReminderDue();
        });
    }

    window.openMedReminderForm = function (editKey) {
        const modal = document.getElementById('medReminderFormModal');
        if (!modal || !currentUserData) return;
        document.getElementById('medReminderEditKey').value = editKey || '';
        const existing = (editKey && medRemindersCache[editKey]) || null;
        document.getElementById('medReminderFormTitle').textContent = existing ? 'Edit Medication Reminder' : 'Add Medication Reminder';
        document.getElementById('medReminderName').value = existing ? (existing.name || '') : '';
        document.getElementById('medReminderDosage').value = existing ? (existing.dosage || '') : '';
        document.getElementById('medReminderTime').value = existing ? (medReminderTimesOf(existing)[0] || '') : '';
        const days = (existing && Array.isArray(existing.days) && existing.days.length) ? existing.days.map(String) : ['0', '1', '2', '3', '4', '5', '6'];
        document.querySelectorAll('#medReminderDays input[type="checkbox"]').forEach(cb => { cb.checked = days.includes(cb.value); });
        modal.style.display = 'flex';
    };

    const medReminderSaveBtn = document.getElementById('medReminderSaveBtn');
    if (medReminderSaveBtn) medReminderSaveBtn.addEventListener('click', async () => {
        if (!currentUserData) return;
        const editKey = (document.getElementById('medReminderEditKey').value || '').trim();
        const name = (document.getElementById('medReminderName').value || '').trim().slice(0, 80);
        const dosage = (document.getElementById('medReminderDosage').value || '').trim().slice(0, 120);
        const time = (document.getElementById('medReminderTime').value || '').trim();
        const days = Array.from(document.querySelectorAll('#medReminderDays input[type="checkbox"]:checked')).map(cb => Number(cb.value));
        if (!name) { showToast('Please type the medicine name.'); return; }
        if (!/^\d{2}:\d{2}$/.test(time)) { showToast('Please choose the time to take it.'); return; }
        try {
            medReminderSaveBtn.disabled = true;
            if (editKey && medRemindersCache[editKey]) {
                const prev = medRemindersCache[editKey] || {};
                const prevTimes = medReminderTimesOf(prev);
                const nextTimes = prevTimes.length ? [time, ...prevTimes.filter(t => t !== time)].slice(0, 6) : [time];
                await update(ref(db, `users/${currentUserData.uid}/medicationReminders/${editKey}`), {
                    name, dosage, times: nextTimes, time: nextTimes[0], days, enabled: true, updatedAt: Date.now()
                });
                showToast('Reminder updated.');
            } else {
                const key = 'rem_' + Date.now();
                await update(ref(db, `users/${currentUserData.uid}/medicationReminders/${key}`), {
                    name, dosage, times: [time], time, days, enabled: true,
                    createdAt: Date.now(), updatedAt: Date.now(), lastTakenDate: '', lastTakenAt: 0
                });
                showToast('Medication reminder added!');
            }
            document.getElementById('medReminderFormModal').style.display = 'none';
        } catch (err) {
            console.error('Save reminder error:', err);
            showToast('Could not save the reminder: ' + err.message);
        } finally {
            medReminderSaveBtn.disabled = false;
        }
    });

    window.markMedReminderTaken = async function (key) {
        if (!currentUserData || !key) return;
        try {
            const now = Date.now();
            await update(ref(db, `users/${currentUserData.uid}/medicationReminders/${key}`), {
                lastTakenAt: now, lastTakenDate: new Date().toDateString()
            });
            const r = medRemindersCache[key] || {};
            await update(ref(db, `users/${currentUserData.uid}/health/logs/log_${now}`), {
                type: 'medication', title: 'Medicine Taken: ' + (r.name || 'Medicine'),
                description: 'Senior marked ' + (r.name || 'medicine') + ' as taken.', createdAt: now, status: 'Taken'
            });
            medReminderDueQueue = medReminderDueQueue.filter(q => q.key !== key);
            if (!medReminderDueQueue.length) document.getElementById('medReminderDueModal').style.display = 'none';
            else showMedReminderDueModal();
            showToast('Good job! Marked as taken.');
        } catch (err) {
            console.error('Mark taken error:', err);
            showToast('Could not save: ' + err.message);
        }
    };

    window.addMedReminderTime = async function (key) {
        if (!currentUserData || !key || !medRemindersCache[key]) return;
        const t = window.prompt('What time? (24-hour format, e.g. 20:00)', '20:00');
        if (t === null) return;
        const clean = String(t).trim();
        if (!/^\d{2}:\d{2}$/.test(clean)) { showToast('Please use HH:MM format (e.g. 08:00).'); return; }
        const prev = medReminderTimesOf(medRemindersCache[key]);
        if (prev.includes(clean)) { showToast('That time is already in the list.'); return; }
        if (prev.length >= 6) { showToast('Maximum of 6 times per medicine.'); return; }
        try {
            await update(ref(db, `users/${currentUserData.uid}/medicationReminders/${key}`), {
                times: [...prev, clean].sort(), time: [...prev, clean].sort()[0], updatedAt: Date.now()
            });
            showToast('Time added.');
        } catch (err) {
            showToast('Could not add the time: ' + err.message);
        }
    };

    window.deleteMedReminder = async function (key) {
        if (!currentUserData || !key) return;
        if (!window.confirm('Delete this medication reminder?')) return;
        try {
            await remove(ref(db, `users/${currentUserData.uid}/medicationReminders/${key}`));
            showToast('Reminder deleted.');
        } catch (err) {
            showToast('Could not delete: ' + err.message);
        }
    };

    function medReminderKeyToday(key, timeStr) {
        return new Date().toDateString() + '|' + key + '|' + timeStr;
    }

    function checkMedReminderDue() {
        if (!currentUserData) return;
        const modal = document.getElementById('medReminderDueModal');
        if (!modal || modal.style.display === 'flex') return;
        if (Date.now() < medReminderSnoozedUntil) return;
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const cur = hh + ':' + mm;
        const today = now.getDay();
        const todayStr = now.toDateString();
        const due = [];
        Object.entries(medRemindersCache || {}).forEach(([key, r]) => {
            if (!r || r.enabled === false || r.status === 'Deleted') return;
            const days = Array.isArray(r.days) ? r.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
            if (!days.includes(today)) return;
            if (r.lastTakenDate === todayStr) return;
            medReminderTimesOf(r).forEach(t => {
                if (t <= cur && !sessionStorage.getItem('medDue_' + medReminderKeyToday(key, t))) {
                    due.push({ key, time: t, name: r.name || 'Medicine', dosage: r.dosage || '' });
                }
            });
        });
        if (due.length) {
            due.forEach(d => sessionStorage.setItem('medDue_' + medReminderKeyToday(d.key, d.time), '1'));
            medReminderDueQueue = due;
            showMedReminderDueModal();
            if ('Notification' in window && Notification.permission === 'granted') {
                try {
                    const n = new Notification('SilverCare: Time for your medicine!');
                    n.onclick = () => window.focus();
                } catch (e) { /* optional */ }
            }
        }
    }

    function showMedReminderDueModal() {
        const first = medReminderDueQueue[0];
        if (!first) return;
        const extra = medReminderDueQueue.length > 1 ? ` (+${medReminderDueQueue.length - 1} more)` : '';
        document.getElementById('medReminderDueText').innerHTML =
            '<strong>' + escapeHtml(first.name) + '</strong>' + (first.dosage ? ' — ' + escapeHtml(first.dosage) : '')
            + '<br><span style="color:#16a34a; font-weight:800;">' + escapeHtml(first.time) + '</span>' + escapeHtml(extra);
        document.getElementById('medReminderDueModal').style.display = 'flex';
        try {
            const beep = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=');
            beep.play().catch(() => {});
        } catch (e) { /* silent */ }
    }

    const medReminderTakenBtn = document.getElementById('medReminderTakenBtn');
    if (medReminderTakenBtn) medReminderTakenBtn.addEventListener('click', () => {
        const first = medReminderDueQueue[0];
        if (first) window.markMedReminderTaken(first.key);
    });

    const medReminderSnoozeBtn = document.getElementById('medReminderSnoozeBtn');
    if (medReminderSnoozeBtn) medReminderSnoozeBtn.addEventListener('click', () => {
        medReminderSnoozedUntil = Date.now() + 10 * 60 * 1000;
        document.getElementById('medReminderDueModal').style.display = 'none';
        showToast('Okay, we will remind you again in 10 minutes.');
    });

    // Ask once for browser notification permission (optional enhancement).
    if ('Notification' in window && Notification.permission === 'default') {
        setTimeout(() => { try { Notification.requestPermission(); } catch (e) { /* optional */ } }, 8000);
    }

    // Guard for restricted links
    document.querySelectorAll('.restricted-link').forEach(link => {
        link.addEventListener('click', (e) => {
            if (currentUserData && currentUserData.kycStatus !== 'Verified') {
                e.preventDefault();
                showToast('⚠️ Please complete KYC verification first to access this feature.');
            }
        });
    });

    // ══════════════════════════════════════════════════════════════════════════
    // ── KYC VERIFICATION SYSTEM (GCash/Bybit Style) ─────────────────────────
    // ══════════════════════════════════════════════════════════════════════════

    let kycStream = null;
    let capturedFaceData = null;
    // kycFaceConfirmed lives here (top of the KYC closure) so goToKycStep()
    // — defined below — can safely reference it without TDZ errors.
    let kycFaceConfirmed = false;
    let kycIdFrontData = null;
    let kycIdBackData = null;
    // Live camera streams for the Step-4 ID capture (one side at a time).
    const kycIdCamStreams = { front: null, back: null };
    let kycMedCertData = null;
    let kycMedCertName = '';
    let kycMedCertType = '';

    function renderKycVerificationStatus(userData) {
        const statusContainer = document.getElementById('verificationStatusContainer');
        const formFlow = document.getElementById('verificationFormFlow');
        const verifyPill = document.getElementById('navPillVerification');
        if (!statusContainer) return;

        // Auto-fill previously submitted health / sex / civil status if available (for profile auto-sync)
        // NOTE: age is NEVER restored into a field — Step 1 has no age input;
        // it is always computed live from the birthdate (kycDob) below.
        const kycHealthEl = document.getElementById('kycHealthCondition');
        const kycSexEl = document.getElementById('kycSex');
        const kycCivilEl = document.getElementById('kycCivilStatus');

        if (kycHealthEl && (userData.healthCondition || userData.condition)) {
            kycHealthEl.value = userData.healthCondition || userData.condition || 'None';
        }

        if (kycSexEl && userData.sex) {
            kycSexEl.value = userData.sex;
        }

        if (kycCivilEl && userData.civilStatus) {
            kycCivilEl.value = userData.civilStatus;
        }

        const kycStatus = userData.kycStatus || 'Not Submitted';

        if (kycStatus === 'Verified') {
            const kycCategory = getKycMilestoneCategory(Number(userData.age) || 0);
            statusContainer.innerHTML = `
                <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 16px; padding: 35px; text-align: center;">
                    <div style="width: 80px; height: 80px; background: #dcfce7; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 18px; font-size: 2.5rem; color: #22c55e;"><i class="fas fa-check-circle"></i></div>
                    <h3 style="color: #166534; font-size: 1.3rem; font-weight: 700; margin-bottom: 10px;">Identity Verified ✓</h3>
                    <p style="color: #15803d; font-size: 0.95rem;">Your identity has been verified. You can now access all services and apply for benefits.</p>
                    ${kycCategory ? `
                    <div style="margin-top: 18px; background: #f3e8ff; border: 1px solid #d8b4fe; color: #7e22ce; border-radius: 12px; padding: 14px 20px; display: inline-flex; align-items: center; gap: 10px; font-weight: 700;">
                        <i class="fas fa-award" style="font-size: 1.2rem;"></i>
                        <span style="text-align: left;">
                            <span style="display: block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; opacity: 0.8;">Senior Category</span>
                            <span style="font-size: 1.1rem;">${kycCategory}</span>
                        </span>
                    </div>` : ''}
                </div>`;
            if (formFlow) formFlow.style.display = 'none';
            if (verifyPill) {
                verifyPill.style.color = '#22c55e';
                verifyPill.innerHTML = '<i class="fas fa-check-circle" style="margin-right: 5px;"></i>Verified';
            }
        } else if (kycStatus === 'Pending') {
            statusContainer.innerHTML = `
                <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 16px; padding: 35px; text-align: center;">
                    <div style="width: 80px; height: 80px; background: #fef3c7; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 18px; font-size: 2.5rem; color: #f59e0b;"><i class="fas fa-clock"></i></div>
                    <h3 style="color: #92400e; font-size: 1.3rem; font-weight: 700; margin-bottom: 10px;">Verification Pending</h3>
                    <p style="color: #a16207; font-size: 0.95rem;">Your details have been submitted and are being reviewed by an employee. You will be notified once verified.</p>
                </div>`;
            if (formFlow) formFlow.style.display = 'none';
            if (verifyPill) {
                verifyPill.style.color = '#f59e0b';
                verifyPill.innerHTML = '<i class="fas fa-clock" style="margin-right: 5px;"></i>Pending';
            }
        } else if (kycStatus === 'Rejected') {
            statusContainer.innerHTML = `
                <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 16px; padding: 35px; text-align: center; margin-bottom: 20px;">
                    <div style="width: 80px; height: 80px; background: #fee2e2; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 18px; font-size: 2.5rem; color: #ef4444;"><i class="fas fa-times-circle"></i></div>
                    <h3 style="color: #991b1b; font-size: 1.3rem; font-weight: 700; margin-bottom: 10px;">Verification Rejected</h3>
                    <p style="color: #b91c1c; font-size: 0.95rem;">Your verification was declined. Please re-submit with clear and valid information.</p>
                </div>`;
            if (formFlow) formFlow.style.display = 'block';
        } else {
            statusContainer.innerHTML = '';
            if (formFlow) formFlow.style.display = 'block';
        }
    }

    // ── Age Requirement & Milestone Category Forms ────────────────────────────
    // A category is assigned ONLY at the exact milestone ages:
    //   80 or 85  = Octogenarian
    //   90 or 95  = Nonagenarian
    //   100       = Centenarian
    // Every other eligible age (60+) still completes the form, but stays
    // uncategorized — a plain "Verified Senior".
    function getKycMilestoneCategory(age) {
        const a = parseInt(age, 10);
        if (a === 80 || a === 85) return 'Octogenarian';
        if (a === 90 || a === 95) return 'Nonagenarian';
        if (a === 100) return 'Centenarian';
        return null;
    }

    // Computes the senior's exact age from a birthdate value (YYYY-MM-DD),
    // based on the current date. Returns null when the value is missing or
    // invalid — never 0 for a real person, so a "0 age" can never be saved.
    function computeAgeFromDobValue(dobValue) {
        if (!dobValue) return null;
        const birthDate = new Date(dobValue);
        if (isNaN(birthDate.getTime())) return null;
        // A birthdate in the future is invalid — treat it as missing.
        const today = new Date();
        if (birthDate > today) return null;
        let age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
            age--;
        }
        return age >= 0 ? age : null;
    }

    // Resolves the senior's age from the stored account: prefers the saved
    // `age` field and falls back to computing it from `dob` (walk-in accounts
    // registered by employees historically had no `age` value saved).
    function getSeniorDataAge(data) {
        if (!data) return 0;
        let age = parseInt(data.age, 10);
        if (age > 0) return age;
        if (!data.dob) return 0;
        const birthDate = new Date(data.dob);
        if (isNaN(birthDate.getTime())) return 0;
        const today = new Date();
        age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
            age--;
        }
        return age > 0 ? age : 0;
    }

    // Shows / hides the milestone Benefit Program form inside
    // the KYC verification flow, based on the age the senior entered.
    // Rendered as an unnumbered interstitial: Personal Information → (Benefit Form, 80+ only) → Face Scan → Health → Senior ID.
    function renderKycMilestoneSection(age) {
        const milestoneSection = document.getElementById('kycMilestoneSection');
        if (!milestoneSection) return null;

        const numericAge = parseInt(age, 10);
        // A category only exists at the exact milestone ages (80, 85, 90, 95, 100).
        // Every other eligible age (60+) still files the same form, but the
        // interstitial header reads "Verification Form" instead of a category name.
        const category = getKycMilestoneCategory(numericAge);
        const formTitleText = category ? `${category} Benefit Program Form` : 'Verification Form';

        // Keep the interstitial header in sync with the age-based category
        const stepFormTitle = document.getElementById('kycStepFormTitle');
        const stepFormSubtitle = document.getElementById('kycStepFormSubtitle');
        if (stepFormTitle) stepFormTitle.textContent = formTitleText;
        if (stepFormSubtitle) {
            stepFormSubtitle.textContent = category
                ? `Based on your age (${numericAge}), please complete the ${category} Benefit Program application form (R.A. No. 11982, NCSC Annex "A"). Your Senior Citizen ID will be collected on Step 4.`
                : `Based on your age (${numericAge}), please complete the verification form (R.A. No. 11982, NCSC Annex "A"). Your Senior Citizen ID will be collected on Step 4.`;
        }

        // Key the rendered form by category, or by exact age when uncategorized,
        // so already-typed answers survive a re-render but the prefill age stays fresh.
        const formKey = category || `none-${numericAge}`;

        // Keep already-typed answers when re-rendering for the same category/age
        if (milestoneSection.dataset.formKey === formKey && milestoneSection.innerHTML) {
            milestoneSection.style.display = 'flex';
            // Re-sync the locked Annex A address (Step-1 barangay may have changed)
            lockAnnexAAddressFields(milestoneSection, getStep1Barangay());
            // Fill any still-empty personal fields from Step 1 (no retyping)
            syncMilestonePersonalInfo(milestoneSection);
            wireSameAsResidential(milestoneSection);
            return category;
        }

        const defaultMilestoneAge = (numericAge >= 85 && numericAge <= 89) ? 85 : (numericAge >= 95 && numericAge <= 99) ? 95 : Math.min(numericAge, 100);
        milestoneSection.dataset.category = category || '';
        milestoneSection.dataset.hasForm = '1';
        milestoneSection.dataset.formKey = formKey;
        milestoneSection.innerHTML = buildMilestoneFormHtml(category, { prefillAge: numericAge, defaultMilestoneAge: defaultMilestoneAge });
        milestoneSection.style.display = 'flex';
        wireSameAsResidential(milestoneSection);
        // Sync Sex/Civil Status from base KYC fields into milestone's Annex A to avoid double entry (profile auto-sync)
        try {
            const baseSex = document.getElementById('kycSex')?.value || '';
            const baseCivil = document.getElementById('kycCivilStatus')?.value || '';
            const mSex = milestoneSection.querySelector('#sex');
            const mCivil = milestoneSection.querySelector('#civilStatus');
            if (mSex && baseSex) mSex.value = baseSex;
            if (mCivil && baseCivil) mCivil.value = baseCivil;
        } catch (e) {}
        return category;
    }

    // NCSC Annex "A" Application Form (R.A. No. 11982) — same contents as the
    // Octogenarian/Nonagenarian/Centenarian Benefit Program service form,
    // followed by the required Senior Citizen ID field.
    function buildMilestoneFormHtml(category, options = {}) {
        const prefillAge = options.prefillAge || '';
        const defaultMilestoneAge = options.defaultMilestoneAge || 80;
        // Annex A name sync: Step-1 inputs (already typed) first, stored record as fallback.
        const step1Val = (id) => (document.getElementById(id)?.value || '').trim();
        const defaultFirstName = step1Val('kycFirstName') || (currentUserData ? (currentUserData.firstName || '') : '');
        const defaultLastName = step1Val('kycLastName') || (currentUserData ? (currentUserData.lastName || '') : '');
        const defaultMiddleName = step1Val('kycMiddleName') || (currentUserData ? (currentUserData.middleName || '') : '');
        const defaultId = currentUserData ? (currentUserData.seniorId || '') : '';
        const defaultEmail = currentUserData ? (currentUserData.email || '') : '';
        const defaultDob = step1Val('kycDob') || (currentUserData ? (currentUserData.dob || '') : '');
        const defaultCp = step1Val('kycCpNumber') || (currentUserData ? (currentUserData.cpNumber || '') : '');
        const defaultSex = currentUserData ? (currentUserData.sex || 'Female') : 'Female';
        const defaultCivil = currentUserData ? (currentUserData.civilStatus || 'Married') : 'Married';
        // Annex A address lock: barangay mirrors the Step-1 verification selection.
        const defaultBarangay = getStep1Barangay();

        // Milestone-age choices: category-specific when a category applies,
        // otherwise every milestone age (uncategorized "Verification Form").
        const milestoneChoices = category === 'Octogenarian' ? [80, 85]
            : category === 'Nonagenarian' ? [90, 95]
            : category === 'Centenarian' ? [100]
            : [80, 85, 90, 95, 100];
        const milestoneOptions = category
            ? milestoneChoices.map(val =>
                `<option value="${val}" ${val === defaultMilestoneAge ? 'selected' : ''}>${val}</option>`
            ).join('')
            : `<option value="" disabled selected>Select milestone age</option>` + milestoneChoices.map(val =>
                `<option value="${val}">${val}</option>`
            ).join('');

        // Title mirrors the interstitial header: the category name when a
        // category applies, "Verification Form" otherwise.
        const formHeading = category ? `${category} Benefit Program` : 'Verification Form';

        let html = `
            <div class="kyc-form-header" style="margin-top: 25px; border-left: 4px solid #16a34a; padding-left: 14px;">
                <h3><i class="fas fa-award" style="color: #16a34a; margin-right: 8px;"></i>${formHeading}</h3>
                <p>Octogenarian, Nonagenarian and Centenarian Benefit Program — Application Form, Republic Act (R.A.) No. 11982 (NCSC Annex "A"). Please complete the form below, then provide your Senior Citizen ID.</p>
            </div>

            <div class="form-section-title">A. PERSONAL INFORMATION</div>
            <div class="form-grid-3">
                <div class="form-group">
                    <label for="ncscRrn">NCSC Registration Reference Number (RRN) <span style="color:#94a3b8;font-weight:400;">(Optional)</span></label>
                    <input type="text" id="ncscRrn" placeholder="Optional">
                </div>
                <div class="form-group">
                    <label for="oscaIdNum">OSCA ID Number *</label>
                    <input type="text" id="oscaIdNum" value="${defaultId}" required>
                </div>
                <div class="form-group">
                    <label for="milestoneAge">Applicant Milestone Age *</label>
                    <select id="milestoneAge" required>
                        ${milestoneOptions}
                    </select>
                </div>
            </div>
        `;
        html += `
            <div class="form-grid-3">
                <div class="form-group">
                    <label for="lastName" title="Last Name">A.1 LN *</label>
                    <input type="text" id="lastName" placeholder="Last Name" value="${defaultLastName}" required>
                </div>
                <div class="form-group">
                    <label for="givenName" title="First Name (Given Name)">A.2 FN *</label>
                    <input type="text" id="givenName" value="${defaultFirstName}" required>
                </div>
                <div class="form-group">
                    <label for="middleName" title="Middle Initial">A.3 MI</label>
                    <input type="text" id="middleName" placeholder="Middle Name" value="${defaultMiddleName}">
                </div>
            </div>
            <div class="form-grid-3">
                <div class="form-group">
                    <label for="dateOfBirth">A.4 Date of Birth (Month/Day/Year) *</label>
                    <input type="date" id="dateOfBirth" value="${defaultDob}" required>
                </div>
                <div class="form-group">
                    <label for="age">A.5 Age *</label>
                    <input type="number" id="age" placeholder="Age" min="60" value="${prefillAge}" required>
                </div>
                <div class="form-group">
                    <label for="sex">A.8 Sex *</label>
                    <select id="sex" required>
                        <option value="Male" ${defaultSex === 'Male' ? 'selected' : ''}>Male</option>
                        <option value="Female" ${defaultSex === 'Female' ? 'selected' : ''}>Female</option>
                    </select>
                </div>
            </div>

            <div class="form-group" style="margin-top:8px;">
                <label style="font-weight:700;">A.6 Residential Address / Address Abroad *</label>
            </div>
            <div class="form-grid-3">
                <div class="form-group">
                    <label for="resHouseNum">House Number</label>
                    <input type="text" id="resHouseNum" placeholder="House No." required>
                </div>
                <div class="form-group">
                    <label for="resStreet">Street</label>
                    <input type="text" id="resStreet" placeholder="Street" required>
                </div>
                <div class="form-group">
                    <label for="resBarangay">Barangay</label>
                    <input type="text" id="resBarangay" value="${defaultBarangay}" readonly tabindex="-1" title="Locked to your verified barangay" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                </div>
                <div class="form-group">
                    <label for="resCityMunicipality">City/Municipality</label>
                    <input type="text" id="resCityMunicipality" value="Magalang" readonly tabindex="-1" title="Fixed to Magalang" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                </div>
                <div class="form-group">
                    <label for="resProvince">Province</label>
                    <input type="text" id="resProvince" value="Pampanga" readonly tabindex="-1" title="Fixed to Pampanga" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                </div>
                <div class="form-group">
                    <label for="resZipCode">Zip Code</label>
                    <input type="text" id="resZipCode" value="2011" readonly tabindex="-1" title="Fixed to 2011 (Magalang)" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                </div>
            </div>
        `;
        html += `
            <div class="form-group" style="margin-top:8px;">
                <label style="font-weight:700;">A.7 Permanent Address in the Philippines *</label>
                    <label style="display:flex; align-items:center; gap:8px; font-weight:500; font-size:0.85rem; color:#475569; cursor:pointer; margin-top:6px;">
                        <input type="checkbox" class="sameAsResidentialChk" style="width:16px; height:16px; cursor:pointer; accent-color:#2563eb;">
                        Residential address is the same as permanent address
                    </label>
            </div>
            <div class="form-grid-3">
                <div class="form-group">
                    <label for="permHouseNum">House Number</label>
                    <input type="text" id="permHouseNum" placeholder="House No." required>
                </div>
                <div class="form-group">
                    <label for="permStreet">Street</label>
                    <input type="text" id="permStreet" placeholder="Street" required>
                </div>
                <div class="form-group">
                    <label for="permBarangay">Barangay</label>
                    <input type="text" id="permBarangay" value="${defaultBarangay}" readonly tabindex="-1" title="Locked to your verified barangay" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                </div>
                <div class="form-group">
                    <label for="permCityMunicipality">City/Municipality</label>
                    <input type="text" id="permCityMunicipality" value="Magalang" readonly tabindex="-1" title="Fixed to Magalang" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                </div>
                <div class="form-group">
                    <label for="permProvince">Province</label>
                    <input type="text" id="permProvince" value="Pampanga" readonly tabindex="-1" title="Fixed to Pampanga" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                </div>
                <div class="form-group">
                    <label for="permZipCode">Zip Code</label>
                    <input type="text" id="permZipCode" value="2011" readonly tabindex="-1" title="Fixed to 2011 (Magalang)" style="background:#e2e8f0; color:#64748b; cursor:not-allowed;" required>
                </div>
            </div>

            <div class="form-grid-3">
                <div class="form-group">
                    <label for="civilStatus">A.9 Civil Status *</label>
                    <select id="civilStatus" required>
                        <option value="Single" ${defaultCivil === 'Single' ? 'selected' : ''}>Single</option>
                        <option value="Married" ${defaultCivil === 'Married' ? 'selected' : ''}>Married</option>
                        <option value="Widowed" ${defaultCivil === 'Widowed' ? 'selected' : ''}>Widowed</option>
                        <option value="Others">Others</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="citizenship">A.10 Citizenship *</label>
                    <select id="citizenship" required>
                        <option value="Filipino">Filipino</option>
                        <option value="Dual Citizen">Dual Citizen</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="dualCitizenDetails">If Dual Citizen, kindly indicate details:</label>
                    <input type="text" id="dualCitizenDetails" placeholder="Specify details">
                </div>
            </div>
        `;
        html += `
            <div class="form-section-title">B. FAMILY INFORMATION</div>
            <div class="form-grid-2">
                <div class="form-group">
                    <label for="spouseName">B.1 Name of Spouse (Last Name, Given Name, Middle Name, Ext.)</label>
                    <input type="text" id="spouseName" placeholder="Spouse Full Name">
                </div>
                <div class="form-group">
                    <label for="spouseCitizenship">B.2 Citizenship</label>
                    <input type="text" id="spouseCitizenship" placeholder="e.g. Filipino">
                </div>
            </div>
            <div class="form-group" style="margin-top:8px;">
                <label style="font-weight:700;">B.3 Name of Children (Last Name, Given Name, Middle Name, Ext.)</label>
            </div>
            <div class="form-grid-2">
                <div class="form-group">
                    <label for="child1">1.</label>
                    <input type="text" id="child1" placeholder="Child 1 Full Name">
                </div>
                <div class="form-group">
                    <label for="child2">2.</label>
                    <input type="text" id="child2" placeholder="Child 2 Full Name">
                </div>
                <div class="form-group">
                    <label for="child3">3.</label>
                    <input type="text" id="child3" placeholder="Child 3 Full Name">
                </div>
                <div class="form-group">
                    <label for="child4">4.</label>
                    <input type="text" id="child4" placeholder="Child 4 Full Name">
                </div>
                <div class="form-group">
                    <label for="child5">5.</label>
                    <input type="text" id="child5" placeholder="Child 5 Full Name">
                </div>
                <div class="form-group">
                    <label for="child6">6.</label>
                    <input type="text" id="child6" placeholder="Child 6 Full Name">
                </div>
                <div class="form-group">
                    <label for="child7">7.</label>
                    <input type="text" id="child7" placeholder="Child 7 Full Name">
                </div>
                <div class="form-group">
                    <label for="child8">8.</label>
                    <input type="text" id="child8" placeholder="Child 8 Full Name">
                </div>
                <div class="form-group">
                    <label for="child9">9.</label>
                    <input type="text" id="child9" placeholder="Child 9 Full Name">
                </div>
                <div class="form-group">
                    <label for="child10">10.</label>
                    <input type="text" id="child10" placeholder="Child 10 Full Name">
                </div>
            </div>

            <div class="form-group" style="margin-top:8px;">
                <label style="font-weight:700;">B.4 Authorized Representatives (Last Name, Given Name, Middle Name, Ext.)</label>
            </div>
            <div class="form-grid-2">
                <div class="form-group">
                    <label for="rep1Name">B.4.1 Name of Representative *</label>
                    <input type="text" id="rep1Name" placeholder="Representative 1 Full Name" required>
                </div>
                <div class="form-group">
                    <label for="rep1Relationship">Relationship *</label>
                    <input type="text" id="rep1Relationship" placeholder="e.g. Son, Daughter" required>
                </div>
                <div class="form-group">
                    <label for="rep2Name">B.4.2 Name of Representative</label>
                    <input type="text" id="rep2Name" placeholder="Representative 2 Full Name">
                </div>
                <div class="form-group">
                    <label for="rep2Relationship">Relationship</label>
                    <input type="text" id="rep2Relationship" placeholder="Relationship">
                </div>
                <div class="form-group">
                    <label for="rep3Name">B.4.3 Name of Representative</label>
                    <input type="text" id="rep3Name" placeholder="Representative 3 Full Name">
                </div>
                <div class="form-group">
                    <label for="rep3Relationship">Relationship</label>
                    <input type="text" id="rep3Relationship" placeholder="Relationship">
                </div>
            </div>
        `;
        html += `
            <div class="form-section-title">C. CONTACT INFORMATION</div>
            <div class="form-grid-2">
                <div class="form-group">
                    <label for="contactNums">C.1 Contact Numbers (Telephone and Mobile Numbers) *</label>
                    <input type="tel" id="contactNums" placeholder="e.g. 09171234567" value="${defaultCp}" required>
                </div>
                <div class="form-group">
                    <label for="emailAddr">C.2 Email Address</label>
                    <input type="email" id="emailAddr" value="${defaultEmail}">
                </div>
            </div>

            <div class="form-section-title">D. DESIGNATED BENEFICIARY</div>
            <div class="form-grid-2">
                <div class="form-group">
                    <label for="primaryBeneficiary">D.1 Primary *</label>
                    <input type="text" id="primaryBeneficiary" placeholder="Full Name" required>
                </div>
                <div class="form-group">
                    <label for="primaryBeneficiaryRelationship">D.1.1 Relationship *</label>
                    <input type="text" id="primaryBeneficiaryRelationship" placeholder="e.g. Son, Daughter" required>
                </div>
                <div class="form-group">
                    <label for="contingentBeneficiary">D.2 Contingent</label>
                    <input type="text" id="contingentBeneficiary" placeholder="Full Name">
                </div>
                <div class="form-group">
                    <label for="contingentBeneficiaryRelationship">D.2.2 Relationship</label>
                    <input type="text" id="contingentBeneficiaryRelationship" placeholder="Relationship">
                </div>
            </div>

            <div class="form-section-title">E. UTILIZATION OF CASH GIFTS (Select all that apply)</div>
            <div class="form-row-checkboxes">
                <label class="checkbox-label-wrapper">
                    <input type="checkbox" name="cashUtilization" value="Food" checked> Food
                </label>
                <label class="checkbox-label-wrapper">
                    <input type="checkbox" name="cashUtilization" value="Medical check-up"> Medical check-up
                </label>
                <label class="checkbox-label-wrapper">
                    <input type="checkbox" name="cashUtilization" value="Medicines/Vitamins" checked> Medicines/Vitamins
                </label>
                <label class="checkbox-label-wrapper">
                    <input type="checkbox" name="cashUtilization" value="Livelihood / Entrepreneurial Activities"> Livelihood / Entrepreneurial Activities
                </label>
                <label class="checkbox-label-wrapper">
                    <input type="checkbox" name="cashUtilization" value="Others"> Others
                </label>
            </div>
            <div class="form-group" style="margin-top:6px;">
                <label for="cashUtilOthersSpecify">If Others, kindly specify:</label>
                <input type="text" id="cashUtilOthersSpecify" placeholder="Specify other utilization">
            </div>

            <div class="form-requirements-checklist">
                <div class="requirement-checklist-title"><i class="fas fa-file-signature"></i> G. Documentary Requirements (NCSC Annex A):</div>
                <ul class="requirement-list-ul">
                    <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Duly accomplished Annex A Application Form</li>
                    <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Certificate of Live Birth duly issued or authenticated by the Philippine Statistics Authority (PSA)</li>
                    <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Photocopy of Philippine Identification System ID card / Philippine ID card / National ID card (original copy must be presented)</li>
                    <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Recent 5.08 cm x 5.08 cm (2" x 2") ID picture</li>
                    <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Full body picture of the applicant printed on an A4 size bond/photo paper</li>
                    <li class="requirement-list-item"><i class="fas fa-circle-check"></i> Applicant's inclusion to the endorsed list for validation issued by the Local Chief Executive</li>
                </ul>
            </div>

            <div class="kyc-form-grid" style="margin-top: 18px;">
                <div class="kyc-field">
                    <label class="kyc-label">Senior Citizen ID Number <span class="kyc-required">*</span></label>
                    <input type="text" id="kycMilestoneSeniorIdNumber" class="kyc-input" placeholder="e.g. OSCA-2024-0123" value="${defaultId}" required>
                    <p class="kyc-id-hint" style="margin-top:6px;">Same ID number you will confirm again on Step 4 (Senior ID).</p>
                </div>
            </div>
        `;

        return html;
    }

    // The milestone (Octogenarian / Nonagenarian / Centenarian) Benefit Program
    // form is NOT rendered while typing the age here — it is rendered only when
    // the senior completes Personal Information and advances to the dedicated
    // Benefit interstitial (see the kycNextBtn handler below).
    // NOTE: the Step-4 Senior Citizen ID Number field lives in the static HTML
    // (id="kycSeniorIdNumber") and is intentionally NOT part of this template.

    // ── Senior ID Back-to-Back Upload (Step 4, required) ─────────────────────
    // Shared UI update for both gallery upload and camera capture.
    // Pass null to clear the side (Remove / Retake).
    function setKycIdPhoto(side, finalData) {
        const isFront = side === 'front';
        if (isFront) kycIdFrontData = finalData; else kycIdBackData = finalData;
        const previewImg = document.getElementById(isFront ? 'kycIdFrontImg' : 'kycIdBackImg');
        const box = document.getElementById(isFront ? 'kycIdFrontBox' : 'kycIdBackBox');
        const removeBtn = document.getElementById(isFront ? 'kycIdFrontRemove' : 'kycIdBackRemove');
        if (previewImg) {
            if (finalData) previewImg.src = finalData;
            else previewImg.removeAttribute('src');
        }
        if (box) {
            box.classList.toggle('has-image', !!finalData);
            if (finalData) box.classList.remove('error');
        }
        if (removeBtn) removeBtn.style.display = finalData ? 'flex' : 'none';
        if (finalData) {
            const err = document.getElementById('kycIdUploadError');
            if (err) err.style.display = 'none';
        }
        paintKycIdBtn(side);
        renderKycReviewBox();
    }
    function paintKycIdBtn(side) {
        const isFront = side === 'front';
        const btn = document.getElementById(isFront ? 'kycIdFrontBtn' : 'kycIdBackBtn');
        if (!btn) return;
        const hasPhoto = isFront ? kycIdFrontData : kycIdBackData;
        const live = !!kycIdCamStreams[side];
        if (live) btn.innerHTML = '<i class="fas fa-camera"></i> Capture Photo';
        else if (hasPhoto) btn.innerHTML = '<i class="fas fa-rotate-left"></i> Retake';
        else btn.innerHTML = '<i class="fas fa-camera"></i> Open Camera';
    }
    function stopKycIdCamera(side) {
        const s = kycIdCamStreams[side];
        if (s) { try { s.getTracks().forEach(t => t.stop()); } catch (e) {} kycIdCamStreams[side] = null; }
        const video = document.getElementById(side === 'front' ? 'kycIdFrontVideo' : 'kycIdBackVideo');
        if (video) { try { video.pause(); } catch (e) {} video.srcObject = null; video.style.display = 'none'; }
        const box = document.getElementById(side === 'front' ? 'kycIdFrontBox' : 'kycIdBackBox');
        if (box) box.classList.remove('cam-live');
        paintKycIdBtn(side);
    }
    function stopAllKycIdCameras() {
        stopKycIdCamera('front');
        stopKycIdCamera('back');
    }
    async function startKycIdCamera(side) {
        const video = document.getElementById(side === 'front' ? 'kycIdFrontVideo' : 'kycIdBackVideo');
        const box = document.getElementById(side === 'front' ? 'kycIdFrontBox' : 'kycIdBackBox');
        const btn = document.getElementById(side === 'front' ? 'kycIdFrontBtn' : 'kycIdBackBtn');
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                showToast('⚠️ Camera is not supported on this device. Please upload from the gallery instead.');
                return false;
            }
            // One camera at a time — release the other side first.
            stopKycIdCamera(side === 'front' ? 'back' : 'front');
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...'; }
            // Rear lens for photographing the ID card.
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } });
            kycIdCamStreams[side] = stream;
            if (video) { video.srcObject = stream; video.style.display = 'block'; try { await video.play(); } catch (e) {} }
            if (box) box.classList.add('cam-live');
            if (btn) btn.disabled = false;
            paintKycIdBtn(side);
            return true;
        } catch (err) {
            console.error('ID camera error:', err);
            showToast('⚠️ Camera access denied. Please allow camera permission, or upload from the gallery instead.');
            if (btn) btn.disabled = false;
            stopKycIdCamera(side);
            return false;
        }
    }
    function captureKycIdPhoto(side) {
        const stream = kycIdCamStreams[side];
        const video = document.getElementById(side === 'front' ? 'kycIdFrontVideo' : 'kycIdBackVideo');
        const canvas = document.getElementById(side === 'front' ? 'kycIdFrontCanvas' : 'kycIdBackCanvas');
        if (!stream || !video || !canvas || !video.videoWidth) {
            showToast('⚠️ Camera is not ready yet. Please try again.');
            return;
        }
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        let dataUrl = '';
        try { dataUrl = canvas.toDataURL('image/jpeg', 0.85); }
        catch (err) { showToast('⚠️ Failed to capture the photo. Please try again.'); return; }
        stopKycIdCamera(side);
        // Same 1.5MB downscale rule as gallery uploads.
        const img = new Image();
        img.onload = () => {
            let finalData = dataUrl;
            if (dataUrl.length > 1.5 * 1024 * 1024) {
                const maxW = 1200;
                let w = img.width, h = img.height;
                if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                try { finalData = canvas.toDataURL('image/jpeg', 0.75); } catch (e) {}
            }
            setKycIdPhoto(side, finalData);
            showToast(side === 'front' ? 'Front photo captured!' : 'Back photo captured!');
        };
        img.onerror = () => setKycIdPhoto(side, dataUrl);
        img.src = dataUrl;
    }
    async function onKycIdMainBtn(side) {
        const hasPhoto = side === 'front' ? kycIdFrontData : kycIdBackData;
        if (kycIdCamStreams[side]) { captureKycIdPhoto(side); return; }
        if (hasPhoto) {
            // Retake: discard the old photo and reopen the camera.
            setKycIdPhoto(side, null);
        }
        await startKycIdCamera(side);
    }
    function handleKycIdFile(file, side) {
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            showToast('⚠️ Please upload an image file (JPG/PNG) for the Senior ID.');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            showToast('⚠️ ID image must be 5MB or smaller.');
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result;
            const img = new Image();
            img.onload = () => {
                let finalData = dataUrl;
                if (dataUrl.length > 1.5 * 1024 * 1024) {
                    const canvas = document.createElement('canvas');
                    const maxW = 1200;
                    let w = img.width, h = img.height;
                    if (w > maxW) {
                        h = Math.round(h * maxW / w);
                        w = maxW;
                    }
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    try { finalData = canvas.toDataURL('image/jpeg', 0.75); } catch (err) {}
                }
                setKycIdPhoto(side, finalData);
            };
            img.onerror = () => setKycIdPhoto(side, dataUrl);
            img.src = dataUrl;
        };
        reader.readAsDataURL(file);
    }

    const kycIdFrontInput = document.getElementById('kycIdFrontInput');
    const kycIdFrontBtn = document.getElementById('kycIdFrontBtn');
    const kycIdFrontRemove = document.getElementById('kycIdFrontRemove');
    const kycIdBackInput = document.getElementById('kycIdBackInput');
    const kycIdBackBtn = document.getElementById('kycIdBackBtn');
    const kycIdBackRemove = document.getElementById('kycIdBackRemove');
    const kycIdFrontGallery = document.getElementById('kycIdFrontGallery');
    const kycIdBackGallery = document.getElementById('kycIdBackGallery');

    // Main buttons drive the in-page camera: Open Camera → Capture Photo → Retake.
    if (kycIdFrontBtn) kycIdFrontBtn.addEventListener('click', () => onKycIdMainBtn('front'));
    if (kycIdBackBtn) kycIdBackBtn.addEventListener('click', () => onKycIdMainBtn('back'));
    // Gallery fallback (camera unsupported / denied / desktop without camera).
    if (kycIdFrontGallery && kycIdFrontInput) kycIdFrontGallery.addEventListener('click', () => kycIdFrontInput.click());
    if (kycIdBackGallery && kycIdBackInput) kycIdBackGallery.addEventListener('click', () => kycIdBackInput.click());
    if (kycIdFrontInput) {
        kycIdFrontInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleKycIdFile(file, 'front');
            e.target.value = '';
        });
    }
    if (kycIdBackInput) {
        kycIdBackInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) handleKycIdFile(file, 'back');
            e.target.value = '';
        });
    }
    if (kycIdFrontRemove) {
        kycIdFrontRemove.addEventListener('click', () => {
            stopKycIdCamera('front');
            setKycIdPhoto('front', null);
        });
    }
    if (kycIdBackRemove) {
        kycIdBackRemove.addEventListener('click', () => {
            stopKycIdCamera('back');
            setKycIdPhoto('back', null);
        });
    }

    function setKycDots(activeNum) {
        const dots = {
            1: document.getElementById('kycStep1'),
            2: document.getElementById('kycStep2'),
            3: document.getElementById('kycStep3'),
            4: document.getElementById('kycStep4')
        };
        const conns = {
            1: document.getElementById('kycConnector1'),
            2: document.getElementById('kycConnector2'),
            3: document.getElementById('kycConnector3')
        };
        Object.values(dots).forEach(d => { if (d) d.classList.remove('active', 'done'); });
        Object.values(conns).forEach(c => { if (c) c.classList.remove('done'); });
        for (let n = 1; n < activeNum; n++) {
            if (dots[n]) dots[n].classList.add('done');
            if (conns[n]) conns[n].classList.add('done');
        }
        if (dots[activeNum]) dots[activeNum].classList.add('active');
    }

    // Benefit Program interstitial (age 80+): shown between Personal Info and
    // Face Scan but NOT as a numbered circle — the header stays 1..4.
    function hasKycMilestoneForm() {
        const milestoneSection = document.getElementById('kycMilestoneSection');
        return !!(milestoneSection && milestoneSection.dataset.hasForm && milestoneSection.innerHTML);
    }

    function goToKycStep(step) {
        const step1Content = document.getElementById('kycStep1Content');
        const stepFormContent = document.getElementById('kycStepFormContent');
        const step2Content = document.getElementById('kycStep2Content');
        const step3Content = document.getElementById('kycStep3Content');
        const step4Content = document.getElementById('kycStep4Content');
        if (!step1Content || !step2Content || !step3Content || !step4Content) return;

        if (step === 'form') {
            // Benefit Program interstitial (unnumbered)
            if (stepFormContent) stepFormContent.style.display = 'block';
            step1Content.style.display = 'none';
            step2Content.style.display = 'none';
            step3Content.style.display = 'none';
            step4Content.style.display = 'none';
            setKycDots(1);
            return;
        }
        if (stepFormContent) stepFormContent.style.display = 'none';
        if (step === 2) {
            // Step 2: Face Scan
            step1Content.style.display = 'none';
            step2Content.style.display = 'block';
            step3Content.style.display = 'none';
            step4Content.style.display = 'none';
            setKycDots(2);
            const backBtn = document.getElementById('kycBackBtn');
            if (backBtn) backBtn.innerHTML = hasKycMilestoneForm()
                ? '<i class="fas fa-arrow-left"></i> Back to Benefit Form'
                : '<i class="fas fa-arrow-left"></i> Back to Information';
            // If the senior already has a scanned photo waiting for review,
            // show it again so they can Retake or press OK.
            // (Guarded: the review helpers are declared later in this closure.)
            try {
                if (typeof showKycFaceReview === 'function' && capturedFaceData && !kycFaceConfirmed) {
                    showKycFaceReview();
                }
            } catch (e) { /* helpers not ready yet — harmless */ }
        } else if (step === 'health') {
            // Step 3: Health Condition / Illness (med cert upload lives here)
            step1Content.style.display = 'none';
            step2Content.style.display = 'none';
            step3Content.style.display = 'block';
            step4Content.style.display = 'none';
            setKycDots(3);
        } else if (step === 'seniorid') {
            // Step 4: Senior Citizen ID (number + back-to-back) + Submit
            step1Content.style.display = 'none';
            step2Content.style.display = 'none';
            step3Content.style.display = 'none';
            step4Content.style.display = 'block';
            setKycDots(4);
            wireKycStep4();
            renderKycReviewBox();
        } else {
            // Step 1: Personal Information
            step1Content.style.display = 'block';
            step2Content.style.display = 'none';
            step3Content.style.display = 'none';
            step4Content.style.display = 'none';
            setKycDots(1);
        }
    }

    // Privacy-safe duplicate check: the server returns only taken:true/false,
    // never the other account's name or details. Returns null when the check
    // itself fails (fail-open — staff review remains the final authority).
    async function checkSeniorIdTaken(seniorId) {
        try {
            const token = await auth.currentUser.getIdToken();
            const res = await fetch('/api/check-senior-id', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ seniorId: seniorId })
            });
            const data = await res.json();
            if (data && data.success) return !!data.taken;
            return null;
        } catch (err) {
            console.warn('Senior ID check failed:', err);
            return null;
        }
    }
    function showSeniorIdTaken(sidField) {
        showToast('⚠️ This Senior Citizen ID number is already used. Please double-check the number on your ID card.');
        const sidErr = document.getElementById('kycSeniorIdError');
        if (sidErr) { sidErr.textContent = 'This ID number is already used. Please verify your ID card, or visit the OSCA office if you believe this is a mistake.'; sidErr.style.display = 'block'; }
        if (sidField) { sidField.classList.add('error'); sidField.focus(); }
    }

    // Returns the single Step-4 ID number (static HTML — unique by design).
    // Falls back to the milestone interstitial + profile only when Step 4 is
    // somehow absent (defensive; normally Step 4 always exists).
    // Declared with `var` for the same hoisting reason as wireKycStep4.
    var getKycSeniorIdNumber = function () {
        const step4 = document.getElementById('kycSeniorIdNumber');
        if (step4 && (step4.value || '').trim()) return step4.value.trim();
        const milestone = document.getElementById('kycMilestoneSeniorIdNumber');
        if (milestone && (milestone.value || '').trim()) return milestone.value.trim();
        if (step4) return (step4.value || '').trim();
        return '';
    };

    // Small review summary shown above the Submit button (Step 4).
    // `var` so ID upload handlers (registered earlier) can safely call it.
    var renderKycReviewBox = function () {
        const box = document.getElementById('kycReviewBox');
        if (!box) return;
        let illness = getKycIllnessValue();
        const illnessLabel = !illness ? 'Not answered yet' : (illness === 'None' ? 'No Illness / Healthy' : illness);
        const medLabel = (illness && illness !== 'None')
            ? (kycMedCertData ? ('<span class="ok">Attached: ' + kycMedCertName + '</span>') : '<span class="missing">Missing — required</span>')
            : 'Not required';
        const sidVal = getKycSeniorIdNumber();
        box.style.display = 'block';
        box.innerHTML = '<strong>Review before submitting</strong><br>'
            + 'Face scan: ' + ((!capturedFaceData) ? '<span class="missing">Missing</span>'
                : (!kycFaceConfirmed ? '<span class="missing">Needs your OK — go back to Face Scan</span>'
                    : '<span class="ok">Confirmed ✓</span>'))
            + ' &nbsp;•&nbsp; Health: <strong>' + illnessLabel + '</strong>'
            + ' &nbsp;•&nbsp; Med cert: ' + medLabel + '<br>'
            + 'Senior ID no.: <strong>' + (sidVal || '—') + '</strong>'
            + ' &nbsp;•&nbsp; ID front: ' + (kycIdFrontData ? '<span class="ok">Attached</span>' : '<span class="missing">Missing</span>')
            + ' &nbsp;•&nbsp; ID back: ' + (kycIdBackData ? '<span class="ok">Attached</span>' : '<span class="missing">Missing</span>');
    };

    // Step navigation: Next
    const kycNextBtn = document.getElementById('kycNextBtn');
    if (kycNextBtn) {
        kycNextBtn.addEventListener('click', () => {
            const firstName = document.getElementById('kycFirstName').value.trim();
            const lastName = document.getElementById('kycLastName').value.trim();
            const address = document.getElementById('kycAddress').value.trim();
            // Province / City are fixed to Pampanga / Magalang (read-only fields).
            const provinceEl = document.getElementById('kycProvince');
            const cityEl = document.getElementById('kycCity');
            if (provinceEl) provinceEl.value = FIXED_PROVINCE;
            if (cityEl) cityEl.value = FIXED_CITY;
            const province = FIXED_PROVINCE;
            const barangay = (document.getElementById('kycBarangay').value || '').trim();
            const citizenship = document.getElementById('kycCitizenship').value.trim();
            const cpNumber = document.getElementById('kycCpNumber').value.trim();
            const dob = document.getElementById('kycDob').value;
            const kycSexVal = document.getElementById('kycSex')?.value || '';
            const kycCivilVal = document.getElementById('kycCivilStatus')?.value || '';
            // Age is NEVER typed — it is computed from the birthdate above.
            const ageVal = computeAgeFromDobValue(dob);

            if (!firstName) { showToast('⚠️ Please enter your first name.'); document.getElementById('kycFirstName').focus(); return; }
            if (!lastName) { showToast('⚠️ Please enter your last name.'); document.getElementById('kycLastName').focus(); return; }
            if (!address) { showToast('⚠️ Please enter your address.'); document.getElementById('kycAddress').focus(); return; }
            if (!barangay) { showToast('⚠️ Please select your barangay.'); document.getElementById('kycBarangay').focus(); return; }
            if (!MAGALANG_BARANGAYS.includes(barangay)) { showToast('⚠️ Please select a valid Magalang barangay.'); document.getElementById('kycBarangay').focus(); return; }
            if (!citizenship) { showToast('⚠️ Please enter your citizenship.'); document.getElementById('kycCitizenship').focus(); return; }
            if (!dob) { showToast('⚠️ Please enter your Date of Birth.'); document.getElementById('kycDob').focus(); return; }
            if (!kycSexVal) { showToast('⚠️ Please select your Sex.'); document.getElementById('kycSex').focus(); return; }
            if (!kycCivilVal) { showToast('⚠️ Please select your Civil Status.'); document.getElementById('kycCivilStatus').focus(); return; }
            if (!cpNumber) { showToast('⚠️ Please enter your cellphone number.'); document.getElementById('kycCpNumber').focus(); return; }
            if (!isValidPhone(cpNumber)) { showToast('⚠️ Please enter a valid cellphone number (digits only, e.g. 09123456789).'); document.getElementById('kycCpNumber').focus(); return; }

            // Personal-info validation ends here — Step 4 (Senior ID) owns the
            // back-to-back ID check, so seniors are not blocked at Step 1.

            // Age is auto-computed from the birthdate above — it is never typed,
            // so a "0 age" is impossible. Under 60 = not eligible as a senior.
            if (ageVal === null || ageVal === undefined || isNaN(ageVal)) {
                showToast('⚠️ Please enter a valid Date of Birth so your age can be computed.');
                document.getElementById('kycDob').focus();
                return;
            }
            if (ageVal < 60) {
                showToast("You're not eligible. You must be a senior.");
                document.getElementById('kycDob').focus();
                return;
            }

            // Every eligible senior (60+) completes the Benefit Program /
            // verification form (Annex A). A category is only assigned at the
            // exact milestone ages (80, 85, 90, 95, 100); all other ages still
            // file the form but stay uncategorized (a plain Verified Senior).
            renderKycMilestoneSection(ageVal);
            goToKycStep('form');
        });
    }

    // Live age readout under the birthdate field: the senior only picks a
    // birthdate; the system shows the auto-computed age (and the
    // under-60 ineligibility notice) immediately while typing.
    const kycDobEl = document.getElementById('kycDob');
    if (kycDobEl && !kycDobEl.dataset.ageReadoutWired) {
        kycDobEl.dataset.ageReadoutWired = '1';
        const paintKycAgeReadout = () => {
            const readout = document.getElementById('kycAgeReadout');
            if (!readout) return;
            const liveAge = computeAgeFromDobValue(kycDobEl.value);
            readout.classList.remove('ok', 'bad');
            if (liveAge === null || liveAge === undefined || isNaN(liveAge)) {
                readout.textContent = kycDobEl.value
                    ? '⚠️ Invalid birthdate — please pick a valid date.'
                    : '';
                if (kycDobEl.value) readout.classList.add('bad');
                return;
            }
            if (liveAge < 60) {
                readout.textContent = `Computed age: ${liveAge} — You're not eligible. You must be a senior.`;
                readout.classList.add('bad');
                return;
            }
            readout.classList.add('ok');
            readout.textContent = `Computed age: ${liveAge} years old ✓`;
        };
        kycDobEl.addEventListener('input', paintKycAgeReadout);
        kycDobEl.addEventListener('change', paintKycAgeReadout);
        paintKycAgeReadout();
    }

    // Benefit interstitial Next — validates Annex A (Senior ID number now lives
    // on Step 4, so only the milestone fields are checked here)
    const kycFormNextBtn = document.getElementById('kycFormNextBtn');
    if (kycFormNextBtn) {
        kycFormNextBtn.addEventListener('click', () => {
            const milestoneSection = document.getElementById('kycMilestoneSection');
            const category = milestoneSection?.dataset.category || '';
            const formLabel = category ? `${category} Form` : 'Verification Form';

            // Re-lock Annex A address to the fixed service area before validating
            // (tamper-proof even if edited via devtools).
            syncSameAsResidential(milestoneSection);
            lockAnnexAAddressFields(milestoneSection, getStep1Barangay());

            const requiredMilestoneFields = milestoneSection ? milestoneSection.querySelectorAll('input[required], select[required]') : [];
            for (const field of requiredMilestoneFields) {
                if (!(field.value || '').trim()) {
                    const groupLabel = field.closest('.form-group')?.querySelector('label')?.textContent.trim() || field.closest('.kyc-field')?.querySelector('label')?.textContent.trim() || 'this field';
                    showToast(`⚠️ ${formLabel}: please complete "${groupLabel.replace('*', '').trim()}".`);
                    field.focus();
                    return;
                }
            }

            // Copy the interstitial ID number into Step 4 so the senior only types it once
            const milestoneSid = document.getElementById('kycMilestoneSeniorIdNumber');
            const step4Sid = document.getElementById('kycSeniorIdNumber');
            if (milestoneSid && step4Sid && (milestoneSid.value || '').trim() && !(step4Sid.value || '').trim()) {
                step4Sid.value = milestoneSid.value.trim();
            }

            goToKycStep(2);
        });
    }

    // Step navigation: Back (Face Scan → Benefit Form if it exists, otherwise Personal Info)
    const kycBackBtn = document.getElementById('kycBackBtn');
    if (kycBackBtn) {
        kycBackBtn.addEventListener('click', () => {
            const milestoneSection = document.getElementById('kycMilestoneSection');
            const hasForm = !!(milestoneSection && milestoneSection.dataset.hasForm && milestoneSection.innerHTML);
            goToKycStep(hasForm ? 'form' : 1);
        });
    }

    // Step navigation: Back (Benefit Form → Personal Information)
    const kycFormBackBtn = document.getElementById('kycFormBackBtn');
    if (kycFormBackBtn) {
        kycFormBackBtn.addEventListener('click', () => {
            goToKycStep(1);
        });
    }

    // ── Health Info step (Step 3 — Senior ID Step 4 comes after) ─────────────
    // Show the "specify your illness" field only when "Enter manually" is chosen.
    // Seniors who select "No Illness / Healthy" do NOT need to upload a medical
    // certification; the certification upload is only asked for when an illness
    // is reported.
    // NOTE: updateKycIllnessFields() is a plain function declaration so the
    // static wiring below can call it, but the helper it uses to reset the
    // med-cert (clearKycMedPreview, a `var`) is assigned further down — JS
    // hoists the `var` but NOT its value, so guard the call.
    // ── Step 3 illness picker: multi-select box buttons (tap all that apply) ──
    // 'None' (No Illness / Healthy) is exclusive; 'Other' reveals the free-text box.
    const KYC_ILLNESS_OPTIONS = [
        { value: 'Hypertension', label: 'Hypertension' },
        { value: 'Diabetes', label: 'Diabetes' },
        { value: 'Heart Disease', label: 'Heart Disease' },
        { value: 'Arthritis', label: 'Arthritis' },
        { value: 'Asthma', label: 'Asthma' },
        { value: 'COPD / Chronic Lung Disease', label: 'COPD / Lung Disease' },
        { value: 'Cataract / Eye Problems', label: 'Cataract / Eye Problems' },
        { value: 'Hearing Loss', label: 'Hearing Loss' },
        { value: 'Osteoporosis', label: 'Osteoporosis' },
        { value: 'Stroke', label: 'Stroke' },
        { value: 'Cancer', label: 'Cancer' },
        { value: 'Kidney Disease / Dialysis', label: 'Kidney Disease / Dialysis' },
        { value: "Dementia / Alzheimer's", label: "Dementia / Alzheimer's" },
        { value: "Parkinson's Disease", label: "Parkinson's Disease" },
        { value: 'Bedridden', label: 'Bedridden' },
        { value: 'Tuberculosis', label: 'Tuberculosis' },
        { value: 'Anemia', label: 'Anemia' },
        { value: 'Goiter / Thyroid Disorder', label: 'Goiter / Thyroid' },
        { value: 'Other', label: 'Others (specify)' }
    ];
    const kycSelectedIllnesses = new Set();
    const KYC_BOX_IDLE = 'border:2px solid #cbd5e1; background:#ffffff; color:#475569; font-weight:600; font-size:0.88rem; padding:10px 18px; border-radius:10px; cursor:pointer; transition:0.15s;';
    const KYC_BOX_ACTIVE = 'border:2px solid #2563eb; background:#eff6ff; color:#1d4ed8; font-weight:700; font-size:0.88rem; padding:10px 18px; border-radius:10px; cursor:pointer; transition:0.15s;';
    const KYC_NONE_IDLE = 'border:2px solid #cbd5e1; background:#ffffff; color:#475569; font-weight:600; font-size:0.88rem; padding:10px 18px; border-radius:10px; cursor:pointer; transition:0.15s; width:100%;';
    const KYC_NONE_ACTIVE = 'border:2px solid #059669; background:#ecfdf5; color:#047857; font-weight:700; font-size:0.88rem; padding:10px 18px; border-radius:10px; cursor:pointer; transition:0.15s; width:100%;';

    // Single source of truth for Step 3: '' = unanswered, 'None' = healthy,
    // otherwise a comma-joined illness list (Others text appended).
    function getKycIllnessValue() {
        if (kycSelectedIllnesses.size === 0) return '';
        if (kycSelectedIllnesses.has('None')) return 'None';
        const named = KYC_ILLNESS_OPTIONS
            .filter(o => o.value !== 'Other' && kycSelectedIllnesses.has(o.value))
            .map(o => o.value);
        if (kycSelectedIllnesses.has('Other')) {
            const otherText = (document.getElementById('kycIllnessOther')?.value || '').trim();
            named.push(otherText || 'Other (specified)');
        }
        return named.join(', ');
    }
    function paintKycIllnessBoxes() {
        const group = document.getElementById('kycIllnessBoxGroup');
        if (!group) return;
        group.querySelectorAll('button[data-illness]').forEach(btn => {
            const v = btn.getAttribute('data-illness');
            const on = kycSelectedIllnesses.has(v);
            btn.style.cssText = v === 'None' ? (on ? KYC_NONE_ACTIVE : KYC_NONE_IDLE) : (on ? KYC_BOX_ACTIVE : KYC_BOX_IDLE);
            const base = btn.getAttribute('data-label') || v;
            btn.textContent = (on ? '✓ ' : '') + base;
        });
    }
    function toggleKycIllness(value) {
        if (value === 'None') {
            kycSelectedIllnesses.clear();
            kycSelectedIllnesses.add('None');
        } else {
            kycSelectedIllnesses.delete('None');
            if (kycSelectedIllnesses.has(value)) kycSelectedIllnesses.delete(value);
            else kycSelectedIllnesses.add(value);
        }
        paintKycIllnessBoxes();
        updateKycIllnessFields();
    }
    function renderKycIllnessBoxes() {
        const group = document.getElementById('kycIllnessBoxGroup');
        if (!group || group.dataset.rendered) return;
        group.dataset.rendered = '1';
        const mk = (value, label, fullWidth) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('data-illness', value);
            b.setAttribute('data-label', label);
            b.textContent = label;
            b.style.cssText = fullWidth ? KYC_NONE_IDLE : KYC_BOX_IDLE;
            if (fullWidth) { const w = document.createElement('div'); w.style.cssText = 'flex-basis:100%;'; w.appendChild(b); b.style.width = '100%'; group.appendChild(w); }
            else group.appendChild(b);
            b.addEventListener('click', () => toggleKycIllness(value));
        };
        mk('None', 'No Illness / Healthy', true);
        KYC_ILLNESS_OPTIONS.forEach(o => mk(o.value, o.label, false));
        paintKycIllnessBoxes();
    }
    function hasReportedKycIllness() {
        const v = getKycIllnessValue();
        return !!(v && v !== 'None');
    }
    function updateKycIllnessFields() {
        const wrap = document.getElementById('kycIllnessOtherWrap');
        const certWrap = document.getElementById('kycMedCertWrap');
        const certError = document.getElementById('kycMedCertError');
        const showOther = kycSelectedIllnesses.has('Other');
        const needsCert = hasReportedKycIllness();
        if (wrap) wrap.style.display = showOther ? 'block' : 'none';
        if (!showOther) {
            const otherInput = document.getElementById('kycIllnessOther');
            if (otherInput) otherInput.value = '';
        }
        if (certWrap) certWrap.style.display = needsCert ? 'block' : 'none';
        if (!needsCert) {
            if (typeof clearKycMedPreview === 'function') clearKycMedPreview();
            if (certError) certError.style.display = 'none';
        }
    }
    renderKycIllnessBoxes();
    function setKycMedPreview(fileName, fileType, dataUrl, fileSize) {
        const preview = document.getElementById('kycMedCertPreview');
        const img = document.getElementById('kycMedCertImg');
        const icon = document.getElementById('kycMedCertIcon');
        const nameEl = document.getElementById('kycMedCertName');
        const subEl = document.getElementById('kycMedCertSub');
        if (nameEl) nameEl.textContent = fileName || 'medical-certification';
        if (subEl) {
            const kb = fileSize ? (fileSize / 1024) : 0;
            const sizeTxt = kb > 1024 ? ((kb / 1024).toFixed(2) + ' MB') : (Math.max(1, Math.round(kb)) + ' KB');
            subEl.textContent = ((fileType === 'application/pdf') ? 'PDF document' : 'Image') + ' • ' + sizeTxt + ' • Ready for review';
        }
        if (preview) preview.style.display = 'flex';
        if (!img) return;
        if (fileType === 'application/pdf') {
            img.classList.remove('has-file');
            img.removeAttribute('src');
            if (icon) icon.style.display = 'flex';
        } else if (dataUrl) {
            img.src = dataUrl;
            img.classList.add('has-file');
            if (icon) icon.style.display = 'none';
        }
    }

    // `var` — updateKycIllnessFields() (called from static wiring above) uses it.
    var clearKycMedPreview = function () {
        kycMedCertData = null;
        kycMedCertName = '';
        kycMedCertType = '';
        const kycMedCertInput = document.getElementById('kycMedCertInput');
        if (kycMedCertInput) kycMedCertInput.value = '';
        const preview = document.getElementById('kycMedCertPreview');
        if (preview) preview.style.display = 'none';
        const nameEl = document.getElementById('kycMedCertName');
        if (nameEl) nameEl.textContent = 'No file attached';
        const img = document.getElementById('kycMedCertImg');
        if (img) { img.classList.remove('has-file'); img.removeAttribute('src'); }
        const icon = document.getElementById('kycMedCertIcon');
        if (icon) icon.style.display = 'flex';
    };

    function handleKycMedCertFile(f) {
        const errEl = document.getElementById('kycMedCertError');
        const kycMedCertInput = document.getElementById('kycMedCertInput');
        if (!f) return;
        if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(f.type)) {
            if (errEl) {
                errEl.textContent = 'Unsupported file type. Please upload JPG, PNG, WEBP or PDF.';
                errEl.style.display = 'block';
            }
            if (kycMedCertInput) kycMedCertInput.value = '';
            return;
        }
        if (f.size > 7 * 1024 * 1024) {
            if (errEl) {
                errEl.textContent = 'File is too large. Maximum allowed size is 7 MB.';
                errEl.style.display = 'block';
            }
            if (kycMedCertInput) kycMedCertInput.value = '';
            return;
        }
        if (errEl) errEl.style.display = 'none';
        const reader = new FileReader();
        reader.onload = () => {
            kycMedCertData = String(reader.result || '');
            kycMedCertName = f.name || 'medical-certification';
            kycMedCertType = f.type || '';
            setKycMedPreview(kycMedCertName, kycMedCertType, kycMedCertData, f.size);
            const box = document.getElementById('kycMedCertBox');
            if (box) box.classList.remove('error');
        };
        reader.readAsDataURL(f);
    }
    const kycMedCertBox = document.getElementById('kycMedCertBox');
    const kycMedCertInput = document.getElementById('kycMedCertInput');
    if (kycMedCertBox && kycMedCertInput) {
        kycMedCertBox.addEventListener('click', () => kycMedCertInput.click());
        kycMedCertBox.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                kycMedCertInput.click();
            }
        });
        ['dragenter', 'dragover'].forEach(evt => kycMedCertBox.addEventListener(evt, (e) => {
            e.preventDefault();
            kycMedCertBox.classList.add('dragging');
        }));
        ['dragleave', 'drop'].forEach(evt => kycMedCertBox.addEventListener(evt, (e) => {
            e.preventDefault();
            kycMedCertBox.classList.remove('dragging');
        }));
        kycMedCertBox.addEventListener('drop', (e) => {
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (f) handleKycMedCertFile(f);
        });
        kycMedCertInput.addEventListener('change', () => {
            const f = kycMedCertInput.files && kycMedCertInput.files[0];
            handleKycMedCertFile(f);
        });
    }
    const kycMedCertRemove = document.getElementById('kycMedCertRemove');
    if (kycMedCertRemove) {
        kycMedCertRemove.addEventListener('click', (e) => {
            e.stopPropagation();
            clearKycMedPreview();
        });
    }

    // Step navigation: Back (Health Info → Face Scan)
    const kycHealthBackBtn = document.getElementById('kycHealthBackBtn');
    if (kycHealthBackBtn) {
        kycHealthBackBtn.addEventListener('click', () => {
            goToKycStep(2);
        });
    }

    // Step 3 validates health, then advances to Step 4 (Senior ID).
    // NOTE: Step 4 lives on its own screen — wire those buttons where Step 4
    // exists in the DOM flow below (NOT here), so Submit always works.
    function validateKycHealthToSeniorId() {
        const illness = getKycIllnessValue();
        const illnessOtherEl = document.getElementById('kycIllnessOther');
        const illnessOther = illnessOtherEl ? illnessOtherEl.value.trim() : '';
        const otherPicked = kycSelectedIllnesses.has('Other');
        if (!illness) {
            showToast('Please tap at least one option to continue.');
            document.getElementById('kycIllnessBoxGroup')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return false;
        }
        if (otherPicked && !illnessOther) {
            showToast('Please specify your illness under "Others", or remove it.');
            if (illnessOtherEl) illnessOtherEl.focus();
            return false;
        }
        if (illness !== 'None' && !kycMedCertData) {
            const certError = document.getElementById('kycMedCertError');
            if (certError) {
                certError.textContent = 'Please attach your medical certification. This is required when an illness is selected.';
                certError.style.display = 'block';
            }
            const box = document.getElementById('kycMedCertBox');
            if (box) box.classList.add('error');
            showToast('Please attach your medical certification for the reported illness.');
            document.getElementById('kycMedCertBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return false;
        }
        return true;
    }
    const kycHealthNextBtn = document.getElementById('kycHealthNextBtn');
    if (kycHealthNextBtn) {
        kycHealthNextBtn.addEventListener('click', () => {
            if (!capturedFaceData || !kycFaceConfirmed) {
                showToast('Please complete the Face Scan first (scan, then press OK on your photo).');
                goToKycStep(2);
                return;
            }
            if (validateKycHealthToSeniorId()) goToKycStep('seniorid');
        });
    }

    // Step 4 controls live on the Step-4 screen (Senior ID number + back-to-back
    // upload + Submit). They are wired by wireKycStep4() the moment Step 4 is
    // shown, because Step-1 validation returns early and must never own them.
    // Declared with `var` so goToKycStep() (defined above) can call it even
    // though the assignment happens later in this same closure.
    var kycStep4Wired = false;
    var wireKycStep4 = function () {
        if (kycStep4Wired) return;
        const backBtn = document.getElementById('kycSeniorIdBackBtn');
        const sidInput = document.getElementById('kycSeniorIdNumber');
        const submitBtn = document.getElementById('kycSubmitBtn');
        if (!backBtn || !sidInput || !submitBtn) return;
        kycStep4Wired = true;
        backBtn.addEventListener('click', () => { stopAllKycIdCameras(); goToKycStep('health'); });
        sidInput.addEventListener('input', () => {
            const err = document.getElementById('kycSeniorIdError');
            if (err) err.style.display = 'none';
            sidInput.classList.remove('error');
            renderKycReviewBox();
        });
        // Early duplicate warning (non-blocking): the submit handler re-checks
        // and blocks when the ID is already used by another account.
        sidInput.addEventListener('change', async () => {
            const v = (sidInput.value || '').trim();
            if (!v) return;
            const taken = await checkSeniorIdTaken(v);
            if (taken === true) {
                goToKycStep('seniorid');
                showSeniorIdTaken(sidInput);
            }
        });
        // Step 4 owns the ONLY submit action: validate everything, then submit.
        submitBtn.addEventListener('click', () => {
            submitKyc();
        });
    };

    // (No global Submit wiring here — Step 4 is wired by wireKycStep4().)

    // Scan Your Face button
    const kycScanFaceBtn = document.getElementById('kycScanFaceBtn');
    const kycVideo = document.getElementById('kycVideo');
    const kycCanvas = document.getElementById('kycCanvas');
    const kycPlaceholder = document.getElementById('kycCameraPlaceholder');
    const kycFaceGuide = document.getElementById('kycFaceGuide');
    const kycCaptureFlash = document.getElementById('kycCaptureFlash');
    const kycCapturedPreview = document.getElementById('kycCapturedPreview');
    const kycFaceReviewBox = document.getElementById('kycFaceReviewBox');
    const kycRetakeBtn = document.getElementById('kycRetakeBtn');
    const kycUsePhotoBtn = document.getElementById('kycUsePhotoBtn');

    function showKycFaceReview() {
        if (kycCapturedPreview) kycCapturedPreview.style.display = 'block';
        if (kycFaceReviewBox) {
            kycFaceReviewBox.style.display = 'block';
            kycFaceReviewBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
    function hideKycFaceReview() {
        if (kycFaceReviewBox) kycFaceReviewBox.style.display = 'none';
        if (kycCapturedPreview) { kycCapturedPreview.style.display = 'none'; kycCapturedPreview.removeAttribute('src'); }
    }
    function setKycScanIdle(label) {
        if (!kycScanFaceBtn) return;
        kycScanFaceBtn.disabled = false;
        kycScanFaceBtn.innerHTML = label || '<i class="fas fa-user-check"></i> Scan Your Face';
    }
    async function startKycCamera() {
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                showToast('⚠️ This device or browser does not support camera access.');
                setKycScanIdle();
                return false;
            }
            if (kycScanFaceBtn) {
                kycScanFaceBtn.disabled = true;
                kycScanFaceBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting Camera...';
            }
            // Front camera, mirror OFF — preview shows the true camera image.
            kycStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 } });
            kycVideo.style.transform = 'none';
            kycVideo.srcObject = kycStream;
            kycPlaceholder.style.display = 'none';
            kycFaceGuide.classList.add('visible');
            if (kycScanFaceBtn) {
                kycScanFaceBtn.disabled = false;
                kycScanFaceBtn.innerHTML = '<i class="fas fa-camera"></i> Tap to Capture';
                kycScanFaceBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
                kycScanFaceBtn.style.boxShadow = '0 6px 14px rgba(245, 158, 11, 0.3)';
            }
            return true;
        } catch (err) {
            showToast('⚠️ Camera access denied. Please allow camera permissions.');
            console.error('Camera error:', err);
            setKycScanIdle();
            return false;
        }
    }
    function stopKycCamera() {
        if (kycStream) { kycStream.getTracks().forEach(t => t.stop()); kycStream = null; }
        if (kycVideo) kycVideo.srcObject = null;
        if (kycFaceGuide) kycFaceGuide.classList.remove('visible');
    }

    if (kycRetakeBtn) {
        kycRetakeBtn.addEventListener('click', async () => {
            // Discard the photo and let the senior scan again.
            capturedFaceData = null;
            kycFaceConfirmed = false;
            hideKycFaceReview();
            if (kycPlaceholder) kycPlaceholder.style.display = 'none';
            setKycScanIdle('<i class="fas fa-camera"></i> Tap to Capture');
            showToast('Photo discarded. Please scan your face again.');
            await startKycCamera();
        });
    }
    if (kycUsePhotoBtn) {
        kycUsePhotoBtn.addEventListener('click', () => {
            if (!capturedFaceData) {
                showToast('Please scan your face first.');
                return;
            }
            kycFaceConfirmed = true;
            if (kycFaceReviewBox) kycFaceReviewBox.style.display = 'none';
            goToKycStep('health');
        });
    }

    if (kycScanFaceBtn) {
        kycScanFaceBtn.addEventListener('click', async () => {
            // Face already captured AND senior already pressed OK → continue.
            // If not yet confirmed, stay here and show the photo for review.
            if (capturedFaceData) {
                if (kycFaceConfirmed) { goToKycStep('health'); return; }
                showKycFaceReview();
                return;
            }

            // If camera is already streaming, capture the frame
            if (kycStream) {
                captureFaceAndSubmit();
                return;
            }

            // Start camera (front lens, mirror OFF)
            await startKycCamera();
        });
    }

    async function captureFaceAndSubmit() {
        if (!kycStream || !kycVideo || !kycCanvas) return;

        // Capture frame — NO mirroring: draw the frame exactly as the camera
        // produced it, so the saved photo matches what the senior saw.
        kycCanvas.width = kycVideo.videoWidth;
        kycCanvas.height = kycVideo.videoHeight;
        const ctx = kycCanvas.getContext('2d');
        ctx.drawImage(kycVideo, 0, 0);

        // Flash effect
        if (kycCaptureFlash) {
            kycCaptureFlash.classList.remove('flash');
            void kycCaptureFlash.offsetWidth;
            kycCaptureFlash.classList.add('flash');
        }

        // ── Face Detection Validation ──────────────────────────────────
        kycScanFaceBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Detecting face...';
        kycScanFaceBtn.disabled = true;

        let faceDetected = false;

        try {
            // Try browser-native FaceDetector API (Chrome/Edge)
            if ('FaceDetector' in window) {
                const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
                const faces = await detector.detect(kycCanvas);
                if (faces.length === 1) {
                    // Validate face size — must be at least 10% of image area
                    const faceArea = faces[0].boundingBox.width * faces[0].boundingBox.height;
                    const imageArea = kycCanvas.width * kycCanvas.height;
                    faceDetected = (faceArea / imageArea) > 0.04;
                    if (faces.length > 1) {
                        showToast('⚠️ Multiple faces detected. Please ensure only your face is in the frame.');
                        resetScanButton();
                        return;
                    }
                } else if (faces.length > 1) {
                    showToast('⚠️ Multiple faces detected. Please ensure only your face is in the frame.');
                    resetScanButton();
                    return;
                }
            }

            // Fallback: Canvas skin-tone pixel analysis
            if (!faceDetected) {
                const imageData = ctx.getImageData(0, 0, kycCanvas.width, kycCanvas.height);
                const data = imageData.data;
                let skinPixels = 0;
                const totalPixels = data.length / 4;

                // Sample center 60% of image (where face should be)
                const startX = Math.floor(kycCanvas.width * 0.2);
                const endX = Math.floor(kycCanvas.width * 0.8);
                const startY = Math.floor(kycCanvas.height * 0.1);
                const endY = Math.floor(kycCanvas.height * 0.7);
                let sampledPixels = 0;

                for (let y = startY; y < endY; y += 2) {
                    for (let x = startX; x < endX; x += 2) {
                        const idx = (y * kycCanvas.width + x) * 4;
                        const r = data[idx], g = data[idx + 1], b = data[idx + 2];

                        // Skin tone detection (works across skin colors)
                        const isSkin = (
                            r > 60 && g > 40 && b > 20 &&
                            r > g && r > b &&
                            (r - g) > 10 &&
                            Math.abs(r - g) < 130 &&
                            (r + g + b) > 150 && (r + g + b) < 700
                        );

                        if (isSkin) skinPixels++;
                        sampledPixels++;
                    }
                }

                const skinRatio = skinPixels / sampledPixels;
                // A real face in the oval should have 15-75% skin-tone pixels
                faceDetected = skinRatio > 0.12 && skinRatio < 0.80;
            }
        } catch (detectionErr) {
            console.warn('Face detection fallback used:', detectionErr);
            // If detection APIs fail completely, do basic brightness check
            const imageData = ctx.getImageData(0, 0, kycCanvas.width, kycCanvas.height);
            const data = imageData.data;
            let totalBrightness = 0;
            const pixelCount = data.length / 4;
            for (let i = 0; i < data.length; i += 16) {
                totalBrightness += (data[i] + data[i + 1] + data[i + 2]) / 3;
            }
            const avgBrightness = totalBrightness / (pixelCount / 4);
            // Reject pure black/white images (no camera or blank wall)
            faceDetected = avgBrightness > 30 && avgBrightness < 240;
        }

        if (!faceDetected) {
            showToast('⚠️ No face detected! Please position your face clearly within the oval frame and try again.');
            resetScanButton();
            return;
        }

        // ── Face validated — show the photo for RETAKE / OK review ──────
        // Do NOT auto-advance: the senior must see the scanned face and pick
        // "Retake" or "OK — Use This Photo" first.
        capturedFaceData = kycCanvas.toDataURL('image/jpeg', 0.7);
        kycFaceConfirmed = false;

        // Stop camera
        stopKycCamera();

        // Show the scanned face + review box (Retake / OK — Use This Photo)
        if (kycCapturedPreview) kycCapturedPreview.src = capturedFaceData;
        showKycFaceReview();
        showToast('Please check your photo. Press OK if it looks good, or Retake to scan again.');

        // Update button
        kycScanFaceBtn.innerHTML = '<i class="fas fa-eye"></i> Review Your Photo';
        kycScanFaceBtn.disabled = false;
    }

    function resetScanButton() {
        if (kycScanFaceBtn) {
            kycScanFaceBtn.disabled = false;
            kycScanFaceBtn.innerHTML = '<i class="fas fa-camera"></i> Tap to Capture';
            kycScanFaceBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
            kycScanFaceBtn.style.boxShadow = '0 6px 14px rgba(245, 158, 11, 0.3)';
        }
    }

    // `var` so the Step-4 Submit wiring (registered earlier) can call it.
    var submitKyc = async function () {
        if (!currentUserData) return;
        if (!capturedFaceData) {
            showToast('Please complete the Face Scan first.');
            goToKycStep(2);
            return;
        }
        if (!kycFaceConfirmed) {
            // Senior scanned but never pressed OK — show the photo and stop.
            showToast('Please confirm your scanned photo first (OK or Retake).');
            goToKycStep(2);
            return;
        }

        // ── Step 3 re-validated at submit: illness question + med cert ──
        let illness = getKycIllnessValue();
        const illnessOtherEl = document.getElementById('kycIllnessOther');
        const illnessOther = illnessOtherEl ? illnessOtherEl.value.trim() : '';
        const otherPicked = kycSelectedIllnesses.has('Other');

        if (!illness) {
            showToast('Please answer the illness question to complete your verification.');
            goToKycStep('health');
            document.getElementById('kycIllnessBoxGroup')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        if (otherPicked && !illnessOther) {
            showToast('Please specify your illness under "Others", or remove it.');
            goToKycStep('health');
            if (illnessOtherEl) illnessOtherEl.focus();
            return;
        }
        const hasReportedIllness = illness !== 'None';

        // Medical certification is required only when an illness is reported.
        // Seniors who select No Illness / Healthy skip this upload.
        if (hasReportedIllness && !kycMedCertData) {
            const certError = document.getElementById('kycMedCertError');
            if (certError) {
                certError.textContent = 'Please attach your medical certification. This is required when an illness is selected.';
                certError.style.display = 'block';
            }
            showToast('Please attach your medical certification for the reported illness.');
            goToKycStep('health');
            document.getElementById('kycMedCertBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }

        // Disable the submit button while submitting — ALWAYS reset it below
        const kycSubmitBtnEl = document.getElementById('kycSubmitBtn');
        const submitOriginalHtml = '<i class="fas fa-paper-plane"></i> Submit Verification';
        function resetKycSubmitBtn() {
            if (kycSubmitBtnEl) {
                kycSubmitBtnEl.disabled = false;
                kycSubmitBtnEl.innerHTML = submitOriginalHtml;
            }
        }
        if (kycSubmitBtnEl) {
            kycSubmitBtnEl.disabled = true;
            kycSubmitBtnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…';
        }

        // ── Step 4 validated at submit: Senior ID number + back-to-back ──
        const verificationSeniorId = getKycSeniorIdNumber();
        if (!verificationSeniorId) {
            showToast('Please enter your Senior Citizen ID Number.');
            goToKycStep('seniorid');
            const sidField = document.getElementById('kycSeniorIdNumber');
            const sidErr = document.getElementById('kycSeniorIdError');
            if (sidErr) { sidErr.textContent = 'Senior Citizen ID Number is required.'; sidErr.style.display = 'block'; }
            if (sidField) { sidField.classList.add('error'); sidField.focus(); }
            resetKycSubmitBtn();
            return;
        }
        if (!kycIdFrontData || !kycIdBackData) {
            showToast('Front and back of your Senior ID are required. Please upload both sides.');
            goToKycStep('seniorid');
            const errEl = document.getElementById('kycIdUploadError');
            if (errEl) errEl.style.display = 'block';
            document.getElementById('kycIdFrontBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            resetKycSubmitBtn();
            return;
        }

        // ── Duplicate Senior ID block (privacy-safe) ──
        // Notifies the senior when the ID is already used by another account.
        // The server only answers taken:true/false — no account is ever named.
        // Fail-open on network error: staff review remains the final authority.
        const idTaken = await checkSeniorIdTaken(verificationSeniorId);
        if (idTaken === true) {
            goToKycStep('seniorid');
            showSeniorIdTaken(document.getElementById('kycSeniorIdNumber'));
            resetKycSubmitBtn();
            return;
        }

        const firstName = document.getElementById('kycFirstName').value.trim();
        const middleName = document.getElementById('kycMiddleName').value.trim();
        const lastName = document.getElementById('kycLastName').value.trim();
        const extension = document.getElementById('kycExtension').value.trim();
        const address = document.getElementById('kycAddress').value.trim();
        // Enforce fixed service area (tamper-proof even via devtools).
        const province = FIXED_PROVINCE;
        const city = FIXED_CITY;
        const barangay = (document.getElementById('kycBarangay').value || '').trim();
        if (!barangay || !MAGALANG_BARANGAYS.includes(barangay)) {
            showToast('⚠️ Please select a valid Magalang barangay.');
            goToKycStep(1);
            resetKycSubmitBtn();
            return;
        }
        const citizenship = document.getElementById('kycCitizenship').value.trim();
        const cpNumber = document.getElementById('kycCpNumber').value.trim();
        const dob = document.getElementById('kycDob').value;
        const healthCondition = document.getElementById('kycHealthCondition')?.value || '';
        // Sex and Civil Status — also sync to Profile (profile auto-updates from verification)
        let kycSex = document.getElementById('kycSex')?.value || '';
        let kycCivilStatus = document.getElementById('kycCivilStatus')?.value || '';
        // If milestone Annex A form is visible, prefer its Sex/Civil Status if filled (Octogenarian 80+ case)
        const msSexEl = document.getElementById('sex');
        const msCivilEl = document.getElementById('civilStatus');
        if (msSexEl && msSexEl.value) kycSex = msSexEl.value;
        if (msCivilEl && msCivilEl.value) kycCivilStatus = msCivilEl.value;

        // Age is auto-computed from the birthdate — never typed, so a "0 age"
        // is impossible. Defense-in-depth: recompute it here too and enforce
        // the same 60+ eligibility rule as Step 1.
        // NOTE: this runs BEFORE the submit button is disabled, so no reset needed.
        let age = computeAgeFromDobValue(dob);
        if (age === null || age === undefined || isNaN(age)) {
            showToast('⚠️ Please enter a valid Date of Birth so your age can be computed.');
            goToKycStep(1);
            return;
        }
        if (age < 60) {
            showToast("You're not eligible. You must be a senior.");
            goToKycStep(1);
            return;
        }

        // Determine priority level — OSCA milestone rule (80-89 Low, 90-99 Medium, 100+ High)
        // WITH the health-condition override: any reported illness → High priority,
        // even when the age does not pass the milestone criteria.
        let priorityLevel = 'Low';
        const hasIllness = illness !== 'None';
        if (hasIllness) {
            priorityLevel = 'High';
        } else if (age >= 100) {
            priorityLevel = 'High';
        } else if (age >= 90) {
            priorityLevel = 'Medium';
        } else {
            priorityLevel = 'Low';
        }

        const fullName = [firstName, middleName, lastName]
            .filter(Boolean)
            .join(' ') + (extension ? ` ${extension}` : '');

        // Age-based milestone category (80-89 Octogenarian, 90-99 Nonagenarian, 100 Centenarian)
        const milestoneCategory = getKycMilestoneCategory(age);

        const kycUpdates = {
            name: fullName,
            firstName: firstName,
            middleName: middleName,
            lastName: lastName,
            extension: extension,
            address: address,
            province: province,
            barangay: barangay,
            city: city,
            citizenship: citizenship,
            cpNumber: cpNumber,
            dob: dob,
            age: age,
            sex: kycSex,
            civilStatus: kycCivilStatus,
            healthCondition: hasIllness ? illness : 'No Illness / Healthy',
            illnessDetails: hasIllness ? illness : '',
            illnessReportedAt: hasIllness ? Date.now() : null,
            priorityLevel: priorityLevel,
            kycStatus: 'Pending',
            kycFaceImage: capturedFaceData,
            kycIdFrontImage: kycIdFrontData,
            kycIdBackImage: kycIdBackData,
            kycMedCertImage: hasReportedIllness && kycMedCertData ? kycMedCertData : null,
            kycMedCertName: hasReportedIllness && kycMedCertData ? kycMedCertName : '',
            kycMedCertType: hasReportedIllness && kycMedCertData ? kycMedCertType : '',
            kycSubmittedAt: Date.now(),
            seniorCategory: milestoneCategory || '',
            seniorCategoryAssignedAt: milestoneCategory ? Date.now() : null,
            verificationSeniorId: verificationSeniorId
        };

        // If the senior provided their ID and has no OSCA ID on file yet, keep it in sync
        if (verificationSeniorId && (!currentUserData.seniorId || currentUserData.seniorId === 'OSCA-PENDING')) {
            kycUpdates.seniorId = verificationSeniorId;
        }

        try {
            await update(ref(db, 'users/' + currentUserData.uid), kycUpdates);

            // Mirror the KYC data to Supabase against THIS senior's record:
            // face + back-to-back Senior ID (+ med cert when present) stored under
            // seniors/{folderKey}/..., and the metadata row keyed by uid.
            try {
                const token = await auth.currentUser.getIdToken();
                const syncRes = await fetch('/api/supabase/sync-senior', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({
                        uid: currentUserData.uid,
                        faceImage: capturedFaceData,
                        idFrontImage: kycIdFrontData,
                        idBackImage: kycIdBackData,
                        medCertImage: hasReportedIllness && kycMedCertData ? kycMedCertData : null,
                        medCertName: hasReportedIllness && kycMedCertData ? kycMedCertName : '',
                        medCertType: hasReportedIllness && kycMedCertData ? kycMedCertType : '',
                        healthCondition: hasReportedIllness ? illness : 'No Illness / Healthy'
                    })
                });
                const syncJson = await syncRes.json().catch(() => ({}));
                if (!syncRes.ok || !syncJson.success) {
                    console.warn('Supabase mirror skipped:', (syncJson && syncJson.message) || syncRes.statusText);
                }
            } catch (err) {
                console.warn('Supabase mirror skipped:', err);
            }

            showToast('Verification submitted. An employee will review your information.');
            resetKycSubmitBtn();
            currentUserData = { ...currentUserData, ...kycUpdates };
            kycSubmitBtnEl.disabled = true;
            kycSubmitBtnEl.innerHTML = '<i class="fas fa-check"></i> Submitted — Pending Review';
            renderKycVerificationStatus(currentUserData);
        } catch (err) {
            console.error('KYC submit error:', err);
            showToast('Failed to submit verification. Please try again.');

            // Reset button
            resetKycSubmitBtn();
        }
    };

    // ══════════════════════════════════════════════════════════════════
    // UPDATE HEALTH + MEDICAL CERTIFICATION (VERIFIED senior accounts only)
    // The senior describes the illness and uploads a medical certification.
    // The physical file is stored in the PRIVATE Supabase vault (pending/)
    // and the metadata is written to Firebase. OSCA staff review the
    // certification and set the OFFICIAL health condition + priority level
    // — the human decision, never an automatic one.
    // ═════════════════════════════════════════════════════════════════
    const HEALTH_CERT_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    const HEALTH_CERT_MAX_BYTES = 7 * 1024 * 1024;
    let healthCertFile = null;

    function formatHealthBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
        if (n >= 1024) return Math.round(n / 1024) + ' KB';
        return n + ' B';
    }

    function formatHealthDate(ts) {
        if (!ts) return '—';
        try {
            return new Date(ts).toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            return new Date(ts).toLocaleDateString();
        }
    }

    function healthPriorityBadge(level) {
        const map = {
            High: 'background:#fee2e2; color:#b91c1c; border:1px solid #fecaca;',
            Medium: 'background:#ffedd5; color:#c2410c; border:1px solid #fed7aa;',
            Low: 'background:#dcfce7; color:#15803d; border:1px solid #bbf7d0;'
        };
        const lvl = ['Low', 'Medium', 'High'].includes(level) ? level : 'Low';
        return `<span style="font-size:0.72rem; padding:4px 10px; border-radius:12px; font-weight:700; ${map[lvl]}">${lvl} Priority</span>`;
    }

    function healthReportStatusBadge(status) {
        const s = status || 'Pending Review';
        const map = {
            'Pending Review': 'background:#e0f2fe; color:#0284c7;',
            'Reviewed': 'background:#dcfce7; color:#15803d;',
            'Rejected': 'background:#fee2e2; color:#b91c1c;'
        };
        return `<span style="font-size:0.72rem; padding:4px 10px; border-radius:12px; font-weight:700; ${map[s] || map['Pending Review']}">${escapeHtml(s)}</span>`;
    }

    /** Shows an inline success/error/info message inside the health card. */
    function setHealthNotice(kind, message) {
        const box = document.getElementById('healthUpdateNotice');
        if (!box) return;
        const styles = {
            success: 'background:#f0fdf4; border:1px solid #bbf7d0; color:#166534;',
            error: 'background:#fef2f2; border:1px solid #fecaca; color:#991b1b;',
            info: 'background:#f0f9ff; border:1px solid #bae6fd; color:#075985;'
        };
        const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info' };
        box.style.cssText = `display:block; border-radius:10px; padding:12px 16px; font-size:0.86rem; line-height:1.5; margin-bottom:14px; ${styles[kind] || styles.info}`;
        box.innerHTML = `<i class="fas ${icons[kind] || icons.info}" style="margin-right:8px;"></i>${escapeHtml(message)}`;
    }

    function clearHealthNotice() {
        const box = document.getElementById('healthUpdateNotice');
        if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    }

    /** Reads a File object into base64 after validating type + size. */
    function readHealthCertFile(file) {
        return new Promise((resolve, reject) => {
            if (!file) return reject(new Error('Please choose your medical certification file.'));
            if (!HEALTH_CERT_ALLOWED_TYPES.includes(file.type)) {
                return reject(new Error('Unsupported file type. Please upload a JPG, PNG, WEBP or PDF file.'));
            }
            if (file.size > HEALTH_CERT_MAX_BYTES) {
                return reject(new Error(`The file is ${formatHealthBytes(file.size)} — the maximum allowed size is 7 MB.`));
            }
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('The file could not be read. Please try again.'));
            reader.onload = () => {
                const result = String(reader.result || '');
                const base64 = result.includes(',') ? result.split(',')[1] : result;
                if (!base64) return reject(new Error('The file could not be read. Please try again.'));
                resolve({ name: file.name, mimeType: file.type, base64: base64, size: file.size });
            };
            reader.readAsDataURL(file);
        });
    }

    /** Renders the OFFICIAL health record + priority set by OSCA staff. */
    function renderHealthOfficialBox(userData) {
        const box = document.getElementById('healthOfficialBox');
        if (!box) return;
        const condition = userData ? String(userData.healthCondition || userData.condition || '').trim() : '';
        const priority = userData ? String(userData.staffPriorityLevel || '').trim() : '';
        if (!condition && !priority) { box.style.display = 'none'; box.innerHTML = ''; return; }

        const details = userData.illnessDetails ? escapeHtml(userData.illnessDetails) : '';
        const by = userData.staffPrioritySetByName ? escapeHtml(userData.staffPrioritySetByName) : 'OSCA Staff';
        const when = userData.staffPrioritySetAt ? formatHealthDate(userData.staffPrioritySetAt) : '';

        box.style.display = 'block';
        box.innerHTML = `
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:18px 20px;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
                    <h4 style="margin:0; font-size:0.92rem; font-weight:700; color:#1e293b; display:flex; align-items:center; gap:8px;">
                        <i class="fas fa-clipboard-check" style="color:#2563eb;"></i> Official Health Record (set by OSCA staff)
                    </h4>
                    ${priority ? healthPriorityBadge(priority) : ''}
                </div>
                <div style="font-size:0.88rem; color:#334155; line-height:1.6;">
                    <div><span style="color:#64748b; font-weight:600;">Condition:</span> <strong>${escapeHtml(condition || 'Not set')}</strong></div>
                    ${details ? `<div style="margin-top:6px;"><span style="color:#64748b; font-weight:600;">Details:</span> ${details}</div>` : ''}
                    ${when ? `<div style="margin-top:8px; font-size:0.75rem; color:#94a3b8;">Updated by ${by} on ${when}</div>` : ''}
                </div>
            </div>`;
    }

    /** Renders the senior's own history of submitted health updates. */
    function renderHealthUpdateHistory(reportsMap) {
        const wrap = document.getElementById('healthUpdateHistoryWrap');
        const list = document.getElementById('healthUpdateHistory');
        if (!wrap || !list) return;

        const reports = Object.entries(reportsMap || {})
            .map(([id, r]) => ({ id, ...r }))
            .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

        if (!reports.length) { wrap.style.display = 'none'; list.innerHTML = ''; return; }

        wrap.style.display = 'block';
        list.innerHTML = reports.slice(0, 8).map(r => `
            <div style="border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px; background:#ffffff;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
                    <div style="min-width:0;">
                        <div style="font-size:0.9rem; font-weight:700; color:#1e293b;">${escapeHtml(r.illness || 'Health update')}</div>
                        <div style="font-size:0.75rem; color:#94a3b8; margin-top:3px;">Submitted ${formatHealthDate(r.submittedAt)}</div>
                    </div>
                    ${healthReportStatusBadge(r.status)}
                </div>
                ${r.description ? `<div style="margin-top:8px; font-size:0.82rem; color:#475569; line-height:1.5;">${escapeHtml(r.description)}</div>` : ''}
                <div style="margin-top:10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:0.76rem; color:#64748b;">
                    <i class="fas fa-paperclip"></i>
                    ${r.hasCertification
                        ? `<span style="font-weight:600; color:#334155; word-break:break-all;">${escapeHtml(r.fileName || 'Medical certification')}</span>${r.size ? ` <span style="color:#94a3b8;">(${formatHealthBytes(r.size)})</span>` : ''}`
                        : '<span>No certification attached</span>'}
                    ${r.hasCertification ? `<button type="button" data-report-view="${escapeHtml(r.id)}" style="margin-left:auto; border:1px solid #2563eb; background:#eff6ff; color:#1d4ed8; font-size:0.72rem; font-weight:700; padding:5px 12px; border-radius:8px; cursor:pointer;"><i class="fas fa-eye" style="margin-right:4px;"></i>View</button>` : ''}
                </div>
                ${r.status === 'Reviewed' ? `
                <div style="margin-top:10px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:10px 12px; font-size:0.8rem; color:#166534; line-height:1.5;">
                    <i class="fas fa-check-circle" style="margin-right:6px;"></i>
                    <strong>Reviewed by OSCA staff</strong>${r.reviewedByName ? ` (${escapeHtml(r.reviewedByName)})` : ''} on ${formatHealthDate(r.reviewedAt)}.
                    ${r.reviewedIllness ? `<div style="margin-top:4px;">Official condition: <strong>${escapeHtml(r.reviewedIllness)}</strong></div>` : ''}
                    ${r.priorityLevel ? `<div style="margin-top:4px;">Priority level: <strong>${escapeHtml(r.priorityLevel)}</strong></div>` : ''}
                </div>` : ''}
                ${r.status === 'Rejected' ? `
                <div style="margin-top:10px; background:#fef2f2; border:1px solid #fecaca; border-radius:10px; padding:10px 12px; font-size:0.8rem; color:#991b1b; line-height:1.5;">
                    <i class="fas fa-circle-exclamation" style="margin-right:6px;"></i>
                    <strong>Not accepted.</strong>${r.reviewNotes ? ` Reason: ${escapeHtml(r.reviewNotes)}` : ''} You may submit a clearer certification.
                </div>` : ''}
            </div>`).join('');
    }

    /** Locked/unlocked state + official record + latest-status box + history. */
    function renderHealthUpdateCard(userData) {
        const card = document.getElementById('healthUpdateCard');
        if (!card || !userData) return;

        const lockedBox = document.getElementById('healthUpdateLockedBox');
        const formBox = document.getElementById('healthUpdateForm');
        const statusBox = document.getElementById('healthUpdateStatusBox');
        // Requirement: this feature is available to VERIFIED senior accounts only.
        const allowed = !!(userData.kycStatus === 'Verified' || userData.kycVerifiedAt);

        if (lockedBox) lockedBox.style.display = allowed ? 'none' : 'block';
        if (formBox) formBox.style.display = allowed ? 'block' : 'none';
        if (statusBox) statusBox.style.display = allowed ? 'block' : 'none';

        renderHealthOfficialBox(allowed ? userData : null);
        renderHealthUpdateHistory(allowed ? (userData.healthReports || {}) : {});

        if (!statusBox) return;
        if (!allowed) { statusBox.innerHTML = ''; return; }

        const reports = Object.entries(userData.healthReports || {})
            .map(([id, r]) => ({ id, ...r }))
            .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
        const latest = reports[0];

        if (!latest) {
            statusBox.innerHTML = `
                <div style="background:#f8fafc; border:1px dashed #cbd5e1; border-radius:12px; padding:16px 18px; font-size:0.86rem; color:#64748b; line-height:1.55;">
                    <i class="fas fa-inbox" style="margin-right:8px;"></i>You have not submitted a health update yet. Fill in the form above and attach your medical certification.
                </div>`;
            return;
        }

        if (latest.status === 'Pending Review') {
            statusBox.innerHTML = `
                <div style="background:#f0f9ff; border:1px solid #bae6fd; border-radius:12px; padding:16px 18px; font-size:0.86rem; color:#075985; line-height:1.6;">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
                        <strong><i class="fas fa-hourglass-half" style="margin-right:8px;"></i>Your latest health update is awaiting OSCA review</strong>
                        ${healthReportStatusBadge(latest.status)}
                    </div>
                    <div style="margin-top:8px;">Illness reported: <strong>${escapeHtml(latest.illness || '—')}</strong></div>
                    ${latest.hasCertification ? `<div style="margin-top:4px;">Medical certification: <strong>${escapeHtml(latest.fileName || 'attached')}</strong></div>` : ''}
                    <div style="margin-top:4px;">Submitted: ${formatHealthDate(latest.submittedAt)}</div>
                    <div style="margin-top:8px; font-size:0.8rem;">OSCA staff will view your certification and set your official health record and priority level.</div>
                </div>`;
            return;
        }

        if (latest.status === 'Reviewed') {
            statusBox.innerHTML = `
                <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:16px 18px; font-size:0.86rem; color:#166534; line-height:1.6;">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
                        <strong><i class="fas fa-check-circle" style="margin-right:8px;"></i>Your health update has been recorded</strong>
                        ${healthReportStatusBadge(latest.status)}
                    </div>
                    <div style="margin-top:8px;">Official condition: <strong>${escapeHtml(latest.reviewedIllness || latest.illness || '—')}</strong></div>
                    <div style="margin-top:4px;">Priority level set by OSCA staff: <strong>${escapeHtml(latest.priorityLevel || '—')}</strong></div>
                    <div style="margin-top:4px;">Reviewed by ${escapeHtml(latest.reviewedByName || 'OSCA Staff')} on ${formatHealthDate(latest.reviewedAt)}</div>
                    ${latest.reviewNotes ? `<div style="margin-top:6px;">Remarks: ${escapeHtml(latest.reviewNotes)}</div>` : ''}
                </div>`;
            return;
        }

        statusBox.innerHTML = `
            <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:12px; padding:16px 18px; font-size:0.86rem; color:#991b1b; line-height:1.6;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
                    <strong><i class="fas fa-circle-exclamation" style="margin-right:8px;"></i>Your latest health update was not accepted</strong>
                    ${healthReportStatusBadge(latest.status)}
                </div>
                <div style="margin-top:8px;">Illness reported: <strong>${escapeHtml(latest.illness || '—')}</strong></div>
                ${latest.reviewNotes ? `<div style="margin-top:4px;">Reason: ${escapeHtml(latest.reviewNotes)}</div>` : ''}
                <div style="margin-top:8px; font-size:0.8rem;">Please submit a clearer medical certification so OSCA staff can review it.</div>
            </div>`;
    }

    // ── Medical certification file picker wiring ─────────────────────────────
    const healthCertInput = document.getElementById('healthCertInput');
    const healthCertDrop = document.getElementById('healthCertDrop');
    const healthCertPreview = document.getElementById('healthCertPreview');
    const healthCertFileName = document.getElementById('healthCertFileName');
    const healthCertRemoveBtn = document.getElementById('healthCertRemoveBtn');
    const healthUpdateSubmitBtn = document.getElementById('healthUpdateSubmitBtn');

    function resetHealthCertFile() {
        healthCertFile = null;
        if (healthCertInput) healthCertInput.value = '';
        if (healthCertPreview) healthCertPreview.style.display = 'none';
        if (healthCertFileName) healthCertFileName.textContent = 'No file selected';
        const title = document.getElementById('healthCertTitle');
        const hint = document.getElementById('healthCertHint');
        if (title) title.textContent = 'Tap to attach your medical certification';
        if (hint) hint.textContent = "Doctor's certificate, medical abstract, laboratory result or prescription — JPG, PNG, WEBP or PDF (max 7 MB)";
    }

    function showHealthCertFile(file) {
        healthCertFile = file;
        if (healthCertFileName) healthCertFileName.textContent = `${file.name} (${formatHealthBytes(file.size)})`;
        if (healthCertPreview) healthCertPreview.style.display = 'flex';
        const title = document.getElementById('healthCertTitle');
        const hint = document.getElementById('healthCertHint');
        if (title) title.textContent = 'Certification attached';
        if (hint) hint.textContent = 'Tap to replace the attached file.';
    }

    if (healthCertDrop && healthCertInput) {
        healthCertDrop.addEventListener('click', () => healthCertInput.click());
        healthCertDrop.addEventListener('dragover', (e) => { e.preventDefault(); healthCertDrop.style.borderColor = '#2563eb'; healthCertDrop.style.background = '#eff6ff'; });
        healthCertDrop.addEventListener('dragleave', () => { healthCertDrop.style.borderColor = '#cbd5e1'; healthCertDrop.style.background = '#f8fafc'; });
        healthCertDrop.addEventListener('drop', (e) => {
            e.preventDefault();
            healthCertDrop.style.borderColor = '#cbd5e1';
            healthCertDrop.style.background = '#f8fafc';
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!f) return;
            if (!HEALTH_CERT_ALLOWED_TYPES.includes(f.type)) { setHealthNotice('error', 'Unsupported file type. Please upload a JPG, PNG, WEBP or PDF file.'); return; }
            if (f.size > HEALTH_CERT_MAX_BYTES) { setHealthNotice('error', `The file is ${formatHealthBytes(f.size)} — the maximum allowed size is 7 MB.`); return; }
            clearHealthNotice();
            showHealthCertFile(f);
        });
        healthCertInput.addEventListener('change', () => {
            const f = healthCertInput.files && healthCertInput.files[0];
            if (!f) return;
            if (!HEALTH_CERT_ALLOWED_TYPES.includes(f.type)) { setHealthNotice('error', 'Unsupported file type. Please upload a JPG, PNG, WEBP or PDF file.'); resetHealthCertFile(); return; }
            if (f.size > HEALTH_CERT_MAX_BYTES) { setHealthNotice('error', `The file is ${formatHealthBytes(f.size)} — the maximum allowed size is 7 MB.`); resetHealthCertFile(); return; }
            clearHealthNotice();
            showHealthCertFile(f);
        });
    }
    if (healthCertRemoveBtn) {
        healthCertRemoveBtn.addEventListener('click', (e) => { e.stopPropagation(); resetHealthCertFile(); clearHealthNotice(); });
    }

    // ── "Do you have an illness?" toggle + "Enter manually" wiring ───────────
    const healthIllnessYesBtn = document.getElementById('healthIllnessYesBtn');
    const healthIllnessNoBtn = document.getElementById('healthIllnessNoBtn');
    const healthHasIllnessInput = document.getElementById('healthHasIllness');
    const healthHealthyNote = document.getElementById('healthHealthyNote');
    const healthIllnessSection = document.getElementById('healthIllnessSection');
    const healthIllnessSelectEl = document.getElementById('healthIllnessSelect');
    const healthIllnessManualInput = document.getElementById('healthIllnessManualInput');

    const HEALTH_BTN_IDLE = 'border:2px solid #cbd5e1; background:white; color:#475569; font-weight:600; font-size:0.88rem; padding:10px 18px; border-radius:10px; cursor:pointer; transition:0.15s;';
    const HEALTH_YES_ACTIVE = 'border:2px solid #059669; background:#059669; color:#fff; font-weight:700; font-size:0.88rem; padding:10px 18px; border-radius:10px; cursor:pointer; transition:0.15s;';
    const HEALTH_NO_ACTIVE = 'border:2px solid #64748b; background:#64748b; color:#fff; font-weight:700; font-size:0.88rem; padding:10px 18px; border-radius:10px; cursor:pointer; transition:0.15s;';

    /** Shows/hides the illness + certification sections based on the Yes/No choice. */
    function applyHealthIllnessState() {
        const choice = healthHasIllnessInput ? healthHasIllnessInput.value : '';
        const hasIllness = choice === 'yes';
        if (healthHealthyNote) healthHealthyNote.style.display = choice === 'no' ? 'block' : 'none';
        if (healthIllnessSection) healthIllnessSection.style.display = hasIllness ? 'block' : 'none';
        if (healthIllnessYesBtn) healthIllnessYesBtn.style.cssText = hasIllness ? HEALTH_YES_ACTIVE : HEALTH_BTN_IDLE;
        if (healthIllnessNoBtn) healthIllnessNoBtn.style.cssText = choice === 'no' ? HEALTH_NO_ACTIVE : HEALTH_BTN_IDLE;
    }

    if (healthIllnessYesBtn) {
        healthIllnessYesBtn.addEventListener('click', () => {
            if (healthHasIllnessInput) healthHasIllnessInput.value = 'yes';
            applyHealthIllnessState();
            clearHealthNotice();
        });
    }
    if (healthIllnessNoBtn) {
        healthIllnessNoBtn.addEventListener('click', () => {
            if (healthHasIllnessInput) healthHasIllnessInput.value = 'no';
            applyHealthIllnessState();
            clearHealthNotice();
        });
    }
    if (healthIllnessSelectEl) {
        healthIllnessSelectEl.addEventListener('change', () => {
            const manual = healthIllnessSelectEl.value === '__manual__';
            if (healthIllnessManualInput) {
                healthIllnessManualInput.style.display = manual ? 'block' : 'none';
                if (manual) healthIllnessManualInput.focus();
                else healthIllnessManualInput.value = '';
            }
        });
    }

    /** Resets the illness choice + selection back to the initial state. */
    function resetHealthIllnessForm() {
        if (healthHasIllnessInput) healthHasIllnessInput.value = '';
        if (healthIllnessSelectEl) healthIllnessSelectEl.value = '';
        if (healthIllnessManualInput) { healthIllnessManualInput.value = ''; healthIllnessManualInput.style.display = 'none'; }
        const detailsEl = document.getElementById('healthIllnessDetails');
        if (detailsEl) detailsEl.value = '';
        applyHealthIllnessState();
    }
    applyHealthIllnessState();

    // ── Submit the health update + medical certification ─────────────────────
    async function submitHealthUpdate() {
        // Client-side gate mirrors the server rule: VERIFIED accounts only.
        if (!currentUserData || !(currentUserData.kycStatus === 'Verified' || currentUserData.kycVerifiedAt)) {
            setHealthNotice('error', 'This feature is for verified senior accounts only. Please complete your identity verification first.');
            return;
        }

        const choice = healthHasIllnessInput ? healthHasIllnessInput.value : '';
        if (!choice) {
            setHealthNotice('error', 'Please answer first: do you have an illness or health condition?');
            return;
        }

        let illness;
        let needsCert = false;
        if (choice === 'no') {
            // Healthy — no illness reported, so NO medical certification is required.
            illness = 'None — healthy (no illness reported)';
        } else {
            const selected = healthIllnessSelectEl ? healthIllnessSelectEl.value : '';
            if (!selected) {
                setHealthNotice('error', 'Please select your illness or health condition, or choose "Enter manually".');
                return;
            }
            if (selected === '__manual__') {
                const manual = healthIllnessManualInput ? healthIllnessManualInput.value.trim() : '';
                if (manual.length < 2) {
                    setHealthNotice('error', 'You chose "Enter manually" — please type your illness or health condition.');
                    return;
                }
                illness = manual;
            } else {
                illness = selected;
            }
            needsCert = true; // An illness was reported, so the medical certification is REQUIRED.
        }

        if (needsCert && !healthCertFile) {
            setHealthNotice('error', 'Please attach your medical certification (doctor\'s certificate, medical abstract, lab result or prescription). It is required when reporting an illness.');
            return;
        }

        const detailsEl = document.getElementById('healthIllnessDetails');
        const details = detailsEl ? detailsEl.value.trim() : '';

        const originalBtnHtml = healthUpdateSubmitBtn ? healthUpdateSubmitBtn.innerHTML : '';
        if (healthUpdateSubmitBtn) {
            healthUpdateSubmitBtn.disabled = true;
            healthUpdateSubmitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
        }
        clearHealthNotice();

        try {
            const headers = await seniorAuthHeaders();
            const body = { illness: illness, description: details };
            if (needsCert && healthCertFile) {
                const payload = await readHealthCertFile(healthCertFile);
                body.fileName = payload.name;
                body.mimeType = payload.mimeType;
                body.fileBase64 = payload.base64;
                healthUpdateSubmitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading certification...';
            }
            const res = await fetch('/api/health-report/submit', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error((data && data.message) || 'The health update could not be submitted.');

            resetHealthIllnessForm();
            resetHealthCertFile();
            if (choice === 'no') {
                setHealthNotice('success', data.message || 'Health update submitted. OSCA staff will record that you are healthy.');
                showToast('Health update submitted. An OSCA employee will review it.');
            } else {
                setHealthNotice('success', data.message || 'Health update submitted. OSCA staff will review your medical certification.');
                showToast('Health update submitted. An OSCA employee will review your medical certification.');
            }
        } catch (err) {
            console.error('Health update submit error:', err);
            setHealthNotice('error', err.message || 'The health update could not be submitted. Please try again.');
            showToast('Failed to submit your health update. Please try again.');
        } finally {
            if (healthUpdateSubmitBtn) {
                healthUpdateSubmitBtn.disabled = false;
                healthUpdateSubmitBtn.innerHTML = originalBtnHtml || '<i class="fas fa-paper-plane"></i> Submit Health Update';
            }
        }
    }

    if (healthUpdateSubmitBtn) {
        healthUpdateSubmitBtn.addEventListener('click', submitHealthUpdate);
    }

    // ── View an uploaded medical certification through a short-lived signed URL ─
    // Delegated so the history list can re-render without re-binding.
    if (healthCertDrop) {
        healthCertDrop.setAttribute('data-health-bound', '1');
    }
    const healthHistoryWrap = document.getElementById('healthUpdateHistory');
    if (healthHistoryWrap) {
        healthHistoryWrap.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-report-view]');
            if (!btn) return;
            const reportId = btn.getAttribute('data-report-view');
            if (reportId) viewMyHealthCertification(reportId);
        });
    }

    async function viewMyHealthCertification(reportId) {
        if (!currentUserData || !currentUserData.uid) return;
        try {
            const headers = await seniorAuthHeaders();
            const res = await fetch(`/api/health-report/view/${encodeURIComponent(currentUserData.uid)}/${encodeURIComponent(reportId)}`, { headers });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error((data && data.message) || 'The medical certification could not be opened.');
            window.open(data.signedUrl, '_blank', 'noopener');
            if (data.expiresIn) scNotify('info', `Secure link opened — it expires in ${Math.round(data.expiresIn / 60)} minutes.`);
        } catch (err) {
            console.error('View medical certification error:', err);
            scNotify('error', err.message || 'The medical certification could not be opened.');
        }
    }
    // Exposed for the employee portal / manual links if needed.
    window.scViewHealthCertification = viewMyHealthCertification;
});
