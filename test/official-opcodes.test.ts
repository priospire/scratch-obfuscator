import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {OFFICIAL_CORE_OPCODES, OFFICIAL_EXTENSION_IDS} from '../src/validation/index.js';

interface VmRuntimeShape {
  readonly _primitives: Record<string, unknown>;
  readonly _hats: Record<string, unknown>;
}

interface VmShape {
  readonly runtime: VmRuntimeShape;
  quit(): void;
}

type VmConstructor = new () => VmShape;

const require = createRequire(import.meta.url);
const Vm = require('../node_modules/@scratch/scratch-vm/src/index.js') as VmConstructor;

describe('pinned official opcode surface', () => {
  it('keeps the production core allowlist aligned with Scratch VM 15.1.0', () => {
    const vm = new Vm();
    try {
      const registered = new Set([
        ...Object.keys(vm.runtime._primitives),
        ...Object.keys(vm.runtime._hats),
        'procedures_prototype'
      ]);
      expect([...registered].filter(opcode => !OFFICIAL_CORE_OPCODES.has(opcode))).toEqual([]);
      for (const serializedShadow of [
        'control_create_clone_of_menu',
        'event_broadcast_menu',
        'looks_costume',
        'motion_goto_menu',
        'sensing_keyoptions',
        'sensing_of_object_menu',
        'sound_sounds_menu'
      ]) {
        expect(OFFICIAL_CORE_OPCODES.has(serializedShadow)).toBe(true);
      }
    } finally {
      vm.quit();
    }
  });

  it('includes the pinned VM face-sensing builtin', () => {
    const managerSource = readFileSync(require.resolve('../node_modules/@scratch/scratch-vm/src/extension-support/extension-manager.js'), 'utf8');
    const registered = [...managerSource.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*): \(\) => require\('\.\.\/extensions\//gm)]
      .map(match => match[1])
      .filter((value): value is string => value !== undefined)
      .sort();
    expect([...OFFICIAL_EXTENSION_IDS].sort()).toEqual(registered);
    expect(registered).toContain('faceSensing');
  });
});
