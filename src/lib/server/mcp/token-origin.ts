/** SvelteKit's CSRF protection stays enabled everywhere else. OAuth token
 * requests are credential/PKCE authenticated, never cookie authenticated. */
export function oauthTokenRequest(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname !== '/oauth/token' || request.method !== 'POST' || request.headers.has('origin')) return request;
  // Node fetch may send Sec-Fetch-Mode: cors, but not browser site metadata.
  if (request.headers.has('sec-fetch-site') ||
      ['navigate', 'no-cors'].includes(request.headers.get('sec-fetch-mode') ?? '') ||
      (request.headers.has('sec-fetch-dest') && request.headers.get('sec-fetch-dest') !== 'empty')) return request;
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return request;
  const headers = new Headers(request.headers);
  headers.set('origin', url.origin);
  headers.delete('cookie');
  return new Request(request, { headers });
}
