import { Request, Response } from 'express';
import { User } from '../models/User';
import Reel from '../models/Reel';
import { getSubordinateUsers } from '../services/hierarchy.service';

export class UserController {
  async getProfile(req: Request, res: Response): Promise<void> {
    try {
      const user = await User.findById(req.params.id).select('-password -email -googleId');
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const requesterId = (req as any).user?.id;
      const requesterRole = (req as any).user?.role;
      const isSelfOrAdmin = requesterId === user._id.toString() || requesterRole === 'admin';
      
      const query: any = { userId: user._id };
      if (!isSelfOrAdmin) {
        query.isAnonymous = { $ne: true };
      }

      const reels = await Reel.find(query).sort({ createdAt: -1 }).lean();

      // Ensure reels show the user's current avatar
      const enrichedReels = reels.map(reel => ({
        ...reel,
        avatar: user.avatar || reel.avatar,
        username: reel.isAnonymous ? 'Anonymous' : user.name,
      }));

      res.status(200).json({
        success: true,
        user: {
          id: user._id,
          name: user.name,
          avatar: user.avatar,
          bio: user.bio,
          isAnonymous: user.isAnonymous,
          trustScore: user.trustScore,
          createdAt: user.createdAt,
        },
        reels: enrichedReels,
      });
    } catch (error) {
      console.error('Get Profile Error:', error);
      res.status(500).json({ success: false, message: 'Server error fetching profile' });
    }
  }

  // GET /api/users/subordinates
  // Admin → the Authority Responders under them; Super Admin → the Local
  // Admins under them. Used for filter dropdowns and broadcast targeting.
  async getSubordinates(req: Request, res: Response): Promise<void> {
    try {
      const account = await User.findById((req as any).user.id)
        .select('role jurisdiction')
        .lean();
      if (!account) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      const members = await getSubordinateUsers(account as any);
      const data = members.map((m) => ({
        id: String(m._id),
        name: m.name,
        avatar: m.avatar,
        email: m.email,
        role: m.role,
        specialization: m.specialization || undefined,
        jurisdiction: m.jurisdiction || null,
      }));

      res.status(200).json({ success: true, data });
    } catch (error) {
      console.error('Get Subordinates Error:', error);
      res.status(500).json({ success: false, message: 'Server error fetching subordinates' });
    }
  }
}

export default new UserController();
