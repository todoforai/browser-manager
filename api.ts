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
import {
    createSession, getSession, listSessions,
    deleteSession, deleteAllForUser,
    hibernateSession, restoreSession, listHibernated,
    requestToken,
} from './service.js';

const router = Router();

const qs = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : undefined;

const token = (req: Request) => requestToken({
    authorization: req.header('authorization') ?? undefined,
    'x-api-key': req.header('x-api-key') ?? undefined,
});

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
        try { await fn(req, res); }
        catch (e) {
            const message = (e as Error).message;
            const status = message === 'invalid api key' ? 401 : message === 'invalid payload' ? 400 : 500;
            res.status(status).json({ error: message });
        }
    };

router.post('/', wrap(async (req, res) => {
    const user_id  = typeof req.body.userId === 'string' ? req.body.userId : 'anonymous';
    const vp       = req.body.viewport;
    const viewport = (vp && typeof vp.width === 'number' && typeof vp.height === 'number'
        && vp.width > 0 && vp.height > 0) ? { width: vp.width, height: vp.height } : undefined;
    res.json(await createSession({ user_id, viewport }, token(req)));
}));

router.get('/hibernated', wrap(async (req, res) => {
    res.json(await listHibernated(qs(req.query.userId), token(req)));
}));

router.get('/', wrap(async (req, res) => {
    res.json(await listSessions(qs(req.query.userId), token(req)));
}));

router.get('/:sessionId', wrap(async (req, res) => {
    const info = await getSession(String(req.params.sessionId), token(req));
    if (!info) return res.status(404).json({ error: 'Session not found' });
    res.json(info);
}));

router.delete('/', wrap(async (req, res) => {
    const userId = qs(req.query.userId);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json({ deleted: await deleteAllForUser(userId, token(req)) });
}));

router.delete('/:sessionId', wrap(async (req, res) => {
    await deleteSession(String(req.params.sessionId), token(req));
    res.json({ success: true });
}));

// POST /api/sessions/:sessionId/hibernate
router.post('/:sessionId/hibernate', wrap(async (req, res) => {
    const ok = await hibernateSession(String(req.params.sessionId), token(req));
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
}));

// POST /api/sessions/:sessionId/restore
router.post('/:sessionId/restore', wrap(async (req, res) => {
    const info = await restoreSession(String(req.params.sessionId), token(req));
    if (!info) return res.status(404).json({ error: 'No hibernated session found' });
    res.json(info);
}));

export default router;
