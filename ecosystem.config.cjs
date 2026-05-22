const fs = require('fs');
const path = require('path');

// Parse a KEY=VALUE env file into an object. Mirrors sandbox-manager/ecosystem.config.js
// so PM2 picks up shared .env without needing a separate loader.
function loadEnvFile(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

// REST port; deploy.sh sets DEPLOY_PORT for blue-green flips. Default 8600.
// Slot A: REST 8600 / Admin 8610 / CDP 8620 / Noise 8630.
// Slot B: REST 8602 / Admin 8612 / CDP 8622 / Noise 8632.
// Coexists with `browsing` (which owns 8085/8086 on the same host — unrelated service).
const port = process.env.DEPLOY_PORT || '8600';
const portN = parseInt(port, 10);
const adminPort = String(portN + 10);
const cdpPort   = String(portN + 20);
const noisePort = String(portN + 30);

const logDir = process.env.PM2_LOG_DIR
  || (fs.existsSync('/var/log/todoforai') ? '/var/log/todoforai' : null);

const baseDir = __dirname;
const sharedDir = path.join(baseDir, 'shared');
const isProd = process.env.NODE_ENV === 'production';
const envFromDisk = {
  ...loadEnvFile(path.join(baseDir, isProd ? '.env' : '.env.development')),
  ...loadEnvFile(path.join(sharedDir, '.env')),
  ...loadEnvFile(path.join(sharedDir, 'noise.env')),
};

module.exports = {
  apps: [
    {
      name: `browser-manager-${port}`,
      script: 'node_modules/.bin/tsx',
      args: 'server.ts',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '2G',
      exp_backoff_restart_delay: 100,
      kill_timeout: 10000,
      watch: false,
      time: true,
      merge_logs: true,
      ...(logDir && {
        error_file: `${logDir}/browser-manager-err.log`,
        out_file: `${logDir}/browser-manager-out.log`,
      }),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        ...envFromDisk,
        NODE_ENV: 'production',
        BROWSER_MANAGER_PORT: port,
        BROWSER_MANAGER_ADMIN_PORT: adminPort,
        BROWSER_MANAGER_CDP_PORT: cdpPort,
        BROWSER_MANAGER_NOISE_PORT: noisePort,
      },
    },
  ],
};
