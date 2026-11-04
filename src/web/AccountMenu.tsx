import type { ConnectionSummary } from '../modules/accounts/contracts';
import { Popover } from '../ui/Popover';
import { Icon } from '../ui/Icon';

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
      trigger={<span className="workspace__avatar">{account.displayName.slice(0, 1)}</span>}
      triggerClassName="workspace__icon-button workspace__account-trigger"
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
                {item.id === account.id && <Icon name="check" size={14} />}
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
            connection and data
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
