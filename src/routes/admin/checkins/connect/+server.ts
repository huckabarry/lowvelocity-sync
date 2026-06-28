import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { buildFoursquareAuthorizationUrl, foursquareRedirectUri } from '$lib/server/foursquare-oauth';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function connectPage(codeUrl: string, tokenUrl: string, callbackUrl: string): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Foursquare</title>
  <style>
    body {
      background: #111;
      color: #eee;
      font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      padding: 3rem 1.5rem;
    }
    main {
      max-width: 760px;
      margin: 0 auto;
    }
    a.button {
      display: inline-block;
      margin: 0.5rem 0.75rem 0.5rem 0;
      padding: 0.7rem 1rem;
      border: 1px solid #666;
      border-radius: 999px;
      color: #fff;
      text-decoration: none;
    }
    a.button:first-of-type {
      border-color: #2abc89;
    }
    code, pre {
      background: #1f1f1f;
      border: 1px solid #444;
      border-radius: 8px;
      color: #fff;
    }
    code {
      padding: .15rem .35rem;
    }
    pre {
      overflow-x: auto;
      padding: 1rem;
      white-space: pre-wrap;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <main>
    <h1>Connect Foursquare</h1>
    <p>Foursquare’s legacy OAuth can be picky. Try the server code flow first. If it only logs you into Foursquare and does not return here, try the direct token fallback.</p>
    <p>
      <a class="button" href="${escapeHtml(codeUrl)}">Authorize with Foursquare</a>
      <a class="button" href="${escapeHtml(tokenUrl)}">Try token fallback</a>
    </p>
    <p>Your Foursquare developer callback must be exactly:</p>
    <pre>${escapeHtml(callbackUrl)}</pre>
    <p>If Foursquare gives you a URL with <code>code=...</code> or <code>#access_token=...</code>, paste/send me that full URL and I can finish the next step.</p>
    <h2>Raw authorization URLs</h2>
    <p>Code flow:</p>
    <pre>${escapeHtml(codeUrl)}</pre>
    <p>Token fallback:</p>
    <pre>${escapeHtml(tokenUrl)}</pre>
  </main>
</body>
</html>`, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    }
  });
}

export const GET: RequestHandler = async ({ platform, url }) => {
  const config = getSyncConfig(platform);
  const codeUrl = await buildFoursquareAuthorizationUrl(config, url, { responseType: 'code', includeState: true });
  const tokenUrl = await buildFoursquareAuthorizationUrl(config, url, { responseType: 'token', includeState: true });

  if (url.searchParams.get('go') === '1') {
    throw redirect(302, codeUrl);
  }

  return connectPage(codeUrl, tokenUrl, foursquareRedirectUri(url));
};
