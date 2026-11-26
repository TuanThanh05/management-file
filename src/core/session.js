import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const SESSION_COOKIE = 'rr_session';
const ISSUER = 'records-retention';

// Ký JWT chứa id người dùng (sub) và id phiên (jti = login_sessions.id)
export function signSessionToken({ userId, sessionId, expiresInSec }) {
  return jwt.sign({}, env.JWT_SECRET, {
    algorithm: 'HS256', subject: String(userId), jwtid: sessionId, expiresIn: expiresInSec, issuer: ISSUER,
  });
}

// Kiểm tra chữ ký và hạn của JWT; sai thì trả null
export function verifySessionToken(token) {
  try {
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
    if (!p.sub || !p.jti) return null;
    return { userId: p.sub, sessionId: p.jti };
  } catch {
    return null;
  }
}

const cookieOptions = () => ({ httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict', path: '/' });

// Đặt cookie phiên httpOnly, Secure, SameSite=Strict (mục 7.1)
export function setSessionCookie(res, token, maxAgeMs) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: maxAgeMs });
}

// Xóa cookie phiên ở trình duyệt
export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}
