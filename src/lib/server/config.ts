export interface SyncConfig {
  ghostUrl: string;
  ghostAdminApiKey: string;
  ghostStaffAccessToken?: string;
  ghostWebhookSecret: string;
  atprotoService: string;
  atprotoIdentifier: string;
  atprotoDid: string;
  atprotoAppPassword: string;
  publicationUri: string;
}

function required(env: App.Platform['env'], name: keyof App.Platform['env']): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required configuration: ${String(name)}`);
  }
  return value.trim();
}

export function getSyncConfig(platform: App.Platform | undefined): SyncConfig {
  if (!platform) throw new Error('Cloudflare platform bindings are unavailable');
  return {
    ghostUrl: required(platform.env, 'GHOST_URL').replace(/\/$/, ''),
    ghostAdminApiKey: required(platform.env, 'GHOST_ADMIN_API_KEY'),
    ghostStaffAccessToken: typeof platform.env.GHOST_STAFF_ACCESS_TOKEN === 'string' ? platform.env.GHOST_STAFF_ACCESS_TOKEN.trim() : undefined,
    ghostWebhookSecret: required(platform.env, 'GHOST_WEBHOOK_SECRET'),
    atprotoService: required(platform.env, 'ATPROTO_SERVICE').replace(/\/$/, ''),
    atprotoIdentifier: required(platform.env, 'ATPROTO_IDENTIFIER'),
    atprotoDid: required(platform.env, 'ATPROTO_DID'),
    atprotoAppPassword: required(platform.env, 'ATPROTO_APP_PASSWORD'),
    publicationUri: required(platform.env, 'PUBLICATION_URI')
  };
}

export function configurationStatus(platform: App.Platform | undefined) {
  const env = platform?.env;
  return {
    ghost: Boolean(env?.GHOST_URL && env?.GHOST_ADMIN_API_KEY && env?.GHOST_WEBHOOK_SECRET),
    ghostActivityPub: Boolean(env?.GHOST_URL && env?.GHOST_STAFF_ACCESS_TOKEN),
    atproto: Boolean(env?.ATPROTO_SERVICE && env?.ATPROTO_IDENTIFIER && env?.ATPROTO_DID && env?.ATPROTO_APP_PASSWORD && env?.PUBLICATION_URI)
  };
}
