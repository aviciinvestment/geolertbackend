import Reel, { IReel } from '../models/Reel';
import { User } from '../models/User';
import View from '../models/View';
import Comment, { IComment } from '../models/Comment';
import cloudinary from '../utils/cloudinary';
import { io } from '../server';

export class ReelService {
  /**
   * Fetch all reels sorted by newest first, with live avatar from User
   * Filters by user's location (within 30 miles) if userId is provided.
   * Returns canInteract=true if reel is within 3.5 miles (full access: like + comment).
   * Between 3.5–30 miles: view + share only.
   */
  async getAllReels(userId?: string): Promise<any[]> {
    let reels: any[] = [];
    const maxDistanceMeters = 48280.3; // 30 miles
    const interactThresholdMeters = 5632.7; // 3.5 miles

    if (userId) {
      const user = await User.findById(userId);
      if (user && user.location && user.location.coordinates) {
        reels = await Reel.aggregate([
          {
            $geoNear: {
              near: {
                type: 'Point',
                coordinates: user.location.coordinates as [number, number]
              },
              distanceField: 'distance',
              maxDistance: maxDistanceMeters,
              spherical: true
            }
          },
          { $sort: { createdAt: -1 } }
        ]);

        // Add distanceMiles, canInteract and isLikedByMe to the results
        reels = reels.map(reel => ({
          ...reel,
          distanceMiles: Number((reel.distance / 1609.34).toFixed(1)),
          canInteract: reel.distance < interactThresholdMeters,
          isLikedByMe: reel.likedBy ? reel.likedBy.some((id: any) => String(id) === userId) : false
        }));
      } else {
        // No location set: show all reels with canInteract=true (best effort)
        reels = await Reel.find().sort({ createdAt: -1 }).lean();
        reels = reels.map(reel => ({ 
          ...reel, 
          distanceMiles: undefined, 
          canInteract: true,
          isLikedByMe: reel.likedBy ? reel.likedBy.some((id: any) => String(id) === userId) : false
        }));
      }
    } else {
      reels = await Reel.find().sort({ createdAt: -1 }).lean();
      reels = reels.map(reel => ({ 
        ...reel, 
        distanceMiles: undefined, 
        canInteract: true,
        isLikedByMe: false 
      }));
    }

    // Collect unique userIds to batch-fetch current avatars
    const userIds = [...new Set(reels.filter(r => r.userId).map(r => String(r.userId)))];
    if (userIds.length === 0) return reels;

    const users = await User.find({ _id: { $in: userIds } }).select('name avatar').lean();
    const userMap = new Map(users.map(u => [String(u._id), u]));

    return reels.map(reel => {
      if (reel.userId) {
        const u = userMap.get(String(reel.userId));
        if (u) {
          return {
            ...reel,
            avatar: u.avatar || reel.avatar,
            username: reel.isAnonymous ? 'Anonymous' : u.name,
          };
        }
      }
      return reel;
    });
  }

  /**
   * Upload a video to Cloudinary and create a Reel record
   */
  async uploadReel(filePath: string, description: string, username: string = 'new_creator', userId?: string, isAnonymous: boolean = false, lat?: number, lng?: number): Promise<IReel> {
    try {
      const result = await cloudinary.uploader.upload(filePath, {
        resource_type: 'video',
        folder: 'geolert_reels'
      });

      let avatarUrl = `https://i.pravatar.cc/150?u=${username}`;
      let displayName = username;

      // Fetch real user data if userId is provided
      if (userId) {
        const user = await User.findById(userId);
        if (user) {
          avatarUrl = user.avatar || avatarUrl;
          displayName = isAnonymous ? 'Anonymous' : user.name;
        }
      }

      const reelData: any = {
        url: result.secure_url,
        description,
        username: displayName,
        avatar: isAnonymous ? 'https://i.pravatar.cc/150?u=anonymous' : avatarUrl,
        userId: userId || null,
        isAnonymous,
      };

      if (lat !== undefined && lng !== undefined) {
        reelData.location = {
          type: 'Point',
          coordinates: [lng, lat]
        };
      }

      const newReel = new Reel(reelData);

      await newReel.save();
      io.emit('new_reel', newReel);

      return newReel;
    } catch (error) {
      console.error('Error in ReelService.uploadReel:', error);
      throw error;
    }
  }

  /**
   * Start a simulated live stream
   */
  async startLiveStream(title: string, username: string = 'live_creator'): Promise<IReel> {
    const liveStream = new Reel({
      url: '',
      description: title,
      username,
      avatar: `https://i.pravatar.cc/150?u=${username}`,
      isLive: true,
      viewers: Math.floor(Math.random() * 100) + 10
    });

    await liveStream.save();
    io.emit('new_reel', liveStream);

    return liveStream;
  }

  /**
   * Check if a user can interact (like/comment) with a reel based on distance.
   * Returns true if within 3.5 miles.
   */
  async checkCanInteract(userId: string, reelId: string): Promise<boolean> {
    const user = await User.findById(userId);
    if (!user || !user.location || !user.location.coordinates) return true; // no location = allow

    const reel = await Reel.findById(reelId);
    if (!reel || !reel.location || !reel.location.coordinates) return true; // no location = allow

    // Calculate distance using MongoDB geo query
    const result = await Reel.aggregate([
      {
        $geoNear: {
          near: {
            type: 'Point',
            coordinates: user.location.coordinates as [number, number]
          },
          distanceField: 'distance',
          maxDistance: 5632.7, // 3.5 miles
          spherical: true
        }
      },
      { $match: { _id: reel._id } },
      { $limit: 1 }
    ]);

    return result.length > 0;
  }

  /**
   * Increment the like count on a reel
   */
  async likeReel(reelId: string, userId?: string): Promise<IReel> {
    const reel = await Reel.findById(reelId);
    if (!reel) throw new Error('Reel not found');

    if (userId) {
      if (!reel.likedBy.includes(userId as any)) {
        reel.likedBy.push(userId as any);
        reel.likes += 1;
        await reel.save();
      }
    } else {
      // anonymous like
      reel.likes += 1;
      await reel.save();
    }
    
    return reel;
  }

  /**
   * Record a distinct view (one per user per reel)
   */
  async viewReel(reelId: string, userId: string): Promise<IReel> {
    // Try to create a view record — duplicate will throw due to unique index
    try {
      await View.create({ reelId, userId });
      const reel = await Reel.findByIdAndUpdate(
        reelId,
        { $inc: { views: 1 } },
        { new: true }
      );
      if (!reel) throw new Error('Reel not found');
      return reel;
    } catch (err: any) {
      // Duplicate key = already viewed, just return current reel without incrementing
      if (err.code === 11000) {
        const reel = await Reel.findById(reelId);
        if (!reel) throw new Error('Reel not found');
        return reel;
      }
      throw err;
    }
  }

  /**
   * Get all comments for a reel
   */
  async getComments(reelId: string): Promise<IComment[]> {
    return Comment.find({ reelId }).sort({ createdAt: 1 });
  }

  /**
   * Add a text comment to a reel
   */
  async addComment(reelId: string, username: string, text: string): Promise<IComment> {
    const reel = await Reel.findById(reelId);
    if (!reel) throw new Error('Reel not found');

    const comment = new Comment({
      reelId,
      username,
      avatar: `https://i.pravatar.cc/150?u=${username}`,
      text
    });

    await comment.save();

    await Reel.findByIdAndUpdate(reelId, { $inc: { comments: 1 } });

    io.emit('new_comment', { reelId, comment });

    return comment;
  }

  /**
   * Add a video comment to a reel
   */
  async addVideoComment(reelId: string, username: string, filePath: string): Promise<IComment> {
    const reel = await Reel.findById(reelId);
    if (!reel) throw new Error('Reel not found');

    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: 'video',
      folder: 'geolert_video_comments'
    });

    const comment = new Comment({
      reelId,
      username,
      avatar: `https://i.pravatar.cc/150?u=${username}`,
      text: '',
      videoUrl: result.secure_url
    });

    await comment.save();

    await Reel.findByIdAndUpdate(reelId, { $inc: { comments: 1 } });

    io.emit('new_comment', { reelId, comment });

    return comment;
  }
}

export default new ReelService();
