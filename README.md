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
  total attempts (including successful ones) per rolling hour are reserved
  atomically before checking the password. Concurrent requests share one limit.
- PKCE is required, authorization codes expire in 5 minutes and are single-use,
  access tokens last up to 1 hour, and each refresh family has an absolute
  30-day lifetime. Refresh tokens are single-use. Replaying one revokes its
  entire family, including access tokens; the owner must authorize again.
- Tokens are signed with a key derived from `MCP_TOKEN_SECRET` and
  `MCP_OWNER_PASSWORD`. **Changing either secret disconnects every client.**
- Tokens only work on `/mcp`. They cannot call the `/admin/*` routes.
- `MCP_AUTH` is a SQLite-backed Durable Object with transactional login
  reservations, used-code markers, and refresh families. Authentication never
  falls back to Workers KV or process-local state. Missing/unavailable storage
  fails closed. `CHECKINS_KV` remains exclusively for existing sync features.
- SvelteKit's default CSRF checks are enabled. A post-build Worker wrapper
  permits only originless, form-encoded backend POSTs to exactly `/oauth/token`.
  It strips cookies and leaves cross-origin/null-origin requests and the consent
  page protected. `Sec-Fetch-Mode: cors` from Node fetch is supported.

### Turning it on

Production is explicitly disabled by `MCP_ENABLED="false"` in `wrangler.jsonc`.
Do not change it until the staged verification below is complete. Secrets alone
never enable the connector: both valid secrets, `MCP_AUTH`, and the exact string
`MCP_ENABLED="true"` are required. Set secrets once; deployments keep them.

```sh
# A random signing secret (32+ characters)
openssl rand -base64 48 | npx wrangler secret put MCP_TOKEN_SECRET

# A passphrase you will type when connecting (16+ characters)
npx wrangler secret put MCP_OWNER_PASSWORD
```

Or in the Cloudflare dashboard: Workers & Pages → `lowvelocity-sync` →
Settings → Variables and Secrets → Add, type **Secret**, for each name.
Adding a secret in the dashboard takes effect immediately.

`GET /health` reports `configured.mcp: true` only when all requirements are met.
The checked-in false flag intentionally disables MCP on every normal deployment.

Optional variables (in `wrangler.jsonc`):

- `MCP_PUBLIC_ORIGIN` (set to `https://sync.lowvelocity.org`) pins the OAuth
  issuer and token audience, so tokens behave the same on the custom domain
  and `workers.dev`.
- `MCP_ALLOWED_REDIRECT_URIS` overrides the redirect allowlist (comma or space
  separated). The default is Claude's two callbacks:
  `https://claude.ai/api/mcp/auth_callback` and
  `https://claude.com/api/mcp/auth_callback`.

### Verification and deployment requirements

Before merge, run under Node 22:

```sh
npm ci
npm test
npm run check
npm run build
npm run test:integration
npx wrangler deploy --dry-run
```

Tests run actual SQLite Durable Objects in Miniflare, including concurrent login,
code redemption, refresh replay, persistence across runtime restarts, and storage
failure. The built Worker integration checks originless OAuth interoperability,
CSRF rejection, disabled/missing-binding behavior, admin/webhook isolation, and
preservation of the scheduled handler. Existing sync/publishing tests remain in
the suite. CI runs tests, type checks, build, and integration tests before deploy.

Before production enablement:

1. Deploy to a separate staging Worker with its own `MCP_AUTH` namespace, secrets,
   origin, and test Ghost site. Remove production custom-domain routes and cron
   triggers from that staging configuration. The `mcp-auth-v1` migration must
   create `McpAuthState` as a SQLite-backed class; never reuse `CHECKINS_KV`.
2. Verify Claude's real registration, consent, PKCE exchange, refresh, reconnect,
   search/read of posts/pages/drafts, and the real Ghost plaintext/NQL queries.
   Local tests do not establish live Claude/Ghost compatibility.
3. Verify old-token replay rejects both the old token and its descendants, and
   confirm an unrelated grant still works. Strict replay protection deliberately
   rejects retries after a lost refresh response and concurrent client refreshes:
   those require reconnecting. Check Claude handles this acceptably.
4. Confirm the Durable Object migration and binding on production while leaving
   `MCP_ENABLED=false`. Check health and normal import/webhook behavior after the
   disabled deployment. Enable only in a separately reviewed configuration change.

Operational tradeoffs: the global owner limit can be exhausted by an attacker,
preventing new logins for up to an hour; established grants can still refresh.
An edge/WAF limit can reduce this denial-of-service and registration traffic.
Each authenticated MCP request checks the durable family state, adding latency
and storage requests. Monitor availability and costs. Do not restore an old auth
state snapshot or roll back to the vulnerable OAuth code while enabled. Rotate
an MCP secret after state restoration to invalidate potentially resurrected tokens.
Disable with `MCP_ENABLED=false`; rotate either secret to revoke all credentials.
No production secrets or deployment are needed to run the local tests.

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
