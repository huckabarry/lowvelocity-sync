import { createGhostAdminToken } from '../src/lib/server/crypto.ts';

async function readSecretInput(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    let value = '';
    for await (const chunk of process.stdin) value += chunk;
    return value;
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = '';
    process.stdin.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.includes('\u0004')) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(value + text.replace('\u0004', ''));
      } else value += text;
    });
  });
}

const input = JSON.parse(await readSecretInput()) as { adminApiKey?: string; slug?: string };
if (!input.adminApiKey || !input.slug) throw new Error('Missing admin key or slug');
const token = await createGhostAdminToken(input.adminApiKey);
const headers = { Accept: 'application/json', 'Accept-Version': 'v5.0', Authorization: `Ghost ${token}` };
const readUrl = new URL(`/ghost/api/admin/posts/slug/${encodeURIComponent(input.slug)}/`, 'https://lowvelocity.org');
const readResponse = await fetch(readUrl, { headers });
if (!readResponse.ok) throw new Error(`Ghost lookup failed: ${readResponse.status}`);
const body = await readResponse.json() as { posts?: { id: string; updated_at: string; codeinjection_head?: string | null }[] };
const post = body.posts?.[0];
if (!post) throw new Error('Post not found');
const response = await fetch(new URL(`/ghost/api/admin/posts/${post.id}/`, 'https://lowvelocity.org'), {
  method: 'PUT',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ posts: [{ id: post.id, updated_at: post.updated_at, codeinjection_head: `${post.codeinjection_head ?? ''}\n` }] })
});
if (!response.ok) throw new Error(`Ghost update failed: ${response.status} ${await response.text()}`);
console.log(JSON.stringify({ triggered: true, postId: post.id }));
