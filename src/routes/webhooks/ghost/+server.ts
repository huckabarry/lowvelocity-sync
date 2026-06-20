import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { verifyGhostSignature } from '$lib/server/crypto';
import { removePublishedPost, syncPublishedPost } from '$lib/server/sync';

interface WebhookPostState { id?: string; slug?: string; status?: string; url?: string; }
interface GhostWebhookBody { post?: { current?: WebhookPostState; previous?: WebhookPostState; }; }

function webhookState(value: unknown): GhostWebhookBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const post = (value as Record<string, unknown>).post;
  if (typeof post !== 'object' || post === null) return null;
  return value as GhostWebhookBody;
}

export const POST: RequestHandler = async ({ request, platform }) => {
  const requestId = crypto.randomUUID();
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 1024 * 1024) return json({ error: 'payload too large', requestId }, { status: 413 });
  try {
    const config = getSyncConfig(platform);
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > 1024 * 1024) return json({ error: 'payload too large', requestId }, { status: 413 });
    const signature = request.headers.get('x-ghost-signature') ?? '';
    if (!(await verifyGhostSignature(raw, signature, config.ghostWebhookSecret))) {
      console.warn(JSON.stringify({ message: 'webhook rejected', requestId, reason: 'signature' }));
      return json({ error: 'invalid webhook signature', requestId }, { status: 401 });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(raw)); }
    catch { return json({ error: 'invalid JSON payload', requestId }, { status: 400 }); }
    const body = webhookState(parsed);
    const current = body?.post?.current;
    const previous = body?.post?.previous;
    const postId = current?.id ?? previous?.id;
    if (!postId || !/^[a-f0-9]{24}$/i.test(postId)) {
      return json({ error: 'missing or invalid Ghost post id', requestId }, { status: 400 });
    }
    const sourceUrl = current?.url ?? previous?.url;
    const path = sourceUrl ? new URL(sourceUrl).pathname : undefined;
    const result = current?.status === 'published'
      ? await syncPublishedPost(config, postId)
      : previous?.status === 'published'
        ? await removePublishedPost(config, postId, path)
        : { action: 'ignore' as const, postId };
    console.log(JSON.stringify({ message: 'webhook processed', requestId, ...result }));
    return json({ ok: true, requestId, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(JSON.stringify({ message: 'webhook failed', requestId, error: message }));
    return json({ error: 'synchronization failed', requestId }, { status: 500 });
  }
};
