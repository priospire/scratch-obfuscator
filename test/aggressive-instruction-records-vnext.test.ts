import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isPrimitive, isScratchBlock} from '../src/model/blocks.js';
import {applyAggressiveTransforms} from '../src/obfuscation/aggressive.js';
import {countBlockEquivalents, countObjectBlocks} from '../src/obfuscation/analysis.js';
import type {
  ObfuscationMode,
  ObfuscationStats,
  ScratchBlock,
  ScratchInput,
  ScratchProject,
  ScratchTarget
} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureArchive, createFixtureProject} from './support.js';

interface RuntimeVariable {
  value: unknown;
}

interface RuntimeTarget {
  isStage: boolean;
  variables: Record<string, RuntimeVariable>;
}

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
    ioDevices: {
      clock: {
        projectTimer(): number;
      };
    };
    sequencer: {
      timer: {
        nowObj: {now(): number};
      };
    };
    _step(): void;
  };
}

type ScratchVmConstructor = new () => ScratchVmInstance;
type StorageConstructor = new () => unknown;

const require = createRequire(import.meta.url);
const vmValue: unknown = require('../node_modules/@scratch/scratch-vm/src/index.js');
const storageValue: unknown = require('@scratch/scratch-storage');
if (typeof vmValue !== 'function') throw new Error('official Scratch VM constructor is unavailable');
if (
  typeof storageValue !== 'object'
  || storageValue === null
  || typeof (storageValue as Record<string, unknown>)['ScratchStorage'] !== 'function'
) throw new Error('official Scratch storage constructor is unavailable');
const ScratchVm = vmValue as ScratchVmConstructor;
const ScratchStorage = (storageValue as Record<string, unknown>)['ScratchStorage'] as StorageConstructor;

describe('result-bound dispatch and dynamic fixed-list packing', () => {
  it('uses one bounded runtime-table cohort for eight commands with allow-size', async () => {
    const source = instructionProject(8);
    const transformed = structuredClone(source);
    const before = countBlockEquivalents(transformed);
    const resultStats = stats(transformed);
    let virtualizationSnapshot: ScratchProject | undefined;
    applyAggressiveTransforms(
      transformed,
      'no-preserve',
      generator(0x71, 'instruction-cohort'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(transformed);
      },
      true
    );

    expect(resultStats.virtualizedBlocks).toBe(8);
    if (!virtualizationSnapshot) throw new Error('virtualization snapshot is unavailable');
    const growth = countBlockEquivalents(virtualizationSnapshot) - before;
    expect(growth).toBe(1691);
    expect(growth).toBeLessThanOrEqual(2048);
    validateProject(transformed);

    const stage = requireTarget(virtualizationSnapshot, 0);
    const tables = expandedRuntimeTables(stage, 8);
    expect(tables.handlerCount).toBe(4);
    verifyExpandedProgramTableShape(tables, 8);
    const listCellCount = Object.values(stage.lists).reduce((total, declaration) => (
      total + (Array.isArray(declaration[1]) ? declaration[1].length : 0)
    ), 0);
    expect(listCellCount).toBe(263);
    expect(JSON.stringify(stage.lists).length).toBeLessThan(32 * 1024);

    const aliasesByCommand: ExpandedCommandAlias[][] = [];
    for (let index = 0; index < 8; index += 1) {
      expect(stage.blocks[`command-${index}`]).toBeUndefined();
      const sourceCommand = requireBlock(requireTarget(source, 0), `command-${index}`);
      const aliases = expandedCommandAliases(stage, sourceCommand);
      expect(aliases).toHaveLength(tables.handlerCount);
      aliasesByCommand.push(aliases);
    }
    verifyUniversalHandlerTopology(stage, aliasesByCommand);

    const driverCallCounts = new Map<string, number>();
    for (const value of Object.values(stage.blocks)) {
      if (!isScratchBlock(value) || value.opcode !== 'procedures_call') continue;
      const code = value.mutation?.['proccode'];
      if (typeof code === 'string') driverCallCounts.set(code, (driverCallCounts.get(code) ?? 0) + 1);
    }
    expect([...driverCallCounts.values()].sort((left, right) => left - right)).toEqual([2, 9]);

    const intact = await runTwice(virtualizationSnapshot, 'result');
    expect(intact.firstValue).toBe('value-7');
    expect(intact.secondValue).toBe('value-7');
    expect(intact.firstSchedulerSteps).toBe(1);
    expect(intact.secondSchedulerSteps).toBe(1);
    expect(intact.secondListLengths).toEqual(intact.firstListLengths);
    expect(intact.firstListValues[tables.powers.id]).toEqual(tables.powers.values);
    expect(intact.secondListValues[tables.powers.id]).toEqual(tables.powers.values);
    expect(intact.firstListLengths).toEqual(Object.fromEntries(
      tables.lists.map(table => [table.id, table.values.length])
    ));

    for (const table of tables.lists) {
      const tampered = structuredClone(virtualizationSnapshot);
      const declaration = requireTarget(tampered, 0).lists[table.id];
      if (!declaration || !Array.isArray(declaration[1])) throw new Error('expanded runtime table is unavailable');
      declaration[1].pop();
      const tripped = await runTwice(tampered, 'result');
      expect(tripped.firstValue).toBe('initial');
      expect(tripped.secondValue).toBe('initial');
      expect(tripped.secondListLengths).toEqual(tripped.firstListLengths);
    }

    for (const wordIndex of [0, 1]) {
      const transitionProgramTampered = structuredClone(virtualizationSnapshot);
      const transitionProgramValues = requireTarget(
        transitionProgramTampered,
        0
      ).lists[tables.powers.id]?.[1];
      if (!Array.isArray(transitionProgramValues) || typeof transitionProgramValues[wordIndex] !== 'number') {
        throw new Error('expanded transition word is unavailable');
      }
      transitionProgramValues[wordIndex] += 1;
      const transitionProgramTrip = await runTwice(transitionProgramTampered, 'result');
      expect(transitionProgramTrip.firstValue).toBe('initial');
      expect(transitionProgramTrip.secondValue).toBe('initial');
    }

    const extraWriterTampered = structuredClone(virtualizationSnapshot);
    const extraWriterStage = requireTarget(extraWriterTampered, 0);
    const hat = requireBlock(extraWriterStage, 'hat');
    const firstEntryId = hat.next;
    const firstRecordWord = tables.powers.values[0];
    if (firstEntryId === null || firstRecordWord === undefined) {
      throw new Error('expanded entry or record word is unavailable');
    }
    hat.next = 'extra-record-writer';
    requireBlock(extraWriterStage, firstEntryId).parent = 'extra-record-writer';
    extraWriterStage.blocks['extra-record-writer'] = block(
      'data_replaceitemoflist',
      firstEntryId,
      'hat',
      false,
      {INDEX: [1, [4, 1]], ITEM: [1, [4, String(firstRecordWord + 1)]]},
      {LIST: [tables.powers.id, tables.powers.id]}
    );
    const extraWriterTrip = await runTwice(extraWriterTampered, 'result');
    expect(extraWriterTrip.firstValue).toBe('initial');
    expect(extraWriterTrip.secondValue).toBe('initial');

    const bridgeTampered = structuredClone(virtualizationSnapshot);
    const bridgeStage = requireTarget(bridgeTampered, 0);
    const tagWrites = listWrites(bridgeStage, tables.program.id).filter(write => (
      numericOperand(write.inputs['INDEX']) === 6
    ));
    expect(tagWrites).toHaveLength(2);
    const transitionTagWrite = tagWrites.find(write => write.parent !== null && (
      requireBlock(bridgeStage, write.parent).opcode === 'data_replaceitemoflist'
    ));
    if (transitionTagWrite === undefined) throw new Error('expanded transition tag write is unavailable');
    transitionTagWrite.inputs['INDEX'] = [1, [4, 5]];
    const bridgeTrip = await runTwice(bridgeTampered, 'result');
    expect(bridgeTrip.firstValue).toBe('value-0');
    expect(bridgeTrip.secondValue).toBe('value-0');
  }, 30_000);

  it('falls back for the whole coupled cohort when argument evaluation is observable', async () => {
    const project = instructionProject(8);
    const source = structuredClone(project);
    const stage = requireTarget(project, 0);
    stage.blocks['command-4'] = block(
      'data_setvariableto',
      'command-5',
      'command-3',
      false,
      {VALUE: [2, 'dynamic-value']},
      {VARIABLE: ['result', 'result']}
    );
    stage.blocks['dynamic-value'] = block(
      'data_variable',
      null,
      'command-4',
      false,
      {},
      {VARIABLE: ['result', 'result']}
    );
    const resultStats = stats(project);
    let virtualizationSnapshot: ScratchProject | undefined;
    applyAggressiveTransforms(
      project,
      'no-preserve',
      generator(0x72, 'instruction-fallback'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
      }
    );
    expect(resultStats.virtualizedBlocks).toBe(0);
    if (!virtualizationSnapshot) throw new Error('observable-argument snapshot is unavailable');
    const snapshotStage = requireTarget(virtualizationSnapshot, 0);
    expect(Object.values(snapshotStage.blocks).some(value => (
      isScratchBlock(value) && value.opcode === 'procedures_call'
    ))).toBe(false);
    expect(Object.keys(snapshotStage.lists)).toHaveLength(0);
    expect((await runTwice(virtualizationSnapshot, 'result')).firstValue)
      .toBe((await runTwice(source, 'result')).firstValue);
  }, 30_000);

  it('is deterministic while diversifying expanded runtime-table programs between seeds', () => {
    const first = instructionProject(8);
    const second = instructionProject(8);
    const different = instructionProject(8);
    applyAggressiveTransforms(first, 'no-preserve', generator(0x31, 'layout'), stats(first), undefined, true);
    applyAggressiveTransforms(second, 'no-preserve', generator(0x31, 'layout'), stats(second), undefined, true);
    applyAggressiveTransforms(different, 'no-preserve', generator(0x32, 'layout'), stats(different), undefined, true);
    expect(second).toEqual(first);
    expect(JSON.stringify(different)).not.toBe(JSON.stringify(first));

    const blockPrograms = new Set<string>();
    const tablePrograms = new Set<string>();
    for (const seed of [0x31, 0x32, 0x33, 0x34]) {
      const candidate = instructionProject(8);
      let virtualizationSnapshot: ScratchProject | undefined;
      applyAggressiveTransforms(
        candidate,
        'no-preserve',
        generator(seed, 'layout-records'),
        stats(candidate),
        event => {
          if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(candidate);
        },
        true
      );
      if (!virtualizationSnapshot) throw new Error('packet layout snapshot is unavailable');
      const stage = requireTarget(virtualizationSnapshot, 0);
      const tables = expandedRuntimeTables(stage, 8);
      expect(tables.handlerCount).toBe(4);
      verifyExpandedProgramTableShape(tables, 8);
      blockPrograms.add(JSON.stringify(stage.blocks));
      tablePrograms.add(JSON.stringify(stage.lists));
    }
    expect(blockPrograms.size).toBe(4);
    expect(tablePrograms.size).toBe(4);
  });

  it('builds and rekeys an authenticated universal program table', async () => {
    const project = instructionProject(8);
    let virtualizationSnapshot: ScratchProject | undefined;
    applyAggressiveTransforms(
      project,
      'no-preserve',
      generator(0x7b, 'state-indexed-codebooks'),
      stats(project),
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
      },
      true
    );
    if (!virtualizationSnapshot) throw new Error('packet virtualization snapshot is unavailable');
    const stage = requireTarget(virtualizationSnapshot, 0);
    const tables = expandedRuntimeTables(stage, 8);
    expect(tables.handlerCount).toBe(4);
    verifyExpandedProgramTableShape(tables, 8);
    verifyExpandedProgramValidationShape(stage, tables);
    const aliasesByCommand: ExpandedCommandAlias[][] = [];
    const sourceStage = requireTarget(instructionProject(8), 0);
    for (let index = 0; index < 8; index += 1) {
      expect(stage.blocks[`command-${index}`]).toBeUndefined();
      const sourceCommand = requireBlock(sourceStage, `command-${index}`);
      const aliases = expandedCommandAliases(stage, sourceCommand);
      expect(aliases).toHaveLength(tables.handlerCount);
      aliasesByCommand.push(aliases);
    }
    verifyUniversalHandlerTopology(stage, aliasesByCommand);
    expect(Object.values(stage.blocks).some(value => (
      isScratchBlock(value)
      && value.opcode === 'control_stop'
      && value.fields['STOP_OPTION']?.[0] === 'this script'
    ))).toBe(true);

    const result = await runTwice(virtualizationSnapshot, 'result');
    expect(result.firstValue).toBe('value-7');
    expect(result.secondValue).toBe('value-7');
    expect(result.secondListLengths).toEqual(result.firstListLengths);
    expect(result.firstListValues[tables.program.id]).not.toEqual(tables.program.values);
    expect(result.firstListValues[tables.powers.id]).toEqual(tables.powers.values);
    expect(result.secondListValues[tables.powers.id]).toEqual(tables.powers.values);
    expect(result.firstListLengths).toEqual(Object.fromEntries(
      tables.lists.map(table => [table.id, table.values.length])
    ));
  });

  it('preserves threaded records and procedure mutations through official save and reload', async () => {
    for (const routeCount of [4, 8] as const) {
      const project = instructionProject(routeCount);
      let virtualizationSnapshot: ScratchProject | undefined;
      const resultStats = stats(project);
      applyAggressiveTransforms(
        project,
        'no-preserve',
        generator(0x58 + routeCount, `threaded-resave-${routeCount}`),
        resultStats,
        event => {
          if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
        },
        true
      );
      expect(resultStats.virtualizedBlocks).toBe(routeCount);
      if (!virtualizationSnapshot) throw new Error('threaded resave snapshot is unavailable');
      const sourceTables = expandedRuntimeTables(requireTarget(virtualizationSnapshot, 0), routeCount);
      const vm = await saveReloadVm(virtualizationSnapshot);
      try {
        const stage = runtimeStage(vm);
        expect(runtimeListValues(stage)[sourceTables.powers.id]).toEqual(sourceTables.powers.values);
        expect(runtimeListValues(stage)[sourceTables.program.id]).toEqual(sourceTables.program.values);
        expect(runFlag(vm)).toBe(1);
        expect(stage.variables['result']?.value).toBe(`value-${routeCount - 1}`);
        expectRuntimeProgramState(runtimeListValues(stage)[sourceTables.program.id]);
        expect(runtimeListValues(stage)[sourceTables.powers.id]).toEqual(sourceTables.powers.values);
      } finally {
        vm.quit();
      }
    }
  }, 60_000);

  it('caches one bounded timer sample after each expanded command', async () => {
    for (const routeCount of [4, 8] as const) {
      const project = instructionProject(routeCount);
      let virtualizationSnapshot: ScratchProject | undefined;
      const resultStats = stats(project);
      applyAggressiveTransforms(
        project,
        'no-preserve',
        generator(0x6d + routeCount, `timer-trace-${routeCount}`),
        resultStats,
        event => {
          if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
        },
        true
      );
      expect(resultStats.virtualizedBlocks).toBe(routeCount);
      if (!virtualizationSnapshot) throw new Error('timer-trace virtualization snapshot is unavailable');
      const stage = requireTarget(virtualizationSnapshot, 0);
      const tables = expandedRuntimeTables(stage, routeCount);
      const trace = routeCount === 4
        ? [-0.0005, 0, 65.5205, 65.5215]
        : [0, 1.0015, 1.0035, 65.5205, 65.5215, -0.0005, 0.25, 0];
      const traced = await runWithTimerTrace(virtualizationSnapshot, 'result', trace);
      expect(traced.value).toBe(`value-${routeCount - 1}`);
      expect(traced.timerCalls).toBe(routeCount);
      expectRuntimeProgramState(traced.listValues[tables.program.id]);
      expect(traced.listValues[tables.powers.id]).toEqual(tables.powers.values);

      const repeated = await runTwiceWithConstantTimer(virtualizationSnapshot, 'result', 1.0015);
      expect(repeated.firstValue).toBe(`value-${routeCount - 1}`);
      expect(repeated.secondValue).toBe(`value-${routeCount - 1}`);
      expect(repeated.timerCalls).toBe(routeCount * 2);
      expect(repeated.secondListValues[tables.program.id]).toEqual(
        repeated.firstListValues[tables.program.id]
      );
      expect(repeated.firstListValues[tables.powers.id]).toEqual(tables.powers.values);
      expect(repeated.secondListValues[tables.powers.id]).toEqual(tables.powers.values);
    }
  }, 30_000);

  it('keeps compact and allow-size four-command packet storage bounded across repeated starts', async () => {
    for (const allowSize of [false, true]) {
      const project = instructionProject(4);
      const before = countBlockEquivalents(project);
      let virtualizationSnapshot: ScratchProject | undefined;
      const resultStats = stats(project);
      applyAggressiveTransforms(
        project,
        'no-preserve',
        generator(0x33, 'four-command-bounds'),
        resultStats,
        event => {
          if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
        },
        allowSize
      );
      expect(resultStats.virtualizedBlocks, resultStats.warnings.join(';')).toBe(4);
      if (!virtualizationSnapshot) throw new Error('four-command virtualization snapshot is unavailable');
      const growth = countBlockEquivalents(virtualizationSnapshot) - before;
      const snapshotStage = requireTarget(virtualizationSnapshot, 0);
      const listIds: string[] = [];
      if (allowSize) {
        expect(growth).toBe(1535);
        expect(growth).toBeLessThanOrEqual(2048);
        const tables = expandedRuntimeTables(snapshotStage, 4);
        expect(tables.handlerCount).toBe(4);
        verifyExpandedProgramTableShape(tables, 4);
        expect(tables.lists.reduce((count, record) => count + record.values.length, 0)).toBe(135);
        expect(JSON.stringify(snapshotStage.lists).length).toBeLessThan(16 * 1024);
        const sourceStage = requireTarget(instructionProject(4), 0);
        const aliasesByCommand = Array.from({length: 4}, (_, index) => (
          expandedCommandAliases(snapshotStage, requireBlock(sourceStage, `command-${index}`))
        ));
        expect(aliasesByCommand.every(aliases => aliases.length === tables.handlerCount)).toBe(true);
        verifyUniversalHandlerTopology(snapshotStage, aliasesByCommand);
        listIds.push(...tables.lists.map(table => table.id));
      } else {
        expect(growth).toBe(252);
        expect(growth).toBeLessThanOrEqual(256);
        const tables = packetTables(snapshotStage, 4);
        expect(tables.lists).toHaveLength(2);
        expect(tables.lists.every(record => record.values.length === 10)).toBe(true);
        expect(tables.lists.reduce((count, record) => count + record.values.length, 0)).toBe(20);
        expect(JSON.stringify(snapshotStage.lists).length).toBeLessThanOrEqual(512 * (4 + 1));
        expect(countPacketRoutes(snapshotStage)).toBe(4);
        verifyPackedWords(tables);
        verifyPacketChecksumShape(snapshotStage, tables);
        verifyDynamicRoutingShape(snapshotStage, tables, 4);
        listIds.push(...tables.lists.map(table => table.id));

        const tamperedProjects = [
          (tampered: ScratchProject): void => {
            corruptPacketWord(requireTarget(tampered, 0), tables.bank0.id);
          },
          (tampered: ScratchProject): void => {
            corruptBalancedPacketWords(requireTarget(tampered, 0), tables, false);
          },
          (tampered: ScratchProject): void => {
            corruptBalancedPacketWords(requireTarget(tampered, 0), tables, true);
          }
        ];
        for (const tamper of tamperedProjects) {
          const tampered = structuredClone(virtualizationSnapshot);
          tamper(tampered);
          const tripped = await runTwice(tampered, 'result');
          expect(tripped.firstValue).toBe('initial');
          expect(tripped.secondValue).toBe('initial');
          expect(tripped.secondListLengths).toEqual(tripped.firstListLengths);
        }
      }
      const result = await runTwice(virtualizationSnapshot, 'result');
      expect(result.firstValue).toBe('value-3');
      expect(result.secondValue).toBe('value-3');
      expect(result.firstSchedulerSteps).toBe(1);
      expect(result.secondSchedulerSteps).toBe(1);
      expect(result.secondListLengths).toEqual(result.firstListLengths);
      if (allowSize) {
        const tables = expandedRuntimeTables(snapshotStage, 4);
        expect(result.firstListValues[tables.powers.id]).toEqual(tables.powers.values);
        expect(result.secondListValues[tables.powers.id]).toEqual(tables.powers.values);
      } else {
        expect(result.secondListValues).toEqual(result.firstListValues);
      }
      for (const listId of listIds) {
        const values = snapshotStage.lists[listId]?.[1];
        if (!Array.isArray(values)) throw new Error('dispatcher list declaration is unavailable');
        const expectedLength = values.length;
        expect(result.firstListLengths[listId]).toBe(expectedLength);
        expect(result.secondListLengths[listId]).toBe(expectedLength);
      }
    }
  }, 30_000);

  it('preserves numeric coercion, signed zero, infinity, numbers, and Boolean-like strings', async () => {
    const source = typedOperandProject();
    const expected = await runVariableValues(source, ['counter', 'text', 'truthish', 'falseish', 'number']);
    const transformed = structuredClone(source);
    let virtualizationSnapshot: ScratchProject | undefined;
    const resultStats = stats(transformed);
    applyAggressiveTransforms(
      transformed,
      'no-preserve',
      generator(0x34, 'typed-operands'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(transformed);
      },
      true
    );
    expect(resultStats.virtualizedBlocks).toBe(8);
    if (!virtualizationSnapshot) throw new Error('typed-operand virtualization snapshot is unavailable');
    const actual = await runVariableValues(
      virtualizationSnapshot,
      ['counter', 'text', 'truthish', 'falseish', 'number']
    );
    expect(actual).toEqual(expected);
    expect(actual).toEqual({counter: 5.5, text: 'text', truthish: 'true', falseish: 'false', number: Infinity});

    const stage = requireTarget(virtualizationSnapshot, 0);
    const sourceStage = requireTarget(source, 0);
    const aliasesByCommand: ExpandedCommandAlias[][] = [];
    for (let index = 0; index < 8; index += 1) {
      expect(stage.blocks[`typed-${index}`]).toBeUndefined();
      const aliases = expandedCommandAliases(stage, requireBlock(sourceStage, `typed-${index}`));
      expect(aliases).toHaveLength(4);
      aliasesByCommand.push(aliases);
      for (const {block: alias} of aliases) {
        const operand = alias.inputs['VALUE']?.[1];
        expect(isPrimitive(operand)).toBe(true);
        if (!isPrimitive(operand)) throw new Error('typed dispatcher operand is unavailable');
        const decoded = index < 4 || index === 7 ? scratchNumber(operand[1]) : operand[1];
        expect(Object.is(decoded, expectedTypedOperand(index))).toBe(true);
      }
    }
    verifyUniversalHandlerTopology(stage, aliasesByCommand);
  }, 30_000);

  it('falls back for a whole cohort containing a Boolean reporter operand', async () => {
    const project = instructionProject(8);
    const stage = requireTarget(project, 0);
    const unsupported = requireBlock(stage, 'command-4');
    unsupported.inputs['VALUE'] = [2, 'boolean-value'];
    stage.blocks['boolean-value'] = block(
      'operator_equals',
      null,
      'command-4',
      false,
      {OPERAND1: [1, [10, 'same']], OPERAND2: [1, [10, 'same']]}
    );
    const resultStats = stats(project);
    let virtualizationSnapshot: ScratchProject | undefined;
    applyAggressiveTransforms(
      project,
      'no-preserve',
      generator(0x35, 'unsupported-operand'),
      resultStats,
      event => {
        if (event.stage === 'virtualizing-control-flow') virtualizationSnapshot = structuredClone(project);
      }
    );
    expect(resultStats.virtualizedBlocks).toBe(0);
    if (!virtualizationSnapshot) throw new Error('unsupported-operand snapshot is unavailable');
    const snapshotStage = requireTarget(virtualizationSnapshot, 0);
    expect(Object.values(snapshotStage.blocks).some(value => (
      isScratchBlock(value) && value.opcode === 'procedures_call'
    ))).toBe(false);
    expect(Object.keys(snapshotStage.lists)).toHaveLength(0);
    expect((await runTwice(virtualizationSnapshot, 'result')).firstValue).toBe('value-7');
  }, 30_000);

  it('preserves dynamic item, replacement, and length semantics through a shuffled logical map', async () => {
    const source = dynamicListProject();
    const baseline = await runOnce(source);
    const transformed = structuredClone(source);
    applyAggressiveTransforms(transformed, 'lossy', generator(0x44, 'dynamic-list'), stats(transformed, 'lossy'));
    validateProject(transformed);

    const stage = requireTarget(transformed, 0);
    expect(stage.lists['source']).toBeUndefined();
    const read = requireBlock(stage, 'read');
    const replace = requireBlock(stage, 'replace');
    const readMapId = mappedListId(stage, read);
    const replaceMapId = mappedListId(stage, replace);
    expect(readMapId).toBe(replaceMapId);
    expect(requireBlock(stage, 'length').fields['LIST']?.[1]).toBe(readMapId);
    const mapValues = stage.lists[readMapId]?.[1];
    expect(Array.isArray(mapValues) ? mapValues.length : -1).toBe(3);

    const actual = await runOnce(transformed);
    expect(actual.stageLists['results']).toEqual(baseline.stageLists['results']);
    expect(actual.stageLists['results']).toEqual(['changed', 3]);
  }, 30_000);

  it('samples a random dynamic list index exactly once', async () => {
    const source = randomListProject();
    const transformed = structuredClone(source);
    applyAggressiveTransforms(transformed, 'lossy', generator(0x45, 'random-list'), stats(transformed, 'lossy'));

    const baseline = await runOnceWithRandom(source, 0.75);
    const actual = await runOnceWithRandom(transformed, 0.75);
    expect(baseline.randomCalls).toBe(1);
    expect(actual.randomCalls).toBe(1);
    expect(actual.stageLists['results']).toEqual(baseline.stageLists['results']);
  }, 30_000);
});

function instructionProject(length: number): ScratchProject {
  const project = createFixtureProject();
  const stage = requireTarget(project, 0);
  project.targets = [stage];
  stage.variables = {result: ['result', 'initial']};
  stage.lists = {};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {hat: block('event_whenflagclicked', length === 0 ? null : 'command-0', null, true)};
  for (let index = 0; index < length; index += 1) {
    stage.blocks[`command-${index}`] = block(
      'data_setvariableto',
      index + 1 < length ? `command-${index + 1}` : null,
      index === 0 ? 'hat' : `command-${index - 1}`,
      false,
      {VALUE: [1, [10, `value-${index}`]]},
      {VARIABLE: ['result', 'result']}
    );
  }
  project.monitors = [];
  project.extensions = [];
  return project;
}

function typedOperandProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireTarget(project, 0);
  project.targets = [stage];
  stage.variables = {
    counter: ['counter', 0],
    text: ['text', ''],
    truthish: ['truthish', ''],
    falseish: ['falseish', ''],
    number: ['number', 0]
  };
  stage.lists = {};
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {hat: block('event_whenflagclicked', 'typed-0', null, true)};
  const values: ScratchInput[] = [
    [1, [4, 2]],
    [1, [4, '-0']],
    [1, [4, '3.5']],
    [1, [4, 'pear']],
    [1, [10, 'text']],
    [1, [10, 'true']],
    [1, [10, 'false']],
    [1, [4, 'Infinity']]
  ];
  const variableIds = ['counter', 'counter', 'counter', 'counter', 'text', 'truthish', 'falseish', 'number'];
  for (let index = 0; index < values.length; index += 1) {
    const variableId = variableIds[index];
    if (variableId === undefined) throw new Error('typed operand fixture variable is unavailable');
    stage.blocks[`typed-${index}`] = block(
      index < 4 || index === 7 ? 'data_changevariableby' : 'data_setvariableto',
      index + 1 < values.length ? `typed-${index + 1}` : null,
      index === 0 ? 'hat' : `typed-${index - 1}`,
      false,
      {VALUE: values[index] ?? []},
      {VARIABLE: [variableId, variableId]}
    );
  }
  project.monitors = [];
  project.extensions = [];
  return project;
}

function expectedTypedOperand(index: number): unknown {
  return [2, -0, 3.5, 0, 'text', 'true', 'false', Infinity][index];
}

function dynamicListProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireTarget(project, 0);
  project.targets = [stage];
  stage.variables = {index: ['index', 2]};
  stage.lists = {
    source: ['source', ['first', 'second', 'third']],
    results: ['results', []]
  };
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    hat: block('event_whenflagclicked', 'replace', null, true),
    replace: block(
      'data_replaceitemoflist',
      'record',
      'hat',
      false,
      {INDEX: [3, [12, 'index', 'index'], [4, '1']], ITEM: [1, [10, 'changed']]},
      {LIST: ['source', 'source']}
    ),
    record: block(
      'data_addtolist',
      'record-length',
      'replace',
      false,
      {ITEM: [2, 'read']},
      {LIST: ['results', 'results']}
    ),
    read: block(
      'data_itemoflist',
      null,
      'record',
      false,
      {INDEX: [3, [12, 'index', 'index'], [4, '1']]},
      {LIST: ['source', 'source']}
    ),
    'record-length': block(
      'data_addtolist',
      null,
      'record',
      false,
      {ITEM: [2, 'length']},
      {LIST: ['results', 'results']}
    ),
    length: block('data_lengthoflist', null, 'record-length', false, {}, {LIST: ['source', 'source']})
  };
  project.monitors = [variableMonitor('index', 'index')];
  project.extensions = [];
  return project;
}

function randomListProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = requireTarget(project, 0);
  project.targets = [stage];
  stage.variables = {};
  stage.lists = {
    source: ['source', ['one', 'two', 'three', 'four']],
    results: ['results', []]
  };
  stage.broadcasts = {};
  stage.comments = {};
  stage.blocks = {
    hat: block('event_whenflagclicked', 'record', null, true),
    record: block(
      'data_addtolist',
      null,
      'hat',
      false,
      {ITEM: [2, 'read']},
      {LIST: ['results', 'results']}
    ),
    read: block(
      'data_itemoflist',
      null,
      'record',
      false,
      {INDEX: [1, [10, 'random']]},
      {LIST: ['source', 'source']}
    )
  };
  project.monitors = [];
  project.extensions = [];
  return project;
}

function mappedListId(target: ScratchTarget, blockValue: ScratchBlock): string {
  const reporterId = blockValue.inputs['INDEX']?.[1];
  if (typeof reporterId !== 'string') throw new Error('logical map reporter is unavailable');
  const reporter = requireBlock(target, reporterId);
  const listId = reporter.fields['LIST']?.[1];
  if (typeof listId !== 'string') throw new Error('logical map list is unavailable');
  return listId;
}

function scratchNumber(value: unknown): number {
  const converted = Number(value);
  return Number.isNaN(converted) ? 0 : converted;
}

interface PacketListRecord {
  readonly id: string;
  readonly values: readonly number[];
}

interface ExpandedRuntimeTableRecords {
  readonly handlerCount: number;
  readonly program: PacketListRecord;
  readonly powers: PacketListRecord;
  readonly lists: readonly [PacketListRecord, PacketListRecord];
}

interface ExpandedCommandAlias {
  readonly id: string;
  readonly block: ScratchBlock;
}

interface PacketTableRecords {
  readonly modulus: number;
  readonly lists: readonly PacketListRecord[];
  readonly bank0: PacketListRecord;
  readonly bank1: PacketListRecord;
  readonly powers: {
    readonly currentRho: number;
    readonly shares: readonly [number, number];
    readonly routeCipher: number;
    readonly digitOrder: readonly [number, number, number, number];
  };
  readonly packetWordVariableId: string;
  readonly rhoVariableId: string;
  readonly checksumExpressionId: string;
}

interface PackedDigitReference {
  readonly list: PacketListRecord;
  readonly power: number;
}

interface MultiplicativeDecode {
  readonly modulus: number;
  readonly left: PackedDigitReference;
  readonly right: PackedDigitReference;
}

const PACKET_PRIMES = [251, 257, 263, 269] as const;
const PACKET_CHECKSUM_MODULUS = 2_147_483_647;
const PACKET_CHECKSUM_STATE_MODULUS = 1_000_003;
const PACKET_CHECKSUM_BANK_MODULUS = 1_000_033;
const PACKET_CHECKSUM_BANK_OFFSET = 65_537;

function countPacketRoutes(target: ScratchTarget): number {
  return Object.values(target.blocks).filter(value => {
    if (!isScratchBlock(value) || value.opcode !== 'control_if') return false;
    const conditionId = value.inputs['CONDITION']?.[1];
    const condition = typeof conditionId === 'string' ? target.blocks[conditionId] : undefined;
    if (!isScratchBlock(condition) || condition.opcode !== 'operator_equals') return false;
    const identityId = condition.inputs['OPERAND2']?.[1];
    return typeof identityId === 'string' && parseRouteIdentity(target, identityId) !== undefined;
  }).length;
}

function expandedRuntimeTables(
  target: ScratchTarget,
  routeCount: 4 | 8
): ExpandedRuntimeTableRecords {
  const lists = Object.entries(target.lists).flatMap(([id, declaration]) => {
    const values = declaration[1];
    if (
      !Array.isArray(values)
      || !values.every((value): value is number => (
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ))
    ) return [];
    return [{id, values}];
  });
  if (lists.length !== 2) throw new Error('the expanded dispatcher state/program lists are unavailable');
  const program = lists.find(record => record.values.length === 7);
  if (program === undefined) throw new Error('expanded dispatcher state dimensions are malformed');
  const handlerLiterals = new Map<string, Set<number>>();
  for (const value of Object.values(target.blocks)) {
    if (!isScratchBlock(value) || value.opcode !== 'operator_equals') continue;
    for (const [variableInput, literalInput] of [
      [value.inputs['OPERAND1'], value.inputs['OPERAND2']],
      [value.inputs['OPERAND2'], value.inputs['OPERAND1']]
    ] as const) {
      const variableId = primitiveVariableId(variableInput?.[1]);
      const literal = numericOperand(literalInput);
      if (variableId === undefined || literal === undefined || !Number.isInteger(literal)) continue;
      const values = handlerLiterals.get(variableId) ?? new Set<number>();
      values.add(literal);
      handlerLiterals.set(variableId, values);
    }
  }
  const handlerCount = 4;
  if (![...handlerLiterals.values()].some(values => (
    [0, 1, 2, 3].every(value => values.has(value)) && !values.has(4)
  ))) throw new Error('expanded handler domain is unavailable');
  const powers = lists.find(record => (
    record.id !== program.id && record.values.length === routeCount * handlerCount * handlerCount * 2
  ));
  if (powers === undefined) throw new Error('expanded central transition program is unavailable');
  return {
    handlerCount,
    program,
    powers,
    lists: [program, powers]
  };
}

function listWrites(target: ScratchTarget, listId: string): ScratchBlock[] {
  return Object.values(target.blocks).filter(value => (
    isScratchBlock(value)
    && value.opcode === 'data_replaceitemoflist'
    && value.fields['LIST']?.[1] === listId
  )) as ScratchBlock[];
}

function verifyExpandedProgramTableShape(
  tables: ExpandedRuntimeTableRecords,
  routeCount: 4 | 8
): void {
  expect(tables.lists).toHaveLength(2);
  expect(tables.program.values).toHaveLength(7);
  expect(tables.powers.values).toHaveLength(routeCount * tables.handlerCount * tables.handlerCount * 2);
  expect(tables.program.values).toEqual([0, 0, 0, 0, 0, 0, 0]);
  expect(tables.powers.values.every(value => (
    Number.isSafeInteger(value) && value >= 0 && value < 67_108_859 ** 2
  ))).toBe(true);
  expect(tables.handlerCount).toBe(4);
}

function verifyExpandedProgramValidationShape(
  target: ScratchTarget,
  tables: ExpandedRuntimeTableRecords
): void {
  const programWrites = listWrites(target, tables.program.id);
  expect(programWrites).toHaveLength(14);
  expect(listWrites(target, tables.powers.id)).toHaveLength(0);
  expect(new Set(programWrites.map(write => numericOperand(write.inputs['INDEX'])))).toEqual(
    new Set([1, 2, 3, 4, 5, 6, 7])
  );

  for (const table of tables.lists) {
    expect(Object.values(target.blocks).some(value => (
      isScratchBlock(value)
      && value.opcode === 'data_itemoflist'
      && value.fields['LIST']?.[1] === table.id
    ))).toBe(true);
    expect(Object.values(target.blocks).some(value => (
      isScratchBlock(value)
      && value.opcode === 'data_lengthoflist'
      && value.fields['LIST']?.[1] === table.id
    ))).toBe(true);
  }
  expect(Object.values(target.blocks).filter(value => (
    isScratchBlock(value) && value.opcode === 'sensing_timer'
  ))).toHaveLength(1);
  expect(Object.values(target.blocks).filter(value => (
    isScratchBlock(value)
    && value.opcode === 'control_repeat'
    && numericOperand(value.inputs['TIMES']) === tables.powers.values.length
  ))).toHaveLength(1);
  expect(Object.values(target.blocks).filter(value => (
    isScratchBlock(value)
    && value.opcode === 'control_repeat'
    && numericOperand(value.inputs['TIMES']) === tables.powers.values.length / 2
  ))).toHaveLength(1);
  expect(Object.values(target.blocks).filter(value => (
    isScratchBlock(value)
    && value.opcode === 'control_repeat'
    && numericOperand(value.inputs['TIMES']) === 8
  ))).toHaveLength(1);
  expect(Object.values(target.blocks).filter(value => (
    isScratchBlock(value)
    && value.opcode === 'operator_divide'
    && numericOperand(value.inputs['NUM2']) === 67_108_859
  ))).toHaveLength(3);
  expect(Object.values(target.blocks).some(value => (
    isScratchBlock(value)
    && value.opcode === 'operator_mod'
    && numericOperand(value.inputs['NUM2']) === 67_108_859
  ))).toBe(true);
}

function expandedCommandAliases(
  target: ScratchTarget,
  source: ScratchBlock
): ExpandedCommandAlias[] {
  const expectedInputs = JSON.stringify(source.inputs);
  const expectedFields = JSON.stringify(source.fields);
  return Object.entries(target.blocks).flatMap(([id, value]) => (
    isScratchBlock(value)
    && value.opcode === source.opcode
    && JSON.stringify(value.inputs) === expectedInputs
    && JSON.stringify(value.fields) === expectedFields
      ? [{id, block: value}]
      : []
  ));
}

function verifyUniversalHandlerTopology(
  target: ScratchTarget,
  aliasesByCommand: readonly (readonly ExpandedCommandAlias[])[]
): void {
  const commandCount = aliasesByCommand.length;
  expect([4, 8]).toContain(commandCount);
  const handlerCount = aliasesByCommand[0]?.length;
  if (handlerCount === undefined) throw new Error('expanded handler count is unavailable');
  expect(handlerCount).toBe(4);
  const aliasOwners = new Map<string, {commandIndex: number; alias: ExpandedCommandAlias}>();
  const suffixBlockIds = new Set<string>();
  for (const [commandIndex, aliases] of aliasesByCommand.entries()) {
    expect(aliases).toHaveLength(handlerCount);
    for (const alias of aliases) {
      expect(aliasOwners.has(alias.id)).toBe(false);
      aliasOwners.set(alias.id, {commandIndex, alias});
      const witnessId = alias.block.next;
      if (witnessId === null) throw new Error('expanded inline witness is unavailable');
      const witness = requireBlock(target, witnessId);
      expect(witness.opcode).toBe('data_setvariableto');
      expect(witness.parent).toBe(alias.id);
      const armedId = witness.next;
      if (armedId === null) throw new Error('expanded inline armed commit is unavailable');
      const armed = requireBlock(target, armedId);
      expect(armed.opcode).toBe('data_setvariableto');
      expect(armed.parent).toBe(witnessId);
      expect(armed.next).toBeNull();
      expect(suffixBlockIds.has(witnessId)).toBe(false);
      expect(suffixBlockIds.has(armedId)).toBe(false);
      suffixBlockIds.add(witnessId);
      suffixBlockIds.add(armedId);
    }
  }
  expect(suffixBlockIds.size).toBe(commandCount * handlerCount * 2);
  expect([...aliasOwners.values()].some(({alias}) => {
    const next = alias.block.next === null ? undefined : target.blocks[alias.block.next];
    return isScratchBlock(next) && next.opcode === 'procedures_call';
  })).toBe(false);

  const claimedAliases = new Set<string>();
  const universalHandlers = Object.entries(target.blocks).flatMap(([outerId, value]) => {
    if (!isScratchBlock(value) || value.opcode !== 'control_if') return [];
    const firstInnerId = value.inputs['SUBSTACK']?.[1];
    if (typeof firstInnerId !== 'string') return [];
    const firstInner = target.blocks[firstInnerId];
    if (!isScratchBlock(firstInner) || firstInner.opcode !== 'control_if') return [];
    const firstAliasId = firstInner.inputs['SUBSTACK']?.[1];
    if (typeof firstAliasId !== 'string' || !aliasOwners.has(firstAliasId)) return [];

    const owned: {commandIndex: number}[] = [];
    let innerId: string | null = firstInnerId;
    let expectedParent = outerId;
    const visited = new Set<string>();
    while (innerId !== null) {
      if (visited.has(innerId)) throw new Error('expanded handler branch cycle is present');
      visited.add(innerId);
      const inner = requireBlock(target, innerId);
      if (inner.opcode !== 'control_if') throw new Error('expanded handler branch is malformed');
      expect(inner.parent).toBe(expectedParent);
      const aliasId = inner.inputs['SUBSTACK']?.[1];
      if (typeof aliasId !== 'string') throw new Error('expanded handler command is unavailable');
      const owner = aliasOwners.get(aliasId);
      if (owner === undefined) throw new Error('expanded handler owns an unexpected command');
      expect(owner.alias.block.parent).toBe(innerId);
      expect(claimedAliases.has(aliasId)).toBe(false);
      claimedAliases.add(aliasId);
      const innerConditionId = inner.inputs['CONDITION']?.[1];
      if (typeof innerConditionId !== 'string') {
        throw new Error('expanded handler command condition is unavailable');
      }
      const innerCondition = requireBlock(target, innerConditionId);
      expect([
        numericOperand(innerCondition.inputs['OPERAND1']),
        numericOperand(innerCondition.inputs['OPERAND2'])
      ].filter((value): value is number => value !== undefined)).toHaveLength(1);
      owned.push({commandIndex: owner.commandIndex});
      expectedParent = innerId;
      innerId = inner.next;
    }
    const conditionId = value.inputs['CONDITION']?.[1];
    if (typeof conditionId !== 'string') throw new Error('expanded handler condition is unavailable');
    const condition = requireBlock(target, conditionId);
    expect(condition.opcode).toBe('operator_equals');
    const operands = [condition.inputs['OPERAND1'], condition.inputs['OPERAND2']];
    const comparedVariableId = operands.map(input => primitiveVariableId(input?.[1]))
      .find((value): value is string => value !== undefined);
    const handlerIndex = operands.map(input => numericOperand(input))
      .find((value): value is number => value !== undefined);
    if (comparedVariableId === undefined || handlerIndex === undefined) {
      throw new Error('expanded handler comparison is not a transient handler selector');
    }
    return [{
      id: outerId,
      block: value,
      comparedVariableId,
      handlerIndex,
      owned
    }];
  });

  expect(universalHandlers).toHaveLength(handlerCount);
  expect(claimedAliases.size).toBe(commandCount * handlerCount);
  const handlerById = new Map(universalHandlers.map(handler => [handler.id, handler]));
  const firstHandlers = universalHandlers.filter(handler => {
    return handler.block.parent === null || !handlerById.has(handler.block.parent);
  });
  expect(firstHandlers).toHaveLength(1);
  const firstHandler = firstHandlers[0];
  if (firstHandler === undefined) throw new Error('expanded first universal handler is unavailable');
  const orderedHandlers = [firstHandler];
  while (orderedHandlers.length < handlerCount) {
    const current = orderedHandlers[orderedHandlers.length - 1];
    if (current === undefined || current.block.next === null) {
      throw new Error('expanded universal handler scan ended early');
    }
    const nextHandler = handlerById.get(current.block.next);
    if (nextHandler === undefined) throw new Error('expanded universal handler scan is malformed');
    expect(nextHandler.block.parent).toBe(current.id);
    expect(orderedHandlers.some(handler => handler.id === nextHandler.id)).toBe(false);
    orderedHandlers.push(nextHandler);
  }
  expect(new Set(orderedHandlers.map(handler => handler.id)).size).toBe(handlerCount);
  expect(new Set(orderedHandlers.map(handler => handler.handlerIndex))).toEqual(
    new Set(Array.from({length: handlerCount}, (_, index) => index))
  );
  expect(new Set(orderedHandlers.map(handler => handler.comparedVariableId)).size).toBe(1);
  for (const handler of orderedHandlers) {
    expect(handler.owned).toHaveLength(commandCount);
    expect(handler.owned.map(owned => owned.commandIndex).sort((left, right) => left - right))
      .toEqual(Array.from({length: commandCount}, (_, index) => index));
  }
}

function packetTables(target: ScratchTarget, routeCount: 4 | 8): PacketTableRecords {
  const listLength = 2 * (routeCount + 1);
  const lists = Object.entries(target.lists).flatMap(([id, declaration]) => {
    const values = declaration[1];
    if (
      !Array.isArray(values)
      || values.length !== listLength
      || !values.every(value => Number.isSafeInteger(Number(value)) && Number(value) >= 0)
    ) return [];
    return [{id, values: values.map(Number)}];
  });
  if (lists.length !== 2) throw new Error('two dispatcher packet lists are unavailable');
  const listById = new Map(lists.map(list => [list.id, list]));
  const tableIds = new Set(listById.keys());
  const checksumSetter = findChecksumSetter(target, tableIds);
  const checksumExpressionId = checksumSetter.inputs['VALUE']?.[1];
  if (typeof checksumExpressionId !== 'string') throw new Error('dispatcher checksum expression is unavailable');

  const rhoReferences = PACKET_PRIMES.flatMap(modulus => (
    Object.values(target.blocks).flatMap(value => {
      if (!isScratchBlock(value) || value.opcode !== 'operator_equals') return [];
      for (const [decodedInput, variableInput] of [
        [value.inputs['OPERAND1'], value.inputs['OPERAND2']],
        [value.inputs['OPERAND2'], value.inputs['OPERAND1']]
      ] as const) {
        const decoded = parsePackedDigitReference(target, decodedInput?.[1], modulus, listById);
        const variableId = primitiveVariableId(variableInput?.[1]);
        if (decoded !== undefined && variableId !== undefined) return [{modulus, decoded, variableId}];
      }
      return [];
    })
  ));
  if (rhoReferences.length !== 1) throw new Error('dispatcher current-state decoder is unavailable');
  const rhoReference = rhoReferences[0];
  if (rhoReference === undefined) throw new Error('dispatcher current-state decoder is unavailable');
  const modulus = rhoReference.modulus;
  const bank0 = rhoReference.decoded.list;
  const bank1 = lists.find(list => list.id !== bank0.id);
  if (bank1 === undefined) throw new Error('dispatcher alternate packet bank is unavailable');

  const cachedListsByVariable = new Map<string, Map<string, PacketListRecord>>();
  for (const value of Object.values(target.blocks)) {
    if (!isScratchBlock(value) || value.opcode !== 'data_setvariableto') continue;
    const variableId = value.fields['VARIABLE']?.[1];
    const cachedList = parsePacketListItem(target, value.inputs['VALUE']?.[1], listById);
    if (typeof variableId !== 'string' || cachedList === undefined) continue;
    const byList = cachedListsByVariable.get(variableId) ?? new Map<string, PacketListRecord>();
    byList.set(cachedList.id, cachedList);
    cachedListsByVariable.set(variableId, byList);
  }
  const packetCacheEntries = [...cachedListsByVariable.entries()].filter(([, byList]) => (
    byList.size === lists.length && lists.every(list => byList.has(list.id))
  ));
  if (packetCacheEntries.length !== 1) throw new Error('dispatcher packet snapshot is unavailable');
  const packetWordVariableId = packetCacheEntries[0]?.[0];
  if (packetWordVariableId === undefined) throw new Error('dispatcher packet snapshot is malformed');
  const packetAliases = new Map([[packetWordVariableId, bank0]]);

  const decodes = Object.values(target.blocks).flatMap(value => {
    if (!isScratchBlock(value) || value.opcode !== 'data_setvariableto') return [];
    const expressionId = value.inputs['VALUE']?.[1];
    if (typeof expressionId !== 'string' || expressionId === checksumExpressionId) return [];
    const decoded = parseMultiplicativeDecode(target, expressionId, listById, packetAliases);
    return decoded === undefined ? [] : [decoded];
  });
  const rhoDecodes = decodes.filter(decode => decode.left.list.id === decode.right.list.id);
  const rhoDecode = rhoDecodes[0];
  if (!rhoDecode || rhoDecodes.length !== 1) throw new Error('dispatcher rho decoder is unavailable');
  if (rhoDecode.modulus !== modulus) throw new Error('dispatcher decoders disagree on their modulus');
  if (!PACKET_PRIMES.includes(modulus)) {
    throw new Error('dispatcher packet modulus is unavailable');
  }
  if (lists.some(list => list.values.some(value => value >= modulus ** 4))) {
    throw new Error('dispatcher packed word exceeds its field');
  }

  if (rhoDecode.left.list.id !== bank0.id || rhoDecode.right.list.id !== bank0.id) {
    throw new Error('dispatcher selected-word decoder uses an unexpected layout');
  }
  const digitOrder = [
    rhoReference.decoded.power,
    rhoDecode.left.power,
    rhoDecode.right.power,
    ...[0, 1, 2, 3].filter(power => (
      power !== rhoReference.decoded.power
      && power !== rhoDecode.left.power
      && power !== rhoDecode.right.power
    ))
  ];
  if (digitOrder.length !== 4 || new Set(digitOrder).size !== 4) {
    throw new Error('dispatcher packed digit layout is incomplete');
  }
  const routeCipherPower = digitOrder[3];
  if (routeCipherPower === undefined) throw new Error('dispatcher route-cipher digit is unavailable');
  return {
    modulus,
    lists,
    bank0,
    bank1,
    powers: {
      currentRho: rhoReference.decoded.power,
      shares: [rhoDecode.left.power, rhoDecode.right.power],
      routeCipher: routeCipherPower,
      digitOrder: digitOrder as [number, number, number, number]
    },
    packetWordVariableId,
    rhoVariableId: rhoReference.variableId,
    checksumExpressionId
  };
}

function findChecksumSetter(target: ScratchTarget, tableIds: ReadonlySet<string>): ScratchBlock {
  const checksumSetter = Object.values(target.blocks).find(value => {
    if (!isScratchBlock(value) || value.opcode !== 'data_setvariableto') return false;
    const expressionId = value.inputs['VALUE']?.[1];
    if (typeof expressionId !== 'string') return false;
    const referencedLists = collectExpressionListIds(target, expressionId);
    return referencedLists.size === tableIds.size
      && [...tableIds].every(id => referencedLists.has(id))
      && collectExpressionNumbers(target, expressionId).includes(PACKET_CHECKSUM_MODULUS);
  });
  if (!isScratchBlock(checksumSetter)) throw new Error('dispatcher checksum setter is unavailable');
  return checksumSetter;
}

function parseMultiplicativeDecode(
  target: ScratchTarget,
  rootId: string,
  lists: ReadonlyMap<string, PacketListRecord>,
  aliases: ReadonlyMap<string, PacketListRecord> = new Map()
): MultiplicativeDecode | undefined {
  const root = target.blocks[rootId];
  if (!isScratchBlock(root) || root.opcode !== 'operator_mod') return undefined;
  const modulus = numericOperand(root.inputs['NUM2']);
  if (modulus === undefined) return undefined;
  const multiplyId = root.inputs['NUM1']?.[1];
  const multiply = typeof multiplyId === 'string' ? target.blocks[multiplyId] : undefined;
  if (!isScratchBlock(multiply) || multiply.opcode !== 'operator_multiply') return undefined;
  const left = parsePackedDigitReference(target, multiply.inputs['NUM1']?.[1], modulus, lists, aliases);
  const right = parsePackedDigitReference(target, multiply.inputs['NUM2']?.[1], modulus, lists, aliases);
  return left === undefined || right === undefined ? undefined : {modulus, left, right};
}

function parsePackedDigitReference(
  target: ScratchTarget,
  rootValue: unknown,
  modulus: number,
  lists: ReadonlyMap<string, PacketListRecord>,
  aliases: ReadonlyMap<string, PacketListRecord> = new Map()
): PackedDigitReference | undefined {
  if (typeof rootValue !== 'string') return undefined;
  const root = target.blocks[rootValue];
  if (!isScratchBlock(root)) return undefined;
  if (root.opcode === 'operator_mod' && numericOperand(root.inputs['NUM2']) === modulus) {
    const numerator = root.inputs['NUM1']?.[1];
    const direct = parsePacketListItem(target, numerator, lists, aliases);
    if (direct !== undefined) return {list: direct, power: 0};
    return parsePackedFloor(target, numerator, modulus, lists, [1, 2], aliases);
  }
  return parsePackedFloor(target, rootValue, modulus, lists, [3], aliases);
}

function parsePackedFloor(
  target: ScratchTarget,
  rootValue: unknown,
  modulus: number,
  lists: ReadonlyMap<string, PacketListRecord>,
  allowedPowers: readonly number[],
  aliases: ReadonlyMap<string, PacketListRecord> = new Map()
): PackedDigitReference | undefined {
  if (typeof rootValue !== 'string') return undefined;
  const floor = target.blocks[rootValue];
  if (
    !isScratchBlock(floor)
    || floor.opcode !== 'operator_mathop'
    || floor.fields['OPERATOR']?.[0] !== 'floor'
  ) return undefined;
  const divideId = floor.inputs['NUM']?.[1];
  const divide = typeof divideId === 'string' ? target.blocks[divideId] : undefined;
  if (!isScratchBlock(divide) || divide.opcode !== 'operator_divide') return undefined;
  const denominator = numericOperand(divide.inputs['NUM2']);
  const power = allowedPowers.find(candidate => denominator === modulus ** candidate);
  if (power === undefined) return undefined;
  const list = parsePacketListItem(target, divide.inputs['NUM1']?.[1], lists, aliases);
  return list === undefined ? undefined : {list, power};
}

function parsePacketListItem(
  target: ScratchTarget,
  rootValue: unknown,
  lists: ReadonlyMap<string, PacketListRecord>,
  aliases: ReadonlyMap<string, PacketListRecord> = new Map()
): PacketListRecord | undefined {
  if (isPrimitive(rootValue) && rootValue[0] === 12 && typeof rootValue[2] === 'string') {
    return aliases.get(rootValue[2]);
  }
  if (typeof rootValue !== 'string') return undefined;
  const item = target.blocks[rootValue];
  if (!isScratchBlock(item) || item.opcode !== 'data_itemoflist') return undefined;
  const listId = item.fields['LIST']?.[1];
  return typeof listId === 'string' ? lists.get(listId) : undefined;
}

function numericOperand(input: ScratchInput | undefined): number | undefined {
  const value = input?.[1];
  return isPrimitive(value) && value[0] === 4 ? Number(value[1]) : undefined;
}

function packetDigit(word: number, power: number, modulus: number): number {
  return Math.floor(word / (modulus ** power)) % modulus;
}

function verifyPackedWords(tables: PacketTableRecords): void {
  for (const list of tables.lists) {
    for (const word of list.values) {
      expect(Number.isSafeInteger(word)).toBe(true);
      expect(word).toBeGreaterThanOrEqual(0);
      expect(word).toBeLessThan(tables.modulus ** 4);
      const digits = Array.from({length: 4}, (_, power) => (
        Math.floor(word / (tables.modulus ** power)) % tables.modulus
      ));
      expect(digits.every(digit => Number.isInteger(digit) && digit >= 0 && digit < tables.modulus)).toBe(true);
      expect(digits.reduce((packed, digit, power) => (
        packed + (digit * (tables.modulus ** power))
      ), 0)).toBe(word);
    }
  }
}

function verifyPacketChecksumShape(target: ScratchTarget, tables: PacketTableRecords): void {
  const tableIds = new Set(tables.lists.map(list => list.id));
  const checksumSetter = findChecksumSetter(target, tableIds);
  const checksumVariableId = checksumSetter.fields['VARIABLE']?.[1];
  if (typeof checksumVariableId !== 'string') throw new Error('dispatcher checksum variable is unavailable');
  const expressionId = checksumSetter.inputs['VALUE']?.[1];
  if (typeof expressionId !== 'string') throw new Error('dispatcher checksum expression is unavailable');
  expect(expressionId).toBe(tables.checksumExpressionId);
  expect(collectExpressionNumbers(target, expressionId)).toContain(PACKET_CHECKSUM_MODULUS);

  const repeat = checksumSetter.parent === null ? undefined : target.blocks[checksumSetter.parent];
  expect(isScratchBlock(repeat) && repeat.opcode === 'control_repeat').toBe(true);
  const repeatCount = isScratchBlock(repeat) ? repeat.inputs['TIMES']?.[1] : undefined;
  const repeatLength = typeof repeatCount === 'string' ? target.blocks[repeatCount] : undefined;
  expect(isScratchBlock(repeatLength) ? repeatLength.opcode : undefined).toBe('data_lengthoflist');
  expect(isScratchBlock(repeatLength) ? repeatLength.fields['LIST']?.[1] : undefined).toBe(tables.bank0.id);
  expect(tables.bank0.values).toHaveLength(tables.bank1.values.length);

  const expectedChecksums = Object.values(target.blocks).flatMap(value => {
    if (!isScratchBlock(value) || value.opcode !== 'operator_equals') return [];
    const operands = Object.values(value.inputs).map(input => input[1]);
    const hasChecksum = operands.some(operand => (
      isPrimitive(operand) && operand[0] === 12 && operand[2] === checksumVariableId
    ));
    return hasChecksum
      ? operands.flatMap(operand => isPrimitive(operand) && operand[0] === 4 ? [Number(operand[1])] : [])
      : [];
  });
  expect(expectedChecksums).not.toHaveLength(0);

  const checksum = packetChecksum(tables.bank0.values, tables.bank1.values);
  expect(expectedChecksums).toContain(checksum);
  const checksumNumbers = collectExpressionNumbers(target, expressionId);
  expect(checksumNumbers).toContain(PACKET_CHECKSUM_STATE_MODULUS);
  expect(checksumNumbers).toContain(PACKET_CHECKSUM_BANK_MODULUS);
  expect(checksumNumbers).toContain(PACKET_CHECKSUM_BANK_OFFSET);

  const sameRowBank0 = [...tables.bank0.values];
  const sameRowBank1 = [...tables.bank1.values];
  const row = sameRowBank0.findIndex((word, index) => (
    word + tables.modulus < tables.modulus ** 4
    && (sameRowBank1[index] ?? 0) >= 17 * tables.modulus
  ));
  expect(row).toBeGreaterThanOrEqual(0);
  if (row >= 0) {
    sameRowBank0[row] = (sameRowBank0[row] ?? 0) + tables.modulus;
    sameRowBank1[row] = (sameRowBank1[row] ?? 0) - (17 * tables.modulus);
    expect(packetChecksum(sameRowBank0, sameRowBank1)).not.toBe(checksum);
  }

  const crossRowBank0 = [...tables.bank0.values];
  const addRow = crossRowBank0.findIndex(word => word + tables.modulus < tables.modulus ** 4);
  const subtractRow = crossRowBank0.findIndex((word, index) => index !== addRow && word >= tables.modulus);
  expect(addRow).toBeGreaterThanOrEqual(0);
  expect(subtractRow).toBeGreaterThanOrEqual(0);
  if (addRow >= 0 && subtractRow >= 0) {
    crossRowBank0[addRow] = (crossRowBank0[addRow] ?? 0) + tables.modulus;
    crossRowBank0[subtractRow] = (crossRowBank0[subtractRow] ?? 0) - tables.modulus;
    expect(packetChecksum(crossRowBank0, tables.bank1.values)).not.toBe(checksum);
  }
}

function packetChecksum(bank0: readonly number[], bank1: readonly number[]): number {
  if (bank0.length !== bank1.length) throw new Error('dispatcher checksum banks differ in length');
  let checksum = 0;
  for (let index = 0; index < bank0.length; index += 1) {
    const word0 = bank0[index] ?? 0;
    const word1 = bank1[index] ?? 0;
    checksum = (
      (((checksum % PACKET_CHECKSUM_STATE_MODULUS) + word0)
        * ((word1 % PACKET_CHECKSUM_BANK_MODULUS) + PACKET_CHECKSUM_BANK_OFFSET))
      + word1
    ) % PACKET_CHECKSUM_MODULUS;
  }
  return checksum;
}

function verifyDynamicRoutingShape(
  target: ScratchTarget,
  tables: PacketTableRecords,
  routeCount: 4 | 8
): 0 | 1 {
  const routes = Object.values(target.blocks).flatMap(value => {
    if (!isScratchBlock(value) || value.opcode !== 'control_if') return [];
    const conditionId = value.inputs['CONDITION']?.[1];
    const condition = typeof conditionId === 'string' ? target.blocks[conditionId] : undefined;
    if (
      !isScratchBlock(condition)
      || condition.opcode !== 'operator_equals'
    ) return [];
    const left = condition.inputs['OPERAND1']?.[1];
    const rightId = condition.inputs['OPERAND2']?.[1];
    if (
      !isPrimitive(left)
      || left[0] !== 12
      || typeof left[2] !== 'string'
      || typeof rightId !== 'string'
    ) return [];
    const identity = parseRouteIdentity(target, rightId);
    if (!identity) return [];
    expect(collectExpressionListIds(target, rightId).size).toBe(0);
    return [{yId: left[2], ...identity}];
  });
  expect(routes).toHaveLength(routeCount);
  const first = routes[0];
  if (!first) throw new Error('dispatcher route is unavailable');
  expect(new Set(routes.map(route => route.yId))).toEqual(new Set([first.yId]));
  expect(new Set(routes.map(route => route.keyId))).toEqual(new Set([first.keyId]));
  expect(new Set(routes.map(route => route.witnessId))).toEqual(new Set([first.witnessId]));
  expect(new Set(routes.map(route => route.secret)).size).toBe(routeCount);
  expect(routes.every(route => route.secret >= 3 && route.secret < tables.modulus)).toBe(true);

  const keyTransition = Object.values(target.blocks).find(value => {
    if (!isScratchBlock(value) || value.opcode !== 'data_setvariableto') return false;
    const variables = collectSetterExpressionVariableIds(target, value);
    return variables.has(tables.packetWordVariableId)
      && variables.size >= 4
      && expressionHasOpcode(target, value, 'operator_add')
      && expressionHasOpcode(target, value, 'operator_multiply')
      && expressionHasOpcode(target, value, 'operator_mod')
      && !expressionHasOpcode(target, value, 'operator_subtract');
  });
  expect(isScratchBlock(keyTransition)).toBe(true);

  const dynamicY = settersForVariable(target, first.yId).find(setter => {
    const variables = collectSetterExpressionVariableIds(target, setter);
    return variables.has(tables.packetWordVariableId)
      && variables.has(first.keyId)
      && variables.has(first.witnessId)
      && variables.has(tables.rhoVariableId)
      && variables.size >= 7
      && expressionHasOpcode(target, setter, 'operator_subtract')
      && expressionHasOpcode(target, setter, 'operator_multiply')
      && expressionHasOpcode(target, setter, 'operator_mod');
  });
  expect(isScratchBlock(dynamicY)).toBe(true);

  const rhoCommit = settersForVariable(target, tables.rhoVariableId).find(setter => {
    const value = setter.inputs['VALUE']?.[1];
    return isPrimitive(value) && value[0] === 12 && typeof value[2] === 'string';
  });
  expect(isScratchBlock(rhoCommit)).toBe(true);

  const multiplicativeDecodes = Object.values(target.blocks).flatMap(value => {
    if (!isScratchBlock(value) || value.opcode !== 'data_setvariableto') return [];
    const expressionId = value.inputs['VALUE']?.[1];
    if (typeof expressionId !== 'string') return [];
    const decoded = parseMultiplicativeDecode(
      target,
      expressionId,
      new Map(tables.lists.map(list => [list.id, list])),
      new Map([[tables.packetWordVariableId, tables.bank0]])
    );
    return decoded === undefined ? [] : [decoded];
  });
  expect(multiplicativeDecodes).toHaveLength(1);
  expect(multiplicativeDecodes[0]?.left.list.id).toBe(tables.bank0.id);
  expect(multiplicativeDecodes[0]?.right.list.id).toBe(tables.bank0.id);

  const routeSecretSet = new Set(collectRouteIdentities(target).map(identity => identity.secret));
  expect(routeSecretSet.size).toBe(routeCount + 1);
  const currentRhos = tables.bank0.values.map(word => (
    packetDigit(word, tables.powers.currentRho, tables.modulus)
  ));
  expect(new Set(currentRhos).size).toBe(2 * (routeCount + 1));
  expect(tables.bank1.values.map(word => (
    packetDigit(word, tables.powers.currentRho, tables.modulus)
  ))).toEqual(currentRhos);

  const decodedBanks = [tables.bank0, tables.bank1].map(bank => bank.values.map(word => ({
    nextRho: packetModulus(
      packetDigit(word, tables.powers.shares[0], tables.modulus)
      * packetDigit(word, tables.powers.shares[1], tables.modulus),
      tables.modulus
    ),
    cipher: packetDigit(word, tables.powers.routeCipher, tables.modulus)
  })));
  const currentRhoSet = new Set(currentRhos);
  expect(decodedBanks.flat().every(record => currentRhoSet.has(record.nextRho))).toBe(true);
  for (let row = 0; row < currentRhos.length; row += 1) {
    const firstBank = decodedBanks[0]?.[row];
    const secondBank = decodedBanks[1]?.[row];
    expect(firstBank?.nextRho).not.toBe(secondBank?.nextRho);
  }

  const routeLatchSetters = Object.values(target.blocks).flatMap(value => {
    if (!isScratchBlock(value) || value.opcode !== 'data_setvariableto' || value.next !== null) return [];
    const input = value.inputs['VALUE']?.[1];
    return isPrimitive(input) && input[0] === 12 && input[2] === first.yId ? [value] : [];
  });
  expect(routeLatchSetters).toHaveLength(routeCount);
  expect(routeLatchSetters.every(setter => setter.fields['VARIABLE']?.[1] !== first.yId)).toBe(true);

  const initialKey = Number(target.variables[first.keyId]?.[1]);
  const initialWitness = Number(target.variables[first.witnessId]?.[1]);
  const initialY = Number(target.variables[first.yId]?.[1]);
  const initialRho = Number(target.variables[tables.rhoVariableId]?.[1]);
  expect([initialKey, initialWitness, initialY, initialRho].every(Number.isSafeInteger)).toBe(true);
  const entrySecret = initialY - (initialKey * initialWitness);
  expect(routeSecretSet.has(entrySecret)).toBe(true);
  expect(currentRhoSet.has(initialRho)).toBe(true);

  const validTemplates = ([0, 1] as const).flatMap(template => {
    let frontier = new Set([initialRho]);
    let secret = entrySecret;
    const recovered = [secret];
    for (let step = 0; step < routeCount; step += 1) {
      const nextRecords = [...frontier].flatMap(rho => {
        const row = currentRhos.indexOf(rho);
        if (row < 0) return [];
        return decodedBanks.map(bank => bank[row]).filter((value): value is {nextRho: number; cipher: number} => (
          value !== undefined
        )).map(record => ({
          nextRho: record.nextRho,
          nextSecret: packetModulus(
            record.cipher - packetRouteMask(template, secret, rho, record.nextRho, step + 1, tables.modulus),
            tables.modulus
          )
        }));
      });
      const nextSecrets = new Set(nextRecords.map(record => record.nextSecret));
      if (nextSecrets.size !== 1) return [];
      const nextSecret = nextRecords[0]?.nextSecret;
      if (nextSecret === undefined || !routeSecretSet.has(nextSecret)) return [];
      secret = nextSecret;
      recovered.push(secret);
      frontier = new Set(nextRecords.map(record => record.nextRho));
    }
    return [{template, recovered}];
  });
  expect(validTemplates).toHaveLength(1);
  expect(new Set(validTemplates[0]?.recovered).size).toBe(routeCount + 1);
  const template = validTemplates[0]?.template;
  if (template === undefined) throw new Error('dispatcher route-mask template is unavailable');
  return template;
}

interface RouteIdentityRecord {
  readonly root: string;
  readonly keyId: string;
  readonly witnessId: string;
  readonly secret: number;
}

function collectRouteIdentities(target: ScratchTarget): RouteIdentityRecord[] {
  return Object.values(target.blocks).flatMap(value => {
    if (!isScratchBlock(value) || value.opcode !== 'operator_equals') return [];
    return Object.values(value.inputs).flatMap(input => {
      const rootId = input[1];
      if (typeof rootId !== 'string') return [];
      const identity = parseRouteIdentity(target, rootId);
      return identity === undefined ? [] : [identity];
    });
  });
}

function parseRouteIdentity(
  target: ScratchTarget,
  rootId: string
): RouteIdentityRecord | undefined {
  const root = target.blocks[rootId];
  if (!isScratchBlock(root) || root.opcode !== 'operator_add') return undefined;
  for (const [multiplyInput, secretInput] of [
    [root.inputs['NUM1'], root.inputs['NUM2']],
    [root.inputs['NUM2'], root.inputs['NUM1']]
  ] as const) {
    const multiplyId = multiplyInput?.[1];
    const multiply = typeof multiplyId === 'string' ? target.blocks[multiplyId] : undefined;
    const secret = numericOperand(secretInput);
    if (!isScratchBlock(multiply) || multiply.opcode !== 'operator_multiply' || secret === undefined) continue;
    const keyId = primitiveVariableId(multiply.inputs['NUM1']?.[1]);
    const witnessId = primitiveVariableId(multiply.inputs['NUM2']?.[1]);
    if (keyId !== undefined && witnessId !== undefined) return {root: rootId, keyId, witnessId, secret};
  }
  return undefined;
}

function primitiveVariableId(value: unknown): string | undefined {
  return isPrimitive(value) && value[0] === 12 && typeof value[2] === 'string'
    ? value[2]
    : undefined;
}

function packetModulus(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function packetRouteMask(
  template: 0 | 1,
  secret: number,
  currentRho: number,
  nextRho: number,
  nextStep: number,
  modulus: number
): number {
  const first = template === 0 ? secret + nextRho : secret + currentRho;
  const second = template === 0 ? currentRho + nextStep : nextRho + nextStep;
  return packetModulus((first * second) * secret, modulus);
}

function settersForVariable(target: ScratchTarget, variableId: string): ScratchBlock[] {
  return Object.values(target.blocks).filter(value => (
    isScratchBlock(value)
    && value.opcode === 'data_setvariableto'
    && value.fields['VARIABLE']?.[1] === variableId
  )) as ScratchBlock[];
}

function collectSetterExpressionVariableIds(target: ScratchTarget, setter: ScratchBlock): Set<string> {
  const expressionId = setter.inputs['VALUE']?.[1];
  if (typeof expressionId !== 'string') return new Set();
  const ids = new Set<string>();
  walkExpression(target, expressionId, blockValue => {
    for (const input of Object.values(blockValue.inputs)) {
      for (const operand of input.slice(1)) {
        if (isPrimitive(operand) && operand[0] === 12 && typeof operand[2] === 'string') {
          ids.add(operand[2]);
        }
      }
    }
  });
  return ids;
}

function expressionHasOpcode(target: ScratchTarget, setter: ScratchBlock, opcode: string): boolean {
  const expressionId = setter.inputs['VALUE']?.[1];
  if (typeof expressionId !== 'string') return false;
  let found = false;
  walkExpression(target, expressionId, blockValue => {
    if (blockValue.opcode === opcode) found = true;
  });
  return found;
}

function collectExpressionListIds(target: ScratchTarget, rootId: string): Set<string> {
  const ids = new Set<string>();
  walkExpression(target, rootId, blockValue => {
    if (blockValue.opcode !== 'data_itemoflist') return;
    const listId = blockValue.fields['LIST']?.[1];
    if (typeof listId === 'string') ids.add(listId);
  });
  return ids;
}

function collectExpressionNumbers(target: ScratchTarget, rootId: string): number[] {
  const numbers: number[] = [];
  walkExpression(target, rootId, blockValue => {
    for (const input of Object.values(blockValue.inputs)) {
      for (const operand of input.slice(1)) {
        if (isPrimitive(operand) && operand[0] === 4) numbers.push(Number(operand[1]));
      }
    }
  });
  return numbers;
}

function walkExpression(
  target: ScratchTarget,
  rootId: string,
  visit: (blockValue: ScratchBlock) => void
): void {
  const pending = [rootId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const value = target.blocks[id];
    if (!isScratchBlock(value)) continue;
    visit(value);
    for (const input of Object.values(value.inputs)) {
      for (const operand of input.slice(1)) {
        if (typeof operand === 'string') pending.push(operand);
      }
    }
  }
}

function corruptPacketWord(target: ScratchTarget, listId: string): void {
  const values = target.lists[listId]?.[1];
  if (!Array.isArray(values) || typeof values[0] !== 'number') {
    throw new Error('dispatcher packet list is unavailable');
  }
  values[0] += 1;
}

function corruptBalancedPacketWords(
  target: ScratchTarget,
  tables: PacketTableRecords,
  crossRow: boolean
): void {
  const bank0 = target.lists[tables.bank0.id]?.[1];
  const bank1 = target.lists[tables.bank1.id]?.[1];
  if (!Array.isArray(bank0) || !Array.isArray(bank1)) {
    throw new Error('dispatcher packet lists are unavailable');
  }
  const addRow = bank0.findIndex(value => (
    typeof value === 'number' && value + tables.modulus < tables.modulus ** 4
  ));
  const subtractRow = bank1.findIndex((value, index) => (
    typeof value === 'number'
    && value >= 17 * tables.modulus
    && (!crossRow || index !== addRow)
  ));
  if (addRow < 0 || subtractRow < 0) throw new Error('balanced packet mutation is unavailable');
  const first = bank0[addRow];
  const second = bank1[subtractRow];
  if (typeof first !== 'number' || typeof second !== 'number') {
    throw new Error('balanced packet words are malformed');
  }
  bank0[addRow] = first + tables.modulus;
  bank1[subtractRow] = second - (17 * tables.modulus);
}

async function runTwice(
  project: ScratchProject,
  variableId: string
): Promise<{
  readonly firstValue: unknown;
  readonly secondValue: unknown;
  readonly firstListLengths: Record<string, number>;
  readonly secondListLengths: Record<string, number>;
  readonly firstListValues: Record<string, unknown[]>;
  readonly secondListValues: Record<string, unknown[]>;
  readonly firstSchedulerSteps: number;
  readonly secondSchedulerSteps: number;
}> {
  const vm = await loadVm(project);
  try {
    const firstSchedulerSteps = runFlag(vm);
    const stage = runtimeStage(vm);
    const firstValue = stage.variables[variableId]?.value;
    const firstListLengths = runtimeListLengths(stage);
    const firstListValues = runtimeListValues(stage);
    const secondSchedulerSteps = runFlag(vm);
    return {
      firstValue,
      secondValue: stage.variables[variableId]?.value,
      firstListLengths,
      secondListLengths: runtimeListLengths(stage),
      firstListValues,
      secondListValues: runtimeListValues(stage),
      firstSchedulerSteps,
      secondSchedulerSteps
    };
  } finally {
    vm.quit();
  }
}

function expectRuntimeProgramState(value: unknown): void {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) throw new Error('expanded runtime state is unavailable');
  expect(value).toHaveLength(7);
  expect(value.every(cell => typeof cell === 'number' && Number.isSafeInteger(cell))).toBe(true);
  const [handler, slot, label, continuation, salt, tag, nonce] = value as number[];
  expect(handler).toBeGreaterThanOrEqual(0);
  expect(handler).toBeLessThan(4);
  expect(slot).toBeGreaterThanOrEqual(0);
  expect(slot).toBeLessThan(67_108_859);
  for (const cell of [label, continuation, salt, tag]) {
    expect(cell).toBeGreaterThanOrEqual(0);
    expect(cell).toBeLessThan(67_108_859);
  }
  expect(nonce).toBeGreaterThanOrEqual(0);
  expect(nonce).toBeLessThan(67_108_859);
}

async function runWithTimerTrace(
  project: ScratchProject,
  variableId: string,
  trace: readonly number[]
): Promise<{
  readonly value: unknown;
  readonly timerCalls: number;
  readonly listValues: Record<string, unknown[]>;
}> {
  const vm = await loadVm(project);
  const clock = vm.runtime.ioDevices.clock;
  const originalTimer = clock.projectTimer.bind(clock);
  let timerCalls = 0;
  clock.projectTimer = () => {
    const value = trace[Math.min(timerCalls, trace.length - 1)] ?? 0;
    timerCalls += 1;
    return value;
  };
  try {
    runFlag(vm);
    const stage = runtimeStage(vm);
    return {
      value: stage.variables[variableId]?.value,
      timerCalls,
      listValues: runtimeListValues(stage)
    };
  } finally {
    clock.projectTimer = originalTimer;
    vm.quit();
  }
}

async function runTwiceWithConstantTimer(
  project: ScratchProject,
  variableId: string,
  timerValue: number
): Promise<{
  readonly firstValue: unknown;
  readonly secondValue: unknown;
  readonly timerCalls: number;
  readonly firstListValues: Record<string, unknown[]>;
  readonly secondListValues: Record<string, unknown[]>;
}> {
  const vm = await loadVm(project);
  const clock = vm.runtime.ioDevices.clock;
  const originalTimer = clock.projectTimer.bind(clock);
  let timerCalls = 0;
  clock.projectTimer = () => {
    timerCalls += 1;
    return timerValue;
  };
  try {
    runFlag(vm);
    const stage = runtimeStage(vm);
    const firstValue = stage.variables[variableId]?.value;
    const firstListValues = runtimeListValues(stage);
    runFlag(vm);
    return {
      firstValue,
      secondValue: stage.variables[variableId]?.value,
      timerCalls,
      firstListValues,
      secondListValues: runtimeListValues(stage)
    };
  } finally {
    clock.projectTimer = originalTimer;
    vm.quit();
  }
}

async function runOnce(project: ScratchProject): Promise<{readonly stageLists: Record<string, unknown>}> {
  const vm = await loadVm(project);
  try {
    runFlag(vm);
    const stage = runtimeStage(vm);
    return {stageLists: Object.fromEntries(Object.entries(stage.variables).map(([id, value]) => [id, value.value]))};
  } finally {
    vm.quit();
  }
}

async function runVariableValues(
  project: ScratchProject,
  ids: readonly string[]
): Promise<Record<string, unknown>> {
  const vm = await loadVm(project);
  try {
    runFlag(vm);
    const stage = runtimeStage(vm);
    return Object.fromEntries(ids.map(id => [id, stage.variables[id]?.value]));
  } finally {
    vm.quit();
  }
}

async function runOnceWithRandom(
  project: ScratchProject,
  sample: number
): Promise<{readonly stageLists: Record<string, unknown>; readonly randomCalls: number}> {
  const vm = await loadVm(project);
  const originalRandom = Math.random;
  let randomCalls = 0;
  Math.random = () => {
    randomCalls += 1;
    return sample;
  };
  try {
    runFlag(vm);
    const stage = runtimeStage(vm);
    return {
      stageLists: Object.fromEntries(Object.entries(stage.variables).map(([id, value]) => [id, value.value])),
      randomCalls
    };
  } finally {
    Math.random = originalRandom;
    vm.quit();
  }
}

async function loadVm(project: ScratchProject): Promise<ScratchVmInstance> {
  const vm = new ScratchVm();
  vm.attachStorage(new ScratchStorage());
  await vm.loadProject(createFixtureArchive(project));
  vm.start();
  return vm;
}

async function saveReloadVm(project: ScratchProject): Promise<ScratchVmInstance> {
  const first = await loadVm(project);
  let saved: Uint8Array;
  try {
    const value = await first.saveProjectSb3();
    saved = value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
  } finally {
    first.quit();
  }
  const reloaded = new ScratchVm();
  reloaded.attachStorage(new ScratchStorage());
  await reloaded.loadProject(saved);
  reloaded.start();
  return reloaded;
}

function runFlag(vm: ScratchVmInstance): number {
  const budgetTimer = vm.runtime.sequencer.timer;
  const originalNow = budgetTimer.nowObj;
  budgetTimer.nowObj = {now: () => 0};
  try {
    vm.greenFlag();
    let schedulerSteps = 0;
    for (; schedulerSteps < 1_000 && vm.runtime.threads.length > 0; schedulerSteps += 1) vm.runtime._step();
    expect(vm.runtime.threads).toHaveLength(0);
    return schedulerSteps;
  } finally {
    budgetTimer.nowObj = originalNow;
  }
}

function runtimeStage(vm: ScratchVmInstance): RuntimeTarget {
  const stage = vm.runtime.targets.find(target => target.isStage);
  if (!stage) throw new Error('runtime Stage is unavailable');
  return stage;
}

function runtimeListLengths(target: RuntimeTarget): Record<string, number> {
  return Object.fromEntries(Object.entries(target.variables).flatMap(([id, variable]) => (
    Array.isArray(variable.value) ? [[id, variable.value.length]] : []
  )));
}

function runtimeListValues(target: RuntimeTarget): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(target.variables).flatMap(([id, variable]) => {
    if (!Array.isArray(variable.value)) return [];
    const values = variable.value as unknown[];
    return [[id, values.slice()]];
  }));
}

function variableMonitor(id: string, name: string): ScratchProject['monitors'][number] {
  return {
    id,
    mode: 'default',
    opcode: 'data_variable',
    params: {VARIABLE: name},
    spriteName: null,
    value: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible: false,
    sliderMin: 0,
    sliderMax: 100,
    isDiscrete: true
  };
}

function block(
  opcode: string,
  next: string | null,
  parent: string | null,
  topLevel: boolean,
  inputs: ScratchBlock['inputs'] = {},
  fields: ScratchBlock['fields'] = {}
): ScratchBlock {
  return {
    opcode,
    next,
    parent,
    inputs,
    fields,
    shadow: false,
    topLevel,
    ...(topLevel ? {x: 10, y: 10} : {})
  };
}

function generator(byte: number, domain: string): DeterministicGenerator {
  return new DeterministicGenerator(new Uint8Array(32).fill(byte), domain);
}

function stats(project: ScratchProject, mode: ObfuscationMode = 'no-preserve'): ObfuscationStats {
  const blocks = countObjectBlocks(project);
  return {
    mode,
    blocksBefore: blocks,
    blocksAfter: blocks,
    identifiersRenamed: 0,
    symbolsRenamed: 0,
    commentsRemoved: 0,
    decoysAdded: 0,
    virtualizedBlocks: 0,
    warnings: []
  };
}

function requireTarget(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`fixture target ${index} is unavailable`);
  return target;
}

function requireBlock(target: ScratchTarget, id: string): ScratchBlock {
  const value = target.blocks[id];
  if (!isScratchBlock(value)) throw new Error(`fixture block ${id} is unavailable`);
  return value;
}
