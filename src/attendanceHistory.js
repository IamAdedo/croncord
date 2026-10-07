const fs = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, '..', 'attendance_history.json');
const MAX_HISTORY = 1000;

class AttendanceHistory {
    constructor() {
        this.history = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(HISTORY_PATH)) {
                const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
                this.history = JSON.parse(raw);
                if (!Array.isArray(this.history)) this.history = [];
            } else {
                this.history = [];
                this.save();
            }
        } catch (err) {
            console.error('[AttendanceHistory] Error loading history:', err.message);
            this.history = [];
        }
    }

    save() {
        try {
            fs.writeFileSync(HISTORY_PATH, JSON.stringify(this.history, null, 2), 'utf8');
        } catch (err) {
            console.error('[AttendanceHistory] Error saving history:', err.message);
        }
    }

    recordExecution({ serverId, serverName, channelId, scheduleId, scheduleLabel, type, status, error, details }) {
        const timestamp = new Date().toISOString();
        const date = timestamp.slice(0, 10);

        const normStatus = status === 'FAILED' ? 'FAILED' : (status === 'SKIPPED' ? 'SKIPPED' : 'SUCCESS');
        const defaultDetails = normStatus === 'SUCCESS'
            ? 'Attendance executed successfully'
            : (normStatus === 'SKIPPED' ? 'Attendance intentionally skipped (holiday / quiet hours)' : 'Attendance execution failed');

        const entry = {
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp,
            date,
            serverId: String(serverId || ''),
            serverName: serverName || 'Unknown Server',
            channelId: channelId || '',
            scheduleId: String(scheduleId || ''),
            scheduleLabel: scheduleLabel || 'Attendance Schedule',
            type: (type || 'MESSAGE').toUpperCase(),
            status: normStatus,
            error: error || null,
            details: details || defaultDetails
        };

        this.history.push(entry);
        if (this.history.length > MAX_HISTORY) {
            this.history.shift();
        }

        this.save();
        return entry;
    }

    getDailyStats(days = 30) {
        const result = [];
        const now = new Date();
        const datesMap = {};

        // Generate day buckets for the past `days`
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
            const dateKey = d.toISOString().slice(0, 10);
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const displayLabel = `${monthNames[d.getMonth()]} ${d.getDate()}`;
            const weekday = dayNames[d.getDay()];

            datesMap[dateKey] = {
                date: dateKey,
                label: displayLabel,
                weekday,
                checkins: 0,
                success: 0,
                failed: 0,
                skipped: 0,
            };
        }

        // Tally records (SKIPPED is neutral: counted, but excluded from success rate)
        this.history.forEach((item) => {
            if (datesMap[item.date]) {
                datesMap[item.date].checkins++;
                if (item.status === 'SUCCESS') {
                    datesMap[item.date].success++;
                } else if (item.status === 'SKIPPED') {
                    datesMap[item.date].skipped++;
                } else {
                    datesMap[item.date].failed++;
                }
            }
        });

        const dailyList = Object.values(datesMap);
        let totalCheckins = 0;
        let totalSuccess = 0;
        let totalFailed = 0;
        let totalSkipped = 0;
        let peakValue = 0;
        let peakDate = null;

        dailyList.forEach((day) => {
            totalCheckins += day.checkins;
            totalSuccess += day.success;
            totalFailed += day.failed;
            totalSkipped += day.skipped;
            if (day.checkins > peakValue) {
                peakValue = day.checkins;
                peakDate = `${day.label} (${day.checkins} check-ins)`;
            }
        });

        // Success rate covers decisive runs only — intentional skips never dilute it.
        const decisive = totalSuccess + totalFailed;
        const successRate = decisive > 0 ? ((totalSuccess / decisive) * 100).toFixed(1) : '0.0';
        const avgDaily = (totalCheckins / days).toFixed(1);

        return {
            daily: dailyList,
            summary: {
                days,
                totalCheckins,
                totalSuccess,
                totalFailed,
                totalSkipped,
                successRate: `${successRate}%`,
                avgDaily,
                peakDay: peakDate || 'None yet'
            }
        };
    }

    /**
     * Weekly digest summary for the digest post + dashboard.
     * @param {number} days window length (default 7)
     * @param {Array} servers server profiles for per-server breakdown
     */
    getWeeklyDigest(days = 7, servers = []) {
        const now = new Date();
        const from = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
        const fromKey = from.toISOString().slice(0, 10);
        const toKey = now.toISOString().slice(0, 10);
        const inWindow = this.history.filter((h) => h.date >= fromKey && h.date <= toKey);

        const count = (st) => inWindow.filter((h) => h.status === st).length;
        const success = count('SUCCESS');
        const failed = count('FAILED');
        const skipped = count('SKIPPED');
        const decisive = success + failed;

        const perServer = (servers || []).map((s) => {
            const recs = inWindow.filter((h) => String(h.serverId) === String(s.id));
            return {
                serverId: String(s.id),
                serverName: s.name,
                active: Boolean(s.active),
                success: recs.filter((r) => r.status === 'SUCCESS').length,
                failed: recs.filter((r) => r.status === 'FAILED').length,
                skipped: recs.filter((r) => r.status === 'SKIPPED').length,
                total: recs.length,
            };
        });

        return {
            days,
            from: fromKey,
            to: toKey,
            total: inWindow.length,
            success,
            failed,
            skipped,
            successRate: decisive > 0 ? ((success / decisive) * 100).toFixed(1) + '%' : '0.0%',
            perServer,
        };
    }

    getServerHealthMap(servers = []) {        const healthMap = {};

        servers.forEach((server) => {
            const serverId = String(server.id);
            const serverRecords = this.history.filter((h) => String(h.serverId) === serverId);
            const lastRecord = serverRecords[serverRecords.length - 1];

            let status = 'RUNNING';
            if (!server.active) {
                status = 'DISABLED';
            } else if (lastRecord && lastRecord.status === 'FAILED') {
                status = 'FAILED';
            } else {
                status = 'RUNNING';
            }

            const successRecords = serverRecords.filter((r) => r.status === 'SUCCESS');
            const lastSuccessRecord = successRecords[successRecords.length - 1];
            const successCount = successRecords.length;
            const failCount = serverRecords.filter((r) => r.status === 'FAILED').length;
            const skipCount = serverRecords.filter((r) => r.status === 'SKIPPED').length;

            // Streaks: consecutive SUCCESS runs; SKIPPED is neutral (bridged,
            // never extends, never breaks); the first FAILED ends the current run.
            let currentStreak = 0;
            for (let i = serverRecords.length - 1; i >= 0; i--) {
                const st = serverRecords[i].status;
                if (st === 'SUCCESS') currentStreak++;
                else if (st === 'SKIPPED') continue;
                else break;
            }
            let bestStreak = 0;
            let run = 0;
            serverRecords.forEach((r) => {
                if (r.status === 'SUCCESS') {
                    run++;
                    if (run > bestStreak) bestStreak = run;
                } else if (r.status === 'SKIPPED') {
                    // neutral: bridge without extending
                } else {
                    run = 0;
                }
            });

            healthMap[serverId] = {
                serverId,
                serverName: server.name,
                active: Boolean(server.active),
                health: status, // 'RUNNING' | 'FAILED' | 'DISABLED'
                lastRunAt: lastRecord ? lastRecord.timestamp : null,
                lastRunStatus: lastRecord ? lastRecord.status : null,
                lastRunLabel: lastRecord ? lastRecord.scheduleLabel : null,
                lastSuccessfulAt: lastSuccessRecord ? lastSuccessRecord.timestamp : null,
                lastError: lastRecord && lastRecord.error ? lastRecord.error : null,
                totalSuccess: successCount,
                totalFailed: failCount,
                totalSkipped: skipCount,
                currentStreak,
                bestStreak,
                recentExecutions: serverRecords.slice(-5)
            };
        });

        return healthMap;
    }
}

const attendanceHistory = new AttendanceHistory();
module.exports = attendanceHistory;
