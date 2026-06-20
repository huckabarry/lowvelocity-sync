import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { configurationStatus } from '$lib/server/config';

export const GET: RequestHandler = ({ platform }) => {
  const configured = configurationStatus(platform);
  return json(
    {
      service: 'lowvelocity-sync',
      status: configured.ghost && configured.atproto ? 'ready' : 'configuration-required',
      configured
    },
    {
      headers: {
        'cache-control': 'no-store'
      }
    }
  );
};
