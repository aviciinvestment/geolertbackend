import { Request, Response } from 'express';
import ReelService from '../services/reel.service';
import fs from 'fs';
import { User } from '../models/User';
import { getSubordinateUsers } from '../services/hierarchy.service';
import { assignedReelsForAuthority } from '../services/incident.service';

export class ReelController {

  // GET /api/reels/assigned
  // Only incidents routed to this Authority Responder (jurisdiction +
  // specialization aware), shaped like the feed for the mission planner.
  async getAssignedReels(req: Request, res: Response): Promise<void> {
    try {
      if ((req as any).user?.role !== 'authority') {
        res.status(403).json({ success: false, message: 'Access denied for your role' });
        return;
      }
      const reels = await assignedReelsForAuthority((req as any).user.id);
      res.status(200).json({ success: true, data: reels });
    } catch (error) {
      console.error('Assigned reels error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch assigned incidents' });
    }
  }

  // GET /api/reels/feed
  async getFeed(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      const reels = await ReelService.getAllReels(userId);
      res.status(200).json({ success: true, data: reels });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Server Error' });
    }
  }

  // POST /api/reels/upload
  async uploadReel(req: Request, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, message: 'No video file provided' });
        return;
      }

      const { description, username, isAnonymous, latitude, longitude } = req.body;
      const filePath = req.file.path;
      const userId = (req as any).user?.id;

      if (!latitude || !longitude) {
        fs.unlinkSync(filePath);
        res.status(400).json({ success: false, message: 'Location is required to upload a reel. Please enable location services.' });
        return;
      }

      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);

      const newReel = await ReelService.uploadReel(filePath, description, username, userId, isAnonymous === 'true', lat, lng);

      fs.unlinkSync(filePath);

      res.status(201).json({ success: true, data: newReel });
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, message: 'Upload Failed' });
    }
  }

  // POST /api/reels/live
  async startLiveStream(req: Request, res: Response): Promise<void> {
    try {
      const { title, username } = req.body;
      const liveStream = await ReelService.startLiveStream(title, username);
      res.status(201).json({ success: true, data: liveStream });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to start live stream' });
    }
  }

  // POST /api/reels/:id/like
  async likeReel(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      const reelId = req.params.id as string;

      // Enforce distance check: must be within 3.5 miles
      if (userId) {
        const canInteract = await ReelService.checkCanInteract(userId, reelId);
        if (!canInteract) {
          res.status(403).json({ success: false, message: 'Too far away to like this reel' });
          return;
        }
      }

      const reel = await ReelService.likeReel(reelId, userId);
      res.status(200).json({ success: true, data: reel });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to like reel' });
    }
  }

  // POST /api/reels/:id/view
  async viewReel(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      const reel = await ReelService.viewReel(req.params.id as string, userId);
      res.status(200).json({ success: true, data: reel });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to view reel' });
    }
  }

  // GET /api/reels/:id/comments
  async getComments(req: Request, res: Response): Promise<void> {
    try {
      const comments = await ReelService.getComments(req.params.id as string);
      res.status(200).json({ success: true, data: comments });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch comments' });
    }
  }

  // POST /api/reels/:id/comments
  async addComment(req: Request, res: Response): Promise<void> {
    try {
      const { username, text } = req.body;
      if (!username || !text) {
        res.status(400).json({ success: false, message: 'username and text are required' });
        return;
      }

      // Enforce distance check: must be within 3.5 miles
      const userId = (req as any).user?.id;
      const reelId = req.params.id as string;
      if (userId) {
        const canInteract = await ReelService.checkCanInteract(userId, reelId);
        if (!canInteract) {
          res.status(403).json({ success: false, message: 'Too far away to comment on this reel' });
          return;
        }
      }

      const comment = await ReelService.addComment(reelId, username, text);
      res.status(201).json({ success: true, data: comment });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to add comment' });
    }
  }

  // POST /api/reels/:id/comments/video
  async addVideoComment(req: Request, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, message: 'No video file provided' });
        return;
      }

      const { username } = req.body;
      const filePath = req.file.path;
      const reelId = req.params.id as string;

      // Enforce distance check: must be within 3.5 miles
      const userId = (req as any).user?.id;
      if (userId) {
        const canInteract = await ReelService.checkCanInteract(userId, reelId);
        if (!canInteract) {
          fs.unlinkSync(filePath);
          res.status(403).json({ success: false, message: 'Too far away to comment on this reel' });
          return;
        }
      }

      const comment = await ReelService.addVideoComment(reelId, username, filePath);

      fs.unlinkSync(filePath);

      res.status(201).json({ success: true, data: comment });
    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, message: 'Failed to add video comment' });
    }
  }

  // PATCH /api/reels/:id/resolve
  async resolveReel(req: Request, res: Response): Promise<void> {
    try {
      const { resolution } = req.body;
      if (resolution !== 'attended' && resolution !== 'false_report' && resolution !== 'pending') {
        res.status(400).json({ success: false, message: 'resolution must be "attended", "false_report", or "pending"' });
        return;
      }
      const reel = await ReelService.resolveReel(req.params.id as string, resolution);
      res.status(200).json({ success: true, data: reel });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message || 'Failed to resolve reel' });
    }
  }

  // GET /api/reels/analytics
  async getAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const analytics = await ReelService.getAnalytics();
      res.status(200).json({ success: true, data: analytics });
    } catch (error) {
      console.error('Analytics error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
    }
  }

  // GET /api/reels/jurisdiction?lga=<optional>&authorityId=<optional>&adminId=<optional>
  // Jurisdiction-scoped dashboard data for Super Admins / Admins.
  async getJurisdictionDashboard(req: Request, res: Response): Promise<void> {
    try {
      const role = (req as any).user?.role;
      if (!['superadmin', 'admin'].includes(role)) {
        res.status(403).json({ success: false, message: 'Access denied for your role' });
        return;
      }

      const account = await User.findById((req as any).user.id)
        .select('jurisdiction region location role')
        .lean();

      const jurisdiction: any = account?.jurisdiction || {};
      // Admins are hard-scoped to the LGA they were onboarded for;
      // Super Admins may freely pick any LGA within their state.
      const lgaParam =
        role === 'admin'
          ? jurisdiction.lga || undefined
          : typeof req.query.lga === 'string'
            ? req.query.lga
            : undefined;

      let fallbackCenter: [number, number] | null = null;
      const loc = account?.location?.coordinates;
      if (loc && loc.length >= 2) fallbackCenter = [loc[1], loc[0]];

      // Super Admin → optionally narrow the whole dashboard to a specific
      // Local Admin under them (scope matches that admin's state + LGA).
      const adminId = typeof req.query.adminId === 'string' ? req.query.adminId : undefined;
      let scopeOverride: { country?: string; state?: string; lga?: string } | null = null;
      if (role === 'superadmin' && adminId) {
        const subordinates = await getSubordinateUsers(account as any);
        const targetAdmin = subordinates.find((a) => String(a._id) === adminId);
        if (!targetAdmin) {
          res.status(400).json({ success: false, message: 'Unknown or unauthorized Local Admin' });
          return;
        }
        scopeOverride = {
          country: (targetAdmin as any).jurisdiction?.country || jurisdiction.country,
          state: (targetAdmin as any).jurisdiction?.state || jurisdiction.state,
          lga: (targetAdmin as any).jurisdiction?.lga || undefined,
        };
      }

      // Local Admin → optionally narrow everything to a specific authority
      // responder under them (only that responder's reports are shown).
      const authorityId =
        typeof req.query.authorityId === 'string' ? req.query.authorityId : undefined;
      if (role === 'admin' && authorityId) {
        const subordinates = await getSubordinateUsers(account as any);
        if (!subordinates.some((s) => String(s._id) === authorityId)) {
          res.status(400).json({ success: false, message: 'Unknown or unauthorized Authority Responder' });
          return;
        }
      }

      const scope = scopeOverride || {
        country: jurisdiction.country,
        state: jurisdiction.state,
        lga: lgaParam,
      };

      const data = await ReelService.getJurisdictionDashboard({
        country: scope.country,
        state: scope.state,
        lga: scope.lga,
        fallbackCenter,
        authorityId: role === 'admin' ? authorityId : undefined,
      });

      res.status(200).json({ success: true, data });
    } catch (error) {
      console.error('Jurisdiction dashboard error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch jurisdiction dashboard' });
    }
  }
}

export default new ReelController();
