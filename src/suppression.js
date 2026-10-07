/**
 * src/suppression.js
 *
 * Intentional send-suppression rules: quiet hours + named holidays.
 * A suppressed firing is SKIPPED (neutral) — never a failure — so success
 * rates, health maps and streaks are unaffected.
 *
 * Config shape:
 *   config.globalQuietHours = { start: '22:00', end: '07:00' } | null
 *   server.quietHours       = { start, end } | null   (overrides global)
 *   config.globalHolidays   = [{ date: 'YYYY-MM-DD', name: 'Christmas Day' }]
 *   server.ignoreHolidays   = true                     (opt out of holidays)
 */

// --- Quiet hours --------------------------------------------------------

/**
 * Parses "HH:MM" (24h) into minutes since midnight. Returns null if invalid.
 */
function parseHHMM(input) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(input || '').trim());
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
}

/**
 * Validates a quiet-hours object. Returns { valid, error }.
 */
function validateQuietHours(qh) {
    if (!qh) return { valid: true, error: null };
    const start = parseHHMM(qh.start);
    const end = parseHHMM(qh.end);
    if (start === null || end === null) {
        return { valid: false, error: 'Quiet hours need "HH:MM" 24h start and end (e.g. 22:00–07:00).' };
    }
    if (start === end) {
        return { valid: false, error: 'Quiet hours start and end must differ.' };
    }
    return { valid: true, error: null };
}

/**
 * Returns true when `at` falls inside the quiet window.
 * Windows may cross midnight (e.g. 22:00–07:00).
 */
function isQuietAt(qh, at = new Date()) {
    if (!qh) return false;
    const start = parseHHMM(qh.start);
    const end = parseHHMM(qh.end);
    if (start === null || end === null) return false;
    const nowMin = at.getHours() * 60 + at.getMinutes();
    if (start < end) {
        return nowMin >= start && nowMin < end;
    }
    return nowMin >= start || nowMin < end;
}

/**
 * Effective quiet hours for a server (server override wins over global).
 */
function effectiveQuietHours(server, config) {
    if (server && server.quietHours) return server.quietHours;
    if (config && config.globalQuietHours) return config.globalQuietHours;
    return null;
}

// --- Holidays ------------------------------------------------------------

/**
 * Normalizes a date input to 'YYYY-MM-DD'. Accepts Date objects and
 * 'YYYY-MM-DD' strings. Returns null when invalid (incl. rollovers).
 */
function normalizeDateKey(input) {
    if (input instanceof Date) {
        if (Number.isNaN(input.getTime())) return null;
        const y = input.getFullYear();
        const m = String(input.getMonth() + 1).padStart(2, '0');
        const d = String(input.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const key = String(input || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const [y, m, d] = key.split('-').map(Number);
    const check = new Date(y, m - 1, d);
    if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) return null;
    return key;
}

/**
 * Validates a single holiday entry { date, name }.
 */
function validateHoliday(entry) {
    const date = normalizeDateKey(entry && entry.date);
    if (!date) {
        return { valid: false, error: `Holiday date must be a real calendar day (YYYY-MM-DD), got "${entry && entry.date}".` };
    }
    const name = entry && entry.name !== undefined ? String(entry.name).trim() : '';
    if (!name) {
        return { valid: false, error: `Holiday on ${date} needs a name (e.g. "Christmas Day").` };
    }
    if (name.length > 80) {
        return { valid: false, error: `Holiday name on ${date} is too long (max 80 characters).` };
    }
    return { valid: true, error: null, sanitized: { date, name } };
}

/**
 * Finds the holiday matching `at` (local calendar day), or null.
 * Servers with ignoreHolidays=true never match.
 */
function matchHoliday(holidays, at = new Date(), ignoreHolidays = false) {
    if (ignoreHolidays) return null;
    const key = normalizeDateKey(at);
    if (!key) return null;
    const found = (holidays || []).find((h) => normalizeDateKey(h.date) === key);
    return found ? { date: normalizeDateKey(found.date), name: String(found.name || 'Holiday') } : null;
}

/**
 * Full suppression check for a firing. Returns null when the run may
 * proceed, otherwise { reason: 'vacation'|'holiday'|'quiet', ...details }.
 */
function checkSuppressed(server, config, at = new Date()) {
    const cfg = config || {};
    const vac = vacationStatus(cfg.vacation, at);
    if (vac.active) {
        return {
            reason: 'vacation',
            vacation: { until: vac.until, note: vac.note },
            message: `⏸️ Skipped — vacation mode until ${vac.until}${vac.note ? ` (${vac.note})` : ''}.`,
        };
    }
    const holidays = Array.isArray(cfg.globalHolidays) ? cfg.globalHolidays : [];
    const holiday = matchHoliday(holidays, at, Boolean(server && server.ignoreHolidays));
    if (holiday) {
        return { reason: 'holiday', holiday, message: `⏸️ Skipped — holiday (${holiday.name}, ${holiday.date}).` };
    }
    const qh = effectiveQuietHours(server, cfg);
    if (isQuietAt(qh, at)) {
        return {
            reason: 'quiet',
            quietHours: qh,
            message: `⏸️ Skipped — inside quiet hours (${qh.start}–${qh.end}).`,
        };
    }
    return null;
}

// --- Vacation mode ---------------------------------------------------------

/**
 * Validates a vacation payload { until: 'YYYY-MM-DD', note? }.
 */
function validateVacation(vac) {
    if (!vac) return { valid: true, error: null };
    const until = normalizeDateKey(vac.until);
    if (!until) {
        return { valid: false, error: 'Vacation "until" must be a real calendar day (YYYY-MM-DD).' };
    }
    const note = vac.note !== undefined ? String(vac.note).trim().slice(0, 120) : '';
    return { valid: true, error: null, sanitized: { until, note } };
}

/**
 * Vacation state relative to `at` (local calendar days).
 * @returns {{ active: boolean, expired: boolean, until: string|null, note: string }}
 */
function vacationStatus(vacation, at = new Date()) {
    const blank = { active: false, expired: false, until: null, note: '' };
    if (!vacation || !vacation.until) return blank;
    const until = normalizeDateKey(vacation.until);
    if (!until) return blank;
    const todayKey = normalizeDateKey(at);
    if (todayKey && todayKey > until) {
        return { active: false, expired: true, until, note: String(vacation.note || '') };
    }
    return { active: true, expired: false, until, note: String(vacation.note || '') };
}

module.exports = {
    parseHHMM,
    validateQuietHours,
    isQuietAt,
    effectiveQuietHours,
    normalizeDateKey,
    validateHoliday,
    matchHoliday,
    checkSuppressed,
    validateVacation,
    vacationStatus,
};
