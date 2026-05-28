// Type declarations for the JS helper — kept next to the implementation so
// every TS consumer (storage-manager, browser-manager, vault-manager) sees
// them via the package's exports.
import type { Express } from 'express';
import type { Server } from 'http';

/**
 * Bind an admin Express app to 127.0.0.1:<port>. See server-helpers.js.
 */
export function startAdminServer(adminApp: Express, port: number): Promise<Server>;
