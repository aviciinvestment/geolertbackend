import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
    authorizationStatus: string;
  };
}

export const protect = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    res.status(401).json({ success: false, message: 'Not authorized to access this route' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string };

    // Load the live user so role/status revocations apply instantly
    const user = await User.findById(decoded.id).select('role authorizationStatus');
    if (!user) {
      res.status(401).json({ success: false, message: 'Not authorized to access this route' });
      return;
    }

    req.user = {
      id: decoded.id,
      role: user.role,
      authorizationStatus: user.authorizationStatus,
    };
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: 'Not authorized to access this route' });
  }
};

export const authorize = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Not authorized to access this route' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ success: false, message: 'Access denied for your role' });
      return;
    }

    if (req.user.authorizationStatus !== 'approved') {
      res.status(403).json({
        success: false,
        message: 'Your account has not been authorized yet',
      });
      return;
    }

    next();
  };
};
