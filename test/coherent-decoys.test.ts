import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {strFromU8, unzipSync} from 'fflate';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock} from '../src/model/blocks.js';
import {applyAggressiveTransforms} from '../src/obfuscation/aggressive.js';
import {countBlockEquivalents, countObjectBlocks} from '../src/obfuscation/analysis.js';
import type {ObfuscationMode, ObfuscationStats, ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

interface ScratchVmInstance {
  attachStorage(storage: unknown): void;
  loadProject(project: Uint8Array): Promise<void>;
  postIOData(device: string, data: Record<string, unknown>): void;
  saveProjectSb3(): Promise<Blob | Uint8Array>;
  start(): void;
  greenFlag(): void;
  quit(): void;
  runtime: {
    targets: Array<{isStage: boolean; variables: Record<string, {value: unknown}>}>;
    threads: unknown[];
    _step(): void;
    emit(event: string, value: unknown): void;
  };
}

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
if (typeof vmValue !== 'function') throw new Error('official Scratch VM constructor is unavailable');
if (typeof storageValue !== 'object' || storageValue === null || typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function') {
  throw new Error('official Scratch storage constructor is unavailable');
}
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;

describe('coherent decoy subsystems', () => {
  it('builds deterministic broadcast and custom-block dependency cycles with opaque state', () => {
    const source = createFixtureProject();
    const first = structuredClone(source);
    const second = structuredClone(source);
    const firstStats = stats(first);
    const secondStats = stats(second);

    applyAggressiveTransforms(first, 'no-preserve', generator(73), firstStats);
    applyAggressiveTransforms(second, 'no-preserve', generator(73), secondStats);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(firstStats).toEqual(secondStats);
    validateProject(first);
    const originalBroadcastIds = new Set(Object.keys(source.targets[0]?.broadcasts ?? {}));
    const stage = requireTarget(first, 0);
    const generatedBroadcasts = Object.entries(stage.broadcasts)
      .filter(([id]) => !originalBroadcastIds.has(id));
    expect(generatedBroadcasts.length).toBeGreaterThanOrEqual(2);
    expect(generatedBroadcasts.every(([id]) => /^c_[A-Za-z0-9]{20}$/u.test(id))).toBe(true);
    expect(generatedBroadcasts.every(([, name]) => !/[A-Za-z]{3}/u.test(name))).toBe(true);

    const allBlocks = first.targets.flatMap(target => Object.entries(target.blocks)
      .filter((entry): entry is [string, ScratchBlock] => isScratchBlock(entry[1]))
      .map(([id, block]) => ({target, id, block})));
    const {received, sent} = broadcastReferenceCounts(first);
    const linkedBroadcastIds = generatedBroadcasts.map(([id]) => id).filter(id => (
      (received.get(id) ?? 0) > 0 && (sent.get(id) ?? 0) > 0
    ));
    expect(unpairedReceiverIds(first)).toEqual([]);
    expect(linkedBroadcastIds).toHaveLength(generatedBroadcasts.length);
    expect(linkedBroadcastIds.length).toBeGreaterThanOrEqual(2);
    expect(linkedBroadcastIds.some(id => (received.get(id) ?? 0) > 1)).toBe(true);
    expect(countLiveRailEntrySenders(first, new Set(linkedBroadcastIds))).toBe(linkedBroadcastIds.length);

    const callsByCode = new Map<string, number>();
    for (const {block} of allBlocks) {
      if (block.opcode !== 'procedures_call') continue;
      const code = block.mutation?.['proccode'];
      if (typeof code === 'string') callsByCode.set(code, (callsByCode.get(code) ?? 0) + 1);
    }
    const sharedFakeCode = [...callsByCode].find(([, count]) => count >= 2)?.[0];
    expect(sharedFakeCode).toBeTypeOf('string');
    expect(allBlocks.some(({block}) => block.opcode === 'procedures_prototype' && block.mutation?.['proccode'] === sharedFakeCode)).toBe(true);

    const opcodes = new Set(allBlocks.map(({block}) => block.opcode));
    const requiredOpcodes = [
      'control_wait',
      'data_addtolist',
      'data_itemoflist',
      'data_lengthoflist',
      'data_variable',
      'event_broadcast',
      'event_whenbroadcastreceived',
      'operator_divide',
      'operator_equals',
      'operator_join',
      'operator_mod',
      'operator_or',
      'procedures_call',
      'procedures_definition',
      'procedures_prototype'
    ];
    for (const opcode of requiredOpcodes) expect(opcodes.has(opcode), `missing ${opcode}`).toBe(true);
    expect(opcodes.has('operator_add')).toBe(true);
    expect(opcodes.has('operator_multiply')).toBe(true);
    expect(opcodes.has('operator_subtract')).toBe(true);
    expect(hasImpossiblePrivateCondition(first)).toBe(true);
    expect(procedureTopologySignatures(first).size).toBeGreaterThanOrEqual(3);
    const liveGuardAudit = auditLiveOpaqueGuards(first);
    expect(liveGuardAudit.strongGuards).toBe(liveGuardAudit.guards);
    expect(liveGuardAudit.reporterOpcodes.size).toBeGreaterThanOrEqual(3);
    expect(liveGuardAudit.conditionOpcodes.size).toBeGreaterThanOrEqual(3);

    const retained = procedureAwareReachableBlocks(first);
    const retainedGeneratedMessages = allBlocks.filter(({id, block}) => {
      if (!retained.has(id)) return false;
      if (block.opcode === 'event_whenbroadcastreceived') {
        const broadcastId = block.fields['BROADCAST_OPTION']?.[1];
        return typeof broadcastId === 'string' && linkedBroadcastIds.includes(broadcastId);
      }
      const primitive = block.opcode === 'event_broadcast' ? block.inputs['BROADCAST_INPUT']?.[1] : undefined;
      const broadcastId = Array.isArray(primitive) ? primitive[2] : undefined;
      return typeof broadcastId === 'string' && linkedBroadcastIds.includes(broadcastId);
    });
    expect(new Set(retainedGeneratedMessages.map(({block}) => block.opcode))).toEqual(new Set([
      'event_broadcast',
      'event_whenbroadcastreceived'
    ]));
    expect(generatedRetentionRatio(source, first, retained)).toBeGreaterThan(0.9);
  });

  it('scales retained paired systems with quota while filling the finite cap', () => {
    const small = emptyLoadableProject();
    const large = scaledNoPreserveProject();
    const smallBefore = countBlockEquivalents(small);
    const largeBefore = countBlockEquivalents(large);
    const smallStats = stats(small);
    const largeStats = stats(large);

    const compact = scaledNoPreserveProject();
    const compactBefore = countBlockEquivalents(compact);
    applyAggressiveTransforms(compact, 'no-preserve', generator(91), stats(compact));
    expect(countBlockEquivalents(compact)).toBe(Math.min((compactBefore * 3) + 512, 30_000));

    applyAggressiveTransforms(small, 'no-preserve', generator(91), smallStats, undefined, true);
    applyAggressiveTransforms(large, 'no-preserve', generator(91), largeStats, undefined, true);

    expect(countBlockEquivalents(small)).toBe(Math.min(
      Math.max((smallBefore * 25) + 512, smallBefore + 2048),
      100_000
    ));
    expect(countBlockEquivalents(large)).toBe(Math.min(
      Math.max((largeBefore * 25) + 512, largeBefore + 2048),
      100_000
    ));
    const smallPaired = pairedBroadcastCount(small);
    const largePaired = pairedBroadcastCount(large);
    expect(smallPaired).toBeGreaterThanOrEqual(6);
    expect(largePaired).toBeGreaterThan(128);
    expect(largePaired).toBeGreaterThan(smallPaired * 4);
    expect(smallStats.decoysAdded).toBeGreaterThan(100);
    expect(largeStats.decoysAdded).toBeGreaterThan(smallStats.decoysAdded * 4);
    const largeRetained = procedureAwareReachableBlocks(large);
    expect(generatedRetentionRatio(scaledNoPreserveProject(), large, largeRetained)).toBeGreaterThan(0.9);
    expect(procedureTopologySignatures(large).size).toBeGreaterThanOrEqual(3);
    expect(procedureBodyEquivalentSizes(large).size).toBeGreaterThanOrEqual(2);
    expect(unpairedReceiverIds(small)).toEqual([]);
    expect(unpairedReceiverIds(large)).toEqual([]);
    expect(obviousGeneratedRootOpcodes(emptyLoadableProject(), small)).toEqual([]);
    expect(obviousGeneratedRootOpcodes(scaledNoPreserveProject(), large)).toEqual([]);
    const smallSiteAudit = coherentSiteGrowthAudit(emptyLoadableProject(), small);
    const largeSiteAudit = coherentSiteGrowthAudit(scaledNoPreserveProject(), large);
    expect(smallSiteAudit.componentGrowths).toHaveLength(smallPaired);
    expect(largeSiteAudit.componentGrowths).toHaveLength(largePaired);
    expect(smallSiteAudit.componentGrowths.every(growth => growth >= 38 && growth <= 56)).toBe(true);
    expect(largeSiteAudit.componentGrowths.every(growth => growth >= 38 && growth <= 56)).toBe(true);
    expect(smallSiteAudit.siteGrowths.every(growth => growth <= 2_048)).toBe(true);
    expect(largeSiteAudit.siteGrowths.every(growth => growth <= 2_048)).toBe(true);
    expect(Math.max(...smallSiteAudit.siteGrowths)).toBeGreaterThan(256);
    expect(Math.max(...largeSiteAudit.siteGrowths)).toBeGreaterThan(256);
    const originalLargeIds = new Set(scaledNoPreserveProject().targets.flatMap(target => Object.keys(target.blocks)));
    const generatedVocabulary = new Set(large.targets.flatMap(target => Object.entries(target.blocks)
      .filter(([id, value]) => !originalLargeIds.has(id) && isScratchBlock(value))
      .map(([, value]) => isScratchBlock(value) ? value.opcode : '')));
    expect(generatedVocabulary.has('data_deleteoflist')).toBe(true);
    expect(generatedVocabulary.has('data_insertatlist')).toBe(true);
    validateProject(small);
    validateProject(large);
  });

  it('never adds an externally triggerable event surface in lossy mode', () => {
    for (const seed of [0, 37, 103, 255]) {
      const safe = largeSafeLossyProject();
      const beforeBroadcasts = structuredClone(requireTarget(safe, 0).broadcasts);
      const beforeReceivers = countOpcode(safe, 'event_whenbroadcastreceived');
      applyAggressiveTransforms(safe, 'lossy', generator(seed), stats(safe, 'lossy'));
      expect(requireTarget(safe, 0).broadcasts).toEqual(beforeBroadcasts);
      expect(countOpcode(safe, 'event_whenbroadcastreceived')).toBe(beforeReceivers);
      validateProject(safe);

      const unsafe = createFixtureProject();
      const unsafeBroadcasts = structuredClone(requireTarget(unsafe, 0).broadcasts);
      const unsafeReceivers = countOpcode(unsafe, 'event_whenbroadcastreceived');
      applyAggressiveTransforms(unsafe, 'lossy', generator(seed), stats(unsafe, 'lossy'));
      expect(requireTarget(unsafe, 0).broadcasts).toEqual(unsafeBroadcasts);
      expect(countOpcode(unsafe, 'event_whenbroadcastreceived')).toBe(unsafeReceivers);
      validateProject(unsafe);
    }
  });

  it('keeps true live-sponsor execution finite and isolated from packed live state', async () => {
    const source = liveStateIsolationProject();
    const transformed = structuredClone(source);
    applyAggressiveTransforms(transformed, 'no-preserve', generator(149), stats(transformed));
    validateProject(transformed);

    const sprite = requireTarget(transformed, 1);
    const liveSetter = sprite.blocks['set-live'];
    if (!isScratchBlock(liveSetter) || liveSetter.opcode !== 'data_replaceitemoflist') {
      throw new Error('live scalar was not packed into its expected list setter');
    }
    const liveListId = liveSetter.fields['LIST']?.[1];
    if (typeof liveListId !== 'string') throw new Error('packed live list ID is unavailable');
    const liveList = sprite.lists[liveListId]?.[1];
    if (!Array.isArray(liveList)) throw new Error('packed live list declaration is unavailable');
    const liveSlot = Number(primitiveValue(liveSetter.inputs['INDEX']?.[1]));
    if (!Number.isInteger(liveSlot) || liveSlot < 1) throw new Error('packed live slot is unavailable');

    const sponsor = findRelationalLiveSponsor(sprite);
    const stateDeclaration = sprite.variables[sponsor.stateVariableId];
    if (!stateDeclaration) throw new Error('live sponsor state declaration is unavailable');
    stateDeclaration[1] = sponsor.conditionOpcode === 'operator_gt' ? -10_000 : 10_000;
    const reachable = decoyDependencyClosure(transformed, 1, sponsor.substackId);
    const decoyListLocations = new Map<string, number>();
    const coherentStateListIds = new Set<string>();
    for (const [targetIndex, ids] of reachable) {
      const target = requireTarget(transformed, targetIndex);
      for (const id of ids) {
        const block = target.blocks[id];
        if (!isScratchBlock(block)) continue;
        const listId = block.fields['LIST']?.[1];
        if (typeof listId !== 'string') continue;
        decoyListLocations.set(listId, targetIndex);
        const itemReporterId = block.opcode === 'data_addtolist' ? block.inputs['ITEM']?.[1] : undefined;
        const itemReporter = typeof itemReporterId === 'string' ? target.blocks[itemReporterId] : undefined;
        if (isScratchBlock(itemReporter) && itemReporter.opcode === 'operator_join') {
          coherentStateListIds.add(listId);
        }
      }
    }
    expect(decoyListLocations.size).toBeGreaterThan(0);
    expect(decoyListLocations.has(liveListId)).toBe(false);
    expect(coherentStateListIds.size).toBeGreaterThan(0);
    expect([...decoyListLocations.keys()].every(id => coherentStateListIds.has(id))).toBe(true);
    expect([...decoyListLocations].every(([id, targetIndex]) => (
      Array.isArray(requireTarget(transformed, targetIndex).lists[id]?.[1])
    ))).toBe(true);
    const initialLive = structuredClone(liveList);
    const initialDecoys = new Map([...decoyListLocations].map(([id, targetIndex]) => [
      id,
      structuredClone(requireTarget(transformed, targetIndex).lists[id]?.[1])
    ]));

    for (const liveValue of [0, 17, 100]) {
      const project = structuredClone(transformed);
      const vm = createVm();
      try {
        await vm.loadProject(createFixtureArchive(project));
        vm.start();
        vm.greenFlag();
        vm.runtime.emit('ANSWER', String(liveValue));
        vm.postIOData('mouse', {
          x: 240 + liveValue,
          y: 180 - liveValue,
          canvasWidth: 480,
          canvasHeight: 360
        });
        for (let step = 0; step < 10_000 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads, `live value ${liveValue} left decoy threads running`).toHaveLength(0);
        const runtimeSprite = vm.runtime.targets.find(target => !target.isStage);
        const packedValues = runtimeSprite?.variables[liveListId]?.value;
        expect(Array.isArray(packedValues)).toBe(true);
        const expectedLive = structuredClone(initialLive);
        expectedLive[liveSlot - 1] = 12;
        expect(packedValues, `live value ${liveValue} corrupted packed state`).toEqual(expectedLive);
        expect([...decoyListLocations.keys()].some(id => (
          JSON.stringify(vm.runtime.targets.find(target => target.variables[id])?.variables[id]?.value)
            !== JSON.stringify(initialDecoys.get(id))
        )), `live value ${liveValue} did not enter a decoy subsystem`).toBe(true);
      } finally {
        vm.quit();
      }
    }
  }, 60_000);

  it('is deterministic and strictly load-save-reload valid across seeds', async () => {
    for (const seed of [0, 117, 255]) {
      const project = emptyLoadableProject();
      const duplicate = emptyLoadableProject();
      applyAggressiveTransforms(project, 'no-preserve', generator(seed), stats(project));
      applyAggressiveTransforms(duplicate, 'no-preserve', generator(seed), stats(duplicate));
      expect(JSON.stringify(project)).toBe(JSON.stringify(duplicate));
      validateProject(project);

      const vm = createVm();
      let reloaded: ScratchVmInstance | undefined;
      try {
        await vm.loadProject(createFixtureArchive(project));
        vm.start();
        vm.greenFlag();
        for (let step = 0; step < 200 && vm.runtime.threads.length > 0; step += 1) vm.runtime._step();
        expect(vm.runtime.threads).toHaveLength(0);
        const saved = await blobBytes(await vm.saveProjectSb3());
        const savedProjectBytes = unzipSync(saved)['project.json'];
        if (!savedProjectBytes) throw new Error('saved archive is missing project.json');
        const savedProject = JSON.parse(strFromU8(savedProjectBytes)) as ScratchProject;
        validateProject(savedProject);
        expect(unpairedReceiverIds(savedProject)).toEqual([]);
        expect(pairedBroadcastCount(savedProject)).toBeGreaterThanOrEqual(6);
        reloaded = createVm();
        await reloaded.loadProject(saved);
      } finally {
        reloaded?.quit();
        vm.quit();
      }
    }
  }, 60_000);
});

function broadcastReferenceCounts(project: ScratchProject): {
  readonly received: Map<string, number>;
  readonly sent: Map<string, number>;
} {
  const received = new Map<string, number>();
  const sent = new Map<string, number>();
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (!isScratchBlock(block)) continue;
      if (block.opcode === 'event_whenbroadcastreceived') {
        const id = block.fields['BROADCAST_OPTION']?.[1];
        if (typeof id === 'string') received.set(id, (received.get(id) ?? 0) + 1);
      }
      if (block.opcode === 'event_broadcast') {
        const primitive = block.inputs['BROADCAST_INPUT']?.[1];
        const id = Array.isArray(primitive) ? primitive[2] : undefined;
        if (typeof id === 'string') sent.set(id, (sent.get(id) ?? 0) + 1);
      }
    }
  }
  return {received, sent};
}

function countLiveRailEntrySenders(project: ScratchProject, generatedBroadcastIds: ReadonlySet<string>): number {
  const matched = new Set<string>();
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (!isScratchBlock(block) || block.opcode !== 'event_broadcast') continue;
      const primitive = block.inputs['BROADCAST_INPUT']?.[1];
      const broadcastId = Array.isArray(primitive) ? primitive[2] : undefined;
      if (typeof broadcastId !== 'string' || !generatedBroadcastIds.has(broadcastId)) continue;
      let parentId = block.parent;
      let parent = parentId ? target.blocks[parentId] : undefined;
      while (isScratchBlock(parent) && parent.opcode === 'event_broadcast') {
        parentId = parent.parent;
        parent = parentId ? target.blocks[parentId] : undefined;
      }
      if (!parentId || !isScratchBlock(parent) || parent.opcode !== 'control_if') continue;
      const updateId = parent.parent;
      const update = updateId ? target.blocks[updateId] : undefined;
      const equalsId = parent.inputs['CONDITION']?.[1];
      if (
        isScratchBlock(update)
        && update.opcode === 'data_changevariableby'
        && update.next === parentId
        && typeof equalsId === 'string'
        && referencedGraphHasVariable(target, equalsId, update.fields['VARIABLE']?.[1])
      ) matched.add(broadcastId);
    }
  }
  return matched.size;
}

function procedureTopologySignatures(project: ScratchProject): Set<string> {
  const signatures = new Set<string>();
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (!isScratchBlock(block) || block.opcode !== 'procedures_definition' || !block.next) continue;
      const prototypeId = block.inputs['custom_block']?.[1];
      const prototype = typeof prototypeId === 'string' ? target.blocks[prototypeId] : undefined;
      const warp = isScratchBlock(prototype) ? prototype.mutation?.['warp'] : undefined;
      const opcodes: string[] = [];
      const visited = new Set<string>();
      const visit = (id: string): void => {
        if (visited.has(id)) return;
        visited.add(id);
        const value = target.blocks[id];
        if (!isScratchBlock(value)) return;
        opcodes.push(value.opcode);
        if (value.next) visit(value.next);
        for (const inputName of Object.keys(value.inputs).sort()) {
          const input = value.inputs[inputName];
          if (!input) continue;
          for (let index = 1; index < input.length; index += 1) {
            if (typeof input[index] === 'string') visit(input[index] as string);
          }
        }
      };
      visit(block.next);
      const warpSignature = typeof warp === 'string' || typeof warp === 'boolean' ? `${warp}` : 'unknown';
      signatures.add(`${warpSignature}:${opcodes.join('>')}`);
    }
  }
  return signatures;
}

function procedureBodyEquivalentSizes(project: ScratchProject): Set<number> {
  const sizes = new Set<number>();
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (!isScratchBlock(block) || block.opcode !== 'procedures_definition' || !block.next) continue;
      const visited = new Set<string>();
      const visit = (id: string): number => {
        if (visited.has(id)) return 0;
        visited.add(id);
        const value = target.blocks[id];
        if (!isScratchBlock(value)) return 0;
        let size = 1;
        if (value.next) size += visit(value.next);
        for (const input of Object.values(value.inputs)) {
          for (let index = 1; index < input.length; index += 1) {
            const child = input[index];
            if (typeof child === 'string') size += visit(child);
            else if (Array.isArray(child)) size += 1;
          }
        }
        return size;
      };
      sizes.add(visit(block.next));
    }
  }
  return sizes;
}

function generatedRetentionRatio(
  source: ScratchProject,
  transformed: ScratchProject,
  retained: ReadonlySet<string>
): number {
  const originalIds = new Set(source.targets.flatMap(target => Object.keys(target.blocks)));
  const generated = transformed.targets.flatMap(target => Object.entries(target.blocks))
    .filter(([id, value]) => !originalIds.has(id) && isScratchBlock(value))
    .map(([id]) => id);
  const retainedCount = generated.filter(id => retained.has(id)).length;
  return generated.length === 0 ? 0 : retainedCount / generated.length;
}

function pairedBroadcastCount(project: ScratchProject): number {
  const stage = requireTarget(project, 0);
  const {received, sent} = broadcastReferenceCounts(project);
  return Object.keys(stage.broadcasts).filter(id => (
    (received.get(id) ?? 0) > 0 && (sent.get(id) ?? 0) > 0
  )).length;
}

function unpairedReceiverIds(project: ScratchProject): string[] {
  const {received, sent} = broadcastReferenceCounts(project);
  return [...received.keys()].filter(id => (sent.get(id) ?? 0) === 0).sort();
}

function obviousGeneratedRootOpcodes(source: ScratchProject, transformed: ScratchProject): string[] {
  const originalIds = new Set(source.targets.flatMap(target => Object.keys(target.blocks)));
  return transformed.targets.flatMap(target => Object.entries(target.blocks).flatMap(([id, value]) => {
    if (!isScratchBlock(value) || !value.topLevel || originalIds.has(id)) return [];
    if (
      value.opcode === 'procedures_definition'
      || value.opcode === 'event_whenbroadcastreceived'
      || value.opcode === 'event_whenflagclicked'
    ) return [];
    return [value.opcode];
  }));
}

function countOpcode(project: ScratchProject, opcode: string): number {
  return project.targets.reduce((count, target) => count + Object.values(target.blocks)
    .filter(value => isScratchBlock(value) && value.opcode === opcode).length, 0);
}

function auditLiveOpaqueGuards(project: ScratchProject): {
  readonly guards: number;
  readonly strongGuards: number;
  readonly reporterOpcodes: Set<string>;
  readonly conditionOpcodes: Set<string>;
} {
  const sensingOpcodes = new Set(['sensing_answer', 'sensing_mousex', 'sensing_mousey', 'sensing_timer']);
  const supportedConditions = new Set(['operator_contains', 'operator_equals', 'operator_gt', 'operator_lt']);
  const reporterOpcodes = new Set<string>();
  const conditionOpcodes = new Set<string>();
  let guards = 0;
  let strongGuards = 0;
  for (const target of project.targets) {
    for (const guard of Object.values(target.blocks)) {
      if (!isScratchBlock(guard) || guard.opcode !== 'control_if' || !guard.parent) continue;
      const update = target.blocks[guard.parent];
      if (!isScratchBlock(update) || update.opcode !== 'data_changevariableby') continue;
      guards += 1;
      const conditionId = guard.inputs['CONDITION']?.[1];
      if (typeof conditionId !== 'string') continue;
      const condition = target.blocks[conditionId];
      if (!isScratchBlock(condition) || !supportedConditions.has(condition.opcode)) continue;
      const conditionIds = new Set<string>();
      collectReferencedBlockIds(target, conditionId, conditionIds);
      const sensing = [...conditionIds].flatMap(id => {
        const block = target.blocks[id];
        return isScratchBlock(block) && sensingOpcodes.has(block.opcode) ? [block.opcode] : [];
      });
      if (
        sensing.length === 1
        && referencedGraphHasVariable(target, conditionId, update.fields['VARIABLE']?.[1])
      ) {
        strongGuards += 1;
        reporterOpcodes.add(sensing[0] ?? '');
        conditionOpcodes.add(condition.opcode);
      }
    }
  }
  return {guards, strongGuards, reporterOpcodes, conditionOpcodes};
}

function coherentSiteGrowthAudit(
  source: ScratchProject,
  transformed: ScratchProject
): {readonly componentGrowths: number[]; readonly siteGrowths: number[]} {
  const originalIds = new Set(source.targets.flatMap(target => Object.keys(target.blocks)));
  const originalBroadcastIds = new Set(source.targets.flatMap(target => Object.keys(target.broadcasts)));
  const generatedBroadcastIds = new Set(transformed.targets.flatMap(target => Object.keys(target.broadcasts))
    .filter(id => !originalBroadcastIds.has(id)));
  const componentGrowths: number[] = [];
  const siteGrowths: number[] = [];
  const attributedBroadcastIds = new Set<string>();

  for (const target of transformed.targets) {
    const definitions = procedureDefinitions(target);
    const hatsByBroadcast = new Map<string, Array<{readonly id: string; readonly block: ScratchBlock}>>();
    for (const [id, block] of Object.entries(target.blocks)) {
      if (!isScratchBlock(block) || block.opcode !== 'event_whenbroadcastreceived') continue;
      const broadcastId = block.fields['BROADCAST_OPTION']?.[1];
      if (typeof broadcastId !== 'string') continue;
      const hats = hatsByBroadcast.get(broadcastId) ?? [];
      hats.push({id, block});
      hatsByBroadcast.set(broadcastId, hats);
    }

    for (const [guardId, guard] of Object.entries(target.blocks)) {
      if (!isScratchBlock(guard) || guard.opcode !== 'control_if' || originalIds.has(guardId)) continue;
      const updateId = guard.parent;
      const update = updateId ? target.blocks[updateId] : undefined;
      if (!updateId || !isScratchBlock(update) || update.opcode !== 'data_changevariableby') continue;
      const conditionId = guard.inputs['CONDITION']?.[1];
      if (
        typeof conditionId !== 'string'
        || !referencedGraphHasVariable(target, conditionId, update.fields['VARIABLE']?.[1])
      ) continue;

      const driverId = update.parent;
      const driver = driverId ? target.blocks[driverId] : undefined;
      let siteGrowth = blockEquivalentContribution(update)
        + blockEquivalentContribution(guard)
        + referencedGraphEquivalentGrowth(target, conditionId)
        + (isScratchBlock(driver)
        && driver.opcode === 'event_whenflagclicked'
        && !originalIds.has(driverId ?? '')
          ? blockEquivalentContribution(driver)
          : 0);
      const visitedChain = new Set<string>();
      let chainId = guard.inputs['SUBSTACK']?.[1];
      while (typeof chainId === 'string' && !visitedChain.has(chainId)) {
        visitedChain.add(chainId);
        const block = target.blocks[chainId];
        if (!isScratchBlock(block)) break;
        const broadcastPrimitive = block.opcode === 'event_broadcast'
          ? block.inputs['BROADCAST_INPUT']?.[1]
          : undefined;
        const broadcastId = Array.isArray(broadcastPrimitive) ? broadcastPrimitive[2] : undefined;
        if (typeof broadcastId === 'string' && generatedBroadcastIds.has(broadcastId)) {
          const componentGrowth = coherentComponentGrowth(target, chainId, broadcastId, hatsByBroadcast, definitions);
          componentGrowths.push(componentGrowth);
          attributedBroadcastIds.add(broadcastId);
          siteGrowth += componentGrowth;
        } else {
          siteGrowth += blockEquivalentContribution(block);
        }
        chainId = block.next;
      }
      siteGrowths.push(siteGrowth);
    }
  }

  expect([...generatedBroadcastIds].filter(id => !attributedBroadcastIds.has(id))).toEqual([]);
  return {componentGrowths, siteGrowths};
}

function coherentComponentGrowth(
  target: ScratchTarget,
  entrySenderId: string,
  broadcastId: string,
  hatsByBroadcast: ReadonlyMap<string, ReadonlyArray<{readonly id: string; readonly block: ScratchBlock}>>,
  definitions: ReadonlyMap<string, string>
): number {
  const entryHat = hatsByBroadcast.get(broadcastId)?.find(({block}) => {
    const next = block.next ? target.blocks[block.next] : undefined;
    return isScratchBlock(next) && next.opcode === 'procedures_call';
  });
  const entryCall = entryHat?.block.next ? target.blocks[entryHat.block.next] : undefined;
  const proccode = isScratchBlock(entryCall) ? entryCall.mutation?.['proccode'] : undefined;
  const definitionId = typeof proccode === 'string' ? definitions.get(proccode) : undefined;
  if (!entryHat || typeof proccode !== 'string' || !definitionId) {
    throw new Error(`generated broadcast ${broadcastId} has no attributed procedure`);
  }
  const continuationHat = Object.values(target.blocks).find(block => {
    if (!isScratchBlock(block) || block.opcode !== 'event_whenbroadcastreceived' || !block.next) return false;
    const wait = target.blocks[block.next];
    if (!isScratchBlock(wait) || wait.opcode !== 'control_wait' || !wait.next) return false;
    const call = target.blocks[wait.next];
    return isScratchBlock(call) && call.opcode === 'procedures_call' && call.mutation?.['proccode'] === proccode;
  });
  if (!isScratchBlock(continuationHat)) throw new Error(`generated procedure ${proccode} has no continuation hat`);

  const componentIds = new Set<string>([entrySenderId]);
  collectReferencedBlockIds(target, entryHat.id, componentIds);
  collectReferencedBlockIds(target, definitionId, componentIds);
  const continuationHatId = Object.entries(target.blocks).find(([, block]) => block === continuationHat)?.[0];
  if (!continuationHatId) throw new Error(`generated procedure ${proccode} has an unindexed continuation hat`);
  collectReferencedBlockIds(target, continuationHatId, componentIds);
  return [...componentIds].reduce((growth, id) => {
    const block = target.blocks[id];
    return growth + (isScratchBlock(block) ? blockEquivalentContribution(block) : 0);
  }, 0);
}

function procedureDefinitions(target: ScratchTarget): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const [id, block] of Object.entries(target.blocks)) {
    if (!isScratchBlock(block) || block.opcode !== 'procedures_definition') continue;
    const prototypeId = block.inputs['custom_block']?.[1];
    const prototype = typeof prototypeId === 'string' ? target.blocks[prototypeId] : undefined;
    const proccode = isScratchBlock(prototype) ? prototype.mutation?.['proccode'] : undefined;
    if (typeof proccode === 'string') definitions.set(proccode, id);
  }
  return definitions;
}

function collectReferencedBlockIds(target: ScratchTarget, rootId: string, collected: Set<string>): void {
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (!id || collected.has(id)) continue;
    const block = target.blocks[id];
    if (!isScratchBlock(block)) continue;
    collected.add(id);
    if (block.next) queue.push(block.next);
    for (const input of Object.values(block.inputs)) {
      for (let index = 1; index < input.length; index += 1) {
        const child = input[index];
        if (typeof child === 'string') queue.push(child);
      }
    }
  }
}

function referencedGraphHasVariable(target: ScratchTarget, rootId: string, variableId: unknown): boolean {
  if (typeof variableId !== 'string') return false;
  const ids = new Set<string>();
  collectReferencedBlockIds(target, rootId, ids);
  return [...ids].some(id => {
    const block = target.blocks[id];
    return isScratchBlock(block)
      && block.opcode === 'data_variable'
      && block.fields['VARIABLE']?.[1] === variableId;
  });
}

function referencedGraphEquivalentGrowth(target: ScratchTarget, rootId: string): number {
  const ids = new Set<string>();
  collectReferencedBlockIds(target, rootId, ids);
  return [...ids].reduce((growth, id) => {
    const block = target.blocks[id];
    return growth + (isScratchBlock(block) ? blockEquivalentContribution(block) : 0);
  }, 0);
}

function blockEquivalentContribution(block: ScratchBlock): number {
  let growth = 1;
  for (const input of Object.values(block.inputs)) {
    if (Array.isArray(input[1])) growth += 1;
    if (Array.isArray(input[2])) growth += 1;
  }
  return growth;
}

function hasImpossiblePrivateCondition(project: ScratchProject): boolean {
  for (const target of project.targets) {
    for (const block of Object.values(target.blocks)) {
      if (!isScratchBlock(block) || block.opcode !== 'operator_or') continue;
      const firstId = block.inputs['OPERAND1']?.[1];
      const secondId = block.inputs['OPERAND2']?.[1];
      if (typeof firstId !== 'string' || typeof secondId !== 'string') continue;
      const first = target.blocks[firstId];
      const second = target.blocks[secondId];
      if (!isScratchBlock(first) || !isScratchBlock(second)) continue;
      const variableReporterId = first.inputs['OPERAND1']?.[1];
      const listReporterId = second.inputs['OPERAND1']?.[1];
      const expectedVariable = primitiveValue(first.inputs['OPERAND2']?.[1]);
      const expectedList = primitiveValue(second.inputs['OPERAND2']?.[1]);
      const variableReporter = typeof variableReporterId === 'string' ? target.blocks[variableReporterId] : undefined;
      const listReporter = typeof listReporterId === 'string' ? target.blocks[listReporterId] : undefined;
      if (!isScratchBlock(variableReporter) || !isScratchBlock(listReporter)) continue;
      const variableId = variableReporter.fields['VARIABLE']?.[1];
      const listId = listReporter.fields['LIST']?.[1];
      if (typeof variableId !== 'string' || typeof listId !== 'string') continue;
      const variableValue = target.variables[variableId]?.[1];
      const listValue = target.lists[listId]?.[1];
      if (!Array.isArray(listValue)) continue;
      if (variableValue !== expectedVariable && listValue[0] !== expectedList) return true;
    }
  }
  return false;
}

function procedureAwareReachableBlocks(project: ScratchProject): Set<string> {
  const retained = new Set<string>();
  for (const target of project.targets) {
    const roots = Object.entries(target.blocks).filter(([, value]) => (
      isScratchBlock(value)
      && value.topLevel
      && (value.opcode.startsWith('event_when') || value.opcode === 'control_start_as_clone')
    )).map(([id]) => id);
    const definitions = new Map<string, string>();
    for (const [id, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'procedures_definition') continue;
      const prototypeId = value.inputs['custom_block']?.[1];
      const prototype = typeof prototypeId === 'string' ? target.blocks[prototypeId] : undefined;
      const code = isScratchBlock(prototype) ? prototype.mutation?.['proccode'] : undefined;
      if (typeof code === 'string') definitions.set(code, id);
    }
    const queue = [...roots];
    while (queue.length > 0) {
      const id = queue.pop();
      if (!id || retained.has(id)) continue;
      const value = target.blocks[id];
      if (!isScratchBlock(value)) continue;
      retained.add(id);
      if (value.next) queue.push(value.next);
      for (const input of Object.values(value.inputs)) {
        for (let index = 1; index < input.length; index += 1) {
          if (typeof input[index] === 'string') queue.push(input[index] as string);
        }
      }
      if (value.opcode === 'procedures_call') {
        const code = value.mutation?.['proccode'];
        const definitionId = typeof code === 'string' ? definitions.get(code) : undefined;
        if (definitionId) queue.push(definitionId);
      }
    }
  }
  return retained;
}

function primitiveValue(value: unknown): unknown {
  return Array.isArray(value) ? value[1] : undefined;
}

function findRelationalLiveSponsor(target: ScratchTarget): {
  readonly conditionOpcode: 'operator_gt' | 'operator_lt';
  readonly stateVariableId: string;
  readonly substackId: string;
} {
  for (const guard of Object.values(target.blocks)) {
    if (!isScratchBlock(guard) || guard.opcode !== 'control_if' || !guard.parent) continue;
    const update = target.blocks[guard.parent];
    if (!isScratchBlock(update) || update.opcode !== 'data_changevariableby') continue;
    const conditionId = guard.inputs['CONDITION']?.[1];
    if (typeof conditionId !== 'string') continue;
    const condition = target.blocks[conditionId];
    if (!isScratchBlock(condition) || (condition.opcode !== 'operator_gt' && condition.opcode !== 'operator_lt')) {
      continue;
    }
    const substackId = guard.inputs['SUBSTACK']?.[1];
    const substack = typeof substackId === 'string' ? target.blocks[substackId] : undefined;
    if (!isScratchBlock(substack) || substack.opcode !== 'event_broadcast') continue;
    const stateVariableId = update.fields['VARIABLE']?.[1];
    if (
      typeof stateVariableId === 'string'
      && typeof substackId === 'string'
      && referencedGraphHasVariable(target, conditionId, stateVariableId)
    ) return {conditionOpcode: condition.opcode, stateVariableId, substackId};
  }
  throw new Error('no relational live sponsor with a coherent substack was generated');
}

function decoyDependencyClosure(
  project: ScratchProject,
  startTargetIndex: number,
  rootId: string
): Map<number, Set<string>> {
  const receivers = new Map<string, Array<{readonly targetIndex: number; readonly id: string}>>();
  const definitions = project.targets.map(target => procedureDefinitions(target));
  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [id, block] of Object.entries(target.blocks)) {
      if (!isScratchBlock(block) || block.opcode !== 'event_whenbroadcastreceived') continue;
      const broadcastId = block.fields['BROADCAST_OPTION']?.[1];
      if (typeof broadcastId !== 'string') continue;
      const entries = receivers.get(broadcastId) ?? [];
      entries.push({targetIndex, id});
      receivers.set(broadcastId, entries);
    }
  }

  const retained = new Map<number, Set<string>>();
  const visited = new Set<string>();
  const queue: Array<{readonly targetIndex: number; readonly id: string}> = [{targetIndex: startTargetIndex, id: rootId}];
  while (queue.length > 0) {
    const location = queue.pop();
    if (!location) continue;
    const key = `${location.targetIndex}\u0000${location.id}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const target = project.targets[location.targetIndex];
    const block = target?.blocks[location.id];
    if (!target || !isScratchBlock(block)) continue;
    const ids = retained.get(location.targetIndex) ?? new Set<string>();
    ids.add(location.id);
    retained.set(location.targetIndex, ids);
    if (block.next) queue.push({targetIndex: location.targetIndex, id: block.next});
    for (const input of Object.values(block.inputs)) {
      for (let index = 1; index < input.length; index += 1) {
        const child = input[index];
        if (typeof child === 'string') queue.push({targetIndex: location.targetIndex, id: child});
      }
    }
    if (block.opcode === 'procedures_call') {
      const proccode = block.mutation?.['proccode'];
      const definitionId = typeof proccode === 'string' ? definitions[location.targetIndex]?.get(proccode) : undefined;
      if (definitionId) queue.push({targetIndex: location.targetIndex, id: definitionId});
    }
    if (block.opcode === 'event_broadcast') {
      const primitive = block.inputs['BROADCAST_INPUT']?.[1];
      const broadcastId = Array.isArray(primitive) ? primitive[2] : undefined;
      if (typeof broadcastId === 'string') queue.push(...(receivers.get(broadcastId) ?? []));
    }
  }
  return retained;
}

function liveStateIsolationProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireTarget(project, 0);
  const sprite = requireTarget(project, 1);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  sprite.variables = {'live-value': ['live value', 0]};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.comments = {};
  sprite.blocks = {
    hat: {
      opcode: 'event_whenflagclicked',
      next: 'set-live',
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0
    },
    'set-live': {
      opcode: 'data_setvariableto',
      next: 'change-live',
      parent: 'hat',
      inputs: {VALUE: [1, [4, '10']]},
      fields: {VARIABLE: ['live value', 'live-value']},
      shadow: false,
      topLevel: false
    },
    'change-live': {
      opcode: 'data_changevariableby',
      next: 'hide-live',
      parent: 'set-live',
      inputs: {VALUE: [1, [4, '2']]},
      fields: {VARIABLE: ['live value', 'live-value']},
      shadow: false,
      topLevel: false
    },
    'hide-live': {
      opcode: 'looks_hide',
      next: 'show-live',
      parent: 'change-live',
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: false
    },
    'show-live': {
      opcode: 'looks_show',
      next: null,
      parent: 'hide-live',
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: false
    }
  };
  project.monitors = [];
  project.extensions = [];
  validateProject(project);
  return project;
}

function emptyLoadableProject(): ScratchProject {
  const fixture = createFixtureProject();
  const stage = requireTarget(fixture, 0);
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  fixture.targets = [stage];
  fixture.monitors = [];
  return fixture;
}

function stats(project: ScratchProject, mode: Extract<ObfuscationMode, 'lossy' | 'no-preserve'> = 'no-preserve'): ObfuscationStats {
  const count = countObjectBlocks(project);
  return {
    mode,
    blocksBefore: count,
    blocksAfter: count,
    identifiersRenamed: 0,
    symbolsRenamed: 0,
    commentsRemoved: 0,
    decoysAdded: 0,
    virtualizedBlocks: 0,
    warnings: []
  };
}

function largeSafeLossyProject(): ScratchProject {
  const project = emptyLoadableProject();
  const stage = requireTarget(project, 0);
  stage.lists['work-list'] = ['work list', []];
  stage.blocks['hat'] = {
    opcode: 'event_whenflagclicked',
    next: 'append-0',
    parent: null,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: true,
    x: 0,
    y: 0
  };
  for (let index = 0; index < 90; index += 1) {
    stage.blocks[`append-${index}`] = {
      opcode: 'data_addtolist',
      next: index === 89 ? null : `append-${index + 1}`,
      parent: index === 0 ? 'hat' : `append-${index - 1}`,
      inputs: {ITEM: [1, [10, `value-${index}`]]},
      fields: {LIST: ['work list', 'work-list']},
      shadow: false,
      topLevel: false
    };
  }
  return project;
}

function scaledNoPreserveProject(): ScratchProject {
  const project = emptyLoadableProject();
  const stage = requireTarget(project, 0);
  stage.lists['work-list'] = ['work list', ['seed']];
  for (let index = 0; index < 180; index += 1) {
    const variant = index % 3;
    stage.blocks[`work-${index}`] = {
      opcode: variant === 0 ? 'control_wait' : variant === 1 ? 'data_deleteoflist' : 'data_insertatlist',
      next: null,
      parent: null,
      inputs: variant === 0
        ? {DURATION: [1, [4, `${(index % 5) + 1}`]]}
        : variant === 1
          ? {INDEX: [1, [4, `${(index % 4) + 1}`]]}
          : {INDEX: [1, [4, `${(index % 4) + 1}`]], ITEM: [1, [10, `item-${index}`]]},
      fields: variant === 0 ? {} : {LIST: ['work list', 'work-list']},
      shadow: false,
      topLevel: true,
      x: index * 4,
      y: index * 3
    };
  }
  return project;
}

function generator(seed: number): DeterministicGenerator {
  return new DeterministicGenerator(new Uint8Array(32).fill(seed), 'coherent-decoy-test');
}

function requireTarget(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`fixture is missing target ${index}`);
  return target;
}

function createVm(): ScratchVmInstance {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  return vm;
}

async function blobBytes(value: Blob | Uint8Array): Promise<Uint8Array> {
  return value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
}
