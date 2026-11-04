import { z } from 'zod';
export const ReadSpreadsheetSchema = z
  .object({ spreadsheetId: z.string().min(1).max(4096) })
  .strict();
export const ReadSpreadsheetRangeSchema = ReadSpreadsheetSchema.extend({
  sheet: z.string().min(1).max(100),
  range: z.string().min(1).max(100),
}).strict();
export const SpreadsheetMetadataSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    locale: z.string().nullable(),
    timeZone: z.string().nullable(),
    sheets: z
      .array(
        z
          .object({
            id: z.number().int().nonnegative(),
            title: z.string(),
            rowCount: z.number().int().positive(),
            columnCount: z.number().int().positive(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type SpreadsheetMetadata = z.infer<typeof SpreadsheetMetadataSchema>;
