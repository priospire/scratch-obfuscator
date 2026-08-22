import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  OFFICIAL_CORE_OPCODES,
  OFFICIAL_EXTENSION_IDS,
  OFFICIAL_EXTENSION_OPCODES,
  OFFICIAL_LITERAL_SHADOW_OPCODES,
  validateOfficialExtensions
} from '../src/validation/extensions.js';
import type {ScratchProject} from '../src/types.js';

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
const extensionManagerPath = require.resolve('../node_modules/@scratch/scratch-vm/src/extension-support/extension-manager.js');

function registeredExtensionSources(): ReadonlyMap<string, string> {
  const managerSource = readFileSync(extensionManagerPath, 'utf8');
  return new Map([...managerSource.matchAll(
    /^ {4}([A-Za-z][A-Za-z0-9]*): \(\) => require\('\.\.\/extensions\/([^']+)'\),?$/gm
  )].flatMap(match => {
    const extensionId = match[1];
    const sourceDirectory = match[2];
    return extensionId && sourceDirectory ? [[extensionId, sourceDirectory] as const] : [];
  }));
}

function sourceOpcodeSurface(extensionId: string, sourceDirectory: string): ReadonlySet<string> {
  const sourcePath = join(dirname(extensionManagerPath), '..', 'extensions', sourceDirectory, 'index.js');
  const source = readFileSync(sourcePath, 'utf8');
  const blockOpcodes = [...source.matchAll(/^ {20}opcode: '([^']+)',$/gm)]
    .flatMap(match => match[1] ? [`${extensionId}_${match[1]}`] : []);
  const menuSection = source.match(/^ {12}menus: \{\r?\n([\s\S]*?)^ {12}\}\r?\n {8}\};/m)?.[1] ?? '';
  const menuOpcodes = [...menuSection.matchAll(/^ {16}([A-Za-z][A-Za-z0-9_]*):/gm)]
    .flatMap(match => match[1] ? [`${extensionId}_menu_${match[1]}`] : []);
  return new Set([...blockOpcodes, ...menuOpcodes]);
}

function extensionProject(extensionId: string, opcodes: readonly string[]): ScratchProject {
  const blocks = Object.fromEntries(opcodes.map((opcode, index) => [`block-${index}`, {
    opcode,
    next: null,
    parent: null,
    inputs: {},
    fields: {OPAQUE: ['preserved payload']},
    mutation: {tagName: 'mutation', opaque: 'preserved payload'},
    shadow: opcode.includes('_menu_'),
    topLevel: false
  }]));
  return {
    targets: [{blocks}],
    monitors: [],
    extensions: [extensionId]
  } as unknown as ScratchProject;
}

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

  it('matches every pinned bundled extension getInfo block and menu helper exactly', () => {
    const registered = registeredExtensionSources();
    expect([...OFFICIAL_EXTENSION_IDS].sort()).toEqual([...registered.keys()].sort());
    expect(registered.has('faceSensing')).toBe(true);

    for (const [extensionId, sourceDirectory] of registered) {
      const expected = sourceOpcodeSurface(extensionId, sourceDirectory);
      const actual = OFFICIAL_EXTENSION_OPCODES.get(extensionId);
      expect(actual, extensionId).toBeDefined();
      expect([...actual ?? []].sort(), extensionId).toEqual([...expected].sort());
    }
  });

  it('classifies every bundled extension menu and the implemented sound menus as literal shadows', () => {
    for (const opcode of ['sound_beats_menu', 'sound_effects_menu', 'sound_sounds_menu']) {
      expect(OFFICIAL_LITERAL_SHADOW_OPCODES.has(opcode), opcode).toBe(true);
    }

    for (const [extensionId, opcodes] of OFFICIAL_EXTENSION_OPCODES) {
      for (const opcode of opcodes) {
        const isMenu = opcode.startsWith(`${extensionId}_menu_`);
        expect(OFFICIAL_LITERAL_SHADOW_OPCODES.has(opcode), opcode).toBe(isMenu);
      }
    }
  });

  it('accepts every registered extension opcode while retaining opaque payloads', () => {
    for (const [extensionId, opcodes] of OFFICIAL_EXTENSION_OPCODES) {
      expect(
        () => validateOfficialExtensions(extensionProject(extensionId, [...opcodes])),
        extensionId
      ).not.toThrow();
    }
  });

  it('rejects invented block and menu opcodes that only reuse an official prefix', () => {
    for (const extensionId of OFFICIAL_EXTENSION_IDS) {
      for (const opcode of [`${extensionId}_invented`, `${extensionId}_menu_INVENTED`]) {
        expect(
          () => validateOfficialExtensions(extensionProject(extensionId, [opcode])),
          opcode
        ).toThrow(/unsupported opcode/);
      }
    }

    expect(() => validateOfficialExtensions({
      ...extensionProject('pen', ['pen_clear']),
      extensions: []
    })).toThrow(/undeclared extension "pen"/);
  });
});
