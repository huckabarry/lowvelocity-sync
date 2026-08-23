export {};

const TOKEN = process.env.PIKA_MICROPUB_TOKEN?.trim();
if (!TOKEN) throw new Error('PIKA_MICROPUB_TOKEN is required');

const endpoint = 'https://pika.page/micropub';
const mediaEndpoint = 'https://pika.page/micropub/media';
const draftUrl = 'https://pika.page/posts/2026-08-23-i-keep-coming-back-105ad33c/edit';
const uri = 'at://did:plc:vt4k6d3e5rjw65cuzaf3nufq/app.bsky.feed.post/3msywtvhc6c2n';
const cid = 'bafyreia4vxx2f4iqkuzb5ak4jexz6qvmzkxj6umx7zzddqdbknqf5djvhu';
const quotedUri = 'at://did:plc:vt4k6d3e5rjw65cuzaf3nufq/app.bsky.feed.post/3msxm2nvyvc2j';

const postResponse = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`);
if (!postResponse.ok) throw new Error(`Bluesky post request failed: HTTP ${postResponse.status}`);
const postBody = await postResponse.json() as {
  posts?: Array<{
    cid?: string;
    record?: { text?: string };
    embed?: {
      record?: {
        author?: { handle?: string; displayName?: string };
        value?: { text?: string };
        embeds?: Array<{ images?: Array<{ fullsize?: string; alt?: string }> }>;
      };
    };
  }>;
};
const post = postBody.posts?.[0];
const quote = post?.embed?.record;
const image = quote?.embeds?.[0]?.images?.[0];
if (!post?.record?.text || !quote?.value?.text || !image?.fullsize) throw new Error('Bluesky self-quote data is incomplete');

const imageResponse = await fetch(image.fullsize);
if (!imageResponse.ok) throw new Error(`Bluesky image download failed: HTTP ${imageResponse.status}`);
const blob = await imageResponse.blob();
const form = new FormData();
form.set('file', blob, `bluesky-self-quote.${blob.type === 'image/png' ? 'png' : 'jpg'}`);
const upload = await fetch(mediaEndpoint, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: form
});
const mediaUrl = upload.headers.get('location');
if (upload.status !== 201 || !mediaUrl) throw new Error(`Pika media upload failed: HTTP ${upload.status}`);

const handle = quote.author?.handle ?? 'bryan.eurosky.social';
const displayName = quote.author?.displayName || `@${handle}`;
const quotedUrl = `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${quotedUri.split('/').at(-1)}`;
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const escapeMarkdown = (value: string) => value.replaceAll('\\', '\\\\').replace(/([\[\]_*`])/g, '\\$1');
const quoteCard = [
  '```pikahtml',
  '<blockquote class="bluesky-import-card bluesky-import-card--quote" data-quote-images="1">',
  `  <a href="${escapeHtml(quotedUrl)}" rel="noopener noreferrer"><strong>${escapeHtml(displayName)}</strong></a>`,
  `  <p>${escapeHtml(quote.value.text)}</p>`,
  '</blockquote>',
  '```'
].join('\n');
const marker = [
  '```pikahtml',
  `<div class="bluesky-conversation" data-at-uri="${escapeHtml(uri)}" data-cid="${escapeHtml(post.cid ?? cid)}"></div>`,
  '```'
].join('\n');
const content = [
  escapeMarkdown(post.record.text),
  quoteCard,
  `![${escapeMarkdown(image.alt ?? '')}](${mediaUrl})`,
  marker
].join('\n\n');

const update = await fetch(endpoint, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'update',
    url: draftUrl,
    replace: {
      content: [content],
      category: ['bluesky'],
      'post-status': ['draft']
    }
  })
});
if (!update.ok) throw new Error(`Pika draft repair failed: HTTP ${update.status} ${(await update.text()).slice(0, 200)}`);
console.log(JSON.stringify({ repaired: true, draftUrl, uri }));
