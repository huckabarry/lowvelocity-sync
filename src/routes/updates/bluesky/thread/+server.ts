import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { blueskyPostUriFromRkey, readBlueskyThreadSummary } from '$lib/server/bluesky';

const CACHE_SECONDS = 600;
const CACHE_VERSION = '1';

const RESPONSE_HEADERS = {
  'access-control-allow-origin': '*',
  'cache-control': `public, max-age=60, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=3600`,
  'content-type': 'application/json; charset=utf-8'
};

function responseHeaders(cacheStatus: 'hit' | 'miss' | 'skip') {
  return {
    ...RESPONSE_HEADERS,
    'x-lowvelocity-cache': cacheStatus
  };
}

function cacheKey(request: Request, uri: string): Request {
  const url = new URL(request.url);
  url.search = '';
  url.searchParams.set('uri', uri);
  url.searchParams.set('v', CACHE_VERSION);
  return new Request(url.toString(), { method: 'GET' });
}

export const OPTIONS: RequestHandler = () => {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
};

export const GET: RequestHandler = async ({ request, platform }) => {
  try {
    const config = getSyncConfig(platform);
    const url = new URL(request.url);
    const requestedUri = url.searchParams.get('uri')?.trim();
    const requestedRkey = url.searchParams.get('rkey')?.trim();
    const uri = requestedUri || (requestedRkey ? blueskyPostUriFromRkey(config.blueskyUpdatesDid, requestedRkey) : '');
    if (!uri) return json({ error: 'missing uri or rkey' }, { status: 400, headers: responseHeaders('skip') });

    const cache = platform?.caches?.default ?? (typeof caches !== 'undefined' ? caches.default : undefined);
    const key = cacheKey(request, uri);

    if (cache) {
      const cached = await cache.match(key);
      if (cached) {
        return new Response(cached.body, {
          status: cached.status,
          headers: responseHeaders('hit')
        });
      }
    }

    const summary = await readBlueskyThreadSummary(config, uri);
    const response = new Response(JSON.stringify(summary, null, 2), {
      headers: responseHeaders('miss')
    });

    if (cache) {
      await cache.put(key, response.clone());
    }

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read Bluesky thread';
    return json({ error: message }, { status: 400, headers: responseHeaders('skip') });
  }
};
