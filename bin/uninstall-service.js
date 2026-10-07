#!/usr/bin/env node

const pm2 = require('pm2');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

const SERVICE_NAME = 'croncord-daemon';
const WEB_SERVICE_NAME = 'croncord-web';
// Pre-4.0 (AttendanceBot-era) names — always cleaned up too.
const LEGACY_SERVICE_NAMES = ['attendanceBot-daemon', 'attendanceBot-web'];
const BOOT_SCRIPT = 'start-croncord.sh';
const LEGACY_BOOT_SCRIPT = 'start-attendancebot.sh';

function isTermux() {
    return (
        process.platform === 'android' ||
        (process.env.PREFIX || '').includes('com.termux') ||
        Boolean(process.env.TERMUX_VERSION)
    );
}

/**
 * Reverses the Termux-specific setup performed by install-service.js:
 * removes the Termux:Boot autostart script and releases the wake lock.
 */
function teardownTermux() {
    [BOOT_SCRIPT, LEGACY_BOOT_SCRIPT].forEach((name) => {
        const bootScript = path.join(os.homedir(), '.termux', 'boot', name);
        try {
            if (fs.existsSync(bootScript)) {
                fs.unlinkSync(bootScript);
                console.log(`🧹 Removed Termux:Boot autostart script (${name}).`);
            }
        } catch (err) {
            console.log(`⚠️  Could not remove boot script: ${err.message}`);
        }
    });

    execFile('termux-wake-unlock', (err) => {
        if (!err) {
            console.log('🔓 Termux wake lock released.');
        }
    });
}

console.log('\n==================================================');
console.log('   🗑️  Croncord - Uninstalling Services ');
console.log('==================================================\n');

pm2.connect((err) => {
    if (err) {
        console.error('❌ Failed to connect to PM2 daemon:', err.message);
        process.exit(1);
    }
    pm2.disconnect();

    // Removal runs through the local PM2 CLI (deterministic, per-command
    // timeouts) instead of the programmatic API, which can stall on some
    // machines when processes are mid-restart.
    const runners = [];
    const localBin = path.join(__dirname, '..', 'node_modules', 'pm2', 'bin', 'pm2');
    if (fs.existsSync(localBin)) {
        runners.push([process.execPath, [localBin]]);
    }
    runners.push(['npx', ['pm2']]);

    const pm2cli = (args) => {
        for (const [cmd, prefix] of runners) {
            try {
                const out = execFileSync(cmd, [...prefix, ...args], { timeout: 45000, stdio: 'pipe' });
                return { ok: true, out: String(out || '') };
            } catch (e) {
                // try next runner
            }
        }
        return { ok: false };
    };

    const removeOne = (name) => {
        const r = pm2cli(['delete', name]);
        if (r.ok) {
            console.log(`✅ Removed "${name}" from PM2.`);
        } else {
            console.log(`ℹ️ "${name}" not present (or already removed).`);
        }
    };

    for (const name of [SERVICE_NAME, WEB_SERVICE_NAME, ...LEGACY_SERVICE_NAMES]) {
        removeOne(name);
    }

    // Persist the cleared list so a reboot cannot resurrect removed services.
    // --force is required because PM2 skips saving an empty process list.
    const saved = pm2cli(['save', '--force']);
    if (!saved.ok) {
        console.log('⚠️ Could not persist the empty process list (`pm2 save` failed).');
    }

    if (isTermux()) {
        teardownTermux();
    }

    console.log('✅ Background services cleared (daemon + web dashboard).');
    console.log('==================================================\n');
});
