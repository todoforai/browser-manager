#!/usr/bin/env node
/**
 * server.ts — entry point
 *
 * Two servers:
 *   adminServer (:8085) — CDP WebSocket proxy (internal, no auth)
 *   httpServer  (:8086) — REST API for session CRUD + health
 */
import 'dotenv/config';
