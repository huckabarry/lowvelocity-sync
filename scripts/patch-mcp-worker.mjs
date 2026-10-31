import { readFile, writeFile } from 'node:fs/promises';

const path = '.svelte-kit/cloudflare/_worker.js';
const marker = '// lowvelocity-mcp-auth';
const source = await readFile(path, 'utf8');
if (!source.includes('worker_default as default') || !source.includes('async scheduled(')) {
  throw new Error('MCP patch requires the adapter Worker with scheduled imports');
}
if (!source.includes(marker)) {
  await writeFile(path, source + `
${marker}
export { McpAuthState } from '../../src/lib/server/mcp/auth-state.ts';
import { oauthTokenRequest } from '../../src/lib/server/mcp/token-origin.ts';
const originalFetch = worker_default.fetch.bind(worker_default);
worker_default.fetch = (request, env, ctx) => originalFetch(oauthTokenRequest(request), env, ctx);
`);
}
console.log('MCP Durable Object export and narrow token Origin exception verified');
