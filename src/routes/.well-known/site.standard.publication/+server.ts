import type { RequestHandler } from './$types';

const PUBLICATION_URI =
  'at://did:plc:peshyp24p4yyoaz3zdsppp3e/site.standard.publication/3mgwfts634r2z';

export const GET: RequestHandler = () => {
  return new Response(`${PUBLICATION_URI}\n`, {
    headers: {
      'cache-control': 'public, max-age=300',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff'
    }
  });
};
