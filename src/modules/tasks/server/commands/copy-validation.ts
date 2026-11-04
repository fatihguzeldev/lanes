import type { D1Database } from '@cloudflare/workers-types';
import { CapturedDependencyValidator } from './dependency-validation';
export type { DependencyValidationProgress as CopyValidationProgress } from './dependency-validation';

export class CopyDependencyValidator extends CapturedDependencyValidator {
  constructor(db: D1Database) {
    super(db, 'copy');
  }
}
