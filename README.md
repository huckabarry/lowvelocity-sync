# Low Velocity Sync

Cloudflare Worker/SvelteKit support service for Low Velocity publishing and import workflows.

See `ARCHITECTURE.md` for the source-of-truth overview of publishing flows, schedules, runtime boundaries, and idempotency rules.

## Development

```bash
npm install
npm test
npm run build
```

## Deployment

Production deploys from `main` through GitHub Actions using Wrangler. The Worker is configured by `wrangler.jsonc` and serves `sync.lowvelocity.org`.

## Bluesky imports

The scheduled Bluesky importer mirrors original authored posts into Ghost while skipping replies, native reposts, self-quote/reblog posts, and posts that link back to the source site. Attached images are copied into Ghost so authored media remains durable. Third-party external-link preview thumbnails stay remote so they remain attributable to the linked publisher instead of becoming locally hosted Ghost media.
