# Low Velocity Sync

A small SvelteKit service deployed to Cloudflare Workers. It is the ingestion
and syndication layer for Low Velocity, while Ghost remains the canonical local
archive and rendering source.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full operating model.

## Current endpoints

- `GET /` — service metadata
- `GET /health` — config and last-run health check. Does not expose secrets.
- `GET /.well-known/site.standard.publication` — canonical Standard.site publication AT-URI
- `GET /updates/bluesky` — cached, normalized recent Bluesky updates for theme display. This can use a different Bluesky identity than the Standard.site publishing account.
- `GET /admin/checkins/connect` — starts the Foursquare OAuth flow and redirects to Foursquare.
- `GET /admin/checkins/callback` — receives the Foursquare OAuth code and returns an access token to save as a Cloudflare secret.
- `POST /admin/import/bluesky` — protected manual import of Bluesky posts as native Ghost posts.
- `POST /admin/import/crucial-tracks` — protected manual import of Crucial Tracks as native Ghost posts.
- `POST /admin/import/checkins` — protected manual import of Swarm/Foursquare check-ins as native Ghost posts.
- `POST /admin/import/checkins-pds` — protected manual import of archived PDS check-ins as native Ghost posts.
- `POST /admin/cleanup/bluesky` — protected cleanup path for imported Bluesky posts.
- `POST /admin/activitypub/test-note` — protected Ghost Social Web note test endpoint.
- `POST /webhooks/ghost` — signed Ghost post synchronization webhook

The Worker only handles its configured Cloudflare routes. All other
`lowvelocity.org` traffic continues directly to Ghost.

## Automatic jobs

Cloudflare invokes the Worker every minute via `wrangler.jsonc`. A post-build
patch in `scripts/patch-scheduled-worker.mjs` adds the scheduled handler to the
SvelteKit-generated Worker and fails the build if the patch is missing. The
scheduled handler dispatches to the same protected admin import routes
internally through the generated Worker `fetch()` handler; it does not call
`sync.lowvelocity.org` over public HTTP. `npm run build` also syntax-checks the
patched Worker file before deployment.

- Every minute: import new Bluesky posts from `bryan.eurosky.social` into Ghost
  as `updates`, `#bluesky`, and `#atproto`.
- Every 5 minutes: import newest Crucial Tracks into Ghost as `listening` and
  `#crucialtracks`.
- Every 15 minutes: import newest Foursquare/Swarm check-ins into Ghost as
  `check-ins`, `#swarm`, and `#foursquare` when a token is available.
- Event-driven: Ghost webhooks sync eligible longform Ghost posts to
  Standard.site.

Imported/status/listening/check-in posts are intentionally excluded from
Standard.site sync.

## Development

```sh
npm install
npm test
npm run check
npm run build
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
npx wrangler secret put GHOST_STAFF_ACCESS_TOKEN
npx wrangler secret put GHOST_WEBHOOK_SECRET
npx wrangler secret put ATPROTO_APP_PASSWORD
npx wrangler secret put FOURSQUARE_CLIENT_ID
npx wrangler secret put FOURSQUARE_CLIENT_SECRET
npx wrangler secret put FOURSQUARE_ACCESS_TOKEN
```

`CHECKINS_KV` stores the current Foursquare token from OAuth and last-run
operation status for `/health`. It should not store user-facing content.

The Foursquare developer console redirect URL should be:

```txt
https://sync.lowvelocity.org/admin/checkins/callback
```

Configure four Ghost webhooks with the same target URL and secret:

- `post.published`
- `post.published.edited`
- `post.unpublished`
- `post.deleted`

Target: `https://sync.lowvelocity.org/webhooks/ghost`

## Manual operations

All protected admin endpoints use:

```txt
Authorization: Bearer $GHOST_STAFF_ACCESS_TOKEN
Content-Type: application/json
```

Examples:

```sh
curl -X POST https://sync.lowvelocity.org/admin/import/bluesky \
  -H "Authorization: Bearer $GHOST_STAFF_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false,"limit":10,"maxPages":2,"sinceTag":"#bluesky"}'

curl -X POST https://sync.lowvelocity.org/admin/import/crucial-tracks \
  -H "Authorization: Bearer $GHOST_STAFF_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false,"limit":3,"order":"desc"}'

curl -X POST https://sync.lowvelocity.org/admin/import/checkins \
  -H "Authorization: Bearer $GHOST_STAFF_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false,"limit":20,"maxPages":2,"sinceTag":"check-ins"}'
```

To reconnect Foursquare, visit:

```txt
https://sync.lowvelocity.org/admin/checkins/connect
```

To temporarily stop publishing Ghost posts to Standard.site, set
`STANDARD_SITE_SYNC_ENABLED=false` as a Worker variable and redeploy.
