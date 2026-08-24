import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { User, IUser } from '../models/User';
import Reel from '../models/Reel';
import cloudinary from '../utils/cloudinary';
import { NIGERIA_LGAS } from '../data/nigeriaLGAs';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

const generateToken = (userId: string) => {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '7d' });
};

// Roles that require authorization from a superior before they may log in
const GATED_ROLES = ['authority', 'admin', 'superadmin'];

const sanitizeUser = (user: IUser) => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  avatar: user.avatar,
  bio: user.bio,
  isAnonymous: user.isAnonymous,
  role: user.role,
  authorizationStatus: user.authorizationStatus,
  jurisdiction: user.jurisdiction,
});

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({ success: false, message: 'Please provide all fields' });
      return;
    }

    const requestedRole =
      role && ['user', 'authority', 'admin', 'superadmin'].includes(role)
        ? role
        : 'user';

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(400).json({ success: false, message: 'User already exists' });
      return;
    }

    // Super Admin onboarding is only open while no Super Admin exists yet
    if (requestedRole === 'superadmin') {
      const existingSuperAdmin = await User.findOne({ role: 'superadmin' });
      if (existingSuperAdmin) {
        res.status(403).json({
          success: false,
          message:
            'A Super Admin already exists. New Super Admins can only be onboarded by an existing Super Admin.',
        });
        return;
      }
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Admins & Authority Responders start pending until their superior approves them
    const authorizationStatus =
      requestedRole === 'admin' || requestedRole === 'authority'
        ? 'pending'
        : 'approved';

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role: requestedRole,
      authorizationStatus,
    });

    // Pending privileged accounts are NOT issued a token —
    // they must wait for authorization before logging in
    if (authorizationStatus === 'pending') {
      res.status(201).json({
        success: true,
        pendingApproval: true,
        message:
          requestedRole === 'admin'
            ? 'Registration received. Your Admin account is awaiting authorization from the Super Admin before you can log in.'
            : 'Registration received. Your Authority Responder account is awaiting authorization from a Local Admin before you can log in.',
      });
      return;
    }

    const token = generateToken(user.id);

    res.status(201).json({
      success: true,
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Registration Error:', error);
    res.status(500).json({ success: false, message: 'Server error during registration' });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ success: false, message: 'Please provide email and password' });
      return;
    }

    const user = await User.findOne({ email });
    if (!user || !user.password) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }

    // Privileged roles cannot log in until authorized by their superior
    if (GATED_ROLES.includes(user.role)) {
      if (user.authorizationStatus === 'pending') {
        res.status(403).json({
          success: false,
          code: 'PENDING_AUTHORIZATION',
          awaiting: user.role === 'admin' ? 'Super Admin' : 'Local Admin',
          message:
            user.role === 'admin'
              ? 'Your Admin account is still awaiting authorization from the Super Admin.'
              : 'Your Authority Responder account is still awaiting authorization from a Local Admin.',
        });
        return;
      }

      if (user.authorizationStatus === 'rejected') {
        res.status(403).json({
          success: false,
          code: 'AUTHORIZATION_REJECTED',
          message: 'Your account authorization request was rejected. Contact your administrator.',
        });
        return;
      }
    }

    const token = generateToken(user.id);

    res.status(200).json({
      success: true,
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
};

export const googleLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { credential } = req.body;

    if (!credential) {
      res.status(400).json({ success: false, message: 'Google credential missing' });
      return;
    }

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      res.status(400).json({ success: false, message: 'Invalid Google token' });
      return;
    }

    const { sub, email, name, picture } = payload;

    let user = await User.findOne({ email });

    if (!user) {
      // Create new user if not exists
      user = await User.create({
        name: name || 'Google User',
        email,
        googleId: sub,
        avatar: picture,
      });
    } else if (!user.googleId) {
      // Link Google account to existing user
      user.googleId = sub;
      if (!user.avatar) user.avatar = picture;
      await user.save();
    }

    const token = generateToken(user.id);

    res.status(200).json({
      success: true,
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Google Login Error:', error);
    res.status(500).json({ success: false, message: 'Server error during Google Login' });
  }
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await User.findById((req as any).user.id).select('-password');
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    res.status(200).json({
      success: true,
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Get Me Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching user' });
  }
};

export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, avatar, bio, isAnonymous } = req.body;
    const userId = (req as any).user.id;

    const updateFields: Record<string, any> = {};
    if (name !== undefined) updateFields.name = name;
    if (avatar !== undefined) updateFields.avatar = avatar;
    if (bio !== undefined) updateFields.bio = bio;
    if (isAnonymous !== undefined) updateFields.isAnonymous = isAnonymous;

    const user = await User.findByIdAndUpdate(userId, updateFields, { new: true }).select('-password');
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // Sync avatar/name changes to all user's reels
    const reelUpdates: Record<string, any> = {};
    if (updateFields.avatar) reelUpdates.avatar = updateFields.avatar;
    if (updateFields.name) reelUpdates.username = updateFields.name;
    if (Object.keys(reelUpdates).length > 0) {
      await Reel.updateMany({ userId }, { $set: reelUpdates });
    }

    res.status(200).json({
      success: true,
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Upload Avatar Error:', error);
    res.status(500).json({ success: false, message: 'Server error uploading avatar' });
  }
};

// POST /api/auth/onboard/superadmin
// Only an approved Super Admin may onboard additional Super Admins
export const onboardSuperAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, country, state } = req.body;

    if (!name || !email || !password || !country || !state) {
      res.status(400).json({
        success: false,
        message: 'Please provide name, email, password, country and state',
      });
      return;
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(400).json({ success: false, message: 'A user with this email already exists' });
      return;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role: 'superadmin',
      authorizationStatus: 'approved',
      authorizedBy: (req as any).user.id,
      jurisdiction: { country, state },
    });

    res.status(201).json({
      success: true,
      message: 'Super Admin onboarded successfully. They can now log in with the temporary password.',
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Onboard Super Admin Error:', error);
    res.status(500).json({ success: false, message: 'Server error during onboarding' });
  }
};

// POST /api/auth/onboard/admin
// Only an approved Super Admin may onboard Local Admins (scoped to a State LGA)
export const onboardAdmin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, state, lga } = req.body;

    if (!name || !email || !password || !state || !lga) {
      res.status(400).json({
        success: false,
        message: 'Please provide name, email, password, state and lga',
      });
      return;
    }

    const knownLGAs = NIGERIA_LGAS[state];
    if (!knownLGAs) {
      res.status(400).json({ success: false, message: 'Unknown state. Please select a valid Nigerian state.' });
      return;
    }
    if (!knownLGAs.includes(lga)) {
      res.status(400).json({ success: false, message: 'Unknown LGA for the selected state.' });
      return;
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(400).json({ success: false, message: 'A user with this email already exists' });
      return;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role: 'admin',
      authorizationStatus: 'approved',
      authorizedBy: (req as any).user.id,
      jurisdiction: { country: 'Nigeria', state, lga },
    });

    res.status(201).json({
      success: true,
      message: 'Admin onboarded successfully. They can now log in with the temporary password.',
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Onboard Admin Error:', error);
    res.status(500).json({ success: false, message: 'Server error during onboarding' });
  }
};

// POST /api/auth/onboard/authority
// Only an approved Local Admin may onboard Authority Responders,
// and they are always scoped to the admin's own State + LGA.
export const onboardAuthority = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({
        success: false,
        message: 'Please provide name, email and password',
      });
      return;
    }

    const admin = await User.findById((req as any).user.id).select('jurisdiction');
    const jurisdiction: any = admin?.jurisdiction || {};
    if (!jurisdiction.state || !jurisdiction.lga) {
      res.status(400).json({
        success: false,
        message:
          'Your admin account has no LGA jurisdiction set. Ask a Super Admin to re-onboard you with a state and LGA.',
      });
      return;
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(400).json({ success: false, message: 'A user with this email already exists' });
      return;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role: 'authority',
      authorizationStatus: 'approved',
      authorizedBy: (req as any).user.id,
      jurisdiction: {
        country: jurisdiction.country || 'Nigeria',
        state: jurisdiction.state,
        lga: jurisdiction.lga,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Authority Responder onboarded successfully. They can now log in with the temporary password.',
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Onboard Authority Error:', error);
    res.status(500).json({ success: false, message: 'Server error during onboarding' });
  }
};

// GET /api/auth/approvals
// Super Admin sees pending Admins; Admin sees pending Authority Responders
export const getPendingApprovals = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { role } = (req as any).user;

    if (role === 'superadmin') {
      const pending = await User.find({ role: 'admin', authorizationStatus: 'pending' })
        .select('-password')
        .sort({ createdAt: -1 });
      res.status(200).json({ success: true, approvals: pending });
      return;
    }

    if (role === 'admin') {
      const pending = await User.find({ role: 'authority', authorizationStatus: 'pending' })
        .select('-password')
        .sort({ createdAt: -1 });
      res.status(200).json({ success: true, approvals: pending });
      return;
    }

    res.status(403).json({ success: false, message: 'Access denied for your role' });
  } catch (error) {
    console.error('Get Pending Approvals Error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching pending approvals' });
  }
};

// PUT /api/auth/approvals/:id  body: { action: 'approve' | 'reject' }
export const reviewApproval = async (req: Request, res: Response): Promise<void> => {
  try {
    const { role } = (req as any).user;
    const { action } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      res.status(400).json({ success: false, message: "Action must be 'approve' or 'reject'" });
      return;
    }

    const target = await User.findById(req.params.id);
    if (!target) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // Strict chain of authority:
    // Super Admin authorizes Admins — Admin authorizes Authority Responders
    const canReview =
      (role === 'superadmin' && target.role === 'admin') ||
      (role === 'admin' && target.role === 'authority');

    if (!canReview) {
      res.status(403).json({
        success: false,
        message: 'You are not authorized to review this account',
      });
      return;
    }

    target.authorizationStatus = action === 'approve' ? 'approved' : 'rejected';
    target.authorizedBy = (req as any).user.id;
    await target.save();

    res.status(200).json({
      success: true,
      message: `${target.role} account ${action}d successfully`,
      user: sanitizeUser(target),
    });
  } catch (error) {
    console.error('Review Approval Error:', error);
    res.status(500).json({ success: false, message: 'Server error reviewing approval' });
  }
};

export const updateLocation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { latitude, longitude } = req.body;
    const userId = (req as any).user.id;

    if (latitude === undefined || longitude === undefined) {
      res.status(400).json({ success: false, message: 'Latitude and longitude are required' });
      return;
    }

    const user = await User.findByIdAndUpdate(
      userId,
      {
        location: {
          type: 'Point',
          coordinates: [longitude, latitude], // GeoJSON order is [longitude, latitude]
        }
      },
      { new: true }
    ).select('-password');

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // Privileged roles get their current administrative region tagged
    // (throttled) so jurisdiction dashboards can count deployed responders.
    const stale =
      !user.regionTaggedAt || Date.now() - new Date(user.regionTaggedAt).getTime() > 6 * 60 * 60 * 1000;
    if (['authority', 'admin', 'superadmin'].includes(user.role) && stale) {
      try {
        const { reverseGeocode } = await import('../services/geo.service');
        const region = await reverseGeocode(latitude, longitude);
        user.region = region || {};
        user.regionTaggedAt = new Date();
        await user.save();
      } catch {
        // Non-fatal — region tagging can be retried later
      }
    }

    res.status(200).json({ success: true, user });
  } catch (error) {
    console.error('Update Location Error:', error);
    res.status(500).json({ success: false, message: 'Server error updating location' });
  }
};

export const uploadAvatar = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'No image file provided' });
      return;
    }

    const userId = (req as any).user.id;
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'geolert_avatars',
      transformation: [{ width: 256, height: 256, crop: 'fill' }],
    });

    const fs = await import('fs');
    fs.unlinkSync(req.file.path);

    const user = await User.findByIdAndUpdate(userId, { avatar: result.secure_url }, { new: true }).select('-password');
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // Sync new avatar to all user's reels
    await Reel.updateMany({ userId }, { $set: { avatar: result.secure_url } });

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        bio: user.bio,
        isAnonymous: user.isAnonymous,
      },
    });
  } catch (error) {
    console.error('Upload Avatar Error:', error);
    res.status(500).json({ success: false, message: 'Server error uploading avatar' });
  }
};
