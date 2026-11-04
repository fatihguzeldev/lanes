import type { ConnectionSummary } from '../../contracts/connection';
import { useCommands } from '../../../operations/browser/submission/useCommands';
import { useServerConnection } from '../../../../shared/browser/connectivity/useServerConnection';
import { Select } from '../../../../shared/ui/select/Select';
import { TimeZoneSelect } from '../../../../shared/ui/time-zone/TimeZoneSelect';
import './AccountPreferences.css';

interface PreferencesContext {
  account: ConnectionSummary;
  clockOffset: number;
  onChanged: () => void;
}

export function useAccountPreferences({ account, clockOffset, onChanged }: PreferencesContext) {
  const commands = useCommands(account.id, clockOffset, onChanged);
  const connection = useServerConnection();
  const disabled =
    commands.busy ||
    connection !== 'reachable' ||
    ['disconnecting', 'disconnected'].includes(account.state);
  const save = (patch: { planningZone?: string; weekStart?: number }) => {
    void commands.submit(
      { kind: 'account.preferences', input: { revision: account.revision, ...patch } },
      'local',
    );
  };
  return { account, disabled, busy: commands.busy, error: commands.error, save };
}

export function AccountPreferences({
  controller,
}: {
  controller: ReturnType<typeof useAccountPreferences>;
}) {
  const { account, disabled, busy, error, save } = controller;
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
          onChange={(value) => save({ weekStart: Number(value) })}
          options={[
            { value: '1', label: 'monday' },
            { value: '7', label: 'sunday' },
          ]}
        />
      </label>
      {busy && (
        <span className="account-preferences__status" role="status">
          saving…
        </span>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
