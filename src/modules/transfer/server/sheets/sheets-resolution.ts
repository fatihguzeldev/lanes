import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { OperationStep } from '../../../operations/server/journal/records';
import type { ImportCell } from '../../contracts/parsing';
import {
  AdoptSheetsVerificationSchema,
  StartSheetsVerificationSchema,
  type AdoptSheetsVerification,
  type StartSheetsVerification,
  type SheetsVerificationSummary,
} from '../../contracts/export';
import { GoogleSheetsError, parseSpreadsheetId } from './sheets';
import type { SheetsExportOptions } from './sheets-export';

type Options = Pick<
  SheetsExportOptions,
  'operations' | 'clientFor' | 'remainingProviderRequests' | 'now'
>;
interface Export {
  id: string;
  account_id: string;
  row_count: number;
  column_count: number;
  file_id: string | null;
  file_url: string | null;
  title: string;
  capture_hash: string;
}
interface Verification {
  id: string;
  export_id: string;
  account_id: string;
  step_key: string;
  original_claim_id: string;
  step_hash: string;
  candidate_id: string;
  action: 'sheets.create' | 'sheets.rows';
  status: 'verifying' | 'matched' | 'mismatch' | 'adopted' | 'cancelled';
  phase: 'metadata' | 'cells';
  first_row: number;
  next_row: number;
  last_row: number;
  column_count: number;
  proof_hash: string;
  verified_at: number | null;
  mismatch_code: string | null;
  revision: number;
}
export type {
  AdoptSheetsVerification,
  StartSheetsVerification,
  SheetsVerificationSummary,
} from '../../contracts/export';
const stepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('sheets.create'),
    rowCount: z.number().int().positive(),
    columnCount: z.number().int().positive(),
  }),
  z.object({
    action: z.literal('sheets.rows'),
    startRow: z.number().int().positive(),
    rows: z
      .array(z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])))
      .min(1)
      .max(10),
  }),
]);
const conflict = (
  message = 'this sheets verification no longer belongs to the unresolved provider step',
) => new AppError('conflict', message, 409);
const explanation =
  'adoption maps the explicitly chosen file. matching titles or values do not prove which file received the original request; another output may exist. google edits can race these paginated checks.';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
async function hash(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(canonical(value))),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
function columnName(value: number): string {
  let name = '';
  for (let number = value; number > 0; number = Math.floor((number - 1) / 26))
    name = String.fromCharCode(65 + ((number - 1) % 26)) + name;
  return name;
}
const blank = (value: ImportCell | undefined): ImportCell =>
  value === null || value === undefined ? '' : value;

/** Provider reads can support an explicit mapping; they cannot establish external exactly-once creation. */
export class SheetsResolutionService {
  constructor(
    private readonly db: D1Database,
    private readonly options: Options,
  ) {}
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private async export(accountId: string, id: string): Promise<Export> {
    const row = await this.db
      .prepare(
        'SELECT id,account_id,row_count,column_count,file_id,file_url,title,capture_hash FROM transfer_sheets_exports WHERE id=? AND account_id=?',
      )
      .bind(id, accountId)
      .first<Export>();
    if (!row)
      throw new AppError(
        'not_found',
        'this sheets export is not available in the selected account',
        404,
      );
    return row;
  }
  private async verification(
    accountId: string,
    exportId: string,
    id: string,
  ): Promise<Verification> {
    await this.export(accountId, exportId);
    const row = await this.db
      .prepare(
        'SELECT * FROM transfer_sheets_verifications WHERE id=? AND export_id=? AND account_id=?',
      )
      .bind(id, exportId, accountId)
      .first<Verification>();
    if (!row)
      throw new AppError(
        'not_found',
        'this candidate verification is not available in the selected export',
        404,
      );
    return row;
  }
  private async unknown(
    accountId: string,
    exportId: string,
    stepKey: string,
    expectedClaimId?: string,
  ): Promise<OperationStep> {
    await this.export(accountId, exportId);
    const operation = await this.options.operations.get(exportId, accountId),
      step = await this.options.operations.getStep(exportId, stepKey);
    if (
      !operation ||
      operation.kind !== 'sheets.export' ||
      !step ||
      step.response !== null ||
      !step.claimId ||
      (expectedClaimId && step.claimId !== expectedClaimId) ||
      !(
        step.state === 'uncertain' ||
        (step.state === 'dispatched' && (step.claimUntil ?? Infinity) <= this.now())
      )
    )
      throw conflict();
    return step;
  }
  private summary(row: Verification): SheetsVerificationSummary {
    return {
      id: row.id,
      exportId: row.export_id,
      stepKey: row.step_key,
      candidateId: row.candidate_id,
      status: row.status,
      checkedRows: Math.max(0, row.next_row - row.first_row),
      totalRows: row.last_row - row.first_row + 1,
      proofDigest: row.status === 'matched' || row.status === 'adopted' ? row.proof_hash : null,
      verifiedAt: row.verified_at === null ? null : new Date(row.verified_at).toISOString(),
      mismatchCode: row.mismatch_code,
      explanation,
    };
  }

  async inspect(
    accountId: string,
    exportId: string,
    stepKey: string,
  ): Promise<{
    stepKey: string;
    expectedClaimId: string;
    action: 'sheets.create' | 'sheets.rows';
    knownSpreadsheet: { id: string; url: string } | null;
    explanation: string;
  }> {
    const run = await this.export(accountId, exportId),
      step = await this.unknown(accountId, exportId, stepKey),
      parsed = stepSchema.safeParse(step.input);
    if (!parsed.success) throw conflict('this captured sheets step cannot be safely interpreted');
    return {
      stepKey,
      expectedClaimId: step.claimId!,
      action: parsed.data.action,
      knownSpreadsheet: run.file_id && run.file_url ? { id: run.file_id, url: run.file_url } : null,
      explanation,
    };
  }

  async start(
    accountId: string,
    exportId: string,
    input: StartSheetsVerification,
  ): Promise<SheetsVerificationSummary> {
    const value = StartSheetsVerificationSchema.safeParse(input);
    if (!value.success)
      throw new AppError(
        'validation_failed',
        'select the unresolved step and an explicit candidate spreadsheet',
        422,
      );
    const run = await this.export(accountId, exportId),
      candidateId = value.data.candidateId
        ? parseSpreadsheetId(value.data.candidateId)
        : run.file_id;
    if (!candidateId)
      throw new AppError(
        'validation_failed',
        'provide the exact candidate spreadsheet id or google sheets url',
        422,
      );
    const id =
      'verify-' + (await hash([exportId, input.stepKey, input.expectedClaimId, candidateId]));
    const previous = await this.db
      .prepare('SELECT * FROM transfer_sheets_verifications WHERE id=?')
      .bind(id)
      .first<Verification>();
    if (previous && (!input.restart || previous.status === 'adopted'))
      return this.summary(previous);
    const step = await this.unknown(accountId, exportId, input.stepKey, input.expectedClaimId),
      parsed = stepSchema.safeParse(step.input);
    if (!parsed.success) throw conflict('this captured sheets step cannot be safely interpreted');
    if (parsed.data.action === 'sheets.rows' && run.file_id !== candidateId)
      throw conflict('a row-write verification must use its already recorded spreadsheet');
    const firstRow = parsed.data.action === 'sheets.create' ? 1 : parsed.data.startRow,
      lastRow =
        parsed.data.action === 'sheets.create'
          ? parsed.data.rowCount
          : parsed.data.startRow + parsed.data.rows.length - 1;
    const stepHash = await hash(step.input);
    await this.db
      .prepare(
        `INSERT INTO transfer_sheets_verifications(id,export_id,account_id,step_key,original_claim_id,step_hash,candidate_id,action,status,phase,first_row,next_row,last_row,column_count,proof_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'verifying','metadata',?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='verifying',phase='metadata',next_row=excluded.first_row,proof_hash=excluded.step_hash,verified_at=NULL,mismatch_code=NULL,revision=transfer_sheets_verifications.revision+1,updated_at=excluded.updated_at WHERE transfer_sheets_verifications.status<>'adopted'`,
      )
      .bind(
        id,
        exportId,
        accountId,
        input.stepKey,
        input.expectedClaimId,
        stepHash,
        candidateId,
        parsed.data.action,
        firstRow,
        firstRow,
        lastRow,
        run.column_count,
        stepHash,
        this.now(),
        this.now(),
      )
      .run();
    return this.summary(await this.verification(accountId, exportId, id));
  }

  async advance(
    accountId: string,
    exportId: string,
    id: string,
  ): Promise<SheetsVerificationSummary> {
    let row = await this.verification(accountId, exportId, id);
    if (row.status !== 'verifying') return this.summary(row);
    const step = await this.unknown(accountId, exportId, row.step_key, row.original_claim_id),
      parsed = stepSchema.safeParse(step.input);
    if (!parsed.success || (await hash(step.input)) !== row.step_hash) throw conflict();
    const client = await this.options.clientFor(accountId);
    for (
      let requests = 0;
      requests < 3 && (this.options.remainingProviderRequests?.() ?? 1) > 0;
      requests++
    ) {
      try {
        if (row.phase === 'metadata') {
          const metadata = await client.metadata(row.candidate_id),
            target = metadata.sheets.find((sheet) => sheet.title === 'tasks');
          const matches =
            target &&
            (row.action === 'sheets.create'
              ? metadata.sheets.length === 1 &&
                target.rowCount === row.last_row &&
                target.columnCount === row.column_count
              : target.rowCount >= row.last_row && target.columnCount >= row.column_count);
          await this.db
            .prepare(
              `UPDATE transfer_sheets_verifications SET phase='cells',status=?,mismatch_code=?,proof_hash=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='verifying'`,
            )
            .bind(
              matches ? 'verifying' : 'mismatch',
              matches ? null : 'shape_mismatch',
              await hash([row.proof_hash, metadata.id, metadata.sheets]),
              this.now(),
              row.id,
              row.revision,
            )
            .run();
        } else {
          const endRow = Math.min(
            row.last_row,
            row.next_row + (row.action === 'sheets.create' ? 99 : 9),
          );
          const table = await client.readRange(row.candidate_id, {
            sheet: 'tasks',
            range: `A${row.next_row}:${columnName(row.column_count)}${endRow}`,
            rejectFormulas: true,
            interpretDates: false,
          });
          const expected =
            parsed.data.action === 'sheets.rows'
              ? parsed.data.rows.slice(row.next_row - row.first_row, endRow - row.first_row + 1)
              : null;
          const matches =
            !table.cellIssues?.length &&
            table.rows.every((cells, index) =>
              cells.every((value, column) => blank(value) === blank(expected?.[index]?.[column])),
            );
          const nextRow = matches ? endRow + 1 : row.next_row,
            complete = matches && nextRow > row.last_row;
          const proof = await hash([
            row.proof_hash,
            row.next_row,
            endRow,
            table.rows,
            ...(complete ? [this.now()] : []),
          ]);
          await this.db
            .prepare(
              `UPDATE transfer_sheets_verifications SET next_row=?,status=?,mismatch_code=?,proof_hash=?,verified_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='verifying'`,
            )
            .bind(
              nextRow,
              !matches ? 'mismatch' : complete ? 'matched' : 'verifying',
              matches ? null : 'content_mismatch',
              proof,
              complete ? this.now() : null,
              this.now(),
              row.id,
              row.revision,
            )
            .run();
        }
      } catch (error) {
        if (error instanceof GoogleSheetsError)
          throw new AppError(error.code, error.message, error.status ?? 503, error.retryable);
        throw error;
      }
      row = await this.verification(accountId, exportId, id);
      if (row.status !== 'verifying') break;
    }
    return this.summary(row);
  }

  async adopt(accountId: string, exportId: string, input: AdoptSheetsVerification): Promise<void> {
    const value = AdoptSheetsVerificationSchema.safeParse(input);
    if (!value.success)
      throw new AppError(
        'validation_failed',
        'explicitly confirm the inspected candidate and its readback result',
        422,
      );
    const row = await this.verification(accountId, exportId, value.data.verificationId);
    if (
      !['matched', 'adopted'].includes(row.status) ||
      row.proof_hash !== value.data.proofDigest ||
      row.verified_at === null
    )
      throw conflict('the candidate has not passed the selected readback checks');
    if (row.status !== 'adopted' && this.now() - row.verified_at > 60000)
      throw conflict(
        'read back this candidate again before adopting it; the prior check is older than one minute',
      );
    const response =
      row.action === 'sheets.create'
        ? {
            id: row.candidate_id,
            url: `https://docs.google.com/spreadsheets/d/${row.candidate_id}/edit`,
          }
        : {
            updatedRows: row.last_row - row.first_row + 1,
            updatedColumns: row.column_count,
            updatedCells: (row.last_row - row.first_row + 1) * row.column_count,
          };
    await this.options.operations.resolveUnknownResponse(
      {
        operationId: exportId,
        accountId,
        stepKey: row.step_key,
        expectedClaimId: row.original_claim_id,
        response,
        evidence: {
          kind: row.action === 'sheets.create' ? 'owner_candidate' : 'provider_readback',
          providerId: row.candidate_id,
          digest: row.proof_hash,
        },
      },
      this.now(),
    );
    await this.db
      .prepare("UPDATE transfer_sheets_verifications SET status='adopted',updated_at=? WHERE id=?")
      .bind(this.now(), row.id)
      .run();
  }
}
