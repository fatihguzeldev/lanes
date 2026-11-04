import { handleRequest } from './request';
import { handleScheduled } from './scheduled';

export { handleRequest };
export default { fetch: handleRequest, scheduled: handleScheduled };
