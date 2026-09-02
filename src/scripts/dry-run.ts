import dotenv from 'dotenv';
dotenv.config();

import { resolveAuthorUrn, buildIncidentCommentary } from '../services/linkedin.service';

async function main(): Promise<void> {
  console.log('[Dry-run] hasLinkedInConfig:', Boolean(process.env.LINKEDIN_ACCESS_TOKEN));

  const target = await resolveAuthorUrn();
  console.log(`[Dry-run] Resolved author: ${target.label} (${target.author})`);

  const sample = {
    _id: 'sample123',
    severity: 0.85,
    category: 'fire',
    description: 'Thick smoke reported rising from a market building.',
    location: { type: 'Point', coordinates: [7.4455, 9.0579] },
    region: { area: 'Karu', lga: 'Abuja Municipal', state: 'FCT - Abuja', country: 'Nigeria' },
    aiAnalysis: {
      summary: 'A large fire is burning inside the main market hall, with flames spreading to nearby stalls and people evacuating in panic.',
    },
  };

  console.log('\n[Dry-run] Curated commentary preview:\n');
  console.log('----------------------------------------');
  console.log(buildIncidentCommentary(sample, 'Karu Market, Karu, Abuja Municipal, Federal Capital Territory, Nigeria'));
  console.log('----------------------------------------');
}

main().catch((err: any) => {
  console.error('[Dry-run] failed:', err?.message || err);
  process.exit(1);
});