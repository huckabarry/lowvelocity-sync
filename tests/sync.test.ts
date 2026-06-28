import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { verifyGhostSignature } from '../src/lib/server/crypto.ts';
import { buildDocumentLinkInjection, findLatestGhostPostByTag } from '../src/lib/server/ghost.ts';
import { ghostPostToDocument, htmlToPlainText } from '../src/lib/server/transform.ts';
import { normalizeBlueskyFeedItem } from '../src/lib/server/bluesky.ts';
import { ghostInputForBlueskyUpdate } from '../src/lib/server/bluesky-native.ts';
import { cleanBlueskyPostHtml } from '../src/lib/server/bluesky-cleanup.ts';
import { ghostInputForSwarmCheckin } from '../src/lib/server/checkins-native.ts';
import { ghostInputForPopfeedItem, type PopfeedImportItem } from '../src/lib/server/popfeed-native.ts';
import { buildFoursquareAuthorizationUrl, createFoursquareOAuthState, verifyFoursquareOAuthState } from '../src/lib/server/foursquare-oauth.ts';
import { summarizeResult } from '../src/lib/server/ops-status.ts';
import type { SyncConfig } from '../src/lib/server/config.ts';

const baseConfig: SyncConfig = {
  ghostUrl: 'https://lowvelocity.org',
  ghostAdminApiKey: 'id:0123456789abcdef',
  ghostStaffAccessToken: 'staff-token',
  ghostWebhookSecret: 'webhook-secret',
  atprotoService: 'https://bsky.social',
  atprotoIdentifier: 'lowvelocity.org',
  atprotoDid: 'did:plc:test',
  blueskyUpdatesIdentifier: 'bryan.eurosky.social',
  blueskyUpdatesDid: 'did:plc:updates',
  mediaPdsService: 'https://eurosky.social',
  mediaPdsDid: 'did:plc:media',
  foursquareClientId: 'client-id',
  foursquareClientSecret: 'client-secret',
  atprotoAppPassword: 'app-password',
  publicationUri: 'at://did:plc:test/site.standard.publication/self',
  standardSiteSyncEnabled: true
};

test('transforms a Ghost post into a Standard.site document', () => {
  const record = ghostPostToDocument({
    id: '65f000000000000000000001',
    slug: 'hello-world',
    title: 'Hello World',
    status: 'published',
    url: 'https://lowvelocity.org/notes/hello-world/',
    published_at: '2026-06-20T12:00:00.000Z',
    updated_at: '2026-06-20T13:00:00.000Z',
    custom_excerpt: 'A short introduction.',
    html: '<p>Hello <strong>world</strong> &amp; friends.</p>',
    tags: [{ name: 'Travel' }, { name: '#internal', visibility: 'internal' }]
  }, 'at://did:plc:test/site.standard.publication/self');

  assert.equal(record.path, '/notes/hello-world/');
  assert.equal(record.textContent, 'Hello world & friends.');
  assert.deepEqual(record.tags, ['Travel']);
  assert.equal(record.updatedAt, '2026-06-20T13:00:00.000Z');
});

test('plain text conversion removes scripts and preserves paragraph boundaries', () => {
  assert.equal(htmlToPlainText('<p>One</p><script>bad()</script><p>Two<br>Three</p>'), 'One\nTwo\nThree');
});

test('document verification injection is idempotent and preserves existing code', () => {
  const uri = 'at://did:plc:abc/site.standard.document/65f000000000000000000001';
  const first = buildDocumentLinkInjection('<meta name="x" content="y">', uri);
  const second = buildDocumentLinkInjection(first, uri);
  assert.equal(second, first);
  assert.match(first, /rel="site\.standard\.document"/);
  assert.match(first, /meta name="x"/);
});

test('verifies Ghost HMAC signatures and rejects modified payloads', async () => {
  const body = new TextEncoder().encode('{"post":{"current":{"id":"65f000000000000000000001"}}}');
  const secret = 'test-webhook-secret';
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const digest = createHmac('sha256', secret).update(body).update(timestamp).digest('hex');
  const header = `sha256=${digest}, t=${timestamp}`;
  assert.equal(await verifyGhostSignature(body, header, secret, now), true);
  assert.equal(await verifyGhostSignature(new TextEncoder().encode('changed'), header, secret, now), false);
  const bodyOnlyDigest = createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(await verifyGhostSignature(body, `sha256=${bodyOnlyDigest}, t=${timestamp}`, secret, now), true);
});

test('normalizes authored Bluesky posts and preserves embeds', () => {
  const update = normalizeBlueskyFeedItem({
    post: {
      uri: 'at://did:plc:test/app.bsky.feed.post/3abc',
      cid: 'bafy',
      author: { did: 'did:plc:test', handle: 'lowvelocity.org', displayName: 'Low Velocity' },
      record: { text: 'A small update.', createdAt: '2026-06-23T12:00:00.000Z' },
      embed: {
        images: [{
          fullsize: 'https://cdn.example/image.webp',
          thumb: 'https://cdn.example/thumb.webp',
          alt: 'Alt text',
          aspectRatio: { width: 1200, height: 800 }
        }],
        external: {
          uri: 'https://lowvelocity.org/post/',
          title: 'A linked post',
          description: 'Preview text.',
          thumb: 'https://cdn.example/preview.webp'
        },
        playlist: 'https://video.bsky.app/watch/playlist.m3u8',
        thumbnail: 'https://video.bsky.app/poster.jpg',
        alt: 'A short video',
        $type: 'app.bsky.embed.video#view'
      },
      likeCount: 1
    }
  }, 'did:plc:test');

  assert.equal(update?.url, 'https://bsky.app/profile/lowvelocity.org/post/3abc');
  assert.equal(update?.text, 'A small update.');
  assert.equal(update?.counts.likes, 1);
  assert.equal(update?.embeds.length, 3);
  assert.equal(update?.embeds[0].type, 'image');
  assert.equal(update?.embeds[1].type, 'external');
  assert.equal(update?.embeds[2].type, 'video');
});

test('skips Bluesky reposts, replies, and other authors', () => {
  assert.equal(normalizeBlueskyFeedItem({
    reason: { $type: 'app.bsky.feed.defs#reasonRepost' },
    post: {
      uri: 'at://did:plc:test/app.bsky.feed.post/3abc',
      author: { did: 'did:plc:test', handle: 'lowvelocity.org' },
      record: { text: 'Repost', createdAt: '2026-06-23T12:00:00.000Z' }
    }
  }, 'did:plc:test'), null);

  assert.equal(normalizeBlueskyFeedItem({
    post: {
      uri: 'at://did:plc:test/app.bsky.feed.post/3abc',
      author: { did: 'did:plc:test', handle: 'lowvelocity.org' },
      record: { text: 'Reply', createdAt: '2026-06-23T12:00:00.000Z', reply: {} }
    }
  }, 'did:plc:test'), null);

  assert.equal(normalizeBlueskyFeedItem({
    post: {
      uri: 'at://did:plc:other/app.bsky.feed.post/3abc',
      author: { did: 'did:plc:other', handle: 'someone.example' },
      record: { text: 'Other author', createdAt: '2026-06-23T12:00:00.000Z' }
    }
  }, 'did:plc:test'), null);
});

test('builds idempotent native Ghost input for Bluesky posts', () => {
  const input = ghostInputForBlueskyUpdate({
    uri: 'at://did:plc:test/app.bsky.feed.post/3mpbzshd77i2o',
    cid: 'bafy',
    url: 'https://bsky.app/profile/bryan.eurosky.social/post/3mpbzshd77i2o',
    text: 'A short note with https://lowvelocity.org/link/',
    createdAt: '2026-06-27T17:41:00.000Z',
    author: { did: 'did:plc:test', handle: 'bryan.eurosky.social' },
    counts: { likes: 1, replies: 2, reposts: 3, quotes: 4 },
    embeds: [{
      type: 'image',
      url: 'https://cdn.example/photo.jpg',
      alt: 'A photo',
      width: 1200,
      height: 800
    }, {
      type: 'external',
      uri: 'https://example.com/article',
      title: 'Article title',
      description: 'Article description',
      thumb: 'https://cdn.example/article.jpg'
    }, {
      type: 'external',
      uri: 'https://media.example/animated.gif',
      title: 'Animated GIF',
      description: 'A dancing GIF',
      thumb: 'https://media.example/animated.gif'
    }, {
      type: 'video',
      playlist: 'https://video.bsky.app/watch/playlist.m3u8',
      thumbnail: 'https://cdn.example/poster.jpg',
      alt: 'A short video',
      width: 1280,
      height: 720
    }, {
      type: 'quote',
      uri: 'at://did:plc:quote/app.bsky.feed.post/3quote',
      cid: 'bafyquote',
      author: {
        did: 'did:plc:quote',
        handle: 'quoted.example',
        displayName: 'Quoted Person'
      },
      text: 'A quoted post with media.',
      createdAt: '2026-06-27T17:40:00.000Z',
      embeds: [{
        type: 'image',
        url: 'https://cdn.example/quote-photo.jpg',
        alt: 'Quoted photo',
        width: 900,
        height: 600
      }, {
        type: 'external',
        uri: 'https://example.com/quoted-article',
        title: 'Quoted article',
        description: 'Quoted article description',
        thumb: 'https://cdn.example/quoted-article.jpg'
      }]
    }]
  });

  assert.equal(input.slug, 'bsky-3mpbzshd77i2o');
  assert.equal(input.feature_image, null);
  assert.equal(input.custom_excerpt, null);
  assert.deepEqual(input.tags, [{ name: 'updates' }, { name: '#bluesky' }, { name: '#atproto' }]);
  assert.match(input.html, /data-atproto-uri="at:\/\/did:plc:test\/app.bsky.feed.post\/3mpbzshd77i2o"/);
  assert.match(input.html, /href="https:\/\/lowvelocity.org\/link\/"/);
  assert.match(input.html, /class="kg-card kg-bookmark-card lv-atproto-card"/);
  assert.match(input.html, /class="kg-bookmark-thumbnail"><img src="https:\/\/cdn\.example\/article\.jpg"/);
  assert.match(input.html, /class="kg-image status-external-gif" src="https:\/\/media\.example\/animated\.gif"/);
  assert.match(input.html, /class="kg-card kg-video-card lv-atproto-video status-video"/);
  assert.match(input.html, /<blockquote cite="https:\/\/bsky\.app\/profile\/quoted\.example\/post\/3quote" class="lv-atproto-quote">/);
  assert.match(input.html, /Quoted Person/);
  assert.match(input.html, /https:\/\/cdn\.example\/quote-photo\.jpg/);
  assert.match(input.html, /https:\/\/cdn\.example\/quoted-article\.jpg/);
  assert.doesNotMatch(input.html, /View on Bluesky/);
  assert.doesNotMatch(input.html, /<code>at:\/\//);
});

test('builds idempotent native Ghost input for Swarm check-ins', () => {
  const input = ghostInputForSwarmCheckin({
    id: 'abc123',
    createdAt: 1782608400,
    shout: 'Great noodles by the river.',
    venue: {
      id: 'venue123',
      name: 'Kizuki Ramen',
      location: {
        address: '123 Main St',
        city: 'Portland',
        state: 'OR',
        country: 'United States',
        lat: 45.52,
        lng: -122.67
      },
      categories: [{ name: 'Ramen Restaurant', primary: true }]
    },
    photos: {
      items: [{ prefix: 'https://fastly.example/photo/', suffix: '.jpg' }]
    }
  });

  assert.equal(input.slug, 'checkin-kizuki-ramen-abc123');
  assert.equal(input.title, 'Checked in at Kizuki Ramen');
  assert.equal(input.feature_image, null);
  assert.deepEqual(input.tags, [{ name: 'check-ins' }, { name: '#swarm' }, { name: '#foursquare' }]);
  assert.match(input.html, /data-checkin-source="swarm"/);
  assert.match(input.html, /data-checkin-id="abc123"/);
  assert.match(input.html, /Great noodles by the river\./);
  assert.match(input.html, /https:\/\/fastly\.example\/photo\/original\.jpg/);
});

test('builds idempotent native Ghost input for Popfeed media records', () => {
  const item: PopfeedImportItem = {
    uri: 'at://did:plc:media/blog.afterword.media.popfeedItem/3abc',
    cid: 'bafy',
    sourceUri: 'at://did:plc:media/social.popfeed.feed.listItem/3abc',
    sourceRkey: '3abc',
    type: 'book',
    title: 'The City & Its Uncertain Life',
    mainCredit: 'Jane Planner',
    mainCreditRole: 'Author',
    genres: ['Urbanism', 'Design'],
    listType: 'read_books',
    listName: 'Read',
    identifiers: { isbn13: '9781234567890' },
    activityLabel: 'Finished reading',
    activityAt: '2026-06-20T12:00:00.000Z',
    posterImage: 'https://eurosky.social/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Amedia&cid=bafycover',
    sourcePosterImage: null,
    overrideStatus: 'approved',
    links: [{ label: 'Open Library', url: 'https://openlibrary.org/isbn/9781234567890' }]
  };
  const input = ghostInputForPopfeedItem(item, 'https://lowvelocity.org/content/images/city.jpg');

  assert.equal(input.slug, 'book-the-city-and-its-uncertain-life-3abc');
  assert.equal(input.title, 'The City & Its Uncertain Life');
  assert.equal(input.feature_image, 'https://lowvelocity.org/content/images/city.jpg');
  assert.equal(input.published_at, '2026-06-20T12:00:00.000Z');
  assert.deepEqual(input.tags, [{ name: 'books' }, { name: 'reading' }, { name: '#popfeed' }, { name: '#pds' }]);
  assert.match(input.html, /data-popfeed-source-uri="at:\/\/did:plc:media\/social\.popfeed\.feed\.listItem\/3abc"/);
  assert.match(input.html, /Finished reading/);
  assert.match(input.html, /Jane Planner/);
  assert.match(input.html, /Open Library/);
});

test('builds Foursquare OAuth authorization URL with the lowvelocity callback', async () => {
  const url = new URL(await buildFoursquareAuthorizationUrl(baseConfig, new URL('https://sync.lowvelocity.org/admin/checkins/connect')));
  assert.equal(url.origin + url.pathname, 'https://foursquare.com/oauth2/authenticate');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://sync.lowvelocity.org/admin/checkins/callback');
  assert.equal(url.searchParams.get('state'), null);
});

test('can build Foursquare token fallback URL', async () => {
  const url = new URL(await buildFoursquareAuthorizationUrl(baseConfig, new URL('https://sync.lowvelocity.org/admin/checkins/connect'), { responseType: 'token' }));
  assert.equal(url.origin + url.pathname, 'https://foursquare.com/oauth2/authenticate');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('response_type'), 'token');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://sync.lowvelocity.org/admin/checkins/callback');
});

test('validates Foursquare OAuth state for the same callback only', async () => {
  const redirectUri = 'https://sync.lowvelocity.org/admin/checkins/callback';
  const state = await createFoursquareOAuthState(baseConfig, redirectUri, 1782608400000);
  assert.equal(await verifyFoursquareOAuthState(baseConfig, state, redirectUri, 1782608400000), true);
  assert.equal(await verifyFoursquareOAuthState(baseConfig, state, 'https://sync.afterword.blog/admin/checkins/callback', 1782608400000), false);
  assert.equal(await verifyFoursquareOAuthState(baseConfig, state, redirectUri, 1782608400000 + 16 * 60 * 1000), false);
});

test('cleans visible Bluesky source block from imported Bluesky HTML', () => {
  const html = '<article data-atproto-uri="at://did:plc:test/app.bsky.feed.post/3abc"><p>Hello.</p><p class="lv-atproto-source"><a href="https://bsky.app/profile/example.test/post/3abc">View on Bluesky</a><span aria-hidden="true"> · </span><code>at://did:plc:test/app.bsky.feed.post/3abc</code></p></article>';
  const cleaned = cleanBlueskyPostHtml(html);
  assert.match(cleaned, /data-atproto-uri="at:\/\/did:plc:test\/app.bsky.feed.post\/3abc"/);
  assert.doesNotMatch(cleaned, /View on Bluesky/);
  assert.doesNotMatch(cleaned, /<code>at:\/\//);
  assert.doesNotMatch(cleaned, /lv-atproto-source/);
});

test('cleans Ghost-normalized visible Bluesky source block', () => {
  const html = '<p>Hello.</p><p><a href="https://bsky.app/profile/bryan.eurosky.social/post/3abc?ref=lowvelocity.org" rel="syndication external noopener">View on Bluesky</a> · <code>at://did:plc:test/app.bsky.feed.post/3abc</code></p>';
  const cleaned = cleanBlueskyPostHtml(html);
  assert.match(cleaned, /<p>Hello\.<\/p>/);
  assert.doesNotMatch(cleaned, /View on Bluesky/);
  assert.doesNotMatch(cleaned, /bsky\.app/);
  assert.doesNotMatch(cleaned, /<code>at:\/\//);
});

test('finds latest Ghost posts by public and internal tag slugs', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify({
      posts: [{
        id: 'post-id',
        slug: 'latest-status',
        title: 'Latest status',
        status: 'published',
        url: 'https://lowvelocity.org/latest-status/',
        published_at: '2026-06-27T12:00:00.000Z',
        updated_at: '2026-06-27T12:01:00.000Z'
      }]
    }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    const config = {
      ghostUrl: 'https://lowvelocity.org',
      ghostAdminApiKey: `id:${'a'.repeat(64)}`,
      ghostWebhookSecret: 'secret',
      atprotoService: 'https://bsky.social',
      atprotoIdentifier: 'example.test',
      atprotoDid: 'did:plc:test',
      blueskyUpdatesIdentifier: 'example.test',
      blueskyUpdatesDid: 'did:plc:test',
      mediaPdsService: 'https://eurosky.social',
      mediaPdsDid: 'did:plc:media',
      atprotoAppPassword: 'password',
      publicationUri: 'at://did:plc:test/site.standard.publication/self',
      standardSiteSyncEnabled: true
    };
    await findLatestGhostPostByTag({
      ...config
    }, 'Afterword');
    await findLatestGhostPostByTag({
      ...config
    }, '#Bluesky');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(calls[0], /filter=tag%3Aafterword%2Bstatus%3Apublished/);
  assert.match(calls[1], /filter=tag%3Ahash-bluesky%2Bstatus%3Apublished/);
});

test('summarizes operation results without storing imported content', () => {
  const summary = summarizeResult({
    source: 'bluesky',
    fetchedAt: '2026-06-28T12:00:00.000Z',
    totalFetched: 3,
    processed: 3,
    secret: 'do-not-include',
    results: [
      { action: 'created', title: 'One', html: '<p>Large content</p>' },
      { action: 'exists', title: 'Two' },
      { action: 'exists', title: 'Three' }
    ]
  });

  assert.deepEqual(summary, {
    source: 'bluesky',
    fetchedAt: '2026-06-28T12:00:00.000Z',
    totalFetched: 3,
    processed: 3,
    'action.created': 1,
    'action.exists': 2
  });
});
