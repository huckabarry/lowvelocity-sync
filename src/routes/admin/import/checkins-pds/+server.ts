import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { timingSafeStringEqual } from '$lib/server/crypto';
import { importPdsCheckins } from '$lib/server/pds-checkins-native';

interface ImportBody {
  dryRun?: boolean;
  limit?: number;
  maxPages?: number;
  since?: string;
  until?: string;
  updateExisting?: boolean;
  uploadImages?: boolean;
  repo?: string;
}

function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

function validDate(value: string | undefined): boolean {
  return value === undefined || Number.isFinite(Date.parse(value));
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

    if (!validDate(body.since) || !validDate(body.until)) {
      return json({ error: 'since/until must be valid ISO-compatible dates', requestId }, { status: 400 });
    }

    const dryRun = body.dryRun !== false;
    const importResult = await importPdsCheckins(config, {
      dryRun,
      limit: body.limit,
      maxPages: body.maxPages,
      since: body.since,
      until: body.until,
      updateExisting: body.updateExisting,
      uploadImages: body.uploadImages,
      repo: body.repo
    });

    console.log(JSON.stringify({ message: 'PDS check-ins native import processed', requestId, dryRun, ...importResult }));
    return json({ ok: true, requestId, dryRun, ...importResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(JSON.stringify({ message: 'PDS check-ins native import failed', requestId, error: message }));
    return json({ error: 'PDS check-ins native import failed', detail: message, requestId }, { status: 500 });
  }
};
