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
import { isStealthOptions } from './noise-protocol.js';
import {
    createSession, getSession, listSessions,
    deleteSession, deleteAllForCaller,
    hibernateSession, restoreSession, listHibernated,
    requestToken,
    AUTH_INVALID, AUTH_MISSING_AS, AUTH_UNAVAIL, AUTH_FORBIDDEN,
} from './service.js';

const router = Router();

const token  = (req: Request) => requestToken({
    authorization: req.header('authorization') ?? undefined,
    'x-api-key': req.header('x-api-key') ?? undefined,
});
// Admin override — when caller uses BROWSER_MANAGER_ADMIN_KEY, X-Act-As selects target user.
const actAs = (req: Request) => req.header('x-act-as') ?? undefined;

const ERROR_STATUS: Record<string, number> = {
    [AUTH_INVALID]:    401,
    [AUTH_MISSING_AS]: 400,
    [AUTH_FORBIDDEN]:  403,
    [AUTH_UNAVAIL]:    503,
    'invalid payload': 400,
};

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
        try { await fn(req, res); }
        catch (e) {
            const message = (e as Error).message;
            res.status(ERROR_STATUS[message] ?? 500).json({ error: message });
        }
    };

router.post('/', wrap(async (req, res) => {
    const vp       = req.body.viewport;
    const viewport = (vp && typeof vp.width === 'number' && typeof vp.height === 'number'
        && vp.width > 0 && vp.height > 0) ? { width: vp.width, height: vp.height } : undefined;
    // Reject a malformed stealth block rather than silently dropping it — a typo'd
    // proxy would otherwise launch a direct-IP session, exactly what it's meant to avoid.
    const stealth = req.body.stealth;
    if (stealth !== undefined && !isStealthOptions(stealth)) throw new Error('invalid payload');
    res.json(await createSession({ viewport, stealth }, token(req), actAs(req)));
}));

router.get('/hibernated', wrap(async (req, res) => {
    res.json(await listHibernated(token(req), actAs(req)));
}));

router.get('/', wrap(async (req, res) => {
    res.json(await listSessions(token(req), actAs(req)));
}));

router.get('/:sessionId', wrap(async (req, res) => {
    const info = await getSession(String(req.params.sessionId), token(req), actAs(req));
    if (!info) return res.status(404).json({ error: 'Session not found' });
    res.json(info);
}));

router.delete('/', wrap(async (req, res) => {
    res.json({ deleted: await deleteAllForCaller(token(req), actAs(req)) });
}));

router.delete('/:sessionId', wrap(async (req, res) => {
    await deleteSession(String(req.params.sessionId), token(req), actAs(req));
    res.json({ success: true });
}));

// POST /api/sessions/:sessionId/hibernate
router.post('/:sessionId/hibernate', wrap(async (req, res) => {
    const result = await hibernateSession(String(req.params.sessionId), token(req), actAs(req));
    if (result === 'not_found') return res.status(404).json({ error: 'Session not found' });
    if (result === 'in_use')    return res.status(409).json({ error: 'Session has active connections' });
    res.json({ success: true });
}));

// POST /api/sessions/:sessionId/restore
router.post('/:sessionId/restore', wrap(async (req, res) => {
    const info = await restoreSession(String(req.params.sessionId), token(req), actAs(req));
    if (!info) return res.status(404).json({ error: 'No hibernated session found' });
    res.json(info);
}));

export default router;
