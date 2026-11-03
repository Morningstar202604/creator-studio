import { describe, expect, it } from 'vitest';
import { sseEventName } from '../src/stream.js';

/**
 * Wire names follow AG-UI's vocabulary where a mapping exists, so a client library
 * built for that protocol can parse our stream without a custom adapter. These
 * tests exist because the mapping is easy to break silently: the payload still
 * carries the internal type, so nothing in the app would notice a regression.
 */
describe('SSE event naming', () => {
  it('uses AG-UI names for lifecycle events', () => {
    expect(sseEventName('step.started')).toBe('STEP_STARTED');
    expect(sseEventName('step.finished')).toBe('STEP_FINISHED');
    expect(sseEventName('tool.called')).toBe('TOOL_CALL_START');
    expect(sseEventName('tool.result')).toBe('TOOL_CALL_RESULT');
    expect(sseEventName('run.finished')).toBe('RUN_FINISHED');
  });

  it('renames error so it cannot collide with the browser error channel', () => {
    expect(sseEventName('error')).toBe('RUN_ERROR');
  });

  it('keeps the internal name for events AG-UI has no equivalent for', () => {
    // Inventing a standard name that does not exist would be worse than a custom
    // one: a client would try to parse it as something it is not.
    expect(sseEventName('approval.requested')).toBe('approval.requested');
    expect(sseEventName('budget.warning')).toBe('budget.warning');
  });
});
