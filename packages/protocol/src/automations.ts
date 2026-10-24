import { z } from 'zod';

const IsoDateTime = z.string().datetime({ offset: false });

export const AutomationKindSchema = z.enum(['topic-card', 'research-notes', 'publish-pack']);
export type AutomationKind = z.infer<typeof AutomationKindSchema>;

export const AutomationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: AutomationKindSchema,
  prompt: z.string().min(1).max(2000),
  intervalMinutes: z.number().int().min(15).max(10_080),
  enabled: z.boolean(),
  lastRunAt: IsoDateTime.nullable(),
  nextRunAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Automation = z.infer<typeof AutomationSchema>;

export const AutomationInputSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: AutomationKindSchema,
  prompt: z.string().min(1).max(2000),
  intervalMinutes: z.number().int().min(15).max(10_080).default(1440),
  enabled: z.boolean().default(true),
});
export type AutomationInput = z.infer<typeof AutomationInputSchema>;

export const ProjectMetricsSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  recordedAt: IsoDateTime,
  views: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  shares: z.number().int().nonnegative(),
  /** Average view duration as a percentage of video length (0-100). */
  retentionPercent: z.number().min(0).max(100),
  revenueCny: z.number().nonnegative(),
  note: z.string().max(300),
});
export type ProjectMetrics = z.infer<typeof ProjectMetricsSchema>;

export const ProjectMetricsInputSchema = ProjectMetricsSchema.pick({
  views: true,
  likes: true,
  comments: true,
  shares: true,
  retentionPercent: true,
  revenueCny: true,
  note: true,
}).partial({ shares: true, retentionPercent: true, revenueCny: true, note: true });
export type ProjectMetricsInput = z.infer<typeof ProjectMetricsInputSchema>;

/** Engagement rate used by the review page; returns 0 for zero views. */
export function engagementRate(metrics: Pick<ProjectMetrics, 'views' | 'likes' | 'comments' | 'shares'>): number {
  if (metrics.views <= 0) return 0;
  return (metrics.likes + metrics.comments + metrics.shares) / metrics.views;
}
