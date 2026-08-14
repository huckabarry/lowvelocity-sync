import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBlueskyFeedItem } from '../src/lib/server/bluesky.ts';

const expectedDid = 'did:plc:updates';

function feedItemWithQuote(quotedDid: string) {
  return {
    post: {
      uri: `at://${expectedDid}/app.bsky.feed.post/3new`,
      cid: 'bafy-new',
      author: {
        did: expectedDid,
        handle: 'bryan.eurosky.social',
        displayName: 'Bryan'
      },
      record: {
        text: 'I keep coming back to this.',
        createdAt: '2026-08-13T20:00:00.000Z'
      },
      embed: {
        record: {
          uri: `at://${quotedDid}/app.bsky.feed.post/3old`,
          cid: 'bafy-old',
          author: {
            did: quotedDid,
            handle: quotedDid === expectedDid ? 'bryan.eurosky.social' : 'someone.example',
            displayName: quotedDid === expectedDid ? 'Bryan' : 'Someone Else'
          },
          value: {
            text: 'The quoted post.',
            createdAt: '2026-08-12T20:00:00.000Z'
          }
        }
      }
    }
  };
}

test('skips self-quote reblogs from the Bluesky-to-Ghost import', () => {
  assert.equal(normalizeBlueskyFeedItem(feedItemWithQuote(expectedDid), expectedDid), null);
});

test('keeps quote posts of other Bluesky users', () => {
  const update = normalizeBlueskyFeedItem(feedItemWithQuote('did:plc:someone-else'), expectedDid);
  assert.ok(update);
  assert.equal(update.text, 'I keep coming back to this.');
  assert.equal(update.embeds[0]?.type, 'quote');
});
