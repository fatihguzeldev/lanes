import type { D1Database, D1DatabaseSession, D1PreparedStatement } from '@cloudflare/workers-types';

/** Counts the whole invocation, including delegated owners and credential reads. */
export function databaseUsage(database: D1Database) {
  let used = 0;
  const statement = (prepared: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(prepared, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => statement(target.bind(...values));
        const value = Reflect.get(target, key, target);
        if (['first', 'all', 'run', 'raw'].includes(String(key)))
          return (...args: unknown[]) => {
            used++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const wrap = <T extends Pick<D1Database, 'prepare' | 'batch'>>(source: T): T =>
    new Proxy(source, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => statement(target.prepare(sql));
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (key === 'withSession')
          return (...args: Parameters<D1Database['withSession']>) =>
            wrap(Reflect.apply(value, target, args) as D1DatabaseSession);
        if (['batch', 'exec', 'dump'].includes(String(key)))
          return (...args: unknown[]) => {
            used++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return {
    db: wrap(database),
    get used() {
      return used;
    },
  };
}
