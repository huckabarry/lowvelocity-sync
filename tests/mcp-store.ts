import { after } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { AuthOperation, AuthStore } from '../src/lib/server/mcp/auth-state.ts';

// Exercise real Cloudflare SQLite-backed Durable Objects, not a Map/KV mock.
const built = await build({ stdin: { contents: "export { McpAuthState } from './src/lib/server/mcp/auth-state.ts';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm' });
const code = built.outputFiles[0].text;
const runtime = new Miniflare({
  modules: true, script: code, compatibilityDate: '2026-06-20',
  durableObjects: { MCP_AUTH: { className: 'McpAuthState', useSQLite: true } }
});
after(() => runtime.dispose());
export class TestAuthStore implements AuthStore {
  name = crypto.randomUUID();
  async execute(operation: AuthOperation): Promise<boolean> {
    const namespace = await runtime.getDurableObjectNamespace('MCP_AUTH');
    const stub = namespace.get(namespace.idFromName(this.name));
    const response = await stub.fetch('http://internal/execute', { method: 'POST', body: JSON.stringify(operation) });
    if (!response.ok) throw new Error(`Auth state failed: ${response.status}`);
    return await response.json() as boolean;
  }
}
