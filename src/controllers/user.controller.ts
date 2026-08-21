import { Request, Response } from 'express';
import { User } from '../models/User';
import Reel from '../models/Reel';

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
}

export default new UserController();
