import type { RequestHandler } from './$types';
import { authorizationServerMetadata } from '$lib/server/mcp/oauth';
import { corsJson, mcpAuthConfig, notConfigured, preflight, publicOrigin } from '$lib/server/mcp/responses';

// RFC 8414 authorization server metadata.
export const GET: RequestHandler = ({ url, platform }) => {
  if (!mcpAuthConfig(platform)) return notConfigured();
  return corsJson(authorizationServerMetadata(publicOrigin(platform, url)));
};

export const OPTIONS: RequestHandler = () => preflight();
