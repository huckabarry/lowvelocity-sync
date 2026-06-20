declare global {
  interface SyncSecrets {
    ATPROTO_APP_PASSWORD: string;
    GHOST_ADMIN_API_KEY: string;
    GHOST_WEBHOOK_SECRET: string;
  }

  interface SyncBindings extends SyncSecrets {
    ATPROTO_DID: string;
    ATPROTO_IDENTIFIER: string;
    ATPROTO_SERVICE: string;
    GHOST_URL: string;
    PUBLICATION_URI: string;
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
