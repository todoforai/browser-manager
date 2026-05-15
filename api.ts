/**
 * api.ts
 *
 * REST routes for browser session management.
 * Mounted on the public HTTP server. The caller's identity (used to scope
 * list/delete-all) is derived from the auth token by service.requireAuth.
 *
 * POST   /api/sessions              create session
 * GET    /api/sessions              list caller's sessions
 * GET    /api/sessions/:sessionId   get session
 * DELETE /api/sessions/:sessionId   delete session
 * DELETE /api/sessions              delete all caller's sessions
 */

import { Router, Request, Response } from 'express';
import {
    createSession, getSession, listSessions,
    deleteSession, deleteAllForCaller,
    hibernateSession, restoreSession, listHibernated,
    requestToken,
} from './service.js';

const router = Router();

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
    const vp       = req.body.viewport;
    const viewport = (vp && typeof vp.width === 'number' && typeof vp.height === 'number'
        && vp.width > 0 && vp.height > 0) ? { width: vp.width, height: vp.height } : undefined;
    res.json(await createSession({ viewport }, token(req)));
}));

router.get('/hibernated', wrap(async (req, res) => {
    res.json(await listHibernated(token(req)));
}));

router.get('/', wrap(async (req, res) => {
    res.json(await listSessions(token(req)));
}));

router.get('/:sessionId', wrap(async (req, res) => {
    const info = await getSession(String(req.params.sessionId), token(req));
    if (!info) return res.status(404).json({ error: 'Session not found' });
    res.json(info);
}));

router.delete('/', wrap(async (req, res) => {
    res.json({ deleted: await deleteAllForCaller(token(req)) });
}));

router.delete('/:sessionId', wrap(async (req, res) => {
    await deleteSession(String(req.params.sessionId), token(req));
    res.json({ success: true });
}));

// POST /api/sessions/:sessionId/hibernate
router.post('/:sessionId/hibernate', wrap(async (req, res) => {
    const result = await hibernateSession(String(req.params.sessionId), token(req));
    if (result === 'not_found') return res.status(404).json({ error: 'Session not found' });
    if (result === 'in_use')    return res.status(409).json({ error: 'Session has active connections' });
    res.json({ success: true });
}));

// POST /api/sessions/:sessionId/restore
router.post('/:sessionId/restore', wrap(async (req, res) => {
    const info = await restoreSession(String(req.params.sessionId), token(req));
    if (!info) return res.status(404).json({ error: 'No hibernated session found' });
    res.json(info);
}));

export default router;
