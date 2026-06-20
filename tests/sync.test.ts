import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { verifyGhostSignature } from '../src/lib/server/crypto.ts';
import { buildDocumentLinkInjection } from '../src/lib/server/ghost.ts';
import { ghostPostToDocument, htmlToPlainText } from '../src/lib/server/transform.ts';

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
