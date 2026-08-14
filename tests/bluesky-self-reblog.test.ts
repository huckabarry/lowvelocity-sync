import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBlueskyFeedItem } from '../src/lib/server/bluesky.ts';
import { ghostInputForBlueskyUpdate } from '../src/lib/server/bluesky-native.ts';

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

test('renders third-party preview images as remote bookmark media', () => {
  const input = ghostInputForBlueskyUpdate({
    uri: `at://${expectedDid}/app.bsky.feed.post/3link`,
    url: 'https://bsky.app/profile/bryan.eurosky.social/post/3link',
    text: 'An interesting link.',
    createdAt: '2026-08-13T20:00:00.000Z',
    author: { did: expectedDid, handle: 'bryan.eurosky.social' },
    counts: { likes: 0, replies: 0, reposts: 0, quotes: 0 },
    embeds: [{
      type: 'external',
      uri: 'https://example.org/story',
      title: 'Example story',
      description: 'A story from another publisher.',
      thumb: 'https://cdn.example.org/story-preview.jpg'
    }]
  });

  assert.match(input.html, /kg-bookmark-card/);
  assert.match(input.html, /https:\/\/cdn\.example\.org\/story-preview\.jpg/);
  assert.doesNotMatch(input.html, /lowvelocity\.org\/content\/images/);
});
