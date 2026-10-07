let currentConfig = { globalToken: '', globalWebhookUrl: '', servers: [] };
let currentStatus = { status: 'STOPPED', user: null, activeJobsCount: 0, stats: {} };
let activeTab = 'servers';
let isStartingOrStopping = false;
let serverSearchQuery = '';
let serverStatusFilter = 'ALL';
let selectedServerIds = new Set();
let pendingImportData = null;
let desktopNotificationsEnabled = (() => {
    // Migration-aware read (v4.0 rename); the top-level migrator also backfills.
    try {
        const v = localStorage.getItem('croncord_desktop_notifications');
        if (v !== null) return v === 'true';
        const legacy = localStorage.getItem('attendanceBot_desktop_notifications');
        return legacy === 'true';
    } catch (e) { return false; }
})();
let rechartsRoot = null;
let latestDailyData = null;
let currentSessionLogs = [];
let logSearchQuery = '';
let logLevelFilter = 'ALL';
let currentTheme = 'dark'; // resolved post-migration by initTheme()

// --- STORAGE KEY MIGRATION (v4.0 rename: AttendanceBot -> Croncord) ---
// Pre-4.0 installs stored UI prefs under attendancebot*/attendanceBot* keys.
// Copy them forward once so theme, notifications, targets, backups, terminal
// skin and command history survive the rename; all new writes use croncord*.
(function migrateLegacyStorageKeys() {
    try {
        const pairs = [
            ['croncord_theme', ['attendancebot_theme']],
            ['croncord_desktop_notifications', ['attendanceBot_desktop_notifications']],
            ['croncord_daily_target', ['attendancebot_daily_target']],
            ['croncord_local_backup', ['attendancebot_local_backup']],
            ['croncord_autobackup_enabled', ['attendancebot_autobackup_enabled']],
            ['croncord_terminal_skin', ['attendancebot_terminal_skin']],
            ['croncord_cli_history', ['attendancebot_cli_history']],
        ];
        pairs.forEach(([next, legacy]) => {
            if (localStorage.getItem(next) !== null) return;
            for (const old of legacy) {
                const v = localStorage.getItem(old);
                if (v !== null) {
                    localStorage.setItem(next, v);
                    break;
                }
            }
        });
    } catch (e) { /* storage unavailable (private mode) — non-fatal */ }
})();

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initDailyTargetUI();
    initAutoBackupUI();
    fetchConfig();
    fetchStatus();
    fetchDailyCheckinStats();
    loadUpcoming();
    loadCalendar();
    loadHeartbeatUI();
    loadDigestUI();
    loadHolidaysUI();
    loadRestorePointsUI();
    setupLogStream();
    initDesktopNotifications();
    setupKeyboardShortcuts();
    setInterval(fetchStatus, 5000);
    setInterval(loadUpcoming, 30000);
    setInterval(loadCalendar, 60000);
});

// --- TAB SWITCHING ---
function switchTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('border-discord-blurple', 'text-white');
        btn.classList.add('border-transparent', 'text-discord-muted');
    });
    document.querySelectorAll('.tab-content').forEach(sec => sec.classList.add('hidden'));

    const activeBtn = document.getElementById(`tabBtn-${tabId}`);
    const activeSec = document.getElementById(`tab-${tabId}`);
    if (activeBtn) {
        activeBtn.classList.add('border-discord-blurple', 'text-white');
        activeBtn.classList.remove('border-transparent', 'text-discord-muted');
    }
    if (activeSec) {
        activeSec.classList.remove('hidden');
    }

    if (tabId === 'cli') {
        setTimeout(() => {
            const input = document.getElementById('cliTerminalInput');
            if (input) input.focus();
        }, 100);
    }
}

// --- API INTERACTIONS ---
let consecutiveStatusFailures = 0;
let consecutiveConfigFailures = 0;

async function fetchConfig(isRetry = false) {
    try {
        const res = await fetch('/api/config');
        if (!res.ok) {
            consecutiveConfigFailures++;
            return;
        }
        consecutiveConfigFailures = 0;
        currentConfig = await res.json();

        // Populate credentials inputs
        const tokenInput = document.getElementById('inputGlobalToken');
        if (tokenInput && currentConfig.globalToken) {
            tokenInput.value = currentConfig.globalToken;
        }
        const webhookInput = document.getElementById('inputGlobalWebhook');
        if (webhookInput && currentConfig.globalWebhookUrl) {
            webhookInput.value = currentConfig.globalWebhookUrl;
        }

        renderServers();
        updateStats();
        if (typeof loadHolidaysUI === 'function') loadHolidaysUI();
        if (typeof loadRestorePointsUI === 'function') loadRestorePointsUI();
        if (typeof performAutoBackup === 'function' && autoBackupEnabled) {
            performAutoBackup(true);
        }
    } catch (err) {
        consecutiveConfigFailures++;
        console.warn('Croncord config temporarily unavailable (retrying):', err && err.message ? err.message : err);
        if (!isRetry && consecutiveConfigFailures <= 3) {
            setTimeout(() => fetchConfig(true), 1500);
        }
    }
}

function updateGlobalVersionUI(versionStr) {
    if (!versionStr) return;
    const formatted = versionStr.startsWith('v') ? versionStr : `v${versionStr}`;
    document.querySelectorAll('.global-app-version').forEach((el) => {
        el.textContent = formatted;
    });
}

async function fetchStatus(isRetry = false) {
    try {
        const res = await fetch('/api/status');
        if (!res.ok) {
            consecutiveStatusFailures++;
            return;
        }
        consecutiveStatusFailures = 0;
        currentStatus = await res.json();

        if (currentStatus.displayVersion || currentStatus.version) {
            updateGlobalVersionUI(currentStatus.displayVersion || currentStatus.version);
        }

        updateDaemonStatusUI();
        updateStats();

        // Refresh server health UI if cards are mounted
        if (currentStatus.serverHealth) {
            renderServers();
        }

        // Update Recharts line chart data if daily stats exist
        if (currentStatus.dailyStats) {
            updateCheckinChart(currentStatus.dailyStats);
        }
    } catch (err) {
        consecutiveStatusFailures++;
        // Transient network blip, container proxy delay, or server restart
        console.warn('Croncord status temporarily unavailable (retrying):', err && err.message ? err.message : err);
        if (!isRetry && consecutiveStatusFailures <= 3) {
            setTimeout(() => fetchStatus(true), 1500);
        }
    }
}

function updateDaemonStatusUI() {
    const dot = document.getElementById('statusIndicatorDot');
    const text = document.getElementById('statusIndicatorText');
    const btn = document.getElementById('toggleDaemonBtn');
    const btnIcon = document.getElementById('toggleDaemonIcon');
    const btnText = document.getElementById('toggleDaemonText');

    if (!dot || !text || !btn) return;

    if (currentStatus.status === 'RUNNING') {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse';
        text.className = 'text-emerald-400 font-bold';
        text.innerText = currentStatus.user ? `Online (${currentStatus.user.tag})` : 'Online';

        btn.className = 'flex items-center space-x-2 px-4 py-1.5 rounded-lg text-xs font-semibold shadow transition duration-150 bg-rose-600 hover:bg-rose-500 text-white cursor-pointer';
        btnIcon.className = 'fa-solid fa-stop';
        btnText.innerText = 'Stop Daemon';
    } else if (currentStatus.status === 'STARTING') {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping';
        text.className = 'text-amber-400 font-bold';
        text.innerText = 'Connecting Gateway...';

        btn.className = 'flex items-center space-x-2 px-4 py-1.5 rounded-lg text-xs font-semibold shadow transition duration-150 bg-gray-600 text-gray-300 cursor-not-allowed';
        btnIcon.className = 'fa-solid fa-spinner fa-spin';
        btnText.innerText = 'Starting...';
    } else if (currentStatus.status === 'ERROR') {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
        text.className = 'text-rose-400 font-bold';
        text.innerText = 'Error (Check logs)';

        btn.className = 'flex items-center space-x-2 px-4 py-1.5 rounded-lg text-xs font-semibold shadow transition duration-150 bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer';
        btnIcon.className = 'fa-solid fa-play';
        btnText.innerText = 'Retry Start';
    } else {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-gray-400';
        text.className = 'text-gray-300';
        text.innerText = 'Daemon Offline';

        btn.className = 'flex items-center space-x-2 px-4 py-1.5 rounded-lg text-xs font-semibold shadow transition duration-150 bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer';
        btnIcon.className = 'fa-solid fa-play';
        btnText.innerText = 'Start Daemon';
    }

    // Self-heal reconnect indicator (daemon reports retry state in /api/status)
    const rc = currentStatus.reconnect;
    if (rc && (rc.pending || (rc.attempts || 0) > 0) && currentStatus.status !== 'STOPPED') {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse';
        const secs = rc.pending && rc.nextAt ? Math.max(0, Math.ceil((rc.nextAt - Date.now()) / 1000)) : 0;
        text.className = 'text-amber-400 font-bold';
        text.innerText = rc.pending
            ? `Reconnecting (${rc.attempts}/${rc.maxAttempts}, retry in ${secs}s)`
            : `Reconnect tried ${rc.attempts}/${rc.maxAttempts}`;
    }

    // Vacation-mode indicator (config-driven, neutral skips)
    try {
        const vac = (currentConfig && currentConfig.vacation) || null;
        if (vac && vac.until) {
            const t = new Date();
            const todayKey = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
            if (todayKey <= vac.until) {
                text.innerText += `  🏖️ Vacation till ${vac.until}`;
            }
        }
    } catch (e) { /* never break the status badge */ }
}

function updateStats() {
    // Discord Account
    const statAccount = document.getElementById('statAccount');
    const statAccountSub = document.getElementById('statAccountSub');
    if (statAccount) {
        if (currentStatus.user) {
            statAccount.innerText = currentStatus.user.tag;
            statAccountSub.innerText = `ID: ${currentStatus.user.id || 'Connected'}`;
        } else if (currentConfig.globalToken) {
            statAccount.innerText = 'Token Configured';
            statAccountSub.innerText = 'Ready to launch';
        } else {
            statAccount.innerText = 'Not Set';
            statAccountSub.innerText = 'Token required';
        }
    }

    // Servers
    const statServers = document.getElementById('statServers');
    const statServersSub = document.getElementById('statServersSub');
    const totalServers = (currentConfig.servers || []).length;
    const activeServers = (currentConfig.servers || []).filter(s => s.active).length;
    if (statServers) statServers.innerText = activeServers;
    if (statServersSub) statServersSub.innerText = `${totalServers} total profile(s)`;

    // Schedules
    const statSchedules = document.getElementById('statSchedules');
    const statSchedulesSub = document.getElementById('statSchedulesSub');
    let totalScheds = 0;
    let activeScheds = 0;
    (currentConfig.servers || []).forEach(s => {
        (s.schedules || []).forEach(sc => {
            totalScheds++;
            if (s.active && sc.active) activeScheds++;
        });
    });
    if (statSchedules) statSchedules.innerText = activeScheds;
    if (statSchedulesSub) statSchedulesSub.innerText = `${totalScheds} total schedule(s)`;

    // Webhook
    const statWebhook = document.getElementById('statWebhook');
    const statWebhookSub = document.getElementById('statWebhookSub');
    if (statWebhook) {
        if (currentConfig.globalWebhookUrl) {
            statWebhook.innerText = 'Active';
            statWebhookSub.innerText = 'Webhook configured';
        } else {
            statWebhook.innerText = 'Disabled';
            statWebhookSub.innerText = 'Optional notifications';
        }
    }
}

// --- UPCOMING RUNS TIMELINE (v3.9, uses shared escapeHtml below) ---
async function loadUpcoming() {
    const box = document.getElementById('upcomingList');
    if (!box) return;
    try {
        const res = await fetch('/api/schedules/upcoming?count=8');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.success || !data.runs || data.runs.length === 0) {
            box.innerHTML = '<p class="text-discord-muted">No upcoming runs — no active schedules found.</p>';
            return;
        }
        box.innerHTML = data.runs.map((r, i) => {
            const at = new Date(r.at);
            const diffMs = Math.max(0, at.getTime() - Date.now());
            const mins = Math.floor(diffMs / 60000);
            const inStr = mins < 1 ? 'any moment' : (mins < 60 ? `in ${mins}m` : `in ${Math.floor(mins / 60)}h ${mins % 60}m`);
            const flags = [];
            if (r.oneTime) flags.push('<span class="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">ONE-TIME</span>');
            if (r.quiet) flags.push('<span class="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">QUIET-HOURS</span>');
            return `<div class="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-discord-card/60 border border-discord-border/60">
                <div class="min-w-0">
                    <span class="text-discord-muted mono">#${i + 1}</span>
                    <span class="font-semibold text-white">${escapeHtml(r.scheduleLabel)}</span>
                    <span class="text-discord-muted">on ${escapeHtml(r.serverName)}</span>
                    ${flags.join(' ')}
                </div>
                <div class="text-right shrink-0">
                    <div class="text-white font-semibold mono">${escapeHtml(at.toLocaleString())}</div>
                    <div class="text-discord-muted">${escapeHtml(inStr)}</div>
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        box.innerHTML = '<p class="text-discord-muted">Upcoming runs unavailable (server unreachable).</p>';
    }
}

// --- MONTHLY FIRING CALENDAR ---
let calYear = null;
let calMonth = null; // 1-12
let calData = null;

function shiftCalendarMonth(delta) {
    if (calYear === null) {
        const now = new Date();
        calYear = now.getFullYear();
        calMonth = now.getMonth() + 1;
    }
    calMonth += delta;
    while (calMonth < 1) { calMonth += 12; calYear--; }
    while (calMonth > 12) { calMonth -= 12; calYear++; }
    loadCalendar();
}

async function loadCalendar() {
    const grid = document.getElementById('calendarGrid');
    if (!grid) return;
    if (calYear === null) {
        const now = new Date();
        calYear = now.getFullYear();
        calMonth = now.getMonth() + 1;
    }
    const label = document.getElementById('calendarMonthLabel');
    try {
        const res = await fetch(`/api/schedules/calendar?month=${calYear}-${String(calMonth).padStart(2, '0')}`);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error((data && data.error) || `HTTP ${res.status}`);
        calData = data;
        if (label) {
            const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            label.textContent = `${names[data.monthNum - 1]} ${data.year}`;
        }
        const cells = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) =>
            `<div class="text-center text-[10px] font-bold text-discord-muted uppercase py-1">${d}</div>`).join('');
        const blanks = Array.from({ length: data.firstWeekday }, () => '<div></div>').join('');
        const todayKey = (() => {
            const t = new Date();
            return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
        })();
        const dayCells = data.days.map((d) => {
            const dayNum = parseInt(d.date.slice(8, 10), 10);
            const isToday = d.date === todayKey;
            const tip = d.count > 0
                ? `${d.count} run(s): ` + [...new Set(d.runs.map((r) => `${r.scheduleLabel} (${r.serverName})`))].join(', ')
                : 'No firings';
            const cls = d.count > 0
                ? 'bg-violet-500/20 border-violet-500/40 text-white font-bold cursor-pointer hover:bg-violet-500/30'
                : 'bg-discord-card/40 border-discord-border/40 text-discord-muted';
            return `<button onclick="selectCalendarDay('${d.date}')" title="${escapeHtml(tip)}" class="rounded-lg border px-1 py-1.5 text-center transition ${cls} ${isToday ? 'ring-1 ring-indigo-400' : ''}">
                <div class="mono leading-none">${dayNum}</div>
                ${d.count > 0 ? `<div class="text-[10px] leading-none mt-0.5 text-violet-300">●${d.count}</div>` : '<div class="text-[10px] leading-none mt-0.5">&nbsp;</div>'}
            </button>`;
        }).join('');
        grid.innerHTML = cells + blanks + dayCells;
        const detail = document.getElementById('calendarDayDetail');
        if (detail) detail.innerHTML = '';
    } catch (err) {
        grid.innerHTML = '<p class="text-discord-muted col-span-7">Calendar unavailable.</p>';
    }
}

function selectCalendarDay(dateStr) {
    const detail = document.getElementById('calendarDayDetail');
    if (!detail || !calData) return;
    const day = (calData.days || []).find((d) => d.date === dateStr);
    if (!day || day.count === 0) {
        detail.innerHTML = `<p class="text-discord-muted">${escapeHtml(dateStr)} — no firings scheduled.</p>`;
        return;
    }
    detail.innerHTML = `<p class="text-white font-semibold mb-1">${escapeHtml(dateStr)} — ${day.count} run(s):</p>` +
        day.runs.map((r) => {
            const at = new Date(r.at);
            return `<div class="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-discord-card/60 border border-discord-border/60">
                <span><span class="font-semibold text-white">${escapeHtml(r.scheduleLabel)}</span>
                <span class="text-discord-muted">on ${escapeHtml(r.serverName)}</span>
                ${r.quiet ? '<span class="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">QUIET-HOURS</span>' : ''}</span>
                <span class="text-discord-muted mono shrink-0">${escapeHtml(at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>
            </div>`;
        }).join('');
}

// --- WEEKLY DIGEST UI ---
async function loadDigestUI() {
    const statusEl = document.getElementById('digestStatusText');
    const summaryBox = document.getElementById('digestSummaryBox');
    if (!statusEl) return;
    try {
        const res = await fetch('/api/digest');
        const data = await res.json();
        const d = data.digest || {};
        if (d.enabled) {
            statusEl.innerHTML = `Enabled — posts every <span class="text-white font-semibold">${escapeHtml(d.day || 'monday')} at ${escapeHtml(d.time || '09:00')}</span>.`;
            const dayInput = document.getElementById('digestDayInput');
            const timeInput = document.getElementById('digestTimeInput');
            if (dayInput) dayInput.value = d.day || 'monday';
            if (timeInput) timeInput.value = d.time || '09:00';
        } else {
            statusEl.innerText = 'Off — enable a weekly auto-post below.';
        }
        const s = data.summary;
        if (summaryBox && s) {
            summaryBox.innerHTML = `Last 7 days (${escapeHtml(s.from)} → ${escapeHtml(s.to)}): ` +
                `<span class="text-white font-semibold">${s.total} runs</span> · ` +
                `<span class="text-emerald-400">✅ ${s.success}</span> · ` +
                `<span class="text-rose-400">❌ ${s.failed}</span> · ` +
                `<span class="text-amber-300">⏸️ ${s.skipped}</span> · ` +
                `<span class="text-white">${escapeHtml(s.successRate)} success</span>`;
        }
    } catch (err) {
        statusEl.innerText = 'Digest state unavailable.';
    }
}

async function saveDigestUI() {
    const day = ((document.getElementById('digestDayInput') || {}).value || 'monday').toLowerCase();
    const time = ((document.getElementById('digestTimeInput') || {}).value || '09:00');
    try {
        const res = await fetch('/api/digest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true, day, time }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast(`Weekly digest enabled: ${day} at ${time}.`, 'success');
            await loadDigestUI();
        } else {
            showNotificationToast(data.error || 'Failed to enable digest.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error: ${err.message}`, 'danger');
    }
}

async function testDigestUI() {
    try {
        const res = await fetch('/api/digest/test', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast('Digest posted — check your webhook channel.', 'success');
        } else {
            showNotificationToast(data.error || data.message || 'Digest failed.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error: ${err.message}`, 'danger');
    }
}

async function clearDigestUI() {
    try {
        const res = await fetch('/api/digest', { method: 'DELETE' });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast('Weekly digest disabled.', 'success');
            await loadDigestUI();
        } else {
            showNotificationToast(data.error || 'Failed to disable.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error: ${err.message}`, 'danger');
    }
}

// --- HEARTBEAT MONITOR UI ---
async function loadHeartbeatUI() {
    const statusEl = document.getElementById('heartbeatStatusText');
    if (!statusEl) return;
    try {
        const res = await fetch('/api/heartbeat');
        const data = await res.json();
        const hb = data.heartbeat;
        if (hb && hb.url) {
            const urlInput = document.getElementById('heartbeatUrlInput');
            const minInput = document.getElementById('heartbeatMinutesInput');
            if (urlInput && !urlInput.value) urlInput.value = hb.url;
            if (minInput) minInput.value = hb.intervalMinutes || 15;
            const last = data.state && data.state.lastPingAt
                ? `Last ping: <span class="text-white mono">${escapeHtml(new Date(data.state.lastPingAt).toLocaleString())}</span> (${escapeHtml(data.state.lastStatus || '')})`
                : 'No pings sent yet.';
            statusEl.innerHTML = `Armed: <span class="text-white font-semibold mono">${escapeHtml(hb.url)}</span> every ${hb.intervalMinutes || 15}m. ${last}`;
        } else {
            statusEl.innerText = 'Off — no heartbeat URL configured.';
        }
    } catch (err) {
        statusEl.innerText = 'Heartbeat state unavailable.';
    }
}

async function saveHeartbeatUI() {
    const url = ((document.getElementById('heartbeatUrlInput') || {}).value || '').trim();
    const minutes = parseInt(((document.getElementById('heartbeatMinutesInput') || {}).value || '15'), 10) || 15;
    if (!url) {
        showNotificationToast('Enter a heartbeat URL first.', 'warning');
        return;
    }
    try {
        const res = await fetch('/api/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, intervalMinutes: minutes }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast(`Heartbeat armed: every ${minutes}m.`, 'success');
            await loadHeartbeatUI();
        } else {
            showNotificationToast(data.error || 'Failed to save heartbeat.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error saving heartbeat: ${err.message}`, 'danger');
    }
}

async function testHeartbeatUI() {
    try {
        const url = ((document.getElementById('heartbeatUrlInput') || {}).value || '').trim();
        const res = await fetch('/api/heartbeat/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(url ? { url } : {}),
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast(`Test ping delivered (HTTP ${data.statusCode}).`, 'success');
            await loadHeartbeatUI();
        } else {
            showNotificationToast(data.error || 'Test ping failed.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error pinging: ${err.message}`, 'danger');
    }
}

async function clearHeartbeatUI() {
    try {
        const res = await fetch('/api/heartbeat', { method: 'DELETE' });
        const data = await res.json();
        if (res.ok && data.success) {
            const urlInput = document.getElementById('heartbeatUrlInput');
            if (urlInput) urlInput.value = '';
            showNotificationToast('Heartbeat disarmed.', 'success');
            await loadHeartbeatUI();
        } else {
            showNotificationToast(data.error || 'Failed to disarm.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error: ${err.message}`, 'danger');
    }
}

// --- HOLIDAYS & QUIET HOURS UI (v3.9) ---
async function loadHolidaysUI() {
    const list = document.getElementById('holidaysList');
    if (!list) return;
    try {
        const res = await fetch('/api/holidays');
        const data = await res.json();
        const holidays = data.holidays || [];
        if (holidays.length === 0) {
            list.innerHTML = '<p class="text-discord-muted">No holidays configured — runs fire every scheduled day.</p>';
        } else {
            list.innerHTML = holidays.map((h) => `
                <div class="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-discord-card/60 border border-discord-border/60">
                    <span><span class="text-white font-semibold mono">${escapeHtml(h.date)}</span> <span class="text-discord-muted">— ${escapeHtml(h.name)}</span></span>
                    <button onclick="removeHolidayUI('${escapeHtml(h.date)}')" class="text-rose-400 hover:text-rose-300 text-xs cursor-pointer" title="Remove holiday">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>`).join('');
        }
    } catch (err) {
        list.innerHTML = '<p class="text-discord-muted">Holidays unavailable.</p>';
    }

    await loadVacationUI();

    try {
        const qres = await fetch('/api/quiet');
        const qdata = await qres.json();
        const cur = document.getElementById('quietCurrentText');
        const qs = document.getElementById('quietStartInput');
        const qe = document.getElementById('quietEndInput');
        if (qdata.global) {
            if (cur) cur.innerHTML = `Active window: <span class="text-white font-semibold mono">${escapeHtml(qdata.global.start)}–${escapeHtml(qdata.global.end)}</span> (plus ${(qdata.perServer || []).length} server override(s))`;
            if (qs) qs.value = qdata.global.start || '';
            if (qe) qe.value = qdata.global.end || '';
        } else if (cur) {
            cur.innerText = 'Not set — runs fire at their scheduled times.';
        }
    } catch (err) { /* quiet display is best-effort */ }
}

async function addHolidayUI() {
    const dateEl = document.getElementById('holidayDateInput');
    const nameEl = document.getElementById('holidayNameInput');
    const date = (dateEl && dateEl.value) || '';
    const name = (nameEl && nameEl.value.trim()) || '';
    if (!date || !name) {
        showNotificationToast('Pick a date and enter a holiday name.', 'warning');
        return;
    }
    try {
        const res = await fetch('/api/holidays', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, name }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast(`Holiday added: ${date} — ${name}.`, 'success');
            if (dateEl) dateEl.value = '';
            if (nameEl) nameEl.value = '';
            await loadHolidaysUI();
        } else {
            showNotificationToast(data.error || 'Failed to add holiday.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error adding holiday: ${err.message}`, 'danger');
    }
}

async function removeHolidayUI(date) {
    try {
        const res = await fetch(`/api/holidays/${encodeURIComponent(date)}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast(`Holiday on ${date} removed.`, 'success');
            await loadHolidaysUI();
        } else {
            showNotificationToast(data.error || 'Failed to remove holiday.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error removing holiday: ${err.message}`, 'danger');
    }
}

async function saveQuietUI() {
    const start = (document.getElementById('quietStartInput') || {}).value || '';
    const end = (document.getElementById('quietEndInput') || {}).value || '';
    if (!start || !end) {
        showNotificationToast('Enter both window start and end (HH:MM).', 'warning');
        return;
    }
    try {
        const res = await fetch('/api/quiet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start, end }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast(`Quiet hours saved: ${start}–${end}.`, 'success');
            await loadHolidaysUI();
        } else {
            showNotificationToast(data.error || 'Failed to save quiet hours.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error saving quiet hours: ${err.message}`, 'danger');
    }
}

async function clearQuietUI() {
    try {
        const res = await fetch('/api/quiet', { method: 'DELETE' });
        const data = await res.json();
        if (res.ok && data.success) {
            const qs = document.getElementById('quietStartInput');
            const qe = document.getElementById('quietEndInput');
            if (qs) qs.value = '';
            if (qe) qe.value = '';
            showNotificationToast('Quiet hours cleared everywhere.', 'success');
            await loadHolidaysUI();
        } else {
            showNotificationToast(data.error || 'Failed to clear quiet hours.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error clearing quiet hours: ${err.message}`, 'danger');
    }
}

// --- VACATION MODE UI ---
async function loadVacationUI() {
    const statusEl = document.getElementById('vacationStatusText');
    if (!statusEl) return;
    try {
        const res = await fetch('/api/vacation');
        const data = await res.json();
        if (data.active) {
            statusEl.innerHTML = `Armed until <span class="text-white font-semibold mono">${escapeHtml(data.until)}</span>${data.note ? ` — ${escapeHtml(data.note)}` : ''} <span class="text-amber-300">(auto-resumes after)</span>`;
            const untilInput = document.getElementById('vacationUntilInput');
            if (untilInput && !untilInput.value) untilInput.value = data.until;
        } else {
            statusEl.innerText = 'Off — schedules fire normally.';
        }
    } catch (err) {
        statusEl.innerText = 'Vacation state unavailable.';
    }
}

async function armVacationUI() {
    const until = ((document.getElementById('vacationUntilInput') || {}).value || '').trim();
    const note = ((document.getElementById('vacationNoteInput') || {}).value || '').trim();
    if (!until) {
        showNotificationToast('Pick an end date (YYYY-MM-DD) for the vacation.', 'warning');
        return;
    }
    try {
        const res = await fetch('/api/vacation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ until, note }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast(`Vacation armed until ${until}.`, 'success');
            await loadVacationUI();
            await loadUpcoming();
        } else {
            showNotificationToast(data.error || 'Failed to arm vacation.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error arming vacation: ${err.message}`, 'danger');
    }
}

async function cancelVacationUI() {
    try {
        const res = await fetch('/api/vacation', { method: 'DELETE' });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast('Vacation cancelled — schedules resumed.', 'success');
            await loadVacationUI();
            await loadUpcoming();
        } else {
            showNotificationToast(data.error || 'Failed to cancel vacation.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error cancelling vacation: ${err.message}`, 'danger');
    }
}

// --- SERVER-SIDE RESTORE POINTS UI (v3.9) ---
async function loadRestorePointsUI() {
    const box = document.getElementById('restorePointsList');
    if (!box) return;
    try {
        const res = await fetch('/api/config/backups');
        const data = await res.json();
        const snaps = data.backups || [];
        if (snaps.length === 0) {
            box.innerHTML = '<p class="text-discord-muted">No server restore points yet — one is saved before every change.</p>';
            return;
        }
        box.innerHTML = snaps.map((s, i) => `
            <div class="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-discord-card/60 border border-discord-border/60">
                <span class="min-w-0"><span class="text-discord-muted mono">#${i + 1}</span>
                <span class="text-white mono truncate">${escapeHtml(s.file)}</span>
                <span class="text-discord-muted">${(s.size / 1024).toFixed(1)} KB</span></span>
                <button onclick="restorePointUI('${escapeHtml(s.file)}')" class="px-2.5 py-1 rounded-md text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white transition cursor-pointer shrink-0">Restore</button>
            </div>`).join('');
    } catch (err) {
        box.innerHTML = '<p class="text-discord-muted">Restore points unavailable.</p>';
    }
}

async function restorePointUI(file) {
    const confirmed = await showConfirmDialog({
        title: 'Restore Configuration',
        message: `Roll back to server restore point "${file}"? A pre-restore snapshot is saved first, so this is reversible.`,
        details: [{ label: 'Restore Point', value: file }],
        icon: 'fa-solid fa-rotate-left',
        iconColor: 'emerald',
        confirmText: 'Restore',
        confirmClass: 'bg-emerald-600 hover:bg-emerald-500 text-white',
        cancelText: 'Cancel'
    });
    if (!confirmed) return;
    try {
        const res = await fetch('/api/config/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast(`Restored from "${file}".`, 'success');
            await fetchConfig();
            await fetchStatus();
            await loadRestorePointsUI();
            await loadHolidaysUI();
        } else {
            showNotificationToast(data.error || 'Restore failed.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error restoring: ${err.message}`, 'danger');
    }
}

async function toggleDaemon() {
    if (isStartingOrStopping) return;
    isStartingOrStopping = true;

    try {
        if (currentStatus.status === 'RUNNING') {
            await fetch('/api/daemon/stop', { method: 'POST' });
        } else {
            const res = await fetch('/api/daemon/start', { method: 'POST' });
            const data = await res.json();
            if (!data.success && data.message) {
                alert(`Cannot start daemon: ${data.message}`);
            }
        }
        await fetchStatus();
    } catch (err) {
        alert(`Daemon action failed: ${err.message}`);
    } finally {
        isStartingOrStopping = false;
    }
}

// --- CREDENTIALS MANAGEMENT ---
function toggleTokenVisibility() {
    const input = document.getElementById('inputGlobalToken');
    const icon = document.getElementById('tokenEyeIcon');
    if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'fa-regular fa-eye-slash';
    } else {
        input.type = 'password';
        icon.className = 'fa-regular fa-eye';
    }
}

async function saveCredentialsSettings() {
    const token = document.getElementById('inputGlobalToken').value;
    const webhook = document.getElementById('inputGlobalWebhook').value;

    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                globalToken: token,
                globalWebhookUrl: webhook,
            }),
        });
        const data = await res.json();
        if (data.success) {
            const notice = document.getElementById('credentialsSaveNotice');
            notice.classList.remove('hidden');
            setTimeout(() => notice.classList.add('hidden'), 3500);
            await fetchConfig();
            await fetchStatus();
        } else {
            alert('Failed to save configuration');
        }
    } catch (err) {
        alert(`Error saving credentials: ${err.message}`);
    }
}

async function testGlobalWebhook() {
    const webhook = document.getElementById('inputGlobalWebhook').value;
    if (!webhook || !webhook.trim()) {
        alert('Please enter a Discord Webhook URL first.');
        return;
    }

    try {
        const res = await fetch('/api/test-webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ webhookUrl: webhook }),
        });
        const data = await res.json();
        if (data.success) {
            alert('✅ Webhook test passed! Notification was sent to Discord.');
        } else {
            alert(`❌ Webhook test failed: ${data.message || 'Check URL'}`);
        }
    } catch (err) {
        alert(`Webhook test error: ${err.message}`);
    }
}

function triggerTestWebhookModal() {
    switchTab('credentials');
    testGlobalWebhook();
}

// --- 30-DAY ATTENDANCE CHECK-INS (RECHARTS INTEGRATION) ---
async function fetchDailyCheckinStats() {
    const refreshIcon = document.getElementById('refreshChartIcon');
    if (refreshIcon) refreshIcon.classList.add('fa-spin');

    try {
        const res = await fetch('/api/stats/daily-checkins');
        if (!res.ok) return;
        const statsData = await res.json();
        updateCheckinChart(statsData);
    } catch (err) {
        console.warn('Croncord daily stats temporarily unavailable:', err && err.message ? err.message : err);
    } finally {
        if (refreshIcon) refreshIcon.classList.remove('fa-spin');
    }
}

function refreshCheckinStats() {
    fetchDailyCheckinStats();
}

function updateCheckinChart(statsData) {
    if (!statsData || !Array.isArray(statsData.daily)) return;

    // Update 30-day metric badges in header
    const totalEl = document.getElementById('chartTotalCheckins');
    const successEl = document.getElementById('chartTotalSuccess');
    const failedEl = document.getElementById('chartTotalFailed');
    const rateEl = document.getElementById('chartSuccessRate');
    const avgEl = document.getElementById('chartAvgDaily');
    const peakEl = document.getElementById('chartPeakDay');

    if (statsData.summary) {
        const total = statsData.summary.totalCheckins ?? 0;
        if (totalEl) totalEl.innerText = total;
        if (successEl) successEl.innerText = statsData.summary.totalSuccess ?? '0';
        if (failedEl) failedEl.innerText = statsData.summary.totalFailed ?? '0';
        if (rateEl) rateEl.innerText = total > 0 ? (statsData.summary.successRate ?? '100%') : '0%';
        if (avgEl) avgEl.innerText = `${statsData.summary.avgDaily ?? '0.0'}/d`;
        if (peakEl) peakEl.innerText = total > 0 ? (statsData.summary.peakDay ?? 'None') : 'No runs yet';
    }

    renderRechartsCheckins(statsData.daily);
    updateDailyTargetProgress(statsData.daily);
}

function renderRechartsCheckins(dailyData) {
    if (dailyData) latestDailyData = dailyData;
    const container = document.getElementById('rechartsOverviewContainer');
    if (!container) return;

    const isLight = document.documentElement.classList.contains('light');

    // If there is zero real attendance data recorded, render a clean, informative zero-state
    const totalCheckinsCount = (dailyData || []).reduce((acc, d) => acc + (d.checkins || 0), 0);
    if (totalCheckinsCount === 0) {
        if (rechartsRoot) {
            try {
                if (rechartsRoot.unmount) rechartsRoot.unmount();
            } catch (e) {}
            rechartsRoot = null;
        }
        container.innerHTML = `
            <div class="h-full flex flex-col items-center justify-center text-center p-6 border-2 border-dashed ${isLight ? 'border-slate-200 bg-slate-50/70' : 'border-discord-border/60 bg-discord-card/30'} rounded-xl select-none">
                <div class="w-12 h-12 rounded-xl flex items-center justify-center ${isLight ? 'bg-indigo-50 text-discord-blurple' : 'bg-discord-card text-discord-blurple'} mb-3 shadow-sm text-lg">
                    <i class="fa-solid fa-chart-line"></i>
                </div>
                <h4 class="text-sm font-bold ${isLight ? 'text-slate-800' : 'text-white'} mb-1">No Attendance History Recorded Yet</h4>
                <p class="text-xs ${isLight ? 'text-slate-500' : 'text-discord-muted'} max-w-md leading-relaxed">
                    Live metrics and 30-day reliability graphs will render here automatically as real attendance events execute via scheduled cron routines or manual check-in triggers.
                </p>
                <div class="mt-4 flex items-center gap-2">
                    <button onclick="switchTab('servers')" class="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-discord-blurple hover:bg-indigo-600 text-white transition shadow-sm cursor-pointer flex items-center gap-1.5">
                        <i class="fa-solid fa-server"></i>
                        <span>Configure Server Schedules</span>
                    </button>
                    <button onclick="switchTab('cli')" class="px-3.5 py-1.5 text-xs font-semibold rounded-lg ${isLight ? 'bg-slate-200 hover:bg-slate-300 text-slate-800' : 'bg-discord-card hover:bg-discord-border text-discord-text'} transition shadow-sm cursor-pointer flex items-center gap-1.5">
                        <i class="fa-solid fa-terminal"></i>
                        <span>Open CLI Terminal</span>
                    </button>
                </div>
            </div>
        `;
        return;
    }

    // Check if React and Recharts are loaded from UMD scripts
    if (!window.React || !window.ReactDOM || !window.Recharts) {
        setTimeout(() => renderRechartsCheckins(dailyData), 250);
        return;
    }

    const { createElement: h } = window.React;
    const {
        ResponsiveContainer,
        LineChart,
        Line,
        XAxis,
        YAxis,
        CartesianGrid,
        Tooltip,
        Legend
    } = window.Recharts;

    // Custom theme-aware tooltip
    const CustomTooltip = (props) => {
        const { active, payload } = props;
        if (!active || !payload || !payload.length) return null;
        const item = payload[0].payload;
        const tooltipBg = isLight
            ? 'bg-white border border-slate-200 p-3 rounded-xl shadow-xl text-xs space-y-1.5 font-sans min-w-[170px]'
            : 'bg-[#1e1f22] border border-[#383a40] p-3 rounded-xl shadow-2xl text-xs space-y-1.5 font-sans min-w-[170px]';
        const titleClass = isLight ? 'font-bold text-slate-900' : 'font-bold text-white';
        const dividerClass = isLight ? 'border-b border-slate-200 pb-1.5' : 'border-b border-[#383a40]/70 pb-1.5';

        const successColor = isLight ? 'text-emerald-700' : 'text-emerald-400';
        const failedColor = isLight ? 'text-rose-700' : 'text-rose-400';
        const totalColor = isLight ? 'text-indigo-600' : 'text-indigo-400';

        return h('div', { className: tooltipBg }, [
            h('div', { key: 'h', className: `flex items-center justify-between gap-3 ${dividerClass}` }, [
                h('span', { key: 'hl', className: titleClass }, `${item.label} (${item.weekday})`),
                h('span', { key: 'ht', className: `${totalColor} font-mono font-bold` }, `${item.checkins} run${item.checkins === 1 ? '' : 's'}`)
            ]),
            h('div', { key: 's', className: `flex items-center justify-between ${successColor} font-medium` }, [
                h('span', { key: 'sl', className: 'flex items-center gap-1.5' }, [
                    h('span', { key: 'dot', className: 'w-2 h-2 rounded-full bg-emerald-500' }),
                    'Successful'
                ]),
                h('span', { key: 'sv', className: 'font-mono font-bold' }, item.success)
            ]),
            h('div', { key: 'f', className: `flex items-center justify-between ${failedColor} font-medium` }, [
                h('span', { key: 'fl', className: 'flex items-center gap-1.5' }, [
                    h('span', { key: 'fdot', className: 'w-2 h-2 rounded-full bg-rose-500' }),
                    'Failed'
                ]),
                h('span', { key: 'fv', className: 'font-mono font-bold' }, item.failed)
            ]),
            h('div', { key: 'r', className: `flex items-center justify-between text-[11px] pt-1 border-t ${isLight ? 'border-slate-100 text-slate-500' : 'border-white/5 text-gray-400'}` }, [
                h('span', { key: 'rl' }, 'Reliability:'),
                h('span', { key: 'rv', className: 'font-mono font-bold text-discord-text' }, item.checkins > 0 ? `${((item.success / item.checkins) * 100).toFixed(0)}%` : '100%')
            ])
        ]);
    };

    const chartComponent = h(ResponsiveContainer, { width: '100%', height: '100%' },
        h(LineChart, {
            data: dailyData,
            margin: { top: 12, right: 18, left: -22, bottom: 4 }
        }, [
            h(CartesianGrid, {
                key: 'grid',
                strokeDasharray: '3 3',
                stroke: isLight ? '#e2e8f0' : '#383a40',
                strokeOpacity: isLight ? 0.9 : 0.5
            }),
            h(XAxis, {
                key: 'xaxis',
                dataKey: 'label',
                stroke: isLight ? '#64748b' : '#949ba4',
                fontSize: 11,
                tickLine: false,
                interval: 2
            }),
            h(YAxis, {
                key: 'yaxis',
                stroke: isLight ? '#64748b' : '#949ba4',
                fontSize: 11,
                tickLine: false,
                allowDecimals: false
            }),
            h(Tooltip, {
                key: 'tooltip',
                content: h(CustomTooltip)
            }),
            h(Legend, {
                key: 'legend',
                verticalAlign: 'top',
                height: 28,
                wrapperStyle: { fontSize: '11px', color: isLight ? '#334155' : '#dbdee1' }
            }),
            h(Line, {
                key: 'lineSuccess',
                type: 'monotone',
                dataKey: 'success',
                name: 'Successful Attempts',
                stroke: isLight ? '#059669' : '#57F287',
                strokeWidth: 2.5,
                dot: { r: 2.5, fill: isLight ? '#059669' : '#57F287', strokeWidth: 0 },
                activeDot: { r: 5, fill: isLight ? '#059669' : '#57F287', stroke: '#ffffff', strokeWidth: 2 }
            }),
            h(Line, {
                key: 'lineFailed',
                type: 'monotone',
                dataKey: 'failed',
                name: 'Failed Attempts',
                stroke: isLight ? '#dc2626' : '#ED4245',
                strokeWidth: 2.5,
                dot: { r: 2.5, fill: isLight ? '#dc2626' : '#ED4245', strokeWidth: 0 },
                activeDot: { r: 5, fill: isLight ? '#dc2626' : '#ED4245', stroke: '#ffffff', strokeWidth: 2 }
            }),
            h(Line, {
                key: 'lineTotal',
                type: 'monotone',
                dataKey: 'checkins',
                name: 'Total Dispatches',
                stroke: isLight ? '#6366f1' : '#5865F2',
                strokeWidth: 1.5,
                strokeDasharray: '4 4',
                dot: false,
                activeDot: { r: 4.5, fill: isLight ? '#6366f1' : '#5865F2' }
            })
        ])
    );

    try {
        if (!rechartsRoot) {
            container.innerHTML = '';
            if (window.ReactDOM.createRoot) {
                rechartsRoot = window.ReactDOM.createRoot(container);
                rechartsRoot.render(chartComponent);
            } else if (window.ReactDOM.render) {
                window.ReactDOM.render(chartComponent, container);
            }
        } else {
            rechartsRoot.render(chartComponent);
        }
    } catch (err) {
        console.warn('Notice mounting Recharts element:', err && err.message ? err.message : err);
    }
}

// --- DAILY TARGET FEATURE ---
let dailyTargetGoal = parseInt(localStorage.getItem('croncord_daily_target') || localStorage.getItem('attendancebot_daily_target') || '10', 10);
if (isNaN(dailyTargetGoal) || dailyTargetGoal < 1) dailyTargetGoal = 10;

function initDailyTargetUI() {
    const input = document.getElementById('dailyTargetInput');
    if (input) input.value = dailyTargetGoal;
    const goalEl = document.getElementById('dailyTargetGoal');
    if (goalEl) goalEl.innerText = dailyTargetGoal;
}

function handleDailyTargetChange(val) {
    let parsed = parseInt(val, 10);
    if (isNaN(parsed) || parsed < 1) parsed = 1;
    if (parsed > 500) parsed = 500;
    dailyTargetGoal = parsed;
    try {
        localStorage.setItem('croncord_daily_target', String(dailyTargetGoal));
    } catch (e) {}
    initDailyTargetUI();
    if (latestDailyData) {
        updateDailyTargetProgress(latestDailyData);
    }
    showNotificationToast(`Daily target set to ${dailyTargetGoal} check-ins`, 'success');
}

function promptCustomDailyTarget() {
    const current = dailyTargetGoal;
    const answer = prompt('Enter your daily attendance check-in target (1 - 500):', current);
    if (answer !== null) {
        handleDailyTargetChange(answer);
    }
}

function updateDailyTargetProgress(dailyList) {
    if (!Array.isArray(dailyList) || dailyList.length === 0) return;
    const today = dailyList[dailyList.length - 1];
    const checkins = today ? (today.checkins || 0) : 0;
    const success = today ? (today.success || 0) : 0;
    const dateLabel = today ? today.label : 'Today';

    const currentEl = document.getElementById('dailyTargetCurrent');
    const goalEl = document.getElementById('dailyTargetGoal');
    const percentEl = document.getElementById('dailyTargetPercent');
    const barEl = document.getElementById('dailyTargetProgressBar');
    const badgeEl = document.getElementById('dailyTargetBadge');
    const badgeTextEl = document.getElementById('dailyTargetBadgeText');
    const remainingEl = document.getElementById('dailyTargetRemainingText');
    const dateTextEl = document.getElementById('dailyTargetDateText');

    if (currentEl) currentEl.innerText = checkins;
    if (goalEl) goalEl.innerText = dailyTargetGoal;
    if (dateTextEl) dateTextEl.innerText = `Today: ${dateLabel}`;

    const percentage = Math.round((checkins / dailyTargetGoal) * 100);
    const clampedWidth = Math.min(100, percentage);

    if (percentEl) percentEl.innerText = `${percentage}%`;
    if (barEl) {
        barEl.style.width = `${clampedWidth}%`;
        if (checkins >= dailyTargetGoal) {
            barEl.className = 'h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-400 transition-all duration-500 ease-out shadow-[0_0_12px_rgba(16,185,129,0.35)]';
        } else {
            barEl.className = 'h-full rounded-full bg-gradient-to-r from-discord-blurple to-indigo-500 transition-all duration-500 ease-out';
        }
    }

    if (checkins >= dailyTargetGoal) {
        if (badgeEl) {
            badgeEl.className = 'text-xs px-2.5 py-0.5 rounded-full font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 inline-flex items-center gap-1.5';
        }
        if (badgeTextEl) badgeTextEl.innerText = 'Goal Achieved! 🎉';
        if (remainingEl) remainingEl.innerHTML = `<span class="text-emerald-400 font-semibold">Goal accomplished today!</span> (${checkins} check-ins performed with ${success} successful dispatches).`;
    } else {
        const needed = dailyTargetGoal - checkins;
        if (badgeEl) {
            badgeEl.className = 'text-xs px-2.5 py-0.5 rounded-full font-bold bg-indigo-500/15 text-indigo-400 border border-indigo-500/30 inline-flex items-center gap-1.5';
        }
        if (badgeTextEl) badgeTextEl.innerText = 'In Progress';
        if (remainingEl) remainingEl.innerText = `${needed} more check-in${needed === 1 ? '' : 's'} needed to reach today's target (${success} successful so far).`;
    }
}

// --- LOCAL AUTO-BACKUP & RESTORE ---
const BACKUP_STORAGE_KEY = 'croncord_local_backup';
const AUTOBACKUP_ENABLED_KEY = 'croncord_autobackup_enabled';
let autoBackupEnabled = localStorage.getItem(AUTOBACKUP_ENABLED_KEY) !== 'false'; // default true

function initAutoBackupUI() {
    const toggle = document.getElementById('autoBackupToggle');
    if (toggle) toggle.checked = autoBackupEnabled;
    updateAutoBackupStatusUI();

    // Schedule periodic backup every 60 seconds
    setInterval(() => {
        if (autoBackupEnabled) {
            performAutoBackup(true);
        }
    }, 60000);
}

function handleAutoBackupToggle(isChecked) {
    autoBackupEnabled = Boolean(isChecked);
    try {
        localStorage.setItem(AUTOBACKUP_ENABLED_KEY, String(autoBackupEnabled));
    } catch (e) {}
    updateAutoBackupStatusUI();
    if (autoBackupEnabled) {
        performAutoBackup(false);
        showNotificationToast('Local Auto-Backup enabled (every 60s)', 'success');
    } else {
        showNotificationToast('Local Auto-Backup paused', 'info');
    }
}

function updateAutoBackupStatusUI() {
    const badge = document.getElementById('autoBackupStatusBadge');
    const lastTimeEl = document.getElementById('lastAutoBackupTime');
    const countEl = document.getElementById('backedUpServerCount');

    if (badge) {
        if (autoBackupEnabled) {
            badge.className = 'text-xs px-2.5 py-0.5 rounded-full font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 inline-flex items-center gap-1.5';
            badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span><span>Active (Auto-save every 60s)</span>';
        } else {
            badge.className = 'text-xs px-2.5 py-0.5 rounded-full font-semibold bg-zinc-700/25 text-zinc-400 border border-zinc-600/30 inline-flex items-center gap-1.5';
            badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-zinc-500"></span><span>Auto-Backup Paused</span>';
        }
    }

    const savedRaw = localStorage.getItem(BACKUP_STORAGE_KEY);
    if (savedRaw) {
        try {
            const saved = JSON.parse(savedRaw);
            if (lastTimeEl && saved.timestamp) {
                const dt = new Date(saved.timestamp);
                lastTimeEl.innerText = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' (' + dt.toLocaleDateString() + ')';
            }
            if (countEl && saved.serverCount !== undefined) {
                countEl.innerText = `${saved.serverCount} server(s) / ${saved.scheduleCount || 0} schedule(s)`;
            }
        } catch (e) {}
    } else {
        if (lastTimeEl) lastTimeEl.innerText = 'Not saved yet';
        if (countEl) countEl.innerText = '0 servers / 0 schedules';
    }
}

function performAutoBackup(silent = false) {
    if (!currentConfig || !Array.isArray(currentConfig.servers)) return;

    let schedCount = 0;
    currentConfig.servers.forEach(s => {
        if (Array.isArray(s.schedules)) schedCount += s.schedules.length;
    });

    const snapshot = {
            app: 'Croncord',
        timestamp: new Date().toISOString(),
        serverCount: currentConfig.servers.length,
        scheduleCount: schedCount,
        config: {
            globalToken: currentConfig.globalToken || '',
            globalWebhookUrl: currentConfig.globalWebhookUrl || '',
            servers: currentConfig.servers || []
        }
    };

    try {
        localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(snapshot));
        updateAutoBackupStatusUI();
        if (!silent) {
            showNotificationToast(`Auto-backup saved (${currentConfig.servers.length} servers snapshot)`, 'success');
        }
    } catch (err) {
        console.warn('Failed to save auto-backup to localStorage:', err);
    }
}

function triggerManualBackup() {
    performAutoBackup(false);
    showNotificationToast('Configuration snapshot backed up to localStorage!', 'success');
}

function downloadConfigBackupJson() {
    if (!currentConfig) return;

    let totalSchedules = 0;
    (currentConfig.servers || []).forEach(s => {
        if (Array.isArray(s.schedules)) totalSchedules += s.schedules.length;
    });

    const exportData = {
            app: 'Croncord',
        version: '3.2.0',
        exportedAt: new Date().toISOString(),
        serverCount: (currentConfig.servers || []).length,
        scheduleCount: totalSchedules,
        globalWebhookUrl: currentConfig.globalWebhookUrl || '',
        servers: currentConfig.servers || []
    };

    const jsonStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStamp = new Date().toISOString().slice(0, 10);
    a.download = `croncord-config-backup-${dateStamp}.json`;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 250);

    showNotificationToast('Configuration downloaded as JSON file.', 'success');
}

async function restoreFromLocalBackup() {
    const raw = localStorage.getItem(BACKUP_STORAGE_KEY);
    if (!raw) {
        showNotificationToast('No local auto-backup snapshot found in browser storage.', 'warning');
        return;
    }

    let backup;
    try {
        backup = JSON.parse(raw);
    } catch (e) {
        showNotificationToast('Local backup data is corrupted.', 'danger');
        return;
    }

    const dateStr = backup.timestamp ? new Date(backup.timestamp).toLocaleString() : 'Unknown date';
    const serverCount = backup.serverCount || (backup.config && backup.config.servers ? backup.config.servers.length : 0);

    const confirmed = await showConfirmDialog({
        title: 'Restore Configuration Snapshot',
        message: 'Restore your server profiles and schedules from the local browser auto-backup?',
        details: [
            { label: 'Snapshot Time', value: dateStr },
            { label: 'Included Servers', value: `${serverCount} server profile(s)` },
            { label: 'Action', value: 'Overwrites current session configuration' }
        ],
        icon: 'fa-solid fa-cloud-arrow-down',
        iconColor: 'indigo',
        confirmText: 'Restore Backup',
        confirmClass: 'bg-discord-blurple hover:bg-indigo-600 text-white',
        cancelText: 'Cancel'
    });
    if (!confirmed) return;

    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(backup.config)
        });
        const data = await res.json();
        if (data.success) {
            await fetchConfig();
            await fetchStatus();
            showNotificationToast(`Restored ${serverCount} servers from local backup!`, 'success');
        } else {
            alert(`Failed to restore backup: ${data.error || 'Server error'}`);
        }
    } catch (err) {
        alert(`Error restoring backup: ${err.message}`);
    }
}

// --- BROWSER NOTIFICATIONS & LOCAL SYSTEM ALERTS ---
function initDesktopNotifications() {
    updateNotificationButtonUI();
}

function updateNotificationButtonUI() {
    const btn = document.getElementById('desktopNotificationBtn');
    const icon = document.getElementById('desktopNotificationIcon');
    const text = document.getElementById('desktopNotificationText');
    const badge = document.getElementById('desktopNotificationBadge');
    if (!btn || !icon) return;

    if (!('Notification' in window)) {
        btn.classList.add('opacity-50', 'cursor-not-allowed');
        btn.title = 'Desktop notifications are not supported by this browser';
        if (text) text.innerText = 'Alerts Unsupported';
        if (badge) badge.className = 'w-2 h-2 rounded-full bg-gray-500';
        return;
    }

    if (Notification.permission === 'granted') {
        if (desktopNotificationsEnabled) {
            btn.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 transition cursor-pointer';
            icon.className = 'fa-solid fa-bell text-emerald-400';
            if (text) text.innerText = 'Alerts Active';
            if (badge) badge.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
            btn.title = 'Desktop system alerts enabled for task completions. Click to pause.';
        } else {
            btn.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-discord-card hover:bg-discord-border text-discord-muted border border-discord-border transition cursor-pointer';
            icon.className = 'fa-regular fa-bell-slash text-gray-400';
            if (text) text.innerText = 'Alerts Paused';
            if (badge) badge.className = 'w-2 h-2 rounded-full bg-amber-400';
            btn.title = 'Desktop alerts paused. Click to resume notifications.';
        }
    } else if (Notification.permission === 'denied') {
        btn.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition cursor-pointer';
        icon.className = 'fa-solid fa-bell-slash text-rose-400';
        if (text) text.innerText = 'Alerts Blocked';
        if (badge) badge.className = 'w-2 h-2 rounded-full bg-rose-500';
        btn.title = 'Notifications blocked in browser settings. Please permit notifications in your browser.';
    } else {
        // 'default' (not requested yet)
        btn.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-discord-card hover:bg-discord-border text-discord-text border border-discord-border transition cursor-pointer';
        icon.className = 'fa-solid fa-bell text-discord-blurple';
        if (text) text.innerText = 'Enable Alerts';
        if (badge) badge.className = 'w-2 h-2 rounded-full bg-indigo-400';
        btn.title = 'Request browser notification permission to get system alerts on successful tasks';
    }
}

async function toggleDesktopNotifications() {
    if (!('Notification' in window)) {
        alert('Desktop notifications are not supported in this browser.');
        return;
    }

    if (Notification.permission === 'default') {
        try {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                desktopNotificationsEnabled = true;
                localStorage.setItem('croncord_desktop_notifications', 'true');
                triggerLocalSystemAlert({
                    title: '⚡ Croncord Alerts Active',
                    body: 'You will receive local desktop alerts whenever an attendance task completes successfully!'
                });
                showNotificationToast('Desktop notifications enabled successfully!', 'success');
            } else {
                desktopNotificationsEnabled = false;
                localStorage.setItem('croncord_desktop_notifications', 'false');
                showNotificationToast('Notification permission was not granted.', 'warning');
            }
        } catch (err) {
            console.warn('Notice requesting notification permission:', err && err.message ? err.message : err);
        }
    } else if (Notification.permission === 'granted') {
        desktopNotificationsEnabled = !desktopNotificationsEnabled;
        localStorage.setItem('croncord_desktop_notifications', desktopNotificationsEnabled ? 'true' : 'false');
        if (desktopNotificationsEnabled) {
            triggerLocalSystemAlert({
                title: '⚡ Croncord Alerts Resumed',
                body: 'System notifications are active for scheduled attendance tasks.'
            });
            showNotificationToast('Desktop alerts enabled.', 'success');
        } else {
            showNotificationToast('Desktop alerts paused.', 'info');
        }
    } else if (Notification.permission === 'denied') {
        alert('Notification permission is blocked in your browser settings. To enable local system alerts, please permit notifications for this origin in your browser settings or URL bar lock icon.');
    }

    updateNotificationButtonUI();
}

function triggerLocalSystemAlert({ title, body, icon }) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!desktopNotificationsEnabled) return;

    try {
        const notif = new Notification(title || '⚡ Attendance Completed', {
            body: body || 'Attendance task executed successfully.',
            tag: 'croncord-exec-' + Date.now(),
            icon: icon || 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/26a1.png',
            silent: false
        });

        setTimeout(() => {
            try { notif.close(); } catch (e) {}
        }, 7000);
    } catch (e) {
        console.warn('Could not dispatch local system notification:', e);
    }
}

// --- GLOBAL KEYBOARD SHORTCUTS ---
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const isModifier = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        const activeElem = document.activeElement;
        const isTyping = activeElem && (
            activeElem.tagName === 'INPUT' ||
            activeElem.tagName === 'TEXTAREA' ||
            activeElem.isContentEditable
        );

        // Escape: Close any open modal dialog
        if (e.key === 'Escape') {
            closeAllOpenModals();
            return;
        }

        // Help Modal: ? or Ctrl+/ (when not actively editing text)
        if ((key === '?' || (isModifier && (e.key === '/' || e.key === '?'))) && !isTyping) {
            e.preventDefault();
            toggleShortcutsModal();
            return;
        }

        // Ctrl+S / Cmd+S: Save Settings or Save Current Open Modal
        if (isModifier && key === 's') {
            e.preventDefault();
            handleGlobalSaveShortcut();
            return;
        }

        // Ctrl+N / Cmd+N or Alt+N: Add New Server Profile
        if ((isModifier && key === 'n') || (e.altKey && key === 'n')) {
            e.preventDefault();
            openAddServerModal();
            return;
        }

        // Ctrl+B: Toggle Daemon Background Worker
        if (isModifier && key === 'b') {
            e.preventDefault();
            toggleDaemon();
            return;
        }

        // Alt+T or Ctrl+Shift+T: Toggle Dark / Light Theme
        if ((e.altKey && key === 't') || (isModifier && e.shiftKey && key === 't')) {
            e.preventDefault();
            toggleTheme();
            return;
        }

        // Ctrl+F or / (when not typing): Focus Server Search Input
        if ((isModifier && key === 'f') || (e.key === '/' && !isTyping)) {
            e.preventDefault();
            switchTab('servers');
            const searchInput = document.getElementById('serverSearchInput');
            if (searchInput) {
                searchInput.focus();
                searchInput.select();
            }
            return;
        }

        // Ctrl + 1..4: Quick Switch Tabs
        if (isModifier && ['1', '2', '3', '4'].includes(e.key)) {
            e.preventDefault();
            const tabMap = { '1': 'servers', '2': 'credentials', '3': 'logs', '4': 'guide' };
            switchTab(tabMap[e.key]);
            return;
        }
    });
}

function handleGlobalSaveShortcut() {
    // 1. If Server Modal is open, submit it
    const serverModal = document.getElementById('serverModal');
    if (serverModal && !serverModal.classList.contains('hidden')) {
        saveServer();
        return;
    }

    // 2. If Schedule Modal is open, submit it
    const scheduleModal = document.getElementById('scheduleModal');
    if (scheduleModal && !scheduleModal.classList.contains('hidden')) {
        saveSchedule();
        return;
    }

    // 3. If Import Modal is open, confirm import
    const importModal = document.getElementById('importModal');
    if (importModal && !importModal.classList.contains('hidden')) {
        confirmImportConfig();
        return;
    }

    // 4. If on Credentials Tab, save credentials
    if (activeTab === 'credentials') {
        saveCredentials();
        return;
    }

    // Default feedback
    showNotificationToast('Settings are saved and synced.', 'info');
}

function closeAllOpenModals() {
    closeServerModal();
    closeScheduleModal();
    closeImportModal();
    closeShortcutsModal();
    closeStatusLegendModal();
    const testModal = document.getElementById('testWebhookModal');
    if (testModal) testModal.classList.add('hidden');
}

function openStatusLegendModal() {
    const modal = document.getElementById('statusLegendModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
}

function closeStatusLegendModal() {
    const modal = document.getElementById('statusLegendModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

function toggleStatusLegendModal() {
    const modal = document.getElementById('statusLegendModal');
    if (!modal) return;
    if (modal.classList.contains('hidden')) {
        openStatusLegendModal();
    } else {
        closeStatusLegendModal();
    }
}

function openShortcutsModal() {
    const modal = document.getElementById('shortcutsModal');
    if (modal) modal.classList.remove('hidden');
}

function closeShortcutsModal() {
    const modal = document.getElementById('shortcutsModal');
    if (modal) modal.classList.add('hidden');
}

function toggleShortcutsModal() {
    const modal = document.getElementById('shortcutsModal');
    if (!modal) return;
    if (modal.classList.contains('hidden')) {
        openShortcutsModal();
    } else {
        closeShortcutsModal();
    }
}

function showNotificationToast(message, type = 'info') {
    const existing = document.getElementById('appGlobalToast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'appGlobalToast';
    let bg = 'bg-discord-card border-discord-border text-white';
    let icon = 'fa-solid fa-circle-info text-discord-blurple';
    if (type === 'success') {
        bg = 'bg-emerald-950/90 border-emerald-500/40 text-emerald-200';
        icon = 'fa-solid fa-circle-check text-emerald-400';
    } else if (type === 'warning') {
        bg = 'bg-amber-950/90 border-amber-500/40 text-amber-200';
        icon = 'fa-solid fa-triangle-exclamation text-amber-400';
    }

    toast.className = `fixed bottom-5 right-5 z-50 flex items-center space-x-2.5 px-4 py-2.5 rounded-xl border ${bg} shadow-2xl text-xs backdrop-blur transition-all duration-300 transform translate-y-0 opacity-100`;
    toast.innerHTML = `<i class="${icon}"></i><span>${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2');
        setTimeout(() => toast.remove(), 350);
    }, 3200);
}

// --- SCHEDULE OVERLAP & CONFLICT DETECTION (< 5-MIN WINDOW) ---
function parseCronDaysAndMinutes(cronStr, sched) {
    if (!cronStr) return null;
    const parts = cronStr.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const minutePart = parts[0];
    const hourPart = parts[1];
    const dowPart = parts[4];

    // parse hours
    let hours = [];
    if (hourPart === '*') {
        hours = Array.from({ length: 24 }, (_, i) => i);
    } else if (hourPart.includes(',')) {
        hours = hourPart.split(',').map(Number).filter(n => !isNaN(n));
    } else {
        const h = parseInt(hourPart, 10);
        if (!isNaN(h)) hours = [h];
    }

    // parse minutes
    let minutes = [];
    if (minutePart === '*') {
        minutes = [0];
    } else if (minutePart.includes(',')) {
        minutes = minutePart.split(',').map(Number).filter(n => !isNaN(n));
    } else {
        const m = parseInt(minutePart, 10);
        if (!isNaN(m)) minutes = [m];
    }

    if (hours.length === 0 || minutes.length === 0) return null;

    // Days of week: 0-6 (0=Sun, 1=Mon, ..., 6=Sat)
    const daysOfWeek = new Set();
    if (dowPart === '*') {
        [0, 1, 2, 3, 4, 5, 6].forEach(d => daysOfWeek.add(d));
    } else if (dowPart === '1-5') {
        [1, 2, 3, 4, 5].forEach(d => daysOfWeek.add(d));
    } else if (dowPart === '0,6' || dowPart === '6,0') {
        [0, 6].forEach(d => daysOfWeek.add(d));
    } else if (dowPart.includes(',')) {
        dowPart.split(',').forEach(d => {
            const num = parseInt(d, 10);
            if (!isNaN(num)) daysOfWeek.add(num % 7);
        });
    } else if (dowPart.includes('-')) {
        const [start, end] = dowPart.split('-').map(Number);
        if (!isNaN(start) && !isNaN(end)) {
            for (let i = start; i <= end; i++) daysOfWeek.add(i % 7);
        }
    } else {
        const d = parseInt(dowPart, 10);
        if (!isNaN(d)) daysOfWeek.add(d % 7);
    }

    // Handle one-time schedule
    const isOnce = sched && sched.type === 'ONCE';
    let onceDate = null;
    let onceDateStr = null;
    if (isOnce && sched.runDate) {
        onceDate = new Date(sched.runDate);
        if (!isNaN(onceDate.getTime())) {
            daysOfWeek.clear();
            daysOfWeek.add(onceDate.getDay());
            onceDateStr = sched.runDate;
        }
    }

    const timesInDay = [];
    hours.forEach(h => {
        minutes.forEach(m => {
            timesInDay.push(h * 60 + m);
        });
    });

    return {
        hours,
        minutes,
        daysOfWeek,
        timesInDay,
        isOnce,
        onceDateStr
    };
}

function formatMinutesToTime(totalMinutes) {
    const hours24 = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    const ampm = hours24 >= 12 ? 'PM' : 'AM';
    const hours12 = hours24 % 12 || 12;
    const padMin = String(minutes).padStart(2, '0');
    return `${String(hours12).padStart(2, '0')}:${padMin} ${ampm}`;
}

function checkSchedulesConflict(schedA, schedB) {
    const parsedA = parseCronDaysAndMinutes(schedA.cron, schedA);
    const parsedB = parseCronDaysAndMinutes(schedB.cron, schedB);
    if (!parsedA || !parsedB) return null;

    // If both are one-time, they must be targeting the same date
    if (parsedA.isOnce && parsedB.isOnce) {
        if (parsedA.onceDateStr && parsedB.onceDateStr && parsedA.onceDateStr !== parsedB.onceDateStr) {
            return null;
        }
    }

    // Check day-of-week overlap
    let hasOverlappingDay = false;
    for (const day of parsedA.daysOfWeek) {
        if (parsedB.daysOfWeek.has(day)) {
            hasOverlappingDay = true;
            break;
        }
    }
    if (!hasOverlappingDay) return null;

    // Check closest circular time difference (in minutes within 24h)
    let minDiff = Infinity;
    let bestPair = null;

    for (const tA of parsedA.timesInDay) {
        for (const tB of parsedB.timesInDay) {
            const rawDiff = Math.abs(tA - tB);
            const circularDiff = Math.min(rawDiff, 1440 - rawDiff);
            if (circularDiff < minDiff) {
                minDiff = circularDiff;
                bestPair = { tA, tB };
            }
        }
    }

    // Warning triggers if within 5 minutes of each other
    if (minDiff <= 5 && bestPair) {
        return {
            schedA,
            schedB,
            diffMinutes: minDiff,
            timeAStr: formatMinutesToTime(bestPair.tA),
            timeBStr: formatMinutesToTime(bestPair.tB)
        };
    }
    return null;
}

function analyzeServerScheduleConflicts(server) {
    const schedules = server.schedules || [];
    if (schedules.length < 2) {
        return { hasConflict: false, conflicts: [], conflictingScheduleIds: new Set() };
    }

    const conflicts = [];
    const conflictingScheduleIds = new Set();

    for (let i = 0; i < schedules.length; i++) {
        for (let j = i + 1; j < schedules.length; j++) {
            const schedA = schedules[i];
            const schedB = schedules[j];
            const conflict = checkSchedulesConflict(schedA, schedB);
            if (conflict) {
                conflicts.push(conflict);
                conflictingScheduleIds.add(String(schedA.id));
                conflictingScheduleIds.add(String(schedB.id));
            }
        }
    }

    return {
        hasConflict: conflicts.length > 0,
        conflicts,
        conflictingScheduleIds
    };
}

// --- SEARCH & STATUS FILTER LOGIC ---
function handleServerSearch(query) {
    serverSearchQuery = (query || '').trim();
    const clearBtn = document.getElementById('clearSearchBtn');
    if (clearBtn) {
        if (serverSearchQuery.length > 0) {
            clearBtn.classList.remove('hidden');
        } else {
            clearBtn.classList.add('hidden');
        }
    }
    renderServers();
}

function clearServerSearch() {
    serverSearchQuery = '';
    const input = document.getElementById('serverSearchInput');
    if (input) input.value = '';
    const clearBtn = document.getElementById('clearSearchBtn');
    if (clearBtn) clearBtn.classList.add('hidden');
    renderServers();
}

function handleServerStatusFilter(val) {
    serverStatusFilter = val || 'ALL';
    renderServers();
}

function getFilteredServers() {
    const allServers = currentConfig.servers || [];
    const q = (serverSearchQuery || '').trim().toLowerCase();

    return allServers.filter(server => {
        // Status filter matching
        if (serverStatusFilter !== 'ALL') {
            const serverHealth = (currentStatus.serverHealth && currentStatus.serverHealth[server.id]) || null;
            let health = 'RUNNING';
            if (!server.active) {
                health = 'DISABLED';
            } else if (serverHealth && serverHealth.health === 'FAILED') {
                health = 'FAILED';
            } else if (serverHealth && serverHealth.health) {
                health = serverHealth.health;
            }
            if (health !== serverStatusFilter) return false;
        }

        // Search query matching
        if (!q) return true;
        const nameMatch = (server.name || '').toLowerCase().includes(q);
        const channelMatch = (server.channelId || '').toLowerCase().includes(q);
        return nameMatch || channelMatch;
    });
}

// --- BULK SELECTION & ACTIONS LOGIC ---
function toggleServerSelection(serverId, isChecked) {
    const idStr = String(serverId);
    if (isChecked) {
        selectedServerIds.add(idStr);
    } else {
        selectedServerIds.delete(idStr);
    }
    updateBulkSelectionUI();
}

function toggleSelectAllServers(isChecked) {
    const visibleServers = getFilteredServers();
    if (isChecked) {
        visibleServers.forEach(s => selectedServerIds.add(String(s.id)));
    } else {
        visibleServers.forEach(s => selectedServerIds.delete(String(s.id)));
    }
    renderServers();
    updateBulkSelectionUI();
}

function clearServerSelection() {
    selectedServerIds.clear();
    renderServers();
    updateBulkSelectionUI();
}

function updateBulkSelectionUI() {
    const visibleServers = getFilteredServers();
    const selectAllCheckbox = document.getElementById('selectAllServersCheckbox');
    const bulkActionButtons = document.getElementById('bulkActionButtons');
    const bulkSelectedBadge = document.getElementById('bulkSelectedBadge');
    const count = selectedServerIds.size;

    if (selectAllCheckbox) {
        if (visibleServers.length > 0 && visibleServers.every(s => selectedServerIds.has(String(s.id)))) {
            selectAllCheckbox.checked = true;
            selectAllCheckbox.indeterminate = false;
        } else if (visibleServers.some(s => selectedServerIds.has(String(s.id)))) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = true;
        } else {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        }
    }

    if (bulkActionButtons && bulkSelectedBadge) {
        if (count > 0) {
            bulkActionButtons.classList.remove('hidden');
            bulkActionButtons.classList.add('flex');
            bulkSelectedBadge.classList.remove('hidden');
            bulkSelectedBadge.innerText = `${count} selected`;
        } else {
            bulkActionButtons.classList.add('hidden');
            bulkActionButtons.classList.remove('flex');
            bulkSelectedBadge.classList.add('hidden');
        }
    }
}

async function bulkSetServersActive(active) {
    if (selectedServerIds.size === 0) {
        showNotificationToast('No servers selected.', 'warning');
        return;
    }
    const serverIds = Array.from(selectedServerIds);
    const action = active ? 'enable' : 'disable';

    try {
        const res = await fetch('/api/servers/bulk-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, serverIds })
        });
        const data = await res.json();
        if (data.success) {
            showNotificationToast(`Bulk ${active ? 'enabled' : 'disabled'} ${data.count} server(s).`, 'success');
            await fetchConfig();
            await fetchStatus();
            clearServerSelection();
        } else {
            alert(`Bulk action failed: ${data.error || 'Unknown error'}`);
        }
    } catch (err) {
        alert(`Error executing bulk action: ${err.message}`);
    }
}

async function bulkDeleteSelectedServers() {
    if (selectedServerIds.size === 0) {
        showNotificationToast('No servers selected.', 'warning');
        return;
    }
    const count = selectedServerIds.size;
    const names = [];
    selectedServerIds.forEach(id => {
        const s = (currentConfig.servers || []).find(srv => String(srv.id) === String(id));
        if (s) names.push(s.name);
    });

    const confirmed = await showConfirmDialog({
        title: `Delete ${count} Server Profile${count === 1 ? '' : 's'}`,
        message: `Are you sure you want to permanently delete the ${count} selected server profile${count === 1 ? '' : 's'} and all associated routines?`,
        details: [
            { label: 'Selected Profiles', value: `${count} server profile(s)` },
            { label: 'Servers', value: names.slice(0, 3).join(', ') + (names.length > 3 ? ` + ${names.length - 3} more` : '') },
            { label: 'Action', value: 'Permanent removal & daemon watcher teardown' }
        ],
        icon: 'fa-solid fa-trash-can',
        iconColor: 'rose',
        confirmText: `Delete ${count} Server${count === 1 ? '' : 's'}`,
        confirmClass: 'bg-rose-600 hover:bg-rose-500 text-white',
        cancelText: 'Cancel'
    });

    if (!confirmed) return;

    const serverIds = Array.from(selectedServerIds);
    try {
        const res = await fetch('/api/servers/bulk-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', serverIds })
        });
        const data = await res.json();
        if (data.success) {
            showNotificationToast(`Successfully deleted ${data.count} server profile(s).`, 'success');
            clearServerSelection();
            await fetchConfig();
            await fetchStatus();
        } else {
            showNotificationToast(`Bulk delete failed: ${data.error || 'Unknown error'}`, 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error executing bulk delete: ${err.message}`, 'danger');
    }
}

// --- BULK TOGGLE MONITORING STATUS ---
async function toggleAllServers(active) {
    const allServers = currentConfig.servers || [];
    if (allServers.length === 0) {
        alert('No configured servers found to toggle.');
        return;
    }

    const actionText = active ? 'enable' : 'pause';
    const serverCount = allServers.length;

    try {
        const res = await fetch('/api/servers/toggle-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: Boolean(active) })
        });

        const data = await res.json();
        if (data.success) {
            currentConfig.servers.forEach(s => {
                s.active = Boolean(active);
            });
            renderServers();
            updateStats();
        } else {
            alert(`Failed to update servers: ${data.error || 'Unknown error'}`);
        }
    } catch (err) {
        alert(`Error toggling servers: ${err.message}`);
    }
}

// --- EXPORT & IMPORT CONFIGURATION ---
function exportConfigJSON() {
    const servers = currentConfig.servers || [];
    if (servers.length === 0) {
        alert('There are no server profiles configured to export.');
        return;
    }

    const exportData = {
            app: 'Croncord',
        version: '3.2.0',
        exportedAt: new Date().toISOString(),
        globalWebhookUrl: currentConfig.globalWebhookUrl || '',
        servers: servers
    };

    const jsonStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `croncord-servers-config-${dateStamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function triggerImportConfig() {
    const input = document.getElementById('importFileInput');
    if (input) {
        input.value = '';
        input.click();
    }
}

function renderImportValidationErrors(errors) {
    const errContainer = document.getElementById('importValidationErrors');
    const errList = document.getElementById('importValidationErrorsList');
    const errCount = document.getElementById('importValidationErrorsCount');
    if (errContainer && errList) {
        errList.innerHTML = '';
        errors.forEach(err => {
            const li = document.createElement('li');
            li.textContent = err;
            errList.appendChild(li);
        });
        if (errCount) {
            errCount.innerText = `Invalid Schema Structure (${errors.length} error${errors.length > 1 ? 's' : ''})`;
        }
        errContainer.classList.remove('hidden');
    }
}

function renderImportModalState(fileName, validation, rawData) {
    const fileNameEl = document.getElementById('importFileName');
    const serverCountEl = document.getElementById('importServerCount');
    const schedCountEl = document.getElementById('importScheduleCount');
    const statusBanner = document.getElementById('importValidationStatus');
    const statusIcon = document.getElementById('importValidationIcon');
    const statusTitle = document.getElementById('importValidationTitle');
    const statusDesc = document.getElementById('importValidationDesc');
    const errContainer = document.getElementById('importValidationErrors');
    const errList = document.getElementById('importValidationErrorsList');
    const errCount = document.getElementById('importValidationErrorsCount');
    const warnContainer = document.getElementById('importValidationWarnings');
    const warnList = document.getElementById('importValidationWarningsList');
    const confirmBtn = document.getElementById('confirmImportBtn');
    const modeContainer = document.getElementById('importModeContainer');
    const webhookNotice = document.getElementById('importWebhookNotice');

    if (fileNameEl) fileNameEl.innerText = fileName || '-';

    const srvCount = validation.stats ? validation.stats.serverCount : 0;
    const scCount = validation.stats ? validation.stats.scheduleCount : 0;
    if (serverCountEl) serverCountEl.innerText = srvCount;
    if (schedCountEl) schedCountEl.innerText = scCount;

    if (validation.isValid) {
        // Valid state
        if (statusBanner) {
            statusBanner.className = 'p-3 rounded-lg border flex items-start space-x-2.5 bg-emerald-500/10 border-emerald-500/20 text-emerald-300';
        }
        if (statusIcon) {
            statusIcon.className = 'fa-solid fa-circle-check text-emerald-400 text-sm mt-0.5';
        }
        if (statusTitle) {
            statusTitle.className = 'font-bold block text-xs text-emerald-300';
            statusTitle.innerText = 'Schema Verification Passed';
        }
        if (statusDesc) {
            statusDesc.innerText = `All ${srvCount} server profile(s) and ${scCount} schedule(s) conform to the Croncord configuration specification.`;
        }

        if (errContainer) errContainer.classList.add('hidden');

        // Warnings
        if (warnContainer && warnList) {
            if (validation.warnings && validation.warnings.length > 0) {
                warnList.innerHTML = '';
                validation.warnings.forEach(w => {
                    const li = document.createElement('li');
                    li.textContent = w;
                    warnList.appendChild(li);
                });
                warnContainer.classList.remove('hidden');
            } else {
                warnContainer.classList.add('hidden');
            }
        }

        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerText = 'Confirm & Apply Import';
            confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
        if (modeContainer) modeContainer.classList.remove('opacity-50', 'pointer-events-none');
    } else {
        // Invalid state
        if (statusBanner) {
            statusBanner.className = 'p-3 rounded-lg border flex items-start space-x-2.5 bg-rose-500/10 border-rose-500/25 text-rose-300';
        }
        if (statusIcon) {
            statusIcon.className = 'fa-solid fa-circle-xmark text-rose-400 text-sm mt-0.5';
        }
        if (statusTitle) {
            statusTitle.className = 'font-bold block text-xs text-rose-300';
            statusTitle.innerText = 'Schema Verification Failed';
        }
        if (statusDesc) {
            statusDesc.innerText = 'The uploaded file does not conform to the required JSON schema structure.';
        }

        renderImportValidationErrors(validation.errors || ['Invalid structure detected.']);

        if (warnContainer) warnContainer.classList.add('hidden');

        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.innerText = 'Resolve Schema Errors to Import';
            confirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }
        if (modeContainer) modeContainer.classList.add('opacity-50', 'pointer-events-none');
    }

    // Check webhook notice
    if (webhookNotice) {
        const hasWebhook = (rawData && rawData.globalWebhookUrl) || (validation.sanitized && validation.sanitized.globalWebhookUrl);
        if (hasWebhook) {
            webhookNotice.classList.remove('hidden');
        } else {
            webhookNotice.classList.add('hidden');
        }
    }
}

function handleConfigFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        let parsed;
        try {
            parsed = JSON.parse(e.target.result);
        } catch (err) {
            showNotificationToast(`Could not parse JSON configuration file: ${err.message}`, 'error');
            return;
        }

        let validationResult = null;
        try {
            const res = await fetch('/api/config/validate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(parsed)
            });
            if (res.ok) {
                validationResult = await res.json();
            } else {
                const errData = await res.json();
                validationResult = {
                    isValid: false,
                    errors: errData.errors || [errData.error || 'Server rejected configuration'],
                    warnings: errData.warnings || [],
                    stats: { serverCount: 0, scheduleCount: 0 }
                };
            }
        } catch (err) {
            validationResult = {
                isValid: false,
                errors: [`Validation service unavailable: ${err.message}`],
                warnings: [],
                stats: { serverCount: 0, scheduleCount: 0 }
            };
        }

        pendingImportData = {
            fileName: file.name,
            rawPayload: parsed,
            validation: validationResult
        };

        renderImportModalState(file.name, validationResult, parsed);

        const modal = document.getElementById('importModal');
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }
    };
    reader.readAsText(file);
}

function closeImportModal() {
    const modal = document.getElementById('importModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    pendingImportData = null;
}

async function confirmImportConfig() {
    if (!pendingImportData || !pendingImportData.validation || !pendingImportData.validation.isValid) {
        showNotificationToast('Cannot import: JSON schema validation errors must be resolved.', 'warning');
        return;
    }

    const modeInput = document.querySelector('input[name="importMode"]:checked');
    const mode = modeInput ? modeInput.value : 'merge';

    const confirmBtn = document.getElementById('confirmImportBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Importing...';
    }

    try {
        const res = await fetch('/api/config/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...pendingImportData.rawPayload,
                mode: mode,
            })
        });

        const data = await res.json();
        if (data.success) {
            closeImportModal();
            await fetchConfig();
            await fetchStatus();
            showNotificationToast(`Successfully imported ${data.count} server profile(s) (${mode === 'merge' ? 'Merged' : 'Replaced'}).`, 'success');
        } else {
            showNotificationToast(`Import failed: ${data.error || 'Schema validation rejected'}`, 'error');
            if (data.errors && data.errors.length > 0) {
                renderImportValidationErrors(data.errors);
            }
        }
    } catch (err) {
        showNotificationToast(`Error importing configuration: ${err.message}`, 'error');
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerText = 'Confirm & Apply Import';
        }
    }
}

// Helper to calculate human-readable uptime tracking time since last successful check-in
function formatUptimeDuration(timestamp) {
    if (!timestamp) return null;
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    if (isNaN(then)) return null;

    const diffMs = Math.max(0, now - then);
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return '< 1m ago';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) {
        const remMins = diffMins % 60;
        return remMins > 0 ? `${diffHours}h ${remMins}m ago` : `${diffHours}h ago`;
    }
    const remHours = diffHours % 24;
    return remHours > 0 ? `${diffDays}d ${remHours}h ago` : `${diffDays}d ago`;
}

// --- DRAG-AND-DROP SCHEDULE REORDERING ---
let draggedScheduleState = null;

function onScheduleDragStart(e, serverId, index) {
    draggedScheduleState = { serverId: String(serverId), index: Number(index) };
    e.dataTransfer.effectAllowed = 'move';
    try {
        e.dataTransfer.setData('text/plain', JSON.stringify(draggedScheduleState));
    } catch (err) {}
    const tr = e.currentTarget;
    if (tr) {
        tr.classList.add('opacity-40', 'bg-indigo-500/10');
    }
}

function onScheduleDragOver(e, serverId, index) {
    if (!draggedScheduleState || draggedScheduleState.serverId !== String(serverId)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const tr = e.currentTarget;
    if (tr && !tr.classList.contains('border-t-2') && draggedScheduleState.index !== Number(index)) {
        tr.classList.add('border-t-2', 'border-discord-blurple', 'bg-discord-blurple/10');
    }
}

function onScheduleDragEnter(e, serverId, index) {
    if (!draggedScheduleState || draggedScheduleState.serverId !== String(serverId)) return;
    e.preventDefault();
}

function onScheduleDragLeave(e) {
    const tr = e.currentTarget;
    if (tr) {
        tr.classList.remove('border-t-2', 'border-discord-blurple', 'bg-discord-blurple/10');
    }
}

async function onScheduleDrop(e, targetServerId, targetIndex) {
    e.preventDefault();
    const tr = e.currentTarget;
    if (tr) {
        tr.classList.remove('border-t-2', 'border-discord-blurple', 'bg-discord-blurple/10');
    }

    let sourceServerId = draggedScheduleState ? draggedScheduleState.serverId : null;
    let sourceIndex = draggedScheduleState ? draggedScheduleState.index : -1;

    try {
        const raw = e.dataTransfer.getData('text/plain');
        if (raw) {
            const parsed = JSON.parse(raw);
            sourceServerId = String(parsed.serverId);
            sourceIndex = Number(parsed.index);
        }
    } catch (err) {}

    targetServerId = String(targetServerId);
    targetIndex = Number(targetIndex);

    if (!sourceServerId || sourceServerId !== targetServerId || sourceIndex === targetIndex || sourceIndex < 0) {
        return;
    }

    await reorderSchedules(targetServerId, sourceIndex, targetIndex);
}

function onScheduleDragEnd(e) {
    draggedScheduleState = null;
    document.querySelectorAll('.schedule-drag-row').forEach(row => {
        row.classList.remove('opacity-40', 'bg-indigo-500/10', 'border-t-2', 'border-discord-blurple', 'bg-discord-blurple/10');
    });
}

async function moveSchedulePriority(serverId, currentIndex, direction) {
    const targetIndex = Number(currentIndex) + Number(direction);
    const server = (currentConfig.servers || []).find(s => String(s.id) === String(serverId));
    if (!server || !server.schedules || targetIndex < 0 || targetIndex >= server.schedules.length) {
        return;
    }
    await reorderSchedules(serverId, currentIndex, targetIndex);
}

async function reorderSchedules(serverId, fromIndex, toIndex) {
    const server = (currentConfig.servers || []).find(s => String(s.id) === String(serverId));
    if (!server || !server.schedules) return;

    const [moved] = server.schedules.splice(fromIndex, 1);
    server.schedules.splice(toIndex, 0, moved);

    // Optimistically re-render to update execution sequence tags immediately
    renderServers();

    try {
        const scheduleIds = server.schedules.map(s => s.id);
        const res = await fetch(`/api/servers/${serverId}/schedules/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scheduleIds })
        });

        if (res.ok) {
            showNotificationToast(`Priority updated: "${moved.label}" moved to #${toIndex + 1}`, 'success');
            if (typeof performAutoBackup === 'function') {
                performAutoBackup(true);
            }
        } else {
            // Fallback to saving whole config
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ servers: currentConfig.servers })
            });
            showNotificationToast(`Priority updated (#${toIndex + 1})`, 'success');
        }
    } catch (err) {
        console.warn('Notice reordering schedules:', err);
        showNotificationToast('Reordered schedules locally', 'info');
    }
}

// --- RENDER SERVER PROFILES ---
function renderServers() {
    const container = document.getElementById('serverListContainer');
    if (!container) return;

    const allServers = currentConfig.servers || [];

    // Update count badge in header
    const totalBadge = document.getElementById('serverCountBadge');
    if (totalBadge) totalBadge.innerText = allServers.length;

    if (allServers.length === 0) {
        const countStatus = document.getElementById('searchResultCount');
        if (countStatus) countStatus.innerText = 'No servers configured';

        const hasLocalBackup = Boolean(localStorage.getItem('croncord_local_backup'));

        container.innerHTML = `
            <div class="bg-discord-dark rounded-xl p-8 text-center border border-discord-border space-y-3">
                <div class="w-12 h-12 rounded-full bg-discord-card mx-auto flex items-center justify-center text-discord-blurple text-xl">
                    <i class="fa-solid fa-server"></i>
                </div>
                <h3 class="text-base font-bold text-white">No Discord Servers Configured</h3>
                <p class="text-xs text-discord-muted max-w-md mx-auto">
                    Add your first server profile with target channel and daily attendance schedules, or restore an offline snapshot.
                </p>
                <div class="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <button onclick="openAddServerModal()" class="px-4 py-2 rounded-lg text-xs font-bold bg-discord-blurple hover:bg-indigo-600 text-white shadow transition cursor-pointer">
                        + Add Server Profile
                    </button>
                    ${hasLocalBackup ? `
                    <button onclick="restoreFromLocalBackup()" class="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow transition cursor-pointer">
                        <i class="fa-solid fa-rotate-left mr-1"></i> Restore from Auto-Backup
                    </button>
                    ` : ''}
                    <button onclick="triggerImportConfig()" class="px-4 py-2 rounded-lg text-xs font-semibold bg-discord-card hover:bg-discord-border text-discord-text border border-discord-border transition cursor-pointer">
                        <i class="fa-solid fa-file-import mr-1"></i> Import JSON
                    </button>
                </div>
            </div>
        `;
        updateBulkSelectionUI();
        return;
    }

    // Filter by search query (name or channelId) and status filter
    const q = (serverSearchQuery || '').trim().toLowerCase();
    const filteredServers = getFilteredServers();

    const countStatus = document.getElementById('searchResultCount');
    if (countStatus) {
        const filterDesc = serverStatusFilter !== 'ALL' ? ` [${serverStatusFilter}]` : '';
        if (q || serverStatusFilter !== 'ALL') {
            countStatus.innerHTML = `Showing <strong class="text-white font-semibold">${filteredServers.length}</strong> of ${allServers.length} server${allServers.length === 1 ? '' : 's'}${filterDesc}`;
        } else {
            countStatus.innerText = `${allServers.length} server profile${allServers.length === 1 ? '' : 's'} configured`;
        }
    }

    if (filteredServers.length === 0) {
        container.innerHTML = `
            <div class="bg-discord-dark rounded-xl p-8 text-center border border-discord-border space-y-3">
                <div class="w-12 h-12 rounded-full bg-discord-card mx-auto flex items-center justify-center text-discord-muted text-xl">
                    <i class="fa-solid fa-magnifying-glass"></i>
                </div>
                <h3 class="text-base font-bold text-white">No Servers Match Your Filters</h3>
                <p class="text-xs text-discord-muted max-w-sm mx-auto">
                    ${q ? `No configured servers matching "<span class="text-discord-text font-mono">${escapeHtml(serverSearchQuery)}</span>"` : ''}
                    ${serverStatusFilter !== 'ALL' ? ` with status <strong class="text-white">${escapeHtml(serverStatusFilter)}</strong>.` : '.'}
                </p>
                <div class="flex items-center justify-center gap-2 pt-1">
                    ${q ? `
                    <button onclick="clearServerSearch()" class="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-discord-card hover:bg-discord-border text-white border border-discord-border transition cursor-pointer">
                        Clear Search Filter
                    </button>
                    ` : ''}
                    ${serverStatusFilter !== 'ALL' ? `
                    <button onclick="handleServerStatusFilter('ALL'); document.getElementById('serverStatusFilter').value = 'ALL';" class="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-discord-blurple hover:bg-indigo-600 text-white transition cursor-pointer">
                        Reset Status Filter
                    </button>
                    ` : ''}
                </div>
            </div>
        `;
        updateBulkSelectionUI();
        return;
    }

    container.innerHTML = filteredServers.map((server, serverIndex) => {
        // Detect 5-minute schedule trigger conflicts for this single channel
        const conflictAnalysis = analyzeServerScheduleConflicts(server);
        const { hasConflict, conflicts, conflictingScheduleIds } = conflictAnalysis;

        // Health Status resolution based on latest execution results
        const serverHealth = (currentStatus.serverHealth && currentStatus.serverHealth[server.id]) || null;
        let health = 'RUNNING';
        if (!server.active) {
            health = 'DISABLED';
        } else if (serverHealth && serverHealth.health === 'FAILED') {
            health = 'FAILED';
        } else if (serverHealth && serverHealth.health) {
            health = serverHealth.health;
        }

        // Color-coding styling based on health (green for Running, red for Failed, gray for Disabled)
        let cardBorder = 'border-emerald-500/50 shadow-[0_0_16px_rgba(87,242,135,0.07)] ring-1 ring-emerald-500/15';
        let cardHeaderBg = 'border-emerald-500/20 bg-emerald-500/5';
        let cardIconBox = 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400';
        let healthPill = `
            <span class="text-xs px-2.5 py-0.5 rounded-full font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/35 inline-flex items-center gap-1.5 shadow-xs" title="Server health is Running - all recent executions succeeded">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                <span>Running</span>
            </span>
        `;

        if (health === 'DISABLED') {
            cardBorder = 'border-zinc-700/60 opacity-80';
            cardHeaderBg = 'border-zinc-700/50 bg-zinc-800/30';
            cardIconBox = 'bg-zinc-700/20 border-zinc-600/30 text-zinc-400';
            healthPill = `
                <span class="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-zinc-700/25 text-zinc-400 border border-zinc-600/30 inline-flex items-center gap-1.5" title="Server is Disabled - monitoring paused">
                    <span class="w-1.5 h-1.5 rounded-full bg-zinc-500"></span>
                    <span>Disabled</span>
                </span>
            `;
        } else if (health === 'FAILED') {
            cardBorder = 'border-rose-500/70 shadow-[0_0_20px_rgba(237,66,69,0.12)] ring-1 ring-rose-500/20';
            cardHeaderBg = 'border-rose-500/30 bg-rose-500/10';
            cardIconBox = 'bg-rose-500/15 border-rose-500/30 text-rose-400';
            healthPill = `
                <span class="text-xs px-2.5 py-0.5 rounded-full font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40 inline-flex items-center gap-1.5 shadow-xs" title="Server health is Failed - recent execution failed">
                    <span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span>
                    <span>Failed</span>
                </span>
            `;
        }

        // Server Uptime & Last Successful Check-in calculation
        const lastSuccessTimestamp = serverHealth ? serverHealth.lastSuccessfulAt : null;
        const lastSuccessElapsed = lastSuccessTimestamp ? formatUptimeDuration(lastSuccessTimestamp) : null;
        let uptimeBadge = '';
        if (!server.active) {
            uptimeBadge = `
                <span class="text-xs px-2.5 py-0.5 rounded-full font-medium bg-zinc-700/25 text-zinc-400 border border-zinc-600/30 inline-flex items-center gap-1.5" title="Server monitoring is paused">
                    <i class="fa-solid fa-pause text-[10px]"></i>
                    <span>Paused</span>
                </span>
            `;
        } else if (lastSuccessTimestamp) {
            const dateFormatted = new Date(lastSuccessTimestamp).toLocaleString();
            uptimeBadge = `
                <span class="text-xs px-2.5 py-0.5 rounded-full font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 inline-flex items-center gap-1.5 shadow-xs" title="Last successful attendance check-in: ${lastSuccessElapsed} (${dateFormatted})">
                    <i class="fa-regular fa-clock text-emerald-400 text-xs"></i>
                    <span>Check-in: ${lastSuccessElapsed}</span>
                </span>
            `;
        } else {
            uptimeBadge = `
                <span class="text-xs px-2.5 py-0.5 rounded-full font-medium bg-indigo-500/10 text-indigo-300 border border-indigo-500/25 inline-flex items-center gap-1.5" title="Server Uptime: Waiting for first scheduled attendance check-in">
                    <i class="fa-regular fa-clock text-indigo-400 text-xs"></i>
                    <span>No check-ins yet</span>
                </span>
            `;
        }

        // Retain visual warning if timing conflict exists and server not failed
        if (hasConflict && health !== 'FAILED') {
            cardBorder = 'border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.08)] ring-1 ring-amber-500/15';
        }

        const isSelected = selectedServerIds.has(String(server.id));

        return `
        <div class="server-card-animate bg-discord-dark rounded-xl border ${cardBorder} overflow-hidden transition shadow-sm hover:border-discord-border/80" style="animation-delay: ${Math.min(serverIndex * 0.04, 0.28)}s;">
            <!-- Server Header -->
            <div class="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3 border-b ${cardHeaderBg}">
                <div class="flex items-center space-x-3">
                    <input
                        type="checkbox"
                        class="server-select-checkbox w-4 h-4 rounded bg-discord-darker border-discord-border text-discord-blurple focus:ring-0 cursor-pointer"
                        data-server-id="${server.id}"
                        ${isSelected ? 'checked' : ''}
                        onchange="toggleServerSelection('${server.id}', this.checked)"
                        title="Select this server for bulk actions"
                    />
                    <div class="relative w-10 h-10 rounded-xl ${cardIconBox} border flex items-center justify-center font-bold text-base shrink-0">
                        <i class="fa-solid fa-hashtag"></i>
                        ${hasConflict ? `
                            <span class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-amber-500 text-black flex items-center justify-center text-[10px] font-black shadow-md border-2 border-discord-dark animate-pulse" title="Rate-Limiting Warning: Multiple schedules trigger within the same 5-minute window in this channel">
                                <i class="fa-solid fa-triangle-exclamation"></i>
                            </span>
                        ` : ''}
                    </div>
                    <div>
                        <div class="flex flex-wrap items-center gap-2">
                            <h3 class="font-bold text-white text-base">${escapeHtml(server.name)}</h3>
                            ${hasConflict ? `
                                <span class="text-xs px-2.5 py-0.5 rounded-full font-bold bg-amber-500/20 text-amber-300 border border-amber-500/50 inline-flex items-center gap-1.5 shadow-xs cursor-pointer hover:bg-amber-500/30 transition group/ratewarn" title="Rate-Limit Warning: Multiple schedules trigger within 5 minutes of each other in channel ${escapeHtml(server.channelId)}. Potential rate-limiting risk!">
                                    <i class="fa-solid fa-triangle-exclamation text-amber-400 text-xs animate-bounce"></i>
                                    <span>Rate-Limit Warning (&le;5m overlap)</span>
                                </span>
                            ` : ''}
                            ${healthPill}
                            ${uptimeBadge}
                            ${(serverHealth && (serverHealth.currentStreak > 0 || serverHealth.bestStreak > 0)) ? `
                                <span class="text-xs px-2.5 py-0.5 rounded-full font-bold bg-orange-500/15 text-orange-300 border border-orange-500/30 inline-flex items-center gap-1.5 shadow-xs" title="Consecutive successful check-ins (skips don't break streaks). Best: ${serverHealth.bestStreak}">
                                    <i class="fa-solid fa-fire text-orange-400 text-xs"></i>
                                    <span>${serverHealth.currentStreak} streak</span>
                                </span>
                            ` : ''}
                        </div>
                        <!-- Server Profile List Row Metadata with Elapsed Check-in Clock -->
                        <div class="flex flex-wrap items-center gap-2.5 text-xs text-discord-muted mt-1 mono">
                            <span>Channel ID: ${escapeHtml(server.channelId)}</span>
                            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-discord-card border border-discord-border text-discord-text text-[11px] font-sans" title="Time elapsed since last successful attendance check-in for this server">
                                <i class="fa-regular fa-clock ${lastSuccessTimestamp ? 'text-emerald-400' : 'text-discord-muted'} text-[11px]"></i>
                                <span>Last success: <strong class="${lastSuccessTimestamp ? 'text-emerald-400' : 'text-discord-muted'}">${lastSuccessElapsed || 'Never'}</strong></span>
                            </span>
                            ${hasConflict ? `
                                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-300 font-sans text-[11px] font-semibold" title="Rate-limiting risk: ${conflicts.length} overlapping schedule pairs found within 5 minutes">
                                    <i class="fa-solid fa-triangle-exclamation text-amber-400 text-[10px] animate-pulse"></i>
                                    <span>${conflicts.length} Timing Overlap${conflicts.length === 1 ? '' : 's'}</span>
                                </span>
                            ` : ''}
                            ${serverHealth && serverHealth.lastRunAt ? `
                                <span class="${health === 'FAILED' ? 'text-rose-300' : 'text-emerald-400/90'}">
                                    • Last Run: ${new Date(serverHealth.lastRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${escapeHtml(serverHealth.lastRunStatus || 'OK')})
                                </span>
                            ` : ''}
                            ${server.webhookUrl ? '<span class="text-indigo-300">• Custom Webhook</span>' : ''}
                        </div>
                    </div>
                </div>

                <div class="flex items-center space-x-2">
                    <button onclick="toggleServerActive('${server.id}')" title="${server.active ? 'Pause Server' : 'Resume Server'}" class="p-2 rounded-lg text-xs bg-discord-card hover:bg-discord-border text-discord-text border border-discord-border transition cursor-pointer">
                        <i class="fa-solid ${server.active ? 'fa-pause text-amber-400' : 'fa-play text-emerald-400'}"></i>
                    </button>
                    <button onclick="openEditServerModal('${server.id}')" title="Edit Server" class="p-2 rounded-lg text-xs bg-discord-card hover:bg-discord-border text-discord-text border border-discord-border transition cursor-pointer">
                        <i class="fa-solid fa-pencil text-gray-300"></i>
                    </button>
                    <button onclick="deleteServer('${server.id}')" title="Delete Server" class="p-2 rounded-lg text-xs bg-discord-card hover:bg-rose-500/20 text-rose-400 border border-discord-border transition cursor-pointer">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                    <button onclick="openCloneServerModal('${server.id}')" title="Clone Server (duplicate with fresh IDs)" class="p-2 rounded-lg text-xs bg-discord-card hover:bg-discord-border text-discord-text border border-discord-border transition cursor-pointer">
                        <i class="fa-solid fa-copy text-indigo-300"></i>
                    </button>
                    <button onclick="openAddScheduleModal('${server.id}')" class="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-discord-blurple hover:bg-indigo-600 text-white shadow transition cursor-pointer">
                        <i class="fa-solid fa-plus"></i>
                        <span>Add Schedule</span>
                    </button>
                </div>
            </div>

            <!-- HEALTH FAILURE ALERT BANNER -->
            ${health === 'FAILED' ? `
                <div class="mx-4 sm:mx-5 mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 shadow-sm flex items-start space-x-2.5">
                    <div class="text-rose-400 text-base mt-0.5 shrink-0">
                        <i class="fa-solid fa-circle-exclamation"></i>
                    </div>
                    <div class="space-y-0.5 flex-1 text-xs">
                        <div class="flex items-center justify-between">
                            <span class="font-bold text-rose-300">Latest Task Failed</span>
                            ${serverHealth && serverHealth.lastRunAt ? `<span class="text-[11px] text-rose-300/80 mono">${new Date(serverHealth.lastRunAt).toLocaleTimeString()}</span>` : ''}
                        </div>
                        <p class="text-rose-200/90 font-mono text-[11px] leading-relaxed">
                            ${escapeHtml(serverHealth && serverHealth.lastError ? serverHealth.lastError : 'Recent attendance task encountered an error during dispatch.')}
                        </p>
                    </div>
                </div>
            ` : ''}

            <!-- VISUAL WARNING INDICATOR FOR OVERLAPPING SCHEDULES (<= 5min window) -->
            ${hasConflict ? `
                <div class="mx-4 sm:mx-5 mt-4 p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 shadow-sm">
                    <div class="flex items-start space-x-3">
                        <div class="text-amber-400 text-base mt-0.5 shrink-0">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                        </div>
                        <div class="text-xs space-y-2 w-full">
                            <div class="flex flex-wrap items-center justify-between gap-1">
                                <span class="font-bold text-amber-300 text-sm flex items-center gap-1.5">
                                    <i class="fa-solid fa-shield-halved text-amber-400"></i>
                                    <span>Rate-Limiting Warning (&le; 5-Minute Trigger Window)</span>
                                </span>
                                <span class="text-[11px] px-2 py-0.5 rounded bg-amber-500/20 font-mono text-amber-200 border border-amber-500/30">Channel: ${escapeHtml(server.channelId)}</span>
                            </div>
                            <p class="text-amber-200/90 leading-relaxed">
                                Two or more attendance schedules are set to trigger within the same <strong>5-minute window</strong> for this channel. Rapid consecutive messages or reactions in the same channel can trigger <strong>Discord rate limits</strong>, cause request drops, or flag your account:
                            </p>
                            <div class="space-y-1.5 pt-0.5">
                                ${conflicts.map(c => `
                                    <div class="flex items-center space-x-2 text-xs bg-black/30 px-3 py-2 rounded-lg border border-amber-500/20 text-amber-100">
                                        <i class="fa-solid fa-clock text-amber-400 shrink-0"></i>
                                        <div class="flex-1">
                                            <span class="font-semibold text-white">"${escapeHtml(c.schedA.label)}"</span> <span class="text-amber-300 font-mono">(${c.timeAStr})</span>
                                            and
                                            <span class="font-semibold text-white">"${escapeHtml(c.schedB.label)}"</span> <span class="text-amber-300 font-mono">(${c.timeBStr})</span>
                                            trigger <span class="font-bold text-amber-400 underline decoration-amber-500/60">${c.diffMinutes} minute${c.diffMinutes === 1 ? '' : 's'}</span> apart.
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                            <p class="text-[11px] text-amber-400/90 pt-0.5 flex items-center gap-1.5">
                                <i class="fa-solid fa-lightbulb text-amber-400"></i>
                                <span><strong>Prevention:</strong> Space routines at least 10–15 minutes apart, or increase anti-detection jitter to stagger automated dispatches safely.</span>
                            </p>
                        </div>
                    </div>
                </div>
            ` : ''}

            <!-- Schedules Table / List with Drag-and-Drop Reordering -->
            <div class="p-4 sm:p-5">
                ${!server.schedules || server.schedules.length === 0 ? `
                    <p class="text-xs text-discord-muted italic">No schedules defined for this server yet. Click "Add Schedule" to configure daily times.</p>
                ` : `
                    <div class="flex items-center justify-end gap-2 mb-2">
                        <span class="text-[11px] text-discord-muted uppercase tracking-wider font-semibold">Bulk:</span>
                        <button onclick="bulkSchedulesUI('${server.id}', 'enable')" title="Enable every routine on this server" class="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-500/15 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 transition cursor-pointer">Enable all</button>
                        <button onclick="bulkSchedulesUI('${server.id}', 'disable')" title="Pause every routine on this server" class="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-amber-500/15 hover:bg-amber-600 text-amber-300 hover:text-white border border-amber-500/30 transition cursor-pointer">Pause all</button>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-left text-xs">
                            <thead>
                                <tr class="text-discord-muted uppercase tracking-wider border-b border-discord-border/40 pb-2">
                                    <th class="pb-2 font-semibold w-16 text-center" title="Execution Sequence Priority (Drag & drop rows to reorder)">Priority</th>
                                    <th class="pb-2 font-semibold">Schedule Label</th>
                                    <th class="pb-2 font-semibold">Frequency (Cron)</th>
                                    <th class="pb-2 font-semibold">Type & Payload</th>
                                    <th class="pb-2 font-semibold">Jitter</th>
                                    <th class="pb-2 font-semibold">Status</th>
                                    <th class="pb-2 font-semibold text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-discord-border/30" id="schedules-tbody-${server.id}">
                                ${server.schedules.map((sched, schedIndex) => {
                                    const isConflicting = conflictingScheduleIds.has(String(sched.id));
                                    return `
                                    <tr
                                        id="sched-row-${server.id}-${sched.id}"
                                        class="schedule-drag-row hover:bg-discord-card/30 transition select-none group ${isConflicting ? 'bg-amber-500/5' : ''}"
                                        draggable="true"
                                        ondragstart="onScheduleDragStart(event, '${server.id}', ${schedIndex})"
                                        ondragover="onScheduleDragOver(event, '${server.id}', ${schedIndex})"
                                        ondragenter="onScheduleDragEnter(event, '${server.id}', ${schedIndex})"
                                        ondragleave="onScheduleDragLeave(event)"
                                        ondrop="onScheduleDrop(event, '${server.id}', ${schedIndex})"
                                        ondragend="onScheduleDragEnd(event)"
                                        data-server-id="${server.id}"
                                        data-schedule-id="${sched.id}"
                                        data-index="${schedIndex}"
                                    >
                                        <td class="py-2.5 text-center whitespace-nowrap">
                                            <div class="inline-flex items-center gap-1.5 justify-center">
                                                <span class="cursor-grab active:cursor-grabbing text-discord-muted hover:text-white p-1 rounded hover:bg-discord-card transition inline-flex items-center" title="Drag & drop to reorder execution sequence priority">
                                                    <i class="fa-solid fa-grip-vertical text-xs group-hover:text-indigo-300"></i>
                                                </span>
                                                <span class="text-[10px] mono font-bold px-1.5 py-0.5 rounded bg-discord-card border border-discord-border text-discord-muted group-hover:text-white" title="Execution Sequence Priority #${schedIndex + 1}">
                                                    #${schedIndex + 1}
                                                </span>
                                                <div class="inline-flex flex-col ml-0.5 opacity-30 group-hover:opacity-100 transition">
                                                    ${schedIndex > 0 ? `
                                                        <button onclick="moveSchedulePriority('${server.id}', ${schedIndex}, -1); event.stopPropagation();" title="Move Up (Higher Priority)" class="text-[9px] text-discord-muted hover:text-white leading-none p-0.5 cursor-pointer">
                                                            <i class="fa-solid fa-chevron-up"></i>
                                                        </button>
                                                    ` : ''}
                                                    ${schedIndex < server.schedules.length - 1 ? `
                                                        <button onclick="moveSchedulePriority('${server.id}', ${schedIndex}, 1); event.stopPropagation();" title="Move Down (Lower Priority)" class="text-[9px] text-discord-muted hover:text-white leading-none p-0.5 cursor-pointer">
                                                            <i class="fa-solid fa-chevron-down"></i>
                                                        </button>
                                                    ` : ''}
                                                </div>
                                            </div>
                                        </td>
                                        <td class="py-2.5 font-medium text-white">
                                            <div class="flex items-center flex-wrap gap-1.5">
                                                <span>${escapeHtml(sched.label)}</span>
                                                ${sched.type === 'ONCE' ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold">ONE-TIME</span>' : ''}
                                                ${isConflicting ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold inline-flex items-center gap-1 shadow-xs cursor-help" title="Rate-Limiting Warning: Triggers within 5 minutes of another schedule in this channel (' + escapeHtml(server.channelId) + '). Potential rate-limiting risk!"><i class="fa-solid fa-triangle-exclamation text-[9px] text-amber-400 animate-pulse"></i> &le;5m Rate-Limit Risk</span>' : ''}
                                            </div>
                                        </td>
                                        <td class="py-2.5 mono text-discord-muted">${escapeHtml(sched.cron)}</td>
                                        <td class="py-2.5">
                                            ${sched.attendanceType === 'REACTION' ? `
                                                <span class="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                                                    <span>Reaction:</span>
                                                    <span class="font-bold text-white">${escapeHtml(sched.emoji || '👍')}</span>
                                                </span>
                                            ` : `
                                                <span class="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 truncate max-w-[200px]" title="${escapeHtml(sched.message || 'Present')}">
                                                    <i class="fa-regular fa-comment-dots text-emerald-400 mr-1"></i>
                                                    <span class="truncate">"${escapeHtml((sched.message || 'Present').replace(/\n/g, ' ⏎ '))}"</span>
                                                </span>
                                            `}
                                        </td>
                                        <td class="py-2.5 text-discord-muted">${sched.maxJitterMinutes || 0}m jitter</td>
                                        <td class="py-2.5">
                                            <button onclick="toggleScheduleActive('${server.id}', '${sched.id}')" class="cursor-pointer">
                                                <span class="px-2 py-0.5 rounded text-[11px] font-semibold ${sched.active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-gray-500/20 text-gray-400'}">
                                                    ${sched.active ? 'Active' : 'Disabled'}
                                                </span>
                                            </button>
                                        </td>
                                        <td class="py-2.5 text-right space-x-1.5 whitespace-nowrap">
                                            <!-- Preview Dry-Run Button -->
                                            <button
                                                onclick="previewScheduleNow('${server.id}', '${sched.id}')"
                                                title="Preview: show the exact resolved post text without sending anything"
                                                class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-500/15 hover:bg-indigo-600 text-indigo-300 hover:text-white border border-indigo-500/30 hover:border-indigo-500 text-xs font-semibold shadow-xs transition duration-150 cursor-pointer active:scale-95"
                                            >
                                                <i class="fa-solid fa-eye text-[9px] text-indigo-400"></i>
                                                <span>Preview</span>
                                            </button>
                                            <!-- Test Run Play Button -->
                                            <button
                                                id="btn-test-run-${server.id}-${sched.id}"
                                                onclick="triggerScheduleNow('${server.id}', '${sched.id}', this)"
                                                title="Test Run: Execute immediate one-time manual execution of this schedule"
                                                class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 hover:border-emerald-500 text-xs font-semibold shadow-xs transition duration-150 cursor-pointer active:scale-95"
                                            >
                                                <i class="fa-solid fa-play text-[9px] text-emerald-400"></i>
                                                <span>Test Run</span>
                                            </button>
                                            <button onclick="openEditScheduleModal('${server.id}', '${sched.id}')" title="Edit Schedule" class="p-1.5 rounded bg-discord-card hover:bg-discord-border text-discord-muted hover:text-white transition cursor-pointer">
                                                <i class="fa-solid fa-pencil"></i>
                                            </button>
                                            <button onclick="duplicateScheduleUI('${server.id}', '${sched.id}')" title="Duplicate Schedule (starts paused)" class="p-1.5 rounded bg-discord-card hover:bg-discord-border text-discord-muted hover:text-white transition cursor-pointer">
                                                <i class="fa-solid fa-clone"></i>
                                            </button>
                                            <button onclick="deleteSchedule('${server.id}', '${sched.id}')" title="Delete Schedule" class="p-1.5 rounded bg-discord-card hover:bg-rose-500/20 text-discord-muted hover:text-rose-400 transition cursor-pointer">
                                                <i class="fa-solid fa-trash"></i>
                                            </button>
                                        </td>
                                    </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                `}
            </div>
        </div>
        `;
    }).join('');

    updateBulkSelectionUI();
}

// --- CONFIRMATION DIALOGUE BOX (Replaces browser popups for deleting servers, schedules, bulk items) ---
let confirmDialogResolve = null;

function showConfirmDialog({
    title = 'Confirm Action',
    message = 'Are you sure you want to proceed?',
    details = [],
    icon = 'fa-solid fa-triangle-exclamation',
    iconColor = 'rose',
    confirmText = 'Delete',
    confirmClass = 'bg-rose-600 hover:bg-rose-500 text-white',
    cancelText = 'Cancel'
}) {
    return new Promise((resolve) => {
        confirmDialogResolve = resolve;

        const modal = document.getElementById('confirmDialogModal');
        const titleEl = document.getElementById('confirmDialogTitle');
        const msgEl = document.getElementById('confirmDialogMessage');
        const detailsEl = document.getElementById('confirmDialogDetailsBox');
        const iconEl = document.getElementById('confirmDialogIcon');
        const iconBox = document.getElementById('confirmDialogIconBox');
        const confirmBtn = document.getElementById('confirmDialogConfirmBtn');
        const cancelBtn = document.getElementById('confirmDialogCancelBtn');

        if (!modal) {
            const fallback = window.confirm(`${title}\n\n${message}`);
            return resolve(fallback);
        }

        if (titleEl) titleEl.textContent = title;
        if (msgEl) msgEl.textContent = message;

        if (detailsEl) {
            if (Array.isArray(details) && details.length > 0) {
                detailsEl.innerHTML = details.map(d => `
                    <div class="flex items-center justify-between text-xs py-1 border-b border-discord-border/30 last:border-0">
                        <span class="text-discord-muted font-medium">${escapeHtml(d.label)}:</span>
                        <span class="font-semibold text-white truncate max-w-[240px]">${escapeHtml(d.value)}</span>
                    </div>
                `).join('');
                detailsEl.classList.remove('hidden');
            } else if (typeof details === 'string' && details.trim().length > 0) {
                detailsEl.innerHTML = details;
                detailsEl.classList.remove('hidden');
            } else {
                detailsEl.innerHTML = '';
                detailsEl.classList.add('hidden');
            }
        }

        if (iconEl) iconEl.className = icon;
        if (iconBox) {
            if (iconColor === 'amber') {
                iconBox.className = 'w-11 h-11 rounded-xl bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center justify-center text-lg shrink-0';
            } else if (iconColor === 'indigo') {
                iconBox.className = 'w-11 h-11 rounded-xl bg-indigo-500/15 text-indigo-400 border border-indigo-500/30 flex items-center justify-center text-lg shrink-0';
            } else {
                iconBox.className = 'w-11 h-11 rounded-xl bg-rose-500/15 text-rose-400 border border-rose-500/30 flex items-center justify-center text-lg shrink-0';
            }
        }

        if (confirmBtn) {
            confirmBtn.className = `px-4 py-2 text-xs font-bold rounded-lg shadow transition cursor-pointer ${confirmClass}`;
            confirmBtn.textContent = confirmText;
        }
        if (cancelBtn) {
            cancelBtn.textContent = cancelText;
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');

        setTimeout(() => {
            if (cancelBtn) cancelBtn.focus();
        }, 50);
    });
}

function resolveConfirmDialog(result) {
    const modal = document.getElementById('confirmDialogModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    if (typeof confirmDialogResolve === 'function') {
        const resolve = confirmDialogResolve;
        confirmDialogResolve = null;
        resolve(Boolean(result));
    }
}

// Global keydown listener for ESC key to close confirmation dialog safely
window.addEventListener('keydown', (e) => {
    const confirmModal = document.getElementById('confirmDialogModal');
    if (confirmModal && !confirmModal.classList.contains('hidden')) {
        if (e.key === 'Escape') {
            e.preventDefault();
            resolveConfirmDialog(false);
        }
    }
});

// --- SERVER MODAL ACTIONS ---
function openAddServerModal() {
    document.getElementById('serverModalTitle').innerText = 'Add Server Profile';
    document.getElementById('modalServerId').value = '';
    document.getElementById('modalServerName').value = '';
    document.getElementById('modalServerChannelId').value = '';
    document.getElementById('modalServerWebhook').value = '';
    document.getElementById('modalServerActive').checked = true;
    document.getElementById('modalServerQuietStart').value = '';
    document.getElementById('modalServerQuietEnd').value = '';
    document.getElementById('modalServerIgnoreHolidays').checked = false;
    const modal = document.getElementById('serverModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function openEditServerModal(serverId) {
    const server = (currentConfig.servers || []).find(s => String(s.id) === String(serverId));
    if (!server) return;

    document.getElementById('serverModalTitle').innerText = 'Edit Server Profile';
    document.getElementById('modalServerId').value = server.id;
    document.getElementById('modalServerName').value = server.name;
    document.getElementById('modalServerChannelId').value = server.channelId;
    document.getElementById('modalServerWebhook').value = server.webhookUrl || '';
    document.getElementById('modalServerActive').checked = Boolean(server.active);
    document.getElementById('modalServerQuietStart').value = (server.quietHours && server.quietHours.start) || '';
    document.getElementById('modalServerQuietEnd').value = (server.quietHours && server.quietHours.end) || '';
    document.getElementById('modalServerIgnoreHolidays').checked = Boolean(server.ignoreHolidays);
    const modal = document.getElementById('serverModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeServerModal() {
    const modal = document.getElementById('serverModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

// --- CLONE SERVER + BULK SCHEDULE ACTIONS ---
function openCloneServerModal(serverId) {
    const server = (currentConfig.servers || []).find((s) => String(s.id) === String(serverId));
    if (!server) return;
    document.getElementById('modalCloneServerId').value = server.id;
    document.getElementById('modalCloneName').value = `${server.name} (copy)`;
    document.getElementById('modalCloneChannelId').value = '';
    const title = document.getElementById('cloneModalTitle');
    if (title) title.textContent = `Clone "${server.name}"`;
    const modal = document.getElementById('cloneModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeCloneServerModal() {
    const modal = document.getElementById('cloneModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function confirmCloneServer(e) {
    e.preventDefault();
    const serverId = document.getElementById('modalCloneServerId').value;
    const name = document.getElementById('modalCloneName').value.trim();
    const channelId = document.getElementById('modalCloneChannelId').value.trim();
    if (!name || !channelId) {
        showNotificationToast('New name and channel ID are required.', 'warning');
        return;
    }
    try {
        const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/clone`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, channelId }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
            closeCloneServerModal();
            showNotificationToast(`Cloned → "${data.server.name}" with ${(data.server.schedules || []).length} schedule(s).`, 'success');
            await fetchConfig();
            await fetchStatus();
        } else {
            showNotificationToast(data.error || 'Clone failed.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error cloning server: ${err.message}`, 'danger');
    }
}

async function bulkSchedulesUI(serverId, action) {
    try {
        const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/schedules/bulk-action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast(`${action === 'enable' ? 'Enabled' : 'Paused'} ${data.count} schedule(s).`, 'success');
            await fetchConfig();
        } else {
            showNotificationToast(data.error || 'Bulk action failed.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error: ${err.message}`, 'danger');
    }
}

async function handleSaveServer(e) {
    e.preventDefault();
    const id = document.getElementById('modalServerId').value;
    const name = document.getElementById('modalServerName').value.trim();
    const channelId = document.getElementById('modalServerChannelId').value.trim();
    const webhookUrl = document.getElementById('modalServerWebhook').value.trim();
    const active = document.getElementById('modalServerActive').checked;
    const quietStart = document.getElementById('modalServerQuietStart').value;
    const quietEnd = document.getElementById('modalServerQuietEnd').value;
    const ignoreHolidays = document.getElementById('modalServerIgnoreHolidays').checked;
    const quietHours = (quietStart && quietEnd) ? { start: quietStart, end: quietEnd } : null;

    if (!name || !channelId) {
        showNotificationToast('Server name and Channel ID are required.', 'warning');
        return;
    }

    // Client-side check for duplicate server profile when creating
    if (!id) {
        const cleanChan = channelId.toLowerCase();
        const cleanName = name.toLowerCase();
        const existingServer = (currentConfig.servers || []).find(s => 
            (s.channelId && s.channelId.trim().toLowerCase() === cleanChan) ||
            (s.name && s.name.trim().toLowerCase() === cleanName)
        );

        if (existingServer) {
            closeServerModal();
            showNotificationToast(`Server "${existingServer.name}" already exists! Redirecting to add schedule...`, 'warning');
            openAddScheduleModal(existingServer.id, {
                redirected: true,
                reason: `Server "${existingServer.name}" (Channel ID: ${existingServer.channelId}) is already configured. Add your attendance schedule below.`
            });
            return;
        }
    }

    try {
        let res;
        if (id) {
            // Update
            res = await fetch(`/api/servers/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, channelId, webhookUrl, active, quietHours, ignoreHolidays }),
            });
        } else {
            // Create
            res = await fetch('/api/servers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, channelId, webhookUrl, active }),
            });
        }

        if (res.ok) {
            closeServerModal();
            showNotificationToast(id ? `Server "${name}" updated successfully.` : `Server "${name}" profile created!`, 'success');
            await fetchConfig();
            await fetchStatus();
        } else if (res.status === 409) {
            // Server profile duplicate conflict from backend
            const errData = await res.json();
            closeServerModal();
            const existingId = errData.existingServer ? errData.existingServer.id : null;
            if (existingId) {
                showNotificationToast(errData.error || `Server "${name}" already exists! Redirecting to add schedule...`, 'warning');
                openAddScheduleModal(existingId, {
                    redirected: true,
                    reason: errData.error || `Server "${name}" already exists. Add your attendance routine below.`
                });
            } else {
                showNotificationToast(errData.error || 'Server profile already exists.', 'warning');
            }
        } else {
            const err = await res.json();
            showNotificationToast(`Failed to save server: ${err.error || 'Unknown error'}`, 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error saving server: ${err.message}`, 'danger');
    }
}

async function toggleServerActive(serverId) {
    const server = (currentConfig.servers || []).find(s => String(s.id) === String(serverId));
    if (!server) return;

    try {
        await fetch(`/api/servers/${serverId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: !server.active }),
        });
        await fetchConfig();
        await fetchStatus();
    } catch (err) {
        showNotificationToast(`Error toggling server: ${err.message}`, 'danger');
    }
}

async function deleteServer(serverId) {
    const server = (currentConfig.servers || []).find(s => String(s.id) === String(serverId));
    if (!server) return;

    const schedCount = (server.schedules || []).length;
    const confirmed = await showConfirmDialog({
        title: 'Delete Server Profile',
        message: `Are you sure you want to permanently delete "${server.name}"? This action cannot be undone.`,
        details: [
            { label: 'Server Profile', value: server.name },
            { label: 'Channel ID', value: server.channelId },
            { label: 'Associated Schedules', value: `${schedCount} routine(s)` },
            { label: 'Active Daemon Watcher', value: server.active ? 'Active (Will be stopped)' : 'Paused' }
        ],
        icon: 'fa-solid fa-trash-can',
        iconColor: 'rose',
        confirmText: 'Delete Server',
        confirmClass: 'bg-rose-600 hover:bg-rose-500 text-white',
        cancelText: 'Cancel'
    });

    if (!confirmed) return;

    try {
        const res = await fetch(`/api/servers/${serverId}`, { method: 'DELETE' });
        if (res.ok) {
            showNotificationToast(`Server "${server.name}" and all schedules deleted.`, 'info');
            await fetchConfig();
            await fetchStatus();
        } else {
            const err = await res.json();
            showNotificationToast(`Failed to delete server: ${err.error || 'Server error'}`, 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error deleting server: ${err.message}`, 'danger');
    }
}

// --- SCHEDULE MODAL ACTIONS ---
function handleFrequencyChange() {
    const freq = document.getElementById('modalScheduleFrequency').value;
    const specificDayField = document.getElementById('specificDayField');
    const oneTimeDateField = document.getElementById('oneTimeDateField');
    const customCronField = document.getElementById('customCronField');

    specificDayField.classList.add('hidden');
    oneTimeDateField.classList.add('hidden');
    customCronField.classList.add('hidden');

    if (freq === 'specific_day') specificDayField.classList.remove('hidden');
    if (freq === 'once') oneTimeDateField.classList.remove('hidden');
    if (freq === 'custom') customCronField.classList.remove('hidden');

    updateScheduleCronAndLabel();
}

function updateScheduleCronAndLabel() {
    const freq = document.getElementById('modalScheduleFrequency').value;
    const timeVal = document.getElementById('modalScheduleTime').value || '09:00';
    const [hours, minutes] = timeVal.split(':').map(Number);

    let cron = `${minutes} ${hours} * * *`;
    let label = `${timeVal} (Everyday)`;

    if (freq === 'everyday') {
        cron = `${minutes} ${hours} * * *`;
        label = `${timeVal} (Everyday)`;
    } else if (freq === 'weekdays') {
        cron = `${minutes} ${hours} * * 1-5`;
        label = `${timeVal} (Weekdays)`;
    } else if (freq === 'weekends') {
        cron = `${minutes} ${hours} * * 0,6`;
        label = `${timeVal} (Weekends)`;
    } else if (freq === 'specific_day') {
        const day = document.getElementById('modalScheduleWeekday').value;
        const dayNames = { '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday', '5': 'Friday', '6': 'Saturday', '0': 'Sunday' };
        cron = `${minutes} ${hours} * * ${day}`;
        label = `${timeVal} (${dayNames[day] || 'Weekday'})`;
    } else if (freq === 'once') {
        const dateInput = document.getElementById('modalScheduleDate').value;
        if (dateInput) {
            const [y, m, d] = dateInput.split('-').map(Number);
            cron = `${minutes} ${hours} ${d} ${m} *`;
            label = `${timeVal} (${dateInput})`;
        } else {
            label = `${timeVal} (One-Time)`;
        }
    } else if (freq === 'custom') {
        const custom = document.getElementById('modalScheduleCustomCron').value;
        cron = custom || '* * * * *';
        label = `${timeVal} (Custom)`;
    }

    const labelInput = document.getElementById('modalScheduleLabel');
    if (labelInput && !labelInput.dataset.manual) {
        labelInput.value = label;
    }
}

function setMode(mode) {
    document.getElementById('modalScheduleType').value = mode;
    const msgBtn = document.getElementById('modeBtn-MESSAGE');
    const reactBtn = document.getElementById('modeBtn-REACTION');
    const msgContainer = document.getElementById('messageModeContainer');
    const reactContainer = document.getElementById('reactionModeContainer');

    if (mode === 'MESSAGE') {
        msgBtn.className = 'px-4 py-2 rounded-lg text-xs font-bold border border-discord-blurple bg-discord-blurple text-white flex items-center justify-center space-x-2 cursor-pointer';
        reactBtn.className = 'px-4 py-2 rounded-lg text-xs font-medium border border-discord-border bg-discord-card text-discord-muted hover:text-white flex items-center justify-center space-x-2 cursor-pointer';
        msgContainer.classList.remove('hidden');
        reactContainer.classList.add('hidden');
    } else {
        reactBtn.className = 'px-4 py-2 rounded-lg text-xs font-bold border border-discord-blurple bg-discord-blurple text-white flex items-center justify-center space-x-2 cursor-pointer';
        msgBtn.className = 'px-4 py-2 rounded-lg text-xs font-medium border border-discord-border bg-discord-card text-discord-muted hover:text-white flex items-center justify-center space-x-2 cursor-pointer';
        reactContainer.classList.remove('hidden');
        msgContainer.classList.add('hidden');
    }
}

function openAddScheduleModal(serverId, options = {}) {
    document.getElementById('scheduleModalTitle').innerText = 'Add Attendance Schedule';
    document.getElementById('modalScheduleServerId').value = serverId;
    document.getElementById('modalScheduleId').value = '';
    document.getElementById('modalScheduleFrequency').value = 'weekdays';
    document.getElementById('modalScheduleTime').value = '09:00';
    document.getElementById('modalScheduleLabel').value = '09:00 (Weekdays)';
    delete document.getElementById('modalScheduleLabel').dataset.manual;
    document.getElementById('modalScheduleMessage').value = 'Present';
    document.getElementById('modalSchedulePool').value = '';
    document.getElementById('modalScheduleEmoji').value = '👍';
    document.getElementById('modalScheduleTargetMessageId').value = '';
    document.getElementById('modalScheduleJitter').value = '10';
    document.getElementById('jitterDisplay').innerText = '10 mins';
    document.getElementById('modalScheduleActive').checked = true;

    // Handle Duplicate Redirect Notice banner
    const noticeBox = document.getElementById('scheduleRedirectNotice');
    const noticeText = document.getElementById('scheduleRedirectNoticeText');
    if (noticeBox && noticeText) {
        if (options && options.redirected) {
            const server = (currentConfig.servers || []).find(s => String(s.id) === String(serverId));
            const sName = server ? server.name : 'Target Server';
            noticeText.textContent = options.reason || `Server "${sName}" is already registered. You can configure an attendance schedule for it below.`;
            noticeBox.classList.remove('hidden');
        } else {
            noticeBox.classList.add('hidden');
        }
    }

    setMode('MESSAGE');
    handleFrequencyChange();

    const modal = document.getElementById('scheduleModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function openEditScheduleModal(serverId, scheduleId) {
    const noticeBox = document.getElementById('scheduleRedirectNotice');
    if (noticeBox) noticeBox.classList.add('hidden');

    const server = (currentConfig.servers || []).find(s => String(s.id) === String(serverId));
    if (!server) return;
    const schedule = (server.schedules || []).find(sc => String(sc.id) === String(scheduleId));
    if (!schedule) return;

    document.getElementById('scheduleModalTitle').innerText = 'Edit Attendance Schedule';
    document.getElementById('modalScheduleServerId').value = serverId;
    document.getElementById('modalScheduleId').value = schedule.id;

    // Detect frequency from cron or type
    if (schedule.type === 'ONCE') {
        document.getElementById('modalScheduleFrequency').value = 'once';
        if (schedule.runDate) {
            document.getElementById('modalScheduleDate').value = schedule.runDate.split('T')[0];
        }
    } else if (schedule.cron.endsWith('1-5')) {
        document.getElementById('modalScheduleFrequency').value = 'weekdays';
    } else if (schedule.cron.endsWith('0,6')) {
        document.getElementById('modalScheduleFrequency').value = 'weekends';
    } else if (schedule.cron.endsWith('* * *')) {
        document.getElementById('modalScheduleFrequency').value = 'everyday';
    } else {
        document.getElementById('modalScheduleFrequency').value = 'custom';
        document.getElementById('modalScheduleCustomCron').value = schedule.cron;
    }

    document.getElementById('modalScheduleLabel').value = schedule.label;
    document.getElementById('modalScheduleLabel').dataset.manual = 'true';
    document.getElementById('modalScheduleMessage').value = schedule.message || 'Present';
    document.getElementById('modalSchedulePool').value = Array.isArray(schedule.messagePool) ? schedule.messagePool.join('\n') : '';
    document.getElementById('modalScheduleEmoji').value = schedule.emoji || '👍';
    document.getElementById('modalScheduleTargetMessageId').value = schedule.targetMessageId || '';
    document.getElementById('modalScheduleJitter').value = schedule.maxJitterMinutes || 10;
    document.getElementById('jitterDisplay').innerText = (schedule.maxJitterMinutes || 10) + ' mins';
    document.getElementById('modalScheduleActive').checked = Boolean(schedule.active);

    setMode(schedule.attendanceType || 'MESSAGE');
    handleFrequencyChange();

    const modal = document.getElementById('scheduleModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeScheduleModal() {
    const noticeBox = document.getElementById('scheduleRedirectNotice');
    if (noticeBox) noticeBox.classList.add('hidden');

    const modal = document.getElementById('scheduleModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function handleSaveSchedule(e) {
    e.preventDefault();
    const serverId = document.getElementById('modalScheduleServerId').value;
    const scheduleId = document.getElementById('modalScheduleId').value;

    const freq = document.getElementById('modalScheduleFrequency').value;
    const timeVal = document.getElementById('modalScheduleTime').value || '09:00';
    const [hours, minutes] = timeVal.split(':').map(Number);
    const label = document.getElementById('modalScheduleLabel').value;
    const mode = document.getElementById('modalScheduleType').value;
    const message = document.getElementById('modalScheduleMessage').value;
    const emoji = document.getElementById('modalScheduleEmoji').value;
    const targetMessageId = document.getElementById('modalScheduleTargetMessageId').value;
    const jitter = parseInt(document.getElementById('modalScheduleJitter').value, 10) || 0;
    const active = document.getElementById('modalScheduleActive').checked;
    const messagePool = document.getElementById('modalSchedulePool').value
        .split('\n').map((l) => l.trim()).filter(Boolean);

    let cron = `${minutes} ${hours} * * *`;
    let type = undefined;
    let runDate = undefined;

    if (freq === 'everyday') cron = `${minutes} ${hours} * * *`;
    else if (freq === 'weekdays') cron = `${minutes} ${hours} * * 1-5`;
    else if (freq === 'weekends') cron = `${minutes} ${hours} * * 0,6`;
    else if (freq === 'specific_day') {
        const day = document.getElementById('modalScheduleWeekday').value;
        cron = `${minutes} ${hours} * * ${day}`;
    } else if (freq === 'once') {
        type = 'ONCE';
        const dateInput = document.getElementById('modalScheduleDate').value;
        if (dateInput) {
            const [y, m, d] = dateInput.split('-').map(Number);
            cron = `${minutes} ${hours} ${d} ${m} *`;
            runDate = new Date(y, m - 1, d).toISOString();
        }
    } else if (freq === 'custom') {
        cron = document.getElementById('modalScheduleCustomCron').value || cron;
    }

    const payload = {
        label,
        cron,
        attendanceType: mode,
        message,
        messagePool,
        emoji,
        targetMessageId,
        maxJitterMinutes: jitter,
        active,
        type,
        runDate,
    };

    try {
        let res;
        if (scheduleId) {
            res = await fetch(`/api/servers/${serverId}/schedules/${scheduleId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } else {
            res = await fetch(`/api/servers/${serverId}/schedules`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        }

        if (res.ok) {
            const saved = await res.json().catch(() => ({}));
            closeScheduleModal();
            if (saved && saved.conflicts && saved.conflicts.hasConflict) {
                showNotificationToast(`Saved — but ${saved.conflicts.conflicts.length} schedule clash(es) detected (≤5m apart).`, 'warning');
            }
            await fetchConfig();
            await fetchStatus();
        } else {
            const err = await res.json();
            alert(`Failed to save schedule: ${err.error || 'Unknown error'}`);
        }
    } catch (err) {
        alert(`Error saving schedule: ${err.message}`);
    }
}

async function toggleScheduleActive(serverId, scheduleId) {
    const server = (currentConfig.servers || []).find(s => String(s.id) === String(serverId));
    if (!server) return;
    const schedule = (server.schedules || []).find(sc => String(sc.id) === String(scheduleId));
    if (!schedule) return;

    try {
        await fetch(`/api/servers/${serverId}/schedules/${scheduleId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: !schedule.active }),
        });
        await fetchConfig();
        await fetchStatus();
    } catch (err) {
        alert(`Error toggling schedule: ${err.message}`);
    }
}

async function duplicateScheduleUI(serverId, scheduleId) {
    try {
        const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/schedules/${encodeURIComponent(scheduleId)}/duplicate`, {
            method: 'POST',
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showNotificationToast(`Duplicated → "${data.schedule.label}" (paused — edit the time, then resume).`, 'success');
            if (data.conflicts && data.conflicts.hasConflict) {
                showNotificationToast(`${data.conflicts.conflicts.length} clash(es) detected with the copy (≤5m apart).`, 'warning');
            }
            await fetchConfig();
            await fetchStatus();
        } else {
            showNotificationToast(data.error || 'Duplicate failed.', 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error duplicating: ${err.message}`, 'danger');
    }
}

async function deleteSchedule(serverId, scheduleId) {
    const server = (currentConfig.servers || []).find(s => String(s.id) === String(serverId));
    const sched = server ? (server.schedules || []).find(sc => String(sc.id) === String(scheduleId)) : null;
    const schedLabel = sched ? sched.label : 'Attendance Routine';

    const confirmed = await showConfirmDialog({
        title: 'Delete Attendance Schedule',
        message: `Are you sure you want to remove the schedule routine "${schedLabel}"?`,
        details: sched ? [
            { label: 'Schedule Routine', value: sched.label },
            { label: 'Server Profile', value: server ? server.name : 'Unknown' },
            { label: 'Frequency (Cron)', value: sched.cron },
            { label: 'Attendance Mode', value: sched.attendanceType === 'REACTION' ? `Reaction (${sched.emoji || '👍'})` : `Message ("${sched.message || 'Present'}")` }
        ] : [],
        icon: 'fa-solid fa-clock-rotate-left',
        iconColor: 'rose',
        confirmText: 'Delete Schedule',
        confirmClass: 'bg-rose-600 hover:bg-rose-500 text-white',
        cancelText: 'Cancel'
    });

    if (!confirmed) return;

    try {
        const res = await fetch(`/api/servers/${serverId}/schedules/${scheduleId}`, { method: 'DELETE' });
        if (res.ok) {
            showNotificationToast(`Schedule "${schedLabel}" deleted successfully.`, 'info');
            await fetchConfig();
            await fetchStatus();
        } else {
            const err = await res.json();
            showNotificationToast(`Failed to delete schedule: ${err.error || 'Server error'}`, 'danger');
        }
    } catch (err) {
        showNotificationToast(`Error deleting schedule: ${err.message}`, 'danger');
    }
}

async function triggerScheduleNow(serverId, scheduleId, btnElement) {
    let originalHtml = '';
    if (btnElement) {
        originalHtml = btnElement.innerHTML;
        btnElement.disabled = true;
        btnElement.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin text-[9px] text-amber-300"></i> <span>Running...</span>';
        btnElement.classList.add('opacity-75');
    }

    try {
        const res = await fetch(`/api/servers/${serverId}/schedules/${scheduleId}/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ simulate: false }),
        });
        const data = await res.json();
        if (data.success) {
            triggerLocalSystemAlert({
                title: '⚡ Attendance Task Executed',
                body: data.message || 'Attendance schedule triggered successfully.'
            });
            showNotificationToast(data.message || 'Manual execution completed! Check-in recorded.', 'success');

            if (btnElement) {
                btnElement.innerHTML = '<i class="fa-solid fa-check text-[9px] text-emerald-300"></i> <span>Executed!</span>';
                btnElement.classList.remove('bg-emerald-500/15', 'text-emerald-300');
                btnElement.classList.add('bg-emerald-600', 'text-white');
            }

            // Immediately refresh status and stats so the elapsed check-in clock and uptime update in real time
            await fetchStatus();
            await fetchDailyCheckinStats();

            setTimeout(() => {
                if (btnElement) {
                    btnElement.innerHTML = originalHtml;
                    btnElement.disabled = false;
                    btnElement.classList.remove('opacity-75', 'bg-emerald-600', 'text-white');
                    btnElement.classList.add('bg-emerald-500/15', 'text-emerald-300');
                }
            }, 1800);
        } else {
            showNotificationToast(`Test run failed: ${data.error || 'Check activity log'}`, 'warning');
            if (btnElement) {
                btnElement.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-[9px] text-rose-300"></i> <span>Failed</span>';
                setTimeout(() => {
                    btnElement.innerHTML = originalHtml;
                    btnElement.disabled = false;
                    btnElement.classList.remove('opacity-75');
                }, 2000);
            }
        }
    } catch (err) {
        showNotificationToast(`Failed to trigger: ${err.message}`, 'error');
        if (btnElement) {
            btnElement.innerHTML = originalHtml;
            btnElement.disabled = false;
            btnElement.classList.remove('opacity-75');
        }
    }
}

// --- DRY-RUN PREVIEW (read-only render, sends nothing) ---
function closePreviewModal() {
    const modal = document.getElementById('previewModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function previewScheduleNow(serverId, scheduleId) {
    const modal = document.getElementById('previewModal');
    const body = document.getElementById('previewModalBody');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
    if (body) body.innerHTML = '<p class="text-discord-muted">Loading preview...</p>';

    try {
        const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/schedules/${encodeURIComponent(scheduleId)}/preview`);
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error((data && data.error) || `HTTP ${res.status}`);
        }
        const p = data.preview;
        const rows = [
            ['Server', `${escapeHtml(p.serverName)} <span class="text-discord-muted">(${escapeHtml(p.channelId)})</span>`],
            ['Schedule', escapeHtml(p.scheduleLabel)],
            ['Cron', `<span class="mono">${escapeHtml(p.cron)}</span>${p.nextFire ? ` <span class="text-discord-muted">(next: ${escapeHtml(new Date(p.nextFire).toLocaleString())})</span>` : ''}`],
            ['Mode', escapeHtml(p.attendanceType) + (p.active ? '' : ' <span class="text-amber-300">[PAUSED]</span>')],
        ];
        let html = rows.map(([k, v]) => `
            <div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-discord-card/60 border border-discord-border/60">
                <span class="text-discord-muted w-20 shrink-0 font-semibold uppercase text-[10px] pt-0.5">${k}</span>
                <span class="text-white flex-1">${v}</span>
            </div>`).join('');

        if (p.attendanceType === 'REACTION') {
            html += `
            <div class="px-3 py-2 rounded-lg bg-discord-card/60 border border-discord-border/60">
                <p class="text-discord-muted text-[10px] uppercase font-semibold mb-1">Reaction</p>
                <p class="text-white text-sm">${escapeHtml(p.emoji)} <span class="text-discord-muted">on ${escapeHtml(p.targetMessageId)}</span></p>
            </div>`;
        } else {
            html += `
            <div class="px-3 py-2 rounded-lg bg-discord-card/60 border border-discord-border/60">
                <p class="text-discord-muted text-[10px] uppercase font-semibold mb-1">Resolved message</p>
                <p class="text-white text-sm whitespace-pre-wrap">"${escapeHtml(p.resolvedBase)}"</p>
            </div>`;
            if (p.pool && p.pool.length > 0) {
                html += `<div class="px-3 py-2 rounded-lg bg-discord-card/60 border border-discord-border/60">
                    <p class="text-discord-muted text-[10px] uppercase font-semibold mb-1">Variants (${p.pool.length}, random pick at runtime)</p>` +
                    p.resolvedPool.map((m, i) => `<p class="text-white text-sm">[${i + 1}] "${escapeHtml(m)}"</p>`).join('') +
                    `</div>`;
            }
        }
        if (body) body.innerHTML = html;
    } catch (err) {
        if (body) body.innerHTML = `<p class="text-rose-400">Preview failed: ${escapeHtml(err.message)}</p>`;
    }
}

// --- THEME MANAGEMENT (DARK / LIGHT MODE) ---
function initTheme() {
    const savedTheme = localStorage.getItem('croncord_theme') || 'dark';
    applyTheme(savedTheme, false);
}

function applyTheme(theme, persist = true) {
    currentTheme = theme;
    if (persist) {
        try {
            localStorage.setItem('croncord_theme', theme);
        } catch (e) {}
    }

    if (theme === 'light') {
        document.documentElement.classList.add('light');
        document.documentElement.classList.remove('dark');
        document.body.classList.add('light');
        document.body.classList.remove('dark');
    } else {
        document.documentElement.classList.add('dark');
        document.documentElement.classList.remove('light');
        document.body.classList.add('dark');
        document.body.classList.remove('light');
    }

    updateThemeButtonUI();

    // Re-render Recharts chart so grid lines, axes, and tooltips re-render with clean contrast
    if (latestDailyData && Array.isArray(latestDailyData)) {
        renderRechartsCheckins(latestDailyData);
    }
}

function toggleTheme() {
    const isLightNow = currentTheme === 'light' || document.documentElement.classList.contains('light');
    const newTheme = isLightNow ? 'dark' : 'light';
    applyTheme(newTheme, true);
    showNotificationToast(`Switched to ${newTheme === 'light' ? 'Light' : 'Dark'} theme`, 'info');
}

function updateThemeButtonUI() {
    const btn = document.getElementById('themeToggleBtn');
    const icon = document.getElementById('themeToggleIcon');
    const text = document.getElementById('themeToggleText');
    if (!btn || !icon || !text) return;

    const isLightNow = currentTheme === 'light' || document.documentElement.classList.contains('light');
    if (isLightNow) {
        icon.className = 'fa-solid fa-moon text-indigo-500';
        text.innerText = 'Dark Mode';
        btn.setAttribute('title', 'Switch to Dark theme (Alt+T)');
    } else {
        icon.className = 'fa-solid fa-sun text-amber-400';
        text.innerText = 'Light Mode';
        btn.setAttribute('title', 'Switch to Light theme (Alt+T)');
    }
}

// --- LOG CONSOLE, ACTIVITY TRACKING & CSV EXPORT ---
function handleLogSearchInput(val) {
    logSearchQuery = (val || '').trim().toLowerCase();
    const clearBtn = document.getElementById('clearLogSearchBtn');
    if (clearBtn) {
        if (logSearchQuery) {
            clearBtn.classList.remove('hidden');
        } else {
            clearBtn.classList.add('hidden');
        }
    }
    renderFilteredLogs();
}

function handleLogLevelFilter(val) {
    logLevelFilter = val || 'ALL';
    renderFilteredLogs();
}

function clearLogSearch() {
    logSearchQuery = '';
    const input = document.getElementById('logSearchInput');
    if (input) input.value = '';
    const clearBtn = document.getElementById('clearLogSearchBtn');
    if (clearBtn) clearBtn.classList.add('hidden');
    renderFilteredLogs();
}

function isLogEntryMatching(entry) {
    if (!entry) return false;
    if (logLevelFilter !== 'ALL') {
        const lvl = (entry.level || 'INFO').toUpperCase();
        if (lvl !== logLevelFilter) return false;
    }
    if (logSearchQuery) {
        const msg = (entry.message || '').toLowerCase();
        const time = (entry.time || '').toLowerCase();
        const lvl = (entry.level || '').toLowerCase();
        if (!msg.includes(logSearchQuery) && !time.includes(logSearchQuery) && !lvl.includes(logSearchQuery)) {
            return false;
        }
    }
    return true;
}

function renderFilteredLogs() {
    const consoleEl = document.getElementById('logsConsole');
    if (!consoleEl) return;

    const filtered = currentSessionLogs.filter(isLogEntryMatching);
    const statusEl = document.getElementById('logFilterMatchStatus');
    if (statusEl) {
        if (logSearchQuery || logLevelFilter !== 'ALL') {
            statusEl.innerText = `Showing ${filtered.length} of ${currentSessionLogs.length}`;
            statusEl.classList.remove('hidden');
        } else {
            statusEl.innerText = '';
            statusEl.classList.add('hidden');
        }
    }

    consoleEl.innerHTML = '';
    if (filtered.length === 0) {
        consoleEl.innerHTML = `
            <div class="text-discord-muted py-8 text-center italic space-y-1">
                <i class="fa-solid fa-magnifying-glass text-lg opacity-40"></i>
                <p class="text-xs">No activity log entries match your search or filter criteria.</p>
            </div>
        `;
        return;
    }

    filtered.forEach(entry => appendSingleLogToDom(entry, false));

    const autoScroll = document.getElementById('autoScrollCheck');
    if (autoScroll && autoScroll.checked) {
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }
}

function appendSingleLogToDom(entry, shouldScroll = true) {
    const consoleEl = document.getElementById('logsConsole');
    if (!consoleEl) return;

    let badgeClass = 'text-blue-400 font-bold';
    if (entry.level === 'WARN') badgeClass = 'text-amber-400 font-bold';
    if (entry.level === 'ERROR') badgeClass = 'text-rose-400 font-bold';
    if (entry.level === 'SUCCESS') badgeClass = 'text-emerald-400 font-bold';

    const div = document.createElement('div');
    div.className = 'py-0.5 border-b border-discord-border/20 flex space-x-2 items-start';
    div.innerHTML = `
        <span class="text-gray-500 shrink-0 select-none">[${escapeHtml(entry.time || '')}]</span>
        <span class="${badgeClass} shrink-0">[${escapeHtml(entry.level || 'INFO')}]</span>
        <span class="text-gray-200 break-all">${escapeHtml(entry.message || '')}</span>
    `;

    consoleEl.appendChild(div);

    if (shouldScroll) {
        const autoScroll = document.getElementById('autoScrollCheck');
        if (autoScroll && autoScroll.checked) {
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }
    }
}

function setupLogStream() {
    const consoleEl = document.getElementById('logsConsole');

    // First load recent history
    fetch('/api/logs')
        .then(r => r.json())
        .then(data => {
            if (data.logs && data.logs.length > 0) {
                currentSessionLogs = data.logs.slice();
                renderFilteredLogs();
                updateSessionLogCounter();
            }
        })
        .catch(() => {});

    // Hook up SSE stream
    try {
        const eventSource = new EventSource('/api/logs/stream');
        eventSource.onmessage = (e) => {
            try {
                const entry = JSON.parse(e.data);
                currentSessionLogs.push(entry);
                updateSessionLogCounter();

                if (isLogEntryMatching(entry)) {
                    appendSingleLogToDom(entry, true);
                }

                const statusEl = document.getElementById('logFilterMatchStatus');
                if (statusEl && (logSearchQuery || logLevelFilter !== 'ALL')) {
                    const filtered = currentSessionLogs.filter(isLogEntryMatching);
                    statusEl.innerText = `Showing ${filtered.length} of ${currentSessionLogs.length}`;
                }

                // Trigger local desktop notification on successful task completion
                if (entry && (entry.level === 'SUCCESS' || (entry.message && (
                    entry.message.includes('Message posted successfully') ||
                    entry.message.includes('Reacted with') ||
                    entry.message.includes('Attendance task executed live')
                )))) {
                    triggerLocalSystemAlert({
                        title: '⚡ Attendance Task Completed',
                        body: entry.message || 'Attendance routine successfully executed.'
                    });
                    // Also refresh stats chart & health
                    fetchDailyCheckinStats();
                }
            } catch (err) {
                // Ignore parse errors
            }
        };
        eventSource.onerror = () => {
            // Reconnect handled automatically by browser
        };
    } catch (e) {
        console.warn('SSE not supported, falling back to polling');
        setInterval(() => {
            fetch('/api/logs').then(r => r.json()).then(data => {
                if (data.logs) {
                    currentSessionLogs = data.logs.slice();
                    renderFilteredLogs();
                    updateSessionLogCounter();
                }
            });
        }, 3000);
    }
}

function appendLogEntryToDom(entry) {
    if (isLogEntryMatching(entry)) {
        appendSingleLogToDom(entry, true);
    }
}

// Backward compatibility alias
function appendLogEntry(entry) {
    currentSessionLogs.push(entry);
    appendLogEntryToDom(entry);
    updateSessionLogCounter();
}

function updateSessionLogCounter() {
    const badge = document.getElementById('logSessionCountBadge');
    if (badge) {
        const count = currentSessionLogs.length;
        badge.innerText = `${count} log${count === 1 ? '' : 's'}`;
        badge.setAttribute('title', `${count} activity log entries captured during current session`);
    }
}

async function clearLogs() {
    try {
        await fetch('/api/logs/clear', { method: 'POST' });
        currentSessionLogs = [];
        updateSessionLogCounter();
        renderFilteredLogs();
        showNotificationToast('Session activity logs cleared.', 'info');
    } catch (err) {
        console.warn('Failed to clear logs on server:', err && err.message ? err.message : err);
        showNotificationToast('Unable to clear server logs at this time', 'warning');
    }
}

// --- CSV LOG EXPORT ---
function exportLogsToCsv() {
    let logs = (currentSessionLogs && currentSessionLogs.length > 0)
        ? currentSessionLogs
        : extractLogsFromDom();

    if (!logs || logs.length === 0) {
        showNotificationToast('No activity logs in current session to export.', 'warning');
        return;
    }

    const escapeCsv = (val) => {
        if (val === null || val === undefined) return '""';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
    };

    const headers = ['Entry #', 'Timestamp', 'Level', 'Message'];
    const rows = logs.map((log, index) => [
        index + 1,
        escapeCsv(log.time || new Date().toLocaleTimeString()),
        escapeCsv(log.level || 'INFO'),
        escapeCsv(log.message || '')
    ].join(','));

    // Prepend UTF-8 BOM (\uFEFF) for immediate compatibility with Excel & spreadsheet viewers
    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    link.download = `croncord-session-logs-${timestamp}.csv`;
    document.body.appendChild(link);
    link.click();

    setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }, 250);

    showNotificationToast(`Exported ${logs.length} session logs to CSV!`, 'success');
}

function extractLogsFromDom() {
    const consoleEl = document.getElementById('logsConsole');
    if (!consoleEl) return [];

    const lines = consoleEl.querySelectorAll('div');
    const extracted = [];
    lines.forEach(line => {
        const spans = line.querySelectorAll('span');
        if (spans.length >= 3) {
            const timeRaw = spans[0].innerText.replace(/^\[|\]$/g, '').trim();
            const levelRaw = spans[1].innerText.replace(/^\[|\]$/g, '').trim();
            const msgRaw = spans[2].innerText.trim();
            if (msgRaw) {
                extracted.push({ time: timeRaw, level: levelRaw, message: msgRaw });
            }
        }
    });
    return extracted;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// --- INTERACTIVE CLI TERMINAL ENGINE ---
let cliCommandHistory = [];
let cliHistoryIndex = -1;

function initCliTerminalShortcuts() {
    const input = document.getElementById('cliTerminalInput');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (cliCommandHistory.length === 0) return;
                if (cliHistoryIndex === -1) {
                    cliHistoryIndex = cliCommandHistory.length - 1;
                } else if (cliHistoryIndex > 0) {
                    cliHistoryIndex--;
                }
                input.value = cliCommandHistory[cliHistoryIndex] || '';
                input.selectionStart = input.selectionEnd = input.value.length;
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (cliHistoryIndex === -1) return;
                if (cliHistoryIndex < cliCommandHistory.length - 1) {
                    cliHistoryIndex++;
                    input.value = cliCommandHistory[cliHistoryIndex] || '';
                } else {
                    cliHistoryIndex = -1;
                    input.value = '';
                }
                input.selectionStart = input.selectionEnd = input.value.length;
            }
        });
    }

    initCliTerminalSkin();
}

function initCliTerminalSkin() {
    const win = document.getElementById('cliTerminalWindow');
    if (!win) return;
    const savedSkin = localStorage.getItem('croncord_terminal_skin');
    if (savedSkin === 'dark') {
        win.classList.add('force-dark-terminal');
    } else if (savedSkin === 'light') {
        win.classList.remove('force-dark-terminal');
    }
}

function toggleCliTerminalSkin() {
    const win = document.getElementById('cliTerminalWindow');
    if (!win) return;
    const isForcedDark = win.classList.contains('force-dark-terminal');
    if (isForcedDark) {
        win.classList.remove('force-dark-terminal');
        localStorage.setItem('croncord_terminal_skin', 'light');
        showNotificationToast('Terminal switched to light appearance', 'info');
    } else {
        win.classList.add('force-dark-terminal');
        localStorage.setItem('croncord_terminal_skin', 'dark');
        showNotificationToast('Terminal switched to dark appearance', 'info');
    }
}

function addCommandToHistory(cmd) {
    if (!cmd || typeof cmd !== 'string') return;
    const trimmed = cmd.trim();
    if (!trimmed) return;

    // Deduplicate: remove if exists earlier so latest occurrence is at the end of the history array (and top of drop-up)
    const existingIndex = cliCommandHistory.indexOf(trimmed);
    if (existingIndex !== -1) {
        cliCommandHistory.splice(existingIndex, 1);
    }
    cliCommandHistory.push(trimmed);

    // Keep history capped at 50 commands
    if (cliCommandHistory.length > 50) {
        cliCommandHistory.shift();
    }

    try {
        localStorage.setItem('croncord_cli_history', JSON.stringify(cliCommandHistory));
    } catch (e) {}

    renderCliHistoryDropup();
}

document.addEventListener('DOMContentLoaded', () => {
    initCliTerminalShortcuts();
    initCliHelpPopover();
    initCliHistory();
});

async function handleCliTerminalSubmit(e) {
    if (e) e.preventDefault();
    const input = document.getElementById('cliTerminalInput');
    if (!input) return;
    const cmd = input.value.trim();
    if (!cmd) return;

    closeCliHistoryDropup();
    addCommandToHistory(cmd);
    cliHistoryIndex = -1;
    input.value = '';

    await executeCliCommand(cmd);
}

async function runCliChip(cmd) {
    switchTab('cli');
    const input = document.getElementById('cliTerminalInput');
    if (input) {
        input.value = cmd;
    }
    closeCliHistoryDropup();
    addCommandToHistory(cmd);
    cliHistoryIndex = -1;
    await executeCliCommand(cmd);
}

async function executeCliCommand(commandLine) {
    const terminalOutput = document.getElementById('cliTerminalOutput');
    const submitBtn = document.getElementById('cliSubmitBtn');

    if (!terminalOutput) return;

    // Render User Command Prompt
    const cmdEl = document.createElement('div');
    cmdEl.className = 'cli-cmd-line mt-2 pt-1 border-t border-zinc-800/80 flex items-start gap-1.5';
    cmdEl.innerHTML = `
        <span class="cli-prompt text-emerald-400 font-bold select-none">croncord:~$</span>
        <span class="cli-cmd-text font-semibold">${escapeHtml(commandLine)}</span>
    `;
    terminalOutput.appendChild(cmdEl);

    // Disable button temporarily
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    try {
        const res = await fetch('/api/cli/exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: commandLine })
        });

        const data = await res.json();

        if (data.isClear) {
            terminalOutput.innerHTML = `
                <div class="text-emerald-400 font-bold">⚡ Terminal Cleared</div>
                <div class="text-zinc-500 text-[11px] pb-2 border-b border-zinc-800">Connected to live spinning server. Type <span class="text-discord-blurple font-bold">help</span> for commands.</div>
            `;
        } else {
            const outEl = document.createElement('div');
            outEl.className = data.success ? 'cli-output-text whitespace-pre-wrap' : 'cli-error-text whitespace-pre-wrap';
            outEl.textContent = data.output || '(No output)';
            terminalOutput.appendChild(outEl);
        }

        // Auto-refresh config and status if mutation command executed
        const lower = commandLine.toLowerCase();
        if (
            lower.startsWith('server') ||
            lower.startsWith('schedule') ||
            lower.startsWith('start') ||
            lower.startsWith('stop') ||
            lower.startsWith('restart') ||
            lower.startsWith('token') ||
            lower.startsWith('webhook') ||
            lower.startsWith('trigger')
        ) {
            await fetchConfig();
            await fetchStatus();
        }
    } catch (err) {
        const errEl = document.createElement('div');
        errEl.className = 'cli-error-text text-rose-400';
        errEl.textContent = `❌ CLI Communication Error: ${err.message}`;
        terminalOutput.appendChild(errEl);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'Run';
        }
        // Auto scroll to bottom
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
        const input = document.getElementById('cliTerminalInput');
        if (input) input.focus();
    }
}

function clearCliTerminal() {
    const terminalOutput = document.getElementById('cliTerminalOutput');
    if (terminalOutput) {
        terminalOutput.innerHTML = `
            <div class="text-emerald-400 font-bold">⚡ Terminal Cleared</div>
            <div class="text-zinc-500 text-[11px] pb-2 border-b border-zinc-800">Connected to live spinning server. Type <span class="text-discord-blurple font-bold">help</span> for commands.</div>
        `;
    }
    const input = document.getElementById('cliTerminalInput');
    if (input) input.focus();
}

function copyCliTerminalOutput() {
    const terminalOutput = document.getElementById('cliTerminalOutput');
    if (!terminalOutput) return;
    const text = terminalOutput.innerText;
    navigator.clipboard.writeText(text).then(() => {
        showNotificationToast('Terminal output copied to clipboard!', 'success');
    }).catch(() => {
        showNotificationToast('Failed to copy to clipboard', 'warning');
    });
}

// ============================================================================
// CLI TERMINAL COMMANDS QUICK REFERENCE POPOVER
// ============================================================================

const CLI_COMMANDS_REFERENCE = [
    {
        cmd: 'status',
        category: 'Daemon',
        desc: 'Show daemon state, uptime, connected Discord account, and active watchers',
        autoRun: true
    },
    {
        cmd: 'start',
        category: 'Daemon',
        desc: 'Start background Discord attendance daemon scheduler',
        autoRun: true
    },
    {
        cmd: 'stop',
        category: 'Daemon',
        desc: 'Stop background Discord attendance daemon safely',
        autoRun: true
    },
    {
        cmd: 'restart',
        category: 'Daemon',
        desc: 'Restart daemon and re-register all server cron watchers',
        autoRun: true
    },
    {
        cmd: 'uptime',
        category: 'Diagnostics',
        desc: 'View daemon execution reliability, check-ins count, and process uptime',
        autoRun: true
    },
    {
        cmd: 'list',
        category: 'Servers',
        desc: 'List all configured server profiles, channels, and schedule timers',
        autoRun: true
    },
    {
        cmd: 'server add <name> <chanId> [cron] [msg]',
        template: 'server add "New Server" 1234567890 "0 9 * * 1-5" "Present"',
        category: 'Servers',
        desc: 'Create a new server profile with channel ID and optional schedule',
        autoRun: false
    },
    {
        cmd: 'server edit <id> [name] [chan] [hook]',
        template: 'server edit 1 "Updated Name" 1234567890',
        category: 'Servers',
        desc: 'Update existing server name, target channel, or webhook URL',
        autoRun: false
    },
    {
        cmd: 'server toggle <id|name>',
        template: 'server toggle 1',
        category: 'Servers',
        desc: 'Pause or resume monitoring for a specific server profile',
        autoRun: false
    },
    {
        cmd: 'server ignore-holidays <id> on|off',
        template: 'server ignore-holidays 1 off',
        category: 'Servers',
        desc: 'Opt a server out of (or back into) holiday skip dates (v3.9)',
        autoRun: false
    },
    {
        cmd: 'server delete <id|name>',
        template: 'server delete 1',
        category: 'Servers',
        desc: 'Permanently remove a server profile and its routines',
        autoRun: false
    },
    {
        cmd: 'server enable-all',
        category: 'Servers',
        desc: 'Bulk activate monitoring for all configured servers',
        autoRun: true
    },
    {
        cmd: 'server disable-all',
        category: 'Servers',
        desc: 'Bulk pause monitoring for all configured servers',
        autoRun: true
    },
    {
        cmd: 'schedule add <srvId> <cron> [msg]',
        template: 'schedule add 1 "0 9 * * 1-5" "Present"',
        category: 'Schedules',
        desc: 'Add a new cron attendance schedule routine to a server',
        autoRun: false
    },
    {
        cmd: 'schedule list <srvId>',
        template: 'schedule list 1',
        category: 'Schedules',
        desc: 'Display all schedule routines for a target server profile',
        autoRun: false
    },
    {
        cmd: 'schedule toggle <srvId> <schedId>',
        template: 'schedule toggle 1 1',
        category: 'Schedules',
        desc: 'Pause or resume an individual attendance routine',
        autoRun: false
    },
    {
        cmd: 'schedule delete <srvId> <schedId>',
        template: 'schedule delete 1 1',
        category: 'Schedules',
        desc: 'Remove an individual attendance routine from a server',
        autoRun: false
    },
    {
        cmd: 'schedule duplicate <srvId> <schedId>',
        template: 'schedule duplicate 1 1',
        category: 'Schedules',
        desc: 'Copy a routine with a fresh ID (starts paused)',
        autoRun: false
    },
    {
        cmd: 'schedule reorder <srvId> <id1,id2>',
        template: 'schedule reorder 1 2,1',
        category: 'Schedules',
        desc: 'Update priority execution sequence for server routines',
        autoRun: false
    },
    {
        cmd: 'schedule conflicts <srvId>',
        template: 'schedule conflicts 1',
        category: 'Schedules',
        desc: 'Show ≤5-minute clash warnings between routines (v3.9)',
        autoRun: true
    },
    {
        cmd: 'schedule pool <srvId> <schedId> [set|clear]',
        template: 'schedule pool 1 1',
        category: 'Schedules',
        desc: 'View or set rotating message variants for a routine (v3.9)',
        autoRun: false
    },
    {
        cmd: 'schedule enable-all <srvId>',
        template: 'schedule enable-all 1',
        category: 'Schedules',
        desc: 'Enable every routine on a server at once',
        autoRun: false
    },
    {
        cmd: 'schedule disable-all <srvId>',
        template: 'schedule disable-all 1',
        category: 'Schedules',
        desc: 'Pause every routine on a server at once',
        autoRun: false
    },
    {
        cmd: 'server clone <id> <name> <chanId>',
        template: 'server clone 1 "Copy" 1234567890123456789',
        category: 'Servers',
        desc: 'Duplicate a server profile with fresh schedule IDs',
        autoRun: false
    },
    {
        cmd: 'preview <serverId> [scheduleId]',
        template: 'preview 1',
        category: 'Actions',
        desc: 'Dry-run: show resolved post text without sending anything',
        autoRun: true
    },
    {
        cmd: 'upcoming [count]',
        template: 'upcoming 10',
        category: 'Planning',
        desc: 'Preview next scheduled fire times across servers (v3.9)',
        autoRun: true
    },
    {
        cmd: 'quiet [HH:MM HH:MM|clear]',
        template: 'quiet 22:00 07:00',
        category: 'Planning',
        desc: 'View, set, or clear the global quiet-hours window (v3.9)',
        autoRun: false
    },
    {
        cmd: 'holiday list|add|remove',
        template: 'holiday add 2026-12-25 "Christmas Day"',
        category: 'Planning',
        desc: 'Manage named intentional skip dates (v3.9)',
        autoRun: false
    },
    {
        cmd: 'vacation [date] [note]|off',
        template: 'vacation 2026-12-20 "Trip"',
        category: 'Planning',
        desc: 'Pause everything until a date, auto-resumes after',
        autoRun: false
    },
    {
        cmd: 'calendar [YYYY-MM]',
        template: 'calendar 2026-10',
        category: 'Planning',
        desc: 'Monthly firing calendar with marked days',
        autoRun: true
    },
    {
        cmd: 'heartbeat [url] [mins]|test|off',
        template: 'heartbeat https://hc-ping.com/abc 15',
        category: 'Planning',
        desc: 'External monitor pings for silent-outage alerts',
        autoRun: false
    },
    {
        cmd: 'digest [on|off|test]',
        template: 'digest test',
        category: 'Planning',
        desc: 'Weekly webhook stats summary: configure or send now',
        autoRun: false
    },
    {
        cmd: 'backups',
        category: 'Config',
        desc: 'List automatic config restore points (v3.9)',
        autoRun: true
    },
    {
        cmd: 'restore <file>',
        template: 'restore ',
        category: 'Config',
        desc: 'Roll back to a restore-point snapshot (v3.9)',
        autoRun: false
    },
    {
        cmd: 'trigger <serverId> [scheduleId]',
        template: 'trigger 1',
        category: 'Actions',
        desc: 'Immediately dispatch manual attendance check-in test run',
        autoRun: false
    },
    {
        cmd: 'logs [count]',
        template: 'logs 15',
        category: 'Logs',
        desc: 'View recent session logs (e.g. logs 15, logs 50)',
        autoRun: false
    },
    {
        cmd: 'logs clear',
        category: 'Logs',
        desc: 'Clear memory log buffer from current daemon session',
        autoRun: true
    },
    {
        cmd: 'token [new_token]',
        template: 'token ',
        category: 'Credentials',
        desc: 'Inspect or update Discord user authorization token',
        autoRun: false
    },
    {
        cmd: 'webhook [url]',
        template: 'webhook ',
        category: 'Credentials',
        desc: 'Inspect or update global Discord notification webhook',
        autoRun: false
    },
    {
        cmd: 'webhook test [url]',
        template: 'webhook test',
        category: 'Credentials',
        desc: 'Send a diagnostic embed alert to test webhook delivery',
        autoRun: true
    },
    {
        cmd: 'backup',
        category: 'Config',
        desc: 'Export complete configuration JSON with schema conformity',
        autoRun: true
    },
    {
        cmd: 'validate <file.json>',
        template: 'validate config.json',
        category: 'Config',
        desc: 'Validate JSON configuration schema file for errors',
        autoRun: false
    },
    {
        cmd: 'clear',
        category: 'Terminal',
        desc: 'Clear terminal screen output window',
        autoRun: true
    },
    {
        cmd: 'help [topic]',
        template: 'help',
        category: 'Terminal',
        desc: 'Display interactive terminal manual or command details',
        autoRun: true
    }
];

function initCliHelpPopover() {
    renderCliHelpCommands(CLI_COMMANDS_REFERENCE);

    // Global click listener to close popover when clicking outside
    document.addEventListener('click', (e) => {
        const popover = document.getElementById('cliHelpPopover');
        const btn = document.getElementById('cliHelpPopoverBtn');
        if (!popover || popover.classList.contains('hidden')) return;

        if (!popover.contains(e.target) && !btn?.contains(e.target)) {
            closeCliHelpPopover();
        }
    });

    // Escape key to close popover
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const popover = document.getElementById('cliHelpPopover');
            if (popover && !popover.classList.contains('hidden')) {
                closeCliHelpPopover();
            }
        }
    });
}

function toggleCliHelpPopover(event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const popover = document.getElementById('cliHelpPopover');
    const btn = document.getElementById('cliHelpPopoverBtn');
    if (!popover) return;

    if (popover.classList.contains('hidden')) {
        closeCliHistoryDropup();
        popover.classList.remove('hidden');
        btn?.setAttribute('aria-expanded', 'true');
        btn?.classList.add('bg-discord-card', 'text-white', 'border-discord-border');
        const searchInput = document.getElementById('cliHelpSearchInput');
        if (searchInput) {
            searchInput.value = '';
            clearCliHelpSearch(false);
            setTimeout(() => searchInput.focus(), 50);
        }
    } else {
        closeCliHelpPopover();
    }
}

function closeCliHelpPopover() {
    const popover = document.getElementById('cliHelpPopover');
    const btn = document.getElementById('cliHelpPopoverBtn');
    if (!popover) return;
    popover.classList.add('hidden');
    btn?.setAttribute('aria-expanded', 'false');
    btn?.classList.remove('bg-discord-card', 'text-white', 'border-discord-border');
}

function clearCliHelpSearch(focus = true) {
    const searchInput = document.getElementById('cliHelpSearchInput');
    const clearBtn = document.getElementById('cliHelpClearSearchBtn');
    if (searchInput) {
        searchInput.value = '';
        if (focus) searchInput.focus();
    }
    if (clearBtn) clearBtn.classList.add('hidden');
    renderCliHelpCommands(CLI_COMMANDS_REFERENCE);
}

function filterCliHelpCommands(query) {
    const clearBtn = document.getElementById('cliHelpClearSearchBtn');
    const q = (query || '').trim().toLowerCase();
    if (clearBtn) {
        if (q) clearBtn.classList.remove('hidden');
        else clearBtn.classList.add('hidden');
    }

    if (!q) {
        renderCliHelpCommands(CLI_COMMANDS_REFERENCE);
        return;
    }

    const filtered = CLI_COMMANDS_REFERENCE.filter((item) => {
        return (
            item.cmd.toLowerCase().includes(q) ||
            item.category.toLowerCase().includes(q) ||
            item.desc.toLowerCase().includes(q) ||
            (item.template && item.template.toLowerCase().includes(q))
        );
    });

    renderCliHelpCommands(filtered, q);
}

function renderCliHelpCommands(list, query = '') {
    const container = document.getElementById('cliHelpCommandsList');
    if (!container) return;

    if (!list || list.length === 0) {
        container.innerHTML = `
            <div class="p-4 text-center text-discord-muted space-y-1">
                <i class="fa-solid fa-circle-exclamation text-amber-400 text-sm"></i>
                <p class="text-xs font-medium">No matching commands found for "${escapeHtml(query)}"</p>
                <p class="text-[11px]">Try searching "status", "server", "schedule", or "logs"</p>
            </div>
        `;
        return;
    }

    const categoryBadgeColors = {
        Daemon: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
        Servers: 'bg-discord-blurple/15 text-indigo-300 border-discord-blurple/30',
        Schedules: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
        Actions: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
        Logs: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
        Credentials: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
        Config: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
        Diagnostics: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
        Terminal: 'bg-zinc-600/15 text-zinc-300 border-zinc-600/30'
    };

    let html = '';
    list.forEach((item) => {
        const badgeClass = categoryBadgeColors[item.category] || 'bg-discord-card text-discord-muted border-discord-border';
        const targetCommand = item.template || item.cmd;
        const safeTargetCmd = escapeHtml(targetCommand);
        const safeCmdDisplay = escapeHtml(item.cmd);
        const safeDesc = escapeHtml(item.desc);

        html += `
            <div class="cli-help-cmd-item group p-2 rounded-lg hover:bg-discord-card/70 transition cursor-pointer flex flex-col gap-1 border border-transparent hover:border-discord-border/50" onclick="insertCliHelpCommand('${safeTargetCmd}', ${item.autoRun})">
                <div class="flex items-center justify-between gap-1.5">
                    <span class="font-mono font-bold text-xs text-white group-hover:text-emerald-400 transition flex items-center gap-1">
                        <span class="text-discord-blurple font-semibold text-[11px] select-none">&gt;</span>
                        <code>${safeCmdDisplay}</code>
                    </span>
                    <span class="text-[9px] font-semibold px-1.5 py-0.5 rounded border uppercase tracking-wider ${badgeClass}">
                        ${escapeHtml(item.category)}
                    </span>
                </div>
                <p class="text-[11px] text-discord-muted leading-tight">${safeDesc}</p>
                <div class="flex items-center justify-between text-[10px] text-discord-muted/70 pt-0.5 opacity-0 group-hover:opacity-100 transition">
                    <span class="font-mono text-zinc-400">Insert: ${safeTargetCmd}</span>
                    <span class="text-discord-blurple font-semibold flex items-center gap-0.5">
                        ${item.autoRun ? '<i class="fa-solid fa-play text-[8px]"></i> Click to run' : '<i class="fa-solid fa-arrow-turn-down text-[8px]"></i> Click to insert'}
                    </span>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function insertCliHelpCommand(cmd, autoRun = false) {
    switchTab('cli');
    const input = document.getElementById('cliTerminalInput');
    if (input) {
        input.value = cmd;
        input.focus();
    }
    closeCliHelpPopover();
    closeCliHistoryDropup();

    if (autoRun && cmd && !cmd.includes('<') && !cmd.includes('[')) {
        addCommandToHistory(cmd);
        cliHistoryIndex = -1;
        executeCliCommand(cmd);
    } else {
        showNotificationToast(`Inserted "${cmd}" into terminal`, 'info');
    }
}

// =========================================================================
// CLI COMMAND HISTORY DROP-UP CONTROLLER
// =========================================================================

function initCliHistory() {
    try {
        const stored = localStorage.getItem('croncord_cli_history');
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) {
                cliCommandHistory = parsed;
            } else {
                cliCommandHistory = ['status', 'list'];
            }
        } else {
            cliCommandHistory = ['status', 'list'];
            try {
                localStorage.setItem('croncord_cli_history', JSON.stringify(cliCommandHistory));
            } catch (e) {}
        }
    } catch (e) {
        cliCommandHistory = ['status', 'list'];
    }

    renderCliHistoryDropup();

    // Close on outside click
    document.addEventListener('click', (e) => {
        const dropup = document.getElementById('cliHistoryDropup');
        const btn = document.getElementById('cliHistoryDropupBtn');
        if (!dropup || dropup.classList.contains('hidden')) return;

        if (!dropup.contains(e.target) && !btn?.contains(e.target)) {
            closeCliHistoryDropup();
        }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const dropup = document.getElementById('cliHistoryDropup');
            if (dropup && !dropup.classList.contains('hidden')) {
                closeCliHistoryDropup();
            }
        }
    });
}

function toggleCliHistoryDropup(event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const dropup = document.getElementById('cliHistoryDropup');
    const btn = document.getElementById('cliHistoryDropupBtn');
    const icon = document.getElementById('cliHistoryArrowIcon');
    if (!dropup) return;

    if (dropup.classList.contains('hidden')) {
        closeCliHelpPopover();
        renderCliHistoryDropup();
        dropup.classList.remove('hidden');
        btn?.setAttribute('aria-expanded', 'true');
        btn?.classList.add('text-discord-blurple');
        if (icon) {
            icon.classList.add('rotate-180', 'text-discord-blurple');
        }
    } else {
        closeCliHistoryDropup();
    }
}

function closeCliHistoryDropup() {
    const dropup = document.getElementById('cliHistoryDropup');
    const btn = document.getElementById('cliHistoryDropupBtn');
    const icon = document.getElementById('cliHistoryArrowIcon');
    if (!dropup) return;

    dropup.classList.add('hidden');
    btn?.setAttribute('aria-expanded', 'false');
    btn?.classList.remove('text-discord-blurple');
    if (icon) {
        icon.classList.remove('rotate-180', 'text-discord-blurple');
    }
}

function renderCliHistoryDropup() {
    const listEl = document.getElementById('cliHistoryItemsList');
    const badgeEl = document.getElementById('cliHistoryCountBadge');
    if (!listEl) return;

    if (badgeEl) {
        badgeEl.textContent = `${cliCommandHistory.length} ${cliCommandHistory.length === 1 ? 'command' : 'commands'}`;
    }

    if (cliCommandHistory.length === 0) {
        listEl.innerHTML = `
            <div class="p-4 text-center text-discord-muted space-y-1.5 select-none">
                <i class="fa-solid fa-clock-rotate-left text-discord-blurple/60 text-lg"></i>
                <p class="text-xs font-semibold text-white/90">No command history yet</p>
                <p class="text-[11px] text-discord-muted">Commands you run will appear here for fast re-execution.</p>
                <div class="pt-2 flex flex-wrap justify-center gap-1.5">
                    <button type="button" onclick="selectAndRunCliHistoryCommand('status')" class="px-2.5 py-1 rounded bg-discord-card hover:bg-discord-border text-discord-text text-[11px] border border-discord-border cursor-pointer">
                        <i class="fa-solid fa-play text-[9px] text-emerald-400 mr-1"></i>Run status
                    </button>
                    <button type="button" onclick="selectAndRunCliHistoryCommand('list')" class="px-2.5 py-1 rounded bg-discord-card hover:bg-discord-border text-discord-text text-[11px] border border-discord-border cursor-pointer">
                        <i class="fa-solid fa-play text-[9px] text-emerald-400 mr-1"></i>Run list
                    </button>
                </div>
            </div>
        `;
        return;
    }

    // Show most recently executed commands at top
    const reversed = [...cliCommandHistory].reverse();
    let html = '';
    reversed.forEach((cmd) => {
        const safeCmd = escapeHtml(cmd);
        html += `
            <div class="cli-history-item group px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 hover:bg-discord-card/80 transition cursor-pointer border border-transparent hover:border-discord-border/50" onclick="selectCliHistoryCommand('${safeCmd}')">
                <div class="flex items-center gap-2 min-w-0 flex-1">
                    <span class="text-discord-blurple font-bold select-none text-[11px] shrink-0">&gt;</span>
                    <span class="font-mono text-xs text-white group-hover:text-emerald-400 transition truncate" title="${safeCmd}">${safeCmd}</span>
                </div>
                <div class="flex items-center gap-1.5 shrink-0" onclick="event.stopPropagation()">
                    <button
                        type="button"
                        onclick="selectCliHistoryCommand('${safeCmd}')"
                        title="Fill command into prompt"
                        class="px-2 py-0.5 rounded text-[10px] text-discord-muted hover:text-white bg-discord-dark hover:bg-discord-card border border-discord-border/50 transition cursor-pointer"
                    >
                        Select
                    </button>
                    <button
                        type="button"
                        onclick="selectAndRunCliHistoryCommand('${safeCmd}')"
                        title="Re-run command immediately"
                        class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 hover:bg-emerald-500 text-emerald-400 hover:text-white border border-emerald-500/30 transition flex items-center gap-1 cursor-pointer"
                    >
                        <i class="fa-solid fa-play text-[8px]"></i>
                        <span>Re-run</span>
                    </button>
                    <button
                        type="button"
                        onclick="removeCliHistoryItem('${safeCmd}', event)"
                        title="Remove from history"
                        class="text-discord-muted/60 hover:text-rose-400 p-1 rounded hover:bg-discord-card transition cursor-pointer opacity-0 group-hover:opacity-100"
                    >
                        <i class="fa-solid fa-xmark text-[10px]"></i>
                    </button>
                </div>
            </div>
        `;
    });

    listEl.innerHTML = html;
}

function selectCliHistoryCommand(cmd) {
    switchTab('cli');
    const input = document.getElementById('cliTerminalInput');
    if (input) {
        input.value = cmd;
        input.focus();
        input.selectionStart = input.selectionEnd = input.value.length;
    }
    closeCliHistoryDropup();
    showNotificationToast(`Selected "${cmd}"`, 'info');
}

async function selectAndRunCliHistoryCommand(cmd) {
    switchTab('cli');
    const input = document.getElementById('cliTerminalInput');
    if (input) {
        input.value = cmd;
    }
    closeCliHistoryDropup();
    addCommandToHistory(cmd);
    cliHistoryIndex = -1;
    await executeCliCommand(cmd);
}

function removeCliHistoryItem(cmd, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const idx = cliCommandHistory.indexOf(cmd);
    if (idx !== -1) {
        cliCommandHistory.splice(idx, 1);
        try {
            localStorage.setItem('croncord_cli_history', JSON.stringify(cliCommandHistory));
        } catch (e) {}
        renderCliHistoryDropup();
        showNotificationToast(`Removed "${cmd}" from history`, 'info');
    }
}

function clearCliHistory(event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    cliCommandHistory = [];
    cliHistoryIndex = -1;
    try {
        localStorage.removeItem('croncord_cli_history');
    } catch (e) {}
    renderCliHistoryDropup();
    showNotificationToast('Command history cleared', 'info');
}

// Expose handlers globally
window.toggleCliHistoryDropup = toggleCliHistoryDropup;
window.closeCliHistoryDropup = closeCliHistoryDropup;
window.selectCliHistoryCommand = selectCliHistoryCommand;
window.selectAndRunCliHistoryCommand = selectAndRunCliHistoryCommand;
window.removeCliHistoryItem = removeCliHistoryItem;
window.clearCliHistory = clearCliHistory;


