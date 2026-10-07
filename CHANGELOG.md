# Changelog

All notable changes to the **Croncord** project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [4.1.0] - 2026-10-07

### Added
- **📆 CRONCORD CLI banner:** the terminal heading art now spells CRONCORD (hand-built block glyphs in the original style, 70 cols) with a 📆 masthead.
- **👁️ Dry-Run Preview:** shared `buildPreview` (engine) + `GET /api/servers/:id/schedules/:scid/preview`; `preview <server> [schedule]` command, dashboard Preview button + read-only modal per schedule row. Zero sends, logs, or history writes.
- **🧬 Server Clone + Bulk Ops:** `server clone <id> <name> <chanId>` (deep copy, fresh IDs, channel-dupe guard) + `POST /api/servers/:id/clone`; `schedule enable-all/disable-all` + `POST .../schedules/bulk-action`; dashboard Clone button/modal and Enable-all/Pause-all schedule buttons.
- **🏖️ Vacation Mode:** `vacation [until] [note]|off`, `GET/POST/DELETE /api/vacation`, dashboard vacation card; suppression reason `vacation` (neutral `SKIPPED`); expired vacations self-clear on save/boot/standalone-boot; upcoming preview hides covered dates with counts; import/export carry it.
- **📆 Schedule Calendar:** `getCalendarMonth` + `GET /api/schedules/calendar?month=YYYY-MM`; `calendar [YYYY-MM]` ASCII command; dashboard month widget (nav + click-a-day details, quiet flags).
- **💓 Health + Heartbeat:** cheap `GET /api/health`; configurable heartbeat pings (`heartbeat [url] [mins]|test|off`, `GET/POST/DELETE /api/heartbeat`, test endpoint) auto-armed at server boot and hot-reloaded from CLI edits via the config watcher; dashboard Heartbeat card.
- **📰 Weekly Digest:** `attendanceHistory.getWeeklyDigest` + daemon-scheduled Monday post (`digest [on|off|test]`, `GET/POST/DELETE /api/digest`, `POST /api/digest/test`); dashboard digest card with live 7-day summary; import/export carry it.
- Web terminal help popover entries for all new commands; interactive planning menu extended (calendar, vacation, digest, heartbeat).

### Fixed
- CLI `import` now preserves imported quiet hours, holidays, vacation, heartbeat, and digest settings (previously dropped).
- Standalone daemon (`src/bot.js`) now honors global holidays/quiet hours (config passed to worker) with skip-aware one-time handling.
- Daemon reconnect scheduler ignores further drops once `ERROR` (no post-give-up spam).
- Dashboard holiday/quiet/restore widgets refresh on every config fetch.

---

## [4.0.0] - 2026-10-06

### Changed — Project renamed AttendanceBot → Croncord (no functionality changes)
- **📦 Package identity:** `package.json` name `attendanceBot` → `croncord`; primary global command is now **`croncord`** (`bin` also keeps legacy aliases `l2e`, `lazyruna`, `lazy-runa`, `attenda`, `attendancebot`).
- **⚙️ PM2 services renamed:** `attendanceBot-daemon` → **`croncord-daemon`**, `attendanceBot-web` → **`croncord-web`** (`ecosystem.config.js`, install/uninstall scripts, npm scripts, `service status|logs` engine commands).
- **🖥️ Display strings:** CLI banners, help, status, installer output, server logs, webhook embed footers, dashboard title/header/footer/guide, download filenames (`croncord-*`), and web-terminal prompts now say Croncord.
- **💾 Browser storage keys renamed** (`croncord_*`) with one-time lazy migration from `attendancebot*` keys — theme, notifications, targets, backups, terminal skin, and command history survive the upgrade.
- **📁 Runtime files:** server pidfile is now `.croncord-server.pid` (the CLI stop command still honors a legacy `.server.pid` left by pre-4.0 installs); Termux boot script is now `start-croncord.sh` (installer removes the legacy one; uninstaller removes both).
- **📚 Docs & metadata:** README rebranded (`# Croncord`, new clone URL `iamadedo/croncord`), `metadata.json`, `retype.yml`, deploy workflow, `.env.example` header.
- **🔖 Version bumped `3.9.1` → `4.0.0`** (package rename + CLI/service renames are breaking) — propagates automatically via `src/version.js`.

### Compatibility (what stays working)
- `config.json`, `attendance_history.json`, `backups/`, export/import payloads: **unchanged formats** — existing data keeps working; the schema validator accepts old exports.
- Running `service:install` on an upgraded machine **removes legacy `attendanceBot-*` PM2 processes first**, so no duplicate daemon/web processes.
- Old global aliases keep launching the CLI; re-run `npm link` (or accept the CLI exit offer) to also gain the `croncord` command. If you linked 3.9.x globally, refresh with `npm unlink -g attendanceBot && npm link`.

---

## [3.9.1] - 2026-10-06

### Added
- **🌐 Global CLI Aliases (launch from anywhere):**
  - `package.json` `bin` now registers five commands — `l2e`, `lazyruna`, `lazy-runa`, `attenda`, `attendancebot` — all launching `bin/cli.js` (verified working from an unrelated directory; config always resolves to the install folder).
  - New exit-time `offerGlobalLink()` prompt in the CLI (next to the daemon-install offer): detects which aliases already resolve on `PATH` and runs `npm link` on accept, with elevated-rights guidance when linking is blocked.
- **🔄 Web Dashboard Autostart on Boot:**
  - New `ecosystem.config.js` declaring both PM2 apps: `attendanceBot-daemon` (`src/bot.js`) and `attendanceBot-web` (`server.js`, pinned to port 3271).
  - `bin/install-service.js` now registers **both** services and persists them (`pm2 save`); `bin/uninstall-service.js` removes both.
  - Platform-aware reboot instructions in the installer (Windows: `pm2-windows-startup`, macOS: `launchd`, Linux: `systemd`, Termux: Termux:Boot `pm2 resurrect` covers both).
  - New scripts: `service:web:status`, `service:web:logs`, `service:web:restart`; `service:status` now shows all services.

### Changed
- **🔖 Version bumped `3.9.0` → `3.9.1`** per versioning policy.
- PM2 service menu labels updated (daemon + web); `.gitignore` now covers `backups/` (snapshots contain the Discord token) and `.server.pid`.

---

## [3.9.0] - 2026-10-06

### Added
- **🔁 V1 Feature Restoration (CLI wizard parity):**
  - Restored `isValidTime` validation with re-prompt loops on every time, weekday, and one-time-date prompt — typos can no longer create broken crons.
  - Restored setup-time `configureGlobalWebhook` with live `testWebhook` delivery check before saving.
  - Restored Multi-Time / Multi-Day batch builder (`promptScheduleBatch`) as builder mode `[2]` in both server wizards, extended with per-slot message/reaction choice.
  - Restored `offerServiceInstall` auto-install prompt on CLI exit when active schedules exist.
  - Added `detectEnvironment()` OS/runtime detection (Windows, macOS, Linux desktop/tmux/headless, Termux, Docker) shown on startup with platform-specific guidance.
- **⚠️ Server-Side Conflict Detection:**
  - New shared `src/scheduleConflicts.js` module (5-minute same-channel clash analysis).
  - New `schedule conflicts <server>` CLI command, `GET /api/servers/:serverId/conflicts` endpoint, and automatic warnings on `schedule list` / `schedule add` and dashboard schedule mutations.
- **🔮 Upcoming-Runs Preview:**
  - New `src/upcoming.js` timeline computation backed by the `cron-parser` dependency.
  - New `upcoming [count]` CLI command, `GET /api/schedules/upcoming` endpoint, and dashboard Upcoming Runs widget (holiday dates excluded, quiet-hour hits flagged).
- **📸 Auto-Backup Restore Points:**
  - New `src/configBackups.js`: timestamped snapshot in `backups/` before every real change (newest 20 kept, unchanged writes skipped).
  - New `backups` / `restore <file>` CLI commands, `GET /api/config/backups` + `POST /api/config/restore` endpoints, and dashboard Restore buttons.
- **💬 Message Templates & Pools:**
  - New `src/messageTemplates.js`: `{date}`, `{time}`, `{day}`, `{server}`, `{channel}` variables resolved at send time; per-schedule `messagePool` random pick per run (exact sent text recorded in history).
  - Wizard variants step, `schedule pool` CLI command, dashboard schedule-editor field, and schema-validator support.
- **🏖️ Holidays & Quiet Hours:**
  - New `src/suppression.js` skip rules: global named holidays (`holiday add/list/remove`) with per-server `ignoreHolidays` opt-out, plus global/per-server quiet windows (`quiet` command).
  - Suppressed firings record neutral `SKIPPED` history (excluded from success rates and health failures); one-time schedules on holidays marked skipped; upcoming preview accounts for both.
  - Dashboard Holidays manager, quiet-hours controls, and per-server holiday toggle.
- **🩹 Self-Healing Daemon:**
  - `daemonManager` auto-reconnects with exponential backoff (5 attempts, fully logged); manual `stop` cancels pending retries; reconnect state exposed in `status` and `/api/status`.

### Changed
- **🔖 Version bumped `3.8.0` → `3.9.0`** per versioning policy (single source of truth `package.json` → `src/version.js` propagates to badges, API, exports, CLI).
- **📖 README rewritten:** V1 + V2 merged — V1 ASCII art, structure, and beginner guides kept intact, with full v3.9 feature documentation.

### Fixed
- One-time schedule builder no longer accepts invalid/past dates (previously fell through to a mislabeled everyday cron).
- Weekday picker no longer silently defaults to Monday on bad input.

---

## [3.8.0] - 2026-09-25

### Added
- **📜 CLI Terminal 'Command History' Drop-up Menu:**
  - Added a dedicated interactive arrow icon button (`#cliHistoryDropupBtn`, `fa-chevron-up`) directly on the CLI Terminal's command input field (`#cliTerminalInput`).
  - Clicking the arrow opens an accessible, floating drop-up panel listing previously executed commands in reverse chronological order.
  - Each item supports 1-click **Select** (to populate and edit the command line) and 1-click **Re-run** (with instant execution feedback).
  - Built-in persistent history backed by `localStorage` (`attendancebot_cli_history`), capped at 50 commands with automatic duplicate pruning.
  - Supports individual command deletion (`x`), bulk "Clear History", `Escape` dismissal, and click-outside dismissal.
  - Fully integrated with keyboard shortcuts (`Up` / `Down` arrows continue to navigate history seamlessly).
  - Modern high-contrast styling with dark theme and light terminal appearance compatibility.

### Changed
- **📄 Streamlined README & Changelog Linking:**
  - Extracted full historical version entries from `README.md` and added a direct link to `CHANGELOG.md` for clean, focused project documentation.

---

## [3.7.0] - 2026-09-24

### Added
- **❓ Interactive CLI Terminal Help Popover:**
  - Added a dedicated Help icon (`fa-circle-question`) inside the web-based CLI Terminal console header (`#cliTerminalTitleBar`).
  - Opens an interactive Quick Reference popover listing all available terminal commands, categorized into Daemon, Servers, Schedules, Actions, Logs, Credentials, Config, Diagnostics, and Utilities.
  - Included a real-time live search filter to instantly find commands by keyword, arguments, or description.
  - Built interactive one-click execution (`Click to run`) for standalone commands and one-click insertion (`Click to insert`) for commands with templates and parameters into `#cliTerminalInput`.
  - Added click-outside and `Escape` key listeners for effortless dismissal.

### Fixed
- **🌐 Dev Server Startup & Container Healthcheck Compatibility:**
  - Configured Express server in `server.js` with dual-adapter listeners: keeping **port 3271** as the primary base port while providing the required container runtime adapter on **port 3000** for the dev environment and iframe preview proxy.
  - Resolved dev server startup issues, ensuring both local dashboard development on `http://localhost:3271` and dev preview on `http://localhost:3000` run simultaneously with zero port collisions.

---

## [3.6.0] - 2026-09-24

### Changed & Fixed
- **🚫 Complete Elimination of Port 3000 Conflicts:**
  - Configured AttendanceBot to **never look at, probe, or bind port 3000** under any circumstances, preventing development environment and local service collisions.
  - Hardened Express web server configuration in `server.js` to strictly enforce **port 3271** as the primary base port (`PRIMARY_BASE_PORT = 3271`).
  - Removed all legacy preview adapters and secondary listeners on port 3000 in `server.js`.
  - Updated CLI server detection (`probeServer` in `bin/cli.js`) to exclusively probe port 3271 without falling back or querying port 3000.
  - Documented strict primary base port policy in `.env.example`, `server.js`, `bin/cli.js`, and `README.md`.

---

## [3.5.0] - 2026-09-24

### Added & Changed
- **🌐 Single Source of Truth Global Versioning:**
  - Consolidated version resolution in `src/version.js` dynamically resolving from `package.json`.
  - Synchronized header badge (`#appHeaderVersionBadge`) and footer badge (`#appFooterVersionBadge`) with `.global-app-version`.
  - Added dedicated `/api/version` endpoint and included dynamic version metadata in `/api/status`, export payloads, and schema validator.
  - Updated interactive CLI menu banners and help commands to dynamically reflect current package version.

---

## [3.4.0] - 2026-09-24

### Added & Improved
- **⚡ Enhanced Schema Validation & CLI Management:**
  - Expanded JSON schema validator with deep channel snowflake checks and cron format linting.
  - Added live daemon process synchronization between CLI engine and Web Dashboard via hot-reloading watchers.

---

## [3.3.0] - 2026-09-24

### Added
- **📁 Configuration Backup & Hot Reloading:**
  - Bidirectional hot-sync watching `config.json` for external CLI or editor changes.
  - Safe configuration export & import with structural sanity verification.

---

## [3.2.0] - 2026-09-23

### Added & Improved
- **🖥️ Light-Mode CLI Terminal Readability Overhaul:**
  - Redesigned light-theme styles for the web-based interactive CLI console.
  - Command prompts (`attendancebot:~$`), user input, execution output, error states, and quick-command chips feature accessible contrast in light mode.
  - Added interactive Terminal Appearance toggle (`fa-circle-half-stroke`) to switch the CLI between clean light theme and classic hacker dark terminal skin independently.
- **🛡️ Duplicate Server Profile Prevention & Smart Schedule Redirect:**
  - Added duplicate server validation by Server Name and Discord Channel ID across REST API (`POST /api/servers`), frontend modal (`handleSaveServer`), and CLI engine (`server add`).
  - When a duplicate server is entered, the app gracefully dismisses the server creation dialog, displays a toast notification, and automatically redirects the user to the "Add Attendance Schedule" dialog pre-targeted to that server with an informative banner.
- **💬 Custom Dialogue Boxes for All Deletions:**
  - Completely replaced native browser `confirm()` popups with styled, accessible modal dialogs (`#confirmDialogModal`).
  - Applied to single server profile deletion, schedule routine deletion, bulk server deletion, and configuration snapshot restores.
- **⚠️ Rate-Limit Overlap Warning Badges:**
  - Prominent visual warning icons on the server profile card when multiple routines trigger within a 5-minute window in the same channel.

---

## [3.1.0] - 2026-09-22

### Added
- **⚠️ Rate-Limit Conflict Warning Icons:**
  - Added visual warning icons across server profile cards for schedules within 5 minutes of each other on the same channel.
  - Enhanced warning banner detailing schedule labels, execution times, and spacing recommendations.

---

## [3.0.0] - 2026-09-20

### Added
- **🔀 Drag-and-Drop Schedule Prioritization:**
  - Added HTML5 drag-and-drop table rows allowing users to reorder attendance schedules visually.
  - Added execution sequence tags (`#1`, `#2`, ...) and up/down priority adjusters.
  - Implemented backend endpoint `POST /api/servers/:serverId/schedules/reorder`.
- **⏱️ Real-Time Elapsed Check-in Clock:**
  - Added elapsed time clock badge on each server profile row and server header.
- **▶️ Immediate 'Test Run' Play Button:**
  - Added one-click test run button on every schedule row.

---

## [2.0.0] - 2026-09-15

### Added
- **🌐 Web Management Dashboard & REST API:**
  - Express full-stack architecture with Discord dark and light themes.
  - Live daemon process management (Start, Stop, Restart) from browser.
- **👍 Reaction-Based Attendance:**
  - Support for emoji reactions (`REACTION` mode) alongside standard text messages (`MESSAGE` mode).
- **📊 30-Day Attendance Analytics:**
  - Historical tracking with interactive Recharts visualizations.
- **📜 Live Activity Logs & CSV Export:**
  - Real-time in-browser log streaming with level filters and CSV export.

---

## [1.0.0] - 2026-09-01

### Added
- **⚡ Initial Release:**
  - Interactive command-line setup wizard (`bin/cli.js`).
  - PM2 background daemon management.
  - Automated cron scheduling for Discord channel attendance messages.
  - Multi-server profile storage in `config.json`.
