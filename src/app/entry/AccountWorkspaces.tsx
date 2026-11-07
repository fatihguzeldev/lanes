import { lazy, Suspense, useRef, useState, type ComponentProps } from 'react';
import type { ConnectionSummary } from '../../modules/accounts/contracts/connection';
import type { WorkspaceProps } from '../workspace/Workspace';
import { WorkspaceSkeleton } from '../workspace/WorkspaceSkeleton';

const Workspace = lazy(() =>
  import('../workspace/Workspace').then((module) => ({ default: module.Workspace })),
);

type BackgroundNotice = {
  accountId: string;
  message: string;
  operationId?: string | null | undefined;
};
type Props = Omit<WorkspaceProps, 'account' | 'active' | 'onBackgroundNotice'> & {
  selected: ConnectionSummary;
  loadingInitial: ComponentProps<typeof WorkspaceSkeleton>['accountInitial'];
};

/** Account selection changes the view; an accepted write keeps its original account owner. */
export function AccountWorkspaces({ selected, loadingInitial, ...props }: Props) {
  const visited = useRef(new Set<string>());
  visited.current.add(selected.id);
  const [notice, setNotice] = useState<BackgroundNotice | null>(null);
  const owners = props.accounts.filter((account) => visited.current.has(account.id));
  const noticeAccount = notice && props.accounts.find((account) => account.id === notice.accountId);
  return (
    <>
      {owners.map((account) => (
        <Suspense
          key={account.id}
          fallback={
            account.id === selected.id ? (
              <WorkspaceSkeleton theme={props.theme} accountInitial={loadingInitial ?? null} />
            ) : null
          }
        >
          <Workspace
            key={account.id}
            {...props}
            account={account}
            active={account.id === selected.id}
            onBackgroundNotice={(message, operationId) =>
              setNotice({ accountId: account.id, message, operationId })
            }
          />
        </Suspense>
      ))}
      {notice && noticeAccount && (
        <div className="app-global-error" role="alert">
          <span>
            {noticeAccount.displayName}: {notice.message}
          </span>
          <button onClick={() => setNotice(null)}>dismiss</button>
        </div>
      )}
    </>
  );
}
