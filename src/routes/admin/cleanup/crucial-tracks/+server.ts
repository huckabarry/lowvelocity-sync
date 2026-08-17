import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cleanupCrucialTrackDuplicates } from '$lib/server/crucial-tracks-cleanup';
import { getSyncConfig } from '$lib/server/config';
import { timingSafeStringEqual } from '$lib/server/crypto';

export const POST: RequestHandler = async ({ request, platform }) => {
  const requestId = crypto.randomUUID();
  try {
    const config = getSyncConfig(platform);
    const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
    if (!token || !config.ghostStaffAccessToken || !timingSafeStringEqual(token, config.ghostStaffAccessToken)) return json({ error: 'unauthorized', requestId }, { status: 401 });
    const body = await request.json() as { dryRun?: boolean };
    const dryRun = body.dryRun !== false;
    const result = await cleanupCrucialTrackDuplicates(config, dryRun);
    return json({ ok: true, requestId, dryRun, ...result });
  } catch (error) {
    return json({ error: 'Crucial Tracks duplicate cleanup failed', detail: error instanceof Error ? error.message : 'Unknown error', requestId }, { status: 500 });
  }
};
