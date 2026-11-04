import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

/** D1 counts one batch as one invocation query, regardless of its statement count. */
export function invocationDatabase(database: D1Database, limit = 50) {
  let queries = 0;
  const count = () => {
    queries++;
    if (queries > limit) throw new Error(`D1 invocation exceeded ${limit} queries`);
  };
  const statement = (prepared: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(prepared, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => statement(target.bind(...values));
        if (key === 'first' || key === 'all' || key === 'run' || key === 'raw')
          return (...args: unknown[]) => {
            count();
            return Reflect.apply(Reflect.get(target, key), target, args);
          };
        return Reflect.get(target, key);
      },
    });
  const db = new Proxy(database, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => statement(target.prepare(sql));
      if (key === 'batch' || key === 'exec')
        return (...args: unknown[]) => {
          count();
          return Reflect.apply(Reflect.get(target, key), target, args);
        };
      return Reflect.get(target, key);
    },
  });
  return {
    db,
    get queries() {
      return queries;
    },
  };
}
