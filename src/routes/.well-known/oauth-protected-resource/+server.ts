import type { RequestHandler } from './$types';
import { protectedResourceMetadata } from '$lib/server/mcp/oauth';
import { corsJson, mcpAuthConfig, notConfigured, preflight, publicOrigin } from '$lib/server/mcp/responses';

// RFC 9728 metadata for the MCP endpoint. Also served at
// /.well-known/oauth-protected-resource/mcp (the path-specific form).
export const GET: RequestHandler = ({ url, platform }) => {
  if (!mcpAuthConfig(platform)) return notConfigured();
  return corsJson(protectedResourceMetadata(publicOrigin(platform, url)));
};

export const OPTIONS: RequestHandler = () => preflight();
