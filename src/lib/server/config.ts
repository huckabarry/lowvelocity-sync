export interface SyncConfig {
  ghostUrl: string;
  ghostAdminApiKey: string;
  ghostStaffAccessToken?: string;
  ghostWebhookSecret: string;
  atprotoService: string;
  atprotoIdentifier: string;
  atprotoDid: string;
  blueskyUpdatesIdentifier: string;
  blueskyUpdatesDid: string;
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

function optional(env: App.Platform['env'], name: keyof App.Platform['env']): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function getSyncConfig(platform: App.Platform | undefined): SyncConfig {
  if (!platform) throw new Error('Cloudflare platform bindings are unavailable');
  const atprotoIdentifier = required(platform.env, 'ATPROTO_IDENTIFIER');
  const atprotoDid = required(platform.env, 'ATPROTO_DID');

  return {
    ghostUrl: required(platform.env, 'GHOST_URL').replace(/\/$/, ''),
    ghostAdminApiKey: required(platform.env, 'GHOST_ADMIN_API_KEY'),
    ghostStaffAccessToken: optional(platform.env, 'GHOST_STAFF_ACCESS_TOKEN'),
    ghostWebhookSecret: required(platform.env, 'GHOST_WEBHOOK_SECRET'),
    atprotoService: required(platform.env, 'ATPROTO_SERVICE').replace(/\/$/, ''),
    atprotoIdentifier,
    atprotoDid,
    blueskyUpdatesIdentifier: optional(platform.env, 'BLUESKY_UPDATES_IDENTIFIER') ?? atprotoIdentifier,
    blueskyUpdatesDid: optional(platform.env, 'BLUESKY_UPDATES_DID') ?? atprotoDid,
    atprotoAppPassword: required(platform.env, 'ATPROTO_APP_PASSWORD'),
    publicationUri: required(platform.env, 'PUBLICATION_URI')
  };
}

export function configurationStatus(platform: App.Platform | undefined) {
  const env = platform?.env;
  return {
    ghost: Boolean(env?.GHOST_URL && env?.GHOST_ADMIN_API_KEY && env?.GHOST_WEBHOOK_SECRET),
    ghostActivityPub: Boolean(env?.GHOST_URL && env?.GHOST_STAFF_ACCESS_TOKEN),
    atproto: Boolean(env?.ATPROTO_SERVICE && env?.ATPROTO_IDENTIFIER && env?.ATPROTO_DID && env?.ATPROTO_APP_PASSWORD && env?.PUBLICATION_URI),
    blueskyUpdates: Boolean(env?.BLUESKY_UPDATES_IDENTIFIER && env?.BLUESKY_UPDATES_DID)
  };
}
