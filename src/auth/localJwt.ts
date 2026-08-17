import jwt from 'jsonwebtoken';
import { validateSecret } from '@team-deepiri/shared-utils';

/** Must match deepiri-auth-service: jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '7d' }). */
const JWT_SECRET = validateSecret('JWT_SECRET', process.env.JWT_SECRET, 32);

export type LocalJwtPayload = {
  userId: string;
  email?: string;
};

export type LocalJwtResult =
  | { ok: true; payload: LocalJwtPayload }
  | { ok: false; status: 401; error: string };

export function bearerTokenFromAuthorization(authorization: string): string {
  const value = String(authorization || '').trim();
  if (!value) return '';
  return value.replace(/^Bearer\s+/i, '').trim();
}

export function verifyLocalBearerToken(authorization: string): LocalJwtResult {
  const token = bearerTokenFromAuthorization(authorization);
  if (!token) {
    return { ok: false, status: 401, error: 'authorization required' };
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as LocalJwtPayload;
    if (!decoded?.userId) {
      return { ok: false, status: 401, error: 'token missing userId' };
    }
    return { ok: true, payload: decoded };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return { ok: false, status: 401, error: 'token expired' };
    }
    return { ok: false, status: 401, error: 'invalid token' };
  }
}
