import { z } from "zod";

// Request schemas — single source of truth for API validation.
// Response shapes still live in types.ts because they're derived from
// the backend/provider adapters, not from user input.

export const reserveRequestSchema = z.object({
  reserve_pct: z.number().min(0).max(100),
  reason: z.string().max(280).optional(),
});
