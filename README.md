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
- `POST /admin/import/popfeed` — protected manual import of canonical Afterword Popfeed media records from the personal PDS as native Ghost posts.
- `POST /admin/cleanup/bluesky` — protected cleanup path for imported Bluesky posts.
- `POST /admin/activitypub/test-note` — protected Ghost Social Web note test endpoint.
- `POST /webhooks/ghost` — signed Ghost post synchronization webhook
- `POST /mcp` — read-only MCP server for Claude custom connectors (OAuth-protected; off until configured, see below)
- `GET /oauth/authorize`, `POST /oauth/token`, `POST /oauth/register` — the OAuth endpoints that protect `/mcp`
- `GET /.well-known/oauth-protected-resource/mcp`, `GET /.well-known/oauth-authorization-server` — OAuth discovery metadata for `/mcp`

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
- Every 3 hours: import newly seen completed/read/watched Popfeed media records
  from the personal PDS into Ghost as books/movies/shows/reading/watching with
  `#popfeed` and `#pds`.
- Event-driven: Ghost webhooks sync eligible longform Ghost posts to
  Standard.site.

Imported/status/listening/check-in/Popfeed media posts are intentionally
excluded from Standard.site sync.

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
Actions (`.github/workflows/ci.yml`). Pull requests run the same tests and
build but do not deploy, so merging a PR is what ships it. The repository must contain `CLOUDFLARE_ACCOUNT_ID` and a narrowly
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

Optional secrets for the read-only MCP connector (see below):

```sh
npx wrangler secret put MCP_TOKEN_SECRET
npx wrangler secret put MCP_OWNER_PASSWORD
```

`CHECKINS_KV` stores the current Foursquare token from OAuth and last-run
operation status for `/health`. It should not store user-facing content.

`MEDIA_PDS_SERVICE` and `MEDIA_PDS_DID` point the Popfeed importer at the
existing personal Afterword media records. They default to
`https://eurosky.social` and `did:plc:vt4k6d3e5rjw65cuzaf3nufq`, but are kept as
explicit Worker vars so the media/shadow PDS does not get confused with the Low
Velocity Standard.site publication PDS.

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

## Read-only MCP connector (Claude)

`https://sync.lowvelocity.org/mcp` lets Claude find and read Low Velocity
content as a custom connector, on any device including the phone apps. It is
read-only: every Ghost call it makes is a `GET` with the existing
`GHOST_ADMIN_API_KEY`, and it has no tools that publish, edit, or delete.

Tools:

| Tool | What it does |
| --- | --- |
| `search_posts` | Find posts by title text, tag, and status (drafts included by default) |
| `get_post` | Read one post in full by id, slug, or site URL, as text or HTML |
| `search_pages` | Same as `search_posts`, for pages |
| `get_page` | Same as `get_post`, for pages |
| `list_tags` | List tags with post counts (public only unless asked) |

### How access is protected

Claude custom connectors support OAuth, so the Worker includes a small OAuth
2.1 server (`src/lib/server/mcp/oauth.ts`):

- Claude registers itself automatically (dynamic client registration), but only
  Claude's own callback URLs are accepted (`MCP_ALLOWED_REDIRECT_URIS`).
- Connecting opens a page on `sync.lowvelocity.org` that asks for the **owner
  passphrase** (`MCP_OWNER_PASSWORD`). Without it, no token is issued. Ten
  wrong attempts in an hour lock the page until the next hour.
- PKCE is required, authorization codes expire in 5 minutes and are single-use,
  access tokens last 1 hour, and refresh tokens last 30 days.
- Tokens are signed with a key derived from `MCP_TOKEN_SECRET` and
  `MCP_OWNER_PASSWORD`. **Changing either secret disconnects every client.**
- Tokens only work on `/mcp`. They cannot call the `/admin/*` routes.
- The only state stored is a "code used" marker and the failed-login counter,
  both short-lived keys in `CHECKINS_KV` under the `mcp:` prefix.

### Turning it on

The connector stays off (all of these routes return 404) until both secrets
exist. Set them once; deployments keep them.

```sh
# A random signing secret (32+ characters)
openssl rand -base64 48 | npx wrangler secret put MCP_TOKEN_SECRET

# A passphrase you will type when connecting (16+ characters)
npx wrangler secret put MCP_OWNER_PASSWORD
```

Or in the Cloudflare dashboard: Workers & Pages → `lowvelocity-sync` →
Settings → Variables and Secrets → Add, type **Secret**, for each name.
Adding a secret in the dashboard takes effect immediately.

`GET /health` reports `"mcp": true` once both are set.

Optional variables (in `wrangler.jsonc`):

- `MCP_PUBLIC_ORIGIN` (set to `https://sync.lowvelocity.org`) pins the OAuth
  issuer and token audience, so tokens behave the same on the custom domain
  and `workers.dev`.
- `MCP_ALLOWED_REDIRECT_URIS` overrides the redirect allowlist (comma or space
  separated). The default is Claude's two callbacks:
  `https://claude.ai/api/mcp/auth_callback` and
  `https://claude.com/api/mcp/auth_callback`.

### Connecting Claude

1. In Claude, open Settings → Connectors → Add custom connector.
2. Name it (for example "Low Velocity") and enter
   `https://sync.lowvelocity.org/mcp`. Leave the advanced OAuth fields empty.
3. Select Connect. A Low Velocity page opens; enter the owner passphrase and
   choose Allow.

To disconnect everything at once, change `MCP_OWNER_PASSWORD`.

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

curl -X POST https://sync.lowvelocity.org/admin/import/popfeed \
  -H "Authorization: Bearer $GHOST_STAFF_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true,"limit":50,"maxPages":20}'
```

The `Import Popfeed media to Ghost` GitHub Action calls the Popfeed endpoint in
batches using `offset` / `nextOffset`, so it can backfill the whole importable
set while keeping each Worker request small.

To reconnect Foursquare, visit:

```txt
https://sync.lowvelocity.org/admin/checkins/connect
```

To temporarily stop publishing Ghost posts to Standard.site, set
`STANDARD_SITE_SYNC_ENABLED=false` as a Worker variable and redeploy.
