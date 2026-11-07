import { useEffect, useRef, useState } from 'react';
import { ConnectionSummarySchema, type ConnectionSummary } from '../../contracts/connection';
import { AccountPreferencesSchema } from '../../contracts/preferences';
import { request } from '../../../../shared/browser/http/http';
import { useCommands } from '../../../operations/browser/submission/useCommands';
import { useServerConnection } from '../../../../shared/browser/connectivity/useServerConnection';
import { Select } from '../../../../shared/ui/select/Select';
import { TimeZoneSelect } from '../../../../shared/ui/time-zone/TimeZoneSelect';
import './AccountPreferences.css';

interface PreferencesContext {
  account: ConnectionSummary;
  clockOffset: number;
  onChanged: () => void;
  onError?: (message: string, operationId?: string | null) => void;
}

type PreferencePatch = Partial<Pick<ConnectionSummary, 'planningZone' | 'weekStart'>>;
interface PreferenceChange {
  id: number;
  patch: PreferencePatch;
  afterRevision: number | null;
}

export function useAccountPreferences({
  account,
  clockOffset,
  onChanged,
  onError,
}: PreferencesContext) {
  const commands = useCommands(account.id, clockOffset, onChanged);
  const connection = useServerConnection();
  const [changes, setChanges] = useState<PreferenceChange[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const jobs = useRef<PreferenceChange[]>([]);
  const running = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const latest = useRef({ commands, onChanged, onError });
  latest.current = { commands, onChanged, onError };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      running.current = false;
      jobs.current = [];
    };
  }, [account.id]);
  const disabled =
    connection !== 'reachable' || ['disconnecting', 'disconnected'].includes(account.state);
  const active = changes.filter(
    (change) => change.afterRevision === null || account.revision <= change.afterRevision,
  );
  const displayed = active.reduce((value, change) => ({ ...value, ...change.patch }), account);
  async function drain() {
    if (running.current) return;
    running.current = true;
    const epoch = generation.current;
    setBusy(true);
    try {
      while (jobs.current.length && alive.current && generation.current === epoch) {
        const job = jobs.current[0]!;
        try {
          const current = await request(
            `/api/accounts/${encodeURIComponent(account.id)}`,
            ConnectionSummarySchema,
          );
          if (!alive.current || generation.current !== epoch) return;
          const result = await latest.current.commands.submit(
            { kind: 'account.preferences', input: { revision: current.revision, ...job.patch } },
            'local',
          );
          if (!alive.current || generation.current !== epoch) return;
          if (result?.state !== 'succeeded') {
            const message =
              result?.error?.message ??
              latest.current.commands.getErrorDetails()?.message ??
              'couldn’t save these preferences. choose them again after checking the connection.';
            setError(message);
            latest.current.onError?.(
              message,
              result?.id ?? latest.current.commands.getErrorDetails()?.operationId ?? null,
            );
            const discarded = new Set(jobs.current.map((change) => change.id));
            jobs.current = [];
            setChanges((previous) => previous.filter((change) => !discarded.has(change.id)));
            latest.current.onChanged();
            return;
          }
          jobs.current.shift();
          setChanges((previous) =>
            previous.map((change) =>
              change.id === job.id ? { ...change, afterRevision: current.revision } : change,
            ),
          );
        } catch (failure) {
          if (!alive.current || generation.current !== epoch) return;
          const message =
            failure instanceof Error ? failure.message : 'couldn’t save these preferences.';
          setError(message);
          latest.current.onError?.(message);
          const discarded = new Set(jobs.current.map((change) => change.id));
          jobs.current = [];
          setChanges((previous) => previous.filter((change) => !discarded.has(change.id)));
          latest.current.onChanged();
          return;
        }
      }
    } finally {
      if (generation.current === epoch) {
        running.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }
  const save = (patch: PreferencePatch) => {
    if (
      disabled ||
      !AccountPreferencesSchema.safeParse({ revision: account.revision, ...patch }).success
    )
      return;
    if (
      Object.entries(patch).every(
        ([key, value]) => displayed[key as keyof ConnectionSummary] === value,
      )
    )
      return;
    const change = { id: ++sequence.current, patch: { ...patch }, afterRevision: null };
    jobs.current.push(change);
    setChanges((previous) => [
      ...previous.filter(
        (item) => item.afterRevision === null || account.revision <= item.afterRevision,
      ),
      change,
    ]);
    setError('');
    void drain();
  };
  return { account: displayed, disabled, busy, error: error || commands.error, save };
}

export function AccountPreferences({
  controller,
}: {
  controller: ReturnType<typeof useAccountPreferences>;
}) {
  const { account, disabled, error, save } = controller;
  return (
    <div className="account-preferences">
      <label>
        time zone
        <TimeZoneSelect
          value={account.planningZone}
          disabled={disabled}
          onChange={(planningZone) => save({ planningZone })}
        />
      </label>
      <label>
        week starts on
        <Select
          aria-label="week starts on"
          value={String(account.weekStart)}
          disabled={disabled}
          onChange={(value) => save({ weekStart: value === '7' ? 7 : 1 })}
          options={[
            { value: '1', label: 'monday' },
            { value: '7', label: 'sunday' },
          ]}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
