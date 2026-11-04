import type { D1Database } from '@cloudflare/workers-types';
import { CapturedDependencyValidator } from './captured-dependency-validation';
export type { DependencyValidationProgress as CopyValidationProgress } from './captured-dependency-validation';

export class CopyDependencyValidator extends CapturedDependencyValidator {
  constructor(db: D1Database) {
    super(db, 'copy');
  }
}
