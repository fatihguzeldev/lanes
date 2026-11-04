import type { OperationSummary } from '../modules/tasks/operation-contract';
import { changeLabel } from './change-status';
import type { SyncStatus } from '../modules/tasks/sync-contract';
import { Icon } from '../ui/Icon';
import { Popover } from '../ui/Popover';
import { syncPresentation } from './sync-presentation';

interface Props {
  unfinished: readonly OperationSummary[];
  moreUnfinished: boolean;
  unfinishedLoading: boolean;
  unfinishedError: string;
  onMoreUnfinished: () => void;
  onRetryUnfinished: () => void;
  onInspectChange: (id: string) => void;
  connected: boolean;
  reachable: boolean;
  busy: boolean;
  error: string;
  status: SyncStatus | null;
  onRefresh: () => void;
}

export function SyncControl(props: Props) {
  const sync = syncPresentation(props);
  const state =
    !props.busy && (props.unfinished.length > 0 || props.unfinishedError) && sync.kind === 'synced'
      ? {
          kind: 'paused' as const,
          label: props.unfinishedError ? 'couldn’t check saves' : 'unfinished saves',
        }
      : sync;
  return (
    <Popover
      label={`google sync: ${state.label}`}
      trigger={
        <Icon
          name={
            state.kind === 'synced'
              ? 'cloud-check'
              : state.kind === 'error' || state.kind === 'paused'
                ? 'cloud-off'
                : 'cloud'
          }
        />
      }
      triggerClassName={`workspace__icon-button sync-control sync-control--${state.kind}`}
      className="sync-control__panel"
      align="end"
    >
      {(close) => (
        <div className="sync-control__body">
          <strong role="status">{state.label}</strong>
          {props.error && <p role="alert">{props.error}</p>}
          <button
            className="popover__item"
            disabled={props.busy || !props.connected || !props.reachable}
            onClick={props.onRefresh}
          >
            <Icon name="sync" size={15} /> {props.busy ? 'refreshing…' : 'refresh now'}
          </button>
          {props.unfinished.length > 0 && (
            <section className="sync-control__saves" aria-label="unfinished saves">
              {props.unfinished.map((item) => (
                <button
                  key={item.id}
                  className="popover__item"
                  onClick={() => {
                    close();
                    props.onInspectChange(item.id);
                  }}
                >
                  <span>
                    {changeLabel(item.kind)}
                    <small>
                      {new Date(item.createdAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </small>
                  </span>
                  <Icon name="right" size={13} />
                </button>
              ))}
              {props.moreUnfinished && (
                <button
                  className="popover__item"
                  disabled={props.unfinishedLoading}
                  onClick={props.onMoreUnfinished}
                >
                  more unfinished saves
                </button>
              )}
            </section>
          )}
          {props.unfinishedError && (
            <div className="sync-control__error">
              <p>couldn’t check unfinished saves.</p>
              <button
                className="popover__item"
                disabled={props.unfinishedLoading}
                onClick={props.onRetryUnfinished}
              >
                try again
              </button>
            </div>
          )}
        </div>
      )}
    </Popover>
  );
}
