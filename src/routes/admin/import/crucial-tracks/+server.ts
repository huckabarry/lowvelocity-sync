import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { timingSafeStringEqual } from '$lib/server/crypto';
import { ensureListeningPage, importCrucialTracks } from '$lib/server/crucial-tracks';

interface ImportBody {
  dryRun?: boolean;
  limit?: number;
  offset?: number;
  updateExisting?: boolean;
  ensurePage?: boolean;
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

    let body: ImportBody;
    try {
      body = (await request.json()) as ImportBody;
    } catch {
      return json({ error: 'invalid JSON payload', requestId }, { status: 400 });
    }

    const dryRun = body.dryRun !== false;
    const page = body.ensurePage === false ? null : await ensureListeningPage(config, dryRun);
    const importResult = await importCrucialTracks(config, {
      dryRun,
      limit: body.limit,
      offset: body.offset,
      updateExisting: body.updateExisting
    });

    console.log(JSON.stringify({ message: 'crucial tracks import processed', requestId, dryRun, ...importResult }));
    return json({ ok: true, requestId, dryRun, page, ...importResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(JSON.stringify({ message: 'crucial tracks import failed', requestId, error: message }));
    return json({ error: 'crucial tracks import failed', detail: message, requestId }, { status: 500 });
  }
};
