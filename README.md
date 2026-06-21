# Low Velocity Sync

A small SvelteKit service deployed to Cloudflare Workers. It provides the
Standard.site publication verification endpoint and Ghost-to-AT Protocol
synchronization service for Low Velocity.

## Current endpoints

- `GET /` — service metadata
- `GET /health` — health check
- `GET /.well-known/site.standard.publication` — canonical Standard.site publication AT-URI
- `POST /webhooks/ghost` — signed Ghost post synchronization webhook

The Worker only handles its configured Cloudflare routes. All other
`lowvelocity.org` traffic continues directly to Ghost.

## Development

```sh
npm install
npm run check
npm run deploy:dry
npm run deploy
```

Secrets must be added with `wrangler secret put`; they do not belong in this
repository or `wrangler.jsonc`.

Pushes to `main` are tested, built, and deployed automatically by GitHub
Actions. The repository must contain `CLOUDFLARE_ACCOUNT_ID` and a narrowly
scoped `CLOUDFLARE_API_TOKEN` as GitHub Actions secrets. Runtime application
secrets remain stored in Cloudflare and are preserved across deployments.

Required secrets:

```sh
npx wrangler secret put GHOST_ADMIN_API_KEY
npx wrangler secret put GHOST_WEBHOOK_SECRET
npx wrangler secret put ATPROTO_APP_PASSWORD
```

Configure four Ghost webhooks with the same target URL and secret:

- `post.published`
- `post.published.edited`
- `post.unpublished`
- `post.deleted`

Target: `https://sync.lowvelocity.org/webhooks/ghost`
