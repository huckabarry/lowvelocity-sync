import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { timingSafeStringEqual } from '$lib/server/crypto';
import { importBlueskyPosts } from '$lib/server/bluesky-native';
import { findLatestGhostPostByTag } from '$lib/server/ghost';

interface ImportBody {
  dryRun?: boolean;
  limit?: number;
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
    const importResult = await importBlueskyPosts(config, {
      dryRun,
      limit: body.limit,
      maxPages: body.maxPages,
      since: resolvedSince,
      until: body.until,
      updateExisting: body.updateExisting,
      uploadImages: body.uploadImages
    });

    console.log(JSON.stringify({ message: 'bluesky native import processed', requestId, dryRun, sinceBoundary, resolvedSince, ...importResult }));
    return json({ ok: true, requestId, dryRun, sinceBoundary, resolvedSince, ...importResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(JSON.stringify({ message: 'bluesky native import failed', requestId, error: message }));
    return json({ error: 'bluesky native import failed', detail: message, requestId }, { status: 500 });
  }
};
