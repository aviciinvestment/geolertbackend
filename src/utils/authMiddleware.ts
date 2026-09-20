import { Request, Response, NextFunction } from 'express';
import { firebaseAdminAuth } from '../services/firebase.service';
import { User } from '../models/User';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
    authorizationStatus: string;
    email: string;
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
    const decodedToken = await firebaseAdminAuth.verifyIdToken(token);

    // Find the user by their email (since we migrate from custom to firebase)
    let user = await User.findOne({ email: decodedToken.email }).select('_id role authorizationStatus email');
    
    // If not found, maybe they just registered but haven't synced yet.
    // The sync route handles this. But for general protected routes, we deny access.
    if (!user) {
      res.status(401).json({ success: false, message: 'User not found in system. Please log in again to sync.' });
      return;
    }

    req.user = {
      id: String(user._id),
      role: user.role,
      authorizationStatus: user.authorizationStatus,
      email: user.email,
    };
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({ success: false, message: 'Not authorized to access this route' });
  }
};

export const isFounderEmail = (email?: string): boolean => {
  const founderEmail = (process.env.FOUNDER_EMAIL || '').trim().toLowerCase();
  return Boolean(founderEmail && email && email.trim().toLowerCase() === founderEmail);
};

export const authorize = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Not authorized to access this route' });
      return;
    }

    const founderEmail = isFounderEmail(req.user.email);

    let allowed: boolean;
    if (roles.includes('founder')) {
      // Founder-only area is reserved for the configured founder email with the founder role.
      allowed = founderEmail && req.user.role === 'founder';
    } else if (founderEmail) {
      // The founder email may act in every other staff role.
      allowed = true;
    } else {
      allowed = roles.includes(req.user.role);
    }

    if (!allowed) {
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
