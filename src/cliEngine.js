/**
 * src/cliEngine.js
 *
 * Unified CLI command parser and executor for Croncord.
 * Used by:
 * - bin/cli.js (terminal CLI / scripts / interactive menu)
 * - server.js (Web dashboard interactive CLI terminal via POST /api/cli/exec)
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const https = require('https');
const { exec } = require('child_process');

const defaultDaemonManager = require('./daemonManager');
const defaultLogger = require('./logger');
const defaultAttendanceHistory = require('./attendanceHistory');
const { validateConfigSchema } = require('./schemaValidator');
const { VERSION, DISPLAY_VERSION } = require('./version');
const { analyzeServerScheduleConflicts } = require('./scheduleConflicts');
const { getUpcomingRuns } = require('./upcoming');
const configBackups = require('./configBackups');
const { validatePool, pickMessage, resolveTemplate } = require('./messageTemplates');
const suppression = require('./suppression');
const { CronExpressionParser } = require('cron-parser');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * Split command line preserving quoted strings
 * e.g. server add "My Server" 123456789 "0 9 * * *" "Present today"
 */
function parseArgs(commandStr) {
    const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
    const args = [];
    let match;
    while ((match = regex.exec(commandStr)) !== null) {
        if (match[1] !== undefined) {
            args.push(match[1]);
        } else if (match[2] !== undefined) {
            args.push(match[2]);
        } else {
            args.push(match[0]);
        }
    }
    return args;
}

function formatDuration(ms) {
    if (!ms || isNaN(ms)) return '0s';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

class CliEngine {
    constructor(deps = {}) {
        this.daemonManager = deps.daemonManager || defaultDaemonManager;
        this.logger = deps.logger || defaultLogger;
        this.attendanceHistory = deps.attendanceHistory || defaultAttendanceHistory;
    }

    getConfig() {
        if (this.daemonManager) {
            return this.daemonManager.getConfig();
        }
        if (!fs.existsSync(CONFIG_PATH)) {
            return { globalToken: '', globalWebhookUrl: '', servers: [] };
        }
        try {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        } catch (e) {
            return { globalToken: '', globalWebhookUrl: '', servers: [] };
        }
    }

    saveConfig(config) {
        if (this.daemonManager) {
            return this.daemonManager.saveConfig(config);
        }
        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
            return true;
        } catch (e) {
            return false;
        }
    }

    findServer(servers, target) {
        if (!target) return null;
        const key = String(target).trim();
        return (servers || []).find(
            (s) => String(s.id) === key || (s.name || '').toLowerCase() === key.toLowerCase()
        ) || null;
    }

    conflictWarningBlock(server) {
        try {
            const analysis = analyzeServerScheduleConflicts(server);
            if (!analysis.hasConflict) return '';
            const lines = ['', '⚠️ Schedule conflict warning (fires ≤5m apart on overlapping days):'];
            analysis.conflicts.forEach((c) => {
                lines.push(`   • ${c.message}`);
            });
            lines.push('   💡 Tip: re-schedule at least 10–15 minutes apart or stagger jitter.');
            return lines.join('\n');
        } catch (e) {
            return '';
        }
    }

    async execute(commandLineOrArgs) {
        let args = [];
        let commandLine = '';

        if (Array.isArray(commandLineOrArgs)) {
            args = commandLineOrArgs;
            commandLine = args.map(a => (String(a).includes(' ') ? `"${a}"` : a)).join(' ');
        } else {
            commandLine = (commandLineOrArgs || '').trim();
            if (!commandLine) {
                return { success: true, output: '' };
            }
            args = parseArgs(commandLine);
        }

        if (args.length === 0) {
            return { success: true, output: '' };
        }

        const command = (args[0] || '').toLowerCase();
        const subCommand = (args[1] || '').toLowerCase();

        try {
            switch (command) {
                case 'help':
                case '?':
                case '--help':
                case '-h':
                    return this.cmdHelp(subCommand);

                case 'status':
                case 'info':
                    return this.cmdStatus();

                case 'start':
                    return await this.cmdStart();

                case 'stop':
                    return await this.cmdStop();

                case 'restart':
                    return await this.cmdRestart();

                case 'list':
                case 'servers':
                    return this.cmdList(args.slice(1));

                case 'server':
                    return await this.cmdServer(args.slice(1));

                case 'schedule':
                case 'sched':
                    return await this.cmdSchedule(args.slice(1));

                case 'trigger':
                case 'run':
                    return await this.cmdTrigger(args.slice(1));

                case 'preview':
                case 'dry-run':
                case 'dryrun':
                    return this.cmdPreview(args.slice(1));

                case 'logs':
                case 'log':
                    return this.cmdLogs(args.slice(1));

                case 'token':
                    return this.cmdToken(args.slice(1));

                case 'webhook':
                    return await this.cmdWebhook(args.slice(1));

                case 'backup':
                case 'export':
                    return this.cmdBackup();

                case 'import':
                    return await this.cmdImport(args.slice(1));

                case 'validate':
                    return await this.cmdValidate(args.slice(1));

                case 'service':
                case 'pm2':
                    return await this.cmdService(args.slice(1));

                case 'upcoming':
                case 'next':
                    return this.cmdUpcoming(args.slice(1));

                case 'calendar':
                case 'cal':
                    return this.cmdCalendar(args.slice(1));

                case 'backups':
                case 'snapshots':
                    return this.cmdBackups();

                case 'restore':
                    return await this.cmdRestore(args.slice(1));

                case 'quiet':
                    return this.cmdQuiet(args.slice(1));

                case 'holiday':
                case 'holidays':
                    return this.cmdHoliday(args.slice(1));

                case 'vacation':
                case 'vacations':
                    return this.cmdVacation(args.slice(1));

                case 'heartbeat':
                case 'healthcheck':
                    return await this.cmdHeartbeat(args.slice(1));

                case 'digest':
                    return await this.cmdDigest(args.slice(1));

                case 'uptime':
                    return this.cmdUptime();

                case 'clear':
                case 'cls':
                    return { success: true, output: '__CLEAR__', isClear: true };

                default:
                    return {
                        success: false,
                        output: `❌ Unknown command: "${command}". Type "help" for a list of available CLI commands.`
                    };
            }
        } catch (err) {
            return {
                success: false,
                output: `❌ Error executing command "${command}": ${err.message}`
            };
        }
    }

    cmdHelp(topic) {
        if (topic === 'server') {
            return {
                success: true,
                output: [
                    '📌 Server Profile Commands:',
                    '  server list                            List all server profiles',
                    '  server add <name> <channelId> [cron] [msg] Quick-add server profile',
                    '  server edit <id> [name] [chan] [hook]  Edit server profile details',
                    '  server toggle <id|name>                Toggle pause / resume for server',
                    '  server pause <id|name>                 Pause automated monitoring for server',
                    '  server resume <id|name>                Resume automated monitoring for server',
                    '  server ignore-holidays <id> on|off    Opt server out of holiday skips',
                    '  server delete <id|name>                Delete a server profile',
                    '  server enable-all                      Enable monitoring on all servers',
                    '  server disable-all                     Disable monitoring on all servers',
                ].join('\n')
            };
        }

        if (topic === 'schedule') {
            return {
                success: true,
                output: [
                    '📌 Schedule Commands:',
                    '  schedule list <serverId|name>          List schedules for a server',
                    '  schedule add <serverId> <cron> [msg]   Add schedule (e.g. "0 9 * * 1-5")',
                    '  schedule toggle <serverId> <schedId>   Toggle active / paused on schedule',
                    '  schedule pause <serverId> <schedId>    Pause a specific schedule',
                    '  schedule resume <serverId> <schedId>   Resume a specific schedule',
                    '  schedule delete <serverId> <schedId>   Delete a schedule from a server',
                    '  schedule duplicate <srvId> <schedId> Duplicate a routine (starts paused)',
                    '  schedule reorder <serverId> <id1,id2>  Reorder schedules by priority',
                    '  schedule move <serverId> <from> <to>   Move schedule between positions',
                    '  schedule enable-all <serverId>        Enable every routine on a server',
                    '  schedule disable-all <serverId>       Pause every routine on a server',
                    '  schedule conflicts <serverId|name>     Show ≤5m clash warnings',
                    '  schedule pool <srvId> <schedId> [set|clear]  View/set message variants',
                ].join('\n')
            };
        }

        const lines = [
            '═══════════════════════════════════════════════════════════════',
            `⚡ Croncord CLI Commands & Operations (${DISPLAY_VERSION})`,
            '═══════════════════════════════════════════════════════════════',
            '  status                                 Show daemon status & health overview',
            '  start                                  Start background Discord attendance daemon',
            '  stop                                   Stop background Discord attendance daemon',
            '  restart                                Restart daemon and re-initialize schedules',
            '  list (or servers)                      List configured servers and schedules',
            '',
            '  server add <name> <chanId> [cron] [msg] Create a new server profile',
            '  server edit <id> [name] [chan] [hook]  Edit server name, channel, or webhook',
            '  server toggle <id|name>                Pause / Resume a server profile',
                    '  server delete <id|name>                Remove a server profile',
            '  server clone <id> <name> <chanId>      Duplicate profile with fresh IDs',
                    '  server clone <id> <name> <chanId>      Duplicate a profile (fresh IDs)',
            '  server enable-all / disable-all        Bulk enable or disable all servers',
            '',
            '  schedule add <srvId> <cron> [message]  Add attendance schedule to server',
            '  schedule list <srvId>                  List all schedules for a server',
            '  schedule toggle <srvId> <schedId>      Pause / Resume a specific schedule',
            '  schedule delete <srvId> <schedId>      Remove schedule from server',
            '  schedule duplicate <srvId> <schedId>   Copy a routine (starts paused)',
            '  schedule reorder <srvId> <id1,id2>     Reorder schedule priority sequence',
            '  schedule conflicts <srvId>             Show ≤5m clash warnings',
            '  schedule pool <srvId> <schedId>        View/set message variants',
            '',
            '  upcoming [count]                       Preview next scheduled fire times',
            '  calendar [YYYY-MM]                      Monthly firing calendar',
            '  quiet [HH:MM HH:MM|clear]              View/set/clear global quiet hours',
            '  holiday list|add|remove                Manage named skip-date holidays',
            '  vacation [until] [note]|off           Pause all until a date (auto-resume)',
            '  heartbeat [url] [mins]|test|off      External monitor pings',
            '  digest [on|off|test]                   Weekly webhook stats summary',
            '  backups (or snapshots)                 List auto config restore points',
            '  restore <config-*.json>                Roll back to a restore point',
            '',
            '  trigger <serverId> [scheduleId]        Manually trigger attendance run now',
            '  preview <serverId> [scheduleId]        Dry-run: show resolved post text (sends nothing)',
            '  logs [count]                           Display recent activity logs (default: 15)',
            '  logs clear                             Clear session activity logs',
            '  token [new_token]                      View or update Discord user token',
            '  webhook [url]                          View or update Discord notification webhook',
            '  webhook test [url]                     Test webhook delivery with embed alert',
            '',
            '  backup (or export)                     Export current configuration JSON',
            '  validate <path/to/file.json>           Validate JSON schema structure',
            '  import <path/to/file.json> [merge]     Import JSON with strict schema check',
            '  service <status|install|stop|logs>     Manage background PM2 service',
            '  uptime                                 View uptime and execution reliability',
            '  clear                                  Clear terminal screen',
            '═══════════════════════════════════════════════════════════════',
            '💡 Tip: Type "help server" or "help schedule" for detailed subcommands.'
        ];

        return { success: true, output: lines.join('\n') };
    }

    cmdStatus() {
        const config = this.getConfig();
        const servers = config.servers || [];
        const activeServers = servers.filter(s => s.active);
        let totalSchedules = 0;
        let activeSchedules = 0;
        servers.forEach(s => {
            (s.schedules || []).forEach(sc => {
                totalSchedules++;
                if (s.active && sc.active) activeSchedules++;
            });
        });

        let daemonStatus = 'STOPPED';
        let userTag = 'None';
        let uptimeStr = '0s';
        let activeJobsCount = activeSchedules;
        let reconnectLine = null;

        if (this.daemonManager) {
            const st = this.daemonManager.getStatus();
            daemonStatus = st.status || 'STOPPED';
            userTag = st.user?.tag || (st.user?.username ? `@${st.user.username}` : 'Not Connected');
            activeJobsCount = st.activeJobsCount !== undefined ? st.activeJobsCount : activeSchedules;
            if (st.startedAt) {
                uptimeStr = formatDuration(Date.now() - st.startedAt);
            }
            if (st.reconnect && (st.reconnect.pending || (st.reconnect.attempts || 0) > 0)) {
                const r = st.reconnect;
                reconnectLine = r.pending
                    ? `🔄 Self-heal retry ${r.attempts}/${r.maxAttempts} in ${Math.max(0, Math.ceil((r.nextAt - Date.now()) / 1000))}s`
                    : `🔄 Self-heal attempted ${r.attempts}/${r.maxAttempts} (last: ${r.lastError || 'n/a'})`;
            }
        }

        const statusEmoji = daemonStatus === 'RUNNING' ? '🟢 RUNNING' : daemonStatus === 'STARTING' ? '🟡 STARTING' : daemonStatus === 'ERROR' ? '🔴 ERROR' : '⚪ STOPPED';

        const lines = [
            '─────────────────────────────────────────────────────────────',
            '📊 Croncord System & Daemon Status',
            '─────────────────────────────────────────────────────────────',
            `  Daemon State     : ${statusEmoji}`,
            `  Discord Account  : ${userTag}`,
            `  Daemon Uptime    : ${uptimeStr}`,
            `  Web Server Port  : 3271 (Dashboard: http://localhost:3271)`,
            `  Discord Token    : ${config.globalToken ? `Configured (${config.globalToken.substring(0, 8)}...)` : '❌ MISSING (run "token <value>")'}`,
            `  Global Webhook   : ${config.globalWebhookUrl ? config.globalWebhookUrl.substring(0, 45) + '...' : 'Not Configured'}`,
            `  Server Profiles  : ${servers.length} configured (${activeServers.length} active)`,
            `  Schedules Count  : ${totalSchedules} total (${activeSchedules} active timers)`,
            `  Cron Watchers    : ${activeJobsCount} live cron triggers registered`,
        ];
        if (reconnectLine) {
            lines.push(`  Self-Heal        : ${reconnectLine}`);
        }
        try {
            const vac = suppression.vacationStatus(config.vacation, new Date());
            if (vac.active) {
                lines.push(`  Vacation         : 🏖️ ARMED until ${vac.until}${vac.note ? ` ("${vac.note}")` : ''} — all firings skipped`);
            }
        } catch (e) { /* never break status */ }
        lines.push('─────────────────────────────────────────────────────────────');

        return { success: true, output: lines.join('\n') };
    }

    async cmdStart() {
        if (!this.daemonManager) {
            return { success: false, output: '❌ Daemon Manager instance is not attached in standalone CLI mode.' };
        }
        const res = await this.daemonManager.start();
        if (res.success) {
            return {
                success: true,
                output: '✅ Croncord daemon started successfully!\nSchedules are now actively monitored.'
            };
        } else {
            return {
                success: false,
                output: `❌ Failed to start daemon: ${res.message || 'Unknown error'}`
            };
        }
    }

    async cmdStop() {
        if (!this.daemonManager) {
            return { success: false, output: '❌ Daemon Manager instance is not attached in standalone CLI mode.' };
        }
        const res = await this.daemonManager.stop();
        if (res.success) {
            return {
                success: true,
                output: '⚪ Croncord daemon stopped. Schedule timers paused.'
            };
        } else {
            return {
                success: false,
                output: `❌ Failed to stop daemon: ${res.message || 'Unknown error'}`
            };
        }
    }

    async cmdRestart() {
        if (!this.daemonManager) {
            return { success: false, output: '❌ Daemon Manager instance is not attached in standalone CLI mode.' };
        }
        await this.daemonManager.stop();
        const res = await this.daemonManager.start();
        if (res.success) {
            return { success: true, output: '🔄 Croncord daemon restarted successfully!' };
        } else {
            return { success: false, output: `❌ Failed to restart daemon: ${res.message}` };
        }
    }

    cmdList(args = []) {
        const config = this.getConfig();
        const servers = config.servers || [];

        if (servers.length === 0) {
            return {
                success: true,
                output: '⚠️ No Discord server profiles configured yet.\nUse: server add <name> <channelId> [cron] [message] to create your first profile.'
            };
        }

        const healthMap = (this.attendanceHistory && this.attendanceHistory.getServerHealthMap)
            ? this.attendanceHistory.getServerHealthMap(servers)
            : {};

        const lines = [
            `📋 Configured Server Profiles (${servers.length} Total):`,
            '─────────────────────────────────────────────────────────────',
        ];

        servers.forEach((srv, idx) => {
            const hInfo = healthMap[srv.id] || {};
            const health = !srv.active ? '⚪ DISABLED' : (hInfo.health === 'FAILED' ? '🔴 FAILED' : '🟢 RUNNING');
            const scheds = srv.schedules || [];

            lines.push(`[#${idx + 1}] ID: ${srv.id} | Name: "${srv.name}" | Status: ${health}`);
            lines.push(`     Channel ID : ${srv.channelId}`);
            if (srv.webhookUrl) lines.push(`     Webhook    : ${srv.webhookUrl.substring(0, 45)}...`);
            if (hInfo.lastSuccessfulAt) {
                const diffMs = Math.max(0, Date.now() - new Date(hInfo.lastSuccessfulAt).getTime());
                const mins = Math.floor(diffMs / 60000);
                const timeAgo = mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
                lines.push(`     Uptime     : Last success ${timeAgo}`);
            }

            if (scheds.length === 0) {
                lines.push('     Schedules  : None configured');
            } else {
                lines.push(`     Schedules (${scheds.length}):`);
                scheds.forEach((sc, sIdx) => {
                    const scState = sc.active ? 'ACTIVE' : 'PAUSED';
                    const msgPreview = (sc.message || 'Present').replace(/\n/g, ' ⏎ ');
                    lines.push(`       ${sIdx + 1}. [${scState}] ID:${sc.id} | "${sc.label}" (${sc.cron}) | Jitter:${sc.maxJitterMinutes || 0}m | "${msgPreview}"`);
                });
            }
            lines.push('─────────────────────────────────────────────────────────────');
        });

        return { success: true, output: lines.join('\n') };
    }

    async cmdServer(args) {
        const sub = (args[0] || '').toLowerCase();
        const config = this.getConfig();
        const servers = config.servers || [];

        if (!sub || sub === 'list') {
            return this.cmdList(args.slice(1));
        }

        if (sub === 'add') {
            const name = args[1];
            const channelId = args[2];
            const cronExp = args[3] || '0 9 * * 1-5';
            const message = args[4] || 'Present';

            if (!name || !channelId) {
                return {
                    success: false,
                    output: '❌ Usage: server add "<server_name>" <channel_id> [cron_expression] [message]'
                };
            }

            const cleanChan = channelId.trim();
            const cleanName = name.trim().toLowerCase();
            const existingServer = servers.find(
                (s) => (s.channelId && s.channelId.trim() === cleanChan) ||
                       (s.name && s.name.trim().toLowerCase() === cleanName)
            );

            if (existingServer) {
                return {
                    success: false,
                    output: `⚠️ Server profile "${existingServer.name}" already exists (Channel: ${existingServer.channelId}, ID: ${existingServer.id}).\nTo add a schedule to this server, run:\n  schedule add ${existingServer.id} "${cronExp}" "${message}"`
                };
            }

            if (cronExp && !cron.validate(cronExp)) {
                return {
                    success: false,
                    output: `❌ Invalid cron expression syntax: "${cronExp}". Example: "0 9 * * 1-5" for weekdays 9:00 AM.`
                };
            }

            const newServer = {
                id: Date.now().toString(),
                name: name.trim(),
                channelId: channelId.trim(),
                webhookUrl: '',
                active: true,
                ignoreHolidays: false,
                schedules: [
                    {
                        id: Date.now().toString() + '01',
                        label: 'Default Attendance',
                        cron: cronExp.trim(),
                        attendanceType: 'MESSAGE',
                        message: message.trim(),
                        messagePool: [],
                        emoji: '👍',
                        targetMessageId: '',
                        maxJitterMinutes: 10,
                        active: true,
                    }
                ]
            };

            servers.push(newServer);
            config.servers = servers;
            const saved = this.saveConfig(config);

            if (saved) {
                return {
                    success: true,
                    output: `✅ Server profile "${newServer.name}" created successfully with 1 schedule.\nServer ID: ${newServer.id} | Channel ID: ${newServer.channelId}`
                };
            } else {
                return { success: false, output: '❌ Failed to save configuration to disk.' };
            }
        }

        if (sub === 'pause' || sub === 'resume') {
            const target = args[1];
            if (!target) return { success: false, output: `❌ Usage: server ${sub} <serverId|serverName>` };

            const srv = servers.find(s => String(s.id) === target || s.name.toLowerCase() === target.toLowerCase());
            if (!srv) {
                return { success: false, output: `❌ Server "${target}" not found.` };
            }

            srv.active = (sub === 'resume');
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `✅ Server "${srv.name}" (ID: ${srv.id}) is now ${srv.active ? 'ACTIVE (Resumed)' : 'PAUSED (Disabled)'}.`
            };
        }

        if (sub === 'delete' || sub === 'rm') {
            const target = args[1];
            if (!target) return { success: false, output: '❌ Usage: server delete <serverId|serverName>' };

            const idx = servers.findIndex(s => String(s.id) === target || s.name.toLowerCase() === target.toLowerCase());
            if (idx === -1) {
                return { success: false, output: `❌ Server "${target}" not found.` };
            }

            const removed = servers.splice(idx, 1)[0];
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `🗑️ Server "${removed.name}" (ID: ${removed.id}) has been deleted.`
            };
        }

        if (sub === 'toggle') {
            const target = args[1];
            if (!target) return { success: false, output: '❌ Usage: server toggle <serverId|serverName>' };
            const srv = servers.find(s => String(s.id) === target || s.name.toLowerCase() === target.toLowerCase());
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };
            srv.active = !srv.active;
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `✅ Server "${srv.name}" (ID: ${srv.id}) is now ${srv.active ? 'ACTIVE' : 'PAUSED'}.`
            };
        }

        if (sub === 'edit') {
            const target = args[1];
            const newName = args[2];
            const newChan = args[3];
            const newWebhook = args[4];
            if (!target) return { success: false, output: '❌ Usage: server edit <serverId|serverName> [newName] [newChannelId] [newWebhookUrl]' };
            const srv = servers.find(s => String(s.id) === target || s.name.toLowerCase() === target.toLowerCase());
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };
            if (newName && newName !== '-') srv.name = newName.trim();
            if (newChan && newChan !== '-') srv.channelId = newChan.trim();
            if (newWebhook !== undefined && newWebhook !== '-') srv.webhookUrl = newWebhook.trim();
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `✅ Server "${srv.name}" (ID: ${srv.id}) updated.\nChannel: ${srv.channelId} | Webhook: ${srv.webhookUrl || 'None'}`
            };
        }

        if (sub === 'ignore-holidays' || sub === 'noholiday' || sub === 'no-holiday') {
            const target = args[1];
            const mode = (args[2] || '').toLowerCase();
            if (!target || !['on', 'off'].includes(mode)) {
                return { success: false, output: '❌ Usage: server ignore-holidays <serverId|serverName> on|off' };
            }
            const srv = this.findServer(servers, target);
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };
            srv.ignoreHolidays = (mode === 'on');
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: srv.ignoreHolidays
                    ? `✅ Server "${srv.name}" will now RUN on holidays (global holiday skips ignored).`
                    : `✅ Server "${srv.name}" will now SKIP on holidays (observes the global holiday list).`
            };
        }

        if (sub === 'clone') {
            const target = args[1];
            const newName = args[2];
            const newChannelId = args[3];
            if (!target || !newName || !newChannelId) {
                return { success: false, output: '❌ Usage: server clone <serverId|serverName> "<new_name>" <new_channel_id>' };
            }
            const src = this.findServer(servers, target);
            if (!src) return { success: false, output: `❌ Server "${target}" not found.` };

            const cleanChan = String(newChannelId).trim();
            const dupe = servers.find((s) => (s.channelId && s.channelId.trim() === cleanChan));
            if (dupe) {
                return { success: false, output: `❌ Channel ${cleanChan} is already used by "${dupe.name}". Pick another channel.` };
            }

            const stamp = Date.now().toString();
            const cloned = {
                id: stamp,
                name: String(newName).trim(),
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
            servers.push(cloned);
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `✅ Cloned "${src.name}" → "${cloned.name}" with ${(cloned.schedules || []).length} schedule(s) (fresh IDs).\nServer ID: ${cloned.id} | Channel ID: ${cloned.channelId}${this.conflictWarningBlock(cloned)}`
            };
        }

        if (sub === 'enable-all' || sub === 'disable-all') {
            const enable = (sub === 'enable-all');
            servers.forEach(s => { s.active = enable; });
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `✅ ${enable ? 'Enabled' : 'Disabled'} all ${servers.length} server profiles.`
            };
        }

        return {
            success: false,
            output: `❌ Unknown server subcommand: "${sub}". Try "help server".`
        };
    }

    async cmdSchedule(args) {
        const sub = (args[0] || '').toLowerCase();
        const config = this.getConfig();
        const servers = config.servers || [];

        if (sub === 'list') {
            const target = args[1];
            if (!target) return { success: false, output: '❌ Usage: schedule list <serverId|serverName>' };
            const srv = servers.find(s => String(s.id) === target || s.name.toLowerCase() === target.toLowerCase());
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };

            const scheds = srv.schedules || [];
            if (scheds.length === 0) return { success: true, output: `Server "${srv.name}" has no schedules.` };

            const lines = [`📅 Schedules for "${srv.name}" (ID: ${srv.id}) — priority order:`];
            scheds.forEach((sc, i) => {
                lines.push(`  [#${i + 1}] ID: ${sc.id} | "${sc.label}" | Cron: "${sc.cron}" | Active: ${sc.active ? 'YES' : 'NO'}`);
            });
            lines.push(this.conflictWarningBlock(srv));
            return { success: true, output: lines.join('\n').trimEnd() };
        }

        if (sub === 'conflicts' || sub === 'check' || sub === 'check-conflicts') {
            const target = args[1];
            if (!target) return { success: false, output: '❌ Usage: schedule conflicts <serverId|serverName>' };
            const srv = this.findServer(servers, target);
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };
            const analysis = analyzeServerScheduleConflicts(srv);
            if (!analysis.hasConflict) {
                return { success: true, output: `✅ No schedule conflicts detected on "${srv.name}" (${(srv.schedules || []).length} schedule(s) checked).` };
            }
            const lines = [
                `⚠️ ${analysis.conflicts.length} schedule conflict(s) on "${srv.name}":`,
                ...analysis.conflicts.map((c) => `  • ${c.message}`),
                '💡 Tip: re-schedule at least 10–15 minutes apart or stagger jitter.',
            ];
            return { success: true, output: lines.join('\n') };
        }

        if (sub === 'pool' || sub === 'messages' || sub === 'variants') {
            const target = args[1];
            const schedId = args[2];
            const action = (args[3] || 'view').toLowerCase();
            if (!target || !schedId) {
                return { success: false, output: '❌ Usage: schedule pool <serverId|serverName> <scheduleId> [view|set <msg...> |clear]\nExample: schedule pool srv1 a1 set "Present ✅" "Here 🙋"' };
            }
            const srv = this.findServer(servers, target);
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };
            const sc = (srv.schedules || []).find((x) => String(x.id) === String(schedId));
            if (!sc) return { success: false, output: `❌ Schedule "${schedId}" not found on server "${srv.name}".` };
            if (sc.attendanceType === 'REACTION') {
                return { success: false, output: '❌ Message pools apply to MESSAGE schedules only (reaction mode uses emoji).' };
            }

            if (action === 'view' || action === 'show' || action === 'list') {
                const pool = Array.isArray(sc.messagePool) ? sc.messagePool : [];
                const lines = [`💬 Message variants for "${sc.label}" on "${srv.name}":`, `   Base: "${sc.message || 'Present'}"`];
                if (pool.length === 0) {
                    lines.push('   Pool: (empty — base message always sent; variables like {day} still resolve)');
                } else {
                    pool.forEach((m, i) => lines.push(`   [${i + 1}] "${m}"`));
                    lines.push('   One variant is picked at random per run, then {variables} resolve.');
                }
                return { success: true, output: lines.join('\n') };
            }

            if (action === 'clear') {
                sc.messagePool = [];
                config.servers = servers;
                this.saveConfig(config);
                return { success: true, output: `🧹 Cleared message variants on "${sc.label}" (base message kept).` };
            }

            if (action === 'set' || action === 'add') {
                const variants = args.slice(4).map((m) => String(m)).filter((m) => m.trim());
                if (variants.length === 0) {
                    return { success: false, output: '❌ Usage: schedule pool <serverId> <scheduleId> set "variant 1" ["variant 2" ...]' };
                }
                const check = validatePool(action === 'add' ? [...(sc.messagePool || []), ...variants] : variants);
                if (!check.valid) return { success: false, output: `❌ ${check.error}` };
                sc.messagePool = check.sanitized;
                config.servers = servers;
                this.saveConfig(config);
                return {
                    success: true,
                    output: `✅ Set ${sc.messagePool.length} message variant(s) on "${sc.label}".\n` +
                        sc.messagePool.map((m, i) => `   [${i + 1}] "${m}"`).join('\n')
                };
            }

            return { success: false, output: '❌ Usage: schedule pool <serverId> <scheduleId> [view|set <msg...>|clear]' };
        }

        if (sub === 'add') {
            const target = args[1];
            const cronExp = args[2];
            const message = args[3] || 'Present';
            const label = args[4] || 'Scheduled Attendance';

            if (!target || !cronExp) {
                return { success: false, output: '❌ Usage: schedule add <serverId|serverName> <cron> [message] [label]' };
            }

            if (!cron.validate(cronExp)) {
                return { success: false, output: `❌ Invalid cron expression syntax: "${cronExp}".` };
            }

            const srv = servers.find(s => String(s.id) === target || s.name.toLowerCase() === target.toLowerCase());
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };

            if (!srv.schedules) srv.schedules = [];
            const newSched = {
                id: Date.now().toString() + Math.floor(Math.random() * 100),
                label,
                cron: cronExp.trim(),
                attendanceType: 'MESSAGE',
                message,
                messagePool: [],
                emoji: '👍',
                targetMessageId: '',
                maxJitterMinutes: 10,
                active: true,
            };

            srv.schedules.push(newSched);
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `✅ Added schedule "${newSched.label}" to server "${srv.name}".\nSchedule ID: ${newSched.id} | Cron: ${newSched.cron}${this.conflictWarningBlock(srv)}`
            };
        }

        if (sub === 'delete' || sub === 'rm') {
            const target = args[1];
            const schedId = args[2];
            if (!target || !schedId) {
                return { success: false, output: '❌ Usage: schedule delete <serverId> <scheduleId>' };
            }
            const srv = servers.find(s => String(s.id) === target || s.name.toLowerCase() === target.toLowerCase());
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };

            const idx = (srv.schedules || []).findIndex(sc => String(sc.id) === String(schedId));
            if (idx === -1) return { success: false, output: `❌ Schedule "${schedId}" not found on server "${srv.name}".` };

            const removed = srv.schedules.splice(idx, 1)[0];
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `🗑️ Schedule "${removed.label}" deleted from server "${srv.name}".`
            };
        }

        if (sub === 'toggle' || sub === 'pause' || sub === 'resume') {
            const target = args[1];
            const schedId = args[2];
            if (!target || !schedId) return { success: false, output: `❌ Usage: schedule ${sub} <serverId> <scheduleId>` };
            const srv = servers.find(s => String(s.id) === target || s.name.toLowerCase() === target.toLowerCase());
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };
            const sc = (srv.schedules || []).find(s => String(s.id) === String(schedId));
            if (!sc) return { success: false, output: `❌ Schedule "${schedId}" not found on server "${srv.name}".` };
            if (sub === 'toggle') sc.active = !sc.active;
            else if (sub === 'pause') sc.active = false;
            else if (sub === 'resume') sc.active = true;
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `✅ Schedule "${sc.label}" on server "${srv.name}" is now ${sc.active ? 'ACTIVE' : 'PAUSED'}.`
            };
        }

        if (sub === 'reorder' || sub === 'priority') {
            const target = args[1];
            const idsArg = args[2];
            if (!target || !idsArg) {
                return { success: false, output: '❌ Usage: schedule reorder <serverId> <id1,id2,...>' };
            }
            const srv = servers.find(s => String(s.id) === target || s.name.toLowerCase() === target.toLowerCase());
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };

            const requestedIds = idsArg.split(',').map(s => s.trim()).filter(Boolean);
            const currentScheds = srv.schedules || [];
            const schedMap = new Map();
            currentScheds.forEach(s => schedMap.set(String(s.id), s));

            const reordered = [];
            for (const id of requestedIds) {
                if (schedMap.has(id)) {
                    reordered.push(schedMap.get(id));
                    schedMap.delete(id);
                }
            }
            for (const rem of schedMap.values()) {
                reordered.push(rem);
            }

            srv.schedules = reordered;
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `✅ Reordered ${reordered.length} schedules on "${srv.name}". New priority sequence:\n` +
                    reordered.map((sc, i) => `  #${i + 1}: ${sc.label} (ID: ${sc.id})`).join('\n')
            };
        }

        if (sub === 'move') {
            const target = args[1];
            const fromIdx = parseInt(args[2], 10) - 1;
            const toIdx = parseInt(args[3], 10) - 1;
            if (!target || isNaN(fromIdx) || isNaN(toIdx)) {
                return { success: false, output: '❌ Usage: schedule move <serverId> <fromPosition> <toPosition>\nExample: schedule move 179015 2 1 (moves 2nd schedule to 1st)' };
            }
            const srv = servers.find(s => String(s.id) === target || s.name.toLowerCase() === target.toLowerCase());
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };

            const scheds = srv.schedules || [];
            if (fromIdx < 0 || fromIdx >= scheds.length || toIdx < 0 || toIdx >= scheds.length) {
                return { success: false, output: `❌ Position out of bounds. Server has ${scheds.length} schedules (positions 1 through ${scheds.length}).` };
            }

            const [moved] = scheds.splice(fromIdx, 1);
            scheds.splice(toIdx, 0, moved);

            srv.schedules = scheds;
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `✅ Moved schedule "${moved.label}" to position #${toIdx + 1}.\nNew sequence:\n` +
                    scheds.map((sc, i) => `  #${i + 1}: ${sc.label} (ID: ${sc.id})`).join('\n')
            };
        }

        if (sub === 'duplicate' || sub === 'copy' || sub === 'dup' || sub === 'clone') {
            const target = args[1];
            const schedId = args[2];
            if (!target || !schedId) {
                return { success: false, output: '❌ Usage: schedule duplicate <serverId|serverName> <scheduleId>' };
            }
            const srv = this.findServer(servers, target);
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };
            const sc = (srv.schedules || []).find((x) => String(x.id) === String(schedId));
            if (!sc) return { success: false, output: `❌ Schedule "${schedId}" not found on server "${srv.name}".` };
            const copy = {
                ...JSON.parse(JSON.stringify(sc)),
                id: Date.now().toString() + Math.floor(Math.random() * 1000),
                label: `${sc.label} (copy)`,
                active: false,
            };
            srv.schedules.push(copy);
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `✅ Duplicated "${sc.label}" → "${copy.label}" on "${srv.name}" (starts PAUSED — edit the time, then resume).\nSchedule ID: ${copy.id} | Cron: ${copy.cron}${this.conflictWarningBlock(srv)}`
            };
        }

        if (sub === 'enable-all' || sub === 'disable-all') {
            const target = args[1];
            if (!target) return { success: false, output: `❌ Usage: schedule ${sub} <serverId|serverName>` };
            const srv = this.findServer(servers, target);
            if (!srv) return { success: false, output: `❌ Server "${target}" not found.` };
            const enable = (sub === 'enable-all');
            (srv.schedules || []).forEach((sc) => { sc.active = enable; });
            config.servers = servers;
            this.saveConfig(config);
            return {
                success: true,
                output: `✅ ${enable ? 'Enabled' : 'Paused'} all ${(srv.schedules || []).length} schedule(s) on "${srv.name}".`
            };
        }

        return { success: false, output: '❌ Unknown schedule subcommand. Try "help schedule".' };
    }

    async cmdTrigger(args) {
        const srvId = args[0];
        const schedId = args[1];

        if (!srvId) {
            return { success: false, output: '❌ Usage: trigger <serverId|serverName> [scheduleId]' };
        }

        if (!this.daemonManager) {
            return { success: false, output: '❌ Daemon manager not connected. Make sure the server or daemon is spinning.' };
        }

        const config = this.getConfig();
        const srv = (config.servers || []).find(s => String(s.id) === srvId || s.name.toLowerCase() === srvId.toLowerCase());
        if (!srv) {
            return { success: false, output: `❌ Server profile "${srvId}" not found.` };
        }

        let targetSchedId = schedId;
        if (!targetSchedId && srv.schedules && srv.schedules.length > 0) {
            targetSchedId = srv.schedules[0].id;
        }

        if (!targetSchedId) {
            return { success: false, output: `❌ No schedules found for server "${srv.name}".` };
        }

        try {
            const res = await this.daemonManager.triggerTask(srv.id, targetSchedId, false);
            if (res.success) {
                return {
                    success: true,
                    output: `⚡ Attendance task executed successfully on [${srv.name}]!\nResult: ${res.message || 'OK'}`
                };
            } else {
                return {
                    success: false,
                    output: `❌ Execution failed on [${srv.name}]: ${res.error || res.message || 'Unknown error'}`
                };
            }
        } catch (err) {
            return { success: false, output: `❌ Trigger error: ${err.message}` };
        }
    }

    /**
     * Builds a dry-run preview payload for one schedule (shared by the
     * `preview` command and the dashboard preview endpoint).
     * Pure read-only: resolves templates + pool variants, never sends.
     */
    buildPreview(server, schedule, at = new Date()) {
        const isReaction = (schedule.attendanceType || 'MESSAGE').toUpperCase() === 'REACTION';
        let nextFire = null;
        try {
            const it = CronExpressionParser.parse(schedule.cron, { currentDate: at });
            nextFire = it.next().toDate().toISOString();
        } catch (e) {
            nextFire = null;
        }

        const base = {
            serverId: String(server.id),
            serverName: server.name,
            channelId: server.channelId,
            scheduleId: String(schedule.id),
            scheduleLabel: schedule.label,
            cron: schedule.cron,
            attendanceType: isReaction ? 'REACTION' : 'MESSAGE',
            active: Boolean(schedule.active),
            nextFire,
            previewedAt: at.toISOString(),
        };

        if (isReaction) {
            return {
                ...base,
                emoji: schedule.emoji || '👍',
                targetMessageId: schedule.targetMessageId || '(newest message in channel)',
            };
        }

        const pool = Array.isArray(schedule.messagePool)
            ? schedule.messagePool.map((m) => String(m)).filter((m) => m.trim())
            : [];
        return {
            ...base,
            baseMessage: schedule.message || 'Present',
            resolvedBase: resolveTemplate(schedule.message || 'Present', server, at),
            pool,
            resolvedPool: pool.map((m) => resolveTemplate(m, server, at)),
            randomPickNote: pool.length > 0
                ? 'One variant is picked at random per run (preview shows all).'
                : 'No variants — base message always sent.',
        };
    }

    cmdPreview(args) {
        const srvId = args[0];
        const schedId = args[1];
        if (!srvId) {
            return { success: false, output: '❌ Usage: preview <serverId|serverName> [scheduleId]' };
        }
        const config = this.getConfig();
        const srv = this.findServer((config.servers || []), srvId);
        if (!srv) {
            return { success: false, output: `❌ Server profile "${srvId}" not found.` };
        }
        let target = null;
        if (schedId) {
            target = (srv.schedules || []).find((s) => String(s.id) === String(schedId));
            if (!target) return { success: false, output: `❌ Schedule "${schedId}" not found on server "${srv.name}".` };
        } else {
            target = (srv.schedules || [])[0];
            if (!target) return { success: false, output: `❌ No schedules found for server "${srv.name}".` };
        }

        const p = this.buildPreview(srv, target, new Date());
        const lines = [
            `👁️ Dry-run preview — "${p.scheduleLabel}" on "${p.serverName}" (nothing sent):`,
            '─────────────────────────────────────────────────────────────',
            `   Channel   : ${p.channelId}`,
            `   Cron      : ${p.cron}${p.nextFire ? `  (next: ${new Date(p.nextFire).toLocaleString()})` : '  (unparseable cron)'}`,
            `   Mode      : ${p.attendanceType}${p.active ? '' : '  [PAUSED]'}`,
        ];
        if (p.attendanceType === 'REACTION') {
            lines.push(`   Emoji     : ${p.emoji}`);
            lines.push(`   Target    : ${p.targetMessageId}`);
        } else {
            lines.push(`   Message   : "${p.resolvedBase}"`);
            if (p.pool.length > 0) {
                lines.push(`   Variants (${p.pool.length}, random pick at runtime):`);
                p.resolvedPool.forEach((m, i) => lines.push(`     [${i + 1}] "${m}"`));
            } else {
                lines.push('   Variants  : none (base message always sent)');
            }
        }
        lines.push('─────────────────────────────────────────────────────────────');
        return { success: true, output: lines.join('\n') };
    }

    cmdLogs(args) {
        if (args[0] === 'clear') {
            if (this.logger && this.logger.clearHistory) {
                this.logger.clearHistory();
            }
            return { success: true, output: '🧹 Session activity logs cleared.' };
        }

        const count = parseInt(args[0], 10) || 15;
        const logs = (this.logger && this.logger.getHistory) ? this.logger.getHistory() : [];

        if (logs.length === 0) {
            return { success: true, output: 'No activity logs captured yet.' };
        }

        const slice = logs.slice(-count);
        const lines = [
            `📜 Recent Activity Logs (Last ${slice.length} of ${logs.length}):`,
            '─────────────────────────────────────────────────────────────'
        ];

        slice.forEach(e => {
            const time = e.time ? new Date(e.time).toLocaleTimeString() : '--:--';
            const lvl = (e.level || 'INFO').padEnd(7);
            lines.push(`[${time}] ${lvl} : ${e.message}`);
        });

        return { success: true, output: lines.join('\n') };
    }

    cmdToken(args) {
        const config = this.getConfig();
        const newToken = args[0];

        if (!newToken || newToken === 'show') {
            if (!config.globalToken) {
                return { success: false, output: '❌ No Discord User Token is currently configured.' };
            }
            return {
                success: true,
                output: `🔑 Current Token: ${config.globalToken.substring(0, 10)}... (Length: ${config.globalToken.length} characters)`
            };
        }

        config.globalToken = newToken.trim();
        this.saveConfig(config);
        return {
            success: true,
            output: `✅ Discord User Token updated (${config.globalToken.substring(0, 10)}...).`
        };
    }

    async cmdWebhook(args) {
        const config = this.getConfig();
        const sub = args[0];

        if (sub === 'test') {
            const url = args[1] || config.globalWebhookUrl;
            if (!url) {
                return { success: false, output: '❌ No webhook URL specified or configured.' };
            }

            if (this.daemonManager) {
                const res = await this.daemonManager.testWebhook(url);
                if (res.success) {
                    return { success: true, output: '✅ Discord webhook test notification delivered successfully!' };
                } else {
                    return { success: false, output: `❌ Webhook test failed: ${res.message || 'Error sending notification'}` };
                }
            }

            // Fallback direct HTTPS test
            const ok = await new Promise(resolve => {
                try {
                    const u = new URL(url);
                    const body = JSON.stringify({
                        embeds: [{
                            title: '🔔 Croncord Webhook Test (CLI)',
                            description: 'Test notification from Croncord CLI Engine.',
                            color: 5814783,
                            timestamp: new Date().toISOString()
                        }]
                    });
                    const req = https.request(u, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                    }, r => resolve(r.statusCode >= 200 && r.statusCode < 300));
                    req.on('error', () => resolve(false));
                    req.write(body);
                    req.end();
                } catch (e) {
                    resolve(false);
                }
            });

            return ok
                ? { success: true, output: '✅ Discord webhook test notification delivered successfully!' }
                : { success: false, output: '❌ Failed to deliver webhook notification. Check the URL.' };
        }

        if (!sub) {
            return {
                success: true,
                output: config.globalWebhookUrl
                    ? `🔔 Configured Webhook: ${config.globalWebhookUrl}`
                    : '🔔 No global webhook configured. Use: webhook <url>'
            };
        }

        config.globalWebhookUrl = sub.trim();
        this.saveConfig(config);
        return {
            success: true,
            output: `✅ Global webhook URL updated: ${config.globalWebhookUrl.substring(0, 45)}...`
        };
    }

    cmdBackup() {
        const config = this.getConfig();
        return {
            success: true,
            output: JSON.stringify(config, null, 2)
        };
    }

    cmdUptime() {
        const config = this.getConfig();
        const servers = config.servers || [];
        const healthMap = (this.attendanceHistory && this.attendanceHistory.getServerHealthMap)
            ? this.attendanceHistory.getServerHealthMap(servers)
            : {};

        const lines = [
            '⏱️ Server Health & Check-in Reliability:',
            '─────────────────────────────────────────────────────────────'
        ];

        servers.forEach(s => {
            const h = healthMap[s.id] || {};
            const state = !s.active ? '⚪ PAUSED' : (h.health === 'FAILED' ? '🔴 FAILED' : '🟢 RUNNING');
            let lastSuccess = 'Never';
            if (h.lastSuccessfulAt) {
                const diffMs = Math.max(0, Date.now() - new Date(h.lastSuccessfulAt).getTime());
                lastSuccess = formatDuration(diffMs) + ' ago';
            }
            lines.push(`  • [${state}] "${s.name}" (Channel: ${s.channelId})`);
            lines.push(`      Uptime / Last Check-in: ${lastSuccess}`);
            lines.push(`      Recent Run Status     : ${h.lastRunStatus || 'None'}`);
            if ((h.currentStreak || 0) > 0 || (h.bestStreak || 0) > 0) {
                lines.push(`      Streak                : 🔥 ${h.currentStreak || 0} current (best ${h.bestStreak || 0})`);
            }
        });

        return { success: true, output: lines.join('\n') };
    }

    async cmdValidate(args) {
        const filePath = args[0];
        if (!filePath) {
            return { success: false, output: '❌ Usage: validate <path/to/config.json>' };
        }
        const resolvedPath = path.resolve(process.cwd(), filePath);
        if (!fs.existsSync(resolvedPath)) {
            return { success: false, output: `❌ File not found: ${filePath}` };
        }
        try {
            const raw = fs.readFileSync(resolvedPath, 'utf8');
            const parsed = JSON.parse(raw);
            const res = validateConfigSchema(parsed);
            if (res.isValid) {
                let out = `✅ Schema Validation PASSED for "${path.basename(filePath)}"!\n`;
                out += `  • Servers Verified  : ${res.stats.serverCount}\n`;
                out += `  • Schedules Verified: ${res.stats.scheduleCount}\n`;
                if (res.warnings.length > 0) {
                    out += `\n⚠️ Warnings (${res.warnings.length}):\n` + res.warnings.map(w => `  • ${w}`).join('\n');
                }
                return { success: true, output: out };
            } else {
                let out = `❌ Schema Validation FAILED for "${path.basename(filePath)}":\n`;
                out += `Found ${res.errors.length} error(s):\n`;
                out += res.errors.map((e, idx) => `  ${idx + 1}. ${e}`).join('\n');
                if (res.warnings.length > 0) {
                    out += `\nWarnings (${res.warnings.length}):\n` + res.warnings.map(w => `  • ${w}`).join('\n');
                }
                return { success: false, output: out };
            }
        } catch (err) {
            return { success: false, output: `❌ JSON Parse Error in "${filePath}": ${err.message}` };
        }
    }

    async cmdImport(args) {
        const filePath = args[0];
        const mode = (args[1] || 'merge').toLowerCase();
        if (!filePath) {
            return { success: false, output: '❌ Usage: import <path/to/config.json> [merge|replace]' };
        }
        const resolvedPath = path.resolve(process.cwd(), filePath);
        if (!fs.existsSync(resolvedPath)) {
            return { success: false, output: `❌ File not found: ${filePath}` };
        }
        try {
            const raw = fs.readFileSync(resolvedPath, 'utf8');
            const parsed = JSON.parse(raw);
            const res = validateConfigSchema(parsed);
            if (!res.isValid) {
                let out = `❌ Import rejected: Schema validation failed for "${path.basename(filePath)}":\n`;
                out += res.errors.map((e, idx) => `  ${idx + 1}. ${e}`).join('\n');
                return { success: false, output: out };
            }

            const config = this.getConfig();
            const incomingServers = res.sanitized.servers;

            if (mode === 'merge') {
                incomingServers.forEach(incoming => {
                    const idx = config.servers.findIndex(s => String(s.id) === String(incoming.id));
                    if (idx >= 0) {
                        config.servers[idx] = incoming;
                    } else {
                        config.servers.push(incoming);
                    }
                });
            } else {
                config.servers = incomingServers;
            }

            if (res.sanitized.globalWebhookUrl && !config.globalWebhookUrl) {
                config.globalWebhookUrl = res.sanitized.globalWebhookUrl;
            }

            if (res.sanitized.globalQuietHours) {
                config.globalQuietHours = res.sanitized.globalQuietHours;
            }
            if (res.sanitized.globalHolidays && res.sanitized.globalHolidays.length > 0) {
                const merged = new Map((config.globalHolidays || []).map((h) => [h.date, h]));
                res.sanitized.globalHolidays.forEach((h) => merged.set(h.date, h));
                config.globalHolidays = [...merged.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
            }
            if (res.sanitized.vacation) {
                config.vacation = res.sanitized.vacation;
            }
            if (res.sanitized.heartbeat) {
                config.heartbeat = res.sanitized.heartbeat;
            }
            if (res.sanitized.digest) {
                config.digest = res.sanitized.digest;
            }

            const saved = this.saveConfig(config);
            if (!saved) {
                return { success: false, output: '❌ Failed to save configuration to disk.' };
            }

            if (this.daemonManager && this.daemonManager.status === 'RUNNING') {
                this.daemonManager.initializeSchedules(config);
            }

            let out = `🎉 Successfully imported ${incomingServers.length} server profile(s) (${mode} mode) with schema validation passed!\n`;
            out += `Total servers configured: ${config.servers.length} | Schedules: ${res.stats.scheduleCount}`;
            if (res.warnings.length > 0) {
                out += `\n⚠️ Warnings:\n` + res.warnings.map(w => `  • ${w}`).join('\n');
            }
            return { success: true, output: out };
        } catch (err) {
            return { success: false, output: `❌ Import error: ${err.message}` };
        }
    }

    cmdVacation(args) {
        const config = this.getConfig();
        const sub = (args[0] || 'status').toLowerCase();

        const describe = () => {
            const st = suppression.vacationStatus(config.vacation, new Date());
            if (st.active) {
                return {
                    success: true,
                    output: [
                        '🏖️ Vacation mode is ARMED — every firing is skipped (neutral) until ' + st.until + '.',
                        st.note ? `   Note: ${st.note}` : '   (no note)',
                        '   Disarm early: vacation off',
                    ].join('\n'),
                };
            }
            return { success: true, output: '🏖️ Vacation mode is OFF — schedules fire normally.\nArm it: vacation <YYYY-MM-DD> [note]' };
        };

        if (!sub || sub === 'status' || sub === 'show' || sub === 'view') {
            return describe();
        }

        if (sub === 'off' || sub === 'clear' || sub === 'cancel' || sub === 'end') {
            if (!config.vacation) {
                return { success: true, output: '🏖️ Vacation mode is already off.' };
            }
            config.vacation = null;
            this.saveConfig(config);
            return { success: true, output: '🏖️ Vacation cancelled — all schedules resumed.' };
        }

        const until = args[0];
        const note = args.slice(1).join(' ').trim();
        const check = suppression.validateVacation({ until, note });
        if (!check.valid) {
            return { success: false, output: `❌ ${check.error}\nUsage: vacation <YYYY-MM-DD> [note]  (e.g. vacation 2026-12-20 "Christmas trip")` };
        }
        const todayKey = suppression.normalizeDateKey(new Date());
        if (check.sanitized.until < todayKey) {
            return { success: false, output: `❌ Vacation end date ${check.sanitized.until} is in the past. Pick today or later.` };
        }
        config.vacation = { ...check.sanitized, armedAt: new Date().toISOString() };
        this.saveConfig(config);
        return {
            success: true,
            output: `🏖️ Vacation mode ARMED until ${check.sanitized.until}${check.sanitized.note ? ` ("${check.sanitized.note}")` : ''}.\nEvery firing until then is skipped (neutral) and resumes automatically after.`
        };
    }

        cmdCalendar(args) {
        const { getCalendarMonth } = require('./upcoming');
        const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        let year, month;
        const param = String(args[0] || '').trim();
        if (!param) {
            const now = new Date();
            year = now.getFullYear();
            month = now.getMonth() + 1;
        } else if (/^\d{4}-\d{2}$/.test(param)) {
            year = parseInt(param.slice(0, 4), 10);
            month = parseInt(param.slice(5, 7), 10);
            if (month < 1 || month > 12) {
                return { success: false, output: '❌ Usage: calendar [YYYY-MM]  (e.g. calendar 2026-10)' };
            }
        } else {
            return { success: false, output: '❌ Usage: calendar [YYYY-MM]  (e.g. calendar 2026-10)' };
        }

        const config = this.getConfig();
        const cal = getCalendarMonth(config, year, month);
        const lines = [`📆 ${MONTH_NAMES[month - 1]} ${year} — ${cal.activeDays} firing day(s):`, '─────────────────────────────────────────────────────────────'];
        lines.push('  Su  Mo  Tu  We  Th  Fr  Sa');

        let week = ' ';
        for (let i = 0; i < cal.firstWeekday; i++) week += '     ';
        cal.days.forEach((d) => {
            const dayNum = parseInt(d.date.slice(8, 10), 10);
            const mark = d.count > 0 ? '●' : ' ';
            week += ` ${String(dayNum).padStart(2, ' ')}${mark} `;
            if (d.weekday === 6) {
                lines.push(' ' + week.trimEnd());
                week = ' ';
            }
        });
        if (week.trim()) lines.push(' ' + week.trimEnd());

        lines.push('─────────────────────────────────────────────────────────────');
        const activeDays = cal.days.filter((d) => d.count > 0);
        if (activeDays.length === 0) {
            lines.push('No firings scheduled this month.');
        } else {
            activeDays.forEach((d) => {
                const names = [...new Set(d.runs.map((r) => `"${r.scheduleLabel}" (${r.serverName})`))];
                lines.push(`  ${d.date}: ${d.count} run(s) — ${names.join(', ')}${d.quiet > 0 ? ' [quiet-hours]' : ''}`);
            });
        }
        if (cal.vacationActive) {
            lines.push(`🏖️ Vacation mode armed — ${cal.vacationSkipped} occurrence(s) hidden this month.`);
        }
        lines.push('● = firing day  •  Holidays excluded automatically.');
        return { success: true, output: lines.join('\n') };
    }

    async cmdHeartbeat(args) {
        const https = require('https');
        const http = require('http');
        const config = this.getConfig();
        const sub = (args[0] || 'status').toLowerCase();

        const pingOnce = (targetUrl) => new Promise((resolve) => {
            let url;
            try {
                url = new URL(String(targetUrl).trim());
            } catch (e) {
                return resolve({ ok: false, error: 'Invalid URL.' });
            }
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                return resolve({ ok: false, error: 'URL must be http(s).' });
            }
            const lib = url.protocol === 'https:' ? https : http;
            const req = lib.get(url, { timeout: 8000 }, (res) => {
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                res.resume();
                resolve({ ok, statusCode: res.statusCode });
            });
            req.on('error', (err) => resolve({ ok: false, error: err.message }));
            req.on('timeout', () => {
                req.destroy();
                resolve({ ok: false, error: 'Ping timed out.' });
            });
        });

        if (!sub || sub === 'status' || sub === 'show' || sub === 'view') {
            const hb = config.heartbeat;
            if (!hb || !hb.url) {
                return { success: true, output: '💓 Heartbeat is OFF (no URL configured).\nArm it: heartbeat <url> [minutes]  (e.g. heartbeat https://hc-ping.com/abc 15)' };
            }
            return {
                success: true,
                output: `💓 Heartbeat ARMED: ${hb.url} every ${hb.intervalMinutes || 15}m.\n   Test now: heartbeat test   •   Disarm: heartbeat off`
            };
        }

        if (sub === 'off' || sub === 'clear' || sub === 'disable') {
            config.heartbeat = null;
            this.saveConfig(config);
            return { success: true, output: '💓 Heartbeat disarmed.' };
        }

        if (sub === 'test') {
            const target = args[1] || (config.heartbeat || {}).url;
            if (!target) {
                return { success: false, output: '❌ No heartbeat URL configured. Usage: heartbeat test [url]' };
            }
            const r = await pingOnce(target);
            return r.ok
                ? { success: true, output: `💓 Heartbeat test ping delivered (HTTP ${r.statusCode}).` }
                : { success: false, output: `❌ Heartbeat test failed: ${r.error || ('HTTP ' + r.statusCode)}` };
        }

        const url = args[0];
        const minutes = Math.min(Math.max(parseInt(args[1], 10) || 15, 1), 1440);
        try {
            const parsed = new URL(String(url).trim());
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad proto');
        } catch (e) {
            return { success: false, output: '❌ Usage: heartbeat <http(s) url> [minutes 1-1440]' };
        }
        config.heartbeat = { url: String(url).trim(), intervalMinutes: minutes };
        this.saveConfig(config);
        return { success: true, output: `💓 Heartbeat armed: ${url.trim()} every ${minutes}m.\n   Takes effect when the web server (re)starts. Test now: heartbeat test` };
    }

        async cmdDigest(args) {
        const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const config = this.getConfig();
        const sub = (args[0] || 'status').toLowerCase();

        const describe = () => {
            const d = config.digest;
            if (d && d.enabled) {
                return { success: true, output: `📰 Weekly digest is ON — posts every ${d.day || 'monday'} at ${d.time || '09:00'} to the global webhook.\n   Change: digest on [day] [HH:MM]   •   Send now: digest test   •   Off: digest off` };
            }
            return { success: true, output: '📰 Weekly digest is OFF.\nEnable: digest on [day] [HH:MM]  (e.g. digest on monday 09:00)' };
        };

        if (!sub || sub === 'status' || sub === 'show' || sub === 'view') {
            return describe();
        }

        if (sub === 'off' || sub === 'disable' || sub === 'clear') {
            config.digest = { ...(config.digest || {}), enabled: false };
            this.saveConfig(config);
            return { success: true, output: '📰 Weekly digest disabled.' };
        }

        if (sub === 'test') {
            if (!this.daemonManager || !this.daemonManager.sendDigest) {
                return { success: false, output: '❌ Digest sender is not available in this context.' };
            }
            const r = await this.daemonManager.sendDigest(true);
            return r.success
                ? { success: true, output: `✅ ${r.message}` }
                : { success: false, output: `❌ ${r.message}` };
        }

        if (sub === 'on' || sub === 'enable') {
            const day = (args[1] || (config.digest || {}).day || 'monday').toLowerCase();
            const time = args[2] || (config.digest || {}).time || '09:00';
            if (!DAYS.includes(day)) {
                return { success: false, output: `❌ Unknown day "${args[1]}". Use: ${DAYS.join(', ')}` };
            }
            if (suppression.parseHHMM(time) === null) {
                return { success: false, output: '❌ Time must be HH:MM (24h), e.g. 09:00.' };
            }
            config.digest = { enabled: true, day, time };
            this.saveConfig(config);
            return { success: true, output: `📰 Weekly digest enabled — every ${day} at ${time} (takes effect on daemon restart/reload).` };
        }

        return { success: false, output: '❌ Usage: digest [status|on [day] [HH:MM]|off|test]' };
    }

    cmdUpcoming(args) {        const count = Math.min(Math.max(parseInt(args[0], 10) || 10, 1), 50);
        const config = this.getConfig();
        let timeline;
        try {
            timeline = getUpcomingRuns(config, { count });
        } catch (err) {
            return { success: false, output: `❌ Could not compute upcoming runs: ${err.message}` };
        }
        if (timeline.runs.length === 0) {
            return { success: true, output: '🔮 No upcoming runs — no active schedules with valid crons found.' };
        }
        const lines = [`🔮 Upcoming Runs (next ${timeline.runs.length}):`, '─────────────────────────────────────────────────────────────'];
        timeline.runs.forEach((r, i) => {
            const at = new Date(r.at);
            const diffMs = Math.max(0, at.getTime() - Date.now());
            const when = at.toLocaleString();
            const inStr = formatDuration(diffMs) === '0s' ? 'now' : `in ${formatDuration(diffMs)}`;
            const flags = [r.oneTime ? 'ONE-TIME' : null, r.quiet ? 'QUIET-HOURS' : null].filter(Boolean);
            lines.push(`  #${i + 1} ${when} (${inStr}) — "${r.scheduleLabel}" on "${r.serverName}"${flags.length ? ` [${flags.join(', ')}]` : ''}`);
        });
        lines.push('─────────────────────────────────────────────────────────────');
        if (timeline.quietFlagged > 0) {
            lines.push(`⚠️ ${timeline.quietFlagged} listed run(s) fall inside quiet hours and will be skipped at fire time.`);
        }
        if (timeline.vacationActive) {
            lines.push(`🏖️ Vacation mode is armed — ${timeline.vacationSkipped} occurrence(s) hidden until it ends.`);
        }
        lines.push('💡 Holidays are excluded automatically (intentional skips, never failures).');
        return { success: true, output: lines.join('\n') };
    }

    cmdBackups() {
        const snaps = configBackups.listBackups();
        if (snaps.length === 0) {
            return { success: true, output: '📸 No restore points yet. One is saved automatically before every config change.' };
        }
        const lines = [`📸 Config Restore Points (${snaps.length}, newest first):`, '─────────────────────────────────────────────────────────────'];
        snaps.forEach((s, i) => {
            lines.push(`  #${i + 1} ${s.file}  (${(s.size / 1024).toFixed(1)} KB, ${s.createdAt || 'unknown time'})`);
        });
        lines.push('─────────────────────────────────────────────────────────────');
        lines.push('💡 Roll back with: restore <filename>');
        return { success: true, output: lines.join('\n') };
    }

    async cmdRestore(args) {
        const file = args[0];
        if (!file) {
            return { success: false, output: '❌ Usage: restore <config-YYYY-MM-DD-HH-mm-ss.json>\nSee available points with: backups' };
        }
        let snapshot;
        try {
            snapshot = configBackups.readBackup(file);
        } catch (err) {
            return { success: false, output: `❌ ${err.message}` };
        }
        if (!snapshot || !Array.isArray(snapshot.servers)) {
            return { success: false, output: `❌ Restore point "${file}" is not a valid config (missing servers array).` };
        }
        const saved = this.saveConfig(snapshot);
        if (!saved) {
            return { success: false, output: '❌ Failed to write restored configuration to disk.' };
        }
        if (this.daemonManager && this.daemonManager.status === 'RUNNING') {
            this.daemonManager.initializeSchedules(snapshot);
        }
        return {
            success: true,
            output: `♻️ Restored configuration from "${file}".\nServers: ${(snapshot.servers || []).length} | (A pre-restore snapshot was saved automatically.)`
        };
    }

    cmdQuiet(args) {
        const config = this.getConfig();
        const sub = (args[0] || '').toLowerCase();

        if (!sub || sub === 'show' || sub === 'view' || sub === 'status') {
            const lines = ['🌙 Quiet Hours (daily blackout window):', '─────────────────────────────────────────────────────────────'];
            if (config.globalQuietHours) {
                lines.push(`   Global: ${config.globalQuietHours.start}–${config.globalQuietHours.end}`);
            } else {
                lines.push('   Global: (not set — runs fire at their scheduled times)');
            }
            (config.servers || []).forEach((s) => {
                if (s.quietHours) lines.push(`   "${s.name}": ${s.quietHours.start}–${s.quietHours.end} (server override)`);
            });
            lines.push('─────────────────────────────────────────────────────────────');
            lines.push('💡 Usage: quiet <HH:MM> <HH:MM>  (e.g. quiet 22:00 07:00) | quiet clear');
            lines.push('   Windows may cross midnight. Firings inside are SKIPPED, never failed.');
            return { success: true, output: lines.join('\n') };
        }

        if (sub === 'clear' || sub === 'off' || sub === 'none') {
            config.globalQuietHours = null;
            (config.servers || []).forEach((s) => { delete s.quietHours; });
            this.saveConfig(config);
            return { success: true, output: '🌙 Quiet hours cleared everywhere (global + per-server overrides).' };
        }

        const start = args[0];
        const end = args[1];
        const check = suppression.validateQuietHours({ start, end });
        if (!check.valid) {
            return { success: false, output: `❌ ${check.error}\nUsage: quiet <HH:MM> <HH:MM>  (e.g. quiet 22:00 07:00)` };
        }
        config.globalQuietHours = { start: start.trim(), end: end.trim() };
        this.saveConfig(config);
        return { success: true, output: `🌙 Global quiet hours set: ${start.trim()}–${end.trim()}.\nFirings inside this window are skipped (SKIPPED, never failed).` };
    }

    cmdHoliday(args) {
        const config = this.getConfig();
        if (!Array.isArray(config.globalHolidays)) config.globalHolidays = [];
        const sub = (args[0] || 'list').toLowerCase();

        if (sub === 'list' || sub === 'show') {
            if (config.globalHolidays.length === 0) {
                return { success: true, output: '🏖️ No holidays configured. Runs fire every scheduled day.\nAdd one: holiday add 2026-12-25 "Christmas Day"' };
            }
            const sorted = [...config.globalHolidays].sort((a, b) => String(a.date).localeCompare(String(b.date)));
            const lines = [`🏖️ Holidays — intentional skip dates (${sorted.length}):`, '─────────────────────────────────────────────────────────────'];
            const todayKey = suppression.normalizeDateKey(new Date());
            sorted.forEach((h) => {
                const past = String(h.date) < todayKey ? ' (past)' : '';
                lines.push(`   ${h.date} — ${h.name}${past}`);
            });
            lines.push('─────────────────────────────────────────────────────────────');
            lines.push('💡 Firings on these days are SKIPPED (neutral — streaks untouched).');
            lines.push('   Per-server opt-out: server ignore-holidays <id> on|off');
            return { success: true, output: lines.join('\n') };
        }

        if (sub === 'add') {
            const date = args[1];
            const name = args.slice(2).join(' ').trim();
            const check = suppression.validateHoliday({ date, name });
            if (!check.valid) {
                return { success: false, output: `❌ ${check.error}\nUsage: holiday add <YYYY-MM-DD> "<name>"` };
            }
            if (config.globalHolidays.some((h) => suppression.normalizeDateKey(h.date) === check.sanitized.date)) {
                return { success: false, output: `❌ ${check.sanitized.date} is already a holiday. Remove it first to rename.` };
            }
            config.globalHolidays.push(check.sanitized);
            this.saveConfig(config);
            return { success: true, output: `🏖️ Holiday added: ${check.sanitized.date} — ${check.sanitized.name}.\nScheduled firings on this day will be skipped (neutral).` };
        }

        if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
            const date = suppression.normalizeDateKey(args[1]);
            if (!date) {
                return { success: false, output: '❌ Usage: holiday remove <YYYY-MM-DD>' };
            }
            const before = config.globalHolidays.length;
            config.globalHolidays = config.globalHolidays.filter((h) => suppression.normalizeDateKey(h.date) !== date);
            if (config.globalHolidays.length === before) {
                return { success: false, output: `❌ No holiday found on ${date}.` };
            }
            this.saveConfig(config);
            return { success: true, output: `🧹 Removed holiday on ${date}.` };
        }

        return { success: false, output: '❌ Usage: holiday <list|add <YYYY-MM-DD> "<name>"|remove <YYYY-MM-DD>>' };
    }

    async cmdService(args) {
        const sub = (args[0] || 'status').toLowerCase();
        const runExec = (cmd) => new Promise((resolve) => {
            exec(cmd, { cwd: path.join(__dirname, '..') }, (err, stdout, stderr) => {
                resolve((stdout || stderr || '').trim());
            });
        });

        if (sub === 'status') {
            const out = await runExec('npx pm2 status croncord-daemon croncord-web');
            return { success: true, output: out || 'PM2 service check completed.' };
        }
        if (sub === 'install' || sub === 'start') {
            const out = await runExec('node bin/install-service.js');
            return { success: true, output: out || 'Service installed.' };
        }
        if (sub === 'uninstall' || sub === 'stop') {
            const out = await runExec('node bin/uninstall-service.js');
            return { success: true, output: out || 'Service uninstalled.' };
        }
        if (sub === 'logs') {
            const lines = args[1] || '20';
            const out = await runExec(`npx pm2 logs croncord-daemon --lines ${lines} --nostream`);
            return { success: true, output: out || 'No PM2 logs available.' };
        }
        return {
            success: false,
            output: '❌ Usage: service <status|install|uninstall|logs [lines]>'
        };
    }
}

module.exports = CliEngine;
