/**
 * src/bot.js
 *
 * Croncord (L2E Engine)
 * Author & Architect: IamAdedo, dlazyHNTR
 *
 * Main daemon manager responsible for:
 * - Loading config.json database
 * - Initializing discord.js-selfbot client
 * - Registering node-cron schedules per server profile
 * - Delegating task execution to src/engine/worker.js
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { Client } = require('discord.js-selfbot-v13');
const { executeAttendanceTask, sendWebhookNotification } = require('./engine/worker');
const logger = require('./logger');
const { vacationStatus } = require('./suppression');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// 1. Verify Configuration File Exists
if (!fs.existsSync(CONFIG_PATH)) {
    logger.error('config.json missing! Run "npm start" to set up your servers.');
    process.exit(1);
}

let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
    logger.error(`Failed to parse config.json: ${err.message}`);
    process.exit(1);
}

// Auto-resume: clear an expired vacation at boot (standalone daemon path).
if (config.vacation && vacationStatus(config.vacation).expired) {
    config.vacation = null;
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) { /* non-fatal */ }
    logger.info('🏖️ Vacation period ended — all schedules resumed automatically.');
}

/**
 * Persists the in-memory config back to disk. Used to disable one-time
 * schedules after they fire so they don't repeat on the next annual match.
 */
function persistConfig() {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (err) {
        logger.error(`Failed to persist config.json: ${err.message}`);
    }
}

/**
 * Returns true when a one-time schedule's target date matches the current day.
 * Guards against a cron (min hour DOM month *) re-firing in a later year if the
 * daemon happened to be offline on the intended date.
 */
function isOneTimeDueToday(schedule) {
    if (!schedule.runDate) return true;
    const target = new Date(schedule.runDate);
    const now = new Date();
    return (
        target.getFullYear() === now.getFullYear() &&
        target.getMonth() === now.getMonth() &&
        target.getDate() === now.getDate()
    );
}

if (!config.globalToken) {
    logger.error('Discord User Token missing from config.json. Run "npm start" setup.');
    process.exit(1);
}

// 2. Initialize Selfbot Client
const client = new Client({
    checkUpdate: false, // Prevents selfbot library update checks
});

const activeJobs = [];

/**
 * Parses and initializes all active server profiles and schedules.
 */
function initializeSchedules() {
    const activeServers = config.servers ? config.servers.filter((s) => s.active) : [];

    if (activeServers.length === 0) {
        logger.warn('No active server profiles found in config.json.');
        return;
    }

    logger.info(`Initializing schedules across ${activeServers.length} active server profile(s)...`);

    activeServers.forEach((server) => {
        const activeSchedules = server.schedules ? server.schedules.filter((sched) => sched.active) : [];

        activeSchedules.forEach((schedule) => {
            if (!cron.validate(schedule.cron)) {
                logger.error(`[${server.name}] Invalid cron expression syntax: "${schedule.cron}" for "${schedule.label}". Skipping.`);
                return;
            }

            const isOneTime = schedule.type === 'ONCE';

            // Skip one-time schedules whose target date has already passed.
            if (isOneTime && schedule.runDate) {
                const target = new Date(schedule.runDate);
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                target.setHours(0, 0, 0, 0);
                if (target < today) {
                    logger.warn(`[${server.name}] One-time schedule "${schedule.label}" is in the past. Disabling.`);
                    schedule.active = false;
                    persistConfig();
                    return;
                }
            }

            logger.info(`[${server.name}] Loaded Schedule: "${schedule.label}" (${schedule.cron})${isOneTime ? ' [ONE-TIME]' : ''}`);

            // Register the cron task
            const job = cron.schedule(schedule.cron, async () => {
                // For one-time schedules, ensure the annual cron match is the intended date.
                if (isOneTime && !isOneTimeDueToday(schedule)) {
                    return;
                }

                // Hand off execution entirely to worker.js (config passed so
                // global holidays / quiet hours apply to standalone runs too)
                const result = await executeAttendanceTask(client, server, schedule, config.globalWebhookUrl, config);

                // One-time schedules fire exactly once: disable, persist, and stop the timer.
                if (isOneTime) {
                    schedule.active = false;
                    persistConfig();
                    job.stop();
                    if (result && result.skipped) {
                        logger.info(`[${server.name}] One-time schedule "${schedule.label}" fell on a skip rule (${result.reason}) — recorded as skipped.`);
                    } else {
                        logger.success(`[${server.name}] One-time schedule "${schedule.label}" completed and disabled.`);
                    }
                }
            });

            activeJobs.push(job);
        });
    });

    logger.success(`Daemon fully initialized with ${activeJobs.length} active schedule watcher(s).`);
}

// 3. Client Gateway Event Handlers
client.on('ready', () => {
    logger.success(`Daemon running as user: ${client.user.tag}`);

    // Start all cron schedulers
    initializeSchedules();

    // Send Daemon Startup Notification to Global Webhook if available
    if (config.globalWebhookUrl) {
        sendWebhookNotification(config.globalWebhookUrl, {
            title: '🟢 Croncord Daemon Started',
            color: 3447003, // Blue
            description: `Background daemon successfully online for **${client.user.tag}**. Monitoring **${activeJobs.length}** active schedule timer(s).`,
            fields: [
                { name: 'Active Profiles', value: `${config.servers.filter((s) => s.active).length}`, inline: true },
                { name: 'Active Schedules', value: `${activeJobs.length}`, inline: true },
            ],
            footer: { text: 'Croncord by IamAdedo, dlazyHNTR' },
        });
    }
});

// Handle Rate Limits and Warnings
client.on('rateLimit', (rateLimitInfo) => {
    logger.warn(`Rate limit hit: ${rateLimitInfo.timeout}ms delay on route ${rateLimitInfo.route}`);
});

client.on('error', (error) => {
    logger.error(`Discord Gateway Error: ${error.message}`);
});

// 4. Graceful Shutdown Signals (PM2 / OS process signals)
function handleShutdown(signal) {
    logger.warn(`Received ${signal}. Shutting down Croncord daemon gracefully...`);

    // Stop all running cron jobs
    activeJobs.forEach((job) => job.stop());

    // Destroy Discord Web-socket Connection
    if (client) {
        client.destroy();
    }

    process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// 5. Authenticate Client
logger.info('Authenticating with Discord Gateway...');
client.login(config.globalToken).catch((err) => {
    logger.error(`Failed to log into Discord: ${err.message}`);
    process.exit(1);
});
