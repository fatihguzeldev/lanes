import {
  AccountPreferences,
  useAccountPreferences,
} from '../../modules/accounts/browser/preferences/AccountPreferences';
import './WorkspaceSettings.css';
import type { ConnectionSummary } from '../../modules/accounts/contracts/connection';
import { Icon } from '../../shared/ui/icon/Icon';
import { Popover } from '../../shared/ui/popover/Popover';

interface Props {
  account: ConnectionSummary;
  clockOffset: number;
  onChanged: () => void;
  onTransfer: () => void;
  onTemplates: () => void;
}

export function WorkspaceSettings(props: Props) {
  const preferences = useAccountPreferences(props);
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
          <AccountPreferences controller={preferences} />
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
