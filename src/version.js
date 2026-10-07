/**
 * src/version.js
 *
 * Single Source of Truth for Croncord Application Version.
 * Dynamically resolves the global version from package.json so bumping
 * "version" in package.json propagates instantly across the Web Dashboard,
 * REST API endpoints, CLI menus, JSON schema validators, and export payloads.
 */

const fs = require('fs');
const path = require('path');

function readPackageVersion() {
    try {
        const pkgPath = path.join(__dirname, '..', 'package.json');
        const content = fs.readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(content);
        return pkg.version || '3.8.0';
    } catch (e) {
        return '3.8.0';
    }
}

module.exports = {
    get version() {
        return readPackageVersion();
    },
    get VERSION() {
        return readPackageVersion();
    },
    get DISPLAY_VERSION() {
        return `v${readPackageVersion()}`;
    },
    readPackageVersion,
};
