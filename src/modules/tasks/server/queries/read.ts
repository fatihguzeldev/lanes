import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';

export async function readProjectionRows<T>(statement: D1PreparedStatement): Promise<T[]> {
  try {
    const result = await statement.all<T>();
    if (!result.success) throw new Error();
    return result.results;
  } catch {
    throw new AppError('storage_unavailable', 'the task projection could not be read', 503, true);
  }
}

export async function readProjectionFirst<T>(statement: D1PreparedStatement): Promise<T | null> {
  try {
    return await statement.first<T>();
  } catch {
    throw new AppError('storage_unavailable', 'the task projection could not be read', 503, true);
  }
}
