/**
 * Parameterized Cloudflare D1 database wrapper.
 * Enforces prepared statement parameter binding and tracks real query latency.
 */

export class DatabaseUnavailableError extends Error {
  constructor(message = 'Cloudflare D1 database binding (DB) is not configured or unavailable.') {
    super(message);
    this.name = 'DatabaseUnavailableError';
    this.status = 503;
  }
}

export function createDbClient(dbBinding) {
  if (!dbBinding) {
    throw new DatabaseUnavailableError();
  }

  async function first(sql, params = []) {
    const start = Date.now();
    try {
      const stmt = dbBinding.prepare(sql).bind(...params);
      const result = await stmt.first();
      return { row: result ?? null, durationMs: Date.now() - start };
    } catch (err) {
      throw new Error(`D1 query failed: ${err?.message || 'Unknown SQL error'}`);
    }
  }

  async function all(sql, params = []) {
    const start = Date.now();
    try {
      const stmt = dbBinding.prepare(sql).bind(...params);
      const res = await stmt.all();
      return {
        rows: res?.results ?? [],
        meta: res?.meta ?? {},
        durationMs: Date.now() - start,
      };
    } catch (err) {
      throw new Error(`D1 query failed: ${err?.message || 'Unknown SQL error'}`);
    }
  }

  async function run(sql, params = []) {
    const start = Date.now();
    try {
      const stmt = dbBinding.prepare(sql).bind(...params);
      const res = await stmt.run();
      return {
        success: res?.success !== false,
        meta: res?.meta ?? {},
        durationMs: Date.now() - start,
      };
    } catch (err) {
      throw new Error(`D1 write failed: ${err?.message || 'Unknown SQL error'}`);
    }
  }

  async function batch(statements = []) {
    const start = Date.now();
    try {
      const prepared = statements.map(({ sql, params = [] }) => dbBinding.prepare(sql).bind(...params));
      const results = await dbBinding.batch(prepared);
      return { results, durationMs: Date.now() - start };
    } catch (err) {
      throw new Error(`D1 batch failed: ${err?.message || 'Unknown SQL error'}`);
    }
  }

  return { first, all, run, batch, raw: dbBinding };
}
