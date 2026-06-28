import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { exchangeFoursquareCodeForAccessToken, foursquareRedirectUri, verifyFoursquareOAuthState } from '$lib/server/foursquare-oauth';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function tokenResponse(accessToken: string): Response {
  const escapedToken = escapeHtml(accessToken);
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Foursquare connected</title>
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
    .status {
      margin: 1rem 0;
      padding: 1rem;
      border: 1px solid #444;
      border-radius: 8px;
      background: #181818;
    }
    .status.ok {
      border-color: #2abc89;
    }
    .status.error {
      border-color: #d45478;
    }
  </style>
</head>
<body>
  <main>
    <h1>Foursquare connected</h1>
    <p>This is your Foursquare access token. I’m testing it against your check-in history now. If it verifies, add it to Cloudflare as <code>FOURSQUARE_ACCESS_TOKEN</code>.</p>
    <div id="verify-status" class="status">Testing token…</div>
    <pre>${escapedToken}</pre>
    <p>With Wrangler:</p>
    <pre>npx wrangler secret put FOURSQUARE_ACCESS_TOKEN --name lowvelocity-sync</pre>
    <p>Keep this token private. You can close this page after saving it.</p>
  </main>
  <script>
    (async function () {
      var box = document.getElementById('verify-status');
      try {
        var response = await fetch('/admin/checkins/verify', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({accessToken: ${JSON.stringify(accessToken)}})
        });
        var result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.detail || result.error || 'Token verification failed');
        }
        box.className = 'status ok';
        box.textContent = 'Verified. This token can read ' + result.count + ' Foursquare/Swarm check-ins' + (result.latest ? '. Latest: ' + result.latest.title + '.' : '.');
      } catch (error) {
        box.className = 'status error';
        box.textContent = 'Token test failed: ' + (error && error.message ? error.message : 'Unknown error');
      }
    })();
  </script>
</body>
</html>`, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    }
  });
}

function callbackHelpResponse(): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Foursquare callback</title>
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
    .hidden {
      display: none;
    }
    .status {
      margin: 1rem 0;
      padding: 1rem;
      border: 1px solid #444;
      border-radius: 8px;
      background: #181818;
    }
    .status.ok {
      border-color: #2abc89;
    }
    .status.error {
      border-color: #d45478;
    }
  </style>
</head>
<body>
  <main>
    <h1>Foursquare callback</h1>
    <div id="token-result" class="hidden">
      <p>This is your Foursquare access token. Add it to Cloudflare as <code>FOURSQUARE_ACCESS_TOKEN</code>.</p>
      <div id="verify-status" class="status">Testing token…</div>
      <pre id="token"></pre>
      <p>With Wrangler:</p>
      <pre>npx wrangler secret put FOURSQUARE_ACCESS_TOKEN --name lowvelocity-sync</pre>
    </div>
    <div id="no-token">
      <p>No OAuth code or access token reached the callback. Go back to <a href="/admin/checkins/connect">the Foursquare connection page</a> and try the token fallback.</p>
      <p>If Foursquare redirected you here with a visible <code>#access_token=...</code> in the address bar, JavaScript may be blocked. Copy that token from the URL fragment.</p>
    </div>
  </main>
  <script>
    (function () {
      var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      var token = params.get('access_token');
      if (!token) return;
      document.getElementById('token').textContent = token;
      document.getElementById('token-result').classList.remove('hidden');
      document.getElementById('no-token').classList.add('hidden');
      history.replaceState(null, document.title, window.location.pathname);
      var box = document.getElementById('verify-status');
      fetch('/admin/checkins/verify', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({accessToken: token})
      }).then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok || !result.ok) {
            throw new Error(result.detail || result.error || 'Token verification failed');
          }
          box.className = 'status ok';
          box.textContent = 'Verified. This token can read ' + result.count + ' Foursquare/Swarm check-ins' + (result.latest ? '. Latest: ' + result.latest.title + '.' : '.');
        });
      }).catch(function (error) {
        box.className = 'status error';
        box.textContent = 'Token test failed: ' + (error && error.message ? error.message : 'Unknown error');
      });
    })();
  </script>
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
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    throw error(400, url.searchParams.get('error_description') || oauthError);
  }

  const code = url.searchParams.get('code')?.trim();
  const state = url.searchParams.get('state')?.trim();
  if (!code) return callbackHelpResponse();

  const redirectUri = foursquareRedirectUri(url);
  if (state && !(await verifyFoursquareOAuthState(config, state, redirectUri))) {
    throw error(400, 'Invalid or expired Foursquare OAuth state');
  }

  const accessToken = await exchangeFoursquareCodeForAccessToken(config, code, redirectUri);
  return tokenResponse(accessToken);
};
