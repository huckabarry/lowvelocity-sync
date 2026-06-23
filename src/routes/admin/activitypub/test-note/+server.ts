import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { timingSafeStringEqual } from '$lib/server/crypto';
import { createGhostActivityPubNote, readGhostActivityPubIdentityToken } from '$lib/server/ghost';

interface TestNoteBody {
  content?: string;
  dryRun?: boolean;
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

    let body: TestNoteBody;
    try {
      body = (await request.json()) as TestNoteBody;
    } catch {
      return json({ error: 'invalid JSON payload', requestId }, { status: 400 });
    }

    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) return json({ error: 'content is required', requestId }, { status: 400 });
    if (content.length > 5000) return json({ error: 'content is too long', requestId }, { status: 400 });

    if (body.dryRun) {
      await readGhostActivityPubIdentityToken(config);
      return json({ ok: true, dryRun: true, requestId });
    }

    const note = await createGhostActivityPubNote(config, content);
    console.log(JSON.stringify({ message: 'activitypub test note created', requestId, noteId: note.id, noteUrl: note.url }));
    return json({ ok: true, requestId, note: { id: note.id, url: note.url, publishedAt: note.publishedAt } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(JSON.stringify({ message: 'activitypub test note failed', requestId, error: message }));
    return json({ error: 'activitypub note failed', requestId }, { status: 500 });
  }
};
