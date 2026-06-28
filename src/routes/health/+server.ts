import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { configurationStatus } from '$lib/server/config';
import { readOpsStatuses } from '$lib/server/ops-status';

export const GET: RequestHandler = async ({ platform }) => {
  const configured = configurationStatus(platform);
  const operations = await readOpsStatuses(platform);

  return json(
    {
      service: 'lowvelocity-sync',
      status: configured.ghost && configured.atproto ? 'ready' : 'configuration-required',
      configured,
      operations,
      scheduledImports: {
        blueskyNativePosts: {
          cadence: 'every minute',
          source: 'Bluesky appview',
          destination: 'native Ghost posts tagged #bluesky',
          last: operations.last.bluesky
        },
        crucialTracks: {
          cadence: 'every 5 minutes',
          source: 'Crucial Tracks feed/archive',
          destination: 'native Ghost posts tagged listening and #crucialtracks',
          last: operations.last.crucialTracks
        },
        checkins: {
          cadence: 'every 15 minutes when Foursquare token verifies',
          source: 'Foursquare/Swarm user check-ins',
          destination: 'native Ghost posts tagged check-ins',
          last: operations.last.checkins
        },
        popfeedMedia: {
          cadence: 'every 3 hours',
          source: 'canonical Afterword Popfeed records on the personal PDS',
          destination: 'native Ghost posts tagged #popfeed and excluded from Standard.site',
          last: operations.last.popfeed
        },
        ghostWebhook: {
          cadence: 'event-driven from Ghost webhooks',
          source: 'Ghost Admin webhook events',
          destination: 'Standard.site document records for eligible posts',
          last: operations.last.ghostWebhook
        }
      }
    },
    {
      headers: {
        'cache-control': 'no-store'
      }
    }
  );
};
