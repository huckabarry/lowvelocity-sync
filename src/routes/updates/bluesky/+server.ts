import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { BLUESKY_UPDATES_LIMIT, readBlueskyUpdates } from '$lib/server/bluesky';

const CACHE_SECONDS = 600;

const RESPONSE_HEADERS = {
  'access-control-allow-origin': '*',
  'cache-control': `public, max-age=300, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=3600`,
  'content-type': 'application/json; charset=utf-8'
};

function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.search = '';
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
  const cache = platform?.caches?.default ?? (typeof caches !== 'undefined' ? caches.default : undefined);
  const key = cacheKey(request);

  if (cache) {
    const cached = await cache.match(key);
    if (cached) {
      return new Response(await cached.text(), {
        status: cached.status,
        headers: {
          ...RESPONSE_HEADERS,
          'x-lowvelocity-cache': 'hit'
        }
      });
    }
  }

  const config = getSyncConfig(platform);
  const updates = await readBlueskyUpdates(config, BLUESKY_UPDATES_LIMIT);
  const response = new Response(JSON.stringify(updates, null, 2), {
    headers: {
      ...RESPONSE_HEADERS,
      'x-lowvelocity-cache': 'miss'
    }
  });

  if (cache) {
    await cache.put(key, response.clone());
  }

  return response;
};
