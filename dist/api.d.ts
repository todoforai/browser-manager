/**
 * api.ts
 *
 * REST routes for browser session management.
 * Mounted on the public HTTP server.
 *
 * POST   /api/sessions              create session
 * GET    /api/sessions              list sessions (optional ?userId=)
 * GET    /api/sessions/:sessionId   get session
 * DELETE /api/sessions/:sessionId   delete session
 * DELETE /api/sessions?userId=      delete all sessions for user
 */
declare const router: import("express-serve-static-core").Router;
export default router;
