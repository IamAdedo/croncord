/**
 * ecosystem.config.js — PM2 process declarations (single source of truth).
 *
 *   - croncord-daemon : Discord background daemon (src/bot.js)
 *   - croncord-web    : Web Management Dashboard (server.js) on :3271
 *
 * Used by bin/install-service.js, and usable directly:
 *   pm2 start ecosystem.config.js
 *   pm2 save            # persist for reboot resurrection
 */
module.exports = {
    apps: [
        {
            name: 'croncord-daemon',
            script: './src/bot.js',
            autorestart: true,
            max_memory_restart: '150M',
            env: { NODE_ENV: 'production' },
        },
        {
            name: 'croncord-web',
            script: './server.js',
            autorestart: true,
            max_memory_restart: '200M',
            env: { NODE_ENV: 'production', PORT: 3271 },
        },
    ],
};
