import {createRequire} from 'node:module';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterAll, describe, expect, it} from 'vitest';
import {runCli} from '../src/cli.js';
import {isScratchBlock} from '../src/model/blocks.js';
import type {ObfuscationMode} from '../src/types.js';
import {createFixtureArchive, readProjectFromArchive} from './support.js';

interface ScratchVmInstance {
  attachStorage(storage: unknown): void;
  loadProject(project: Uint8Array): Promise<void>;
  saveProjectSb3(): Promise<Blob | Uint8Array>;
  start(): void;
  greenFlag(): void;
  quit(): void;
  runtime: {
    targets: RuntimeTarget[];
    threads: unknown[];
    _step(): void;
  };
}

interface RuntimeVariable {
  type: string;
  value: unknown;
  isCloud: boolean;
}

interface RuntimeTarget {
  isStage: boolean;
  x: number;
  y: number;
  visible: boolean;
  variables: Record<string, RuntimeVariable>;
  blocks: {
    getScripts(): string[];
    toXML(): string;
  };
}

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;
type ScratchParser = (input: Uint8Array, isSprite: boolean, callback: (error: Error | null, result?: unknown) => void) => void;

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
const parserValue: unknown = require('scratch-parser');
if (typeof vmValue !== 'function') throw new Error('official Scratch VM constructor is unavailable');
if (typeof storageValue !== 'object' || storageValue === null || typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function') {
  throw new Error('official Scratch storage constructor is unavailable');
}
if (typeof parserValue !== 'function') throw new Error('official Scratch parser is unavailable');
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;
const parseScratch = parserValue as ScratchParser;

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

describe('official Scratch compatibility gates', () => {
  it.each<ObfuscationMode>(['lossless', 'lossy', 'no-preserve'])('%s output parses, loads, saves, and reloads', async mode => {
    const directory = await mkdtemp(join(tmpdir(), `scratch-obfuscator-${mode}-`));
    directories.push(directory);
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    await writeFile(input, createFixtureArchive());
    const diagnostics: string[] = [];
    const code = await runCli([input, '-o', output, `--${mode}`], {
      stdout: () => undefined,
      stderr: text => diagnostics.push(text)
    });
    expect(code, diagnostics.join('')).toBe(0);

    const outputBytes = await readFile(output);
    if (mode === 'no-preserve') {
      const transformed = readProjectFromArchive(outputBytes);
      const opcodes = transformed.targets.flatMap(target => Object.values(target.blocks).filter(isScratchBlock).map(block => block.opcode));
      expect(opcodes).toContain('control_if_else');
      expect(opcodes).toContain('procedures_definition');
    }
    const parsed = await parserProject(outputBytes);
    expect(Array.isArray(parsed)).toBe(true);

    const vm = createVm();
    await vm.loadProject(outputBytes);
    expect(vm.runtime.targets.length).toBeGreaterThan(0);
    const saved = await vm.saveProjectSb3();
    const savedBytes = await blobBytes(saved);
    expect(savedBytes.length).toBeGreaterThan(0);

    const reloaded = createVm();
    await reloaded.loadProject(savedBytes);
    expect(reloaded.runtime.targets.length).toBe(vm.runtime.targets.length);
  }, 60_000);

  it.each<ObfuscationMode>(['lossless', 'lossy', 'no-preserve'])('%s ignores source ZIP order, compression, and timestamps', async mode => {
    const directory = await mkdtemp(join(tmpdir(), `scratch-obfuscator-determinism-${mode}-`));
    directories.push(directory);
    const firstInput = join(directory, 'first.sb3');
    const secondInput = join(directory, 'second.sb3');
    const firstOutput = join(directory, 'first.output.sb3');
    const secondOutput = join(directory, 'second.output.sb3');
    await writeFile(firstInput, createFixtureArchive(undefined, false));
    await writeFile(secondInput, createFixtureArchive(undefined, true));
    const io = {stdout: () => undefined, stderr: () => undefined};
    expect(await runCli([firstInput, '-o', firstOutput, `--${mode}`], io)).toBe(0);
    expect(await runCli([secondInput, '-o', secondOutput, `--${mode}`], io)).toBe(0);
    expect(await readFile(firstOutput)).toEqual(await readFile(secondOutput));
  });

  it.each<ObfuscationMode>(['lossless', 'lossy', 'no-preserve'])('%s preserves the sequential fixture effects', async mode => {
    const directory = await mkdtemp(join(tmpdir(), `scratch-obfuscator-effects-${mode}-`));
    directories.push(directory);
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    const originalBytes = createFixtureArchive();
    await writeFile(input, originalBytes);
    expect(await runCli([input, '-o', output, `--${mode}`], {stdout: () => undefined, stderr: () => undefined})).toBe(0);
    expect(await executeSnapshot(await readFile(output))).toEqual(await executeSnapshot(originalBytes));
  }, 60_000);

  it('extra level 2 hides and disables native event columns while remaining saveable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scratch-obfuscator-extra2-runtime-'));
    directories.push(directory);
    const input = join(directory, 'input.sb3');
    const output = join(directory, 'output.sb3');
    const resavedInput = join(directory, 'official-resave.sb3');
    const reobfuscatedOutput = join(directory, 'reobfuscated.sb3');
    await writeFile(input, createFixtureArchive());
    const diagnostics: string[] = [];
    expect(await runCli([input, '-o', output, '-extra', '2'], {
      stdout: () => undefined,
      stderr: text => diagnostics.push(text)
    }), diagnostics.join('')).toBe(0);
    expect(diagnostics.join('')).toContain('Affected stacks do not execute');
    expect(diagnostics.join('')).toContain('does not prevent saving');

    const outputBytes = await readFile(output);
    const raw = readProjectFromArchive(outputBytes);
    const rawHatSites = raw.targets.flatMap((target, targetIndex) => Object.entries(target.blocks)
      .flatMap(([hatId, value]) => isScratchBlock(value)
        && value.topLevel
        && (value.opcode.startsWith('event_when') || value.opcode === 'control_start_as_clone')
        ? [{targetIndex, hatId}]
        : []));
    expect(rawHatSites).toHaveLength(2);
    expect(rawHatSites.every(site => {
      const block = raw.targets[site.targetIndex]?.blocks[site.hatId];
      return isScratchBlock(block) && block.shadow;
    })).toBe(true);

    const vm = createVm();
    const reloaded = createVm();
    const reobfuscated = createVm();
    try {
      await vm.loadProject(outputBytes);
      expect(vm.runtime.targets.flatMap(target => target.blocks.getScripts())).toEqual([]);
      expect(vm.runtime.targets.map(target => target.blocks.toXML())).toEqual(['', '']);
      vm.start();
      vm.greenFlag();
      for (let step = 0; step < 20 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
      expect(vm.runtime.threads).toHaveLength(0);
      const stage = vm.runtime.targets.find(target => target.isStage);
      const sprite = vm.runtime.targets.find(target => !target.isStage);
      expect(Object.values(stage?.variables ?? {}).some(variable => variable.value === 42)).toBe(false);
      expect(sprite?.x).toBe(0);

      const savedBytes = await blobBytes(await vm.saveProjectSb3());
      expect(savedBytes.length).toBeGreaterThan(0);
      const saved = readProjectFromArchive(savedBytes);
      for (const site of rawHatSites) {
        const block = saved.targets[site.targetIndex]?.blocks[site.hatId];
        expect(isScratchBlock(block) && block.shadow).toBe(true);
        expect(isScratchBlock(block) && block.topLevel).toBe(false);
      }
      await reloaded.loadProject(savedBytes);
      expect(reloaded.runtime.targets.flatMap(target => target.blocks.getScripts())).toEqual([]);

      await writeFile(resavedInput, savedBytes);
      const reobfuscationDiagnostics: string[] = [];
      expect(await runCli([resavedInput, '-o', reobfuscatedOutput, '-extra', '2'], {
        stdout: () => undefined,
        stderr: text => reobfuscationDiagnostics.push(text)
      }), reobfuscationDiagnostics.join('')).toBe(0);
      expect(reobfuscationDiagnostics.join('')).toContain('VM-normalized shadow event stack root');
      await reobfuscated.loadProject(await readFile(reobfuscatedOutput));
      expect(reobfuscated.runtime.targets.flatMap(target => target.blocks.getScripts())).toEqual([]);
    } finally {
      vm.quit();
      reloaded.quit();
      reobfuscated.quit();
    }
  }, 60_000);
});

function createVm(): ScratchVmInstance {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  return vm;
}

function parserProject(bytes: Uint8Array): Promise<unknown> {
  return new Promise((resolve, reject) => {
    parseScratch(bytes, false, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function blobBytes(value: Blob | Uint8Array): Promise<Uint8Array> {
  return value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
}

async function executeSnapshot(project: Uint8Array): Promise<Record<string, unknown>> {
  const vm = createVm();
  try {
    await vm.loadProject(project);
    vm.start();
    vm.greenFlag();
    for (let step = 0; step < 200 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
    expect(vm.runtime.threads).toHaveLength(0);
    const stage = vm.runtime.targets.find(target => target.isStage);
    const sprite = vm.runtime.targets.find(target => !target.isStage);
    if (!stage || !sprite) throw new Error('fixture targets did not load');
    const stageValues = Object.values(stage.variables);
    const score = stageValues.find(variable => variable.type === '' && !variable.isCloud);
    const globalList = stageValues.find(variable => variable.type === 'list');
    return {
      score: score?.value,
      globalList: globalList?.value,
      spriteX: sprite.x,
      spriteY: sprite.y,
      spriteVisible: sprite.visible
    };
  } finally {
    vm.quit();
  }
}
