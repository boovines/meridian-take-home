import { z } from "zod";

export const uuid = z.uuid();
export const revisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
