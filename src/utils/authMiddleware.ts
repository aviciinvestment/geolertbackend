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
