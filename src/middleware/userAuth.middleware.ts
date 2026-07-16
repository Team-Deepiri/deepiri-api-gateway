import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { validateSecret } from '@team-deepiri/shared-utils';

// Same secret/signing scheme as deepiri-auth-service's login/register/refresh
// (jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '7d' })) -- this
// middleware is the other half: verify what auth-service issued.
const JWT_SECRET = validateSecret('JWT_SECRET', process.env.JWT_SECRET, 32);

interface DecodedToken {
  userId: string;
}

export function userAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Never forward a client-supplied identity claim -- only this middleware,
  // after verifying a real token, is allowed to set this. x-user-email is
  // stripped but deliberately never re-set: nothing downstream reads it, so
  // forwarding it would just be unnecessary PII exposure (least privilege).
  delete req.headers['x-user-id'];
  delete req.headers['x-user-email'];

  const authHeader = req.headers['authorization'];
  const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Missing bearer token.' });
    return;
  }

  let decoded: DecodedToken;
  try {
    decoded = jwt.verify(token, JWT_SECRET) as DecodedToken;
  } catch (err) {
    const message = err instanceof jwt.TokenExpiredError ? 'Token expired.' : 'Invalid token.';
    res.status(401).json({ error: `Unauthorized: ${message}` });
    return;
  }

  if (!decoded.userId) {
    res.status(401).json({ error: 'Unauthorized: Token missing userId claim.' });
    return;
  }

  req.headers['x-user-id'] = decoded.userId;

  next();
}
