import { createHmac } from 'node:crypto';
import { createGhostAdminToken } from '../src/lib/server/crypto.ts';

interface Input { adminApiKey?: string; webhookSecret?: string; slug?: string; }
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
const rawInput = await readSecretInput();
const input = JSON.parse(rawInput) as Input;
if (!input.adminApiKey || !input.webhookSecret || !input.slug) throw new Error('Missing test credentials or slug');

const token = await createGhostAdminToken(input.adminApiKey);
const ghostUrl = new URL(`/ghost/api/admin/posts/slug/${encodeURIComponent(input.slug)}/`, 'https://lowvelocity.org');
ghostUrl.searchParams.set('formats', 'html');
ghostUrl.searchParams.set('include', 'tags');
const ghostResponse = await fetch(ghostUrl, {
  headers: { Accept: 'application/json', 'Accept-Version': 'v5.0', Authorization: `Ghost ${token}` }
});
if (!ghostResponse.ok) throw new Error(`Ghost lookup failed: ${ghostResponse.status} ${await ghostResponse.text()}`);
const ghostBody = await ghostResponse.json() as { posts?: Record<string, unknown>[] };
const post = ghostBody.posts?.[0];
if (!post) throw new Error('Ghost post not found');

const payload = JSON.stringify({ post: { current: post } });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac('sha256', input.webhookSecret).update(payload).update(timestamp).digest('hex');
const syncResponse = await fetch('https://sync.lowvelocity.org/webhooks/ghost', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Ghost-Signature': `sha256=${signature}, t=${timestamp}` },
  body: payload
});
const result = await syncResponse.text();
console.log(result);
if (!syncResponse.ok) process.exitCode = 1;
