# Low Velocity Publishing Architecture

Low Velocity is built around a simple principle: Ghost is the canonical local
archive. External services feed Ghost or receive selected Ghost content, but the
public site should keep rendering from local Ghost posts if those services go
down.

## Repositories and responsibilities

- `huckabarry/lowvelocity` controls the Ghost theme, routes, templates, and
  client-side presentation for `lowvelocity.org`.
- `huckabarry/lowvelocity-sync` controls `sync.lowvelocity.org`, a SvelteKit app
  deployed as a Cloudflare Worker.
- Ghost stores and serves the native posts, pages, images, memberships,
  comments, RSS, JSON feeds, and theme-rendered pages.

## Automatic flows

| Flow | Trigger | Source | Destination | Tags / records |
| --- | --- | --- | --- | --- |
| Ghost longform to Standard.site | Ghost webhook | Eligible Ghost posts | ATProto PDS | `site.standard.document` |
| Bluesky to Ghost updates | Worker cron every minute | `bryan.eurosky.social` | Native Ghost posts | `updates`, `#bluesky`, `#atproto` |
| Crucial Tracks to Ghost listening | Worker cron every 5 minutes | Crucial Tracks feed/archive | Native Ghost posts | `listening`, `#crucialtracks` |
| Foursquare/Swarm to Ghost check-ins | Worker cron every 15 minutes | Foursquare user check-ins | Native Ghost posts | `check-ins`, `#swarm`, `#foursquare` |

Imported Bluesky, Crucial Tracks, and check-in posts are intentionally excluded
from Standard.site sync. The exclusion list lives in `src/lib/server/sync.ts`.

## Manual flows

- GitHub Actions can manually call the Bluesky, Crucial Tracks, Foursquare, PDS
  check-in, cleanup, and ActivityPub test endpoints.
- Backfills should use manual workflows or protected admin endpoints with small
  batches.
- The Ghost theme deploys from `huckabarry/lowvelocity`; this Worker deploys
  from `huckabarry/lowvelocity-sync`.

## Runtime boundaries

- The Worker only handles `sync.lowvelocity.org`.
- `lowvelocity.org` itself remains Ghost-hosted.
- `/.well-known/site.standard.publication` is also exposed from the Worker and
  represented in the Ghost theme routes for publication verification.
- The theme should avoid live external API dependencies for page rendering.
  Imported content should be local Ghost content whenever possible.

## Configuration and secrets

Non-secret config lives in `wrangler.jsonc`:

- Ghost URL
- ATProto service, DID, identifier, and publication URI
- Bluesky updates identity
- Standard.site sync enablement
- Worker cron cadence
- `CHECKINS_KV` binding

Secrets live in Cloudflare and GitHub Actions, never in source:

- `GHOST_ADMIN_API_KEY`
- `GHOST_STAFF_ACCESS_TOKEN`
- `GHOST_WEBHOOK_SECRET`
- `ATPROTO_APP_PASSWORD`
- `FOURSQUARE_CLIENT_ID`
- `FOURSQUARE_CLIENT_SECRET`
- `FOURSQUARE_ACCESS_TOKEN` or stored OAuth token in `CHECKINS_KV`

GitHub Actions also needs `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` to deploy.

## Health and operations status

`GET /health` returns:

- configuration readiness flags
- expected scheduled import cadences
- last-run status for Bluesky, Crucial Tracks, Foursquare check-ins, and Ghost
  webhooks when `CHECKINS_KV` is available

The last-run records are deliberately small summaries. They avoid secrets and
avoid storing full imported content.

## Scheduled Worker implementation

SvelteKit generates the Cloudflare Worker file during `vite build`. The project
currently patches that generated file in `scripts/patch-scheduled-worker.mjs` to
add a `scheduled()` handler after build.

This is not as elegant as a first-class source-level scheduled handler, but it
keeps the current SvelteKit Worker working with Cloudflare cron triggers. The
patch script now verifies that the generated Worker contains the scheduled
handler and all three import calls, so future build shape changes fail loudly.

If this is refactored later, preserve these behaviors:

- Bluesky import every minute.
- Crucial Tracks import only when UTC minute is divisible by 5.
- Check-ins import only when UTC minute is divisible by 15.
- Missing Foursquare tokens should skip check-ins, not fail the whole cron.
- Individual importer endpoint failures should not prevent the other scheduled
  imports from running.

## Failure modes

- Ghost down: imports and Standard.site sync fail, but existing Ghost-hosted
  pages are whatever Ghost can serve.
- Cloudflare Worker down: new imports and Standard.site webhooks stop, but
  Ghost-local content remains visible.
- Bluesky down: new status imports stop; existing status posts remain local.
- Crucial Tracks down: new listening imports stop; existing listening posts
  remain local.
- Foursquare down or token invalid: new check-ins stop; existing check-ins and
  maps remain local.
- ATProto/Standard.site down: Ghost publishing continues; Standard.site records
  may need retry/backfill later.

## Idempotency rules

- Bluesky post slugs are based on the ATProto post rkey.
- Foursquare check-in slugs include the check-in source ID.
- Crucial Tracks slugs are derived from track metadata.
- Standard.site documents reuse an existing document rkey when one is already
  linked in Ghost code injection; otherwise they use the Ghost post ID.

All importers should be safe to rerun. Existing posts should be skipped unless
`updateExisting` is explicitly true.
