import { useEffect, useState } from 'react';
import { z } from 'zod';
import {
  SheetsUncertainStepSchema,
  SheetsVerificationSummarySchema,
  SheetsExportSummarySchema,
  type SheetsExportSummary,
  type SheetsUncertainStep,
  type SheetsVerificationSummary,
} from '../modules/transfer/export-contract';
import {
  IssuedOperationStepSchema,
  type IssuedOperationStep,
} from '../modules/tasks/operation-contract';
import { request } from '../client/http';
import { newOperationId } from '../client/operation-identity';
import {
  accountBase,
  escaped,
  transferBase,
  TransferError,
  useTransferAction,
} from './TransferCommon';
import { spreadsheetHref } from './transfer-sheets-model';
interface Props {
  run: SheetsExportSummary;
  clockOffset: number;
  onUpdated: (run: SheetsExportSummary) => void;
  onPermission: () => void;
  disabled: boolean;
}
export function TransferSheetsRecovery({
  run,
  clockOffset,
  onUpdated,
  onPermission,
  disabled,
}: Props) {
  const action = useTransferAction(run.accountId + ':' + run.id + ':resolution'),
    [stepKey, setStepKey] = useState(''),
    [inspection, setInspection] = useState<SheetsUncertainStep | null>(null),
    [candidate, setCandidate] = useState(''),
    [verification, setVerification] = useState<SheetsVerificationSummary | null>(null),
    [adopt, setAdopt] = useState(false),
    [duplicateRisk, setDuplicateRisk] = useState(false),
    [proofExpired, setProofExpired] = useState(false);
  const base = `${transferBase(run.accountId)}/exports/sheets/${escaped(run.id)}/resolution`,
    [issued, setIssued] = useState<IssuedOperationStep | null>(null),
    [issueError, setIssueError] = useState('');
  async function loadIssued(signal: AbortSignal) {
    const value = await request(
      `${accountBase(run.accountId)}/operations/${escaped(run.id)}/unresolved-step`,
      z.object({ step: IssuedOperationStepSchema.nullable() }).strict(),
      { signal },
    );
    setIssued(value.step);
    setStepKey(value.step?.key ?? '');
    setIssueError('');
    if (!value.step)
      onUpdated(
        await request(
          `${transferBase(run.accountId)}/exports/sheets/${escaped(run.id)}`,
          SheetsExportSummarySchema,
          { signal },
        ),
      );
  }
  useEffect(() => {
    const controller = new AbortController();
    void loadIssued(controller.signal).catch((error) => {
      if (!controller.signal.aborted)
        setIssueError(
          error instanceof Error ? error.message : 'the recorded outcome could not be read.',
        );
    });
    return () => controller.abort();
  }, [run.id, run.operation?.updatedAt]);
  useEffect(() => {
    setInspection(null);
    setVerification(null);
    setAdopt(false);
    setDuplicateRisk(false);
    setCandidate('');
  }, [run.id, stepKey]);
  useEffect(() => {
    setProofExpired(false);
    if (!verification?.verifiedAt) return;
    const remaining = Date.parse(verification.verifiedAt) + 60000 - Date.now() - clockOffset;
    if (remaining <= 0) {
      setProofExpired(true);
      return;
    }
    const timer = setTimeout(() => setProofExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [verification?.verifiedAt, clockOffset]);
  async function inspect(signal: AbortSignal) {
    const result = await request(base + '/inspect', SheetsUncertainStepSchema, {
      method: 'POST',
      body: { stepKey },
      signal,
    });
    setInspection(result);
    setCandidate(result.knownSpreadsheet?.id ?? '');
    setVerification(null);
    setAdopt(false);
  }
  async function verify(signal: AbortSignal) {
    if (!inspection) throw Error('inspect the exact unresolved step first.');
    let current = await request(base + '/start', SheetsVerificationSummarySchema, {
      method: 'POST',
      body: {
        stepKey: inspection.stepKey,
        expectedClaimId: inspection.expectedClaimId,
        ...(inspection.action === 'sheets.create' ? { candidateId: candidate.trim() } : {}),
        restart: true,
      },
      signal,
    });
    setVerification(current);
    const deadline = Date.now() + 30000;
    for (
      let slice = 0;
      current.status === 'verifying' && slice < 12 && Date.now() < deadline && !signal.aborted;
      slice++
    ) {
      current = await request(base + '/advance', SheetsVerificationSummarySchema, {
        method: 'POST',
        body: { verificationId: current.id },
        signal,
      });
      setVerification(current);
    }
  }
  async function continueVerification(signal: AbortSignal) {
    if (!verification) throw Error('start candidate verification first.');
    let current = verification;
    const deadline = Date.now() + 30000;
    for (
      let slice = 0;
      current.status === 'verifying' && slice < 12 && Date.now() < deadline && !signal.aborted;
      slice++
    ) {
      current = await request(base + '/advance', SheetsVerificationSummarySchema, {
        method: 'POST',
        body: { verificationId: current.id },
        signal,
      });
      setVerification(current);
    }
  }
  const knownHref = spreadsheetHref(inspection?.knownSpreadsheet ?? null),
    busy = action.busy || disabled || !!issued?.claimActive;
  return (
    <section className="sheets-export__recovery">
      <h4>settle the unresolved request</h4>
      <p>
        google may have accepted it. inspection reads the chosen file; it does not repeat a create
        or row write.
      </p>
      <TransferError>{issueError}</TransferError>
      {issued?.claimActive && (
        <p>the issued request is still settling. wait, then refresh its recorded outcome.</p>
      )}
      <div className="transfer__actions">
        <button
          type="button"
          disabled={action.busy || disabled}
          onClick={() => void action.run(loadIssued)}
        >
          refresh recorded outcome
        </button>
        {!issued?.hasRecordedResponse && (
          <button
            type="button"
            disabled={busy || !stepKey}
            onClick={() => void action.run(inspect)}
          >
            inspect this request
          </button>
        )}
        {issued?.hasRecordedResponse && (
          <button
            type="button"
            disabled={busy || !stepKey}
            onClick={() =>
              void action.run(async (signal) =>
                onUpdated(
                  await request(base + '/repair', SheetsExportSummarySchema, {
                    method: 'POST',
                    body: { stepKey },
                    signal,
                  }),
                ),
              )
            }
          >
            finish saving the recorded google result
          </button>
        )}
        <button type="button" disabled={busy} onClick={onPermission}>
          renew sheets permission
        </button>
      </div>
      {!issued && !issueError && <p>reading the recorded request…</p>}
      {inspection && !issued?.hasRecordedResponse && (
        <>
          <p>{inspection.explanation}</p>
          {inspection.action === 'sheets.create' ? (
            <label>
              candidate google sheets url or file id
              <input
                value={candidate}
                onChange={(event) => {
                  setCandidate(event.target.value);
                  setVerification(null);
                  setAdopt(false);
                }}
                maxLength={4096}
                disabled={busy}
                placeholder="https://docs.google.com/spreadsheets/d/…/edit"
              />
            </label>
          ) : (
            <p>
              the row check uses the already recorded spreadsheet.
              {knownHref && (
                <>
                  {' '}
                  <a href={knownHref} target="_blank" rel="noopener noreferrer">
                    open it ↗
                  </a>
                </>
              )}
            </p>
          )}
          <button
            type="button"
            className="transfer__secondary"
            disabled={busy || (inspection.action === 'sheets.create' && !candidate.trim())}
            onClick={() => void action.run(verify)}
          >
            {verification ? 'check again' : 'check the captured file and values'}
          </button>
          {verification && (
            <div className="transfer__preview">
              <p role="status">
                {verification.status} · {verification.checkedRows} of {verification.totalRows} rows
                checked
              </p>
              <p>{verification.explanation}</p>
              {verification.mismatchCode && (
                <p className="transfer__notice">
                  {verification.mismatchCode.replaceAll('_', ' ')}. this candidate was not adopted.
                </p>
              )}
              {verification.status === 'verifying' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void action.run(continueVerification)}
                >
                  continue the same check
                </button>
              )}
              {verification.status === 'matched' && (
                <>
                  <label className="transfer__check">
                    <input
                      type="checkbox"
                      checked={adopt}
                      onChange={(event) => setAdopt(event.target.checked)}
                      disabled={busy || proofExpired}
                    />
                    use this chosen file/result for the recorded request; matching values alone do
                    not prove which request originally created it
                  </label>
                  {proofExpired && <p>the readback has expired. check again before adopting.</p>}
                  <button
                    type="button"
                    className="transfer__primary"
                    disabled={busy || !adopt || proofExpired || !verification.proofDigest}
                    onClick={() =>
                      void action.run(async (signal) => {
                        onUpdated(
                          await request(base + '/adopt', SheetsExportSummarySchema, {
                            method: 'POST',
                            body: {
                              verificationId: verification.id,
                              proofDigest: verification.proofDigest,
                              confirmAdoption: true,
                            },
                            signal,
                          }),
                        );
                      })
                    }
                  >
                    adopt the verified result
                  </button>
                </>
              )}
            </div>
          )}
          <details className="transfer__details">
            <summary>start a separate attempt</summary>
            <p>
              the earlier spreadsheet or write may still exist. a new attempt keeps the same frozen
              rows and preserves the earlier unresolved record. it does not resolve or remove the
              earlier output.
            </p>
            <label className="transfer__check">
              <input
                type="checkbox"
                checked={duplicateRisk}
                disabled={busy}
                onChange={(event) => setDuplicateRisk(event.target.checked)}
              />
              i accept that another file or write may already exist
            </label>
            <button
              type="button"
              disabled={busy || !duplicateRisk}
              onClick={() =>
                void action.run(async (signal) => {
                  onUpdated(
                    await request(base + '/fresh-attempt', SheetsExportSummarySchema, {
                      method: 'POST',
                      body: {
                        newOperationId: newOperationId(clockOffset),
                        stepKey: inspection.stepKey,
                        expectedClaimId: inspection.expectedClaimId,
                        confirmDuplicateRisk: true,
                      },
                      signal,
                    }),
                  );
                })
              }
            >
              capture a separate attempt from the same rows
            </button>
          </details>
        </>
      )}
      <TransferError>{action.error}</TransferError>
    </section>
  );
}
