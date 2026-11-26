import * as service from './service.js';
import { actorFromReq } from '../../core/tx.js';
import { setSessionCookie, clearSessionCookie } from '../../core/session.js';

// POST /api/auth/login
export async function login(req, res) {
  const { email, password } = req.input.body;
  const out = await service.login({ email, password, ip: req.ip, userAgent: req.get('user-agent') });
  setSessionCookie(res, out.token, out.maxAgeMs);
  res.json({ mustChangePassword: out.mustChangePassword, sessionExpiresAt: out.expiresAt });
}

// POST /api/auth/logout
export async function logout(req, res) {
  await service.logout(req.user, actorFromReq(req));
  clearSessionCookie(res);
  res.status(204).end();
}

// POST /api/auth/change-password
export async function changePassword(req, res) {
  const out = await service.changePassword(req.user, actorFromReq(req), req.input.body, { userAgent: req.get('user-agent') });
  setSessionCookie(res, out.token, out.maxAgeMs);
  res.json({ mustChangePassword: false, sessionExpiresAt: out.expiresAt });
}

// GET /api/auth/me
export function me(req, res) {
  res.json(service.toMe(req.user));
}
