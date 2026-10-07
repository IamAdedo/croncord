# ⚡ Croncord

A self-hosted Discord message scheduling daemon.

```text
██████╗ ██████╗  ██████╗ ███╗   ██╗██████╗ ██████╗ ██████╗ ██████╗ 
██╔════╝██╔══██╗██╔═══██╗████╗  ██║██╔════╝██╔═══██╗██╔══██╗██╔══██╗
██║     ██████╔╝██║   ██║██╔██╗ ██║██║     ██║   ██║██████╔╝██║  ██║
██║     ██╔══██╗██║   ██║██║╚██╗██║██║     ██║   ██║██╔══██╗██║  ██║
╚██████╗██║  ██║╚██████╔╝██║ ╚████║╚██████╗╚██████╔╝██║  ██║██████╔╝
 ╚═════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═════╝ 
```

> **Croncord v4.2.0 by IamAdedo, dlazyHNTR** \
> *Automatically send attendance messages to Discord servers on schedule. Set it once, let it run in the background forever — now with a Web Management Dashboard, upcoming-runs preview, holidays & quiet hours, message pools, auto-restore points, and a self-healing daemon.*

---

## 📌 Badges & Metadata

- **Current Version:** `v4.2.0`
- **Dashboard Port:** `http://localhost:3271` (Primary Base Port — never touches port 3000)
- **Node.js Requirement:** `18.0.0` or higher
- **License:** MIT
- **Supported Platforms:** Windows, macOS, Linux, and Android (Termux — No Root Needed)
- **Interfaces:** Interactive Terminal CLI · Web Management Dashboard · 24/7 Background Daemon

---

## 🤔 What Does This Do?

**Croncord** automatically sends messages (like "Present" or "Good morning") — or emoji reactions — to Discord channels at times you choose. Perfect for:

- Daily attendance in Work/Study Discord servers
- Automated check-ins for games or communities
- Scheduled greetings or reminders

Once set up, it runs invisibly in the background on your computer. You can add multiple servers and multiple schedules for each server.

You can manage the bot three ways:

1. **Interactive Terminal CLI** (`npm run cli`) — guided wizards, duplicate detection, schedule batch builder, daemon controls, and a full headless command suite.
2. **Web Management Dashboard** (`npm start` → `http://localhost:3271`) — server cards, drag-and-drop schedule prioritization, one-click test runs, upcoming-runs timeline, analytics, and live logs.
3. **Background Daemon** — runs 24/7 with PM2 (auto-start on boot, wake-lock on Termux) and now heals itself after Discord disconnects.

---

## ✨ Features

### Core (V1 classics, fully restored)
- ✅ **Multiple Servers** — Manage attendance for unlimited Discord servers
- ✅ **Multiple Schedules** — Set different times for each server (e.g., 9 AM weekdays, 8 PM weekends)
- ✅ **Flexible Scheduling** — Everyday, weekdays, weekends, a specific repeating weekday (e.g., every Monday), a **one-time calendar date** that auto-disables after it fires, or a **custom 5-part cron**
- ✅ **Multi-Time / Multi-Day Builder** — Add several times to one day and several days in a single pass
- ✅ **Guided + Validated Input** — Every time, weekday, and calendar date is re-prompted until valid, so a typo can never create a broken schedule
- ✅ **Multi-Line Messages** — Attendance messages can span multiple lines (finish with an empty line)
- ✅ **Anti-Detection Jitter** — Adds random delays (configurable, 10+ minutes recommended) so messages don't post at the exact same second every day
- ✅ **Message OR Reaction** — Send text messages OR react with emojis to existing messages
- ✅ **Webhook Alerts** — Get notifications on your phone when attendance posts (verified with a live test *before* saving)
- ✅ **Background Service** — Runs 24/7 even when you close the terminal or restart your computer — including **no-root Android (Termux)**, with automatic OS detection
- ✅ **Exit-Time Daemon Offer** — Quitting the CLI with active schedules offers to install & start the background daemon for you
- ✅ **Easy Setup** — Interactive step-by-step wizard — no coding knowledge needed

### Dashboard & CLI suite (V2)
- 🌐 **Modern Web Management Dashboard** — Responsive Discord-styled interface for servers, schedules, credentials, and live daemon controls
- 🔀 **Drag-and-Drop Schedule Prioritization** — Reorder execution sequences with drag handles, priority badges (`#1`, `#2`…), or the CLI (`schedule move`, `schedule reorder`)
- ▶️ **One-Click Test Runs** — Execute any schedule immediately with spinner states, toast feedback, and live telemetry updates
- ⏱️ **Time-Since-Last-Check-in** — Live elapsed-time badges on every server card and header
- 💻 **Interactive CLI Suite + REPL** — Full headless commands plus an in-CLI command console and a web CLI terminal with history and help popover
- 📦 **Schema-Validated Import/Export** — Strict JSON validation with duplicate detection and merge/replace modes
- 📊 **30-Day Attendance Analytics** — Interactive charts, check-in heatmaps, success rates, and streak counters
- 📜 **Live Activity Logs & CSV Export** — Real-time streaming (SSE), severity filters, search, and one-click CSV export

### New in v3.9.0
- 🆕 **Upcoming-Runs Preview** — `upcoming [count]` command, `/api/schedules/upcoming` endpoint, and a dashboard timeline widget showing the next real fire times across all servers (holidays excluded, quiet-hour hits flagged)
- 🆕 **Server-Side Conflict Detection** — The 5-minute clash analysis now lives in `src/scheduleConflicts.js`: `schedule conflicts <server>` command, `/api/servers/:id/conflicts` endpoint, and automatic warnings on `schedule list` / `schedule add` and every dashboard schedule mutation
- 🆕 **Auto-Backup Restore Points** — A timestamped snapshot lands in `backups/` before every real change (last 20 kept); `backups` + `restore <file>` commands, `/api/config/backups` + `/api/config/restore` endpoints, and dashboard restore buttons
- 🆕 **Message Templates & Pools** — `{date}`, `{time}`, `{day}`, `{server}`, `{channel}` variables resolved at send time, plus per-schedule variant pools with random pick per run (history records exactly what was sent)
- 🆕 **Holidays & Quiet Hours** — Global named holidays (`holiday add 2026-12-25 "Christmas Day"`) with per-server opt-out, plus daily quiet windows; firings on these are recorded as neutral `SKIPPED` — never failures, never streak-breakers
- 🆕 **Self-Healing Daemon** — Automatic reconnect with exponential backoff on Discord drops (5 attempts, fully logged); manual `stop` always wins; reconnect state visible in `status` and the dashboard badge

### New in v4.2.0
- 🆕 **Success Streaks** — Per-server current/best success streaks (SKIPPED bridged, never breaks) in health data, dashboard 🔥 badges, and `uptime` output
- 🆕 **Schedule Duplicate** — `schedule duplicate <srv> <sched>` (+ API + dashboard clone button): exact copy with fresh ID, starts paused with conflict check
- 🆕 **Vacation Visibility** — Armed vacations show in `status` and as a dashboard header badge

### New in v4.1.0
- 🆕 **CRONCORD Banner** — The CLI heading art now spells CRONCORD in matching block letters with a 📆 masthead
- 🆕 **Dry-Run Preview** — `preview <server> [schedule]`, `/api/servers/:id/schedules/:scid/preview`, and a dashboard Preview button per schedule row: exact resolved post text with zero sends, logs, or history writes
- 🆕 **Server Clone + Bulk Ops** — `server clone <id> <name> <chanId>` duplicates a profile with fresh IDs; `schedule enable-all/disable-all <srv>` flips every routine; dashboard Clone button, Clone modal, and Enable-all/Pause-all schedule buttons
- 🆕 **Vacation Mode** — `vacation <until> [note]` pauses everything until a date and auto-resumes after (expired vacations self-clear on save/boot); `/api/vacation` endpoints + dashboard vacation card; upcoming preview hides covered dates
- 🆕 **Schedule Calendar** — `calendar [YYYY-MM]` ASCII month view + `/api/schedules/calendar` + dashboard month widget with navigation and click-a-day run lists
- 🆕 **Health Check + Heartbeat** — Cheap `/api/health` probe plus optional heartbeat pings (`heartbeat <url> [mins]`, auto-armed from config on server boot, CLI-set values picked up live via config watch); dashboard Heartbeat card
- 🆕 **Weekly Digest** — Daemon-scheduled Monday post (`digest on [day] [HH:MM]`, `digest test`, `digest off`) with 7-day totals + per-server breakdown to the global webhook; dashboard digest card with live summary

---

## 📋 What You Need Before Starting

1. **Node.js** installed on your computer ([Download here](https://nodejs.org/))
   - Check if you have it: Open Terminal/PowerShell and type `node -v`
   - You need version 18 or higher

2. **Your Discord User Token** ([How to get it](#-how-to-get-your-discord-token))

3. **Discord Channel ID** where you want to send attendance ([How to get it](#-how-to-get-a-channel-id))

---

## 🚀 Installation Guide (Step-by-Step)

### Step 1: Download and Install Dependencies

Open your **Terminal** (Mac/Linux) or **PowerShell** (Windows) and run these commands one by one:

##### Navigate to where you want to save the bot (e.g., Desktop)

```bash
cd Desktop
```

##### Download the project (or download and extract the ZIP from GitHub)

> 📱 **On Android?** No root required — see [Android (Termux, no root needed)](#android-termux-no-root-needed) for the mobile setup.

```bash
git clone https://github.com/iamadedo/croncord.git
```

##### Enter the project folder
```bash
cd croncord
```

##### Install required packages (this may take 1-2 minutes)
```bash
npm install
```

---

### Step 2: Choose Your Interface

**Option A — Interactive Terminal CLI (guided setup):**

```bash
npm run cli
```

The CLI detects your environment automatically (Windows / macOS / Linux / Termux / Docker) and, when the dashboard is offline, offers a startup choice:

```
  [1] Interactive Terminal CLI (manage profiles, schedules & daemon here)
  [2] Launch Web Dashboard in a New Terminal Window (http://localhost:3271)
  [3] Dual Mode (Web Server in new window + continue in Terminal CLI)
```

**Option B — Web Dashboard:**

```bash
npm start
```

Open your browser to 👉 **`http://localhost:3271`**

From the dashboard you can enter your token, add the webhook URL, create server profiles, build and reorder schedules, run test runs, and start/stop the daemon — all with one click.

---

### Step 3: Set Up Your First Server (CLI wizard)

In the CLI, choose **[2] Add New Server Profile**. The wizard will ask you:

1. **Discord User Token**: Paste your token (see below for how to get it)
2. **Global Webhook URL** (first run only): Paste it and the bot sends a **live test notification before saving** — a failed test is never stored
3. **Profile Name**: A nickname like "Work Server" or "Game Guild"
4. **Channel ID**: The channel where attendance should post (duplicates are detected — if the name or channel already exists, the wizard offers to add the schedule to that server instead)
5. **Schedules** — pick a builder mode:
   - **[1] Guided builder** — one routine at a time with full options: Everyday / Weekdays / Weekends / Specific weekday / One-time date / Custom cron, then Message **or** Reaction mode, then anti-detection jitter
   - **[2] Multi-Time / Multi-Day batch** — pick repeating weekday(s) **or** one-time date(s), then add **multiple times to the same day**, then **more days** — all in one pass
   - Times accept `09:00 AM` or `21:30` and are **re-prompted until valid**; dates must be real, `YYYY-MM-DD`, and not in the past
   - Messages can span **multiple lines** — type each line and press **Enter on an empty line** to finish (leave the first line blank for `Present`)
   - Variables like `{day}`, `{date}`, `{time}`, `{server}` work anywhere in a message (see [Message Templates & Pools](#-message-templates--pools))

✅ **Your configuration is now saved!** Everything lives in `config.json`, and a timestamped snapshot is stored in `backups/` before every change.

> 💡 When you exit the CLI, Croncord offers to **install and start the background services for you automatically** (daemon + dashboard) **and** to **link the CLI globally** — so you can skip Step 4 below if you accept.

### Launch From Anywhere (Global Aliases)

After linking (offered at CLI exit, or run `npm link` in the project folder once), any of these opens the CLI from **any directory** on the machine:

```bash
```bash
croncord  |  l2e  |  lazyruna  |  lazy-runa  |  attenda  |  attendancebot
```
```

```bash
cd ~/anywhere && l2e status     # works — config always resolves to the install folder
```

Unlink anytime with `npm unlink -g croncord`. (If a command isn't found after linking, make sure your npm global bin dir — `npm config get prefix` — is on `PATH`; on Windows/macOS/Linux the Node installer normally does this.)

---

### Step 4: Start the Background Services

```bash
npm run service:install
```

You'll see:

```
✅ Registered "croncord-daemon" (.../src/bot.js).
✅ Registered "croncord-web" (.../server.js).

🎉 Croncord services installed and running!
   • croncord-daemon — Discord background daemon
   • croncord-web — Web Dashboard at http://localhost:3271
```

**That's it!** Both services now run in the background. You can close the terminal — the daemon keeps posting (and self-heals Discord drops), and the dashboard stays live on port 3271.

### Autostart on Every Boot

`service:install` persists the process list (`pm2 save`). For boot resurrection, run **once**:

- **Windows** (PowerShell as Administrator): `npm install -g pm2-windows-startup` then `pm2-startup install`
- **macOS:** `npx pm2 startup launchd`, then run the command it prints
- **Linux:** `npx pm2 startup systemd`, then run the command it prints
- **Termux:** install Termux:Boot — the boot script runs `pm2 resurrect`, reviving **both** services, no root needed

Extra commands: `service:web:logs` (dashboard logs), `service:web:restart`, `service:web:status`.

---

## 🔑 How to Get Your Discord Token

> ⚠️ **IMPORTANT**: Your token is like a password to your Discord account. NEVER share it with anyone. If someone gets your token, they can control your Discord account.

1. Open Discord in your desktop browser or app
2. Press **F12** (or `Ctrl + Shift + I` on Windows/Linux, `Cmd + Option + I` on Mac)
3. Switch to the **Console** tab
4. Paste this script and press **Enter**:
   ```javascript
   (webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()
   ```
5. Copy the returned token string (without quotes) and paste it into the CLI wizard or the dashboard (**Credentials & Webhook** tab)

---

## 📍 How to Get a Channel ID

1. Open Discord and go to **User Settings** (gear icon)
2. Go to **Advanced** (under "APP SETTINGS")
3. Turn on **Developer Mode**
4. Go back to Discord, **right-click** any channel, and click **Copy Channel ID**

---

## 💻 Managing the Bot

### Check if the Bot is Running

```bash
npm run service:status
```

You'll see:

```
┌─────┬──────────────────────┬─────────┬─────────┬──────────┐
│ id  │ name                 │ status  │ uptime  │ memory   │
├─────┼──────────────────────┼─────────┼─────────┼──────────┤
│ 0   │ croncord-daemon │ online  │ 2h 15m  │ 45.2 MB  │
└─────┴──────────────────────┴─────────┴─────────┴──────────┘
```

### View Live Logs (What's Happening Right Now)

```bash
npm run service:logs
```

Press **Ctrl + C** to stop watching logs. (The dashboard also streams logs live with filters, search, and CSV export.)

### What's Running Next?

```bash
node bin/cli.js upcoming 10
```

Shows the next 10 real fire times across all servers with countdowns — or open the **Upcoming Runs** widget on the dashboard.

### Add More Servers or Edit Schedules

```bash
npm run cli
```

Choose **[2]** to add servers (with duplicate check + batch builder), **[3]/[4]** to manage servers and schedule routines (add, toggle, reorder by priority, delete), **[7]** for an instant test run.

### Stop Everything Completely

```bash
npm run service:uninstall
```

Removes **both** PM2 services (daemon + web dashboard).

---

## 💻 CLI Command Reference

| Command | Description |
| :--- | :--- |
| `status` | Daemon status, uptime, reconnect state, profile counts |
| `start` / `stop` / `restart` | Control the attendance daemon |
| `list` (or `servers`) | List all server profiles and schedules |
| `upcoming [count]` | *(New in v3.9)* Next real fire times across servers (default 10) |
| `server add <name> <chanId> [cron] [msg]` | Create a new server profile |
| `server edit <id> [name] [chan] [hook]` | Edit server details |
| `server toggle` / `pause` / `resume <id\|name>` | Pause / resume a server |
| `server delete <id\|name>` | Remove a server profile |
| `server enable-all` / `disable-all` | Bulk toggle all servers |
| `server ignore-holidays <id> on\|off` | *(New in v3.9)* Opt a server out of holiday skips |
| `server clone <id> <name> <chanId>` | *(New in v4.1)* Duplicate a profile with fresh IDs |
| `preview <serverId> [scheduleId]` | *(New in v4.1)* Dry-run: resolved post text, sends nothing |
| `schedule list <srvId>` | List schedules (with conflict warnings) |
| `schedule add <srvId> <cron> [msg] [label]` | Add a schedule (warns on conflicts) |
| `schedule toggle` / `pause` / `resume` | Pause / resume a schedule |
| `schedule delete <srvId> <schedId>` | Remove a schedule |
| `schedule duplicate <srvId> <schedId>` | *(New in v4.2)* Copy a routine (starts paused) |
| `schedule reorder <srvId> <id1,id2,...>` | Reorder execution priority sequence |
| `schedule move <srvId> <from> <to>` | Move a schedule between positions |
| `schedule conflicts <srvId>` | *(New in v3.9)* Show ≤5-minute clash warnings |
| `schedule pool <srvId> <schedId> [...]` | *(New in v3.9)* View/set message variants |
| `schedule enable-all \| disable-all <srvId>` | *(New in v4.1)* Bulk enable/pause every routine on a server |
| `trigger <serverId> [scheduleId]` | Immediate test run |
| `quiet [start end \| clear]` | *(New in v3.9)* View/set/clear quiet hours |
| `holiday list \| add <date> [name] \| remove <date>` | *(New in v3.9)* Manage named holidays |
| `backups` / `restore <file>` | *(New in v3.9)* List / restore config snapshots |
| `vacation [until] [note] \| off` | *(New in v4.1)* Pause all until a date (auto-resumes) |
| `calendar [YYYY-MM]` | *(New in v4.1)* Monthly firing calendar |
| `heartbeat [url] [mins] \| test \| off` | *(New in v4.1)* External monitor pings |
| `digest [on \| off \| test]` | *(New in v4.1)* Weekly webhook stats summary |
| `logs [count]` / `logs clear` | Activity logs |
| `token [new_token]` | View or update the Discord token |
| `webhook [url]` / `webhook test [url]` | View, update, or live-test the webhook |
| `backup` (or `export`) | Print current configuration JSON |
| `validate <file>` / `import <file> [merge\|replace]` | Schema-check / import configs |
| `service <status\|install\|uninstall\|logs>` | PM2 background service control |
| `uptime` | Uptime and reliability metrics |

---

## 🔀 Drag-and-Drop Schedule Prioritization & Test Runs

1. Navigate to **Server Profiles** in the Web Dashboard.
2. Grab the **priority handle** on any schedule row and drag it up or down — badges (`#1`, `#2`…) update instantly and persist via `/api/servers/:serverId/schedules/reorder`.
3. Or use the up/down chevrons, or CLI `schedule move` / `schedule reorder`.
4. Click the emerald **Test Run** play button (▶) on any row for an immediate execution with spinner state, toast feedback, and telemetry refresh — no page reload.

---

## 🏖️ Holidays & Quiet Hours

Some days, attendance should *intentionally* not fire — public holidays, server maintenance, or your sleep hours. Skips are recorded as neutral **`SKIPPED`** history entries: they never count as failures and never break streaks or success rates.

### Holidays (named skip-dates)

```bash
node bin/cli.js holiday add 2026-12-25 "Christmas Day"
node bin/cli.js holiday list
node bin/cli.js holiday remove 2026-12-25
# A server that operates on holidays:
node bin/cli.js server ignore-holidays <id> on
```

- Manage the global list from the CLI above or the dashboard **Holidays manager** (list, add with date-picker, remove).
- Per-server toggle (`ignoreHolidays`) lives in the server editor — a 24/7 community server can opt out while work servers observe holidays.
- One-time schedules landing on a holiday are marked skipped, not completed.
- The upcoming-runs preview automatically excludes holiday dates.

### Quiet hours (daily blackout window)

```bash
node bin/cli.js quiet 22:00 07:00   # global window (crosses midnight fine)
node bin/cli.js quiet                # view effective window
node bin/cli.js quiet clear
```

- Set globally or override per server (server value wins).
- Occurrences inside the window still appear in the preview but are flagged; at fire time the worker skips with a clear log line.

---

## 💬 Message Templates & Pools

Make posts feel human and never byte-identical:

- **Variables** (resolved at send time): `{date}` → `Oct 6, 2026`, `{time}` → `09:00 AM`, `{day}` → `Tuesday`, `{server}` → profile name, `{channel}` → channel ID.
  Example: `"Present — {day}, {date} ✅"` → `"Present — Tuesday, Oct 6, 2026 ✅"`
- **Variant pools**: give a schedule several messages; one is picked at random each run (on top of jitter). Manage via the wizard's variants step, `schedule pool`, or the dashboard schedule editor.
- History records the **exact resolved text** that went out, so audits show what was really posted.

---

## 📸 Restore Points (Auto-Backup)

- A snapshot lands in `backups/` **before every real change** (wizard edits, dashboard saves, imports) — but only when something actually changed, keeping the newest 20.
- CLI: `backups` lists snapshots, `restore <file>` rolls back (with confirmation).
- Dashboard: `GET /api/config/backups` + `POST /api/config/restore`, with Restore buttons in the backup area.
- `backup` still prints the live config JSON for quick copies.

---

## 👁️ Dry-Run Preview (v4.1)

See exactly what a schedule *would* post — resolved templates, pool variants, next fire time — without sending, logging, or recording anything:

```bash
node bin/cli.js preview srv1          # first schedule, fully resolved
node bin/cli.js preview srv1 a1       # a specific routine
```

Dashboard: the 👁️ **Preview** button on every schedule row opens the same render in a modal. API: `GET /api/servers/:id/schedules/:scid/preview`.

---

## 🧬 Server Clone & Bulk Ops (v4.1)

```bash
node bin/cli.js server clone srv1 "Copy" 999888777666555444
node bin/cli.js schedule disable-all srv1   # pause every routine
node bin/cli.js schedule enable-all srv1    # resume every routine
```

Cloning deep-copies all schedules with fresh IDs (channel duplicates rejected). Dashboard: Clone button on each server card (Clone modal) plus Enable-all / Pause-all buttons above every schedule table. API: `POST /api/servers/:id/clone`, `POST /api/servers/:id/schedules/bulk-action`.

---

## 🏖️ Vacation Mode (v4.1)

```bash
node bin/cli.js vacation 2026-12-20 "Christmas trip"
node bin/cli.js vacation              # view state
node bin/cli.js vacation off          # cancel early
```

Every firing until the end date is skipped neutrally (`SKIPPED`); expired vacations clear themselves on the next save or daemon boot, so schedules always resume. Manual test runs bypass it on purpose. Dashboard vacation card (arm/cancel + status); API: `GET/POST/DELETE /api/vacation`. Imports/exports carry it.

---

## 📆 Schedule Calendar (v4.1)

```bash
node bin/cli.js calendar              # this month, ASCII grid + day list
node bin/cli.js calendar 2026-10      # any month
```

Dashboard: month widget with prev/next navigation and click-a-day run lists (quiet-hour days flagged, holidays excluded). API: `GET /api/schedules/calendar?month=YYYY-MM`.

---

## 💓 Health Check & Heartbeat (v4.1)

```bash
curl http://localhost:3271/api/health
node bin/cli.js heartbeat https://hc-ping.com/abc 15
node bin/cli.js heartbeat test
node bin/cli.js heartbeat off
```

`/api/health` is a cheap probe (no history recompute) for uptime monitors. Heartbeat pings the configured URL on an interval from the server process (auto-armed from config at boot; CLI changes picked up live via the config watcher). Dashboard Heartbeat card with arm/test/off.

---

## 📰 Weekly Digest (v4.1)

```bash
node bin/cli.js digest                # view config
node bin/cli.js digest on monday 09:00
node bin/cli.js digest test           # post one immediately
node bin/cli.js digest off
```

Every week the daemon posts totals, success rate, and a per-server ✅/❌/⏸️ breakdown to the global webhook (needs a webhook + running daemon). Dashboard digest card shows the live 7-day summary with the same controls. API: `GET/POST/DELETE /api/digest`, `POST /api/digest/test`.

---

## 🌐 Web Dashboard Tour

Open 👉 **`http://localhost:3271`** (`npm start`):

- **Server Profiles** — cards with status badges, elapsed-since-check-in clocks, per-channel conflict warnings, drag-and-drop schedules, and Test Run buttons.
- **Upcoming Runs widget** — the next fire times across all servers with countdowns.
- **30-Day Analytics** — charts, heatmaps, success rates, streak counters.
- **Live Logs** — SSE stream with severity filters, search, clear, and CSV export.
- **Credentials & Webhook** — token + webhook management with live webhook test.
- **Backup & Import** — schema-validated import (merge/replace) with preview, export with version metadata, and one-click restore points.
- **Holidays & Quiet Hours** — named-holiday manager and quiet-window controls.
- **Web CLI Terminal** — full command console with history drop-up, help popover, and one-click run/insert.

Key API endpoints: `/api/status`, `/api/version`, `/api/health`, `/api/config`, `/api/servers/*`, `/api/servers/:id/schedules/*`, `/api/servers/:id/clone`, `/api/servers/:id/conflicts`, `/api/schedules/upcoming`, `/api/schedules/calendar`, `/api/config/backups`, `/api/config/restore`, `/api/quiet`, `/api/holidays`, `/api/vacation`, `/api/heartbeat`, `/api/digest`, `/api/daemon/start|stop`, `/api/test-webhook`, `/api/stats/daily-checkins`, `/api/servers/health`, `/api/logs*`.

---

## 🔄 24/7 Background Service Installation

```bash
npm run service:install   # install & start   |  npm run service:status
npm run service:logs      # live logs         |  npm run service:uninstall
```

The installer **auto-detects your OS** (the CLI shows it on startup, e.g. `🖥️ Detected environment: Windows (10.0.19045)`).

### Auto-Start on System Boot

- **Windows** (PowerShell as Administrator):
  ```powershell
  npm install -g pm2-windows-startup
  pm2-startup install
  ```
  If scripts are disabled: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` first ([docs](https://go.microsoft.com/fwlink/?LinkID=135170)).
- **macOS:** `npx pm2 startup launchd` (then run the command it prints)
- **Linux:** `npx pm2 startup systemd`

### Android (Termux — No Root Required)

1. Install [Termux](https://f-droid.org/en/packages/com.termux/) (F-Droid version recommended):
   ```bash
   pkg update && pkg upgrade -y
   pkg install nodejs-lts termux-api -y
   ```
2. Install the project:
   ```bash
   git clone https://github.com/iamadedo/croncord.git
   cd croncord
   npm install
   ```
3. Configure: `npm run cli`, set up your server, and **accept the exit-time offer to install the daemon** (or run `npm run service:install`). The installer detects Termux automatically and:
   - Acquires a **wake lock** (needs the [Termux:API](https://f-droid.org/en/packages/com.termux.api/) app) so Android doesn't suspend it
   - Creates a **Termux:Boot** startup script so the daemon resurrects after reboot
4. Install [Termux:Boot](https://f-droid.org/en/packages/com.termux.boot/) from F-Droid, open it once — done, no root required.

---

## 🔔 Get Notifications on Your Phone (Optional)

1. In Discord, go to the channel → gear icon → **Integrations** → **Webhooks** → **New Webhook** → **Copy Webhook URL**
2. CLI: menu **[10] Credentials** → update webhook (or set it during the Add Server wizard — it's **test-sent before saving**)
3. Dashboard: **Credentials & Webhook** tab → paste → Test
4. You'll get a test embed immediately; every run (success, failure, or holiday/quiet skip) can notify you from then on

---

## 📁 Project Files Explained

```
croncord/
├── bin/
│   ├── cli.js               ← Interactive menu + headless commands (npm run cli)
│   ├── install-service.js   ← PM2 install (auto-detects Windows/macOS/Linux/Termux)
│   └── uninstall-service.js ← PM2 removal (also cleans Termux boot script)
├── src/
│   ├── bot.js               ← Standalone daemon entry (PM2 target)
│   ├── daemonManager.js     ← Discord client, cron engine, self-heal reconnect
│   ├── cliEngine.js         ← Headless command parser (also powers the web terminal)
│   ├── scheduleConflicts.js ← 5-minute clash analysis (CLI + API)
│   ├── upcoming.js          ← Next-fire timeline computation
│   ├── suppression.js       ← Quiet-hours + holiday skip rules
│   ├── configBackups.js     ← Timestamped restore-point snapshots
│   ├── messageTemplates.js  ← {variable} resolution + pool picking
│   ├── attendanceHistory.js ← Run history, daily stats, health maps
│   ├── schemaValidator.js   ← Strict import/config validation
│   ├── logger.js            ← Leveled logs + SSE streaming + history
│   ├── version.js           ← Single source of truth (reads package.json)
│   └── engine/
│       └── worker.js        ← Sends messages/reactions, jitter, typing sim
├── public/
│   ├── index.html           ← Dashboard page
│   └── app.js               ← Dashboard logic (drag-drop, charts, terminal)
├── server.js                ← Web dashboard entry (port 3271, npm start)
├── config.json              ← YOUR SETTINGS (git-ignored, never share!)
├── config.example.json      ← Safe template of the config shape
├── backups/                 ← Auto-created restore-point snapshots (newest 20)
├── logs/server.log          ← Dashboard server output (headless/background mode)
├── package.json             ← Deps, scripts, version (bump per policy below)
├── CHANGELOG.md             ← Release history (Keep a Changelog)
└── README.md                ← This file!
```

**Important:** `config.json` contains your Discord token. Never share this file or commit it to GitHub!

---

## ⚠️ Important Warnings

### 1. Discord's Rules

Using "self-bots" (bots that control your personal Discord account) **violates Discord's Terms of Service**. While many people use them without issues, Discord *can* ban your account if they detect it.

**How to stay safer:**
- ✅ Always keep anti-detection jitter enabled (10+ minutes recommended) — pools + templates help further
- ✅ Don't use this bot on your main Discord account
- ✅ Use it sparingly (1-2 messages per day max)
- ✅ Respect holidays/quiet hours so it never posts at odd times
- ❌ Never post in rapid succession or across many servers

### 2. Keep Your Token Secret

Your Discord token is like your password. If someone gets it, they can read/send messages as you, join/leave servers, and change settings.

**Never:** share it, post it online, or commit `config.json` to GitHub.

### 3. Personal / Educational Use Only

Use this responsibly. Don't spam, don't harass, and respect the communities you're in.

---

## ❓ Troubleshooting

### "npm: command not found"
Install Node.js 18+: https://nodejs.org/

### "Failed to log into Discord: Unauthorized"
Your token is wrong or expired — grab a fresh one ([steps above](#-how-to-get-your-discord-token)) and update via CLI **[10]** or the dashboard.

### "Channel not found" / "Missing Permissions"
Check the Channel ID, your send permission, and that the channel still exists.

### CLI commands act strangely / show unexpected data
A stale server may be squatting on port 3271 (the CLI routes to any live server). Stop it via CLI **[K]**, or find and kill the old `node server.js` / `bin/cli.js --serve` process, then retry.

### Import rejected by schema validation
Run `node bin/cli.js validate <file>` to see exact errors (bad cron? non-numeric channel ID? blank name?) — fix and re-import, or restore a snapshot (`backups` → `restore <file>`).

### A run shows SKIPPED, not SUCCESS/FAILED
That's intentional: the firing landed on a **holiday** or inside **quiet hours**. Check `holiday list` / `quiet`. To exempt a server: `server ignore-holidays <id> on`.

### Bot stops working after a few days
- v3.9+ self-heals Discord drops (see `status` reconnect state + logs). If it gave up after 5 attempts, `restart` it.
- Otherwise: token expired, channel deleted, or rate-limited (reduce frequency / raise jitter). Inspect with `npm run service:logs`.

### How do I update the bot?
```bash
cd croncord
git pull
npm install
npm run service:uninstall
npm run service:install
```

---

## 🛠️ Advanced: Reaction-Based Attendance

Some servers require an emoji reaction instead of a message. In the wizard choose **Reaction mode**, or set it in `config.json`:

```json
{
  "id": "1234567891",
  "label": "09:00 AM (Weekdays)",
  "cron": "0 9 * * 1-5",
  "attendanceType": "REACTION",
  "emoji": "✅",
  "targetMessageId": "1234567890123456789",
  "maxJitterMinutes": 10,
  "active": true
}
```

If `targetMessageId` is empty, the bot reacts to the most recent message in the channel. Combine with `messagePool`… (pools apply to message mode; reaction mode uses `emoji`).

### Advanced: schedule variants & holidays in config

```json
{
  "label": "09:00 AM (Weekdays)",
  "cron": "0 9 * * 1-5",
  "message": "Present — {day}, {date} ✅",
  "messagePool": ["Present — {day}! ✅", "Here 🙋 ({date})", "Checking in ✅"],
  "quietHours": { "start": "22:00", "end": "07:00" }
}
```

```json
"globalQuietHours": { "start": "22:00", "end": "07:00" },
"globalHolidays": [
  { "date": "2026-12-25", "name": "Christmas Day" },
  { "date": "2026-01-01", "name": "New Year's Day" }
]
```

---

## 📝 Changelog

All notable changes, release history, and version archives are documented in the [Changelog](./CHANGELOG.md).

---

## 📌 Versioning Policy

Croncord adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- **Patch / Minor Bump (`3.8` → `3.9`):** Small improvements, UI enhancements, optimizations, bug fixes — and feature batches like the v3.9 restoration + holidays update.
- **Major Bump (`3.0` → `4.0`):** Breaking API changes or significant architectural overhauls.
- The version in `package.json` is the **single source of truth** (`src/version.js` reads it live): dashboard badges, `/api/version`, `/api/status`, export payloads, and CLI banners all follow it automatically. Every update bumps it and logs the change in `CHANGELOG.md`.

---

## 📞 Support & Community

- **Authors:** IamAdedo, dlazyHNTR
- **License:** MIT License — free to use, modify, and distribute. **Use at your own risk** — the authors are not responsible for Discord account bans or consequences of use.
- **Issues & Contributions:** Bug reports and ideas are welcome via GitHub Issues.


...with love by The !Lazy Hunter <||>
