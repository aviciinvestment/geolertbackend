import { Router, Request, Response } from 'express';
import Reel from '../models/Reel';
import ReelService from '../services/reel.service';
import { isIncidentCategory, classifyIncidentText } from '../data/incidentCategories';
import { assignIncidentToAuthorities } from '../services/incident.service';

const router = Router();

router.post('/analyze', async (req: Request, res: Response) => {
  const { videoUrl } = req.body;
  if (!videoUrl) {
    res.status(400).json({ error: 'videoUrl is required' });
    return;
  }

  try {
    console.log('[Gemini] Analyzing video:', videoUrl.substring(0, 80));
    const result = await ReelService.analyzeVideo(videoUrl);
    console.log('[Gemini] Done. Severity:', result.severity);
    res.json(result);
  } catch (err: any) {
    console.error('[Gemini] Analysis error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

router.post('/batch-analyze', async (_req: Request, res: Response) => {
  try {
    const unanalyzed = await Reel.find({
      $or: [
        { aiAnalysis: { $exists: false } },
        { 'aiAnalysis.summary': '' },
        { severity: { $exists: false } },
      ],
      url: { $ne: '' },
    }).limit(20);

    console.log(`[Gemini Batch] Found ${unanalyzed.length} reels to analyze`);

    let analyzed = 0;
    let failed = 0;
    const errors: { id: string; url: string; error: string }[] = [];

    for (const reel of unanalyzed) {
      try {
        console.log(`[Gemini Batch] Analyzing reel ${reel._id} (${reel.url.substring(0, 80)})...`);
        const result = await ReelService.analyzeVideo(reel.url);

        const category = isIncidentCategory(result.category)
          ? result.category
          : classifyIncidentText(`${result.summary}\n${result.description}\n${result.severityReason}`);

        const updated = await Reel.findByIdAndUpdate(reel._id, {
          aiAnalysis: {
            summary: result.summary,
            transcript: result.transcript,
            description: result.description,
            severityReason: result.severityReason,
          },
          severity: result.severity,
          category,
        }, { new: true });

        // Keep assignments in sync with the freshest analysis
        if (updated) {
          try {
            await assignIncidentToAuthorities(updated);
          } catch (err: any) {
            console.error('[Gemini Batch] Incident routing failed (non-fatal):', err?.message || err);
          }
        }

        analyzed++;
        console.log(`[Gemini Batch] Reel ${reel._id} done. Severity: ${result.severity}`);
        if (analyzed < unanalyzed.length) {
          console.log('[Gemini Batch] Waiting 5s before next reel...');
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (err: any) {
        failed++;
        errors.push({ id: String(reel._id), url: reel.url.substring(0, 100), error: err.message });
        console.error(`[Gemini Batch] Reel ${reel._id} failed:`, err.message);
        if (failed < 3) {
          await new Promise(r => setTimeout(r, 10000));
        }
      }
    }

    res.json({ analyzed, failed, total: unanalyzed.length, errors });
  } catch (err: any) {
    console.error('[Gemini Batch] Error:', err);
    res.status(500).json({ error: err.message || 'Batch analysis failed' });
  }
});

export default router;
