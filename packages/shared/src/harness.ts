import { z } from 'zod';

export const ValidationEngine = z.enum(['metadata', 'tooling']);
export const CheckpointSummary = z.object({
  id: z.string(),
  sessionId: z.string(),
  deployId: z.string(),
  engine: ValidationEngine,
  scope: z.enum(['full', 'slice']),
  checkOnly: z.boolean(),
  status: z.enum(['in_progress', 'uncertain', 'succeeded', 'failed', 'quarantined']),
  payloadHash: z.string(),
  comparisonKey: z.string(),
  rootCount: z.number().nullable(),
  createdAt: z.string(),
  restoredFrom: z.string().nullable(),
});
export type CheckpointSummary = z.infer<typeof CheckpointSummary>;
export const HydrationEntry = z.object({
  resource: z.string(),
  source: z.enum(['git', 'describe', 'tooling', 'metadata']),
  status: z.enum(['verified', 'absent', 'unavailable', 'stale']),
  apiVersion: z.string(),
  identity: z.string(),
  fetchedAt: z.string(),
  contentHash: z.string().nullable(),
  detail: z.string().nullable(),
  data: z.unknown(),
});
export type HydrationEntry = z.infer<typeof HydrationEntry>;
export const HydrationBundle = z.object({
  id: z.string(),
  sessionId: z.string(),
  createdAt: z.string(),
  passes: z.number(),
  requirements: z.string(),
  entries: z.array(HydrationEntry),
});
export type HydrationBundle = z.infer<typeof HydrationBundle>;
