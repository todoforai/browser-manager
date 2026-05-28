// @shared/web/server-helpers.js — small server-side helpers shared by *-manager Node services.
//
// Two-socket pattern: every manager binds a public REST on 0.0.0.0:<base> and
// an admin REST on 127.0.0.1:<base+10>. The localhost-only bind is the actual
// security boundary — nginx only ever proxies the public port, and edge configs
// also 404 /admin/ as defense-in-depth (see e.g. browser-manager/nginx/).
//
// Usage:
//   import express from 'express';
//   import { startAdminServer } from '@shared/web/server-helpers';
//   const adminApp = express();
//   adminApp.use(express.json());
//   adminApp.use('/admin/api', adminRouter);
//   const adminServer = await startAdminServer(adminApp, config.adminPort);

import { createServer } from 'http';

/**
 * Bind an admin Express app to 127.0.0.1:<port>. Returns the underlying http
 * Server (so callers can close() on shutdown). Bind host is hard-coded to
 * localhost — the whole point of the helper is that the invariant is not
 * negotiable per service.
 *
 * @param {import('express').Express} adminApp
 * @param {number} port
 * @returns {Promise<import('http').Server>}
 */
export function startAdminServer(adminApp, port) {
    const srv = createServer(adminApp);
    return new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => {
            console.log(`🛠  Admin REST 127.0.0.1:${port}`);
            resolve(srv);
        });
    });
}
