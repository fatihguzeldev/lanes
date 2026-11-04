import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { AppError } from '../../../../shared/contracts/errors';
import { assertProviderWritable } from '../../../accounts/access';
import type {
  ResolutionCandidate,
  ResolutionContext,
  ResolutionPreview,
} from '../../resolution-contract';
import { ResolutionConfirmSchema, ResolutionPreviewRequestSchema } from '../../resolution-contract';
import type { CapturedStep } from './provider-command-state';
import {
  GoogleTasksError,
  type GoogleTaskDTO,
  type GoogleTaskListDTO,
  type GoogleTasksClient,
} from '../provider';
import type { OperationStep, OperationStore, ResolutionEvidence } from '../operations';
import type { TaskProjectionStore } from '../projection';
import { normalizeTaskSearchText } from '../../model';
interface Dependencies {
  operations: OperationStore;
  projection: TaskProjectionStore;
  clientFor: (accountId: string) => Promise<GoogleTasksClient>;
  resolveStep: (
    accountId: string,
    operationId: string,
    step: CapturedStep,
  ) => Promise<CapturedStep>;
  now: () => number;
}
interface ProjectionFence {
  lists: { id: string; revision: number; projection_revision: number }[];
  tasks: { id: string; list_id: string; revision: number }[];
}
const stopExplanation =
  'keep the values read from google and stop all unsent work in this operation. existing lanes identities and metadata remain separate. this does not prove whether the original write succeeded; another created resource may still exist. no provider write will be repeated.';
async function digest(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
const conflict = (message: string) => new AppError('conflict', message, 409);
/** Exact-address readback and explicit owner adoption. This service never sends a mutation. */
export class TaskOperationResolution {
  constructor(
    private readonly db: D1Database,
    private readonly options: Dependencies,
  ) {}
  private async issued(accountId: string, operationId: string) {
    const operation = await this.options.operations.get(operationId, accountId);
    if (!operation)
      throw new AppError(
        'not_found',
        'this operation is not available in the selected account.',
        404,
      );
    if (operation.finished) throw conflict('this operation is already settled.');
    const row = await this.db
      .prepare(
        "SELECT item_key FROM tasks_operation_steps WHERE operation_id=? AND state IN('dispatched','uncertain') ORDER BY position LIMIT 1",
      )
      .bind(operationId)
      .first<{ item_key: string }>();
    const issued = row ? await this.options.operations.getStep(operationId, row.item_key) : null;
    if (!issued) throw conflict('this operation has no issued outcome waiting for resolution.');
    const saved = issued.input as CapturedStep;
    if (
      !saved ||
      ![
        'task.create',
        'task.patch',
        'task.move',
        'task.delete',
        'list.create',
        'list.rename',
        'list.delete',
      ].includes(saved.action)
    )
      throw conflict('this operation uses another owner’s resolution flow.');
    const step = saved.copyKey
      ? await this.options.resolveStep(accountId, operationId, saved)
      : saved;
    const context: ResolutionContext = {
      operationId,
      stepKey: issued.key,
      action: step.action,
      title: step.title ?? step.provider?.title ?? step.task?.title ?? '',
      listTitle: step.list.title,
      hasRecordedResponse: issued.response !== null,
      claimActive: (issued.claimUntil ?? 0) > this.options.now(),
      needsCandidate:
        step.action === 'task.create' ||
        step.action === 'list.create' ||
        step.action === 'task.move',
    };
    return { issued, step, context };
  }
  async inspect(accountId: string, operationId: string) {
    return (await this.issued(accountId, operationId)).context;
  }
  private async candidate(
    accountId: string,
    step: CapturedStep,
    value: GoogleTaskDTO | GoogleTaskListDTO,
    known?: Map<string, string>,
  ): Promise<ResolutionCandidate> {
    const task = value as GoogleTaskDTO;
    const table = step.action.startsWith('list.') ? 'tasks_lists' : 'tasks_tasks';
    const retainedId = known
      ? known.get(value.id)
      : (
          await this.db
            .prepare(
              `SELECT id FROM ${table} WHERE account_id=? AND provider_id=? ${table === 'tasks_tasks' ? 'AND list_id=?' : ''} AND deleted_at IS NULL`,
            )
            .bind(
              accountId,
              value.id,
              ...(table === 'tasks_tasks' ? [(step.destination ?? step.list).id] : []),
            )
            .first<{ id: string }>()
        )?.id;
    const expectedId = step.task?.id ?? step.targetId ?? step.list.id;
    return {
      providerId: value.id,
      title: value.title ?? '',
      notes: task.notes ?? '',
      scheduledDay: task.due?.slice(0, 10) ?? null,
      completed: task.status === 'completed',
      parentId: task.parent ?? null,
      etag: value.etag ?? null,
      alreadyRetained: !!retainedId && retainedId !== expectedId,
      retainedId: retainedId ?? null,
    };
  }
  async candidates(accountId: string, operationId: string, cursor?: string) {
    const current = await this.issued(accountId, operationId);
    if (current.context.hasRecordedResponse || !current.context.needsCandidate)
      return { context: current.context, items: [], nextCursor: null };
    await assertProviderWritable(this.db, accountId);
    let pageToken: string | undefined;
    if (cursor) {
      try {
        const value = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(atob(cursor), (char) => char.charCodeAt(0))),
        ) as { operationId: string; stepKey: string; pageToken: string };
        if (
          value.operationId !== operationId ||
          value.stepKey !== current.issued.key ||
          typeof value.pageToken !== 'string' ||
          value.pageToken.length > 16384
        )
          throw new Error();
        pageToken = value.pageToken;
      } catch {
        throw new AppError(
          'validation_failed',
          'this candidate page belongs to another issued step.',
          400,
        );
      }
    }
    const client = await this.options.clientFor(accountId),
      { step } = current;
    const page =
      step.action === 'list.create'
        ? await client.listTaskLists({ maxResults: 50, ...(pageToken ? { pageToken } : {}) })
        : await client.listTasks((step.destination ?? step.list).providerId, {
            maxResults: 50,
            ...(pageToken ? { pageToken } : {}),
          });
    const table = step.action === 'list.create' ? 'tasks_lists' : 'tasks_tasks';
    const rows = await this.db
      .prepare(
        `SELECT id,provider_id FROM ${table} WHERE account_id=? AND provider_id IN(SELECT value FROM json_each(?)) ${table === 'tasks_tasks' ? 'AND list_id=?' : ''} AND deleted_at IS NULL`,
      )
      .bind(
        accountId,
        JSON.stringify(page.items.map((item) => item.id)),
        ...(table === 'tasks_tasks' ? [(step.destination ?? step.list).id] : []),
      )
      .all<{ id: string; provider_id: string }>();
    const known = new Map(rows.results.map((row) => [row.provider_id, row.id]));
    const items = await Promise.all(
      page.items
        .filter((value) => !(value as GoogleTaskDTO).deleted)
        .map(async (value) => ({
          ...(await this.candidate(accountId, step, value, known)),
          notes: ((value as GoogleTaskDTO).notes ?? '').slice(0, 240),
        })),
    );
    const nextCursor = page.nextPageToken
      ? btoa(
          String.fromCharCode(
            ...new TextEncoder().encode(
              JSON.stringify({
                operationId,
                stepKey: current.issued.key,
                pageToken: page.nextPageToken,
              }),
            ),
          ),
        )
      : null;
    return { context: current.context, items, nextCursor };
  }
  private matches(step: CapturedStep, value: GoogleTaskDTO | GoogleTaskListDTO): boolean {
    if (step.action === 'list.create' || step.action === 'list.rename')
      return value.title === step.title;
    const task = value as GoogleTaskDTO;
    if (task.deleted || (step.action === 'task.create' && task.assignmentInfo)) return false;
    if (step.action === 'task.move')
      return (
        (task.parent ?? null) === (step.parent?.provider.id ?? null) &&
        task.title === step.task?.title
      );
    const intended = step.provider ?? {};
    for (const field of ['title', 'notes', 'status'] as const)
      if (
        field in intended &&
        (task[field] ?? (field === 'notes' ? '' : undefined)) !== intended[field]
      )
        return false;
    if ('dueDay' in intended && (task.due?.slice(0, 10) ?? null) !== intended.dueDay) return false;
    if (
      step.action === 'task.create' &&
      (task.parent ?? null) !== (step.parent?.provider.id ?? null)
    )
      return false;
    return true;
  }
  private async captureFence(
    accountId: string,
    step: CapturedStep,
    retainedId: string | null,
  ): Promise<ProjectionFence> {
    const listIds = [
      ...new Set(
        step.action === 'list.create'
          ? retainedId
            ? [retainedId]
            : []
          : [step.list.id, ...(step.destination ? [step.destination.id] : [])],
      ),
    ];
    const lists = (
      await this.db
        .prepare(
          'SELECT id,revision,projection_revision FROM tasks_lists WHERE account_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL',
        )
        .bind(accountId, JSON.stringify(listIds))
        .all<ProjectionFence['lists'][number]>()
    ).results;
    if (lists.length !== listIds.length)
      throw conflict(
        'a captured list is no longer retained. refresh the destination before resolving this operation.',
      );
    const taskIds = step.action.startsWith('task.')
      ? [...new Set([step.task?.id, retainedId].filter((id): id is string => !!id))]
      : [];
    const tasks = (
      await this.db
        .prepare(
          'SELECT id,list_id,revision FROM tasks_tasks WHERE account_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL',
        )
        .bind(accountId, JSON.stringify(taskIds))
        .all<ProjectionFence['tasks'][number]>()
    ).results;
    if (tasks.length !== taskIds.length)
      throw conflict(
        'a retained task identity changed. inspect its current mapping before resolving this operation.',
      );
    return {
      lists: lists.sort((a, b) => a.id.localeCompare(b.id)),
      tasks: tasks.sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  private async currentWrites(
    accountId: string,
    operationId: string,
    step: CapturedStep,
    response: GoogleTaskDTO | GoogleTaskListDTO,
    candidate: ResolutionCandidate,
    fence: ProjectionFence,
    sourceResponse?: GoogleTaskDTO,
  ): Promise<D1PreparedStatement[]> {
    const writes: D1PreparedStatement[] = [];
    for (const list of fence.lists)
      writes.push(
        this.db
          .prepare(
            'INSERT INTO tasks_write_guards(valid)SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_lists WHERE account_id=? AND id=? AND revision=? AND projection_revision=? AND deleted_at IS NULL)',
          )
          .bind(accountId, list.id, list.revision, list.projection_revision),
      );
    for (const task of fence.tasks)
      writes.push(
        this.db
          .prepare(
            'INSERT INTO tasks_write_guards(valid)SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM tasks_tasks WHERE account_id=? AND id=? AND list_id=? AND revision=? AND deleted_at IS NULL)',
          )
          .bind(accountId, task.id, task.list_id, task.revision),
      );
    if (step.action.startsWith('list.')) {
      if (!candidate.retainedId)
        throw conflict('refresh google list inventory before keeping this unretained list.');
      writes.push(
        this.db
          .prepare(
            'UPDATE tasks_lists SET title=?,title_key=?,provider_etag=?,revision=revision+CASE WHEN title IS NOT ? OR provider_etag IS NOT ? THEN 1 ELSE 0 END,projection_revision=projection_revision+1,last_synced_at=? WHERE account_id=? AND id=? AND provider_id=? AND deleted_at IS NULL',
          )
          .bind(
            response.title!,
            normalizeTaskSearchText(response.title!),
            response.etag ?? null,
            response.title!,
            response.etag ?? null,
            this.options.now(),
            accountId,
            candidate.retainedId,
            response.id,
          ),
      );
    } else {
      const list = step.destination ?? step.list;
      writes.push(
        this.db
          .prepare(
            "INSERT INTO tasks_write_guards(valid)SELECT 0 WHERE COALESCE((SELECT id FROM tasks_tasks WHERE account_id=? AND list_id=? AND provider_id=? AND deleted_at IS NULL),'')<>?",
          )
          .bind(accountId, list.id, response.id, candidate.retainedId ?? ''),
      );
      writes.push(
        ...(
          await this.options.projection.prepareConfirmedWrites(
            accountId,
            list.id,
            [response as GoogleTaskDTO],
            { observed: true, baseline: !candidate.retainedId },
          )
        ).writes,
      );
      if (sourceResponse && step.task) {
        if (sourceResponse.deleted)
          writes.push(
            this.db
              .prepare(
                `UPDATE tasks_tasks SET provider_missing_at=?,revision=revision+1,capabilities_json=json_set(capabilities_json,'$.canEdit',json('false'),'$.canEditNotes',json('false'),'$.canMove',json('false'),'$.canDelete',json('false'),'$.canHaveChildren',json('false'),'$.canNest',json('false'),'$.restriction',?) WHERE account_id=? AND id=? AND deleted_at IS NULL`,
              )
              .bind(
                this.options.now(),
                'google no longer returns the recorded source address. its lanes identity and metadata remain retained; this stop did not merge it with the selected destination.',
                accountId,
                step.task.id,
              ),
          );
        else
          writes.push(
            ...(
              await this.options.projection.prepareConfirmedWrites(
                accountId,
                step.list.id,
                [sourceResponse],
                { observed: true, baseline: false },
              )
            ).writes,
          );
      }
      writes.push(
        this.db
          .prepare(
            'UPDATE tasks_lists SET projection_revision=projection_revision+1,tasks_complete_at=NULL,completed_complete_at=NULL WHERE account_id=? AND id IN(SELECT value FROM json_each(?))',
          )
          .bind(accountId, JSON.stringify(fence.lists.map((list) => list.id))),
      );
    }
    const transitionPrefix = `owner:${operationId}:`;
    writes.push(
      this.db
        .prepare(
          "UPDATE tasks_recurrence_transitions SET state='cancelled' WHERE account_id=? AND substr(id,1,length(?))=? AND state='captured'",
        )
        .bind(accountId, transitionPrefix, transitionPrefix),
    );
    return writes;
  }
  private async read(accountId: string, operationId: string, input: unknown) {
    const parsed = ResolutionPreviewRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError('validation_failed', 'choose an exact provider resource identity.', 400);
    const current = await this.issued(accountId, operationId),
      { issued, step, context } = current;
    if (context.claimActive)
      throw conflict(
        'the original worker still owns this request. wait for its bounded claim before resolving it.',
      );
    const decision = parsed.data.decision;
    if (issued.response !== null && decision === 'adopt')
      return {
        ...current,
        response: issued.response,
        evidence: null,
        candidate: null,
        canConfirm: true,
        reason: null,
        decision,
        canKeepProviderCurrent: true,
        stopExplanation,
        sourceResponse: undefined,
        fence: undefined,
        hash: await digest({
          operationId,
          stepKey: issued.key,
          decision,
          response: issued.response,
        }),
      };
    await assertProviderWritable(this.db, accountId);
    const client = await this.options.clientFor(accountId),
      list = step.destination ?? step.list;
    const knownId = step.task?.provider.id ?? step.list.providerId;
    if (!context.needsCandidate && parsed.data.candidateId && parsed.data.candidateId !== knownId)
      throw new AppError(
        'validation_failed',
        'readback must use the exact address captured by this request.',
        400,
      );
    const recordedId =
      issued.response &&
      typeof issued.response === 'object' &&
      'id' in issued.response &&
      typeof issued.response.id === 'string'
        ? issued.response.id
        : undefined;
    const candidateId = context.needsCandidate ? (parsed.data.candidateId ?? recordedId) : knownId;
    if (
      context.hasRecordedResponse &&
      parsed.data.candidateId &&
      parsed.data.candidateId !== recordedId
    )
      throw new AppError(
        'validation_failed',
        'a recorded provider receipt cannot be retargeted to a different resource.',
        400,
      );
    if (!candidateId)
      throw new AppError(
        'validation_failed',
        'select the exact resource you identified in google.',
        400,
      );
    const deleting = step.action === 'task.delete' || step.action === 'list.delete';
    let response: GoogleTaskDTO | GoogleTaskListDTO;
    try {
      response = step.action.startsWith('list.')
        ? await client.getTaskList(candidateId)
        : await client.getTask(list.providerId, candidateId);
    } catch (error) {
      if (!deleting || !(error instanceof GoogleTasksError) || error.code !== 'not_found')
        throw error;
      response = { id: candidateId, deleted: true } as GoogleTaskDTO;
    }
    if (response.id !== candidateId)
      throw conflict(
        'google returned a different resource identity for this exact-address readback.',
      );
    const isDeleted =
      deleting &&
      (step.action === 'list.delete'
        ? (response as GoogleTaskDTO).deleted === true
        : (response as GoogleTaskDTO).deleted === true);
    const candidate = isDeleted ? null : await this.candidate(accountId, step, response);
    const canAdopt = deleting
      ? isDeleted
      : !candidate?.alreadyRetained && this.matches(step, response);
    const completeRead = step.action.startsWith('list.')
      ? response.title !== undefined
      : response.title !== undefined &&
        (response as GoogleTaskDTO).status !== undefined &&
        !(response as GoogleTaskDTO).deleted;
    const canKeepProviderCurrent =
      completeRead &&
      !isDeleted &&
      (step.action !== 'list.create' || candidate?.retainedId !== null);
    const canConfirm = decision === 'keep_provider_current' ? canKeepProviderCurrent : canAdopt;
    const reason = canConfirm
      ? null
      : decision === 'keep_provider_current' && isDeleted
        ? 'google confirms this resource is absent. use the deletion confirmation rather than keeping a current resource.'
        : decision === 'keep_provider_current' &&
            step.action === 'list.create' &&
            !candidate?.retainedId
          ? 'refresh google list inventory so this list has a retained lanes placement before keeping it.'
          : decision === 'keep_provider_current' && !completeRead
            ? 'google did not return complete current fields. refresh the exact provider resource before stopping this operation.'
            : candidate?.alreadyRetained
              ? 'this provider resource already has another retained lanes identity. keep its current state and stop this operation to preserve that identity without merging metadata.'
              : deleting
                ? 'google still returns the resource. its deletion is not confirmed.'
                : 'the current provider values differ from this captured change. inspect them before deciding how to proceed.';
    const evidence: ResolutionEvidence = {
      kind: context.needsCandidate ? 'owner_candidate' : 'provider_readback',
      providerId: candidateId,
      ...('etag' in response && response.etag ? { etag: response.etag } : {}),
      digest: await digest(response),
    };
    let sourceResponse: GoogleTaskDTO | undefined;
    if (
      decision === 'keep_provider_current' &&
      step.action === 'task.move' &&
      step.destination?.id !== step.list.id
    ) {
      try {
        sourceResponse = await client.getTask(step.list.providerId, step.task!.provider.id);
      } catch (error) {
        if (!(error instanceof GoogleTasksError) || error.code !== 'not_found') throw error;
        sourceResponse = { id: step.task!.provider.id, deleted: true };
      }
      if (sourceResponse.id !== step.task!.provider.id)
        throw conflict('google returned a different source task identity.');
      if (
        !sourceResponse.deleted &&
        (sourceResponse.title === undefined || sourceResponse.status === undefined)
      )
        throw conflict(
          'google did not return complete source fields. refresh the exact source address before stopping this move.',
        );
    }
    const fence =
      decision === 'keep_provider_current'
        ? await this.captureFence(accountId, step, candidate?.retainedId ?? null)
        : undefined;
    return {
      ...current,
      response,
      evidence,
      candidate,
      canConfirm,
      reason,
      decision,
      canKeepProviderCurrent,
      stopExplanation: canKeepProviderCurrent ? stopExplanation : null,
      sourceResponse,
      fence,
      hash: await digest({
        operationId,
        stepKey: issued.key,
        claimId: issued.claimId,
        originalResponse: issued.response,
        decision,
        response,
        evidence,
        sourceResponse,
        fence,
      }),
    };
  }
  async preview(
    accountId: string,
    operationId: string,
    input: unknown,
  ): Promise<ResolutionPreview> {
    const value = await this.read(accountId, operationId, input);
    return {
      context: value.context,
      previewHash: value.hash,
      candidate: value.candidate,
      canConfirm: value.canConfirm,
      reason: value.reason,
      decision: value.decision,
      canKeepProviderCurrent: value.canKeepProviderCurrent,
      stopExplanation: value.stopExplanation,
      checkedAt: this.options.now(),
    };
  }
  async confirm(accountId: string, operationId: string, input: unknown): Promise<void> {
    const parsed = ResolutionConfirmSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'validation_failed',
        'confirm the current exact-identity resolution preview.',
        400,
      );
    if (parsed.data.decision === 'keep_provider_current') {
      const prior = await this.options.operations.findStoppedIntent(operationId, accountId);
      if (prior) {
        if (
          prior.evidence.digest !== parsed.data.previewHash ||
          (parsed.data.candidateId && parsed.data.candidateId !== prior.evidence.providerId)
        )
          throw conflict(
            'this operation was already stopped using a different preview or provider identity.',
          );
        if (prior.evidence.kind === 'owner_candidate' && !parsed.data.confirmIdentity)
          throw new AppError(
            'validation_failed',
            'explicitly acknowledge the selected provider identity and stopped intent.',
            400,
          );
        return;
      }
    }
    const value = await this.read(accountId, operationId, {
      ...(parsed.data.candidateId ? { candidateId: parsed.data.candidateId } : {}),
      decision: parsed.data.decision,
    });
    if (value.hash !== parsed.data.previewHash || !value.canConfirm)
      throw conflict(
        'the provider result or issued step changed. review a fresh resolution preview.',
      );
    if (
      value.context.needsCandidate &&
      (!value.context.hasRecordedResponse || value.decision === 'keep_provider_current') &&
      !parsed.data.confirmIdentity
    )
      throw new AppError(
        'validation_failed',
        value.decision === 'keep_provider_current'
          ? 'explicitly confirm the selected provider resource and the decision to stop this operation. its identity and metadata will remain separate.'
          : 'explicitly confirm this is the resource created or moved by the issued request. equal titles do not prove identity.',
        400,
      );
    if (value.decision === 'keep_provider_current') {
      if (!value.evidence || !value.fence || !value.candidate)
        throw conflict(
          'a fresh complete provider readback is required before stopping this operation.',
        );
      await this.options.operations.stopRecordedIntent(
        {
          operationId,
          accountId,
          stepKey: value.issued.key,
          expectedClaimId: value.issued.claimId,
          expectedResponse: value.issued.response,
          evidence: { ...value.evidence, digest: value.hash },
          decision: 'keep_provider_current',
        },
        await this.currentWrites(
          accountId,
          operationId,
          value.step,
          value.response as GoogleTaskDTO | GoogleTaskListDTO,
          value.candidate,
          value.fence,
          value.sourceResponse,
        ),
        this.options.now(),
      );
    } else if (value.issued.response !== null)
      await this.options.operations.resumeRecordedResponse(
        operationId,
        value.issued.key,
        accountId,
        this.options.now(),
      );
    else {
      if (!value.issued.claimId || !value.evidence)
        throw conflict('the original dispatch identity is not retained.');
      await this.options.operations.resolveUnknownResponse(
        {
          operationId,
          accountId,
          stepKey: value.issued.key,
          expectedClaimId: value.issued.claimId,
          response: value.response,
          evidence: value.evidence,
        },
        this.options.now(),
      );
    }
  }
}
