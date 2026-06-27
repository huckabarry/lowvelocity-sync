import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSyncConfig } from '$lib/server/config';
import { buildFoursquareAuthorizationUrl } from '$lib/server/foursquare-oauth';

export const GET: RequestHandler = async ({ platform, url }) => {
  const config = getSyncConfig(platform);
  throw redirect(302, await buildFoursquareAuthorizationUrl(config, url));
};

