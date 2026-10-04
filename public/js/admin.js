import { auth, db } from './firebase-init.js';
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signOut, updatePassword, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-auth.js";
import { ref, onValue, update, set, remove } from "https://www.gstatic.com/firebasejs/10.11.1/firebase-database.js";

// Archive Function: statuses that move a senior record out of the
// active roster (hidden from main dashboards & processing lists).
const ARCHIVED_STATUSES = ['Inactive', 'Deceased', 'Transferred', 'Archived'];

document.addEventListener('DOMContentLoaded', () => {
    // Check if on Admin page
    if (window.location.pathname !== '/admin') return;



    // --- Auth State Observer (with 2FA gate) ---
    auth.onAuthStateChanged(async (user) => {
        if (!user) {
            window.location.replace('/');
            return;
        }
        // Two-Factor Authentication gate: without a verified OTP in this
        // tab, the dashboard is locked and the session is terminated.
        // Exception: the default/Master Admin account (admin@silvercare.com).
        if (String(user.email || '').toLowerCase() !== 'admin@silvercare.com' &&
            sessionStorage.getItem('sc_2fa_verified') !== user.uid) {
            sessionStorage.removeItem('sc_2fa_pending');
            try { await auth.signOut(); } catch (err) { console.error(err); }
            window.location.replace('/');
        }
    });

    // Logout handler
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try {
                sessionStorage.removeItem('sc_2fa_verified');
                sessionStorage.removeItem('sc_2fa_pending');
                await auth.signOut();
                localStorage.removeItem('userRole');
                window.location.replace('/');
            } catch (err) {
                console.error('Logout error:', err);
            }
        });
    }

    const pendingTable = document.getElementById('pendingUsersTable');
    const adminTable = document.getElementById('adminUsersTable');
    const employeeTable = document.getElementById('employeeUsersTable');
    const seniorTable = document.getElementById('seniorUsersTable');

    if (!pendingTable || !adminTable || !employeeTable || !seniorTable) return;

    const usersRef = ref(db, 'users');
    let allUsersData = {};
    
    function buildStatusBadge(status, role, user) {
        let statusColor = '#94a3b8';
        let statusBg = '#f1f5f9';
        if (status === 'Active') { statusColor = '#166534'; statusBg = '#dcfce7'; }
        else if (status === 'Inactive') { statusColor = '#991b1b'; statusBg = '#fef2f2'; }
        else if (status === 'Deceased') { statusColor = '#1e293b'; statusBg = '#e2e8f0'; }
        const display = (role === 'senior' && user.lifeStatus) ? user.lifeStatus : status;
        return `<span class="status-badge" style="background: ${statusBg}; color: ${statusColor};">${display}</span>`;
    }

    function buildManageBtn(uid) {
        return `<button class="btn manage-btn" data-uid="${uid}" style="background: transparent; color: #3b82f6; border: none; cursor: pointer; font-size: 0.9rem; font-weight: 500;">Manage</button>`;
    }

    // ── Manage Users: Employees vs Seniors (verified/unverified/inactive) ──
    // Verified = KYC-verified. Unverified = active account, not KYC-verified.
    // Inactive = archived lifeStatus (Inactive/Deceased/Transferred/Archived),
    // kept visible here so admin can review / restore via Manage.
    window.currentAdminUsersView = window.currentAdminUsersView || 'employees';
    window.currentAdminSeniorFilter = window.currentAdminSeniorFilter || 'verified';
    window.currentAdminSeniorSearch = window.currentAdminSeniorSearch || '';

    function adminSeniorBuckets(usersData) {
        const buckets = { verified: [], unverified: [], inactive: [] };
        for (const [uid, user] of Object.entries(usersData || {})) {
            if (!user || user.role !== 'senior') continue;
            if (String(user.status || '') === 'Pending') continue;
            const entry = { uid, ...user };
            if (ARCHIVED_STATUSES.includes(String(user.lifeStatus || user.status || 'Active'))) {
                buckets.inactive.push(entry);
            } else if (String(user.kycStatus || '') === 'Verified' || !!user.kycVerifiedAt) {
                buckets.verified.push(entry);
            } else {
                buckets.unverified.push(entry);
            }
        }
        return buckets;
    }

    function paintAdminUsersSubTabs() {
        const empBtn = document.getElementById('adminUsersTabEmployees');
        const senBtn = document.getElementById('adminUsersTabSeniors');
        const onEmp = window.currentAdminUsersView !== 'seniors';
        const onStyle = 'padding:9px 20px;border-radius:20px;font-weight:700;font-size:0.85rem;cursor:pointer;border:1px solid #0ea5e9;background:#0ea5e9;color:#fff;';
        const offStyle = 'padding:9px 20px;border-radius:20px;font-weight:700;font-size:0.85rem;cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#475569;';
        if (empBtn) empBtn.style.cssText = onEmp ? onStyle : offStyle;
        if (senBtn) senBtn.style.cssText = onEmp ? offStyle : onStyle;
        const empView = document.getElementById('adminUsersViewEmployees');
        const senView = document.getElementById('adminUsersViewSeniors');
        if (empView) empView.style.display = onEmp ? '' : 'none';
        if (senView) senView.style.display = onEmp ? 'none' : '';
    }

    function paintAdminSeniorFilters() {
        const title = document.getElementById('adminSeniorTableTitle');
        if (title) {
            title.textContent = window.currentAdminSeniorFilter === 'inactive' ? '— Inactive'
                : window.currentAdminSeniorFilter === 'unverified' ? '— Unverified' : '— Verified';
        }
        document.querySelectorAll('.admin-senior-filter').forEach(btn => {
            const active = btn.dataset.seniorFilter === window.currentAdminSeniorFilter;
            btn.style.cssText = active
                ? 'padding:8px 18px;border-radius:20px;font-weight:700;font-size:0.82rem;cursor:pointer;border:1px solid #16a34a;background:#16a34a;color:#fff;'
                : 'padding:8px 18px;border-radius:20px;font-weight:700;font-size:0.82rem;cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#475569;';
        });
        const counts = document.getElementById('adminSeniorSubCounts');
        if (counts) {
            const b = adminSeniorBuckets(window.allUsersData || {});
            counts.textContent = 'Verified ' + b.verified.length + ' · Unverified ' + b.unverified.length + ' · Inactive ' + b.inactive.length;
        }
    }

    function applyAdminSeniorView() {
        paintAdminUsersSubTabs();
        paintAdminSeniorFilters();
        const tbl = document.getElementById('seniorUsersTable');
        if (!tbl) return;
        const buckets = adminSeniorBuckets(window.allUsersData || {});
        const q = String(window.currentAdminSeniorSearch || '').toLowerCase().trim();
        let list = buckets[window.currentAdminSeniorFilter] || buckets.verified;
        if (q) {
            list = list.filter(u => String(u.name || '').toLowerCase().includes(q)
                || String(u.email || '').toLowerCase().includes(q)
                || String(u.seniorId || '').toLowerCase().includes(q));
        }
        tbl.innerHTML = '';
        if (list.length === 0) {
            const label = window.currentAdminSeniorFilter === 'inactive' ? 'inactive senior accounts'
                : window.currentAdminSeniorFilter === 'unverified' ? 'unverified seniors' : 'verified seniors';
            tbl.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No ' + (q ? 'matching ' : '') + label + '.</td></tr>';
            return;
        }
        list.forEach(user => {
            const tr = document.createElement('tr');
            const badge = buildStatusBadge(user.status, user.role, user);
            const emailOrId = user.seniorId
                ? (user.email || '') + '<br><span style="font-size:0.8rem; color:#64748b;">ID: ' + user.seniorId + '</span>'
                : (user.email || 'N/A');
            tr.innerHTML = '<td style="font-weight: 500;">' + (user.name || 'N/A') + '</td>'
                + '<td>' + emailOrId + '</td><td>' + badge + '</td>'
                + '<td>' + buildManageBtn(user.uid) + '</td>';
            tbl.appendChild(tr);
        });
        tbl.querySelectorAll('.manage-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const uid = e.target.getAttribute('data-uid');
                if (window.allUsersData && window.allUsersData[uid]) openManageModal(uid, window.allUsersData[uid]);
            });
        });
    }

    window.switchAdminUsersSubTab = function (view) {
        window.currentAdminUsersView = view === 'seniors' ? 'seniors' : 'employees';
        applyAdminSeniorView();
    };

    window.switchAdminSeniorFilter = function (filter) {
        window.currentAdminSeniorFilter = ['verified', 'unverified', 'inactive'].includes(filter) ? filter : 'verified';
        applyAdminSeniorView();
    };

    window.filterAdminSeniors = function (query) {
        window.currentAdminSeniorSearch = query || '';
        applyAdminSeniorView();
    };

    onValue(usersRef, (snapshot) => {
        pendingTable.innerHTML = '';
        adminTable.innerHTML = '';
        employeeTable.innerHTML = '';

        if (!snapshot.exists()) {
            pendingTable.innerHTML = '<tr><td colspan="4" style="text-align:center;">No pending requests.</td></tr>';
            adminTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No users found.</td></tr>';
            employeeTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No users found.</td></tr>';
            seniorTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No users found.</td></tr>';
            return;
        }

        allUsersData = snapshot.val();
        window.allUsersData = allUsersData;
        // Refresh the Seniors view (verified/unverified/inactive) so its table,
        // filter pills and counts stay live with the latest user data.
        applyAdminSeniorView();
        let pendingCount = 0;
        let adminCount = 0;
        let employeeCount = 0;

        for (const [uid, user] of Object.entries(allUsersData)) {
            const roleBadgeClass = user.role === 'admin' ? 'blue' : (user.role === 'senior' ? 'purple' : 'staff');
            const roleDisplay = user.role.charAt(0).toUpperCase() + user.role.slice(1);

            if (user.status === 'Pending') {
                pendingCount++;
                let details = user.email;
                if (user.role === 'senior') {
                    details += `<br><span style="font-size:0.8rem; color:#64748b;">ID: ${user.seniorId || 'N/A'}</span>`;
                }

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="font-weight: 500;">${user.name || 'N/A'}</td>
                    <td><span class="role-badge ${roleBadgeClass}">${roleDisplay}</span></td>
                    <td>${details}</td>
                    <td>
                        <button class="btn approve-btn" data-uid="${uid}" style="background: #22c55e; color: white; padding: 5px 10px; border: none; border-radius: 5px; cursor: pointer; font-size: 0.85rem;"><i class="fas fa-check"></i> Approve</button>
                        <button class="btn reject-btn" data-uid="${uid}" style="background: #ef4444; color: white; padding: 5px 10px; border: none; border-radius: 5px; cursor: pointer; font-size: 0.85rem; margin-left: 5px;"><i class="fas fa-times"></i> Reject</button>
                    </td>
                `;
                pendingTable.appendChild(tr);
                continue;
            }

            const tr = document.createElement('tr');
            const manageBtn = buildManageBtn(uid);
            const statusBadge = buildStatusBadge(user.status, user.role, user);

            if (user.role === 'admin') {
                adminCount++;
                tr.innerHTML = `
                    <td style="font-weight: 500;">${user.name || 'N/A'}</td>
                    <td>${user.email || 'N/A'}</td>
                    <td>${statusBadge}</td>
                    <td>${manageBtn}</td>
                `;
                adminTable.appendChild(tr);
            } else if (user.role === 'employee') {
                employeeCount++;
                tr.innerHTML = `
                    <td style="font-weight: 500;">${user.name || 'N/A'}</td>
                    <td>${user.email || 'N/A'}</td>
                    <td>${statusBadge}</td>
                    <td>${manageBtn}</td>
                `;
                employeeTable.appendChild(tr);
            } else if (user.role === 'senior') {
                continue;
            }
        }

        if (pendingCount === 0) {
            pendingTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No pending requests.</td></tr>';
        }
        if (adminCount === 0) {
            adminTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No admin accounts.</td></tr>';
        }
        if (employeeCount === 0) {
            employeeTable.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#64748b;">No employee accounts.</td></tr>';
        }
        // Seniors are rendered by the dedicated Seniors view (verified/unverified/inactive).

        const adminUsersBadge = document.getElementById('adminUsersBadge');
        if (adminUsersBadge) {
            adminUsersBadge.style.display = pendingCount > 0 ? 'block' : 'none';
        }

        // Render Senior Priority & Pill Request Monitor for Admin
        renderAdminPriorityMonitor(allUsersData, window.currentAdminPriorityFilter || 'all');

        // Attach event listeners for Approve/Reject
        document.querySelectorAll('.approve-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const uid = e.target.closest('.approve-btn').getAttribute('data-uid');
                scConfirm('Are you sure you want to approve this user?', async () => {
                    await update(ref(db, 'users/' + uid), { status: 'Active' });
                    scNotify('success', 'User approved successfully.');
                });
            });
        });

        document.querySelectorAll('.reject-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const uid = e.target.closest('.reject-btn').getAttribute('data-uid');
                scConfirm('Are you sure you want to reject this user request?', async () => {
                    await update(ref(db, 'users/' + uid), { status: 'Rejected' });
                    scNotify('info', 'User request rejected.');
                });
            });
        });

        // Attach event listeners for Manage
        document.querySelectorAll('.manage-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const uid = e.target.getAttribute('data-uid');
                openManageModal(uid, allUsersData[uid]);
            });
        });
    }, (error) => {
        console.error("Firebase database error (usersRef):", error);
        if (pendingTable) pendingTable.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#ef4444;">Error loading requests: ${error.message}</td></tr>`;
        if (adminTable) adminTable.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#ef4444;">Error loading admins: ${error.message}</td></tr>`;
        if (employeeTable) employeeTable.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#ef4444;">Error loading staff: ${error.message}</td></tr>`;
        if (seniorTable) seniorTable.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#ef4444;">Error loading seniors: ${error.message}</td></tr>`;
    });

    // --- Manage User Modal Logic ---
    const manageUserModal = document.getElementById('manageUserModal');
    const closeManageUserModal = document.getElementById('closeManageUserModal');
    const saveManageUserBtn = document.getElementById('saveManageUserBtn');
    const deleteManageUserBtn = document.getElementById('deleteManageUserBtn');
    let currentManageUid = null;

    function openManageModal(uid, userData) {
        currentManageUid = uid;
        const detailsDiv = document.getElementById('manageUserDetails');
        const lifeStatusSelect = document.getElementById('manageLifeStatus');
        const passwordSection = document.getElementById('managePasswordSection');

        // Clear password fields
        document.getElementById('manageNewPassword').value = '';
        document.getElementById('manageConfirmPassword').value = '';

        if (passwordSection) {
            passwordSection.style.display = userData.role === 'admin' ? 'none' : 'block';
        }

        let detailsHTML = `<strong>Name:</strong> ${userData.name}<br>
                           <strong>Email:</strong> ${userData.email}<br>
                           <strong>Role:</strong> ${userData.role}`;
        if (userData.role === 'senior') {
            detailsHTML += `<br><strong>Senior ID:</strong> ${userData.seniorId || 'N/A'}`;
            lifeStatusSelect.parentElement.style.display = 'block';
            lifeStatusSelect.value = userData.lifeStatus || 'Active';
        } else {
            lifeStatusSelect.parentElement.style.display = 'none';
        }

        detailsDiv.innerHTML = detailsHTML;

        manageUserModal.style.display = 'flex';
    }

    if (closeManageUserModal) {
        closeManageUserModal.addEventListener('click', () => {
            manageUserModal.style.display = 'none';
        });
    }

    if (saveManageUserBtn) {
        saveManageUserBtn.addEventListener('click', async () => {
            if (!currentManageUid) return;
            
            const lifeStatus = document.getElementById('manageLifeStatus').value;
            const newPassword = document.getElementById('manageNewPassword').value;
            const confirmPassword = document.getElementById('manageConfirmPassword').value;
            const userData = allUsersData[currentManageUid];
            
            if (newPassword || confirmPassword) {
                if (newPassword !== confirmPassword) {
                    scNotify('error', 'Passwords do not match.');
                    return;
                }
                if (newPassword.length < 6) {
                    scNotify('warning', 'Password must be at least 6 characters long.');
                    return;
                }
                
                try {
                    const token = await auth.currentUser.getIdToken();
                    const response = await fetch('/api/change-user-password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify({ uid: currentManageUid, newPassword })
                    });
                    const data = await response.json();
                    if (data.success) {
                        scNotify('success', 'User password successfully updated.');
                    } else {
                        throw new Error(data.message || 'Unknown error occurred.');
                    }
                } catch (err) {
                    scNotify('error', 'Failed to update user password: ' + err.message);
                    return;
                }
            }

            const updates = {};
            if (userData.role === 'senior') {
                // Life Status is now the single source of truth: keep the legacy
                // account `status` field in sync so login gating still works
                updates.status = lifeStatus;
                updates.lifeStatus = lifeStatus;
                // Archive Function: stamp archive metadata the moment a record
                // is moved out of the active roster (Inactive/Deceased/Transferred/Archived)
                const previousStatus = String(userData.lifeStatus || userData.status || 'Active');
                if (ARCHIVED_STATUSES.includes(lifeStatus) && !ARCHIVED_STATUSES.includes(previousStatus)) {
                    updates.archivedAt = Date.now();
                    updates.archivedBy = 'Administrator';
                    updates.archivedReason = `Marked ${lifeStatus} via Admin panel`;
                } else if (!ARCHIVED_STATUSES.includes(lifeStatus) && ARCHIVED_STATUSES.includes(previousStatus)) {
                    updates.restoredAt = Date.now();
                    updates.restoredBy = 'Administrator';
                }
            }

            if (Object.keys(updates).length > 0) {
                try {
                    await update(ref(db, 'users/' + currentManageUid), updates);
                    if (!newPassword) {
                        scNotify('success', 'User updated successfully.');
                    }
                } catch (err) {
                    scNotify('error', 'Failed to update user: ' + err.message);
                    return;
                }
            }
            manageUserModal.style.display = 'none';
        });
    }

    if (deleteManageUserBtn) {
        deleteManageUserBtn.addEventListener('click', () => {
            if (!currentManageUid) return;
            const userData = allUsersData[currentManageUid];
            
            // Prevent deleting the Master Admin or yourself if needed (basic protection)
            if (userData.email === 'admin@silvercare.com') {
                scNotify('error', 'The Master Admin account cannot be deleted.');
                return;
            }

            scConfirm(`Are you sure you want to permanently delete the account for ${userData.name}? This action cannot be undone.`, async () => {
                try {
                    await remove(ref(db, 'users/' + currentManageUid));
                    manageUserModal.style.display = 'none';
                    scNotify('success', 'User account has been permanently deleted.');
                } catch (err) {
                    scNotify('error', 'Failed to delete user: ' + err.message);
                }
            });
        });
    }

    // --- Change Password Button (validates match, then calls API) ---
    const changeUserPasswordBtn = document.getElementById('changeUserPasswordBtn');
    if (changeUserPasswordBtn) {
        changeUserPasswordBtn.addEventListener('click', async () => {
            if (!currentManageUid) return;

            const newPassword = document.getElementById('manageNewPassword').value;
            const confirmPassword = document.getElementById('manageConfirmPassword').value;

            if (newPassword !== confirmPassword) {
                scNotify('error', 'Passwords do not match.');
                return;
            }
            if (!newPassword || newPassword.length < 6) {
                scNotify('warning', 'Password must be at least 6 characters long.');
                return;
            }

            const originalText = changeUserPasswordBtn.innerHTML;
            changeUserPasswordBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';
            changeUserPasswordBtn.disabled = true;

            try {
                const token = await auth.currentUser.getIdToken();
                const response = await fetch('/api/change-user-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ uid: currentManageUid, newPassword })
                });
                const data = await response.json();
                if (data.success) {
                    scNotify('success', 'User password successfully updated.');
                    document.getElementById('manageNewPassword').value = '';
                    document.getElementById('manageConfirmPassword').value = '';
                } else {
                    throw new Error(data.message || 'Unknown error occurred.');
                }
            } catch (err) {
                scNotify('error', 'Failed to update user password: ' + err.message);
            } finally {
                changeUserPasswordBtn.innerHTML = originalText;
                changeUserPasswordBtn.disabled = false;
            }
        });
    }

    // --- Admin Face Capture Logic ---
    const adminStartCameraBtn = document.getElementById('adminStartCameraBtn');
    const adminCaptureBtn = document.getElementById('adminCaptureBtn');
    const adminRetakeBtn = document.getElementById('adminRetakeBtn');
    const adminWebcam = document.getElementById('adminWebcam');
    const adminCanvas = document.getElementById('adminCanvas');
    const adminPhotoPreview = document.getElementById('adminPhotoPreview');
    const adminRegisterFaceBtn = document.getElementById('adminRegisterFaceBtn');
    
    let adminStream = null;
    let adminCapturedBase64 = null;

    if (adminStartCameraBtn) {
        adminStartCameraBtn.addEventListener('click', async () => {
            try {
                adminStream = await navigator.mediaDevices.getUserMedia({ video: true });
                adminWebcam.srcObject = adminStream;
                adminWebcam.style.display = 'block';
                adminStartCameraBtn.style.display = 'none';
                adminCaptureBtn.style.display = 'inline-block';
                adminPhotoPreview.style.display = 'none';
            } catch (err) {
                scNotify('error', 'Camera access denied or unavailable.', 'Camera Error');
            }
        });
    }

    if (adminCaptureBtn) {
        adminCaptureBtn.addEventListener('click', () => {
            adminCanvas.width = adminWebcam.videoWidth;
            adminCanvas.height = adminWebcam.videoHeight;
            const context = adminCanvas.getContext('2d');
            context.drawImage(adminWebcam, 0, 0, adminCanvas.width, adminCanvas.height);
            
            adminCapturedBase64 = adminCanvas.toDataURL('image/png');
            adminPhotoPreview.src = adminCapturedBase64;
            
            adminWebcam.style.display = 'none';
            adminCaptureBtn.style.display = 'none';
            adminPhotoPreview.style.display = 'block';
            adminRetakeBtn.style.display = 'inline-block';
            
            if (adminStream) {
                adminStream.getTracks().forEach(track => track.stop());
            }
        });
    }

    if (adminRetakeBtn) {
        adminRetakeBtn.addEventListener('click', () => {
            adminRetakeBtn.style.display = 'none';
            adminCapturedBase64 = null;
            adminStartCameraBtn.click();
        });
    }

    if (adminRegisterFaceBtn) {
        adminRegisterFaceBtn.addEventListener('click', async () => {
            const seniorId = document.getElementById('adminSeniorId').value;
            const seniorName = document.getElementById('adminSeniorName').value;
            const seniorEmail = document.getElementById('adminSeniorEmail').value;

            if (!seniorId || !seniorName) {
                scNotify('warning', 'Please fill in the Senior ID and Full Name.');
                return;
            }

            if (!adminCapturedBase64) {
                scNotify('warning', 'Please capture the senior\'s face first.');
                return;
            }

            const originalText = adminRegisterFaceBtn.innerHTML;
            adminRegisterFaceBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
            adminRegisterFaceBtn.disabled = true;

            try {
                const newRecordId = 'SENIOR_' + Date.now();
                
                await update(ref(db, 'users/' + newRecordId), {
                    seniorId: seniorId,
                    name: seniorName,
                    email: seniorEmail || 'N/A',
                    role: 'senior',
                    status: 'Active',
                    lifeStatus: 'Active',
                    faceImage: adminCapturedBase64,
                    createdAt: Date.now()
                });

                scNotify('success', 'Senior successfully registered with Face Capture!');

                // Mirror the new senior to the Supabase data store
                // (username, senior ID, face, ID number) — best-effort.
                if (auth.currentUser) {
                    const faceForMirror = adminCapturedBase64;
                    auth.currentUser.getIdToken().then(token => fetch('/api/supabase/sync-senior', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify({ uid: newRecordId, faceImage: faceForMirror })
                    })).catch(err => console.warn('Supabase mirror skipped:', err.message));
                }

                document.getElementById('adminSeniorId').value = '';
                document.getElementById('adminSeniorName').value = '';
                document.getElementById('adminSeniorEmail').value = '';
                adminCapturedBase64 = null;
                adminPhotoPreview.style.display = 'none';
                adminStartCameraBtn.style.display = 'inline-block';
                adminRetakeBtn.style.display = 'none';
                
            } catch (error) {
                scNotify('error', 'Failed to register senior: ' + error.message);
            } finally {
                adminRegisterFaceBtn.innerHTML = originalText;
                adminRegisterFaceBtn.disabled = false;
            }
        });
    }

    // --- Add User Modal Logic ---
    const btnAddUser = document.getElementById('btnAddUser');
    const addUserModal = document.getElementById('addUserModal');
    const closeAddUserModal = document.getElementById('closeAddUserModal');
    const addUserForm = document.getElementById('addUserForm');

    if (btnAddUser && addUserModal) {
        btnAddUser.addEventListener('click', () => {
            addUserModal.style.display = 'flex';
        });

        closeAddUserModal.addEventListener('click', () => {
            addUserModal.style.display = 'none';
        });

        addUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const name = document.getElementById('addUserName').value;
            const email = document.getElementById('addUserEmail').value;
            const password = document.getElementById('addUserPassword').value;
            const role = document.querySelector('input[name="addUserRole"]:checked').value;
            const submitBtn = addUserForm.querySelector('button');

            const originalText = submitBtn.innerHTML;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
            submitBtn.disabled = true;

            try {
                const secondaryApp = initializeApp(firebaseConfig, "Secondary" + Date.now());
                const secondaryAuth = getAuth(secondaryApp);

                const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
                const newUser = userCredential.user;

                await set(ref(db, 'users/' + newUser.uid), {
                    email: email,
                    name: name,
                    role: role,
                    status: 'Active',
                    createdAt: Date.now()
                });

                await signOut(secondaryAuth);
                
                scNotify('success', `User ${name} successfully created as ${role}!`);
                
                addUserForm.reset();
                addUserModal.style.display = 'none';

            } catch (error) {
                scNotify('error', 'Failed to create user: ' + error.message);
            } finally {
                submitBtn.innerHTML = originalText;
                submitBtn.disabled = false;
            }
        });
    }

    // --- Settings Tab Logic ---
    const requestOtpBtn = document.getElementById('requestOtpBtn');
    const otpInputGroup = document.getElementById('otpInputGroup');
    const updatePasswordBtn = document.getElementById('updatePasswordBtn');

    if (requestOtpBtn) {
        requestOtpBtn.addEventListener('click', async () => {
            const newPassword = document.getElementById('newAdminPassword').value;
            const confirmPassword = document.getElementById('confirmAdminPassword').value;

            if (!newPassword || newPassword.length < 6) {
                scNotify('warning', 'Password must be at least 6 characters long.');
                return;
            }
            if (newPassword !== confirmPassword) {
                scNotify('error', 'Passwords do not match.');
                return;
            }

            const user = auth.currentUser;
            if (!user) {
                scNotify('error', 'No active user session found.');
                return;
            }

            const originalText = requestOtpBtn.innerHTML;
            requestOtpBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
            requestOtpBtn.disabled = true;

            try {
                const response = await fetch('/api/send-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: user.email })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    scNotify('success', `Verification OTP sent to ${user.email}`);
                    otpInputGroup.style.display = 'flex';
                    updatePasswordBtn.style.opacity = '1';
                    updatePasswordBtn.style.pointerEvents = 'auto';
                    requestOtpBtn.innerHTML = 'Resend OTP';
                } else {
                    scNotify('error', data.message || 'Failed to send OTP.');
                    requestOtpBtn.innerHTML = originalText;
                }
            } catch (err) {
                scNotify('error', 'Network error. Could not request OTP.');
                requestOtpBtn.innerHTML = originalText;
            } finally {
                requestOtpBtn.disabled = false;
            }
        });
    }

    if (updatePasswordBtn) {
        updatePasswordBtn.addEventListener('click', async () => {
            const newPassword = document.getElementById('newAdminPassword').value;
            const confirmPassword = document.getElementById('confirmAdminPassword').value;
            const otp = document.getElementById('adminOtp').value;

            if (newPassword !== confirmPassword) {
                scNotify('error', 'Passwords do not match.');
                return;
            }
            if (!otp || otp.length !== 6) {
                scNotify('warning', 'Please enter the 6-digit OTP sent to your email.');
                return;
            }

            const user = auth.currentUser;
            if (!user) return;

            const originalText = updatePasswordBtn.innerHTML;
            updatePasswordBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';
            updatePasswordBtn.disabled = true;

            try {
                // 1. Verify OTP
                const response = await fetch('/api/verify-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: user.email, pin: otp })
                });
                const data = await response.json();

                if (!data.success) {
                    scNotify('error', data.message);
                    return;
                }

                // 2. Update Password via Firebase Auth
                await updatePassword(user, newPassword);
                scNotify('success', 'Master Admin password successfully and securely updated!');
                
                // Reset form
                document.getElementById('newAdminPassword').value = '';
                document.getElementById('confirmAdminPassword').value = '';
                document.getElementById('adminOtp').value = '';
                otpInputGroup.style.display = 'none';
                updatePasswordBtn.style.opacity = '0.5';
                updatePasswordBtn.style.pointerEvents = 'none';
                if(requestOtpBtn) requestOtpBtn.innerHTML = 'Request OTP to Email';

            } catch (error) {
                console.error(error);
                if (error.code === 'auth/requires-recent-login') {
                    scNotify('error', 'Security requirement: Please logout and login again before updating your password.');
                } else {
                    scNotify('error', 'Failed to update password: ' + error.message);
                }
            } finally {
                updatePasswordBtn.innerHTML = originalText;
                updatePasswordBtn.disabled = false;
            }
        });
    }

    const backupDataBtn = document.getElementById('backupDataBtn');
    if (backupDataBtn) {
        backupDataBtn.addEventListener('click', async () => {
            const now = new Date();
            const stampStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const originalText = backupDataBtn.innerHTML;

            backupDataBtn.innerHTML = '<span><i class="fas fa-spinner fa-spin" style="margin-right: 10px;"></i> Preparing Backup...</span>';
            backupDataBtn.disabled = true;

            try {
                let dataset = null;
                let supabaseDump = null;
                let source = 'cached-users';

                // Preferred: server-side full export. The Admin SDK on the
                // server bypasses DB security rules (the browser cannot read
                // the root node) and also includes the Supabase mirror.
                try {
                    const currentUser = auth.currentUser;
                    if (currentUser) {
                        const token = await currentUser.getIdToken();
                        const res = await fetch('/api/admin/backup/full-export', {
                            headers: { 'Authorization': 'Bearer ' + token }
                        });
                        if (res.ok) {
                            const json = await res.json();
                            if (json && json.success && json.firebase && typeof json.firebase === 'object') {
                                dataset = json.firebase;
                                supabaseDump = json.supabase || null;
                                source = 'server-full-export (firebase + supabase)';
                            }
                        } else {
                            console.warn('[Backup] Server full export returned HTTP ' + res.status);
                        }
                    }
                } catch (err) {
                    console.warn('[Backup] Server full export failed, trying direct REST export.', err);
                }

                // Fallback 1: direct database export via REST using the admin's
                // auth token (subject to DB security rules).
                if (!dataset) {
                    try {
                        const currentUser = auth.currentUser;
                        if (currentUser) {
                            const token = await currentUser.getIdToken();
                            const res = await fetch(firebaseConfig.databaseURL + '/.json?auth=' + token);
                            if (res.ok) {
                                const json = await res.json();
                                if (json && typeof json === 'object') {
                                    dataset = json;
                                    source = 'rest-database-export';
                                }
                            }
                        }
                    } catch (err) {
                        console.warn('[Backup] REST database export failed, falling back to cached users data.', err);
                    }
                }

                // Fallback: use the users data already cached by the dashboard.
                if (!dataset) {
                    if (!window.allUsersData) {
                        scNotify('error', 'No data available to backup.');
                        return;
                    }
                    dataset = { users: window.allUsersData };
                }

                if (typeof JSZip === 'undefined') {
                    scNotify('error', 'Backup library failed to load. Please refresh the page and try again.');
                    return;
                }

                const zip = new JSZip();
                const root = zip.folder('SilverCare_Backup_' + stampStr);

                // Known top-level nodes mapped to organized folders.
                // Anything NOT listed here still lands in database/ (nothing is skipped).
                const NODE_CATEGORIES = {
                    'transactions': 'transactions',      // benefit transactions / disbursement logs
                    'claims': 'claims',                  // claim history records
                    'queue': 'appointments',             // appointment queue / scheduling data
                    'checkups': 'medical-records',       // senior checkup history
                    'doctors': 'directory',              // doctors directory
                    'healthCenters': 'directory',        // health centers directory
                    'auditLogs': 'logs',                 // system activity / audit trail
                    'system': 'system'                   // system settings and internal state
                };

                const categorized = {}; // folder -> [file names] (for the manifest)

                const writeNode = (folder, key, value) => {
                    const safeName = String(key).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
                    root.folder(folder).file(safeName, JSON.stringify(value, null, 2));
                    if (!categorized[folder]) categorized[folder] = [];
                    categorized[folder].push(safeName);
                };

                // 1) Users: full copy + split by role for quick review.
                const users = (dataset.users && typeof dataset.users === 'object') ? dataset.users : {};
                const roleCounts = {};
                const usersFolder = root.folder('users');
                usersFolder.file('users.json', JSON.stringify(users, null, 2));
                ['admin', 'staff', 'senior'].forEach((role) => {
                    const bucket = {};
                    for (const [uid, user] of Object.entries(users)) {
                        if (user && String(user.role || '').toLowerCase() === role) bucket[uid] = user;
                    }
                    roleCounts[role] = Object.keys(bucket).length;
                    usersFolder.file(role + 's.json', JSON.stringify(bucket, null, 2));
                });
                categorized['users'] = ['users.json', 'admins.json', 'staffs.json', 'seniors.json'];

                // 2) Every other top-level node, grouped into its category folder.
                Object.keys(dataset).sort().forEach((key) => {
                    const value = dataset[key];
                    if (value === null || value === undefined) return;
                    if (key === 'users') return; // already handled above
                    writeNode(NODE_CATEGORIES[key] || 'database', key, value);
                });

                // 3) Supabase mirror — table rows + storage file inventory.
                if (supabaseDump) {
                    const sbFolder = root.folder('supabase');
                    const sbFiles = ['export.json'];
                    sbFolder.file('export.json', JSON.stringify(supabaseDump, null, 2));
                    if (Array.isArray(supabaseDump.seniors)) {
                        sbFolder.file('seniors.json', JSON.stringify(supabaseDump.seniors, null, 2));
                        sbFiles.push('seniors.json');
                    }
                    categorized['supabase'] = sbFiles;
                }

                // 4) Manifest describing the archive contents.
                root.file('manifest.json', JSON.stringify({
                    system: 'SilverCare',
                    generatedAt: now.toISOString(),
                    source: source,
                    topLevelNodes: Object.keys(dataset).sort(),
                    userCounts: roleCounts,
                    folders: categorized,
                    folderGuide: {
                        'users/': 'User accounts — full list (users.json) plus split by role (admins/staffs/seniors)',
                        'transactions/': 'Benefit transactions and disbursement logs',
                        'claims/': 'Claim history records',
                        'appointments/': 'Appointment queue and scheduling history',
                        'medical-records/': 'Senior checkup records',
                        'directory/': 'Doctors and health centers',
                        'logs/': 'Audit logs — system activity trail',
                        'system/': 'System settings and internal state',
                        'supabase/': 'Supabase mirror — seniors table rows (seniors.json) + storage file inventory (export.json)',
                        'database/': 'Catch-all for any other database nodes'
                    }
                }, null, 2));

                const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
                const url = URL.createObjectURL(blob);
                const downloadAnchorNode = document.createElement('a');
                downloadAnchorNode.setAttribute('href', url);
                downloadAnchorNode.setAttribute('download', 'SilverCare_Backup_' + stampStr + '.zip');
                document.body.appendChild(downloadAnchorNode); // required for firefox
                downloadAnchorNode.click();
                downloadAnchorNode.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);

                const fileCount = Object.keys(dataset).length + (supabaseDump && supabaseDump.enabled ? 1 : 0);
                scNotify('success', 'Backup ZIP downloaded successfully (' + fileCount + ' data files' + (supabaseDump && supabaseDump.enabled ? ', Supabase included' : '') + ').');
            } catch (error) {
                console.error(error);
                scNotify('error', 'Failed to generate backup: ' + error.message);
            } finally {
                backupDataBtn.innerHTML = originalText;
                backupDataBtn.disabled = false;
            }
        });
    }

    const emailNotifToggle = document.getElementById('emailNotifToggle');
    if (emailNotifToggle) {
        onValue(ref(db, 'system/settings/emailNotifications'), (snapshot) => {
            if(snapshot.exists()) emailNotifToggle.checked = snapshot.val();
        });
        emailNotifToggle.addEventListener('change', async (e) => {
            await set(ref(db, 'system/settings/emailNotifications'), e.target.checked);
            scNotify('info', e.target.checked ? 'Automatic email notifications enabled.' : 'Automatic email notifications disabled.');
        });
    }

    const maintenanceToggle = document.getElementById('maintenanceToggle');
    if (maintenanceToggle) {
        onValue(ref(db, 'system/settings/maintenanceMode'), (snapshot) => {
            if(snapshot.exists()) maintenanceToggle.checked = snapshot.val();
        });
        maintenanceToggle.addEventListener('change', async (e) => {
            await set(ref(db, 'system/settings/maintenanceMode'), e.target.checked);
            scNotify(e.target.checked ? 'warning' : 'success', e.target.checked ? 'Maintenance Mode Enabled. Staff logins restricted.' : 'Maintenance Mode Disabled. System operational.');
        });
    }

    // Real-time transactions activity listener (with date + claim status filters)
    const activityContainer = document.getElementById('adminRecentActivityContainer');
    const finDateFromInput = document.getElementById('finDateFrom');
    const finDateToInput = document.getElementById('finDateTo');
    const finClaimFilterSelect = document.getElementById('finClaimFilter');
    const finFilterResetBtn = document.getElementById('finFilterReset');
    const finFilterCountEl = document.getElementById('finFilterCount');
    let financialTxEntries = null; // cached [txId, tx] pairs from Firebase
    const financialTxById = {}; // txId -> transaction, filled on each render for the details modal

    // Local YYYY-MM-DD key for a timestamp (matches <input type="date"> values)
    function finTxDateKey(ts) {
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    function finTxMatchesClaimFilter(tx) {
        const filter = finClaimFilterSelect ? finClaimFilterSelect.value : 'all';
        if (filter === 'all') return true;
        const t = String(tx.type || '').toLowerCase();
        if (filter === 'claim-approved') return t.includes('claim') && t.includes('approv');
        if (filter === 'claim-declined') return t.includes('claim') && t.includes('declin');
        if (filter === 'claim-deleted') return t.includes('claim') && t.includes('delet');
        if (filter === 'approved-non-claim') return t.includes('approv') && !t.includes('claim');
        return true;
    }

    // Badge colors: green = approved claims, orange = approved non-claims (pension),
    // red = declined/rejected, grey = deleted
    function finTxBadgeStyle(tx) {
        const t = String(tx.type || '').toLowerCase();
        if (t.includes('delet')) return { bg: '#e2e8f0', color: '#475569' };
        if (t.includes('declin') || t.includes('reject')) return { bg: '#fee2e2', color: '#991b1b' };
        if (t.includes('approv')) {
            return t.includes('claim')
                ? { bg: '#dcfce7', color: '#166534' }
                : { bg: '#ffedd5', color: '#c2410c' };
        }
        return { bg: '#fee2e2', color: '#991b1b' };
    }

    function finTxMatchesDateFilter(tx) {
        const txKey = finTxDateKey(tx.createdAt);
        if (finDateFromInput && finDateFromInput.value && txKey < finDateFromInput.value) return false;
        if (finDateToInput && finDateToInput.value && txKey > finDateToInput.value) return false;
        return true;
    }

    function renderFinancialActivity() {
        if (!activityContainer || financialTxEntries === null) return;

        activityContainer.innerHTML = '';
        if (financialTxEntries.length === 0) {
            activityContainer.innerHTML = `
                <div style="text-align: center; color: #64748b; padding: 30px 0;">
                    <i class="fas fa-hand-holding-heart" style="font-size:2rem;color:#cbd5e1;margin-bottom:10px;display:block;"></i>
                    No transactions recorded yet.
                </div>`;
            if (finFilterCountEl) finFilterCountEl.textContent = '';
            return;
        }

        // Sort by createdAt descending
        financialTxEntries.sort((a, b) => b[1].createdAt - a[1].createdAt);
        financialTxEntries.forEach(([txId, tx]) => { financialTxById[txId] = tx; });

        const totalCount = financialTxEntries.length;
        const transactions = financialTxEntries.filter(([, tx]) => finTxMatchesDateFilter(tx) && finTxMatchesClaimFilter(tx));

        if (finFilterCountEl) {
            finFilterCountEl.textContent = `Showing ${transactions.length} of ${totalCount} transaction${totalCount === 1 ? '' : 's'}`;
        }

        if (transactions.length === 0) {
            activityContainer.innerHTML = `
                <div style="text-align: center; color: #64748b; padding: 30px 0;">
                    <i class="fas fa-filter" style="font-size:2rem;color:#cbd5e1;margin-bottom:10px;display:block;"></i>
                    No transactions match the selected filters.
                </div>`;
            return;
        }

            let tableHtml = `
                <div class="modern-table" style="box-shadow: none; border: none; padding: 0; margin-top: 10px;">
                    <table style="width: 100%; border-collapse: collapse; font-family: 'Inter', sans-serif;">
                        <thead>
                            <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                                <th style="text-align: left; padding: 12px; font-size: 0.8rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Status/Type</th>
                                <th style="text-align: left; padding: 12px; font-size: 0.8rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Senior Name</th>
                                <th style="text-align: left; padding: 12px; font-size: 0.8rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Amount & Ref</th>
                                <th style="text-align: left; padding: 12px; font-size: 0.8rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Processed By</th>
                                <th style="text-align: left; padding: 12px; font-size: 0.8rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Date & Time</th>
                            </tr>
                        </thead>
                        <tbody>
            `;

            transactions.forEach(([txId, tx]) => {
                const badge = finTxBadgeStyle(tx);
                const badgeBg = badge.bg;
                const badgeColor = badge.color;
                
                tableHtml += `
                    <tr style="border-bottom: 1px solid #f1f5f9; transition: background 0.2s; cursor: pointer;" title="Click to view transaction details" onclick="openFinDetailsModal('${txId}')" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
                        <td style="padding: 15px 12px;">
                            <span class="status-badge" style="background: ${badgeBg}; color: ${badgeColor}; font-weight: 700; font-size: 0.75rem; padding: 5px 10px; border-radius: 6px; text-transform: uppercase; display: inline-block;">
                                ${tx.type}
                            </span>
                        </td>
                        <td style="padding: 15px 12px; font-weight: 600; color: #1e293b;">${tx.seniorName}</td>
                        <td style="padding: 15px 12px;">
                            <div style="font-weight: 700; color: #0f172a;">PHP ${tx.amount}</div>
                            ${tx.refNumber ? `<div style="font-size: 0.75rem; color: #3b82f6; font-family: monospace; font-weight: 700; margin-top: 2px;">${tx.refNumber}</div>` : ''}
                        </td>
                        <td style="padding: 15px 12px; color: #475569; font-size: 0.85rem; font-weight: 500;">
                            <i class="fas fa-user-shield" style="color: #94a3b8; margin-right: 5px;"></i>${tx.processedBy || 'Staff'}
                        </td>
                        <td style="padding: 15px 12px; color: #64748b; font-size: 0.85rem;">${new Date(tx.createdAt).toLocaleString()}</td>
                    </tr>
                `;
            });

            tableHtml += `
                        </tbody>
                    </table>
                </div>
            `;
            activityContainer.innerHTML = tableHtml;
    }

    if (activityContainer) {
        onValue(ref(db, 'transactions'), (snapshot) => {
            financialTxEntries = snapshot.exists() ? Object.entries(snapshot.val()) : [];
            renderFinancialActivity();
        });

        const finReRender = () => renderFinancialActivity();
        if (finDateFromInput) finDateFromInput.addEventListener('change', finReRender);
        if (finDateToInput) finDateToInput.addEventListener('change', finReRender);
        if (finClaimFilterSelect) finClaimFilterSelect.addEventListener('change', finReRender);
        if (finFilterResetBtn) finFilterResetBtn.addEventListener('click', () => {
            if (finDateFromInput) finDateFromInput.value = '';
            if (finDateToInput) finDateToInput.value = '';
            if (finClaimFilterSelect) finClaimFilterSelect.value = 'all';
            renderFinancialActivity();
            scNotify('info', 'Financial activity filters cleared.');
        });
    }

    // ── Admin Overview Dashboard: shared realtime state ──
    // users -> total seniors + pending verifications + pending pensions
    // claims -> pending assistance requests
    // transactions -> categorized money claimed (pension vs assistance)
    // queue -> appointments section (successful checkups / pending / declined)
    const adminDashState = { users: {}, claims: {}, txs: {}, queues: {} };

    function adminDashSetText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function adminDashParseAmount(value) {
        if (value == null) return 0;
        if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
        const num = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
        return Number.isFinite(num) ? num : 0;
    }

    function adminDashFormatPHP(num) {
        return '₱' + Number(num || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 });
    }

    function adminDashIsArchivedSenior(user) {
        if (!user || user.role !== 'senior') return false;
        const status = String(user.lifeStatus || user.status || 'Active');
        return ARCHIVED_STATUSES.includes(status);
    }

    function adminDashTxIsPension(tx) {
        const hay = String(((tx && tx.type) || '') + ' ' + ((tx && tx.reason) || '')).toLowerCase();
        return hay.includes('pension');
    }

    function adminDashTxIsCountable(tx) {
        if (!tx) return false;
        const t = String(tx.type || '').toLowerCase();
        if (/(declin|reject|delet|remov|cancel|void|pending)/.test(t)) return false;
        return /(approv|paid|payout|claim|releas)/.test(t);
    }

    function adminDashDrawMoneyPie(pensionTotal, assistTotal) {
        const canvas = document.getElementById('adminMoneyPie');
        const legend = document.getElementById('adminMoneyPieLegend');
        if (!canvas) return;
        const grand = pensionTotal + assistTotal;
        const pct = (n) => grand > 0 ? (n / grand * 100).toFixed(1) + '%' : '—';
        if (legend) {
            legend.innerHTML =
                '<span><span style="display:inline-block;width:10px;height:10px;' +
                'border-radius:50%;background:#16a34a;margin-right:6px;"></span>' +
                'Pension ' + pct(pensionTotal) + '</span>' +
                '<span><span style="display:inline-block;width:10px;height:10px;' +
                'border-radius:50%;background:#2563eb;margin-right:6px;"></span>' +
                'Assistance ' + pct(assistTotal) + '</span>';
        }
        if (typeof Chart === 'undefined') return;
        try { if (window._adminMoneyPie) window._adminMoneyPie.destroy(); } catch (e) {}
        const empty = grand <= 0;
        try {
            window._adminMoneyPie = new Chart(canvas, {
                type: 'pie',
                data: {
                    labels: ['Monthly Pension', 'Assistance'],
                    datasets: [{
                        data: empty ? [1, 1] : [pensionTotal, assistTotal],
                        backgroundColor: empty ? ['#e2e8f0', '#f1f5f9'] : ['#16a34a', '#2563eb'],
                        borderWidth: 2, borderColor: '#ffffff', hoverOffset: 6
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: (item) => empty ? ' No released money yet'
                                    : ' ' + item.label + ': ' + adminDashFormatPHP(item.raw)
                                    + ' (' + pct(item.raw) + ')'
                            }
                        }
                    }
                }
            });
        } catch (e) { console.warn('Admin money pie skipped:', e.message); }
    }

    function renderAdminOverviewDashboard() {
        if (!document.getElementById('tab-overview')) return;
        const users = adminDashState.users || {};
        const claims = adminDashState.claims || {};
        const txs = adminDashState.txs || {};
        const seniors = Object.values(users).filter(
            u => u && u.role === 'senior' && !adminDashIsArchivedSenior(u));
        adminDashSetText('adminStatTotalSeniors', seniors.length);
        const pendingAssist = Object.values(claims).filter(
            c => c && String(c.status || '') === 'Pending').length;
        adminDashSetText('adminStatPendingAssist', pendingAssist);
        const pendingVerify = seniors.filter(s => {
            const kyc = String(s.kycStatus || '');
            return kyc === 'Pending' || kyc === 'Submitted';
        }).length;
        adminDashSetText('adminStatPendingVerify', pendingVerify);
        const currentMonth = new Date().toISOString().substring(0, 7);
        const pendingPension = seniors.filter(s => {
            const verified = s.kycStatus === 'Verified' || !!s.kycVerifiedAt;
            const active = String(s.lifeStatus || s.status || 'Active') === 'Active';
            return verified && active && s.lastPensionMonth !== currentMonth;
        }).length;
        adminDashSetText('adminStatPendingPension', pendingPension);
        let pensionTotal = 0, assistTotal = 0, counted = 0, skipped = 0;
        Object.values(txs).forEach(tx => {
            if (!adminDashTxIsCountable(tx)) { skipped++; return; }
            const amt = adminDashParseAmount(tx.amount);
            if (!(amt > 0)) { skipped++; return; }
            counted++;
            if (adminDashTxIsPension(tx)) pensionTotal += amt;
            else assistTotal += amt;
        });
        const combined = pensionTotal + assistTotal;
        adminDashSetText('adminMoneyPension', adminDashFormatPHP(pensionTotal));
        adminDashSetText('adminMoneyAssist', adminDashFormatPHP(assistTotal));
        adminDashSetText('adminMoneyTotal', adminDashFormatPHP(combined));
        const note = document.getElementById('adminMoneyNote');
        if (note) {
            const leader = pensionTotal === assistTotal ? 'Both programs are tied so far.'
                : (pensionTotal > assistTotal
                    ? 'Monthly Pension has released more money so far.'
                    : 'Assistance has released more money so far.');
            note.textContent = leader + ' Counted ' + counted + ' released transaction'
                + (counted === 1 ? '' : 's') + ' (' + adminDashFormatPHP(pensionTotal)
                + ' pension + ' + adminDashFormatPHP(assistTotal) + ' assistance = '
                + adminDashFormatPHP(combined) + '). Declined, deleted and pending items ('
                + skipped + ') are never counted.';
        }
        adminDashDrawMoneyPie(pensionTotal, assistTotal);
    }

    // Appointment date-filter inputs — declared BEFORE initAdminOverviewDashboard()
    // runs, since it synchronously calls renderAdminAppointments() which uses these.
    const apptDateFromInput = document.getElementById('apptDateFrom');
    const apptDateToInput = document.getElementById('apptDateTo');
    const apptFilterResetBtn = document.getElementById('apptFilterReset');
    const apptFilterCountEl = document.getElementById('apptFilterCount');
    const adminApptById = {}; // queueId -> appointment, filled on each render for the details modal

    function initAdminOverviewDashboard() {
        if (!document.getElementById('tab-overview')) return;
        try {
            onValue(ref(db, 'users'), (snap) => {
                adminDashState.users = snap.exists() ? snap.val() : {};
                renderAdminOverviewDashboard();
            });
            onValue(ref(db, 'claims'), (snap) => {
                adminDashState.claims = snap.exists() ? snap.val() : {};
                renderAdminOverviewDashboard();
            });
            onValue(ref(db, 'transactions'), (snap) => {
                adminDashState.txs = snap.exists() ? snap.val() : {};
                renderAdminOverviewDashboard();
            });
            onValue(ref(db, 'queue'), (snap) => {
                adminDashState.queues = snap.exists() ? snap.val() : {};
                renderAdminAppointments();
            });
        } catch (e) { console.warn('Admin overview listeners skipped:', e.message); }
        renderAdminOverviewDashboard();
        renderAdminAppointments();
    }

    initAdminOverviewDashboard();

    // ── Appointments section: successful checkups / pending / declined ──
    // Driven by the realtime `queue` node — the same appointment data the
    // employee dashboard approves/declines/marks done.
    // Successful checkup = status "Attended" (a staff member marked the visit
    // as done). Pending = awaiting action or upcoming (Pending/Rescheduled/
    // Approved). Declined = bookings rejected by staff.
    const APPT_STATUS_META = {
        Attended:    { bg: '#dcfce7', color: '#166534' },
        Approved:    { bg: '#dcfce7', color: '#15803d' },
        Pending:     { bg: '#fef9c3', color: '#a16207' },
        Rescheduled: { bg: '#dbeafe', color: '#1d4ed8' },
        Declined:    { bg: '#fee2e2', color: '#b91c1c' },
        Missed:      { bg: '#fee2e2', color: '#991b1b' },
        Cancelled:   { bg: '#e2e8f0', color: '#334155' }
    };

    function adminApptStatusMeta(status) {
        return APPT_STATUS_META[status] || { bg: '#f1f5f9', color: '#475569' };
    }

    function adminApptSetCount(id, count, label) {
        const el = document.getElementById(id);
        if (el) el.textContent = count + ' ' + label;
    }

    function adminApptSchedule(q) {
        let dateStr = 'N/A';
        if (q.date) {
            const d = new Date(q.date + 'T00:00:00');
            dateStr = isNaN(d.getTime()) ? q.date
                : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        }
        return scEscapeHtml(dateStr + (q.time ? ' · ' + q.time : ''));
    }

    function adminApptRows(list, noteFor) {
        if (!list.length) {
            return '<tr><td colspan="6" style="text-align:center; color:#94a3b8; padding:18px 12px; font-style:italic;">No appointments here.</td></tr>';
        }
        return list.map(q => {
            const meta = adminApptStatusMeta(q.status);
            const user = (adminDashState.users || {})[q.uid] || {};
            const name = user.name || q.name || 'Unknown Senior';
            const note = noteFor ? noteFor(q) : '';
            return `<tr style="cursor: pointer; transition: background 0.15s;" title="Click to view appointment details" onclick="openApptDetailsModal('${q.id}')" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
                <td style="font-weight:600; color:#1e293b;">${scEscapeHtml(name)}<br><span style="font-size:0.75rem; color:#64748b;">ID: ${scEscapeHtml(q.seniorId || 'N/A')}</span></td>
                <td>${scEscapeHtml(q.service || 'General Consultation')}</td>
                <td style="color:#475569;">${adminApptSchedule(q)}</td>
                <td><span style="font-family:monospace; font-weight:600; color:#3b82f6;">${scEscapeHtml(q.queueNumber || 'N/A')}</span></td>
                <td><span class="status-badge" style="background:${meta.bg}; color:${meta.color}; font-weight:700;">${scEscapeHtml(q.status || 'Unknown')}</span></td>
                <td style="color:#64748b; font-size:0.82rem;">${note || '—'}</td>
            </tr>`;
        }).join('');
    }

    // Appointments store their schedule as q.date ('YYYY-MM-DD'), which matches
    // <input type="date"> values directly — plain string comparison is enough.
    function adminApptMatchesDateFilter(q) {
        const d = String(q.date || '');
        if (apptDateFromInput && apptDateFromInput.value && (!d || d < apptDateFromInput.value)) return false;
        if (apptDateToInput && apptDateToInput.value && (!d || d > apptDateToInput.value)) return false;
        return true;
    }

    function renderAdminAppointments() {
        const completedBody = document.getElementById('adminApptCompletedBody');
        if (!completedBody) return;

        const allQueues = Object.entries(adminDashState.queues || {})
            .map(([id, q]) => ({ ...(q || {}), id }))
            .filter(q => q.uid || q.queueNumber);
        allQueues.forEach(q => { adminApptById[q.id] = q; });
        const queues = allQueues.filter(adminApptMatchesDateFilter);

        if (apptFilterCountEl) {
            apptFilterCountEl.textContent = `Showing ${queues.length} of ${allQueues.length} appointment${allQueues.length === 1 ? '' : 's'}`;
        }

        const completed = queues.filter(q => q.status === 'Attended')
            .sort((a, b) => (b.attendedAt || b.scheduledAt || 0) - (a.attendedAt || a.scheduledAt || 0));
        const pending = queues.filter(q => ['Pending', 'Rescheduled', 'Approved'].includes(q.status))
            .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
        const declined = queues.filter(q => q.status === 'Declined')
            .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

        adminApptSetCount('adminApptCompletedCount', completed.length, 'Successful');
        adminApptSetCount('adminApptPendingCount', pending.length, 'Pending');
        adminApptSetCount('adminApptDeclinedCount', declined.length, 'Declined');

        completedBody.innerHTML = adminApptRows(completed, (q) =>
            q.attendedAt ? scEscapeHtml('Completed ' + new Date(q.attendedAt).toLocaleString()) : '');
        document.getElementById('adminApptPendingBody').innerHTML = adminApptRows(pending, null);
        document.getElementById('adminApptDeclinedBody').innerHTML = adminApptRows(declined, (q) =>
            q.decisionNote ? scEscapeHtml(q.decisionNote) : '');
    }

    const apptReRender = () => renderAdminAppointments();
    if (apptDateFromInput) apptDateFromInput.addEventListener('change', apptReRender);
    if (apptDateToInput) apptDateToInput.addEventListener('change', apptReRender);
    if (apptFilterResetBtn) apptFilterResetBtn.addEventListener('click', () => {
        if (apptDateFromInput) apptDateFromInput.value = '';
        if (apptDateToInput) apptDateToInput.value = '';
        renderAdminAppointments();
        scNotify('info', 'Appointment date filters cleared.');
    });

    // ── Appointment details modal (click a row to view the staff decision log) ──
    function adminApptFormatTs(ts) {
        if (!ts) return '—';
        const d = new Date(ts);
        return isNaN(d.getTime()) ? '—' : d.toLocaleString();
    }

    function adminApptDecisionRow(icon, iconColor, label, who, when) {
        return `<div style="display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f1f5f9;">
            <span style="width: 30px; height: 30px; border-radius: 50%; background: ${iconColor}1a; color: ${iconColor}; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;"><i class="fas ${icon}" style="font-size: 0.8rem;"></i></span>
            <div style="min-width: 0;">
                <div style="font-size: 0.75rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.3px;">${label}</div>
                <div style="font-size: 0.92rem; font-weight: 600; color: #1e293b; margin-top: 2px;"><i class="fas fa-user-shield" style="color: #94a3b8; margin-right: 5px;"></i>${scEscapeHtml(who || 'Unknown staff')}</div>
                <div style="font-size: 0.78rem; color: #64748b; margin-top: 1px;">${scEscapeHtml(when)}</div>
            </div>
        </div>`;
    }

    window.openApptDetailsModal = function(queueId) {
        const q = adminApptById[queueId];
        const modal = document.getElementById('apptDetailsModal');
        const content = document.getElementById('apptDetailsContent');
        if (!q || !modal || !content) return;

        const user = (adminDashState.users || {})[q.uid] || {};
        const name = user.name || q.name || 'Unknown Senior';
        const meta = adminApptStatusMeta(q.status);

        // Prefer the per-decision actor fields; fall back to the last updater for
        // records created before per-decision tracking was added.
        let approvedBy = q.approvedByName || '';
        let approvedAt = q.approvedAt || '';
        if (!approvedBy && q.status === 'Approved') { approvedBy = q.updatedByName || ''; approvedAt = q.updatedAt || ''; }
        let declinedBy = q.declinedByName || '';
        let declinedAt = q.declinedAt || '';
        if (!declinedBy && q.status === 'Declined') { declinedBy = q.updatedByName || ''; declinedAt = q.updatedAt || ''; }
        let attendedBy = q.attendedByName || '';
        let attendedAt = q.attendedAt || '';
        if (!attendedBy && q.status === 'Attended') { attendedBy = q.updatedByName || ''; if (!attendedAt) attendedAt = q.updatedAt || ''; }

        let html = `
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 15px; margin-bottom: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
                    <div>
                        <div style="font-weight: 700; color: #1e293b; font-size: 1.05rem;">${scEscapeHtml(name)}</div>
                        <div style="font-size: 0.8rem; color: #64748b;">ID: ${scEscapeHtml(q.seniorId || 'N/A')}</div>
                    </div>
                    <span class="status-badge" style="background: ${meta.bg}; color: ${meta.color}; font-weight: 700;">${scEscapeHtml(q.status || 'Unknown')}</span>
                </div>
                <div style="display: flex; gap: 18px; flex-wrap: wrap; margin-top: 12px; font-size: 0.85rem; color: #475569;">
                    <span><i class="fas fa-stethoscope" style="color: #94a3b8; margin-right: 5px;"></i>${scEscapeHtml(q.service || 'General Consultation')}</span>
                    <span><i class="fas fa-calendar" style="color: #94a3b8; margin-right: 5px;"></i>${adminApptSchedule(q)}</span>
                    <span><i class="fas fa-hashtag" style="color: #94a3b8; margin-right: 5px;"></i>${scEscapeHtml(q.queueNumber || 'N/A')}</span>
                </div>
                ${q.note ? `<div style="font-size: 0.8rem; color: #64748b; margin-top: 10px;"><b>Senior's note:</b> ${scEscapeHtml(q.note)}</div>` : ''}
            </div>
            <h4 style="font-size: 0.8rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 5px; font-weight: 700;">Staff Decision Log</h4>
            ${adminApptDecisionRow('fa-calendar-plus', '#3b82f6', 'Booked by senior', name, adminApptFormatTs(q.createdAt))}`;
        if (approvedBy) html += adminApptDecisionRow('fa-circle-check', '#16a34a', 'Approved by', approvedBy, adminApptFormatTs(approvedAt));
        if (declinedBy) {
            html += adminApptDecisionRow('fa-circle-xmark', '#dc2626', 'Declined by', declinedBy, adminApptFormatTs(declinedAt));
            if (q.decisionNote) {
                html += `<div style="font-size: 0.85rem; color: #b91c1c; background: #fef2f2; border-radius: 8px; padding: 10px 12px; margin: 8px 0;"><b>Reason:</b> ${scEscapeHtml(q.decisionNote)}</div>`;
            }
        }
        if (attendedBy) html += adminApptDecisionRow('fa-clipboard-check', '#16a34a', 'Visit marked as done by', attendedBy, adminApptFormatTs(attendedAt));
        if (!approvedBy && !declinedBy && !attendedBy) {
            html += q.updatedByName
                ? adminApptDecisionRow('fa-clock-rotate-left', '#64748b', 'Last updated by', q.updatedByName, adminApptFormatTs(q.updatedAt))
                : '<div style="text-align: center; color: #94a3b8; font-style: italic; padding: 12px 0;">Awaiting staff review — no decision recorded yet.</div>';
        }
        content.innerHTML = html;
        modal.style.display = 'flex';
    };

    const apptDetailsModal = document.getElementById('apptDetailsModal');
    const closeApptDetailsModalBtn = document.getElementById('closeApptDetailsModal');
    if (closeApptDetailsModalBtn && apptDetailsModal) {
        closeApptDetailsModalBtn.addEventListener('click', () => {
            apptDetailsModal.style.display = 'none';
        });
        apptDetailsModal.addEventListener('click', (e) => {
            if (e.target === apptDetailsModal) apptDetailsModal.style.display = 'none';
        });
    }

    // ── Transaction details modal (click a financial row to view full record) ──
    function finTxCategory(tx) {
        const t = String(tx.type || '').toLowerCase();
        if (t.includes('delet')) return { icon: 'fa-trash-can', color: '#64748b', label: 'Record Deleted', desc: 'This claim record was deleted by staff. No payout was released.' };
        if (t.includes('declin') || t.includes('reject')) return { icon: 'fa-circle-xmark', color: '#dc2626', label: 'Declined', desc: 'This request was declined by staff. No payout was released.' };
        if (t.includes('approv')) {
            return t.includes('claim')
                ? { icon: 'fa-circle-check', color: '#16a34a', label: 'Claim Approved', desc: 'Assistance claim was verified, approved and paid out.' }
                : { icon: 'fa-circle-check', color: '#c2410c', label: 'Pension Approved', desc: 'Pension was approved and released to the senior.' };
        }
        return { icon: 'fa-circle-xmark', color: '#dc2626', label: 'Declined', desc: 'This request was declined by staff. No payout was released.' };
    }

    function finTxDetailRow(label, valueHtml) {
        return `<div style="display: flex; justify-content: space-between; gap: 15px; padding: 9px 0; border-bottom: 1px solid #f1f5f9; font-size: 0.88rem;">
            <span style="color: #64748b; font-weight: 600; flex-shrink: 0;">${label}</span>
            <span style="color: #1e293b; font-weight: 600; text-align: right; min-width: 0;">${valueHtml}</span>
        </div>`;
    }

    window.openFinDetailsModal = function(txId) {
        const tx = financialTxById[txId];
        const modal = document.getElementById('finTxDetailsModal');
        const content = document.getElementById('finTxDetailsContent');
        if (!tx || !modal || !content) return;

        const cat = finTxCategory(tx);
        const user = (adminDashState.users || {})[tx.seniorUid] || {};
        const amount = 'PHP ' + Number(tx.amount || 0).toLocaleString();

        content.innerHTML = `
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 15px; margin-bottom: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
                    <div>
                        <div style="font-weight: 700; color: #1e293b; font-size: 1.05rem;">${scEscapeHtml(tx.seniorName || 'Unknown Senior')}</div>
                        ${tx.seniorUid && user.name ? `<div style="font-size: 0.8rem; color: #64748b;">Account: ${scEscapeHtml(user.name)}${user.seniorId ? ' &bull; ID: ' + scEscapeHtml(user.seniorId) : ''}</div>` : ''}
                    </div>
                    <span class="status-badge" style="background: ${cat.color}1a; color: ${cat.color}; font-weight: 700; text-transform: uppercase; font-size: 0.75rem; padding: 5px 10px; border-radius: 6px;"><i class="fas ${cat.icon}" style="margin-right: 5px;"></i>${scEscapeHtml(tx.type || cat.label)}</span>
                </div>
                <div style="margin-top: 12px;">
                    <div style="font-size: 1.35rem; font-weight: 800; color: #0f172a;">${scEscapeHtml(amount)}</div>
                    ${tx.refNumber ? `<div style="font-size: 0.8rem; color: #3b82f6; font-family: monospace; font-weight: 700; margin-top: 2px;">Ref: ${scEscapeHtml(tx.refNumber)}</div>` : '<div style="font-size: 0.8rem; color: #94a3b8; margin-top: 2px;">No reference number recorded.</div>'}
                </div>
            </div>
            <div style="font-size: 0.85rem; color: #475569; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
                <i class="fas fa-circle-info" style="color: #b45309; margin-right: 5px;"></i>${scEscapeHtml(cat.desc)}
            </div>
            ${finTxDetailRow('Processed by', `<i class="fas fa-user-shield" style="color: #94a3b8; margin-right: 5px;"></i>${scEscapeHtml(tx.processedBy || 'Staff')}`)}
            ${finTxDetailRow('Date &amp; time', scEscapeHtml(adminApptFormatTs(tx.createdAt)))}
            ${tx.reason ? finTxDetailRow('Reason / note', scEscapeHtml(tx.reason)) : ''}
        `;
        modal.style.display = 'flex';
    };

    const finTxDetailsModal = document.getElementById('finTxDetailsModal');
    const closeFinTxDetailsModalBtn = document.getElementById('closeFinTxDetailsModal');
    if (closeFinTxDetailsModalBtn && finTxDetailsModal) {
        closeFinTxDetailsModalBtn.addEventListener('click', () => {
            finTxDetailsModal.style.display = 'none';
        });
        finTxDetailsModal.addEventListener('click', (e) => {
            if (e.target === finTxDetailsModal) finTxDetailsModal.style.display = 'none';
        });
    }

    // ── Verified Seniors Registry (Face Tab) ──
    const verifiedTableBody = document.getElementById('verifiedSeniorsTableBody');
    const verifiedSeniorSearch = document.getElementById('verifiedSeniorSearch');
    const verifiedEmptyState = document.getElementById('verifiedEmptyState');
    let verifiedSeniorsData = [];

    if (verifiedTableBody) {
        onValue(ref(db, 'users'), (snapshot) => {
            verifiedTableBody.innerHTML = '';
            verifiedSeniorsData = [];

            if (!snapshot.exists()) {
                verifiedTableBody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:#94a3b8;">No senior accounts found.</td></tr>';
                return;
            }

            let totalVerified = 0;
            let pendingKyc = 0;
            let notVerified = 0;
            let totalSeniors = 0;

            // Collect ALL senior accounts (every account is shown — no KYC filtering)
            const allSeniors = [];
            for (const [uid, user] of Object.entries(snapshot.val())) {
                if (user.role !== 'senior') continue;
                totalSeniors++;

                const kycStatus = user.kycStatus || 'Not Verified';
                if (kycStatus === 'Verified') totalVerified++;
                else if (kycStatus === 'Pending' || kycStatus === 'Submitted') pendingKyc++;
                else notVerified++;

                let age = Number(user.age) || 0;
                if (!age && user.dob) {
                    const birthDate = new Date(user.dob);
                    const today = new Date();
                    age = today.getFullYear() - birthDate.getFullYear();
                    const m = today.getMonth() - birthDate.getMonth();
                    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
                }

                allSeniors.push({
                    uid,
                    user,
                    kycStatus,
                    accountStatus: user.lifeStatus || user.status || 'Active',
                    priority: calculatePriorityLevelAdmin(user),
                    age
                });
            }

            // Sort Higher → Lower priority (High first), then oldest seniors first within each group
            const pRank = { High: 0, Medium: 1, Low: 2 };
            allSeniors.sort((a, b) => {
                if (pRank[a.priority] !== pRank[b.priority]) return pRank[a.priority] - pRank[b.priority];
                if ((b.age || 0) !== (a.age || 0)) return (b.age || 0) - (a.age || 0);
                return (a.user.name || '').localeCompare(b.user.name || '');
            });

            const groupMeta = {
                High: { label: 'High Priority', icon: 'fa-exclamation-circle', bg: '#fee2e2', color: '#b91c1c', border: '#fecaca', desc: 'Reported illness / health condition, centenarians (100+), or staff-flagged cases' },
                Medium: { label: 'Medium Priority', icon: 'fa-hourglass-half', bg: '#fef3c7', color: '#b45309', border: '#fde68a', desc: 'Ages 90–99 (nonagenarians)' },
                Low: { label: 'Low Priority', icon: 'fa-check-circle', bg: '#e0f2fe', color: '#0369a1', border: '#bae6fd', desc: 'Below 90 with no reported illness (standard queue)' }
            };

            let currentPriority = null;

            for (const { uid, user, kycStatus, accountStatus, priority, age } of allSeniors) {
                // Category header row — rendered once per priority group (High → Medium → Low)
                if (priority !== currentPriority) {
                    currentPriority = priority;
                    const meta = groupMeta[priority] || groupMeta.Low;
                    const groupCount = allSeniors.filter(s => s.priority === priority).length;
                    const headerTr = document.createElement('tr');
                    headerTr.setAttribute('data-group', priority);
                    headerTr.innerHTML = `<td colspan="9" style="padding:10px 15px;background:${meta.bg};border-top:2px solid ${meta.border};border-bottom:1px solid ${meta.border};">
                        <span style="font-weight:800;color:${meta.color};font-size:0.78rem;text-transform:uppercase;letter-spacing:0.5px;"><i class="fas ${meta.icon}" style="margin-right:6px;"></i>${meta.label}</span>
                        <span style="color:${meta.color};font-size:0.75rem;margin-left:10px;">${groupCount} senior${groupCount === 1 ? '' : 's'} &bull; ${meta.desc}</span>
                    </td>`;
                    verifiedTableBody.appendChild(headerTr);
                }
                let acctColor = '#94a3b8', acctBg = '#f1f5f9';
                if (accountStatus === 'Active') { acctColor = '#166534'; acctBg = '#dcfce7'; }
                else if (accountStatus === 'Inactive') { acctColor = '#991b1b'; acctBg = '#fef2f2'; }
                else if (accountStatus === 'Deceased') { acctColor = '#1e293b'; acctBg = '#e2e8f0'; }
                else if (accountStatus === 'Transferred' || accountStatus === 'Archived') { acctColor = '#92400e'; acctBg = '#fef3c7'; }

                const faceSrc = user.kycFaceImage || user.faceImage || '';
                const faceThumb = faceSrc
                    ? `<img src="${faceSrc}" alt="Face" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid #e2e8f0;display:block;">`
                    : `<div style="width:44px;height:44px;border-radius:50%;background:#f1f5f9;border:2px solid #e2e8f0;display:flex;align-items:center;justify-content:center;"><i class="fas fa-user" style="color:#cbd5e1;"></i></div>`;

                const kycBadge = kycStatus === 'Verified'
                    ? '<span class="status-badge" style="background:#dcfce7;color:#166534;font-weight:600;">Verified</span>'
                    : (kycStatus === 'Pending' || kycStatus === 'Submitted')
                        ? `<span class="status-badge" style="background:#fef3c7;color:#b45309;font-weight:600;">${kycStatus}</span>`
                        : `<span class="status-badge" style="background:#f1f5f9;color:#64748b;font-weight:600;">${kycStatus}</span>`;

                const pMeta = priority === 'High' ? { bg: '#fee2e2', color: '#b91c1c' }
                    : priority === 'Medium' ? { bg: '#fef3c7', color: '#b45309' }
                    : { bg: '#e0f2fe', color: '#0369a1' };

                const verifiedOn = user.kycVerifiedAt
                    ? new Date(user.kycVerifiedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                    : 'N/A';

                const registeredOn = user.createdAt
                    ? new Date(user.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                    : 'N/A';

                const entry = { uid, name: user.name, email: user.email, seniorId: user.seniorId, priority, verifiedOn: user.kycVerifiedAt, verifiedBy: user.verifiedBy, accountStatus };
                verifiedSeniorsData.push(entry);

                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid #f1f5f9';
                tr.style.cursor = 'pointer';
                tr.style.transition = 'background 0.2s';
                tr.setAttribute('data-name', (user.name || '').toLowerCase());
                tr.setAttribute('data-seniorid', (user.seniorId || '').toLowerCase());

                tr.innerHTML = `
                    <td style="padding: 10px 15px;">${faceThumb}</td>
                    <td style="padding: 12px 15px; font-family: monospace; font-weight: 600; color: #3b82f6;">${user.seniorId || 'N/A'}</td>
                    <td style="padding: 12px 15px; font-weight: 600; color: #1e293b;">${user.name || 'N/A'}${age ? ` <span style="font-weight:400;color:#94a3b8;font-size:0.8rem;">(${age} yrs)</span>` : ''}</td>
                    <td style="padding: 12px 15px; color: #64748b;">${user.email || 'N/A'}</td>
                    <td style="padding: 12px 15px;"><span class="status-badge" style="background:${pMeta.bg};color:${pMeta.color};font-weight:700;">${priority}</span></td>
                    <td style="padding: 12px 15px;">${kycBadge}</td>
                    <td style="padding: 12px 15px; color: #475569; font-size: 0.85rem;">${verifiedOn}</td>
                    <td style="padding: 12px 15px; color: #475569; font-size: 0.85rem;">${user.verifiedByEmail ? `<i class="fas fa-user-shield" style="color:#94a3b8;margin-right:4px;"></i>${user.verifiedBy} (${user.verifiedByEmail})` : (user.verifiedBy || '<span style="color:#94a3b8;">N/A</span>')}</td>
                    <td style="padding: 12px 15px;"><span class="status-badge" style="background:${acctBg};color:${acctColor};">${accountStatus}</span></td>
                `;

                // Expandable details row
                const detailsRow = document.createElement('tr');
                detailsRow.style.display = 'none';
                detailsRow.innerHTML = `
                    <td colspan="9" style="padding: 0;">
                        <div style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; padding: 24px 32px; display: flex; gap: 28px;">
                            <div style="flex: 1; min-width: 0;">
                                <h5 style="font-size:0.8rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 14px;"><i class="fas fa-id-card" style="margin-right:6px;color:#3b82f6;"></i>Personal Information</h5>
                                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px 24px;">
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">First Name</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.firstName || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Middle Name</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.middleName || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Last Name</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.lastName || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Extension</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.extension || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Senior ID Number</strong><br><span style="font-size:0.9rem;font-family:monospace;font-weight:600;color:#3b82f6;">${user.seniorId || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Gmail / Email</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.email || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Date of Birth</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.dob || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Age</strong><br><span style="font-size:0.9rem;color:#1e293b;">${age || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Sex</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.sex || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Civil Status</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.civilStatus || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Citizenship</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.citizenship || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Cellphone No.</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.cpNumber || 'N/A'}</span></div>
                                    <div style="grid-column:span 3;"><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Complete Address</strong><br><span style="font-size:0.9rem;color:#1e293b;">${[user.address, user.barangay, user.city, user.province, user.postalCode].filter(Boolean).join(', ') || 'N/A'}</span></div>
                                </div>
                                <h5 style="font-size:0.8rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;margin:18px 0 14px;"><i class="fas fa-clipboard-list" style="margin-right:6px;color:#3b82f6;"></i>Account &amp; Health Information</h5>
                                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px 24px;">
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Account Status</strong><br><span class="status-badge" style="background:${acctBg};color:${acctColor};">${accountStatus}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">KYC Status</strong><br><span style="font-size:0.9rem;color:#1e293b;">${kycStatus}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Priority Level</strong><br><span class="status-badge" style="background:${pMeta.bg};color:${pMeta.color};font-weight:700;">${priority}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Health Condition</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.healthCondition || user.condition || user.preExistingConditions || 'None reported'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Senior Category</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.seniorCategory || 'None'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Registration Method</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.registrationMethod || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Registered By</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.registeredBy || 'N/A'}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Registered On</strong><br><span style="font-size:0.9rem;color:#1e293b;">${registeredOn}</span></div>
                                    <div><strong style="font-size:0.75rem;color:#64748b;text-transform:uppercase;">Verified By / On</strong><br><span style="font-size:0.9rem;color:#1e293b;">${user.verifiedBy || 'N/A'} · ${verifiedOn}</span></div>
                                </div>
                                <p style="font-size:0.75rem;color:#94a3b8;margin:14px 0 0;"><i class="fas fa-lock" style="margin-right:4px;"></i>Password is hidden for security and cannot be displayed.</p>
                            </div>
                            <div style="width: 240px; flex-shrink: 0;">
                                <h5 style="font-size:0.8rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 14px;"><i class="fas fa-camera" style="margin-right:6px;color:#3b82f6;"></i>Face Scan</h5>
                                <div style="background: #0f172a; border-radius: 10px; overflow: hidden; border: 2px solid #e2e8f0; aspect-ratio: 4/3; display: flex; align-items: center; justify-content: center;">
                                    ${(user.kycFaceImage || user.faceImage)
                                        ? `<img src="${user.kycFaceImage || user.faceImage}" alt="Face" style="width:100%;height:100%;object-fit:cover;">`
                                        : `<span style="color:#64748b;font-size:0.8rem;text-align:center;"><i class="fas fa-user" style="font-size:2rem;display:block;margin-bottom:6px;opacity:0.5;"></i>No Image</span>`
                                    }
                                </div>
                                <p style="font-size:0.75rem;color:#94a3b8;margin:10px 0 0;text-align:center;">Senior ID: <strong>${user.seniorId || 'N/A'}</strong></p>
                            </div>
                        </div>
                    </td>
                `;

                tr.addEventListener('click', () => {
                    const isOpen = detailsRow.style.display !== 'none';
                    detailsRow.style.display = isOpen ? 'none' : 'table-row';
                    const icon = tr.querySelector('.fa-chevron-right');
                    if (icon) icon.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(90deg)';
                });

                verifiedTableBody.appendChild(tr);
                verifiedTableBody.appendChild(detailsRow);
            }

            document.getElementById('statTotalVerified').textContent = totalVerified;
            document.getElementById('statPendingKyc').textContent = pendingKyc;
            document.getElementById('statNotVerified').textContent = notVerified;
            document.getElementById('verifiedSeniorCount').textContent = totalSeniors;

            if (verifiedSeniorsData.length === 0) {
                verifiedTableBody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:#94a3b8;">No senior accounts found.</td></tr>';
            }

            // Re-apply search filter if there's a value
            if (verifiedSeniorSearch && verifiedSeniorSearch.value) {
                filterVerifiedSeniors(verifiedSeniorSearch.value);
            }
        }, (error) => {
            console.error("Firebase database error (verifiedSeniors):", error);
            verifiedTableBody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:#ef4444;">Error loading seniors: ${error.message}</td></tr>`;
        });
    }

    // Global search filter for verified seniors
    window.filterVerifiedSeniors = function (query) {
        const q = query.toLowerCase().trim();
        const rows = verifiedTableBody ? verifiedTableBody.querySelectorAll('tr[data-name]') : [];
        let visibleCount = 0;

        rows.forEach(row => {
            const name = row.getAttribute('data-name') || '';
            const seniorId = row.getAttribute('data-seniorid') || '';
            const match = !q || name.includes(q) || seniorId.includes(q);
            row.style.display = match ? '' : 'none';
            if (match) visibleCount++;

            const detailsRow = row.nextElementSibling;
            if (detailsRow && detailsRow.style.display !== 'none' && !detailsRow.hasAttribute('data-name')) {
                detailsRow.style.display = match ? detailsRow.style.display : 'none';
            }
        });

        // Hide priority category headers whose group has no visible seniors
        const groupRows = verifiedTableBody ? verifiedTableBody.querySelectorAll('tr[data-group]') : [];
        groupRows.forEach(groupRow => {
            let sibling = groupRow.nextElementSibling;
            let visibleInGroup = 0;
            while (sibling && !sibling.hasAttribute('data-group')) {
                if (sibling.hasAttribute('data-name') && sibling.style.display !== 'none') visibleInGroup++;
                sibling = sibling.nextElementSibling;
            }
            groupRow.style.display = visibleInGroup > 0 ? '' : 'none';
        });

        if (verifiedEmptyState) {
            verifiedEmptyState.style.display = (visibleCount === 0 && q) ? 'block' : 'none';
        }
    };
});

// ============================================================
// SilverCare — Shared report export helpers (CSV + Excel + PDF)
// CSV export below is preserved; Excel (.xls) and printable PDF
// are generated fully client-side with zero new dependencies.
// ============================================================
function scReportTitle(type) {
    return (type || 'report').charAt(0).toUpperCase() + (type || 'report').slice(1) + ' Report';
}

function scReportStamp() {
    return new Date().toLocaleString();
}

function scCollectReportRows(type) {
    const rows = [];
    const users = window.allUsersData || {};
    if (type === 'population') {
        rows.push(['Name', 'Email', 'Role', 'Account Status', 'Life Status', 'Senior ID']);
        for (const uid of Object.keys(users)) {
            const user = users[uid] || {};
            if (user.role !== 'senior') continue;
            rows.push([user.name || '', user.email || '', user.role || '', user.status || '', user.lifeStatus || 'Active', user.seniorId || '']);
        }
    } else if (type === 'benefits') {
        rows.push(['Senior ID', 'Name', 'Benefit Status', 'Last Disbursed']);
        for (const uid of Object.keys(users)) {
            const user = users[uid] || {};
            if (user.role !== 'senior') continue;
            rows.push([user.seniorId || '', user.name || '', 'Active', new Date().toLocaleDateString()]);
        }
    } else if (type === 'health') {
        rows.push(['Senior ID', 'Name', 'Health Status', 'Last Checkup']);
        for (const uid of Object.keys(users)) {
            const user = users[uid] || {};
            if (user.role !== 'senior') continue;
            rows.push([user.seniorId || '', user.name || '', 'Stable', 'N/A']);
        }
    }
    return rows;
}

function scEscapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function scDownloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { document.body.removeChild(link); URL.revokeObjectURL(url); }, 500);
}

// Excel-compatible export (.xls opens in Excel / Sheets).
window.exportReportExcel = function (type) {
    try {
        const title = scReportTitle(type);
        const rows = scCollectReportRows(type);
        if (rows.length <= 1) {
            scNotify('warning', 'No senior data available to export.');
            return;
        }
        let html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">';
        html += '<head><meta charset="UTF-8"></head><body>';
        html += '<h2>' + scEscapeHtml('SilverCare — OSCA Magalang · ' + title) + '</h2>';
        html += '<p>Generated: ' + scEscapeHtml(scReportStamp()) + '</p>';
        html += '<table border="1"><thead><tr>';
        rows[0].forEach(h => { html += '<th>' + scEscapeHtml(h) + '</th>'; });
        html += '</tr></thead><tbody>';
        for (let i = 1; i < rows.length; i++) {
            html += '<tr>';
            rows[i].forEach(c => { html += '<td>' + scEscapeHtml(c) + '</td>'; });
            html += '</tr>';
        }
        html += '</tbody></table></body></html>';
        scDownloadBlob(new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8' }), 'SilverCare_' + title.replace(/\s+/g, '_') + '.xls');
        scNotify('success', title + ' exported to Excel successfully!');
    } catch (err) {
        console.error('Excel export error:', err);
        scNotify('error', 'Excel export failed. Please try again.');
    }
};

// Print-friendly PDF export via a printable window (Save as PDF).
window.exportReportPdf = function (type) {
    try {
        const title = scReportTitle(type);
        const rows = scCollectReportRows(type);
        if (rows.length <= 1) {
            scNotify('warning', 'No senior data available to export.');
            return;
        }
        const w = window.open('', '_blank', 'width=1000,height=700');
        if (!w) {
            scNotify('warning', 'Please allow pop-ups to export the PDF report.');
            return;
        }
        let html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>SilverCare ' + scEscapeHtml(title) + '</title>';
        html += '<style>body{font-family:Arial,sans-serif;color:#1e293b;padding:28px;}';
        html += 'h1{font-size:20px;margin:0;}p.meta{color:#64748b;font-size:12px;}';
        html += 'table{width:100%;border-collapse:collapse;margin-top:16px;font-size:12px;}';
        html += 'th{background:#065f46;color:#fff;padding:8px;border:1px solid #065f46;text-align:left;}';
        html += 'td{padding:7px 8px;border:1px solid #cbd5e1;}';
        html += 'tr:nth-child(even) td{background:#f8fafc;}</style></head><body>';
        html += '<h1>SilverCare — OSCA Magalang · ' + scEscapeHtml(title) + '</h1>';
        html += '<p class="meta">Generated: ' + scEscapeHtml(scReportStamp()) + ' · Records: ' + (rows.length - 1) + '</p>';
        html += '<table><thead><tr>';
        rows[0].forEach(h => { html += '<th>' + scEscapeHtml(h) + '</th>'; });
        html += '</tr></thead><tbody>';
        for (let i = 1; i < rows.length; i++) {
            html += '<tr>';
            rows[i].forEach(c => { html += '<td>' + scEscapeHtml(c) + '</td>'; });
            html += '</tr>';
        }
        html += '</tbody></table>';
        html += '<p style="margin-top:18px;color:#64748b;">In the print dialog, choose <strong>Save as PDF</strong> as the destination.</p>';
        html += '</body></html>';
        w.document.write(html);
        w.document.close();
        w.focus();
        setTimeout(() => { try { w.print(); } catch (e) { /* user can print manually */ } }, 400);
        scNotify('success', title + ' opened for printing — choose "Save as PDF".');
    } catch (err) {
        console.error('PDF export error:', err);
        scNotify('error', 'PDF export failed. Please try again.');
    }
};

// Global Report Generation Function
window.generateReport = function(type) {
    if (!window.allUsersData) {
        scNotify('warning', 'No data available to generate report. Please ensure users exist.');
        return;
    }
    
    scNotify('info', `Compiling ${type} report...`);
    
    setTimeout(() => {
        let csvContent = "data:text/csv;charset=utf-8,";
        
        if (type === 'population') {
            csvContent += "Name,Email,Role,Account Status,Life Status,Senior ID\n";
            for (const [uid, user] of Object.entries(window.allUsersData)) {
                if (user.role === 'senior') {
                    csvContent += `"${user.name || ''}","${user.email || ''}","${user.role}","${user.status}","${user.lifeStatus || 'Active'}","${user.seniorId || ''}"\n`;
                }
            }
        } else if (type === 'benefits') {
            csvContent += "Senior ID,Name,Benefit Status,Last Disbursed\n";
            for (const [uid, user] of Object.entries(window.allUsersData)) {
                if (user.role === 'senior') {
                    csvContent += `"${user.seniorId || ''}","${user.name || ''}","Active","${new Date().toLocaleDateString()}"\n`;
                }
            }
        } else if (type === 'health') {
            csvContent += "Senior ID,Name,Health Status,Last Checkup\n";
            for (const [uid, user] of Object.entries(window.allUsersData)) {
                if (user.role === 'senior') {
                    csvContent += `"${user.seniorId || ''}","${user.name || ''}","Stable","N/A"\n`;
                }
            }
        }

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `SilverCare_${type.charAt(0).toUpperCase() + type.slice(1)}_Report.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        scNotify('success', `${type.charAt(0).toUpperCase() + type.slice(1)} Report downloaded successfully!`);
    }, 1500);
};

// ── Senior Priority Level — milestone-based (per OSCA reference: 1-89 Low, 90-99 Medium, 100+ High) ──
// WITH the health-condition override: a reported illness → High priority even when
// the senior's age does not pass the milestone criteria.
function hasReportedIllnessAdmin(user) {
    if (!user) return false;
    const cond = String(user.healthCondition || user.condition || user.illness || user.preExistingConditions || '').trim();
    if (!cond) return false;
    return !/^none$/i.test(cond) && !/^none reported$/i.test(cond) && !/^no illness/i.test(cond) && !/^healthy/i.test(cond);
}

function calculatePriorityLevelAdmin(user) {
    // Illness override — any reported illness → High priority regardless of age
    if (hasReportedIllnessAdmin(user)) return 'High';
    let age = Number(user.age) || 0;
    if (!age && user.dob) {
        const birthDate = new Date(user.dob);
        const today = new Date();
        age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
    }
    // The senior's age determines the category when no illness is reported —
    // a stale stored priorityLevel can never override it:
    //   age <= 89 → Low   |   age 90-99 → Medium   |   age >= 100 → High
    if (age >= 100) return 'High';
    if (age >= 90) return 'Medium';
    return 'Low';
}

window.currentAdminPriorityFilter = 'all';
window.showAllSeniorsAdmin = false;

// ── Audit Trail (admin-only) ─────────────────────────────────────────────────
// Reads the auditLogs node through the admin-only /api/audit-logs endpoint
// (requireRole('admin')) and renders the full system activity trail: who did
// what, to whom, and when — including pension changes (logged with `pension`
// as an INT so exact amounts are auditable). Access is enforced server-side
// and by database.rules.json (auditLogs read = admin only).
let auditLogsCache = [];

function auditFriendlyAction(action) {
    return String(action || 'EVENT').split('_')
        .map(w => (w ? w.charAt(0) + w.slice(1).toLowerCase() : w))
        .join(' ');
}

function auditFormatTs(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
        ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function auditRoleBadge(role) {
    const r = String(role || 'system').toLowerCase();
    const map = {
        admin: ['#eef2ff', '#4338ca'],
        employee: ['#ecfeff', '#0e7490'],
        senior: ['#f0fdf4', '#166534'],
        system: ['#f1f5f9', '#475569']
    };
    const pair = map[r] || map.system;
    return `<span style="background:${pair[0]}; color:${pair[1]}; padding:2px 10px; border-radius:20px; font-weight:700; font-size:0.72rem; text-transform:uppercase;">${scEscapeHtml(r)}</span>`;
}

function auditActionChip(action) {
    const a = String(action || 'EVENT');
    let bg = '#f1f5f9', color = '#334155';
    if (/PENSION/i.test(a)) { bg = '#fef9c3'; color = '#854d0e'; }
    else if (/LOGIN|2FA|PASSWORD/i.test(a)) { bg = '#eef2ff'; color = '#4338ca'; }
    else if (/CLAIM|BENEFIT|BUDGET/i.test(a)) { bg = '#f0fdf4'; color = '#166534'; }
    else if (/REJECT|DECLIN|FAIL|BLOCK|DENIED/i.test(a)) { bg = '#fef2f2'; color = '#b91c1c'; }
    else if (/HEALTH|PRIORITY/i.test(a)) { bg = '#ecfeff'; color = '#0e7490'; }
    return `<span style="background:${bg}; color:${color}; border:1px solid ${color}33; padding:2px 10px; border-radius:4px; font-weight:700; font-size:0.74rem; white-space:nowrap;">${scEscapeHtml(auditFriendlyAction(a))}</span>`;
}

window.loadAdminAuditLogs = async function () {
    const container = document.getElementById('auditTableContainer');
    if (!container) return;
    try {
        const token = await auth.currentUser.getIdToken();
        const limitSel = document.getElementById('auditLimit');
        const limit = limitSel ? limitSel.value : 200;
        const res = await fetch(`/api/audit-logs?limit=${encodeURIComponent(limit)}`, {
            headers: { Authorization: 'Bearer ' + token }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || 'Failed to load audit logs.');
        auditLogsCache = Array.isArray(data.logs) ? data.logs : [];
        renderAuditLogs();
    } catch (err) {
        console.error('Audit trail load error:', err);
        container.innerHTML = `<div style="text-align:center; color:#ef4444; padding:30px;">
            Failed to load the audit trail. <button id="auditRetryBtn"
            style="margin-left:6px; border:1px solid #cbd5e1; background:white; border-radius:6px; padding:6px 14px; cursor:pointer; font-weight:700;">Retry</button></div>`;
        const retry = document.getElementById('auditRetryBtn');
        if (retry) retry.onclick = () => window.loadAdminAuditLogs();
    }
};

function auditFilterLogs() {
    const search = (document.getElementById('auditSearch')?.value || '').toLowerCase().trim();
    const actionFilter = (document.getElementById('auditActionFilter')?.value || 'all');
    return auditLogsCache.filter(l => {
        if (actionFilter !== 'all' && String(l.action || 'EVENT') !== actionFilter) return false;
        if (!search) return true;
        const hay = `${l.actorName || ''} ${l.actorRole || ''} ${l.action || ''} ${l.detail || ''} ${l.targetUid || ''} ${l.docId || ''}`.toLowerCase();
        return hay.includes(search);
    });
}

function renderAuditLogs() {
    const container = document.getElementById('auditTableContainer');
    if (!container) return;

    // Rebuild action filter options from the loaded entries (keeps selection).
    const sel = document.getElementById('auditActionFilter');
    if (sel) {
        const actions = Array.from(new Set(auditLogsCache.map(l => String(l.action || 'EVENT')))).sort();
        const prev = sel.value;
        sel.innerHTML = '<option value="all">All actions</option>' +
            actions.map(a => `<option value="${scEscapeHtml(a)}">${scEscapeHtml(auditFriendlyAction(a))}</option>`).join('');
        if (actions.includes(prev)) sel.value = prev;
        else if (prev && prev !== 'all') sel.value = 'all';
    }

    const filtered = auditFilterLogs();

    const countEl = document.getElementById('auditCount');
    if (countEl) countEl.textContent = `${filtered.length} of ${auditLogsCache.length} entries`;

    if (!filtered.length) {
        container.innerHTML = `<div style="text-align:center; color:#71717a; padding:36px;">
            <i class="fas fa-clipboard-list" style="font-size:2rem; margin-bottom:10px; display:block; opacity:0.4;"></i>
            ${auditLogsCache.length ? 'No audit entries match the selected filters.' : 'No audit entries recorded yet.'}
        </div>`;
        return;
    }

    container.innerHTML = `<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:0.85rem; min-width:900px;">
        <thead>
            <tr style="border-bottom:2px solid #1e293b; color:#52525b; text-align:left;">
                <th style="padding:10px 12px; font-weight:600; white-space:nowrap;">Timestamp</th>
                <th style="padding:10px 12px; font-weight:600;">Actor</th>
                <th style="padding:10px 12px; font-weight:600;">Role</th>
                <th style="padding:10px 12px; font-weight:600;">Action</th>
                <th style="padding:10px 12px; font-weight:600;">Target / Reference</th>
                <th style="padding:10px 12px; font-weight:600;">Details</th>
            </tr>
        </thead>
        <tbody>
            ${filtered.map(auditRowHtml).join('')}
        </tbody>
    </table></div>`;
}

function auditRowHtml(log) {
    const pension = (log.pension !== undefined && log.pension !== null && !isNaN(Number(log.pension))) ? Number(log.pension) : null;
    const pensionChip = pension !== null
        ? ` <span style="background:#fef9c3; color:#854d0e; border:1px solid #fde047; padding:1px 8px; border-radius:4px; font-weight:700; font-size:0.74rem; white-space:nowrap;">Pension: ₱${pension.toLocaleString()}</span>`
        : '';
    const target = log.docId || log.targetUid || '—';
    return `<tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:10px 12px; color:#3f3f46; white-space:nowrap;">${scEscapeHtml(auditFormatTs(log.timestamp))}</td>
        <td style="padding:10px 12px; font-weight:600; color:#1e293b;">${scEscapeHtml(log.actorName || 'Unknown')}</td>
        <td style="padding:10px 12px;">${auditRoleBadge(log.actorRole)}</td>
        <td style="padding:10px 12px;">${auditActionChip(log.action)}${pensionChip}</td>
        <td style="padding:10px 12px; color:#3f3f46; font-family:monospace; font-size:0.78rem; overflow-wrap:anywhere;">${scEscapeHtml(target)}</td>
        <td style="padding:10px 12px; color:#3f3f46;">${scEscapeHtml(log.detail || '—')}</td>
    </tr>`;
}

window.exportAuditCsv = function () {
    try {
        const logs = auditFilterLogs();
        if (!logs.length) {
            scNotify('warning', 'No audit entries to export.');
            return;
        }
        const toCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const rows = [['Timestamp', 'Actor', 'Role', 'Action', 'Pension (int)', 'Target / Reference', 'Details']];
        logs.forEach(l => {
            const pension = (l.pension !== undefined && l.pension !== null && !isNaN(Number(l.pension))) ? Number(l.pension) : '';
            rows.push([auditFormatTs(l.timestamp), l.actorName || 'Unknown', l.actorRole || 'system', l.action || 'EVENT', pension, l.docId || l.targetUid || '', l.detail || '']);
        });
        const csv = rows.map(r => r.map(toCell).join(',')).join('\r\n');
        const d = new Date();
        const fname = `SilverCare_Audit_Trail_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
        scDownloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }), fname);
        scNotify('success', `Audit trail exported (${logs.length} entries).`);
    } catch (err) {
        console.error('Audit CSV export error:', err);
        scNotify('error', 'Export failed. Please try again.');
    }
};

window.printAuditTrail = function () {
    try {
        const logs = auditFilterLogs();
        if (!logs.length) {
            scNotify('warning', 'No audit entries to print.');
            return;
        }
        const w = window.open('', '_blank', 'width=1100,height=750');
        if (!w) {
            scNotify('warning', 'Please allow pop-ups to print the audit trail.');
            return;
        }
        let html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>SilverCare Audit Trail</title>';
        html += '<style>body{font-family:Arial,sans-serif;color:#1e293b;padding:26px;}h1{font-size:19px;margin:0;}p.meta{color:#64748b;font-size:12px;}table{width:100%;border-collapse:collapse;margin-top:14px;font-size:11px;}th{background:#1e293b;color:#fff;padding:7px;border:1px solid #1e293b;text-align:left;}td{padding:6px 7px;border:1px solid #cbd5e1;}</style>';
        html += '</head><body>';
        html += '<h1>SilverCare — OSCA Magalang · Audit Trail</h1>';
        html += `<p class="meta">Generated: ${scEscapeHtml(scReportStamp())} · ${logs.length} entries · Admin access only</p>`;
        html += '<table><thead><tr><th>Timestamp</th><th>Actor</th><th>Role</th><th>Action</th><th>Pension</th><th>Target / Reference</th><th>Details</th></tr></thead><tbody>';
        logs.forEach(l => {
            const pension = (l.pension !== undefined && l.pension !== null && !isNaN(Number(l.pension))) ? '₱' + Number(l.pension).toLocaleString() : '';
            html += `<tr><td>${scEscapeHtml(auditFormatTs(l.timestamp))}</td><td>${scEscapeHtml(l.actorName || 'Unknown')}</td><td>${scEscapeHtml(l.actorRole || 'system')}</td><td>${scEscapeHtml(l.action || 'EVENT')}</td><td>${scEscapeHtml(pension)}</td><td>${scEscapeHtml(l.docId || l.targetUid || '—')}</td><td>${scEscapeHtml(l.detail || '—')}</td></tr>`;
        });
        html += '</tbody></table></body></html>';
        w.document.write(html);
        w.document.close();
        w.focus();
        setTimeout(() => { try { w.print(); } catch (e) { /* user can print manually */ } }, 350);
    } catch (err) {
        console.error('Audit print error:', err);
        scNotify('error', 'Print failed. Please try again.');
    }
};

// Wire the audit trail controls (safe to call — elements exist only on /admin).
(function wireAuditTrailControls() {
    const wire = () => {
        const refresh = document.getElementById('auditRefreshBtn');
        const exportBtn = document.getElementById('auditExportBtn');
        const printBtn = document.getElementById('auditPrintBtn');
        const search = document.getElementById('auditSearch');
        const actionFilter = document.getElementById('auditActionFilter');
        if (refresh) refresh.addEventListener('click', () => window.loadAdminAuditLogs());
        if (exportBtn) exportBtn.addEventListener('click', () => window.exportAuditCsv());
        if (printBtn) printBtn.addEventListener('click', () => window.printAuditTrail());
        if (search) search.addEventListener('input', () => renderAuditLogs());
        if (actionFilter) actionFilter.addEventListener('change', () => renderAuditLogs());
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();

window.toggleAdminSeeAllSeniors = function() {
    window.showAllSeniorsAdmin = !window.showAllSeniorsAdmin;
    const btn = document.getElementById('adminToggleSeeAllBtn');
    if (btn) {
        if (window.showAllSeniorsAdmin) {
            btn.innerHTML = '<i class="fas fa-eye-slash"></i> Close view';
            btn.style.background = '#e2e8f0';
            btn.style.color = '#0f172a';
            btn.style.border = '1px solid #94a3b8';
        } else {
            btn.innerHTML = '<i class="fas fa-eye"></i> See all seniors';
            btn.style.background = '#f8fafc';
            btn.style.color = '#475569';
            btn.style.border = '1px solid #cbd5e1';
        }
    }
    if (window.allUsersData) {
        renderAdminPriorityMonitor(window.allUsersData, window.currentAdminPriorityFilter || 'all');
    }
};

window.filterAdminPriority = function(filterMode, btnEl) {
    window.currentAdminPriorityFilter = filterMode;
    // Reset "see all" state whenever the filter mode changes so the toggle
    // always starts from a collapsed state when returning to 'all'.
    if (filterMode !== 'all') {
        window.showAllSeniorsAdmin = false;
    }
    document.querySelectorAll('.admin-priority-filter-btn').forEach(btn => {
        btn.style.background = '#f8fafc';
        btn.style.color = '#475569';
        btn.style.border = '1px solid #cbd5e1';
    });
    if (btnEl) {
        if (filterMode === 'high') {
            btnEl.style.background = '#dc2626';
            btnEl.style.color = 'white';
            btnEl.style.border = '1px solid #dc2626';
        } else if (filterMode === 'pills') {
            btnEl.style.background = '#1d4ed8';
            btnEl.style.color = 'white';
            btnEl.style.border = '1px solid #1d4ed8';
        }
    }
    if (window.allUsersData) {
        renderAdminPriorityMonitor(window.allUsersData, filterMode);
    }
};

function renderAdminPriorityMonitor(usersData, filterMode = 'all') {
    const container = document.getElementById('adminPriorityMonitorContainer');
    if (!container) return;

    let highCount = 0;
    let activeBenefitsCount = 0;
    let healthRecordsCount = 0;
    let totalSeniorsCount = 0;

    const seniors = [];

    for (const [uid, user] of Object.entries(usersData)) {
        if (user.role !== 'senior') continue;
        totalSeniorsCount++;

        const priority = calculatePriorityLevelAdmin(user);
        if (priority === 'High') highCount++;
        if (user.health || user.medicationRequests) healthRecordsCount++;
        if (user.benefits) activeBenefitsCount += Object.keys(user.benefits).length;

        const pendingReqs = [];
        if (user.medicationRequests) {
            for (const [reqId, req] of Object.entries(user.medicationRequests)) {
                if (!req.status || req.status === 'Pending') {
                    pendingReqs.push({ reqId, ...req });
                }
            }
        }

        let age = user.age || 0;
        if (!age && user.dob) {
            const birthDate = new Date(user.dob);
            const today = new Date();
            age = today.getFullYear() - birthDate.getFullYear();
            const m = today.getMonth() - birthDate.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
        }

        seniors.push({
            uid,
            name: user.name || 'Senior Citizen',
            seniorId: user.seniorId || 'N/A',
            priority,
            age: age || 'N/A',
            healthCondition: user.healthCondition || user.condition || user.preExistingConditions || 'None reported',
            pendingReqs,
            hasHighPriorityPillReq: (priority === 'High' && pendingReqs.length > 0)
        });
    }

    const elTotSeniors = document.getElementById('adminStatTotalSeniors');
    const elActBenefits = document.getElementById('adminStatActiveBenefits');
    const elHealthRecs = document.getElementById('adminStatHealthRecords');
    const elPriorityQueue = document.getElementById('adminStatPriorityQueue');
    if (elTotSeniors) elTotSeniors.textContent = totalSeniorsCount;
    if (elActBenefits) elActBenefits.textContent = activeBenefitsCount;
    if (elHealthRecs) elHealthRecs.textContent = healthRecordsCount;
    if (elPriorityQueue) elPriorityQueue.textContent = highCount;

    let filtered = seniors;
    if (filterMode === 'high') {
        filtered = seniors.filter(s => s.priority === 'High');
    } else if (filterMode === 'pills') {
        filtered = seniors.filter(s => s.pendingReqs.length > 0);
    } else {
        if (!window.showAllSeniorsAdmin) {
            filtered = seniors.filter(s => s.pendingReqs.length > 0 || s.priority === 'High');
        }
    }

    if (filtered.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: #64748b; padding: 30px 0;">
                <i class="fas fa-check-circle" style="font-size: 2rem; color: #22c55e; margin-bottom: 8px; display: block;"></i>
                No urgent priority alerts or pending pill requests at this time.
                <div style="margin-top: 10px;">
                    <button onclick="window.toggleAdminSeeAllSeniors()" style="padding: 6px 16px; border-radius: 20px; background: #2563eb; color: white; border: none; font-weight: 600; font-size: 0.85rem; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
                        <i class="fas fa-eye"></i> See all seniors (${seniors.length})
                    </button>
                </div>
            </div>
        `;
        return;
    }

    filtered.sort((a, b) => {
        if (a.hasHighPriorityPillReq && !b.hasHighPriorityPillReq) return -1;
        if (!a.hasHighPriorityPillReq && b.hasHighPriorityPillReq) return 1;
        const pRank = { 'High': 1, 'Medium': 2, 'Low': 3 };
        if (pRank[a.priority] !== pRank[b.priority]) {
            return pRank[a.priority] - pRank[b.priority];
        }
        return a.name.localeCompare(b.name);
    });

    let tableHtml = `
        <div class="modern-table" style="box-shadow: none; border: none; padding: 0; overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
                <thead>
                    <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                        <th style="padding: 12px; text-align: left; color: #475569; font-size: 0.78rem; text-transform: uppercase;">Senior Name & ID</th>
                        <th style="padding: 12px; text-align: left; color: #475569; font-size: 0.78rem; text-transform: uppercase;">Priority Level</th>
                        <th style="padding: 12px; text-align: left; color: #475569; font-size: 0.78rem; text-transform: uppercase;">Health Condition</th>
                        <th style="padding: 12px; text-align: left; color: #475569; font-size: 0.78rem; text-transform: uppercase;">Requested Pills / Status</th>
                    </tr>
                </thead>
                <tbody>
    `;

    filtered.forEach(s => {
        let badgeBg = '#e0f2fe', badgeColor = '#0369a1';
        if (s.priority === 'High') { badgeBg = '#fee2e2'; badgeColor = '#b91c1c'; }
        else if (s.priority === 'Medium') { badgeBg = '#fef3c7'; badgeColor = '#b45309'; }

        let pillsDisplay = '<span style="color:#94a3b8; font-size:0.85rem;"><i class="fas fa-check-circle" style="color:#22c55e; margin-right:4px;"></i>No pending requests</span>';
        if (s.pendingReqs.length > 0) {
            pillsDisplay = s.pendingReqs.map(r => `
                <div style="background:#fff7ed; border:1px solid #ffedd5; border-radius:6px; padding:6px 10px; margin-bottom:4px; font-size:0.83rem;">
                    <strong style="color:#ea580c;"><i class="fas fa-pills" style="margin-right:4px;"></i>${r.medicationName}</strong>
                    ${r.notes ? `<div style="color:#64748b; font-size:0.78rem;">Note: ${r.notes}</div>` : ''}
                </div>
            `).join('');
        }

        const trBg = s.hasHighPriorityPillReq ? 'background: #fff5f5;' : '';

        tableHtml += `
            <tr style="border-bottom: 1px solid #f1f5f9; ${trBg}">
                <td style="padding: 14px 12px;">
                    <div style="font-weight: 700; color: #1e293b;">${s.name} ${s.hasHighPriorityPillReq ? '<span style="background:#dc2626; color:white; font-size:0.68rem; font-weight:800; padding:2px 6px; border-radius:4px; margin-left:6px;"><i class="fas fa-exclamation-triangle"></i> URGENT REQ</span>' : ''}</div>
                    <div style="font-size: 0.8rem; color: #64748b;">ID: ${s.seniorId} &bull; Age: ${s.age}</div>
                </td>
                <td style="padding: 14px 12px;">
                    <span class="status-badge" style="background: ${badgeBg}; color: ${badgeColor}; font-weight: 700;">
                        ${s.priority} Priority
                    </span>
                </td>
                <td style="padding: 14px 12px; color: #475569; font-size: 0.85rem;">
                    ${s.healthCondition}
                </td>
                <td style="padding: 14px 12px;">
                    ${pillsDisplay}
                </td>
            </tr>
        `;
    });

    tableHtml += `
                </tbody>
            </table>
        </div>
    `;

    if (!window.showAllSeniorsAdmin && seniors.length > filtered.length) {
        const hiddenCount = seniors.length - filtered.length;
        tableHtml += `
            <div style="text-align: center; padding: 15px 0 5px;">
                <button id="adminToggleSeeAllBtn" onclick="window.toggleAdminSeeAllSeniors()" style="padding: 8px 22px; border-radius: 20px; background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; font-weight: 700; font-size: 0.85rem; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 2px 4px rgba(37,99,235,0.08);">
                    <i class="fas fa-eye"></i> See all seniors (${hiddenCount} hidden)
                </button>
            </div>
        `;
    } else if (window.showAllSeniorsAdmin) {
        tableHtml += `
            <div style="text-align: center; padding: 15px 0 5px;">
                <button id="adminToggleSeeAllBtn" onclick="window.toggleAdminSeeAllSeniors()" style="padding: 8px 22px; border-radius: 20px; background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; font-weight: 700; font-size: 0.85rem; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
                    <i class="fas fa-eye-slash"></i> Close view
                </button>
            </div>
        `;
    }

    container.innerHTML = tableHtml;
}
