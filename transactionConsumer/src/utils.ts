import { z } from "zod";

export const messageValidator = z.strictObject({
  messageId: z.string().uuid(),
  from: z.number(),
  to: z.number(),
  ammount: z.number(),
});
