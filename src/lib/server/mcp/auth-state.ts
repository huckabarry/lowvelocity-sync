/** Atomic operations only: never emulate these with Workers KV. */
export type AuthOperation =
  | { kind: 'login'; now: number }
  | { kind: 'create'; now: number; code: string; codeExpires: number; family: string; current: string; expires: number }
  | { kind: 'rotate'; now: number; family: string; current: string; next: string }
  | { kind: 'active'; now: number; family: string };

export interface AuthStore {
  execute(operation: AuthOperation): Promise<boolean>;
}

export const MAX_LOGIN_ATTEMPTS_PER_HOUR = 10;

/** One private Durable Object for this Worker's owner, across all hostnames. */
export function durableAuthStore(namespace: DurableObjectNamespace | undefined): AuthStore | undefined {
  if (!namespace) return undefined;
  const stub = namespace.get(namespace.idFromName('lowvelocity-mcp-auth-v1'));
  return {
    async execute(operation) {
      const response = await stub.fetch('https://mcp-auth.internal/execute', {
        method: 'POST', body: JSON.stringify(operation)
      });
      if (!response.ok) throw new Error('MCP authentication storage unavailable');
      const result: unknown = await response.json();
      if (typeof result !== 'boolean') throw new Error('Invalid MCP authentication storage response');
      return result;
    }
  };
}

/** SQL transactions serialize reservations and refresh compare-and-swap. */
export class McpAuthState {
  private storage: DurableObjectStorage;

  constructor(state: DurableObjectState) {
    this.storage = state.storage;
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS auth_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auth_expiry ON auth_state(expires);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/execute') {
      return new Response('Not found', { status: 404 });
    }
    const op = await request.json() as AuthOperation;
    if (!Number.isFinite(op.now)) return new Response('Invalid time', { status: 400 });
    const result = this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      // Expiration is checked on every operation, including after eviction/restart.
      sql.exec('DELETE FROM auth_state WHERE expires <= ?', op.now);
      const get = (key: string) => sql.exec<{ value: string }>('SELECT value FROM auth_state WHERE key = ?', key).toArray()[0]?.value;
      const put = (key: string, value: string, expires: number) => {
        sql.exec('INSERT OR REPLACE INTO auth_state VALUES (?, ?, ?)', key, value, expires);
      };
      if (op.kind === 'login') {
        const attempts: number[] = JSON.parse(get('login') ?? '[]');
        const recent = attempts.filter(time => time > op.now - 3_600_000);
        if (recent.length >= MAX_LOGIN_ATTEMPTS_PER_HOUR) return false;
        recent.push(op.now);
        put('login', JSON.stringify(recent), op.now + 3_600_000);
        return true;
      }
      if (op.kind === 'create') {
        if (op.codeExpires <= op.now || op.expires <= op.now || get(`code:${op.code}`)) return false;
        put(`code:${op.code}`, 'used', op.codeExpires);
        put(`family:${op.family}`, op.current, op.expires);
        return true;
      }
      if (op.kind === 'rotate' || op.kind === 'active') {
        const key = `family:${op.family}`;
        const current = get(key);
        if (!current || current === 'revoked') return false;
        if (op.kind === 'active') return true;
        // Preserve the original absolute expiry. Replay revokes every descendant.
        sql.exec('UPDATE auth_state SET value = ? WHERE key = ?', current === op.current ? op.next : 'revoked', key);
        return current === op.current;
      }
      return false;
    });
    return Response.json(result);
  }
}
