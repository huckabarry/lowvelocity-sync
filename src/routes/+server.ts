import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
  return json(
    {
      service: 'lowvelocity-sync',
      status: 'ok',
      publication: 'at://did:plc:peshyp24p4yyoaz3zdsppp3e/site.standard.publication/3mgwfts634r2z'
    },
    {
      headers: {
        'cache-control': 'no-store'
      }
    }
  );
};
