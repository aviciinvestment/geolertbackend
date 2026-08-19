import { Request, Response } from 'express';
import ReelService from '../services/reel.service';
import fs from 'fs';

export class ReelController {

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

      const lat = latitude ? parseFloat(latitude) : undefined;
      const lng = longitude ? parseFloat(longitude) : undefined;

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
}

export default new ReelController();
