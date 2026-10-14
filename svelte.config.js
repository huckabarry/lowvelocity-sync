import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    csrf: {
      // OAuth token requests (/oauth/token) are form-encoded server-to-server
      // POSTs that usually carry no Origin header, which SvelteKit's origin
      // check rejects. Nothing in this app authenticates with cookies (admin
      // routes use bearer tokens, webhooks use signatures, and the OAuth
      // consent form requires the owner passphrase), so the check protects
      // nothing here and is disabled.
      trustedOrigins: ['*']
    }
  }
};

export default config;
