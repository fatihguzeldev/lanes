import type { ConnectionSummary } from '../contracts';
import { Popover } from '../../../shared/ui/popover/Popover';
import { Icon } from '../../../shared/ui/icon/Icon';
import './AccountMenu.css';

interface Props {
  account: ConnectionSummary;
  accounts: readonly ConnectionSummary[];
  onSelect: (id: string) => void;
  onConnect: () => void;
  onManage: () => void;
  onSignOut: () => void;
}

export function AccountMenu({
  account,
  accounts,
  onSelect,
  onConnect,
  onManage,
  onSignOut,
}: Props) {
  return (
    <Popover
      label={`google account: ${account.email}`}
      trigger={<span className="account-menu__avatar">{account.displayName.slice(0, 1)}</span>}
      triggerClassName="account-menu__trigger"
      className="account-menu"
      align="end"
    >
      {(close) => (
        <div className="popover__menu">
          <div className="account-menu__identity">
            <strong>{account.displayName}</strong>
            <span>{account.email}</span>
          </div>
          {accounts.length > 1 &&
            accounts.map((item) => (
              <button
                className="popover__item"
                key={item.id}
                aria-pressed={item.id === account.id}
                onClick={() => {
                  close();
                  onSelect(item.id);
                }}
              >
                <span>{item.email}</span>
                {item.id === account.id && (
                  <Icon name="check" size={14} className="account-menu__selected-check" />
                )}
              </button>
            ))}
          <button
            className="popover__item"
            onClick={() => {
              close();
              onConnect();
            }}
          >
            <Icon name="plus" size={15} /> connect another account
          </button>
          <button
            className="popover__item"
            onClick={() => {
              close();
              onManage();
            }}
          >
            <Icon name="link" size={15} /> connection and data
          </button>
          <button
            className="popover__item"
            onClick={() => {
              close();
              onSignOut();
            }}
          >
            <Icon name="logout" size={15} /> sign out
          </button>
        </div>
      )}
    </Popover>
  );
}
