import { z } from "zod";

export const HealthResponseSchema = z.object({
  service: z.literal("santo-api"),
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
