/** One work family per tick. Maintenance also gets a reserved turn under continuous load. */
export async function advanceScheduledWork(
  turn: number,
  work: readonly (() => Promise<boolean>)[],
  maintenance: () => Promise<void>,
  idle: () => Promise<void> = maintenance,
): Promise<void> {
  if (turn % 10 === 0 || !work.length) {
    await maintenance();
    return;
  }
  const start = (turn - Math.floor(turn / 10) - 1) % work.length;
  for (let offset = 0; offset < work.length; offset++)
    if (await work[(start + offset) % work.length]!()) return;
  await idle();
}
