import { ErrorCode, StandardResolutionReasons, type ResolutionDetails } from '@openfeature/core';
import type { Json } from '@stagecraft/core';

export type Kind = 'boolean' | 'string' | 'number' | 'object';

const META = { source: 'stagecraft' };

function kindOf(v: unknown): Kind | 'null' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'object';
  const t = typeof v;
  return t === 'boolean' || t === 'string' || t === 'number' ? t : 'object';
}

/**
 * Resolve one flag from a Stagecraft flag map (exported for the server provider and tests).
 * Found: reason STATIC (the value is fixed by the prototype, not targeted). Missing: the code
 * default with reason DEFAULT. Wrong type: the default with TYPE_MISMATCH.
 */
export function resolveFromFlags<T>(flags: Record<string, Json>, kind: Kind, flagKey: string, defaultValue: T): ResolutionDetails<T> {
  if (!Object.prototype.hasOwnProperty.call(flags, flagKey)) {
    return { value: defaultValue, reason: StandardResolutionReasons.DEFAULT, flagMetadata: META };
  }
  const v = flags[flagKey];
  if (kindOf(v) !== kind) {
    return {
      value: defaultValue,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.TYPE_MISMATCH,
      errorMessage: `Stagecraft flag "${flagKey}" is ${kindOf(v)}, not ${kind}`,
      flagMetadata: META,
    };
  }
  return {
    value: v as T,
    variant: kind === 'object' ? undefined : String(v),
    reason: StandardResolutionReasons.STATIC,
    flagMetadata: META,
  };
}
