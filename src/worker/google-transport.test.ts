import { expect, it, vi } from 'vitest';
import { googleTransport } from './google-transport';
it('counts failed, OAuth and provider requests against the same invocation budget', async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('network'))
    .mockResolvedValue(new Response('{}'));
  const budget = googleTransport(2, transport);
  await expect(budget.fetch('https://oauth2.googleapis.com/token')).rejects.toThrow('network');
  await budget.fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists');
  await expect(
    budget.fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists'),
  ).rejects.toMatchObject({ code: 'provider_rate_limited' });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(budget.used).toBe(2);
});
