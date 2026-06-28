declare global {
  interface SyncSecrets {
    ATPROTO_APP_PASSWORD: string;
    FOURSQUARE_ACCESS_TOKEN?: string;
    FOURSQUARE_CLIENT_ID?: string;
    FOURSQUARE_CLIENT_SECRET?: string;
    GHOST_ADMIN_API_KEY: string;
    GHOST_STAFF_ACCESS_TOKEN: string;
    GHOST_WEBHOOK_SECRET: string;
    SWARM_ACCESS_TOKEN?: string;
  }

  interface SyncBindings extends SyncSecrets {
    ATPROTO_DID: string;
    ATPROTO_IDENTIFIER: string;
    ATPROTO_SERVICE: string;
    BLUESKY_UPDATES_DID?: string;
    BLUESKY_UPDATES_IDENTIFIER?: string;
    CHECKINS_KV?: KVNamespace;
    GHOST_URL: string;
    MEDIA_PDS_DID?: string;
    MEDIA_PDS_SERVICE?: string;
    PUBLICATION_URI: string;
    STANDARD_SITE_SYNC_ENABLED?: string;
  }

  namespace App {
    interface Platform {
      env: Env & SyncBindings;
      context: ExecutionContext;
      caches: CacheStorage;
    }
  }
}

export {};
