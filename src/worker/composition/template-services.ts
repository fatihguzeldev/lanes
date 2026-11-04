import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { BoardService } from '../../modules/boards/server/boards/service';
import {
  BoardTemplateService,
  readTemplateListAppearance,
} from '../../modules/boards/server/templates/definitions';
import { TemplateApplicationService } from '../../modules/boards/server/templates/runs';
import { TemplateScheduleService } from '../../modules/boards/server/templates/schedules';
import type { OperationStore } from '../../modules/operations/server/journal/store';
import type { TaskCommandService } from '../../modules/tasks/server/commands/service';
import { ListSnapshotStore } from '../../modules/tasks/server/templates/snapshots';
import { ListTemplateService } from '../../modules/tasks/server/templates/definitions';
import { AppError } from '../../shared/contracts/errors';
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
    boardQueries: dependencies.boards.queries,
    commands: dependencies.commands,
    operations: dependencies.operations,
  });
  schedules = new TemplateScheduleService(db, {
    applications,
    boardQueries: dependencies.boards.queries,
    ownerSubjectFor: dependencies.ownerSubjectFor,
    commitWrites,
  });
  return { snapshots, listTemplates, boardTemplates, applications, schedules };
}
export type TemplateOwners = ReturnType<typeof createTemplateOwners>;
