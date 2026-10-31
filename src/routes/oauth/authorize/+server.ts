import type { RequestHandler } from './$types';
import { authorizePage, errorPage, pageHeaders } from '$lib/server/mcp/authorize-page';
import {
  authorizationRedirect,
  issueAuthorizationCode,
  reserveLoginAttempt,
  OAuthError,
  ownerPasswordMatches,
  validateAuthorizationRequest,
  type AuthorizationValidation,
  type McpAuthConfig
} from '$lib/server/mcp/oauth';
import { mcpAuthConfig, mcpStore, publicOrigin } from '$lib/server/mcp/responses';

function html(config: McpAuthConfig, body: string, status = 200): Response {
  return new Response(body, { status, headers: pageHeaders(config.allowedRedirectUris) });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

function rejection(config: McpAuthConfig, issuer: string, result: Exclude<AuthorizationValidation, { ok: true }>): Response {
  if (!result.redirectable) return html(config, errorPage(result.description), 400);
  return redirect(authorizationRedirect(result.redirectUri, issuer, {
    error: result.error,
    error_description: result.description,
    state: result.state
  }));
}

export const GET: RequestHandler = async ({ url, platform }) => {
  const config = mcpAuthConfig(platform);
  if (!config) return new Response('Not found', { status: 404 });

  const result = await validateAuthorizationRequest(config, url.searchParams, publicOrigin(platform, url));
  if (!result.ok) return rejection(config, publicOrigin(platform, url), result);
  return html(config, authorizePage(result.request));
};

export const POST: RequestHandler = async ({ request, url, platform }) => {
  const config = mcpAuthConfig(platform);
  if (!config) return new Response('Not found', { status: 404 });
  if (Number(request.headers.get('content-length') ?? 0) > 16 * 1024) return html(config, errorPage('Request is too large.'), 413);

  const form = new URLSearchParams(await request.text());
  const result = await validateAuthorizationRequest(config, form, publicOrigin(platform, url));
  if (!result.ok) return rejection(config, publicOrigin(platform, url), result);
  const authorization = result.request;

  if (form.get('decision') !== 'allow') {
    return redirect(authorizationRedirect(authorization.redirectUri, publicOrigin(platform, url), {
      error: 'access_denied',
      error_description: 'The owner declined the connection',
      state: authorization.state
    }));
  }

  const store = mcpStore(platform);
  try {
    if (!(await reserveLoginAttempt(store))) {
      console.warn(JSON.stringify({ message: 'mcp oauth login throttled' }));
      return html(config, authorizePage(authorization, { error: 'Too many login attempts. Try again in an hour.' }), 429);
    }
  } catch (error) {
    if (error instanceof OAuthError) return html(config, errorPage('Authentication temporarily unavailable.'), error.status);
    throw error;
  }

  if (!ownerPasswordMatches(config, form.get('password') ?? '')) {
    console.warn(JSON.stringify({ message: 'mcp oauth login failed' }));
    return html(config, authorizePage(authorization, { error: 'That passphrase is not right.' }), 401);
  }

  const code = await issueAuthorizationCode(config, authorization);
  console.log(JSON.stringify({ message: 'mcp oauth authorization granted', clientName: authorization.clientName ?? null }));
  return redirect(authorizationRedirect(authorization.redirectUri, publicOrigin(platform, url), { code, state: authorization.state }));
};
