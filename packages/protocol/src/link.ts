import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export const LinkHelloSchema = z.object({
  t: z.literal('hello'),
  deviceId: z.string().min(1),
  token: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type LinkHello = z.infer<typeof LinkHelloSchema>;

export const LinkToolCallSchema = z.object({
  t: z.literal('tool.call'),
  callId: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
  timeoutMs: z.number().int().positive().max(1_800_000),
});
export type LinkToolCall = z.infer<typeof LinkToolCallSchema>;

export const LinkToolOkSchema = z.object({
  t: z.literal('tool.result'),
  callId: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown(),
});
export type LinkToolOk = z.infer<typeof LinkToolOkSchema>;

export const LinkToolErrSchema = z.object({
  t: z.literal('tool.result'),
  callId: z.string().min(1),
  ok: z.literal(false),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
});
export type LinkToolErr = z.infer<typeof LinkToolErrSchema>;

export const LinkHeartbeatSchema = z.object({
  t: z.literal('heartbeat'),
  ts: z.number().int().nonnegative(),
});
export type LinkHeartbeat = z.infer<typeof LinkHeartbeatSchema>;

export const LinkCancelSchema = z.object({
  t: z.literal('cancel'),
  callId: z.string().min(1),
});
export type LinkCancel = z.infer<typeof LinkCancelSchema>;

export const LinkToolResultSchema = z.discriminatedUnion('ok', [LinkToolOkSchema, LinkToolErrSchema]);

export const LinkFrameSchema = z.union([
  z.discriminatedUnion('t', [
    LinkHelloSchema,
    LinkToolCallSchema,
    LinkHeartbeatSchema,
    LinkCancelSchema,
  ]),
  LinkToolResultSchema,
]);
export type LinkFrame = z.infer<typeof LinkFrameSchema>;

export function encodeFrame(frame: LinkFrame): string {
  return JSON.stringify(LinkFrameSchema.parse(frame));
}

export function decodeFrame(raw: string): LinkFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('LINK_FRAME_NOT_JSON');
  }
  const result = LinkFrameSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('LINK_FRAME_INVALID');
  }
  return result.data;
}
