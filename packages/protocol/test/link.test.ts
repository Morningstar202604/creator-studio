import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, decodeFrame, encodeFrame } from '../src/index.js';

describe('Agent Link frames', () => {
  it('round-trips a hello frame', () => {
    const frame = {
      t: 'hello' as const,
      deviceId: 'd1',
      token: 'tok',
      capabilities: ['fs.read', 'media.probe'],
      protocolVersion: PROTOCOL_VERSION,
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it('round-trips a tool call', () => {
    const frame = {
      t: 'tool.call' as const,
      callId: 'c1',
      name: 'fs.read',
      args: { path: 'script/script.v3.md' },
      timeoutMs: 60_000,
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it('round-trips both tool result variants', () => {
    const ok = { t: 'tool.result' as const, callId: 'c1', ok: true as const, result: { bytes: 42 } };
    const err = {
      t: 'tool.result' as const,
      callId: 'c2',
      ok: false as const,
      error: { code: 'DEVICE_OFFLINE', message: 'no heartbeat for 90s' },
    };
    expect(decodeFrame(encodeFrame(ok))).toEqual(ok);
    expect(decodeFrame(encodeFrame(err))).toEqual(err);
  });

  it('rejects an unknown frame type', () => {
    expect(() => decodeFrame(JSON.stringify({ t: 'eval', code: 'rm -rf /' }))).toThrowError(
      /LINK_FRAME_INVALID/,
    );
  });

  it('rejects malformed json', () => {
    expect(() => decodeFrame('{"t":')).toThrowError(/LINK_FRAME_NOT_JSON/);
  });

  it('rejects a tool call without timeout', () => {
    const bad = { t: 'tool.call', callId: 'c1', name: 'fs.read', args: {} };
    expect(() => decodeFrame(JSON.stringify(bad))).toThrowError(/LINK_FRAME_INVALID/);
  });

  it('rejects a timeout above the 30 minute ceiling', () => {
    const bad = { t: 'tool.call', callId: 'c1', name: 'media.transcode', args: {}, timeoutMs: 1_800_001 };
    expect(() => decodeFrame(JSON.stringify(bad))).toThrowError(/LINK_FRAME_INVALID/);
  });
});
