import { describe, expect, it } from 'vitest';
import { assertNextRunEventSeq } from '../src/index.js';

describe('INV-9 run event seq', () => {
  it('starts at zero', () => {
    expect(() => assertNextRunEventSeq(null, 0)).not.toThrow();
  });

  it('increments by one', () => {
    expect(() => assertNextRunEventSeq(4, 5)).not.toThrow();
  });

  it('rejects a gap', () => {
    expect(() => assertNextRunEventSeq(4, 6)).toThrowError(/INVALID_TRANSITION/);
  });

  it('rejects a replay', () => {
    expect(() => assertNextRunEventSeq(4, 4)).toThrowError(/INVALID_TRANSITION/);
  });

  it('rejects a first event above zero', () => {
    expect(() => assertNextRunEventSeq(null, 1)).toThrowError(/INVALID_TRANSITION/);
  });
});
