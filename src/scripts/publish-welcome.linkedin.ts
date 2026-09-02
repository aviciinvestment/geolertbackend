/**
 * One-off publisher for the brand's LinkedIn page welcome post.
 * Run from server/:  npx tsx src/scripts/publish-welcome.linkedin.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { publishWelcomePost, resolveAuthorUrn } from '../services/linkedin.service';

const WELCOME_TEXT = [
  'Welcome to the official LinkedIn page of Achiv Apps — home of GeoLert.',
  '',
  'GeoLert turns everyday witnesses into first responders. When someone records an emergency on the GeoLert app, our AI analyzes the footage in seconds, classifies the incident, flags its severity, pins the exact location, and alerts the right responders in the area.',
  '',
  'On this page, we will publish verified community incident alerts as they are flagged by our system — starting with high-severity events that need extra public awareness — alongside safety tips and platform updates.',
  '',
  'Follow us to stay informed, stay prepared, and help build safer communities.',
  '',
  '#AchivApps #GeoLert #CommunitySafety #EmergencyResponse',
].join('\n');

async function main(): Promise<void> {
  const target = await resolveAuthorUrn();
  console.log(`[LinkedIn] Target author: ${target.label}`);

  const result = await publishWelcomePost(WELCOME_TEXT);
  console.log('');
  console.log('[LinkedIn] Welcome post published successfully.');
  console.log(`  Post URL : ${result.feedUrl}`);
  console.log(`  Post ID  : ${result.postId}`);
  console.log(`  Author   : ${result.author}`);
}

main().catch((err: any) => {
  console.error('[LinkedIn] Welcome post failed:', err?.message || err);
  process.exit(1);
});