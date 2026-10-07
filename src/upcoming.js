/**
 * src/upcoming.js
 *
 * "What runs next?" timeline. Expands every active schedule's cron into real
 * fire times, merges them across servers, and returns the soonest runs.
 * Holiday dates are excluded (intentionally skipped, never failures);
 * occurrences inside quiet hours are still listed but flagged.
 */

const { CronExpressionParser } = require('cron-parser');
const { matchHoliday, effectiveQuietHours, isQuietAt, normalizeDateKey, vacationStatus } = require('./suppression');

const MAX_ITERATIONS_PER_SCHEDULE = 500;
const DEFAULT_HORIZON_DAYS = 60;

function scheduleOccurrences(server, schedule, config, { from, horizonDays }) {
    const out = [];
    const empty = () => ({ runs: out, vacationSkipped: 0 });
    if (!server || server.active === false) return empty();
    if (!schedule || schedule.active === false) return empty();
    if (!schedule.cron) return empty();

    const holidays = Array.isArray(config.globalHolidays) ? config.globalHolidays : [];
    const ignoreHolidays = Boolean(server.ignoreHolidays);
    const qh = effectiveQuietHours(server, config);
    const vac = vacationStatus(config.vacation, from);
    let vacationSkipped = 0;

    const isOnce = schedule.type === 'ONCE';
    const onceKey = isOnce && schedule.runDate ? schedule.runDate.slice(0, 10) : null;

    let iterator;
    try {
        iterator = CronExpressionParser.parse(schedule.cron, { currentDate: from });
    } catch (e) {
        return empty(); // daemon skips invalid crons too
    }

    const horizonMs = from.getTime() + horizonDays * 24 * 60 * 60 * 1000;
    for (let i = 0; i < MAX_ITERATIONS_PER_SCHEDULE; i++) {
        let next;
        try {
            next = iterator.next().toDate();
        } catch (e) {
            break; // no further occurrences
        }
        if (next.getTime() > horizonMs) break;

        if (isOnce) {
            if (!onceKey) break;
            const occKey = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
            const todayKey = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
            if (occKey !== onceKey) {
                // Annual cron re-match outside the intended date: stop, like the daemon guard.
                if (occKey > onceKey || onceKey < todayKey) break;
                continue;
            }
        }

        if (matchHoliday(holidays, next, ignoreHolidays)) {
            continue; // intentionally skipped — not a run
        }

        if (vac.active) {
            const occKey = normalizeDateKey(next);
            if (occKey && occKey <= vac.until) {
                vacationSkipped++;
                continue; // vacation covers this date — not a run
            }
        }

        out.push({
            at: next.toISOString(),
            serverId: String(server.id),
            serverName: server.name,
            scheduleId: String(schedule.id),
            scheduleLabel: schedule.label,
            cron: schedule.cron,
            quiet: isQuietAt(qh, next),
            oneTime: isOnce,
        });

        if (isOnce) break;
    }

    return { runs: out, vacationSkipped };
}

/**
 * @param {object} config full config.json object
 * @param {{ count?: number, from?: Date, horizonDays?: number }} opts
 */
function getUpcomingRuns(config, opts = {}) {
    const count = Math.min(Math.max(parseInt(opts.count, 10) || 10, 1), 50);
    const from = opts.from instanceof Date ? opts.from : new Date();
    const horizonDays = Math.min(Math.max(parseInt(opts.horizonDays, 10) || DEFAULT_HORIZON_DAYS, 7), 365);

    const all = [];
    let vacationSkipped = 0;
    (config.servers || []).forEach((server) => {
        (server.schedules || []).forEach((schedule) => {
            const occ = scheduleOccurrences(server, schedule, config, { from, horizonDays });
            all.push(...occ.runs);
            vacationSkipped += occ.vacationSkipped;
        });
    });

    all.sort((a, b) => new Date(a.at) - new Date(b.at));
    const runs = all.slice(0, count);

    return {
        from: from.toISOString(),
        count: runs.length,
        requested: count,
        quietFlagged: runs.filter((r) => r.quiet).length,
        vacationActive: vacationStatus(config.vacation, from).active,
        vacationSkipped,
        runs,
    };
}

/**
 * Builds a month calendar of firings: per-day run counts + entries.
 * @param {object} config
 * @param {number} year e.g. 2026
 * @param {number} month 1-12
 */
function getCalendarMonth(config, year, month) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const from = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(year, month - 1, d);
        days.push({
            date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
            weekday: dt.getDay(),
            count: 0,
            quiet: 0,
            runs: [],
        });
    }
    const byDate = new Map(days.map((d) => [d.date, d]));

    let vacationSkipped = 0;
    (config.servers || []).forEach((server) => {
        (server.schedules || []).forEach((schedule) => {
            const occ = scheduleOccurrences(server, schedule, config, { from, horizonDays: daysInMonth });
            vacationSkipped += occ.vacationSkipped;
            occ.runs.forEach((r) => {
                const key = String(r.at).slice(0, 10);
                const bucket = byDate.get(key);
                if (!bucket) return;
                bucket.count++;
                if (r.quiet) bucket.quiet++;
                bucket.runs.push(r);
            });
        });
    });

    const activeDays = days.filter((d) => d.count > 0).length;
    return {
        month: `${year}-${String(month).padStart(2, '0')}`,
        year,
        monthNum: month,
        daysInMonth,
        firstWeekday: new Date(year, month - 1, 1).getDay(),
        activeDays,
        vacationSkipped,
        vacationActive: vacationStatus(config.vacation, from).active,
        days,
    };
}

module.exports = {
    getUpcomingRuns,
    getCalendarMonth,
    scheduleOccurrences,
};
