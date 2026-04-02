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
import { Router } from 'express';
import crypto from 'crypto';
import { createSession, getSession, listSessions, deleteSession, deleteAllForUser, } from './session-manager.js';
const router = Router();
const qs = (v) => typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : undefined;
router.post('/', async (req, res) => {
    const sessionId = crypto.randomUUID();
    const userId = req.body.userId || 'anonymous';
    const viewport = req.body.viewport;
    try {
        const info = await createSession(sessionId, { userId, viewport });
        res.json(info);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
router.get('/', async (req, res) => {
    res.json(await listSessions(qs(req.query.userId)));
});
router.get('/:sessionId', async (req, res) => {
    const info = await getSession(String(req.params.sessionId));
    if (!info)
        return res.status(404).json({ error: 'Session not found' });
    res.json(info);
});
router.delete('/', async (req, res) => {
    const userId = qs(req.query.userId);
    if (!userId)
        return res.status(400).json({ error: 'userId required' });
    res.json({ deleted: await deleteAllForUser(userId) });
});
router.delete('/:sessionId', async (req, res) => {
    await deleteSession(String(req.params.sessionId));
    res.json({ success: true });
});
export default router;
//# sourceMappingURL=api.js.map