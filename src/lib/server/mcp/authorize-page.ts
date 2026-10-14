import type { AuthorizationRequest } from './oauth.ts';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #faf9f6; --fg: #1d1d1b; --muted: #6b6a66; --line: #d9d7d0; --accent: #1d1d1b; --accent-fg: #faf9f6; --error: #a1260d; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe6; --muted: #9a9993; --line: #34332f; --accent: #ecebe6; --accent-fg: #161615; --error: #f08a72; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 17px/1.5 Georgia, 'Iowan Old Style', serif; }
  main { width: 100%; max-width: 420px; }
  h1 { font-size: 1.4rem; font-weight: normal; margin: 0 0 12px; }
  p { margin: 0 0 16px; color: var(--muted); }
  ul { margin: 0 0 20px; padding-left: 20px; color: var(--muted); }
  label { display: block; font: 600 0.8rem/1.2 system-ui, sans-serif; letter-spacing: 0.02em; text-transform: uppercase; margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 12px; font-size: 16px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); }
  .actions { display: flex; gap: 12px; margin-top: 20px; }
  button { flex: 1; padding: 12px; font: 600 0.95rem system-ui, sans-serif; border-radius: 6px; border: 1px solid var(--accent); cursor: pointer; }
  button[value=allow] { background: var(--accent); color: var(--accent-fg); }
  button[value=deny] { background: transparent; color: var(--fg); border-color: var(--line); }
  .error { color: var(--error); }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function authorizePage(request: AuthorizationRequest, options: { error?: string } = {}): string {
  const hidden: Array<[string, string | undefined]> = [
    ['response_type', 'code'],
    ['client_id', request.clientId],
    ['redirect_uri', request.redirectUri],
    ['state', request.state],
    ['code_challenge', request.codeChallenge],
    ['code_challenge_method', 'S256'],
    ['scope', request.scope],
    ['resource', request.resource]
  ];
  const fields = hidden
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n');
  const client = escapeHtml(request.clientName || 'Claude');
  const destination = escapeHtml(new URL(request.redirectUri).host);

  return page(
    'Connect to Low Velocity',
    `<h1>Let ${client} read Low Velocity?</h1>
<p>This connection is read-only. It can:</p>
<ul>
  <li>Find and read posts, including drafts</li>
  <li>Find and read pages</li>
  <li>List tags</li>
</ul>
<p>It cannot publish, edit, or delete anything. You will be sent back to ${destination}.</p>
${options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ''}
<form method="post" action="/oauth/authorize">
${fields}
<label for="password">Owner passphrase</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus>
<div class="actions">
  <button type="submit" name="decision" value="deny">Cancel</button>
  <button type="submit" name="decision" value="allow">Allow</button>
</div>
</form>`
  );
}

export function errorPage(message: string): string {
  return page('Cannot connect', `<h1>Cannot connect</h1><p class="error">${escapeHtml(message)}</p>`);
}

/** Security headers for the HTML authorization pages. */
export function pageHeaders(allowedRedirectUris: string[]): Record<string, string> {
  const redirectOrigins = [...new Set(allowedRedirectUris.map((uri) => {
    try {
      return new URL(uri).origin;
    } catch {
      return '';
    }
  }).filter(Boolean))];
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    // form-action must include the redirect origins because browsers apply it
    // to the redirect that follows the form submission.
    'content-security-policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `form-action 'self' ${redirectOrigins.join(' ')}`.trim(),
      "frame-ancestors 'none'",
      "base-uri 'none'"
    ].join('; ')
  };
}
