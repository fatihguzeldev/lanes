import type { SheetsExportSummary } from '../../export-contract';
import { describeSheetsScope, spreadsheetHref } from './export-state';
export function TransferSheetsRun({
  run,
  onOpenOperation,
}: {
  run: SheetsExportSummary;
  onOpenOperation?: (id: string) => void;
}) {
  const href = spreadsheetHref(run.spreadsheet),
    priorHref = spreadsheetHref(run.retryOf?.spreadsheet ?? null);
  return (
    <div className="transfer__preview sheets-export__run">
      <h4>{run.title ?? 'saved google sheets export'}</h4>
      <p className="sheets-export__status" role="status">
        {run.state.replaceAll('_', ' ')} · {run.confirmedRows} of {run.totalRows} task rows
        confirmed
      </p>
      {run.selection && <p>{describeSheetsScope(run.selection)}</p>}
      <p>
        {run.totalChunks} saved chunks · {(run.capturedBytes / 1024).toFixed(0)} kib captured.
        captured rows keep their original values when the source changes.
      </p>
      {run.freshness && (
        <p>
          {run.freshness.complete ? 'complete' : 'partial'} retained selection ·{' '}
          {run.freshness.stale ? 'stale' : 'recently synced'}
          {run.freshness.lastSyncedAt ? ` · last synced ${run.freshness.lastSyncedAt}` : ''}. pages
          may contain changes from different times.
        </p>
      )}
      <p>
        {run.counts.parentContext} parent context records · {run.counts.omittedDependencies}{' '}
        dependencies outside the selection omitted.
      </p>
      {run.counts.missingParents + run.counts.missingLabels + run.counts.unsupportedHierarchy >
        0 && (
        <p className="transfer__notice">
          {run.counts.missingParents} unavailable parents, {run.counts.missingLabels} unavailable
          labels, {run.counts.unsupportedHierarchy} unsupported hierarchy records. inspect the
          retained source before confirming this selection.
        </p>
      )}
      {run.error && (
        <p className="transfer__error" role="alert">
          {run.error.message}
        </p>
      )}
      {href && (
        <a className="sheets-export__file" href={href} target="_blank" rel="noopener noreferrer">
          open the confirmed spreadsheet ↗
        </a>
      )}
      {run.retryOf && (
        <div className="transfer__notice">
          <p>{run.duplicateRiskExplanation}</p>
          {priorHref && (
            <a href={priorHref} target="_blank" rel="noopener noreferrer">
              open the earlier confirmed file ↗
            </a>
          )}
          {onOpenOperation && (
            <button
              type="button"
              className="transfer__text"
              onClick={() => onOpenOperation(run.retryOf!.operationId)}
            >
              inspect the earlier unresolved attempt
            </button>
          )}
        </div>
      )}
      {run.operation && onOpenOperation && (
        <button type="button" className="transfer__text" onClick={() => onOpenOperation(run.id)}>
          inspect this operation
        </button>
      )}
    </div>
  );
}
