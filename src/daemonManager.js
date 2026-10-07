const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const https = require('https');
const { Client } = require('discord.js-selfbot-v13');
const { executeAttendanceTask, sendWebhookNotification } = require('./engine/worker');
const logger = require('./logger');
const attendanceHistory = require('./attendanceHistory');
const configBackups = require('./configBackups');
const suppression = require('./suppression');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// Digest weekday names → cron day-of-week.
const DIGEST_DAYS = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/**
 * Builds a weekly cron from a digest day/time (defaults Monday 09:00).
 * Returns null when invalid.
 */
function buildDigestCron(day, time) {
    const dow = DIGEST_DAYS[String(day || 'monday').trim().toLowerCase()];
    const mins = suppression.parseHHMM(time || '09:00');
    if (dow === undefined || mins === null) return null;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${m} ${h} * * ${dow}`;
}

// Self-heal policy: reconnect attempts with exponential backoff.
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 5 * 60 * 1000;

class DaemonManager {
    constructor() {
        this.status = 'STOPPED'; // 'STOPPED' | 'STARTING' | 'RUNNING' | 'ERROR'
        this.client = null;
        this.activeJobs = [];
        this.startedAt = null;
        this.errorMessage = null;
        this.user = null;
        this.digestJob = null;
        this.reconnect = {
            attempts: 0,
            maxAttempts: RECONNECT_MAX_ATTEMPTS,
            pending: false,
            nextAt: 0,
            lastError: null,
            timer: null,
        };
    }

    resetReconnect() {
        if (this.reconnect.timer) {
            try { clearTimeout(this.reconnect.timer); } catch (e) { /* ignore */ }
        }
        this.reconnect = {
            attempts: 0,
            maxAttempts: RECONNECT_MAX_ATTEMPTS,
            pending: false,
            nextAt: 0,
            lastError: null,
            timer: null,
        };
    }

    cancelPendingReconnect() {
        if (this.reconnect.timer) {
            try { clearTimeout(this.reconnect.timer); } catch (e) { /* ignore */ }
        }
        this.reconnect.pending = false;
        this.reconnect.timer = null;
    }

    /**
     * Schedules a Discord reconnect with exponential backoff after an
     * unexpected drop. Manual stop() always cancels pending retries.
     */
    scheduleReconnect(reason) {
        if (this.status === 'STOPPED' || this.status === 'STARTING') {
            return; // manual stop or fresh start in progress — never fight the user
        }
        if (this.status === 'ERROR') {
            return; // already gave up — manual restart required
        }
        if (!this.client) {
            return;
        }

        this.reconnect.attempts += 1;
        this.reconnect.lastError = reason || 'unknown';

        if (this.reconnect.attempts > this.reconnect.maxAttempts) {
            this.status = 'ERROR';
            this.errorMessage = `Discord connection lost and self-heal gave up after ${this.reconnect.maxAttempts} attempts (last: ${this.reconnect.lastError}). Restart the daemon manually.`;
            this.reconnect.pending = false;
            logger.error(this.errorMessage);
            const cfg = this.getConfig();
            if (cfg.globalWebhookUrl) {
                sendWebhookNotification(cfg.globalWebhookUrl, {
                    title: '🔴 Croncord Daemon Giving Up',
                    color: 15158332,
                    description: this.errorMessage,
                });
            }
            return;
        }

        const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnect.attempts - 1), RECONNECT_MAX_DELAY_MS);
        this.reconnect.pending = true;
        this.reconnect.nextAt = Date.now() + delay;
        logger.warn(`Discord connection dropped (${reason || 'unknown'}). Self-heal retry ${this.reconnect.attempts}/${this.reconnect.maxAttempts} in ${Math.round(delay / 1000)}s...`);

        if (this.reconnect.timer) {
            try { clearTimeout(this.reconnect.timer); } catch (e) { /* ignore */ }
        }
        this.reconnect.timer = setTimeout(() => {
            this.reconnect.timer = null;
            this.attemptReconnect();
        }, delay);
        if (this.reconnect.timer.unref) this.reconnect.timer.unref();
    }

    async attemptReconnect() {
        if (this.status === 'STOPPED') {
            this.reconnect.pending = false;
            return;
        }
        this.reconnect.pending = false;
        logger.info(`Attempting Discord reconnect (${this.reconnect.attempts}/${this.reconnect.maxAttempts})...`);
        try {
            if (this.client) {
                try { this.client.destroy(); } catch (e) { /* ignore */ }
            }
            const config = this.getConfig();
            const token = config.globalToken || process.env.DISCORD_USER_TOKEN;
            if (!token || !token.trim()) {
                throw new Error('Discord User Token is missing.');
            }
            this.attachClientListeners(config);
            await this.client.login(token);
        } catch (err) {
            logger.error(`Reconnect attempt failed: ${err.message}`);
            this.scheduleReconnect(err.message);
        }
    }

    /**
     * (Re)creates the Discord client and attaches gateway listeners.
     */
    attachClientListeners(config) {
        this.client = new Client({ checkUpdate: false });

        this.client.on('ready', () => {
            this.status = 'RUNNING';
            this.startedAt = this.startedAt || Date.now();
            this.resetReconnect();
            this.user = {
                tag: this.client.user?.tag || 'Unknown',
                id: this.client.user?.id || '',
                username: this.client.user?.username || '',
            };
            logger.success(`Discord Gateway connected! Daemon running as user: ${this.user.tag}`);

            this.initializeSchedules(config);

            if (config.globalWebhookUrl) {
                sendWebhookNotification(config.globalWebhookUrl, {
                    title: '🟢 Croncord Daemon Started',
                    color: 3447003,
                    description: `Background daemon online for **${this.user.tag}**. Monitoring **${this.activeJobs.length}** active schedule timer(s).`,
                    fields: [
                        { name: 'Active Profiles', value: `${(config.servers || []).filter((s) => s.active).length}`, inline: true },
                        { name: 'Active Schedules', value: `${this.activeJobs.length}`, inline: true },
                    ],
                });
            }
        });

        this.client.on('rateLimit', (rateLimitInfo) => {
            logger.warn(`Discord rate limit encountered: ${rateLimitInfo.timeout}ms delay on ${rateLimitInfo.route}`);
        });

        this.client.on('error', (err) => {
            logger.error(`Discord Gateway Error: ${err.message}`);
            this.errorMessage = err.message;
        });

        const onDrop = (where) => (info) => {
            const reason = (info && (info.reason || info.message)) || where;
            logger.warn(`Discord connection event (${where}). Scheduling self-heal...`);
            this.scheduleReconnect(reason);
        };
        this.client.on('disconnect', onDrop('disconnect'));
        this.client.on('shardDisconnect', onDrop('shardDisconnect'));
        this.client.on('shardError', (err) => {
            logger.error(`Discord shard error: ${err && err.message ? err.message : err}`);
            this.errorMessage = (err && err.message) || String(err);
        });
    }

    getConfig() {
        if (!fs.existsSync(CONFIG_PATH)) {
            const fallback = {
                globalToken: process.env.DISCORD_USER_TOKEN || '',
                globalWebhookUrl: process.env.GLOBAL_WEBHOOK_URL || '',
                servers: []
            };
            this.saveConfig(fallback);
            return fallback;
        }
        try {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed.servers) parsed.servers = [];
            return parsed;
        } catch (err) {
            logger.error(`Failed to read config.json: ${err.message}`);
            return {
                globalToken: '',
                globalWebhookUrl: '',
                servers: []
            };
        }
    }

    saveConfig(data) {
        try {
            // Auto-resume: an expired vacation ends itself on the next write.
            try {
                const suppression = require('./suppression');
                if (data && data.vacation && suppression.vacationStatus(data.vacation).expired) {
                    data.vacation = null;
                    logger.info('🏖️ Vacation period ended — all schedules resumed automatically.');
                }
            } catch (e) { /* never block a save */ }
            // Restore point first: snapshot only when something actually changed.
            try { configBackups.maybeSnapshot(data); } catch (e) { /* never block a save */ }
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
            if (this.status === 'RUNNING' && this.client) {
                this.initializeSchedules(data);
            }
            return true;
        } catch (err) {
            logger.error(`Failed to save config.json: ${err.message}`);
            return false;
        }
    }

    reloadConfigFromDisk() {
        if (!fs.existsSync(CONFIG_PATH)) return null;
        try {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed.servers) parsed.servers = [];
            logger.info('External config change detected on disk. Hot-reloading daemon schedules...');
            if (this.status === 'RUNNING' && this.client) {
                this.initializeSchedules(parsed);
            }
            return parsed;
        } catch (err) {
            logger.error(`Failed to reload config from disk: ${err.message}`);
            return null;
        }
    }

    isOneTimeDueToday(schedule) {
        if (!schedule.runDate) return true;
        const target = new Date(schedule.runDate);
        const now = new Date();
        return (
            target.getFullYear() === now.getFullYear() &&
            target.getMonth() === now.getMonth() &&
            target.getDate() === now.getDate()
        );
    }

    initializeSchedules(config) {
        this.stopSchedules();

        const activeServers = (config.servers || []).filter((s) => s.active);
        if (activeServers.length === 0) {
            logger.warn('No active server profiles found in configuration.');
            return;
        }

        logger.info(`Initializing schedules across ${activeServers.length} active server profile(s)...`);

        activeServers.forEach((server) => {
            const activeSchedules = (server.schedules || []).filter((sched) => sched.active);

            activeSchedules.forEach((schedule) => {
                if (!cron.validate(schedule.cron)) {
                    logger.error(`[${server.name}] Invalid cron expression syntax: "${schedule.cron}" for "${schedule.label}". Skipping.`);
                    return;
                }

                const isOneTime = schedule.type === 'ONCE';

                if (isOneTime && schedule.runDate) {
                    const target = new Date(schedule.runDate);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    target.setHours(0, 0, 0, 0);
                    if (target < today) {
                        logger.warn(`[${server.name}] One-time schedule "${schedule.label}" is in the past. Disabling.`);
                        schedule.active = false;
                        this.saveConfig(config);
                        return;
                    }
                }

                logger.info(`[${server.name}] Loaded Schedule: "${schedule.label}" (${schedule.cron})${isOneTime ? ' [ONE-TIME]' : ''}`);

                const job = cron.schedule(schedule.cron, async () => {
                    if (isOneTime && !this.isOneTimeDueToday(schedule)) {
                        return;
                    }

                    let result = null;
                    if (this.client) {
                        result = await executeAttendanceTask(this.client, server, schedule, config.globalWebhookUrl, config);
                    } else {
                        logger.warn(`[${server.name}] Schedule fired but Discord client is offline.`);
                    }

                    if (isOneTime) {
                        schedule.active = false;
                        this.saveConfig(config);
                        job.stop();
                        if (result && result.skipped) {
                            logger.info(`[${server.name}] One-time schedule "${schedule.label}" fell on a skip rule (${result.reason}) — recorded as skipped.`);
                        } else {
                            logger.success(`[${server.name}] One-time schedule "${schedule.label}" completed and disabled.`);
                        }
                    }
                });

                this.activeJobs.push({
                    serverId: server.id,
                    scheduleId: schedule.id,
                    job,
                });
            });
        });

        logger.success(`Daemon loaded ${this.activeJobs.length} active schedule watcher(s).`);

        // Weekly digest post (webhook-only, needs no Discord client).
        this.stopDigestJob();
        if (config.digest && config.digest.enabled) {
            const cronExp = buildDigestCron(config.digest.day, config.digest.time);
            if (cronExp && cron.validate(cronExp)) {
                logger.info(`Weekly digest scheduled: "${cronExp}" (day: ${config.digest.day || 'monday'}, time: ${config.digest.time || '09:00'}).`);
                this.digestJob = cron.schedule(cronExp, async () => {
                    await this.sendDigest(false);
                });
            } else {
                logger.warn('Weekly digest enabled but day/time are invalid — digest not scheduled.');
            }
        }
    }

    stopDigestJob() {
        if (this.digestJob) {
            try { this.digestJob.stop(); } catch (e) { /* ignore */ }
            this.digestJob = null;
        }
    }

    /**
     * Builds + posts the weekly stats digest to the global webhook.
     * @param {boolean} isTest adds a test marker instead of waiting for Monday
     */
    async sendDigest(isTest = false) {
        const config = this.getConfig();
        const webhookUrl = config.globalWebhookUrl;
        if (!webhookUrl) {
            const msg = 'Cannot post digest: no global webhook URL configured.';
            logger.warn(msg);
            return { success: false, message: msg };
        }

        const digest = attendanceHistory.getWeeklyDigest(7, config.servers || []);
        const serverLines = digest.perServer.length > 0
            ? digest.perServer.map((s) =>
                `• ${s.serverName}: ✅ ${s.success}  ❌ ${s.failed}  ⏸️ ${s.skipped}${s.active ? '' : ' (paused)'}`).join('\n')
            : '_No server profiles configured._';

        sendWebhookNotification(webhookUrl, {
            title: `📰 Weekly Attendance Digest${isTest ? ' (Test)' : ''}`,
            color: 5814783,
            description: `Check-in summary for **${digest.from} → ${digest.to}** (${digest.days} days).`,
            fields: [
                { name: 'Total Runs', value: `${digest.total}`, inline: true },
                { name: 'Success Rate', value: digest.successRate, inline: true },
                { name: 'Failed', value: `${digest.failed}`, inline: true },
                { name: 'Successful', value: `${digest.success}`, inline: true },
                { name: 'Skipped (neutral)', value: `${digest.skipped}`, inline: true },
                { name: 'Per-Server Breakdown', value: serverLines.slice(0, 1000) || '_None_', inline: false },
            ],
        });

        logger.success(`Weekly digest posted (${digest.total} runs, ${digest.successRate} success)${isTest ? ' [test]' : ''}.`);
        return { success: true, message: `Digest posted: ${digest.total} runs, ${digest.successRate} success.`, digest };
    }

    stopSchedules() {
        this.stopDigestJob();
        if (this.activeJobs.length > 0) {
            this.activeJobs.forEach((item) => {
                try { item.job.stop(); } catch (e) { /* ignore */ }
            });
            this.activeJobs = [];
        }
    }

    async start() {
        if (this.status === 'RUNNING' || this.status === 'STARTING') {
            return { success: false, message: 'Daemon is already running or starting.' };
        }

        const config = this.getConfig();
        const token = config.globalToken || process.env.DISCORD_USER_TOKEN;

        // Auto-resume: an expired vacation ends itself at daemon boot.
        try {
            const suppression = require('./suppression');
            if (config.vacation && suppression.vacationStatus(config.vacation).expired) {
                config.vacation = null;
                this.saveConfig(config);
                logger.info('🏖️ Vacation period ended — all schedules resumed automatically.');
            }
        } catch (e) { /* never block startup */ }

        if (!token || !token.trim()) {
            this.status = 'STOPPED';
            this.errorMessage = 'Discord User Token is missing. Set your token in Credentials Settings.';
            logger.warn('Cannot start daemon: Discord User Token is missing.');
            return { success: false, message: this.errorMessage };
        }

        this.status = 'STARTING';
        this.errorMessage = null;
        this.resetReconnect();
        logger.info('Starting Croncord daemon...');

        try {
            this.attachClientListeners(config);

            logger.info('Authenticating Discord client...');
            await this.client.login(token);

            return { success: true, message: 'Daemon connection initiated.' };
        } catch (err) {
            this.status = 'ERROR';
            this.errorMessage = err.message;
            logger.error(`Failed to start daemon: ${err.message}`);
            this.stop();
            return { success: false, message: err.message };
        }
    }

    async stop() {
        logger.warn('Stopping Croncord daemon...');
        this.cancelPendingReconnect();
        this.stopSchedules();

        if (this.client) {
            try {
                this.client.destroy();
            } catch (e) {
                /* ignore */
            }
            this.client = null;
        }

        this.status = 'STOPPED';
        this.startedAt = null;
        this.user = null;
        logger.info('Daemon stopped successfully.');
        return { success: true, message: 'Daemon stopped.' };
    }

    getStatus() {
        const config = this.getConfig();
        const activeServers = (config.servers || []).filter((s) => s.active);
        const totalSchedules = (config.servers || []).reduce(
            (acc, s) => acc + (s.schedules ? s.schedules.length : 0),
            0
        );
        const activeSchedules = (config.servers || []).reduce(
            (acc, s) => acc + (s.active && s.schedules ? s.schedules.filter((sc) => sc.active).length : 0),
            0
        );

        return {
            status: this.status,
            uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
            startedAt: this.startedAt,
            user: this.user,
            errorMessage: this.errorMessage,
            activeJobsCount: this.activeJobs.length,
            reconnect: {
                attempts: this.reconnect.attempts,
                maxAttempts: this.reconnect.maxAttempts,
                pending: this.reconnect.pending,
                nextAt: this.reconnect.nextAt,
                lastError: this.reconnect.lastError,
            },
            stats: {
                totalServers: (config.servers || []).length,
                activeServers: activeServers.length,
                totalSchedules,
                activeSchedules,
            },
            serverHealth: attendanceHistory.getServerHealthMap(config.servers || []),
            dailyStats: attendanceHistory.getDailyStats(30),
        };
    }

    async triggerTask(serverId, scheduleId, simulate = false) {
        const config = this.getConfig();
        const server = (config.servers || []).find((s) => String(s.id) === String(serverId));
        if (!server) {
            throw new Error(`Server profile ${serverId} not found.`);
        }

        const schedule = (server.schedules || []).find((sc) => String(sc.id) === String(scheduleId));
        if (!schedule) {
            throw new Error(`Schedule ${scheduleId} not found on server ${server.name}.`);
        }

        logger.info(`[Trigger] Manual trigger requested for "${server.name}" - "${schedule.label}" (Simulate: ${simulate || !this.client})`);

        if (simulate || !this.client) {
            // Simulated execution without live Discord client (manual test runs
            // bypass suppression rules on purpose — the user asked to run NOW).
            const isReaction = (schedule.attendanceType || 'MESSAGE').toUpperCase() === 'REACTION';
            let previewText = schedule.message || 'Present';
            if (!isReaction) {
                try {
                    const { pickMessage } = require('./messageTemplates');
                    previewText = pickMessage(schedule, server, new Date()).text;
                } catch (e) { /* fall back to raw message */ }
            }
            const actionDesc = isReaction
                ? `Reaction with emoji "${schedule.emoji || '👍'}" to channel ${server.channelId}`
                : `Message "${previewText}" to channel ${server.channelId}`;

            logger.info(`[Simulation] Simulating attendance dispatch for server "${server.name}"...`);
            await new Promise((r) => setTimeout(r, 1000));
            logger.success(`[Simulation] ${actionDesc} completed successfully!`);

            attendanceHistory.recordExecution({
                serverId: server.id,
                serverName: server.name,
                channelId: server.channelId,
                scheduleId: schedule.id,
                scheduleLabel: schedule.label,
                type: isReaction ? 'REACTION' : 'MESSAGE',
                status: 'SUCCESS',
                details: `[Manual / Test Run] ${actionDesc}`
            });

            const webhookUrl = server.webhookUrl || config.globalWebhookUrl;
            if (webhookUrl) {
                sendWebhookNotification(webhookUrl, {
                    title: '✅ Attendance Dispatched (Manual / Test Run)',
                    color: 3066993,
                    fields: [
                        { name: 'Server Profile', value: server.name, inline: true },
                        { name: 'Channel ID', value: server.channelId, inline: true },
                        { name: 'Schedule', value: schedule.label, inline: true },
                        { name: isReaction ? 'Emoji' : 'Message', value: isReaction ? (schedule.emoji || '👍') : previewText, inline: false },
                        { name: 'Mode', value: this.client ? 'Live Run' : 'Simulation Mode', inline: true },
                    ],
                });
            }

            return {
                success: true,
                simulated: true,
                message: `Attendance test completed (${isReaction ? 'Reaction' : 'Message'}).`,
            };
        }

        // Live execution with connected client (manual run: bypass suppression)
        await executeAttendanceTask(this.client, server, schedule, config.globalWebhookUrl, config, { force: true });
        return {
            success: true,
            simulated: false,
            message: `Attendance task executed live for server ${server.name}!`,
        };
    }

    testWebhook(webhookUrl) {
        return new Promise((resolve) => {
            if (!webhookUrl || !webhookUrl.startsWith('http')) {
                return resolve({ success: false, message: 'Invalid webhook URL provided' });
            }

            try {
                const url = new URL(webhookUrl);
                const payload = JSON.stringify({
                    embeds: [
                        {
                            title: '🔔 Croncord Webhook Connected',
                            description: 'Test notification from Croncord Web Dashboard! Webhook alerts are functioning properly.',
                            color: 5814783,
                            footer: { text: 'Croncord by IamAdedo, dlazyHNTR' },
                            timestamp: new Date().toISOString(),
                        },
                    ],
                });

                const req = https.request(
                    url,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(payload),
                        },
                    },
                    (res) => {
                        const ok = res.statusCode >= 200 && res.statusCode < 300;
                        resolve({
                            success: ok,
                            statusCode: res.statusCode,
                            message: ok ? 'Webhook notification delivered!' : `Webhook returned status HTTP ${res.statusCode}`,
                        });
                    }
                );

                req.on('error', (err) => {
                    resolve({ success: false, message: err.message });
                });

                req.write(payload);
                req.end();
            } catch (err) {
                resolve({ success: false, message: err.message });
            }
        });
    }
}

const daemonManager = new DaemonManager();
module.exports = daemonManager;
