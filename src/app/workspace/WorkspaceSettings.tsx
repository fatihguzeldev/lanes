import {
  AccountPreferences,
  useAccountPreferences,
} from '../../modules/accounts/browser/preferences/AccountPreferences';
import './WorkspaceSettings.css';
import { Icon } from '../../shared/ui/icon/Icon';
import { Popover } from '../../shared/ui/popover/Popover';

interface Props {
  preferences: ReturnType<typeof useAccountPreferences>;
  labelled?: boolean;
  onTransfer: () => void;
  onTemplates: () => void;
}

export function WorkspaceSettings(props: Props) {
  return (
    <Popover
      label="settings"
      trigger={
        <>
          <Icon name="settings" />
          {props.labelled && <span>settings</span>}
        </>
      }
      triggerClassName={props.labelled ? 'workspace__utility-button' : 'workspace__icon-button'}
      className="workspace-settings"
      align="end"
    >
      {(close) => (
        <div className="workspace-settings__body">
          <AccountPreferences controller={props.preferences} />
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
