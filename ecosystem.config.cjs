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

// REST port; deploy.sh sets DEPLOY_PORT for blue-green flips. Default 8090.
// Noise port is paired: REST + 1 (so 8090→8091, 8092→8093).
// Coexists with `browsing` (which owns 8085/8086 on the same host).
const port = process.env.DEPLOY_PORT || '8090';
const noisePort = String(parseInt(port, 10) + 1);
// Admin port stays internal; pair across blue/green slots (8094/8095).
const adminPort = String(parseInt(port, 10) === 8090 ? 8094 : 8095);

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
        BROWSER_MANAGER_NOISE_PORT: noisePort,
      },
    },
  ],
};
