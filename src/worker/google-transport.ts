import { AppError } from '../contracts/errors';

/** One invocation shares this counter across OAuth, Tasks, and Sheets requests. */
export function googleTransport(maxRequests = 4, transport: typeof fetch = fetch) {
  let used = 0;
  const counted: typeof fetch = async (input, init) => {
    if (used >= maxRequests)
      throw new AppError(
        'provider_rate_limited',
        'this work reached its request budget and will continue in another slice.',
        429,
        true,
      );
    used++;
    return transport(input, init);
  };
  return {
    fetch: counted,
    get used() {
      return used;
    },
  };
}
