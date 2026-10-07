/**
 * src/configBackups.js
 *
 * Timestamped config.json snapshots ("restore points").
 * A snapshot is written before every real mutation so a bad edit, wizard
 * mistake or import can always be undone. Only the newest MAX_SNAPSHOTS
 * are kept; snapshots are skipped when nothing actually changed.
 */

const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const MAX_SNAPSHOTS = 20;

function ensureDir() {
    try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        return true;
    } catch (e) {
        return false;
    }
}

function snapshotFilename(at = new Date()) {
    const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `config-${stamp}.json`;
}

function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    try {
        return fs.readdirSync(BACKUP_DIR)
            .filter((f) => /^config-.*\.json$/.test(f))
            .sort()
            .reverse()
            .map((f) => {
                let stat = null;
                try { stat = fs.statSync(path.join(BACKUP_DIR, f)); } catch (e) { /* ignore */ }
                return {
                    file: f,
                    path: path.join(BACKUP_DIR, f),
                    size: stat ? stat.size : 0,
                    createdAt: stat ? stat.mtime.toISOString() : null,
                };
            });
    } catch (e) {
        return [];
    }
}

/**
 * Writes a snapshot of `configData` if it differs from the newest snapshot.
 * @returns {{ written: boolean, file?: string, reason?: string }}
 */
function maybeSnapshot(configData) {
    if (!ensureDir()) return { written: false, reason: 'backup dir unavailable' };
    let payload = '';
    try {
        payload = JSON.stringify(configData, null, 2);
    } catch (e) {
        return { written: false, reason: 'config not serializable' };
    }

    const existing = listBackups();
    if (existing.length > 0) {
        try {
            const latest = fs.readFileSync(existing[0].path, 'utf8');
            if (latest === payload) {
                return { written: false, reason: 'unchanged' };
            }
        } catch (e) { /* fall through and write */ }
    }

    const file = snapshotFilename();
    try {
        fs.writeFileSync(path.join(BACKUP_DIR, file), payload, 'utf8');
    } catch (e) {
        return { written: false, reason: e.message };
    }

    prune();
    return { written: true, file };
}

function prune() {
    const all = listBackups();
    if (all.length <= MAX_SNAPSHOTS) return 0;
    let removed = 0;
    all.slice(MAX_SNAPSHOTS).forEach((entry) => {
        try {
            fs.unlinkSync(entry.path);
            removed++;
        } catch (e) { /* ignore */ }
    });
    return removed;
}

/**
 * Reads a snapshot back (parsed). Throws on missing/invalid file.
 */
function readBackup(file) {
    const safe = String(file || '').trim();
    if (!/^config-.*\.json$/.test(safe)) {
        throw new Error(`Refusing to read unexpected backup name "${file}".`);
    }
    const full = path.join(BACKUP_DIR, safe);
    if (!fs.existsSync(full)) {
        throw new Error(`Restore point "${file}" not found.`);
    }
    return JSON.parse(fs.readFileSync(full, 'utf8'));
}

module.exports = {
    BACKUP_DIR,
    MAX_SNAPSHOTS,
    listBackups,
    maybeSnapshot,
    prune,
    readBackup,
};
