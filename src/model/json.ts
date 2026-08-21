import type {JsonValue, ScratchProject} from '../types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function assertJsonTree(value: unknown, path = '$', ancestors = new WeakSet<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} contains a non-finite number`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} contains a non-JSON value`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a cycle`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonTree(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    const prototype: unknown = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${path} contains a non-JSON object`);
    }
    for (const [key, child] of Object.entries(value)) {
      assertJsonTree(child, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

/** Clone JSON without sorting any object keys. */
export function cloneProject(project: ScratchProject): ScratchProject {
  return structuredClone(project);
}

/** Create a dictionary whose keys retain the source enumeration order. */
export function orderedDictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
