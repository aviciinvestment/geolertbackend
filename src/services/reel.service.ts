import Reel, { IReel } from '../models/Reel';
import { User } from '../models/User';
import View from '../models/View';
import Comment, { IComment } from '../models/Comment';
import cloudinary from '../utils/cloudinary';
import { io } from '../server';
import { reverseGeocode, geocodePlace, expandRegionName, expandLgaName } from './geo.service';
import { getAreaList, getAreaCoords, isKnownLga } from './lga.service';
import { isIncidentCategory, classifyIncidentText } from '../data/incidentCategories';
import { assignIncidentToAuthorities } from './incident.service';

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
    category: string;
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
  "severityReason": "Explain in 2-3 sentences why this rating. Address danger, urgency.",
  "category": "Pick ONE from: fire, medical, police, rescue, flood, gas_hazard, traffic, building_collapse, general"
}

Severity scale:
0.0-0.2 = Very mild, 0.3-0.4 = Low, 0.5-0.6 = Moderate, 0.7-0.8 = High (danger/crime/disaster), 0.9-1.0 = Critical (life-threatening)
category: "fire" for fire/smoke/burning, "medical" for injuries/sickness/medical emergencies, "police" for crime/violence/security, "rescue" for people trapped/stranded/entrapped, "flood" for water/flooding, "gas_hazard" for gas/chemical/toxic leaks, "traffic" for road accidents/collisions, "building_collapse" for structural collapse, otherwise "general".
Return ONLY the JSON object.`
    );

    let summary = '', transcript = '', description = '', severityReason = '', category = 'general';
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
      category = typeof parsed.category === 'string' ? parsed.category.toLowerCase() : 'general';
      if (!isIncidentCategory(category)) {
        // AI returned an off-list value → keyword fallback over its own text
        category = classifyIncidentText(`${description}\n${summary}\n${severityReason}`);
      }
    } catch {
      summary = result;
      severity = 0;
      category = classifyIncidentText(result);
    }

    return { summary, transcript, description, severity, severityReason, category };
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
        analysis = { summary: '', transcript: '', description: '', severity: 0, severityReason: '', category: 'general' };
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

      // Step 4: Resolve administrative region (country / state / LGA / area)
      let region: { country?: string; state?: string; lga?: string; area?: string } | undefined;
      try {
        region = (await reverseGeocode(lat, lng)) || undefined;
      } catch {
        region = undefined;
      }

      // Step 5: Save reel WITH analysis already attached
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
        category: isIncidentCategory(analysis.category)
          ? analysis.category
          : classifyIncidentText(`${analysis.summary}\n${analysis.description}\n${analysis.severityReason}`),
        region: region || {},
        regionTagged: true,
      };

      const newReel = new Reel(reelData);
      await newReel.save();

      console.log(`[Upload] Reel saved with analysis. Severity: ${analysis.severity}`);

      // Route to the Authority Responders who should respond, within their
      // jurisdiction + specialization. Never blocks the upload on failure.
      try {
        await assignIncidentToAuthorities(newReel);
      } catch (err: any) {
        console.error('[Upload] Incident routing failed (non-fatal):', err?.message || err);
      }

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
        category: isIncidentCategory(analysis.category)
          ? analysis.category
          : classifyIncidentText(`${analysis.summary}\n${analysis.description}\n${analysis.severityReason}`),
      }, { new: true });

      if (updated) {
        // Re-route so assignments stay in sync with the freshest analysis
        try {
          await assignIncidentToAuthorities(updated);
        } catch (err: any) {
          console.error('[AutoAnalyze] Incident routing failed (non-fatal):', err?.message || err);
        }

        io.emit('reel_analysis_updated', {
          _id: updated._id,
          aiAnalysis: updated.aiAnalysis,
          severity: updated.severity,
          category: updated.category,
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
  async getAnalytics(): Promise<any> {    const reels = await Reel.find({}).select('severity status createdAt userId').lean();

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

  // ---- Region backfill (background job) ----
  private backfillRunning = false;
  private lastBackfillKickAt = 0;
  private failedTagAttempts = new Map<string, number>();

  /**
   * Reverse-geocode every reel that has no region tags yet.
   * Runs in the BACKGROUND (never awaited by request handlers) in throttled
   * batches so legacy reports become jurisdiction-scoped over time without
   * ever blocking an API response.
   */
  async ensureRegionsBackfilled(force: boolean = false): Promise<void> {
    const now = Date.now();
    if (this.backfillRunning) return;
    if (!force && now - this.lastBackfillKickAt < 30_000) return;

    this.backfillRunning = true;
    this.lastBackfillKickAt = now;

    try {
      const BATCH = 8;
      let processed = 0;

      while (processed < 400) {
        // Re-tag anything untagged OR tagged before neighborhood (area)
        // resolution existed, so legacy reports gain their area label.
        const candidates = await Reel.find({
          $or: [{ regionTagged: { $ne: true } }, { 'region.area': { $exists: false } }],
        })
          .select('location')
          .sort({ createdAt: -1 })
          .limit(BATCH * 3)
          .lean();

        const batch = candidates
          .filter((r) => (this.failedTagAttempts.get(String(r._id)) ?? 0) < 3)
          .slice(0, BATCH);

        if (batch.length === 0) break;

        await Promise.all(
          batch.map(async (reel) => {
            const coords = reel.location?.coordinates;
            if (!coords || coords.length < 2) {
              await Reel.updateOne({ _id: reel._id }, { $set: { regionTagged: true } });
              return;
            }
            try {
              const region = await reverseGeocode(coords[1], coords[0]);
              if (!region) throw new Error('geocode failed');
              await Reel.updateOne(
                { _id: reel._id },
                {
                  $set: {
                    region: { ...region, area: region.area ?? '' },
                    regionTagged: true,
                  },
                }
              );
              this.failedTagAttempts.delete(String(reel._id));
            } catch {
              const fails = (this.failedTagAttempts.get(String(reel._id)) ?? 0) + 1;
              this.failedTagAttempts.set(String(reel._id), fails);
            }
            processed++;
          })
        );
      }
    } finally {
      this.backfillRunning = false;
    }
  }

  /**
   * Full data payload for the Super Admin jurisdiction dashboard.
   * Everything (stats, charts, map markers, pending table, responders)
   * is scoped to country+state from the admin's jurisdiction, and
   * optionally narrowed further to a single LGA/province.
   *
   * Resilience: reels whose region tags haven't been resolved yet are still
   * included when they fall within a sensible radius of the scope's center,
   * so previously-reported events appear immediately.
   */
  async getJurisdictionDashboard(opts: {
    country?: string;
    state?: string;
    lga?: string;
    fallbackCenter?: [number, number] | null;
    authorityId?: string | null;
  }): Promise<any> {
    const { country, state, lga, authorityId } = opts;
    const hasJurisdiction = Boolean(country && state);
    const selectedLga = lga && lga !== '__all__' ? lga : null;

    // Kick off (non-blocking) region tagging for untagged reports
    this.ensureRegionsBackfilled().catch(() => {});

    // Optional: narrow everything to a single Authority Responder's reports
    const authorityFilter = authorityId ? { userId: authorityId } : {};

    // ---- Tagged scope query ----
    const scopeQuery: Record<string, any> = { ...authorityFilter };
    if (country) scopeQuery['region.country'] = { $in: expandRegionName(country) };
    if (state) scopeQuery['region.state'] = { $in: expandRegionName(state) };
    if (selectedLga) {
      // Match either the LGA name (with geocoder alias variants) or a
      // neighborhood/district (e.g. Gwarinpa)
      scopeQuery.$or = [
        { 'region.lga': { $in: expandLgaName(selectedLga) } },
        { 'region.area': selectedLga },
      ];
    }

    const regionCollation = { locale: 'en', strength: 2 }; // case-insensitive

    const taggedReels = hasJurisdiction
      ? await Reel.find(scopeQuery)
          .collation(regionCollation)
          .select('severity status createdAt location region description url avatar username isAnonymous userId aiAnalysis views likes comments')
          .sort({ createdAt: -1 })
          .limit(2000)
          .lean()
      : // No jurisdiction on the account → show everything
        await Reel.find({ ...authorityFilter })
          .select('severity status createdAt location region description url avatar username isAnonymous userId aiAnalysis views likes comments')
          .sort({ createdAt: -1 })
          .limit(2000)
          .lean();

    // ---- Scope center ----
    // Priority: average of scoped reports -> selected LGA's known coords ->
    // geocoded state -> admin's own location.
    let center: [number, number] | null = null;
    const withCoords = taggedReels.filter((r) => r.location?.coordinates?.length >= 2);
    if (withCoords.length > 0) {
      let latSum = 0;
      let lngSum = 0;
      for (const r of withCoords) {
        latSum += r.location.coordinates[1];
        lngSum += r.location.coordinates[0];
      }
      center = [latSum / withCoords.length, lngSum / withCoords.length];
    } else if (selectedLga) {
      center =
        (await getAreaCoords(country, state, selectedLga)) ??
        (state ? await geocodePlace(`${selectedLga}, ${state}`, country) : null);
    } else if (hasJurisdiction) {
      center = (await geocodePlace(state!, country)) ?? opts.fallbackCenter ?? null;
    } else if (opts.fallbackCenter && opts.fallbackCenter.length === 2) {
      center = opts.fallbackCenter;
    }

    // ---- Coordinate sweep around the scope's center ----
    // Catches every report near the center by longitude/latitude, including
    // legacy ones whose region tags haven't been resolved yet.
    let nearbyReels: any[] = [];
    if (hasJurisdiction && center) {
      // Constitutional LGA → wider sweep; neighborhood/district → tight sweep
      const radiusMeters = selectedLga
        ? isKnownLga(country, state, selectedLga)
          ? 12_000
          : 5_000
        : 60_000;
      try {
        nearbyReels = await Reel.aggregate([
          {
            $geoNear: {
              // GeoJSON requires [longitude, latitude]; `center` is [lat, lng]
              near: { type: 'Point', coordinates: [center[1], center[0]] },
              distanceField: '_distanceM',
              maxDistance: radiusMeters,
              spherical: true,
              query: { 'location.coordinates': { $exists: true }, ...authorityFilter },
            },
          },
          { $limit: 300 },
        ]);
      } catch {
        nearbyReels = [];
      }
    }

    // Merge + de-duplicate (untagged can't overlap tagged by construction,
    // but guard anyway), newest first
    const seen = new Set<string>();
    const reels: any[] = [];
    for (const r of [...taggedReels, ...nearbyReels]) {
      const id = String(r._id);
      if (seen.has(id)) continue;
      seen.add(id);
      reels.push(r);
    }
    reels.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // ---- Headline stats ----
    const realReports = reels.filter((r) => (r.status || 'pending') !== 'false_report');
    const activeEmergencies = realReports.length;
    const catered = realReports.filter((r) => r.status === 'attended').length;
    const uncatered = realReports.filter((r) => !r.status || r.status === 'pending').length;
    const falseReports = reels.length - realReports.length;

    // ---- Severity breakdown (same buckets as the authority map legend) ----
    const severityBreakdown = [
      { name: 'Critical', value: 0, color: '#ef4444' },
      { name: 'High', value: 0, color: '#f97316' },
      { name: 'Medium', value: 0, color: '#eab308' },
      { name: 'Low', value: 0, color: '#22c55e' },
    ];
    for (const r of realReports) {
      const s = r.severity ?? 0;
      if (s >= 0.8) severityBreakdown[0].value++;
      else if (s >= 0.6) severityBreakdown[1].value++;
      else if (s >= 0.4) severityBreakdown[2].value++;
      else severityBreakdown[3].value++;
    }

    // ---- Incident activity (7 daily buckets ending today) ----
    const DAY_MS = 24 * 60 * 60 * 1000;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const activityData: { time: string; incidents: number }[] = [];
    const bucketCounts = new Array(7).fill(0);
    for (const r of realReports) {
      const ageDays = Math.floor(
        (startOfToday.getTime() - new Date(r.createdAt).getTime()) / DAY_MS
      );
      if (ageDays >= 0 && ageDays < 7) {
        bucketCounts[6 - ageDays]++;
      }
    }
    for (let i = 0; i < 7; i++) {
      const d = new Date(startOfToday.getTime() - (6 - i) * DAY_MS);
      activityData.push({
        time: d.toLocaleDateString('en-US', { weekday: 'short' }),
        incidents: bucketCounts[i],
      });
    }

    // ---- Map markers (latest 150 real reports) ----
    type MapReel = {
      _id: any;
      lat: number;
      lng: number;
      severity: number;
      status: string;
      description?: string;
      aiSummary?: string;
      url: string;
      avatar?: string;
      username: string;
      isAnonymous: boolean;
      area?: string;
      createdAt: Date;
      views?: number;
      likes?: number;
      comments?: number;
    };
    const mapReels: MapReel[] = [];
    for (const r of realReports.slice(0, 150)) {
      const coords = r.location?.coordinates;
      if (!coords || coords.length < 2) continue;
      mapReels.push({
        _id: String(r._id),
        lat: coords[1],
        lng: coords[0],
        severity: r.severity ?? 0,
        status: r.status || 'pending',
        description: r.description || '',
        aiSummary: r.aiAnalysis?.summary || '',
        url: r.url,
        avatar: r.avatar,
        username: r.isAnonymous ? 'Anonymous' : r.username,
        isAnonymous: !!r.isAnonymous,
        area:
          (r.region as any)?.area ||
          (r.region as any)?.lga ||
          (r.region as any)?.state ||
          undefined,
        createdAt: r.createdAt,
        views: r.views,
        likes: r.likes,
        comments: r.comments,
      });
    }

    // ---- Pending / uncatered table rows (latest 10) ----
    const pendingEmergencies = mapReels
      .filter((m) => m.status === 'pending')
      .slice(0, 10)
      .map((m) => ({
        id: String(m._id).slice(-6).toUpperCase(),
        reelId: m._id,
        area: m.area,
        lat: m.lat,
        lng: m.lng,
        severity: m.severity,
        reporter: m.username,
        createdAt: m.createdAt,
      }));

    // ---- Areas selector: full LGA/province directory + every place seen
    // in reports (LGAs and neighborhood/district names like Gwarinpa),
    // deduped case-insensitively ----
    let areas: string[] = [];
    if (hasJurisdiction) {
      const scopeBase = {
        'region.country': { $in: expandRegionName(country) },
        'region.state': { $in: expandRegionName(state) },
      };
      const [curatedAreas, taggedLgas, taggedAreas] = await Promise.all([
        getAreaList(country, state),
        Reel.distinct('region.lga', {
          ...scopeBase,
          'region.lga': { $nin: [null, ''] },
        }).collation(regionCollation),
        Reel.distinct('region.area', {
          ...scopeBase,
          'region.area': { $nin: [null, ''] },
        }).collation(regionCollation),
      ]);
      const byNorm = new Map<string, string>();
      for (const area of [
        ...(curatedAreas ?? []),
        ...(taggedLgas as string[]).map(String),
        ...(taggedAreas as string[]).map(String),
      ]) {
        const normArea = area.trim().toLowerCase().replace(/\s+/g, ' ');
        if (normArea && !byNorm.has(normArea)) byNorm.set(normArea, area);
      }
      areas = [...byNorm.values()].sort((a, b) => a.localeCompare(b));
    }

    // ---- Responders deployed (approved authority users in scope) ----
    const responderQuery: Record<string, any> = {
      role: 'authority',
      authorizationStatus: 'approved',
    };
    if (country) responderQuery['region.country'] = { $in: expandRegionName(country) };
    if (state) responderQuery['region.state'] = { $in: expandRegionName(state) };
    if (selectedLga) responderQuery['region.lga'] = { $in: expandLgaName(selectedLga) };
    const respondersDeployed = hasJurisdiction
      ? await User.countDocuments(responderQuery).collation(regionCollation)
      : await User.countDocuments({ role: 'authority', authorizationStatus: 'approved' });

    // ---- Every scoped report (all statuses) with its full AI analysis ----
    type ReportRow = {
      _id: any;
      status: string;
      severity: number;
      description?: string;
      aiAnalysis?: any;
      url: string;
      avatar?: string;
      username: string;
      isAnonymous: boolean;
      area?: string;
      lga?: string;
      state?: string;
      latitude: number;
      longitude: number;
      userId?: string;
      createdAt: Date;
      views?: number;
      likes?: number;
      comments?: number;
    };
    const reports: ReportRow[] = [];
    for (const r of reels.slice(0, 1000)) {
      const coords = r.location?.coordinates;
      if (!coords || coords.length < 2) continue;
      const region = r.region as any;
      reports.push({
        _id: String(r._id),
        status: r.status || 'pending',
        severity: r.severity ?? 0,
        description: r.description || '',
        aiAnalysis: r.aiAnalysis || null,
        url: r.url,
        avatar: r.avatar,
        username: r.isAnonymous ? 'Anonymous' : r.username,
        isAnonymous: !!r.isAnonymous,
        area: region?.area || undefined,
        lga: region?.lga || undefined,
        state: region?.state || undefined,
        latitude: coords[1],
        longitude: coords[0],
        userId: r.userId ? String(r.userId) : undefined,
        createdAt: r.createdAt,
        views: r.views,
        likes: r.likes,
        comments: r.comments,
      });
    }

    return {
      scope: { country: country ?? null, state: state ?? null, lga: lga && lga !== '__all__' ? lga : null },
      areas,
      stats: { activeEmergencies, catered, uncatered, falseReports, respondersDeployed },
      severityBreakdown,
      activityData,
      mapReels,
      pendingEmergencies,
      reports,
      center,
    };
  }
}

export default new ReelService();
