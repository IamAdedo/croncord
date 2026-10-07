/**
 * src/scheduleConflicts.js
 *
 * Shared server-side conflict-detection logic (ported from the Web Dashboard
 * frontend so the API and CLI report the same warnings).
 * Flags schedule pairs on the same server that fire within 5 minutes of each
 * other on an overlapping day.
 */

function parseCronDaysAndMinutes(cronStr, sched) {
    if (!cronStr) return null;
    const parts = String(cronStr).trim().split(/\s+/);
    if (parts.length < 5) return null;

    const minutePart = parts[0];
    const hourPart = parts[1];
    const dowPart = parts[4];

    let hours = [];
    if (hourPart === '*') {
        hours = Array.from({ length: 24 }, (_, i) => i);
    } else if (hourPart.includes(',')) {
        hours = hourPart.split(',').map(Number).filter((n) => !Number.isNaN(n));
    } else {
        const h = parseInt(hourPart, 10);
        if (!Number.isNaN(h)) hours = [h];
    }

    let minutes = [];
    if (minutePart === '*') {
        minutes = [0];
    } else if (minutePart.includes(',')) {
        minutes = minutePart.split(',').map(Number).filter((n) => !Number.isNaN(n));
    } else {
        const m = parseInt(minutePart, 10);
        if (!Number.isNaN(m)) minutes = [m];
    }

    if (hours.length === 0 || minutes.length === 0) return null;

    const daysOfWeek = new Set();
    if (dowPart === '*') {
        [0, 1, 2, 3, 4, 5, 6].forEach((d) => daysOfWeek.add(d));
    } else if (dowPart === '1-5') {
        [1, 2, 3, 4, 5].forEach((d) => daysOfWeek.add(d));
    } else if (dowPart === '0,6' || dowPart === '6,0') {
        [0, 6].forEach((d) => daysOfWeek.add(d));
    } else if (dowPart.includes(',')) {
        dowPart.split(',').forEach((d) => {
            const num = parseInt(d, 10);
            if (!Number.isNaN(num)) daysOfWeek.add(num % 7);
        });
    } else if (dowPart.includes('-')) {
        const [start, end] = dowPart.split('-').map(Number);
        if (!Number.isNaN(start) && !Number.isNaN(end)) {
            for (let i = start; i <= end; i++) daysOfWeek.add(i % 7);
        }
    } else {
        const d = parseInt(dowPart, 10);
        if (!Number.isNaN(d)) daysOfWeek.add(d % 7);
    }

    const isOnce = sched && sched.type === 'ONCE';
    let onceDateStr = null;
    if (isOnce && sched.runDate) {
        const onceDate = new Date(sched.runDate);
        if (!Number.isNaN(onceDate.getTime())) {
            daysOfWeek.clear();
            daysOfWeek.add(onceDate.getDay());
            onceDateStr = sched.runDate;
        }
    }

    const timesInDay = [];
    hours.forEach((h) => {
        minutes.forEach((m) => {
            timesInDay.push(h * 60 + m);
        });
    });

    return { hours, minutes, daysOfWeek, timesInDay, isOnce, onceDateStr };
}

function formatMinutesToTime(totalMinutes) {
    const hours24 = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    const ampm = hours24 >= 12 ? 'PM' : 'AM';
    const hours12 = hours24 % 12 || 12;
    return `${String(hours12).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${ampm}`;
}

function checkSchedulesConflict(schedA, schedB) {
    const parsedA = parseCronDaysAndMinutes(schedA.cron, schedA);
    const parsedB = parseCronDaysAndMinutes(schedB.cron, schedB);
    if (!parsedA || !parsedB) return null;

    if (parsedA.isOnce && parsedB.isOnce) {
        if (parsedA.onceDateStr && parsedB.onceDateStr && parsedA.onceDateStr !== parsedB.onceDateStr) {
            return null;
        }
    }

    let hasOverlappingDay = false;
    for (const day of parsedA.daysOfWeek) {
        if (parsedB.daysOfWeek.has(day)) {
            hasOverlappingDay = true;
            break;
        }
    }
    if (!hasOverlappingDay) return null;

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

    if (minDiff <= 5 && bestPair) {
        return {
            scheduleAId: String(schedA.id),
            scheduleALabel: schedA.label,
            scheduleBId: String(schedB.id),
            scheduleBLabel: schedB.label,
            diffMinutes: minDiff,
            timeAStr: formatMinutesToTime(bestPair.tA),
            timeBStr: formatMinutesToTime(bestPair.tB),
            message: `⚠️ "${schedA.label}" (${formatMinutesToTime(bestPair.tA)}) conflicts with "${schedB.label}" (${formatMinutesToTime(bestPair.tB)}) — only ${minDiff}m apart. Re-schedule at least 10–15 minutes apart.`,
        };
    }
    return null;
}

function analyzeServerScheduleConflicts(server) {
    const schedules = (server && server.schedules) || [];
    if (schedules.length < 2) {
        return { hasConflict: false, conflicts: [], conflictingScheduleIds: [] };
    }
    const conflicts = [];
    const idSet = new Set();
    for (let i = 0; i < schedules.length; i++) {
        for (let j = i + 1; j < schedules.length; j++) {
            const conflict = checkSchedulesConflict(schedules[i], schedules[j]);
            if (conflict) {
                conflicts.push(conflict);
                idSet.add(String(schedules[i].id));
                idSet.add(String(schedules[j].id));
            }
        }
    }
    return {
        hasConflict: conflicts.length > 0,
        conflicts,
        conflictingScheduleIds: [...idSet],
    };
}

module.exports = {
    parseCronDaysAndMinutes,
    formatMinutesToTime,
    checkSchedulesConflict,
    analyzeServerScheduleConflicts,
};
