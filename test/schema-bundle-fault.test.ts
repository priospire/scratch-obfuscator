import {afterEach, describe, expect, it, vi} from 'vitest';

afterEach(() => {
  vi.doUnmock('../src/validation/schemas/sb3_definitions.json');
  vi.resetModules();
});

describe('bundled schema fault handling', () => {
  it('rejects a malformed definitions root during module initialization', async () => {
    vi.doMock('../src/validation/schemas/sb3_definitions.json', () => ({default: {}}));

    await expect(import('../src/validation/schema.js')).rejects
      .toThrowError(/schema definitions are malformed/);
  });

  it('rejects a malformed broadcast primitive overlay during module initialization', async () => {
    vi.doMock('../src/validation/schemas/sb3_definitions.json', () => ({
      default: {definitions: {broadcast_primitive: {items: []}}}
    }));

    await expect(import('../src/validation/schema.js')).rejects
      .toThrowError(/broadcast primitive schema is malformed/);
  });
});
