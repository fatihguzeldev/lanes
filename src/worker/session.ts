import { SessionSnapshotSchema, type SessionSnapshot } from '../modules/accounts/contracts/session';
import type { Services } from './composition/services';

export async function readSessionSnapshot(
  request: Request,
  accounts: Services['accounts'],
): Promise<SessionSnapshot> {
  const session = await accounts.sessions.getSession(request);
  const connections = session
    ? await accounts.connections.listConnectionSummaries(request)
    : undefined;
  return SessionSnapshotSchema.parse({
    configured: true,
    authenticated: !!session,
    serverTime: Date.now(),
    ...(connections ? { accounts: connections } : {}),
  });
}
