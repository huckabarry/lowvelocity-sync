import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { timingSafeStringEqual } from '$lib/server/crypto';
import { importPopfeedMedia } from '$lib/server/popfeed-native';
import { summarizeResult, writeOpsStatus } from '$lib/server/ops-status';

interface ImportBody {
  dryRun?: boolean;
  limit?: number;
  maxPages?: number;
  since?: string;
  until?: string;
  updateExisting?: boolean;
  uploadImages?: boolean;
  repo?: string;
  pdsEndpoint?: string;
  includeCurrentlyReading?: boolean;
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
    const importResult = await importPopfeedMedia(config, {
      dryRun,
      limit: body.limit,
      maxPages: body.maxPages,
      since: body.since,
      until: body.until,
      updateExisting: body.updateExisting,
      uploadImages: body.uploadImages,
      repo: body.repo,
      pdsEndpoint: body.pdsEndpoint,
      includeCurrentlyReading: body.includeCurrentlyReading
    });

    console.log(JSON.stringify({ message: 'Popfeed media native import processed', requestId, dryRun, ...importResult }));
    await writeOpsStatus(platform, {
      flow: 'popfeed',
      outcome: 'ok',
      requestId,
      message: dryRun ? 'Popfeed media dry-run import processed' : 'Popfeed media import processed',
      summary: summarizeResult(importResult)
    });
    return json({ ok: true, requestId, dryRun, ...importResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(JSON.stringify({ message: 'Popfeed media native import failed', requestId, error: message }));
    await writeOpsStatus(platform, {
      flow: 'popfeed',
      outcome: 'error',
      requestId,
      message
    });
    return json({ error: 'Popfeed media native import failed', detail: message, requestId }, { status: 500 });
  }
};
