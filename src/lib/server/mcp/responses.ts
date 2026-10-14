import { CORS_HEADERS, getMcpAuthConfig, type KeyValueStore, type McpAuthConfig } from './oauth.ts';

export function mcpAuthConfig(platform: App.Platform | undefined): McpAuthConfig | null {
  return getMcpAuthConfig(platform?.env);
}

/**
 * The canonical public origin used as the OAuth issuer and MCP resource.
 * Pinned with MCP_PUBLIC_ORIGIN so tokens stay valid whether a request
 * arrives on the custom domain or workers.dev, and so local dev proxies
 * cannot change it.
 */
export function publicOrigin(platform: App.Platform | undefined, url: URL): string {
  const configured = platform?.env?.MCP_PUBLIC_ORIGIN;
  if (typeof configured === 'string' && configured.trim()) {
    try {
      return new URL(configured.trim()).origin;
    } catch {
      // Fall through to the request origin.
    }
  }
  return url.origin;
}

export function mcpStore(platform: App.Platform | undefined): KeyValueStore | undefined {
  return platform?.env?.CHECKINS_KV;
}

export function corsJson(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...init.headers
    }
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** The MCP feature is off until MCP_TOKEN_SECRET and MCP_OWNER_PASSWORD exist. */
export function notConfigured(): Response {
  return corsJson({ error: 'not_found', error_description: 'The MCP connector is not enabled on this Worker.' }, { status: 404 });
}
