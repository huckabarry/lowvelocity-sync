import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { verifyGhostSignature } from '../src/lib/server/crypto.ts';
import { buildDocumentLinkInjection } from '../src/lib/server/ghost.ts';
import { ghostPostToDocument, htmlToPlainText } from '../src/lib/server/transform.ts';
import { normalizeBlueskyFeedItem } from '../src/lib/server/bluesky.ts';

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
