import { describe, expect, it } from 'vitest';
import {
  ClassificationEngine,
  ContentlessAdapterRegistry,
  SecurityClassificationError,
} from '../../../src/security/index.js';

describe('classification engine', () => {
  it('propagates the highest input classification for opaque transforms', () => {
    const engine = new ClassificationEngine();
    expect(engine.combine(['ordinary', 'sensitive'])).toBe('sensitive');
    expect(engine.combine(['ordinary', 'credential', 'sensitive'])).toBe('credential');
    expect(engine.opaqueTransform(['sensitive'], 'shell')).toBe('sensitive');
  });

  it('lets project classification only raise an existing classification', () => {
    const engine = new ClassificationEngine();
    expect(engine.applyProjectClassification('ordinary', 'sensitive')).toBe('sensitive');
    expect(() => engine.applyProjectClassification('credential', 'ordinary'))
      .toThrow(SecurityClassificationError);
  });

  it('allows registered contentless adapters to classify only contentless outputs', () => {
    const registry = new ContentlessAdapterRegistry();
    registry.register('exit-code', ['number']);

    expect(registry.classify('exit-code', 0)).toBe('ordinary');
    expect(() => registry.classify('exit-code', 'derived secret')).toThrow(SecurityClassificationError);
    expect(() => registry.classify('unknown', true)).toThrow(SecurityClassificationError);
  });

  it('preserves monotonicity for a fixed-seed generated corpus', () => {
    const engine = new ClassificationEngine();
    const levels = ['ordinary', 'sensitive', 'credential'] as const;
    let seed = 0xc0ffee;
    for (let index = 0; index < 512; index += 1) {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      const inputs = Array.from({ length: (seed % 7) + 1 }, (_, offset) => levels[(seed >>> (offset * 2)) % levels.length]!);
      const output = engine.opaqueTransform(inputs, 'model');
      expect(levels.indexOf(output)).toBe(Math.max(...inputs.map((value) => levels.indexOf(value))));
    }
  });
});
