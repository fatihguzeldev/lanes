import type { ConnectionSummary } from '../../modules/accounts/contracts/connection';
import { Icon } from '../../shared/ui/icon/Icon';
import { Popover } from '../../shared/ui/popover/Popover';
import { Select } from '../../shared/ui/select/Select';
import { TimeZoneSelect } from '../../shared/ui/time-zone/TimeZoneSelect';
import { useCommands } from '../../modules/operations/browser/submission/useCommands';
import { useServerConnection } from '../../shared/browser/connectivity/useServerConnection';

interface Props {
  account: ConnectionSummary;
  clockOffset: number;
  onChanged: () => void;
  onTransfer: () => void;
  onTemplates: () => void;
}

export function WorkspaceSettings(props: Props) {
  const { account } = props;
  const commands = useCommands(account.id, props.clockOffset, props.onChanged);
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
  return (
    <Popover
      label="settings"
      trigger={<Icon name="settings" />}
      triggerClassName="workspace__icon-button"
      className="workspace-settings"
      align="end"
    >
      {(close) => (
        <div className="workspace-settings__body">
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
          {commands.busy && (
            <span className="workspace-settings__status" role="status">
              saving…
            </span>
          )}
          {commands.error && (
            <p className="error" role="alert">
              {commands.error}
            </p>
          )}
          <div className="workspace-settings__tools popover__menu">
            <button
              className="popover__item"
              onClick={() => {
                close();
                props.onTransfer();
              }}
            >
              <Icon name="arrow" size={15} /> import & export
            </button>
            <button
              className="popover__item"
              onClick={() => {
                close();
                props.onTemplates();
              }}
            >
              <Icon name="copy" size={15} /> templates
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}
