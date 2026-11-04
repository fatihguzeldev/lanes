import { z } from 'zod';
const SheetsDraftSchema = z
  .object({
    createdAt: z.number().int().nonnegative(),
    sourceAccountId: z.string().min(1).max(1024),
    spreadsheet: z.string().max(4096),
    selectedSheets: z.array(z.string().min(1).max(256)).max(100),
    ranges: z
      .record(z.string().min(1).max(256), z.string().max(100))
      .refine((value) => Object.keys(value).length <= 100),
  })
  .strict();
export type SheetsSourceDraft = z.infer<typeof SheetsDraftSchema>;
export function decodeSheetsDraft(
  serialized: string | null,
  accountIds: readonly string[],
  now = Date.now(),
): SheetsSourceDraft | null {
  if (!serialized || serialized.length > 64000) return null;
  try {
    const value = SheetsDraftSchema.safeParse(JSON.parse(serialized));
    return value.success &&
      accountIds.includes(value.data.sourceAccountId) &&
      value.data.createdAt <= now + 300000 &&
      now - value.data.createdAt < 86400000
      ? value.data
      : null;
  } catch {
    return null;
  }
}
export function readSheetsDraft(
  destinationAccountId: string,
  accountIds: readonly string[],
): SheetsSourceDraft | null {
  try {
    return decodeSheetsDraft(
      sessionStorage.getItem(`lanes:transfer-source:${destinationAccountId}`),
      accountIds,
    );
  } catch {
    return null;
  }
}
export function writeSheetsDraft(
  destinationAccountId: string,
  draft: Omit<SheetsSourceDraft, 'createdAt'>,
): void {
  const value = SheetsDraftSchema.parse({ ...draft, createdAt: Date.now() });
  sessionStorage.setItem(`lanes:transfer-source:${destinationAccountId}`, JSON.stringify(value));
}
export function clearSheetsDraft(destinationAccountId: string): void {
  try {
    sessionStorage.removeItem(`lanes:transfer-source:${destinationAccountId}`);
  } catch {
    /* A blocked session store does not affect a confirmed server capture. */
  }
}
