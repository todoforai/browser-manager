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

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import {
    createSession, getSession, listSessions,
    deleteSession, deleteAllForUser,
    hibernateSession, restoreSession, listHibernated,
} from './session-manager.js';

const router = Router();

const qs = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : undefined;

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
        try { await fn(req, res); }
        catch (e) { res.status(500).json({ error: (e as Error).message }); }
    };

router.post('/', wrap(async (req, res) => {
    const userId   = typeof req.body.userId === 'string' ? req.body.userId : 'anonymous';
    const vp       = req.body.viewport;
    const viewport = (vp && typeof vp.width === 'number' && typeof vp.height === 'number'
        && vp.width > 0 && vp.height > 0) ? { width: vp.width, height: vp.height } : undefined;
    res.json(await createSession(crypto.randomUUID(), { userId, viewport }));
}));

router.get('/', wrap(async (req, res) => {
    res.json(await listSessions(qs(req.query.userId)));
}));

router.get('/:sessionId', wrap(async (req, res) => {
    const info = await getSession(String(req.params.sessionId));
    if (!info) return res.status(404).json({ error: 'Session not found' });
    res.json(info);
}));

router.delete('/', wrap(async (req, res) => {
    const userId = qs(req.query.userId);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json({ deleted: await deleteAllForUser(userId) });
}));

router.delete('/:sessionId', wrap(async (req, res) => {
    await deleteSession(String(req.params.sessionId));
    res.json({ success: true });
}));

// POST /api/sessions/:sessionId/hibernate
router.post('/:sessionId/hibernate', wrap(async (req, res) => {
    const ok = await hibernateSession(String(req.params.sessionId));
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
}));

// POST /api/sessions/:sessionId/restore
router.post('/:sessionId/restore', wrap(async (req, res) => {
    const info = await restoreSession(String(req.params.sessionId));
    if (!info) return res.status(404).json({ error: 'No hibernated session found' });
    res.json(info);
}));

// GET /api/sessions/hibernated?userId=
router.get('/hibernated', wrap(async (req, res) => {
    res.json(await listHibernated(qs(req.query.userId)));
}));

export default router;
