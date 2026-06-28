import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { configurationStatus } from '$lib/server/config';

export const GET: RequestHandler = ({ platform }) => {
  const configured = configurationStatus(platform);
  return json(
    {
      service: 'lowvelocity-sync',
      status: configured.ghost && configured.atproto ? 'ready' : 'configuration-required',
      configured,
      scheduledImports: {
        blueskyNativePosts: {
          cadence: 'every minute',
          source: 'Bluesky appview',
          destination: 'native Ghost posts tagged #bluesky'
        },
        crucialTracks: {
          cadence: 'every 5 minutes',
          source: 'Crucial Tracks feed/archive',
          destination: 'native Ghost posts tagged listening and #crucialtracks'
        },
        checkins: {
          cadence: 'every 15 minutes when Foursquare token verifies',
          source: 'Foursquare/Swarm user check-ins',
          destination: 'native Ghost posts tagged check-ins'
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
