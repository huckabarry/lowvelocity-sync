import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cleanupBlueskyPosts } from '$lib/server/bluesky-cleanup';
import { getSyncConfig } from '$lib/server/config';
import { timingSafeStringEqual } from '$lib/server/crypto';

interface CleanupBody {
  dryRun?: boolean;
  limit?: number;
  page?: number;
}

function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

export const POST: RequestHandler = async ({ request, platform }) => {
  const requestId = crypto.randomUUID();

  try {
    const config = getSyncConfig(platform);
    const token = bearerToken(request);
    if (!token || !config.ghostStaffAccessToken || !timingSafeStringEqual(token, config.ghostStaffAccessToken)) {
      return json({ error: 'unauthorized', requestId }, { status: 401 });
    }

    let body: CleanupBody;
    try {
      body = (await request.json()) as CleanupBody;
    } catch {
      return json({ error: 'invalid JSON payload', requestId }, { status: 400 });
    }

    const dryRun = body.dryRun !== false;
    const cleanupResult = await cleanupBlueskyPosts(config, {
      dryRun,
      limit: body.limit,
      page: body.page
    });

    console.log(JSON.stringify({ message: 'bluesky cleanup processed', requestId, dryRun, ...cleanupResult }));
    return json({ ok: true, requestId, dryRun, ...cleanupResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(JSON.stringify({ message: 'bluesky cleanup failed', requestId, error: message }));
    return json({ error: 'bluesky cleanup failed', detail: message, requestId }, { status: 500 });
  }
};
