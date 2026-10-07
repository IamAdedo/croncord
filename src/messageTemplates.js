/**
 * src/messageTemplates.js
 *
 * Message templates + variant pools for schedules.
 * - Template variables are resolved at send time:
 *     {date}    -> Oct 6, 2026        {time} -> 09:00 AM
 *     {day}     -> Tuesday            {server} -> server profile name
 *     {channel} -> channel id         {mention} -> <@&...> left as-is
 * - messagePool: when a schedule holds several variants, one is picked at
 *   random per run (anti-detection: posts are never byte-identical), then
 *   variables are resolved on the picked variant.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatTime12h(date) {
    let h = date.getHours();
    const m = String(date.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${String(h).padStart(2, '0')}:${m} ${ampm}`;
}

/**
 * Resolves template variables in `text` for a given server + moment.
 */
function resolveTemplate(text, server = {}, at = new Date()) {
    if (!text) return text;
    const vars = {
        '{date}': `${MONTHS[at.getMonth()]} ${at.getDate()}, ${at.getFullYear()}`,
        '{time}': formatTime12h(at),
        '{day}': DAYS[at.getDay()],
        '{server}': server.name || 'this server',
        '{channel}': server.channelId || '',
    };
    let out = String(text);
    Object.keys(vars).forEach((key) => {
        out = out.split(key).join(vars[key]);
    });
    return out;
}

/**
 * Picks the message to send for a schedule: random pool variant when the
 * pool is non-empty, otherwise the base message. Variables resolved.
 * @returns {{ text: string, fromPool: boolean }}
 */
function pickMessage(schedule = {}, server = {}, at = new Date()) {
    const pool = Array.isArray(schedule.messagePool)
        ? schedule.messagePool.map((m) => String(m)).filter((m) => m.trim())
        : [];
    if (pool.length > 0) {
        const picked = pool[Math.floor(Math.random() * pool.length)];
        return { text: resolveTemplate(picked, server, at), fromPool: true };
    }
    return { text: resolveTemplate(schedule.message || 'Present', server, at), fromPool: false };
}

/**
 * Validates a message pool (array of non-empty strings, capped).
 */
function validatePool(pool) {
    if (pool === undefined || pool === null) return { valid: true, error: null, sanitized: [] };
    if (!Array.isArray(pool)) {
        return { valid: false, error: 'messagePool must be an array of message strings.' };
    }
    const cleaned = pool.map((m) => String(m)).filter((m) => m.trim());
    if (cleaned.length === 0 && pool.length > 0) {
        return { valid: false, error: 'messagePool contains only blank messages.' };
    }
    if (cleaned.length > 20) {
        return { valid: false, error: 'messagePool holds at most 20 variants.' };
    }
    const tooLong = cleaned.find((m) => m.length > 2000);
    if (tooLong) {
        return { valid: false, error: 'A message variant exceeds Discord\'s 2000-character limit.' };
    }
    return { valid: true, error: null, sanitized: cleaned };
}

module.exports = {
    resolveTemplate,
    pickMessage,
    validatePool,
};
