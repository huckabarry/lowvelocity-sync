import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { timingSafeStringEqual } from '$lib/server/crypto';
import { findLatestGhostPostByTag } from '$lib/server/ghost';
import { importSwarmCheckins } from '$lib/server/checkins-native';
import { resolveFoursquareAccessToken } from '$lib/server/checkins-token-store';
import { summarizeResult, writeOpsStatus } from '$lib/server/ops-status';

interface ImportBody {
  dryRun?: boolean;
  limit?: number;
  offset?: number;
  maxPages?: number;
  since?: string;
  sinceTag?: string;
  until?: string;
  updateExisting?: boolean;
  uploadImages?: boolean;
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

    let resolvedSince = body.since;
    let sinceBoundary: { tag: string; slug: string; title: string; publishedAt: string; url: string } | null = null;
    if (!resolvedSince && body.sinceTag?.trim()) {
      const tag = body.sinceTag.trim();
      const latest = await findLatestGhostPostByTag(config, tag);
      if (!latest) {
        return json({ error: `No published Ghost post found for tag ${tag}`, requestId }, { status: 404 });
      }
      const publishedAt = new Date(latest.published_at);
      resolvedSince = new Date(publishedAt.getTime() + 1).toISOString();
      sinceBoundary = {
        tag,
        slug: latest.slug,
        title: latest.title,
        publishedAt: latest.published_at,
        url: latest.url
      };
    }

    const dryRun = body.dryRun !== false;
    const tokenResolution = await resolveFoursquareAccessToken(config, platform);
    const importResult = await importSwarmCheckins(config, {
      accessToken: tokenResolution.accessToken,
      dryRun,
      limit: body.limit,
      offset: body.offset,
      maxPages: body.maxPages,
      since: resolvedSince,
      until: body.until,
      updateExisting: body.updateExisting,
      uploadImages: body.uploadImages
    });

    console.log(JSON.stringify({
      message: 'check-ins native import processed',
      requestId,
      dryRun,
      tokenSource: tokenResolution.source,
      sinceBoundary,
      resolvedSince,
      ...importResult
    }));
    await writeOpsStatus(platform, {
      flow: 'checkins',
      outcome: 'ok',
      requestId,
      message: dryRun ? 'Foursquare check-ins dry-run import processed' : 'Foursquare check-ins import processed',
      summary: summarizeResult({ tokenSource: tokenResolution.source, ...importResult })
    });
    return json({ ok: true, requestId, dryRun, tokenSource: tokenResolution.source, sinceBoundary, resolvedSince, ...importResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(JSON.stringify({ message: 'check-ins native import failed', requestId, error: message }));
    await writeOpsStatus(platform, {
      flow: 'checkins',
      outcome: 'error',
      requestId,
      message
    });
    return json({ error: 'check-ins native import failed', detail: message, requestId }, { status: 500 });
  }
};
