import type { DataClassification } from './domain.js';

const LEVELS: readonly DataClassification[] = ['ordinary', 'sensitive', 'credential'];

export class SecurityClassificationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityClassificationError';
  }
}

export class ClassificationEngine {
  combine(inputs: readonly DataClassification[]): DataClassification {
    if (inputs.length === 0) return 'ordinary';
    return inputs.reduce((highest, current) => level(current) > level(highest) ? current : highest, 'ordinary');
  }

  opaqueTransform(inputs: readonly DataClassification[], _transform: 'model' | 'shell' | 'process' | 'unknown'): DataClassification {
    return this.combine(inputs);
  }

  applyProjectClassification(current: DataClassification, proposed: DataClassification): DataClassification {
    if (level(proposed) < level(current)) {
      throw new SecurityClassificationError('Project classification cannot lower an existing classification');
    }
    return proposed;
  }
}

type ContentlessOutputType = 'boolean' | 'number';

export class ContentlessAdapterRegistry {
  private readonly adapters = new Map<string, ReadonlySet<ContentlessOutputType>>();

  register(name: string, outputTypes: readonly ContentlessOutputType[]): void {
    if (name.length === 0 || outputTypes.length === 0) throw new SecurityClassificationError('Contentless adapter registration is incomplete');
    if (this.adapters.has(name)) throw new SecurityClassificationError(`Contentless adapter is already registered: ${name}`);
    this.adapters.set(name, new Set(outputTypes));
  }

  classify(name: string, output: unknown): DataClassification {
    const allowed = this.adapters.get(name);
    if (allowed === undefined) throw new SecurityClassificationError(`Contentless adapter is not registered: ${name}`);
    const type = typeof output;
    if ((type !== 'boolean' && type !== 'number') || !allowed.has(type)) {
      throw new SecurityClassificationError('Trusted adapters may only classify registered contentless scalar outputs');
    }
    if (type === 'number' && !Number.isFinite(output as number)) throw new SecurityClassificationError('Contentless number must be finite');
    return 'ordinary';
  }
}

function level(value: DataClassification): number {
  return LEVELS.indexOf(value);
}
