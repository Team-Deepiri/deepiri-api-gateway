import { Request, Response, NextFunction } from 'express';
import { verifyLocalBearerToken } from '../auth/localJwt';

export function userAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Never forward a client-supplied identity claim -- only this middleware,
  // after verifying a real token, is allowed to set this. x-user-email is
  // stripped but deliberately never re-set: nothing downstream reads it, so
  // forwarding it would just be unnecessary PII exposure (least privilege).
  delete req.headers['x-user-id'];
  delete req.headers['x-user-email'];

  const authHeader = req.headers['authorization'];
  const tokenHeader = typeof authHeader === 'string' ? authHeader : '';

  const result = verifyLocalBearerToken(tokenHeader);
  if (!result.ok) {
    if (result.error === 'authorization required') {
      res.status(401).json({ error: 'Unauthorized: Missing bearer token.' });
      return;
    }
    const message =
      result.error === 'token expired' ? 'Token expired.' : 'Invalid token.';
    res.status(401).json({ error: `Unauthorized: ${message}` });
    return;
  }

  req.headers['x-user-id'] = result.payload.userId;

  next();
}
