import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { timingSafeStringEqual } from '$lib/server/crypto';
import { createPikaPost, verifyPikaMicropub } from '$lib/server/pika';

interface PikaRequestBody {
  action?: 'verify' | 'create-draft';
  content?: string;
  title?: string;
  categories?: string[];
}

function bearerToken(request: Request): string {
  const match = (request.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
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
    let body: PikaRequestBody;
    try {
      body = await request.json() as PikaRequestBody;
    } catch {
      return json({ error: 'invalid JSON payload', requestId }, { status: 400 });
    }
    if ((body.action ?? 'verify') === 'verify') {
      const mediaEndpoint = await verifyPikaMicropub(config);
      return json({ ok: true, action: 'verify', mediaEndpoint, requestId });
    }
    const content = body.content?.trim() ?? '';
    if (!content) return json({ error: 'content is required', requestId }, { status: 400 });
    const post = await createPikaPost(config, {
      content,
      title: body.title,
      categories: body.categories,
      status: 'draft'
    });
    console.log(JSON.stringify({ message: 'Pika draft created', requestId, location: post.location }));
    return json({ ok: true, action: 'create-draft', post, requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(JSON.stringify({ message: 'Pika Micropub request failed', requestId, error: message }));
    return json({ error: 'Pika Micropub request failed', detail: message, requestId }, { status: 500 });
  }
};
