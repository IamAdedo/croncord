const express = require('express');
const path = require('path');
const fs = require('fs');
const daemonManager = require('./src/daemonManager');
const logger = require('./src/logger');
const attendanceHistory = require('./src/attendanceHistory');
const CliEngine = require('./src/cliEngine');
const { VERSION, DISPLAY_VERSION } = require('./src/version');

const { validateConfigSchema } = require('./src/schemaValidator');
const { analyzeServerScheduleConflicts } = require('./src/scheduleConflicts');
const { getUpcomingRuns } = require('./src/upcoming');
const configBackups = require('./src/configBackups');
const suppression = require('./src/suppression');
const { validatePool } = require('./src/messageTemplates');

const app = express();

// Force primary base port to 3271 and prevent conflicts by never using port 3000
const PRIMARY_BASE_PORT = 3271;
const PORT = PRIMARY_BASE_PORT;
const HOST = '0.0.0.0';

const cliEngine = new CliEngine({ daemonManager, logger, attendanceHistory });

// Bidirectional hot-sync: Watch config.json for external CLI or editor changes
const CONFIG_FILE_PATH = path.join(__dirname, 'config.json');
let configWatchDebounce = null;
if (fs.existsSync(CONFIG_FILE_PATH)) {
    fs.watchFile(CONFIG_FILE_PATH, { interval: 1000 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) {
            clearTimeout(configWatchDebounce);
            configWatchDebounce = setTimeout(() => {
                daemonManager.reloadConfigFromDisk();
                // Pick up heartbeat arm/disarm made from the CLI without a restart.
                try { restartHeartbeatTimer(); } catch (e) { /* non-fatal */ }
            }, 300);
        }
    });
}

// CORS and security headers for iframe / dev environment proxying
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

// Dynamic template injection for global version consistency
app.get(['/', '/index.html'], (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(indexPath, 'utf8', (err, html) => {
        if (err) return res.sendFile(indexPath);
        const rendered = html
            .replace(/\{\{APP_VERSION\}\}/g, DISPLAY_VERSION)
            .replace(/\{\{RAW_VERSION\}\}/g, VERSION);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(rendered);
    });
});

app.use(express.static(path.join(__dirname, 'public')));

// --- REST API Endpoints ---

// Get daemon and application status with global version
app.get('/api/status', (req, res) => {
    try {
        const status = daemonManager.getStatus();
        res.json({
            ...status,
            version: VERSION,
            displayVersion: DISPLAY_VERSION
        });
    } catch (err) {
        logger.error(`Error in /api/status: ${err.message}`);
        res.status(500).json({ error: 'Failed to retrieve status', details: err.message });
    }
});

// Dedicated global version endpoint
app.get('/api/version', (req, res) => {
    res.json({
        app: 'Croncord',
        version: VERSION,
        displayVersion: DISPLAY_VERSION
    });
});

// Lightweight health probe for external monitors (cheap: no history recompute)
app.get('/api/health', (req, res) => {
    const daemonStatus = daemonManager.status;
    res.json({
        ok: true,
        app: 'Croncord',
        version: VERSION,
        time: new Date().toISOString(),
        daemon: daemonStatus,
        uptime: daemonManager.startedAt ? Math.floor((Date.now() - daemonManager.startedAt) / 1000) : 0,
        activeJobs: daemonManager.activeJobs.length,
        servers: (daemonManager.getConfig().servers || []).length,
    });
});

// --- Heartbeat pings (optional external monitoring) ---
const heartbeatState = { lastPingAt: null, lastStatus: null, lastError: null, timer: null };

function heartbeatPayload() {
    return {
        app: 'croncord',
        version: VERSION,
        status: daemonManager.status,
        uptime: daemonManager.startedAt ? Math.floor((Date.now() - daemonManager.startedAt) / 1000) : 0,
        activeJobs: daemonManager.activeJobs.length,
        time: new Date().toISOString(),
    };
}

function sendHeartbeatPing(targetUrl) {
    return new Promise((resolve) => {
        let url;
        try {
            url = new URL(targetUrl);
        } catch (e) {
            return resolve({ ok: false, error: 'Invalid heartbeat URL.' });
        }
        const payload = heartbeatPayload();
        Object.keys(payload).forEach((k) => url.searchParams.set(k, String(payload[k])));
        const lib = url.protocol === 'https:' ? require('https') : require('http');
        const req = lib.get(url, { timeout: 8000 }, (res) => {
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            res.resume();
            resolve({ ok, statusCode: res.statusCode });
        });
        req.on('error', (err) => resolve({ ok: false, error: err.message }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, error: 'Heartbeat ping timed out.' });
        });
    });
}

async function runHeartbeatOnce(reason = 'scheduled') {
    const config = daemonManager.getConfig();
    const hb = config.heartbeat;
    if (!hb || !hb.url) return { ok: false, error: 'Heartbeat not configured.' };
    const result = await sendHeartbeatPing(hb.url);
    heartbeatState.lastPingAt = new Date().toISOString();
    heartbeatState.lastStatus = result.ok ? `ok (${reason})` : `failed: ${result.error || ('HTTP ' + result.statusCode)}`;
    heartbeatState.lastError = result.ok ? null : (result.error || String(result.statusCode));
    if (result.ok) {
        logger.info(`Heartbeat ping delivered (${reason}).`);
    } else {
        logger.warn(`Heartbeat ping failed (${reason}): ${heartbeatState.lastError}`);
    }
    return { ok: result.ok, ...heartbeatState };
}

function restartHeartbeatTimer() {
    if (heartbeatState.timer) {
        clearInterval(heartbeatState.timer);
        heartbeatState.timer = null;
    }
    const config = daemonManager.getConfig();
    const hb = config.heartbeat;
    if (!hb || !hb.url) return;
    const minutes = Math.min(Math.max(parseInt(hb.intervalMinutes, 10) || 15, 1), 1440);
    heartbeatState.timer = setInterval(() => {
        runHeartbeatOnce('scheduled');
    }, minutes * 60 * 1000);
    if (heartbeatState.timer.unref) heartbeatState.timer.unref();
    logger.info(`Heartbeat armed: ping ${hb.url} every ${minutes}m.`);
}

app.get('/api/heartbeat', (req, res) => {
    const config = daemonManager.getConfig();
    res.json({ success: true, heartbeat: config.heartbeat || null, state: { ...heartbeatState, timer: undefined } });
});

app.post('/api/heartbeat', (req, res) => {
    const { url, intervalMinutes } = req.body || {};
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Heartbeat "url" is required.' });
    }
    let parsed;
    try {
        parsed = new URL(url.trim());
    } catch (e) {
        return res.status(400).json({ error: 'Heartbeat URL is not a valid URL.' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'Heartbeat URL must be http(s).' });
    }
    const minutes = Math.min(Math.max(parseInt(intervalMinutes, 10) || 15, 1), 1440);
    const config = daemonManager.getConfig();
    config.heartbeat = { url: url.trim(), intervalMinutes: minutes };
    daemonManager.saveConfig(config);
    restartHeartbeatTimer();
    logger.success(`Heartbeat configured: ${url.trim()} every ${minutes}m.`);
    res.status(201).json({ success: true, heartbeat: config.heartbeat });
});

app.post('/api/heartbeat/test', async (req, res) => {
    const { url } = req.body || {};
    const target = (url && String(url).trim()) || (daemonManager.getConfig().heartbeat || {}).url;
    if (!target) {
        return res.status(400).json({ error: 'No heartbeat URL configured. Provide one or save it first.' });
    }
    const result = await sendHeartbeatPing(target);
    if (result.ok) {
        heartbeatState.lastPingAt = new Date().toISOString();
        heartbeatState.lastStatus = 'ok (manual test)';
        heartbeatState.lastError = null;
    }
    res.json({ success: result.ok, ...result, at: heartbeatState.lastPingAt });
});

// Weekly digest: auto-posted stats summary + manual controls
const DIGEST_DAYS_API = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

app.get('/api/digest', (req, res) => {
    const config = daemonManager.getConfig();
    const summary = attendanceHistory.getWeeklyDigest(7, config.servers || []);
    res.json({ success: true, digest: config.digest || { enabled: false }, summary });
});

app.post('/api/digest', (req, res) => {
    const { enabled, day, time } = req.body || {};
    const config = daemonManager.getConfig();
    if (enabled === false) {
        config.digest = { ...(config.digest || {}), enabled: false };
        daemonManager.saveConfig(config);
        logger.info('Weekly digest disabled via Web Dashboard.');
        return res.json({ success: true, digest: config.digest });
    }
    const useDay = String(day || (config.digest || {}).day || 'monday').toLowerCase();
    const useTime = String(time || (config.digest || {}).time || '09:00');
    if (!DIGEST_DAYS_API.includes(useDay)) {
        return res.status(400).json({ error: `Unknown day "${day}". Use: ${DIGEST_DAYS_API.join(', ')}` });
    }
    if (suppression.parseHHMM(useTime) === null) {
        return res.status(400).json({ error: 'Time must be HH:MM (24h), e.g. 09:00.' });
    }
    config.digest = { enabled: true, day: useDay, time: useTime };
    daemonManager.saveConfig(config);
    logger.success(`Weekly digest enabled: every ${useDay} at ${useTime}.`);
    res.status(201).json({ success: true, digest: config.digest });
});

app.delete('/api/digest', (req, res) => {
    const config = daemonManager.getConfig();
    config.digest = { ...(config.digest || {}), enabled: false };
    daemonManager.saveConfig(config);
    logger.info('Weekly digest disabled via Web Dashboard.');
    res.json({ success: true });
});

app.post('/api/digest/test', async (req, res) => {
    try {
        const result = await daemonManager.sendDigest(true);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/heartbeat', (req, res) => {    const config = daemonManager.getConfig();
    config.heartbeat = null;
    daemonManager.saveConfig(config);
    if (heartbeatState.timer) {
        clearInterval(heartbeatState.timer);
        heartbeatState.timer = null;
    }
    heartbeatState.lastPingAt = null;
    heartbeatState.lastStatus = null;
    heartbeatState.lastError = null;
    logger.info('Heartbeat disarmed.');
    res.json({ success: true });
});

// Get current config
app.get('/api/config', (req, res) => {
    try {
        const config = daemonManager.getConfig();
        // Return config with full info (or masked token preview)
        res.json({
            ...config,
            hasToken: Boolean(config.globalToken && config.globalToken.trim()),
            tokenPreview: config.globalToken ? `${config.globalToken.substring(0, 8)}...` : '',
        });
    } catch (err) {
        logger.error(`Error in /api/config: ${err.message}`);
        res.status(500).json({ error: 'Failed to retrieve config', details: err.message });
    }
});

// Save whole config or update global settings
app.post('/api/config', (req, res) => {
    const current = daemonManager.getConfig();
    const { globalToken, globalWebhookUrl, servers, globalQuietHours, globalHolidays } = req.body;

    if (globalToken !== undefined) current.globalToken = globalToken.trim();
    if (globalWebhookUrl !== undefined) current.globalWebhookUrl = globalWebhookUrl.trim();
    if (Array.isArray(servers)) current.servers = servers;

    if (globalQuietHours !== undefined) {
        if (globalQuietHours === null) {
            current.globalQuietHours = null;
        } else {
            const check = suppression.validateQuietHours(globalQuietHours);
            if (!check.valid) return res.status(400).json({ error: check.error });
            current.globalQuietHours = { start: String(globalQuietHours.start).trim(), end: String(globalQuietHours.end).trim() };
        }
    }

    if (globalHolidays !== undefined) {
        if (!Array.isArray(globalHolidays)) {
            return res.status(400).json({ error: '"globalHolidays" must be an array of { date, name } entries.' });
        }
        const cleaned = [];
        const seen = new Set();
        for (const h of globalHolidays) {
            const check = suppression.validateHoliday(h);
            if (!check.valid) return res.status(400).json({ error: check.error });
            if (seen.has(check.sanitized.date)) continue;
            seen.add(check.sanitized.date);
            cleaned.push(check.sanitized);
        }
        current.globalHolidays = cleaned;
    }

    const saved = daemonManager.saveConfig(current);
    if (!saved) {
        return res.status(500).json({ error: 'Failed to save configuration' });
    }

    if (daemonManager.status === 'RUNNING') {
        daemonManager.initializeSchedules(current);
    }

    logger.info('Configuration updated via Web Dashboard');
    res.json({ success: true, config: current });
});

// Bulk toggle monitoring status for all servers (Enable All / Disable All)
app.post('/api/servers/toggle-all', (req, res) => {
    const { active } = req.body;
    if (active === undefined) {
        return res.status(400).json({ error: 'active boolean flag is required' });
    }

    const config = daemonManager.getConfig();
    const shouldEnable = Boolean(active);
    (config.servers || []).forEach((s) => {
        s.active = shouldEnable;
    });

    const saved = daemonManager.saveConfig(config);
    if (!saved) {
        return res.status(500).json({ error: 'Failed to save configuration' });
    }

    if (daemonManager.status === 'RUNNING') {
        daemonManager.initializeSchedules(config);
    }

    const statusLabel = shouldEnable ? 'Enabled all' : 'Disabled all';
    logger.info(`${statusLabel} server profiles (${config.servers.length} servers total).`);
    res.json({ success: true, active: shouldEnable, count: config.servers.length, servers: config.servers });
});

// Export server profiles and schedules configuration
app.get('/api/config/export', (req, res) => {
    const config = daemonManager.getConfig();
    const exportData = {
            app: 'Croncord',
        version: VERSION,
        exportedAt: new Date().toISOString(),
        globalWebhookUrl: config.globalWebhookUrl || '',
        ...(config.globalQuietHours ? { globalQuietHours: config.globalQuietHours } : {}),
        ...((config.globalHolidays || []).length > 0 ? { globalHolidays: config.globalHolidays } : {}),
        ...(config.vacation ? { vacation: config.vacation } : {}),
        ...(config.heartbeat ? { heartbeat: config.heartbeat } : {}),
        ...(config.digest ? { digest: config.digest } : {}),
        servers: config.servers || [],
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="croncord-servers-config.json"');
    res.json(exportData);
});

// Pre-validate configuration schema before committing import
app.post('/api/config/validate', (req, res) => {
    const validation = validateConfigSchema(req.body);
    res.json({
        isValid: validation.isValid,
        errors: validation.errors,
        warnings: validation.warnings,
        stats: validation.stats
    });
});

// Import server profiles and schedules configuration with strict schema validation
app.post('/api/config/import', (req, res) => {
    const { mode = 'replace', globalWebhookUrl } = req.body;

    // Run deep schema validation
    const validation = validateConfigSchema(req.body);
    if (!validation.isValid) {
        logger.warn(`Config import rejected: ${validation.errors.length} schema validation error(s).`);
        return res.status(400).json({
            error: 'Configuration failed schema validation.',
            errors: validation.errors,
            warnings: validation.warnings,
            stats: validation.stats
        });
    }

    const sanitizedServers = validation.sanitized.servers;
    const config = daemonManager.getConfig();

    if (mode === 'merge') {
        sanitizedServers.forEach((incoming) => {
            const existingIdx = config.servers.findIndex((s) => String(s.id) === String(incoming.id));
            if (existingIdx >= 0) {
                config.servers[existingIdx] = incoming;
            } else {
                config.servers.push(incoming);
            }
        });
    } else {
        // Replace
        config.servers = sanitizedServers;
    }

    const importedWebhook = globalWebhookUrl || validation.sanitized.globalWebhookUrl;
    if (importedWebhook && !config.globalWebhookUrl) {
        config.globalWebhookUrl = importedWebhook.trim();
    }

    // Carry validated quiet hours + holidays + vacation from the import when present.
    if (validation.sanitized.globalQuietHours) {
        config.globalQuietHours = validation.sanitized.globalQuietHours;
    }
    if (validation.sanitized.globalHolidays && validation.sanitized.globalHolidays.length > 0) {
        const merged = new Map((config.globalHolidays || []).map((h) => [h.date, h]));
        validation.sanitized.globalHolidays.forEach((h) => merged.set(h.date, h));
        config.globalHolidays = [...merged.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }
    if (validation.sanitized.vacation) {
        config.vacation = validation.sanitized.vacation;
    }
    if (validation.sanitized.heartbeat) {
        config.heartbeat = validation.sanitized.heartbeat;
    }
    if (validation.sanitized.digest) {
        config.digest = validation.sanitized.digest;
    }

    const saved = daemonManager.saveConfig(config);
    if (!saved) {
        return res.status(500).json({ error: 'Failed to persist imported configuration to disk.' });
    }

    if (daemonManager.status === 'RUNNING') {
        daemonManager.initializeSchedules(config);
    }

    logger.success(`Successfully imported ${sanitizedServers.length} server profile(s) (${mode} mode) with schema validation passed.`);
    res.json({
        success: true,
        count: sanitizedServers.length,
        warnings: validation.warnings,
        stats: validation.stats,
        servers: config.servers
    });
});

// Start Daemon
app.post('/api/daemon/start', async (req, res) => {
    const result = await daemonManager.start();
    res.json(result);
});

// Stop Daemon
app.post('/api/daemon/stop', async (req, res) => {
    const result = await daemonManager.stop();
    res.json(result);
});

// Add a Server Profile
app.post('/api/servers', (req, res) => {
    const { name, channelId, webhookUrl, active } = req.body;
    if (!name || !channelId) {
        return res.status(400).json({ error: 'Server name and Channel ID are required' });
    }

    const config = daemonManager.getConfig();
    const cleanChan = channelId.trim();
    const cleanName = name.trim();

    // Check for duplicate server profile by channel ID or server name
    const existing = (config.servers || []).find(
        (s) => (s.channelId && s.channelId.trim() === cleanChan) ||
               (s.name && s.name.trim().toLowerCase() === cleanName.toLowerCase())
    );

    if (existing) {
        return res.status(409).json({
            error: `Server profile already exists: "${existing.name}" (Channel: ${existing.channelId})`,
            duplicate: true,
            existingServer: existing,
        });
    }

    const newServer = {
        id: Date.now().toString(),
        name: cleanName,
        channelId: cleanChan,
        webhookUrl: (webhookUrl || '').trim(),
        active: active !== undefined ? Boolean(active) : true,
        schedules: [],
    };

    config.servers.push(newServer);
    daemonManager.saveConfig(config);
    logger.success(`Created server profile: "${newServer.name}"`);
    res.status(201).json({ success: true, server: newServer });
});

// Update a Server Profile
app.put('/api/servers/:serverId', (req, res) => {
    const { serverId } = req.params;
    const { name, channelId, webhookUrl, active, quietHours, ignoreHolidays } = req.body;
    const config = daemonManager.getConfig();
    const server = config.servers.find((s) => String(s.id) === String(serverId));

    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    if (name !== undefined) server.name = name.trim();
    if (channelId !== undefined) server.channelId = channelId.trim();
    if (webhookUrl !== undefined) server.webhookUrl = (webhookUrl || '').trim();
    if (active !== undefined) server.active = Boolean(active);
    if (ignoreHolidays !== undefined) server.ignoreHolidays = Boolean(ignoreHolidays);
    if (quietHours !== undefined) {
        if (quietHours === null) {
            delete server.quietHours;
        } else {
            const check = suppression.validateQuietHours(quietHours);
            if (!check.valid) return res.status(400).json({ error: check.error });
            server.quietHours = { start: String(quietHours.start).trim(), end: String(quietHours.end).trim() };
        }
    }

    daemonManager.saveConfig(config);
    logger.info(`Updated server profile: "${server.name}"`);
    res.json({ success: true, server });
});

// Delete a Server Profile
app.delete('/api/servers/:serverId', (req, res) => {
    const { serverId } = req.params;
    const config = daemonManager.getConfig();
    const idx = config.servers.findIndex((s) => String(s.id) === String(serverId));

    if (idx === -1) {
        return res.status(404).json({ error: 'Server not found' });
    }

    const removed = config.servers.splice(idx, 1)[0];
    daemonManager.saveConfig(config);
    logger.warn(`Deleted server profile: "${removed.name}"`);
    res.json({ success: true, message: `Server ${removed.name} removed` });
});

// Bulk Action on Selected Server Profiles (Delete, Enable, Disable)
app.post('/api/servers/bulk-action', (req, res) => {
    const { action, serverIds } = req.body;
    if (!action || !Array.isArray(serverIds) || serverIds.length === 0) {
        return res.status(400).json({ error: 'Valid action and non-empty serverIds array are required' });
    }

    const config = daemonManager.getConfig();
    const idSet = new Set(serverIds.map(String));
    let affectedCount = 0;

    if (action === 'delete') {
        const initialLen = config.servers.length;
        config.servers = config.servers.filter(s => !idSet.has(String(s.id)));
        affectedCount = initialLen - config.servers.length;
        daemonManager.saveConfig(config);
        logger.warn(`Bulk deleted ${affectedCount} server profile(s).`);
        return res.json({ success: true, action: 'delete', count: affectedCount });
    }

    if (action === 'enable' || action === 'disable') {
        const setActive = (action === 'enable');
        config.servers.forEach(s => {
            if (idSet.has(String(s.id))) {
                s.active = setActive;
                affectedCount++;
            }
        });
        daemonManager.saveConfig(config);
        logger.info(`Bulk ${setActive ? 'enabled' : 'disabled'} ${affectedCount} server profile(s).`);
        return res.json({ success: true, action, count: affectedCount });
    }

    return res.status(400).json({ error: `Unknown bulk action: ${action}` });
});

function withConflictWarnings(server) {
    try {
        const analysis = analyzeServerScheduleConflicts(server);
        return {
            hasConflict: analysis.hasConflict,
            conflicts: analysis.conflicts,
            conflictingScheduleIds: analysis.conflictingScheduleIds,
        };
    } catch (e) {
        return { hasConflict: false, conflicts: [], conflictingScheduleIds: [] };
    }
}

// Add a Schedule to a Server
app.post('/api/servers/:serverId/schedules', (req, res) => {
    const { serverId } = req.params;
    const { label, cron, message, messagePool, attendanceType, emoji, targetMessageId, maxJitterMinutes, active, type, runDate } = req.body;

    if (!cron || !label) {
        return res.status(400).json({ error: 'Label and cron expression are required' });
    }

    const config = daemonManager.getConfig();
    const server = config.servers.find((s) => String(s.id) === String(serverId));
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    let pool = [];
    if (messagePool !== undefined && messagePool !== null) {
        const check = validatePool(messagePool);
        if (!check.valid) return res.status(400).json({ error: check.error });
        pool = check.sanitized;
    }

    const newSchedule = {
        id: Date.now().toString() + Math.floor(Math.random() * 1000),
        label: label.trim(),
        cron: cron.trim(),
        message: message !== undefined ? message : 'Present',
        messagePool: pool,
        attendanceType: (attendanceType || 'MESSAGE').toUpperCase(),
        emoji: emoji || '👍',
        targetMessageId: targetMessageId ? targetMessageId.trim() : '',
        maxJitterMinutes: Number(maxJitterMinutes) >= 0 ? Number(maxJitterMinutes) : 10,
        active: active !== undefined ? Boolean(active) : true,
    };

    if (type === 'ONCE') {
        newSchedule.type = 'ONCE';
        if (runDate) newSchedule.runDate = runDate;
    }

    if (!server.schedules) server.schedules = [];
    server.schedules.push(newSchedule);

    daemonManager.saveConfig(config);
    logger.success(`[${server.name}] Added schedule: "${newSchedule.label}"`);
    res.status(201).json({ success: true, schedule: newSchedule, conflicts: withConflictWarnings(server) });
});

// Update a Schedule
app.put('/api/servers/:serverId/schedules/:scheduleId', (req, res) => {
    const { serverId, scheduleId } = req.params;
    const config = daemonManager.getConfig();
    const server = config.servers.find((s) => String(s.id) === String(serverId));
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    const schedule = (server.schedules || []).find((sc) => String(sc.id) === String(scheduleId));
    if (!schedule) {
        return res.status(404).json({ error: 'Schedule not found' });
    }

    const { label, cron, message, messagePool, attendanceType, emoji, targetMessageId, maxJitterMinutes, active, type, runDate } = req.body;

    if (label !== undefined) schedule.label = label.trim();
    if (cron !== undefined) schedule.cron = cron.trim();
    if (message !== undefined) schedule.message = message;
    if (messagePool !== undefined) {
        if (messagePool === null) {
            schedule.messagePool = [];
        } else {
            const check = validatePool(messagePool);
            if (!check.valid) return res.status(400).json({ error: check.error });
            schedule.messagePool = check.sanitized;
        }
    }
    if (attendanceType !== undefined) schedule.attendanceType = attendanceType.toUpperCase();
    if (emoji !== undefined) schedule.emoji = emoji;
    if (targetMessageId !== undefined) schedule.targetMessageId = targetMessageId ? targetMessageId.trim() : '';
    if (maxJitterMinutes !== undefined) schedule.maxJitterMinutes = Number(maxJitterMinutes);
    if (active !== undefined) schedule.active = Boolean(active);
    if (type !== undefined) schedule.type = type;
    if (runDate !== undefined) schedule.runDate = runDate;

    daemonManager.saveConfig(config);
    logger.info(`[${server.name}] Updated schedule: "${schedule.label}"`);
    res.json({ success: true, schedule, conflicts: withConflictWarnings(server) });
});

// Delete a Schedule
app.delete('/api/servers/:serverId/schedules/:scheduleId', (req, res) => {
    const { serverId, scheduleId } = req.params;
    const config = daemonManager.getConfig();
    const server = config.servers.find((s) => String(s.id) === String(serverId));
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    const idx = (server.schedules || []).findIndex((sc) => String(sc.id) === String(scheduleId));
    if (idx === -1) {
        return res.status(404).json({ error: 'Schedule not found' });
    }

    const removed = server.schedules.splice(idx, 1)[0];
    daemonManager.saveConfig(config);
    logger.warn(`[${server.name}] Deleted schedule: "${removed.label}"`);
    res.json({ success: true, message: `Schedule ${removed.label} deleted` });
});

// Reorder schedules for a server profile (Drag-and-Drop sequence prioritization)
app.post('/api/servers/:serverId/schedules/reorder', (req, res) => {
    const { serverId } = req.params;
    const { scheduleIds, schedules } = req.body;

    const config = daemonManager.getConfig();
    const server = config.servers.find((s) => String(s.id) === String(serverId));
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    if (Array.isArray(scheduleIds)) {
        const scheduleMap = new Map((server.schedules || []).map((sc) => [String(sc.id), sc]));
        const reordered = [];
        scheduleIds.forEach((id) => {
            const sc = scheduleMap.get(String(id));
            if (sc) {
                reordered.push(sc);
                scheduleMap.delete(String(id));
            }
        });
        // Append any omitted schedules to prevent data loss
        scheduleMap.forEach((sc) => reordered.push(sc));
        server.schedules = reordered;
    } else if (Array.isArray(schedules)) {
        server.schedules = schedules;
    } else {
        return res.status(400).json({ error: 'scheduleIds array or schedules array is required' });
    }

    const saved = daemonManager.saveConfig(config);
    if (!saved) {
        return res.status(500).json({ error: 'Failed to save configuration' });
    }

    if (daemonManager.status === 'RUNNING') {
        daemonManager.initializeSchedules(config);
    }

    logger.info(`[${server.name}] Attendance schedules reordered for prioritized execution sequence.`);
    res.json({ success: true, server, schedules: server.schedules, conflicts: withConflictWarnings(server) });
});

// Schedule conflict analysis for a server (mirrors the dashboard's 5-minute rule)
app.get('/api/servers/:serverId/conflicts', (req, res) => {
    const { serverId } = req.params;
    const config = daemonManager.getConfig();
    const server = (config.servers || []).find((s) => String(s.id) === String(serverId));
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }
    const analysis = withConflictWarnings(server);
    res.json({ success: true, serverId: server.id, serverName: server.name, ...analysis });
});

// Monthly firing calendar across all servers
app.get('/api/schedules/calendar', (req, res) => {
    try {
        const monthParam = String(req.query.month || '').trim();
        let year, month;
        if (/^\d{4}-\d{2}$/.test(monthParam)) {
            year = parseInt(monthParam.slice(0, 4), 10);
            month = parseInt(monthParam.slice(5, 7), 10);
            if (month < 1 || month > 12) throw new Error('bad month');
        } else if (!monthParam) {
            const now = new Date();
            year = now.getFullYear();
            month = now.getMonth() + 1;
        } else {
            return res.status(400).json({ error: 'month must be YYYY-MM (e.g. 2026-10).' });
        }
        const { getCalendarMonth } = require('./src/upcoming');
        res.json({ success: true, ...getCalendarMonth(daemonManager.getConfig(), year, month) });
    } catch (err) {
        logger.error(`Error in /api/schedules/calendar: ${err.message}`);
        res.status(500).json({ error: 'Failed to compute calendar', details: err.message });
    }
});

// Upcoming-runs timeline across all servers
app.get('/api/schedules/upcoming', (req, res) => {
    try {
        const count = Math.min(Math.max(parseInt(req.query.count, 10) || 10, 1), 50);
        const config = daemonManager.getConfig();
        res.json({ success: true, ...getUpcomingRuns(config, { count }) });
    } catch (err) {
        logger.error(`Error in /api/schedules/upcoming: ${err.message}`);
        res.status(500).json({ error: 'Failed to compute upcoming runs', details: err.message });
    }
});

// Config restore points (auto snapshots)
app.get('/api/config/backups', (req, res) => {
    res.json({ success: true, backups: configBackups.listBackups() });
});

app.post('/api/config/restore', (req, res) => {
    const { file } = req.body || {};
    if (!file) {
        return res.status(400).json({ error: 'Restore "file" name is required.' });
    }
    let snapshot;
    try {
        snapshot = configBackups.readBackup(file);
    } catch (err) {
        return res.status(404).json({ error: err.message });
    }
    if (!snapshot || !Array.isArray(snapshot.servers)) {
        return res.status(400).json({ error: 'Restore point is not a valid config (missing servers array).' });
    }
    const saved = daemonManager.saveConfig(snapshot);
    if (!saved) {
        return res.status(500).json({ error: 'Failed to write restored configuration.' });
    }
    if (daemonManager.status === 'RUNNING') {
        daemonManager.initializeSchedules(snapshot);
    }
    logger.success(`Configuration restored from "${file}" via Web Dashboard.`);
    res.json({ success: true, file, servers: snapshot.servers });
});

// Quiet hours: view / set global / clear everywhere
app.get('/api/quiet', (req, res) => {
    const config = daemonManager.getConfig();
    const perServer = (config.servers || [])
        .filter((s) => s.quietHours)
        .map((s) => ({ serverId: s.id, serverName: s.name, quietHours: s.quietHours }));
    res.json({ success: true, global: config.globalQuietHours || null, perServer });
});

app.post('/api/quiet', (req, res) => {
    const { start, end } = req.body || {};
    const check = suppression.validateQuietHours({ start, end });
    if (!check.valid) {
        return res.status(400).json({ error: check.error });
    }
    const config = daemonManager.getConfig();
    config.globalQuietHours = { start: String(start).trim(), end: String(end).trim() };
    daemonManager.saveConfig(config);
    logger.info(`Global quiet hours set to ${config.globalQuietHours.start}–${config.globalQuietHours.end} via Web Dashboard.`);
    res.json({ success: true, global: config.globalQuietHours });
});

app.delete('/api/quiet', (req, res) => {
    const config = daemonManager.getConfig();
    config.globalQuietHours = null;
    (config.servers || []).forEach((s) => { delete s.quietHours; });
    daemonManager.saveConfig(config);
    logger.info('Quiet hours cleared everywhere via Web Dashboard.');
    res.json({ success: true });
});

// Named holidays: list / add / remove
app.get('/api/holidays', (req, res) => {
    const config = daemonManager.getConfig();
    const holidays = [...(config.globalHolidays || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    res.json({ success: true, holidays });
});

app.post('/api/holidays', (req, res) => {
    const { date, name } = req.body || {};
    const check = suppression.validateHoliday({ date, name });
    if (!check.valid) {
        return res.status(400).json({ error: check.error });
    }
    const config = daemonManager.getConfig();
    if (!Array.isArray(config.globalHolidays)) config.globalHolidays = [];
    if (config.globalHolidays.some((h) => suppression.normalizeDateKey(h.date) === check.sanitized.date)) {
        return res.status(409).json({ error: `${check.sanitized.date} is already a holiday. Remove it first to rename.` });
    }
    config.globalHolidays.push(check.sanitized);
    daemonManager.saveConfig(config);
    logger.success(`Holiday added: ${check.sanitized.date} — ${check.sanitized.name}.`);
    res.status(201).json({ success: true, holiday: check.sanitized });
});

app.delete('/api/holidays/:date', (req, res) => {
    const key = suppression.normalizeDateKey(req.params.date);
    if (!key) {
        return res.status(400).json({ error: 'Holiday date must be YYYY-MM-DD.' });
    }
    const config = daemonManager.getConfig();
    const before = (config.globalHolidays || []).length;
    config.globalHolidays = (config.globalHolidays || []).filter((h) => suppression.normalizeDateKey(h.date) !== key);
    if (config.globalHolidays.length === before) {
        return res.status(404).json({ error: `No holiday found on ${key}.` });
    }
    daemonManager.saveConfig(config);
    logger.warn(`Holiday on ${key} removed via Web Dashboard.`);
    res.json({ success: true, date: key });
});

// Duplicate a server profile with fresh IDs (templating shortcut)
app.post('/api/servers/:serverId/clone', (req, res) => {
    const { serverId } = req.params;
    const { name, channelId } = req.body || {};
    if (!name || !channelId) {
        return res.status(400).json({ error: 'Clone target "name" and "channelId" are required.' });
    }
    const config = daemonManager.getConfig();
    const src = (config.servers || []).find((s) => String(s.id) === String(serverId));
    if (!src) {
        return res.status(404).json({ error: 'Server not found' });
    }
    const cleanChan = String(channelId).trim();
    const dupe = (config.servers || []).find((s) => s.channelId && s.channelId.trim() === cleanChan);
    if (dupe) {
        return res.status(409).json({ error: `Channel ${cleanChan} is already used by "${dupe.name}".`, duplicate: true });
    }
    const stamp = Date.now().toString();
    const cloned = {
        id: stamp,
        name: String(name).trim(),
        channelId: cleanChan,
        webhookUrl: src.webhookUrl || '',
        active: Boolean(src.active),
        ignoreHolidays: Boolean(src.ignoreHolidays),
        ...(src.quietHours ? { quietHours: { ...src.quietHours } } : {}),
        schedules: (src.schedules || []).map((sc, i) => ({
            ...JSON.parse(JSON.stringify(sc)),
            id: `${stamp}_${i}`,
        })),
    };
    config.servers.push(cloned);
    daemonManager.saveConfig(config);
    logger.success(`Cloned server profile "${src.name}" → "${cloned.name}".`);
    res.status(201).json({ success: true, server: cloned });
});

// Bulk enable/disable every schedule on one server
app.post('/api/servers/:serverId/schedules/bulk-action', (req, res) => {
    const { serverId } = req.params;
    const { action } = req.body || {};
    if (action !== 'enable' && action !== 'disable') {
        return res.status(400).json({ error: 'Bulk action must be "enable" or "disable".' });
    }
    const config = daemonManager.getConfig();
    const server = (config.servers || []).find((s) => String(s.id) === String(serverId));
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }
    const enable = (action === 'enable');
    (server.schedules || []).forEach((sc) => { sc.active = enable; });
    daemonManager.saveConfig(config);
    logger.info(`[${server.name}] Bulk ${enable ? 'enabled' : 'paused'} ${(server.schedules || []).length} schedule(s).`);
    res.json({ success: true, action, count: (server.schedules || []).length, schedules: server.schedules });
});

// Vacation mode: pause everything until a date (auto-resumes after)
app.get('/api/vacation', (req, res) => {
    const config = daemonManager.getConfig();
    const st = suppression.vacationStatus(config.vacation, new Date());
    res.json({ success: true, vacation: config.vacation || null, ...st });
});

app.post('/api/vacation', (req, res) => {
    const { until, note } = req.body || {};
    const check = suppression.validateVacation({ until, note });
    if (!check.valid) {
        return res.status(400).json({ error: check.error });
    }
    const todayKey = suppression.normalizeDateKey(new Date());
    if (check.sanitized.until < todayKey) {
        return res.status(400).json({ error: `Vacation end date ${check.sanitized.until} is in the past.` });
    }
    const config = daemonManager.getConfig();
    config.vacation = { ...check.sanitized, armedAt: new Date().toISOString() };
    daemonManager.saveConfig(config);
    logger.success(`Vacation mode armed until ${check.sanitized.until} via Web Dashboard.`);
    res.status(201).json({ success: true, vacation: config.vacation });
});

app.delete('/api/vacation', (req, res) => {
    const config = daemonManager.getConfig();
    if (!config.vacation) {
        return res.json({ success: true, message: 'Vacation mode is already off.' });
    }
    config.vacation = null;
    daemonManager.saveConfig(config);
    logger.info('Vacation cancelled via Web Dashboard — schedules resumed.');
    res.json({ success: true });
});

// Test Webhook Dispatch
app.post('/api/test-webhook', async (req, res) => {
    const { webhookUrl } = req.body;
    const targetUrl = webhookUrl || daemonManager.getConfig().globalWebhookUrl;
    if (!targetUrl) {
        return res.status(400).json({ success: false, message: 'No webhook URL provided or configured.' });
    }

    logger.info(`Testing Discord Webhook dispatch to: ${targetUrl.substring(0, 40)}...`);
    const result = await daemonManager.testWebhook(targetUrl);
    if (result.success) {
        logger.success('Discord Webhook test notification delivered successfully!');
    } else {
        logger.error(`Discord Webhook test failed: ${result.message}`);
    }
    res.json(result);
});

// Trigger a Schedule Immediately (Test Run)
app.post('/api/servers/:serverId/schedules/:scheduleId/trigger', async (req, res) => {
    const { serverId, scheduleId } = req.params;
    const { simulate } = req.body;
    try {
        const result = await daemonManager.triggerTask(serverId, scheduleId, simulate);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Dry-run preview: resolved post text for a schedule (sends nothing, logs nothing)
app.get('/api/servers/:serverId/schedules/:scheduleId/preview', (req, res) => {
    const { serverId, scheduleId } = req.params;
    const config = daemonManager.getConfig();
    const server = (config.servers || []).find((s) => String(s.id) === String(serverId));
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }
    const schedule = (server.schedules || []).find((sc) => String(sc.id) === String(scheduleId));
    if (!schedule) {
        return res.status(404).json({ error: 'Schedule not found' });
    }
    res.json({ success: true, preview: cliEngine.buildPreview(server, schedule, new Date()) });
});

// Activity Logs Endpoint
app.get('/api/logs', (req, res) => {
    res.json({ logs: logger.getHistory() });
});

// Export Activity Logs as CSV file
app.get('/api/logs/export', (req, res) => {
    const logs = logger.getHistory() || [];
    const escapeCsv = (val) => {
        if (val === null || val === undefined) return '""';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
    };

    const header = ['Entry #', 'Timestamp', 'Level', 'Message'];
    const rows = logs.map((entry, idx) => [
        idx + 1,
        escapeCsv(entry.time || ''),
        escapeCsv(entry.level || 'INFO'),
        escapeCsv(entry.message || '')
    ].join(','));

    const csvContent = '\uFEFF' + [header.join(','), ...rows].join('\r\n');
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `croncord-activity-logs-${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csvContent);
});

// Daily Check-ins Statistics (30 days)
app.get('/api/stats/daily-checkins', (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 90);
    res.json(attendanceHistory.getDailyStats(days));
});

// Server Health Status Map
app.get('/api/servers/health', (req, res) => {
    const config = daemonManager.getConfig();
    res.json({ healthMap: attendanceHistory.getServerHealthMap(config.servers || []) });
});

// Clear Activity Logs
app.post('/api/logs/clear', (req, res) => {
    logger.clearHistory();
    logger.info('Activity logs cleared by user.');
    res.json({ success: true });
});

// Interactive CLI Command Execution Endpoint (Web Terminal & Remote CLI)
app.post('/api/cli/exec', async (req, res) => {
    const { command, cmd } = req.body;
    const commandToRun = (command || cmd || '').trim();

    if (!commandToRun) {
        return res.json({ success: true, output: '', command: '' });
    }

    try {
        const result = await cliEngine.execute(commandToRun);
        res.json({
            success: result.success,
            output: result.output,
            command: commandToRun,
            isClear: Boolean(result.isClear)
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            output: `Internal CLI error: ${err.message}`,
            command: commandToRun
        });
    }
});

// Server-Sent Events (SSE) for Real-Time Log Streaming
app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const listener = (logEntry) => {
        res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
    };

    logger.addListener(listener);

    // Initial ping
    res.write(`data: ${JSON.stringify({ time: new Date().toISOString(), level: 'INFO', message: 'Connected to live log stream.' })}\n\n`);

    req.on('close', () => {
        logger.removeListener(listener);
        res.end();
    });
});

// Missing API endpoint 404 handler (prevents returning HTML to fetch calls)
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

// Fallback index.html for SPA/Web dashboard with global version injected
app.use((req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(indexPath, 'utf8', (err, html) => {
        if (err) return res.sendFile(indexPath);
        const rendered = html
            .replace(/\{\{APP_VERSION\}\}/g, DISPLAY_VERSION)
            .replace(/\{\{RAW_VERSION\}\}/g, VERSION);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(rendered);
    });
});

// Start Express Server
// 1. Primary Base Port 3271 (Dedicated Croncord Dashboard & CLI sync port)
const server = app.listen(PORT, HOST, () => {
    logger.success(`Croncord Web Dashboard online and live on primary base port http://${HOST}:${PORT}`);
    // Arm the heartbeat monitor if one is configured (survives reboots via config).
    try { restartHeartbeatTimer(); } catch (e) { /* non-fatal */ }
});

server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') {
        logger.error(`Error binding primary base port ${PORT}: ${err.message}`);
    }
});

