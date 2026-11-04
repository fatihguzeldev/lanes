import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../shared/contracts/errors';
import type { BoardService } from '../modules/boards/server';
import {
  BoardTemplateService,
  readTemplateListAppearance,
} from '../modules/boards/server/templates';
import { TemplateApplicationService } from '../modules/boards/server/template-runs';
import { TemplateScheduleService } from '../modules/boards/server/template-schedules';
import { ListSnapshotStore, ListTemplateService } from '../modules/tasks/server/list-templates';
import type { TaskCommandService } from '../modules/tasks/server/commands/provider-commands';
import type { OperationStore } from '../modules/tasks/server/operations';
export type CommitTemplateWrites = (writes: D1PreparedStatement[]) => Promise<unknown>;
interface Dependencies {
  boards: BoardService;
  commands: TaskCommandService;
  operations: OperationStore;
  ownerSubjectFor: () => Promise<string>;
}
export function createTemplateOwners(
  db: D1Database,
  dependencies: Dependencies,
  commitWrites: CommitTemplateWrites = async () => {
    throw new AppError('conflict', 'template changes require a captured operation.', 409);
  },
) {
  const snapshots = new ListSnapshotStore(db);
  let schedules: TemplateScheduleService;
  const listTemplates = new ListTemplateService(db, {
    snapshots,
    commitWrites,
    sourceListAppearance: (account, list) => readTemplateListAppearance(db, account, list),
    onDeleteWrites: (account, id) => schedules.pauseTemplateWrites(account, 'list', id),
  });
  const boardTemplates = new BoardTemplateService(db, {
    snapshots,
    commitWrites,
    onDeleteWrites: (account, id) => schedules.pauseTemplateWrites(account, 'board', id),
  });
  const applications = new TemplateApplicationService(db, {
    snapshots,
    listTemplates,
    boardTemplates,
    boards: dependencies.boards,
    commands: dependencies.commands,
    operations: dependencies.operations,
  });
  schedules = new TemplateScheduleService(db, {
    applications,
    boards: dependencies.boards,
    ownerSubjectFor: dependencies.ownerSubjectFor,
    commitWrites,
  });
  return { snapshots, listTemplates, boardTemplates, applications, schedules };
}
export type TemplateOwners = ReturnType<typeof createTemplateOwners>;
