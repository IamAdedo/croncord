/**
 * src/engine/worker.js
 *
 * Croncord (L2E Engine)
 * Author & Architect: IamAdedo, dlazyHNTR
 *
 * Execution engine responsible for:
 * - Anti-detection randomized jitter calculation
 * - Human-like typing simulation
 * - Multi-mode execution (MESSAGE vs REACTION)
 * - Rate-limit backoff and webhook alert dispatches
 */

const https = require('https');
const logger = require('../logger');
const attendanceHistory = require('../attendanceHistory');
const { pickMessage } = require('../messageTemplates');
const { checkSuppressed } = require('../suppression');

/**
 * Utility pause helper
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends structured notifications to a Discord Webhook.
 * @param {string} webhookUrl
 * @param {object} embedData
 */
function sendWebhookNotification(webhookUrl, embedData) {
    if (!webhookUrl) return;

    try {
        const url = new URL(webhookUrl);
        const payload = JSON.stringify({
            embeds: [
                {
                    ...embedData,
                    footer: { text: 'Croncord by IamAdedo, dlazyHNTR' },
                    timestamp: new Date().toISOString(),
                },
            ],
        });

        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        });

        req.on('error', (err) => {
            console.error(`[Worker] Webhook dispatch failed: ${err.message}`);
        });

        req.write(payload);
        req.end();
    } catch (err) {
        console.error(`[Worker] Invalid Webhook URL provided: ${err.message}`);
    }
}

/**
 * Calculates randomized anti-detection delay in milliseconds.
 * @param {number} maxJitterMinutes
 * @returns {number}
 */
function calculateJitterMs(maxJitterMinutes = 10) {
    if (!maxJitterMinutes || maxJitterMinutes <= 0) return 0;
    const maxMs = maxJitterMinutes * 60 * 1000;
    return Math.floor(Math.random() * maxMs);
}

/**
 * Main Task Execution Handler
 *
 * @param {object} client - Authenticated discord.js-selfbot client instance
 * @param {object} server - Server configuration object from config.json
 * @param {object} schedule - Target schedule object to execute
 * @param {string} [globalWebhookUrl=''] - Optional fallback webhook URL
 * @param {object|null} [config=null] - Full config (global holidays/quiet hours)
 * @param {object} [opts={}] - { force: true } bypasses suppression (manual test runs)
 * @returns {Promise<{skipped:boolean,reason?:string}>}
 */
async function executeAttendanceTask(client, server, schedule, globalWebhookUrl = '', config = null, opts = {}) {
    const targetWebhook = server.webhookUrl || globalWebhookUrl;
    const startTime = Date.now();
    const fireTime = new Date();

    // 0. Intentional-skip rules (holidays / quiet hours) — neutral SKIPPED, never a failure.
    if (!opts.force) {
        const suppressed = checkSuppressed(server, config, fireTime);
        if (suppressed) {
            console.log(`[Worker] ${suppressed.message} [${server.name} / ${schedule.label}]`);
            logger.info(`[Worker] ${suppressed.message} [${server.name} / ${schedule.label}]`);

            attendanceHistory.recordExecution({
                serverId: server.id,
                serverName: server.name,
                channelId: server.channelId,
                scheduleId: schedule.id,
                scheduleLabel: schedule.label,
                type: (schedule.attendanceType || 'MESSAGE').toUpperCase(),
                status: 'SKIPPED',
                details: `${suppressed.message} Streaks and success rates unaffected.`
            });

            sendWebhookNotification(targetWebhook, {
                title: '⏸️ Attendance Skipped (Intentional)',
                color: 9807270, // Grey
                fields: [
                    { name: 'Server Profile', value: server.name || 'Unknown', inline: true },
                    { name: 'Schedule', value: schedule.label || 'Unknown', inline: true },
                    { name: 'Reason', value: suppressed.message, inline: false },
                ],
            });

            return { skipped: true, reason: suppressed.reason };
        }
    }

    try {
        console.log(`\n[Worker] ⏰ Schedule triggered for server: "${server.name}" (${schedule.label})`);
        logger.info(`[Worker] ⏰ Schedule triggered for server: "${server.name}" (${schedule.label})`);

        // 1. Calculate and apply anti-detection jitter
        const maxJitter = schedule.maxJitterMinutes ?? 10;
        const jitterMs = calculateJitterMs(maxJitter);

        if (jitterMs > 0) {
            const jitterSec = Math.round(jitterMs / 1000);
            console.log(`[Worker] 🎲 Applying anti-detection jitter: waiting ${jitterSec}s before dispatching...`);
            logger.info(`[Worker] 🎲 Applying anti-detection jitter: waiting ${jitterSec}s before dispatching...`);
            await sleep(jitterMs);
        }

        // 2. Fetch target channel
        const channel = await client.channels.fetch(server.channelId).catch((err) => {
            throw new Error(`Failed to access target channel (${server.channelId}): ${err.message}`);
        });

        if (!channel) {
            throw new Error(`Channel ${server.channelId} could not be resolved or found.`);
        }

        const attendanceType = (schedule.attendanceType || 'MESSAGE').toUpperCase();

        // 3. Execution Logic Strategy
        if (attendanceType === 'REACTION') {
            const emoji = schedule.emoji || '👍';
            let targetMessage;

            if (schedule.targetMessageId) {
                targetMessage = await channel.messages.fetch(schedule.targetMessageId).catch(() => null);
            }

            // Fallback to fetching the most recent message in channel if targetMessageId isn't provided/found
            if (!targetMessage) {
                const recentMessages = await channel.messages.fetch({ limit: 1 });
                targetMessage = recentMessages.first();
            }

            if (!targetMessage) {
                throw new Error(`No available message found in channel ${channel.id} to react to.`);
            }

            // Small pause to simulate reading/moving mouse before clicking reaction
            await sleep(1200 + Math.random() * 1800);
            await targetMessage.react(emoji);

            console.log(`[Worker] ✅ Reacted with "${emoji}" to message ID: ${targetMessage.id}`);
            logger.success(`[Worker] Reacted with "${emoji}" to message ID: ${targetMessage.id}`);

            attendanceHistory.recordExecution({
                serverId: server.id,
                serverName: server.name,
                channelId: server.channelId,
                scheduleId: schedule.id,
                scheduleLabel: schedule.label,
                type: 'REACTION',
                status: 'SUCCESS',
                details: `Reacted with "${emoji}" to message ID: ${targetMessage.id}`
            });

            // Dispatch Success Webhook
            sendWebhookNotification(targetWebhook, {
                title: '✅ Attendance Reaction Posted Successfully',
                color: 3066993, // Green
                fields: [
                    { name: 'Server Profile', value: server.name, inline: true },
                    { name: 'Channel', value: `#${channel.name || server.channelId}`, inline: true },
                    { name: 'Schedule', value: schedule.label, inline: true },
                    { name: 'Emoji Reacted', value: `\`${emoji}\``, inline: true },
                    { name: 'Target Message ID', value: targetMessage.id, inline: true },
                    { name: 'Execution Delay', value: `${Math.round(jitterMs / 1000)}s jitter applied`, inline: true },
                ],
            });

        } else {
            // Default: MESSAGE Mode (template variables resolved, pool variant picked)
            const picked = pickMessage(schedule, server, new Date());
            const messageText = picked.text;

            // Simulate natural human typing duration based on character count
            if (channel.sendTyping) {
                await channel.sendTyping().catch(() => { });
                // Base delay (1.5s) + 80ms to 120ms per character, capped at 7 seconds
                const charCount = messageText.length;
                const typingMs = Math.min(Math.max(charCount * 100, 1500), 7000);

                console.log(`[Worker] ⌨️ Simulating human typing for ${Math.round(typingMs)}ms...`);
                logger.info(`[Worker] ⌨️ Simulating human typing for ${Math.round(typingMs)}ms...`);
                await sleep(typingMs);
            }

            const sentMsg = await channel.send(messageText);
            console.log(`[Worker] ✅ Message posted successfully! (ID: ${sentMsg.id})`);
            logger.success(`[Worker] Message posted successfully to #${channel.name || server.channelId}! (ID: ${sentMsg.id})`);

            attendanceHistory.recordExecution({
                serverId: server.id,
                serverName: server.name,
                channelId: server.channelId,
                scheduleId: schedule.id,
                scheduleLabel: schedule.label,
                type: 'MESSAGE',
                status: 'SUCCESS',
                details: `Message posted successfully: "${messageText}" (ID: ${sentMsg.id})${picked.fromPool ? ' [pool variant]' : ''}`
            });

            // Dispatch Success Webhook
            sendWebhookNotification(targetWebhook, {
                title: '✅ Attendance Posted Successfully',
                color: 3066993, // Green
                fields: [
                    { name: 'Server Profile', value: server.name, inline: true },
                    { name: 'Channel', value: `#${channel.name || server.channelId}`, inline: true },
                    { name: 'Schedule', value: schedule.label, inline: true },
                    { name: 'Message Sent', value: `\`${messageText}\``, inline: false },
                    { name: 'Execution Delay', value: `${Math.round(jitterMs / 1000)}s jitter applied`, inline: true },
                ],
            });
        }

        return { skipped: false };

    } catch (err) {
        const totalElapsedSec = Math.round((Date.now() - startTime) / 1000);
        console.error(`[Worker] ❌ Error executing schedule "${schedule.label}" on server "${server.name}":`, err.message);
        logger.error(`[Worker] Error executing schedule "${schedule.label}" on server "${server.name}": ${err.message}`);

        attendanceHistory.recordExecution({
            serverId: server.id,
            serverName: server.name,
            channelId: server.channelId,
            scheduleId: schedule.id,
            scheduleLabel: schedule.label,
            type: (schedule.attendanceType || 'MESSAGE').toUpperCase(),
            status: 'FAILED',
            error: err.message,
            details: `Execution failed: ${err.message}`
        });

        // Dispatch Failure Webhook
        sendWebhookNotification(targetWebhook, {
            title: '🚨 Attendance Posting Failed',
            color: 15158332, // Red
            fields: [
                { name: 'Server Profile', value: server.name || 'Unknown', inline: true },
                { name: 'Channel ID', value: server.channelId || 'Unknown', inline: true },
                { name: 'Schedule', value: schedule.label || 'Unknown', inline: true },
                { name: 'Error Details', value: `\`\`\`${err.message}\`\`\``, inline: false },
                { name: 'Time Elapsed', value: `${totalElapsedSec}s`, inline: true },
            ],
        });

        return { skipped: false, error: err.message };
    }
}

module.exports = {
    executeAttendanceTask,
    calculateJitterMs,
    sendWebhookNotification,
};
