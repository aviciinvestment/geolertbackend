import { Request, Response } from 'express';
import ReelService from '../services/reel.service';
import { User } from '../models/User';

export class FounderController {
  // GET /api/founder/dashboard
  async getGlobalDashboard(req: Request, res: Response): Promise<void> {
    try {
      if ((req as any).user?.role !== 'founder') {
        res.status(403).json({ success: false, message: 'Access denied. Founder role required.' });
        return;
      }

      // Using ReelService's dashboard with no scope to fetch ALL reels
      const data = await ReelService.getJurisdictionDashboard({});
      res.status(200).json({ success: true, data });
    } catch (error) {
      console.error('Founder dashboard error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch global dashboard' });
    }
  }

  // GET /api/founder/users
  async getAllUsersGrouped(req: Request, res: Response): Promise<void> {
    try {
      if ((req as any).user?.role !== 'founder') {
        res.status(403).json({ success: false, message: 'Access denied. Founder role required.' });
        return;
      }

      const users = await User.find({}).select('-password').lean();

      const groupedUsers = {
        users: users.filter((u) => u.role === 'user'),
        authorities: users.filter((u) => u.role === 'authority'),
        admins: users.filter((u) => u.role === 'admin'),
        superadmins: users.filter((u) => u.role === 'superadmin'),
        founders: users.filter((u) => u.role === 'founder'),
      };

      res.status(200).json({ success: true, data: groupedUsers });
    } catch (error) {
      console.error('Founder users error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch users' });
    }
  }
}

export default new FounderController();
