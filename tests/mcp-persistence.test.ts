import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { AuthOperation } from '../src/lib/server/mcp/auth-state.ts';

test('login budget, used codes, and family revocation survive runtime restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-auth-test-'));
  const built = await build({ stdin: { contents: "export { McpAuthState } from './src/lib/server/mcp/auth-state.ts';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm' });
  const options = { modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-06-20', durableObjects: { MCP_AUTH: { className: 'McpAuthState', useSQLite: true } }, durableObjectsPersist: directory };
  let runtime = new Miniflare(options);
  const call = async (operation: AuthOperation) => {
    const ns = await runtime.getDurableObjectNamespace('MCP_AUTH');
    return (await ns.get(ns.idFromName('owner')).fetch('http://internal/execute', { method: 'POST', body: JSON.stringify(operation) })).json();
  };
  const now = Date.now();
  const create: AuthOperation = { kind: 'create', now, code: 'code', codeExpires: now + 300_000, family: 'family', current: 'original', expires: now + 86_400_000 };
  try {
    for (let i = 0; i < 10; i++) assert.equal(await call({ kind: 'login', now }), true);
    assert.equal(await call(create), true);
    assert.equal(await call({ kind: 'rotate', now, family: 'family', current: 'original', next: 'replacement' }), true);
    await runtime.dispose();
    runtime = new Miniflare(options);
    assert.equal(await call({ kind: 'login', now }), false);
    assert.equal(await call(create), false);
    assert.equal(await call({ kind: 'rotate', now, family: 'family', current: 'original', next: 'replay' }), false);
    await runtime.dispose();
    runtime = new Miniflare(options);
    assert.equal(await call({ kind: 'active', now, family: 'family' }), false);
    assert.equal(await call({ kind: 'rotate', now, family: 'family', current: 'replacement', next: 'another' }), false);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
