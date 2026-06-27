import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { verifyGhostSignature } from '../src/lib/server/crypto.ts';
import { buildDocumentLinkInjection, findLatestGhostPostByTag } from '../src/lib/server/ghost.ts';
import { ghostPostToDocument, htmlToPlainText } from '../src/lib/server/transform.ts';
import { normalizeBlueskyFeedItem } from '../src/lib/server/bluesky.ts';
import { ghostInputForBlueskyUpdate } from '../src/lib/server/bluesky-native.ts';
import { cleanBlueskyPostHtml } from '../src/lib/server/bluesky-cleanup.ts';

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
        }
      },
      likeCount: 1
    }
  }, 'did:plc:test');

  assert.equal(update?.url, 'https://bsky.app/profile/lowvelocity.org/post/3abc');
  assert.equal(update?.text, 'A small update.');
  assert.equal(update?.counts.likes, 1);
  assert.equal(update?.embeds.length, 2);
  assert.equal(update?.embeds[0].type, 'image');
  assert.equal(update?.embeds[1].type, 'external');
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
    }]
  });

  assert.equal(input.slug, 'bsky-3mpbzshd77i2o');
  assert.equal(input.feature_image, null);
  assert.equal(input.custom_excerpt, null);
  assert.deepEqual(input.tags, [{ name: 'updates' }, { name: '#bluesky' }, { name: '#atproto' }]);
  assert.match(input.html, /data-atproto-uri="at:\/\/did:plc:test\/app.bsky.feed.post\/3mpbzshd77i2o"/);
  assert.match(input.html, /href="https:\/\/lowvelocity.org\/link\/"/);
  assert.doesNotMatch(input.html, /View on Bluesky/);
  assert.doesNotMatch(input.html, /<code>at:\/\//);
});

test('cleans visible Bluesky source block from imported Bluesky HTML', () => {
  const html = '<article data-atproto-uri="at://did:plc:test/app.bsky.feed.post/3abc"><p>Hello.</p><p class="lv-atproto-source"><a href="https://bsky.app/profile/example.test/post/3abc">View on Bluesky</a><span aria-hidden="true"> · </span><code>at://did:plc:test/app.bsky.feed.post/3abc</code></p></article>';
  const cleaned = cleanBlueskyPostHtml(html);
  assert.match(cleaned, /data-atproto-uri="at:\/\/did:plc:test\/app.bsky.feed.post\/3abc"/);
  assert.doesNotMatch(cleaned, /View on Bluesky/);
  assert.doesNotMatch(cleaned, /<code>at:\/\//);
  assert.doesNotMatch(cleaned, /lv-atproto-source/);
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
