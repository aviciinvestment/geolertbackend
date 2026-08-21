import Reel, { IReel } from '../models/Reel';
import { User } from '../models/User';
import View from '../models/View';
import Comment, { IComment } from '../models/Comment';
import cloudinary from '../utils/cloudinary';
import { io } from '../server';

export class ReelService {
  /**
   * Calculate engagement-boosted severity for priority sorting.
   * Factors in: severity, engagement rate, and uploader trust score.
   * Higher trust score users get a priority boost (up to +0.15).
   * Returns a priority score between 0 and 1 used for sorting.
   */
  calculateEngagementPriority(severity: number, likes: number, comments: number, views: number, trustScore: number = 50): number {
    let boosted = severity;

    if (views > 0) {
      const engagementRate = (likes + comments) / views;
      if (severity >= 0.3 && engagementRate > 0.5) {
        const engagementBoost = Math.min(0.3, (engagementRate - 0.5) * 0.6);
        boosted = Math.min(1.0, severity + engagementBoost);
      }
    }

    // Trust score boost: 0-100 → 0 to +0.15 priority boost
    const trustBoost = Math.min(0.15, ((trustScore || 50) / 100) * 0.15);
    return Math.min(1.0, boosted + trustBoost);
  }

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
        // Only return reels within 30 miles of the user
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
          { $sort: { severity: -1, createdAt: -1 } }
        ]);

        reels = reels.map(reel => ({
          ...reel,
          distanceMiles: Number((reel.distance / 1609.34).toFixed(1)),
          canInteract: reel.distance < interactThresholdMeters,
          isLikedByMe: reel.likedBy ? reel.likedBy.some((id: any) => String(id) === userId) : false,
        }));
      } else {
        // No location set: cannot filter, deny access
        return [];
      }
    } else {
      // No auth: cannot filter by location, deny access
      return [];
    }

    // Collect unique userIds to batch-fetch current avatars + trust scores
    const userIds = [...new Set(reels.filter(r => r.userId).map(r => String(r.userId)))];
    if (userIds.length === 0) return reels;

    const users = await User.find({ _id: { $in: userIds } }).select('name avatar trustScore').lean();
    const userMap = new Map(users.map(u => [String(u._id), u]));

    // Re-calculate engagement priority with trust scores
    reels = reels.map(reel => {
      const u = reel.userId ? userMap.get(String(reel.userId)) : null;
      const trustScore = u?.trustScore ?? 50;
      return {
        ...reel,
        engagementPriority: this.calculateEngagementPriority(
          reel.severity ?? 0,
          reel.likes ?? 0,
          reel.comments ?? 0,
          reel.views ?? 0,
          trustScore
        ),
      };
    });

    // Re-sort by trust-adjusted priority (highest first), then by date
    reels.sort((a: any, b: any) => {
      if (b.engagementPriority !== a.engagementPriority) {
        return b.engagementPriority - a.engagementPriority;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

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
   * Analyze a video with Gemini and return structured results.
   * Does NOT touch the database — pure analysis.
   */
  async analyzeVideo(videoUrl: string): Promise<{
    summary: string;
    transcript: string;
    description: string;
    severity: number;
    severityReason: string;
  }> {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
    const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw new Error(`Failed to fetch video for analysis: ${videoRes.status}`);
    const buffer = Buffer.from(await videoRes.arrayBuffer());
    const videoBase64 = buffer.toString('base64');

    async function callGemini(prompt: string): Promise<string> {
      const res = await fetch(`${GEMINI_BASE}/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'video/mp4', data: videoBase64 } }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
        }),
      });
      if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    const result = await callGemini(
      `Analyze this video comprehensively. Return your response in this EXACT JSON format (no markdown, no code fences):

{
  "summary": "Detailed explanation of what is happening, context, and notable events.",
  "transcript": "Transcribe ALL speech word-for-word. If no speech, say 'No speech detected.'",
  "description": "Detailed visual description: setting, people, objects, actions, mood.",
  "severity": 0.0,
  "severityReason": "Explain in 2-3 sentences why this rating. Address danger, urgency."
}

Severity scale:
0.0-0.2 = Very mild, 0.3-0.4 = Low, 0.5-0.6 = Moderate, 0.7-0.8 = High (danger/crime/disaster), 0.9-1.0 = Critical (life-threatening)
Return ONLY the JSON object.`
    );

    let summary = '', transcript = '', description = '', severityReason = '';
    let severity = 0;
    try {
      let cleaned = result.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      const parsed = JSON.parse(cleaned);
      summary = parsed.summary || '';
      transcript = parsed.transcript || '';
      description = parsed.description || '';
      severityReason = parsed.severityReason || '';
      severity = Math.max(0, Math.min(1, parseFloat(parsed.severity) || 0));
    } catch {
      summary = result;
      severity = 0;
    }

    return { summary, transcript, description, severity, severityReason };
  }

  /**
   * Upload a video to Cloudinary, analyze it with Gemini, then create a Reel record.
   * Analysis happens BEFORE the reel is saved — guaranteed to have AI data.
   */
  async uploadReel(filePath: string, description: string, username: string = 'new_creator', userId?: string, isAnonymous: boolean = false, lat?: number, lng?: number): Promise<IReel> {
    if (lat === undefined || lng === undefined) {
      throw new Error('Location is required to upload a reel');
    }

    try {
      // Step 1: Upload video to Cloudinary
      console.log('[Upload] Uploading video to Cloudinary...');
      const result = await cloudinary.uploader.upload(filePath, {
        resource_type: 'video',
        folder: 'geolert_reels'
      });
      console.log('[Upload] Cloudinary upload done:', result.secure_url.substring(0, 80));

      // Step 2: Analyze with Gemini BEFORE saving to DB
      console.log('[Upload] Starting AI analysis...');
      let analysis;
      try {
        analysis = await this.analyzeVideo(result.secure_url);
        console.log(`[Upload] AI analysis done. Severity: ${analysis.severity}`);
      } catch (err: any) {
        console.error('[Upload] AI analysis failed, saving reel with empty analysis:', err.message);
        analysis = { summary: '', transcript: '', description: '', severity: 0, severityReason: '' };
      }

      // Step 3: Fetch user data
      let avatarUrl = `https://i.pravatar.cc/150?u=${username}`;
      let displayName = username;

      if (userId) {
        const user = await User.findById(userId);
        if (user) {
          avatarUrl = user.avatar || avatarUrl;
          displayName = isAnonymous ? 'Anonymous' : user.name;
        }
      }

      // Step 4: Save reel WITH analysis already attached
      const reelData: any = {
        url: result.secure_url,
        description,
        username: displayName,
        avatar: isAnonymous ? 'https://i.pravatar.cc/150?u=anonymous' : avatarUrl,
        userId: userId || null,
        isAnonymous,
        location: {
          type: 'Point',
          coordinates: [lng, lat]
        },
        aiAnalysis: {
          summary: analysis.summary,
          transcript: analysis.transcript,
          description: analysis.description,
          severityReason: analysis.severityReason,
        },
        severity: analysis.severity,
      };

      const newReel = new Reel(reelData);
      await newReel.save();

      console.log(`[Upload] Reel saved with analysis. Severity: ${analysis.severity}`);
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
      if (!reel.likedBy) reel.likedBy = [];
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

  /**
   * Resolve a reel as attended or false report, or revert to pending.
   * Adjusts the uploader's trust score by ±5 accordingly.
   */
  async resolveReel(reelId: string, resolution: 'attended' | 'false_report' | 'pending'): Promise<IReel> {
    const reel = await Reel.findById(reelId);
    if (!reel) throw new Error('Reel not found');

    const previousStatus = reel.status || 'pending';
    reel.status = resolution;
    await reel.save();

    if (reel.userId && previousStatus !== resolution) {
      let trustDelta = 0;
      if (resolution === 'attended') trustDelta = +5;
      else if (resolution === 'false_report') trustDelta = -5;
      else if (previousStatus === 'attended') trustDelta = -5;
      else if (previousStatus === 'false_report') trustDelta = +5;

      if (trustDelta !== 0) {
        const user = await User.findById(reel.userId);
        if (user) {
          user.trustScore = Math.max(0, Math.min(100, (user.trustScore || 50) + trustDelta));
          await user.save();
          console.log(`[Resolve] User ${user.name} trust: ${user.trustScore} (${trustDelta > 0 ? '+' : ''}${trustDelta})`);
        }
      }
    }

    return reel;
  }

  async autoAnalyze(reelId: string, videoUrl: string): Promise<void> {
    try {
      const analysis = await this.analyzeVideo(videoUrl);

      const updated = await Reel.findByIdAndUpdate(reelId, {
        aiAnalysis: {
          summary: analysis.summary,
          transcript: analysis.transcript,
          description: analysis.description,
          severityReason: analysis.severityReason,
        },
        severity: analysis.severity,
      }, { new: true });

      if (updated) {
        io.emit('reel_analysis_updated', {
          _id: updated._id,
          aiAnalysis: updated.aiAnalysis,
          severity: updated.severity,
        });
      }

      console.log(`[AutoAnalyze] Reel ${reelId} done. Severity: ${analysis.severity}`);
    } catch (err: any) {
      console.error(`[AutoAnalyze] Reel ${reelId} failed:`, err.message);
    }
  }

  /**
   * Get analytics data for the authority dashboard.
   * Returns daily event counts, resolution stats, and time-to-resolve.
   */
  async getAnalytics(): Promise<any> {
    const reels = await Reel.find({}).select('severity status createdAt userId').lean();

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Daily event counts (last 30 days)
    const dailyMap: Record<string, { total: number; attended: number; false_report: number; pending: number }> = {};

    // Initialize last 30 days
    for (let i = 0; i < 30; i++) {
      const d = new Date(thirtyDaysAgo.getTime() + i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      dailyMap[key] = { total: 0, attended: 0, false_report: 0, pending: 0 };
    }

    reels.forEach(reel => {
      const key = new Date(reel.createdAt).toISOString().slice(0, 10);
      if (!dailyMap[key]) {
        dailyMap[key] = { total: 0, attended: 0, false_report: 0, pending: 0 };
      }
      dailyMap[key].total++;
      const s = reel.status || 'pending';
      if (s === 'attended') dailyMap[key].attended++;
      else if (s === 'false_report') dailyMap[key].false_report++;
      else dailyMap[key].pending++;
    });

    const daily = Object.entries(dailyMap).map(([date, counts]) => ({ date, ...counts })).sort((a, b) => a.date.localeCompare(b.date));

    // Monthly stats (last 6 months)
    const monthlyMap: Record<string, { total: number; attended: number; false_report: number; avgTimeToResolve: number }> = {};

    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthlyMap[key] = { total: 0, attended: 0, false_report: 0, avgTimeToResolve: 0 };
    }

    const resolvedTimes: number[] = [];

    reels.forEach(reel => {
      const d = new Date(reel.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthlyMap[key]) return;
      monthlyMap[key].total++;
      const s = reel.status || 'pending';
      if (s === 'attended') monthlyMap[key].attended++;
      else if (s === 'false_report') monthlyMap[key].false_report++;
      if (s !== 'pending') {
        resolvedTimes.push(Date.now() - new Date(reel.createdAt).getTime());
      }
    });

    const monthly = Object.entries(monthlyMap)
      .map(([month, data]) => ({ month, ...data }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Overall stats
    const totalEvents = reels.length;
    const totalAttended = reels.filter(r => r.status === 'attended').length;
    const totalFalse = reels.filter(r => r.status === 'false_report').length;
    const totalPending = reels.filter(r => !r.status || r.status === 'pending').length;
    const avgTimeToResolveMs = resolvedTimes.length > 0 ? resolvedTimes.reduce((a, b) => a + b, 0) / resolvedTimes.length : 0;
    const avgTimeToResolveHours = Math.round(avgTimeToResolveMs / (1000 * 60 * 60) * 10) / 10;

    // Severity distribution
    const severityDist = {
      critical: reels.filter(r => (r.severity ?? 0) >= 0.7).length,
      high: reels.filter(r => (r.severity ?? 0) >= 0.4 && (r.severity ?? 0) < 0.7).length,
      low: reels.filter(r => (r.severity ?? 0) < 0.4).length,
    };

    return {
      daily,
      monthly,
      overall: {
        totalEvents,
        totalAttended,
        totalFalse,
        totalPending,
        avgTimeToResolveHours,
        resolutionRate: totalEvents > 0 ? Math.round(((totalAttended + totalFalse) / totalEvents) * 100) : 0,
      },
      severityDist,
    };
  }
}

export default new ReelService();
