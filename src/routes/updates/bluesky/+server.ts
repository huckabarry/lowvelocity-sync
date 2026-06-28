import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { BLUESKY_UPDATES_LIMIT, readBlueskyUpdates } from '$lib/server/bluesky';

const CACHE_SECONDS = 600;
const CACHE_VERSION = '2';

const RESPONSE_HEADERS = {
  'access-control-allow-origin': '*',
  'cache-control': `public, max-age=300, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=3600`,
  'content-type': 'application/json; charset=utf-8'
};

function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.search = '';
  url.searchParams.set('v', CACHE_VERSION);
  return new Request(url.toString(), { method: 'GET' });
}

function defaultCache(platform: App.Platform | undefined): Cache | undefined {
  const storage = platform?.caches ?? (typeof caches !== 'undefined' ? caches : undefined);
  return (storage as CacheStorage & { default?: Cache } | undefined)?.default;
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
  const cache = defaultCache(platform);
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
