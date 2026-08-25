import {describe, expect, it} from 'vitest';
import {DeterministicGenerator} from '../src/deterministic.js';
import {isScratchBlock, stageOf} from '../src/model/blocks.js';
import {collectVariableCandidates, type VariableCandidate} from '../src/obfuscation/analysis.js';
import {
  ANTI_CHEAT_DECOY_COUNT,
  applyAntiCheatTransform,
  applyGameplayStateProtection,
  releaseGameplayStateCandidates,
  reserveGameplayStateCandidates,
  selectReservedGameplayStateCandidates
} from '../src/obfuscation/anticheat.js';
import type {JsonValue, ScratchBlock, ScratchProject, ScratchTarget} from '../src/types.js';
import {validateProject} from '../src/validation/project.js';
import {createFixtureProject} from './support.js';

describe('anti-tamper eligibility and edge coverage', () => {
  it('prioritizes frequently used gameplay state without mutating monitor state', () => {
    const project = emptyProject();
    const stage = stageOf(project);
    const permanentMonitor = variableMonitor('permanent', 'permanent');
    stage.variables['permanent'] = ['permanent', 0];
    project.monitors.push(permanentMonitor);

    for (let index = 0; index < 17; index += 1) {
      const id = `value-${index}`;
      const name = `value ${index}`;
      const hatId = `hat-${index}`;
      const writeId = `write-${index}`;
      stage.variables[id] = [name, index];
      stage.blocks[hatId] = block('event_whenflagclicked', writeId, null, true);
      stage.blocks[writeId] = block(
        'data_setvariableto',
        null,
        hatId,
        false,
        {VALUE: index === 16 ? [1, [12, name, id]] : [1, [4, index]]},
        {VARIABLE: [name, id]}
      );
    }
    validateProject(project);

    const candidates = collectVariableCandidates(project);
    const mostUsed = candidates.find(candidate => candidate.id === 'value-16');
    expect(mostUsed?.usages).toHaveLength(2);
    const reservation = reserveGameplayStateCandidates(project, candidates, generator('reservation-cap'));

    expect(reservation.candidateKeys).toHaveLength(16);
    expect(reservation.candidateKeys.has('0\u0000value-16')).toBe(true);
    expect(reservation.markerMonitors).toHaveLength(0);
    expect(project.monitors).toHaveLength(1);
    expect(project.monitors[0]).toBe(permanentMonitor);

    releaseGameplayStateCandidates(project, reservation);
    expect(project.monitors).toEqual([permanentMonitor]);
    expect(selectReservedGameplayStateCandidates(candidates, reservation)).toHaveLength(16);
    releaseGameplayStateCandidates(project, reservation);
    expect(project.monitors).toEqual([permanentMonitor]);
  });

  it('falls back for malformed ownership graphs and every unsafe scalar ownership boundary', () => {
    const rejected: Array<readonly [string, ScratchProject, VariableCandidate]> = [];

    {
      const {project, candidate} = singleCandidateProject();
      rejected.push(['missing declaration target', project, {...candidate, targetIndex: 99}]);
    }
    {
      const {project, candidate, target} = singleCandidateProject();
      delete target.variables[candidate.id];
      rejected.push(['missing declaration', project, candidate]);
    }
    {
      const {project, candidate} = singleCandidateProject();
      rejected.push(['declaration-name mismatch', project, {...candidate, name: 'renamed elsewhere'}]);
    }
    {
      const {project, candidate} = singleCandidateProject();
      rejected.push(['non-finite scalar', project, {...candidate, initialValue: Number.POSITIVE_INFINITY}]);
    }
    {
      const {project, candidate} = singleCandidateProject();
      rejected.push(['unused scalar', project, {...candidate, usages: []}]);
    }
    {
      const {project, candidate} = singleCandidateProject();
      rejected.push([
        'missing usage block',
        project,
        {...candidate, usages: [{kind: 'field', targetIndex: 0, blockId: 'missing'}]}
      ]);
    }
    {
      const {project, candidate, target} = singleCandidateProject();
      const writer = requireBlock(target, 'write');
      writer.parent = 'missing-parent';
      rejected.push(['missing statement parent', project, candidate]);
    }
    {
      const {project, candidate, target} = singleCandidateProject();
      const hat = requireBlock(target, 'hat');
      hat.topLevel = false;
      rejected.push(['non-top-level root', project, candidate]);
    }
    {
      const {project, candidate, target} = singleCandidateProject();
      const hat = requireBlock(target, 'hat');
      const writer = requireBlock(target, 'write');
      hat.topLevel = false;
      hat.parent = 'write';
      writer.parent = 'hat';
      rejected.push(['cyclic parent graph', project, candidate]);
    }
    {
      const {project, candidate, target} = singleCandidateProject();
      requireBlock(target, 'hat').opcode = 'procedures_definition';
      rejected.push(['procedure-owned state', project, candidate]);
    }
    {
      const {project, candidate, target} = singleCandidateProject();
      requireBlock(target, 'hat').opcode = 'event_whenbroadcastreceived';
      rejected.push(['broadcast-owned state', project, candidate]);
    }
    {
      const {project, candidate, target} = singleCandidateProject();
      target.lists['results'] = ['results', []];
      target.blocks['write'] = block(
        'data_addtolist',
        null,
        'hat',
        false,
        {ITEM: [1, [12, candidate.name, candidate.id]]},
        {LIST: ['results', 'results']}
      );
      const readOnly = requireCandidate(collectVariableCandidates(project), candidate.id);
      rejected.push(['read-only state', project, readOnly]);
    }
    {
      const {project, candidate, target} = singleCandidateProject();
      target.blocks['hat-two'] = block('event_whenkeypressed', 'write-two', null, true);
      target.blocks['write-two'] = variableWriter('hat-two', candidate.id, candidate.name);
      rejected.push([
        'multiple event roots',
        project,
        {
          ...candidate,
          usages: [
            ...candidate.usages,
            {kind: 'field', targetIndex: 0, blockId: 'write-two'}
          ]
        }
      ]);
    }
    {
      const {project, candidate} = singleCandidateProject();
      const sprite = appendSprite(project, 'Second');
      sprite.blocks['sprite-hat'] = block('event_whenflagclicked', 'sprite-write', null, true);
      sprite.blocks['sprite-write'] = variableWriter('sprite-hat', candidate.id, candidate.name);
      rejected.push([
        'multiple usage targets',
        project,
        {
          ...candidate,
          usages: [
            ...candidate.usages,
            {kind: 'field', targetIndex: 1, blockId: 'sprite-write'}
          ]
        }
      ]);
    }
    {
      const {project, candidate} = singleCandidateProject(true);
      const stage = stageOf(project);
      stage.blocks['clone-surface'] = block('control_create_clone_of', null, null, true);
      rejected.push(['clone-reachable sprite state', project, candidate]);
    }
    {
      const {project, candidate} = singleCandidateProject(true);
      const other = appendSprite(project, 'Other');
      other.blocks['other-hat'] = block('event_whenflagclicked', 'other-write', null, true);
      other.blocks['other-write'] = variableWriter('other-hat', candidate.id, candidate.name);
      rejected.push([
        'sprite-local state used by another target',
        project,
        {...candidate, usages: [{kind: 'field', targetIndex: 2, blockId: 'other-write'}]}
      ]);
    }
    {
      const {project, candidate, target} = singleCandidateProject(true);
      appendSprite(project, target.name);
      rejected.push(['ambiguous duplicate sprite name', project, candidate]);
    }

    for (const [reason, project, candidate] of rejected) {
      const reservation = reserveGameplayStateCandidates(project, [candidate], generator(`reject:${reason}`));
      expect([...reservation.candidateKeys], reason).toEqual([]);
      expect(reservation.markerMonitors, reason).toEqual([]);
      expect(project.monitors, reason).toEqual([]);
    }
  });

  it('guards a nested substack and encodes both boolean scalar spellings', () => {
    const project = emptyProject();
    const stage = stageOf(project);
    stage.variables = {
      truth: ['truth', true],
      falsity: ['falsity', false]
    };
    stage.lists = {results: ['results', []]};
    stage.blocks = {
      hat: block('event_whenflagclicked', 'branch', null, true),
      branch: block(
        'control_if',
        null,
        'hat',
        false,
        {CONDITION: [1, [10, 'true']], SUBSTACK: [2, 'write-truth']}
      ),
      'write-truth': block(
        'data_setvariableto',
        'write-falsity',
        'branch',
        false,
        {VALUE: [1, [10, 'true']]},
        {VARIABLE: ['truth', 'truth']}
      ),
      'write-falsity': block(
        'data_setvariableto',
        'observe',
        'write-truth',
        false,
        {VALUE: [1, [10, 'false']]},
        {VARIABLE: ['falsity', 'falsity']}
      ),
      observe: block(
        'data_addtolist',
        null,
        'write-falsity',
        false,
        {ITEM: [1, [12, 'falsity', 'falsity']]},
        {LIST: ['results', 'results']}
      )
    };
    validateProject(project);

    const candidates = collectVariableCandidates(project);
    const reservation = reserveGameplayStateCandidates(project, candidates, generator('nested-reservation'));
    releaseGameplayStateCandidates(project, reservation);
    const selected = selectReservedGameplayStateCandidates(candidates, reservation);
    const gameplay = applyGameplayStateProtection(project, generator('nested-gameplay'), selected);

    expect(gameplay.protectedVariableIds).toEqual(expect.arrayContaining(['truth', 'falsity']));
    const truthPair = gameplay.integrityPairs.find(pair => pair.valueId === 'truth');
    const falsityPair = gameplay.integrityPairs.find(pair => pair.valueId === 'falsity');
    if (!truthPair || !falsityPair) throw new Error('boolean integrity pairs are unavailable');
    expect(truthPair).toMatchObject({groupSize: 2, groupPosition: 0, nextValueId: 'falsity'});
    expect(falsityPair).toMatchObject({groupSize: 2, groupPosition: 1, nextValueId: 'truth'});
    expect(stage.variables[truthPair.tagId]?.[1]).toBe(`${truthPair.secret}4:true${truthPair.linkSecret}false`);
    expect(stage.variables[falsityPair.tagId]?.[1]).toBe(`${falsityPair.secret}5:false${falsityPair.linkSecret}true`);

    const branch = requireBlock(stage, 'branch');
    const guardedEntryId = branch.inputs['SUBSTACK']?.[1];
    const guardedEntry = typeof guardedEntryId === 'string' ? stage.blocks[guardedEntryId] : undefined;
    expect(isScratchBlock(guardedEntry) ? guardedEntry.opcode : undefined).toBe('procedures_call');
    expect(isScratchBlock(guardedEntry) ? guardedEntry.next : undefined).toBe('write-truth');

    const watchdog = applyAntiCheatTransform(project, generator('nested-watchdog'), {gameplayState: gameplay});
    expect(watchdog.guardedHatCount).toBe(1);
    expect(Object.values(stage.blocks).filter(value => isScratchBlock(value) && value.opcode === 'sensing_of').length)
      .toBeGreaterThanOrEqual(4);
    validateProject(project);
  });

  it('recovers deterministically when generated token candidates collide', () => {
    const first = emptyProject();
    const second = emptyProject();

    const firstResult = applyAntiCheatTransform(first, new CollisionGenerator());
    const secondResult = applyAntiCheatTransform(second, new CollisionGenerator());

    expect(first).toEqual(second);
    expect(firstResult).toEqual(secondResult);
    const stage = stageOf(first);
    const protectedIds = [...firstResult.decoyVariableIds, firstResult.latchVariableId];
    const values = protectedIds.map(id => stage.variables[id]?.[1]);
    expect(values).toHaveLength(ANTI_CHEAT_DECOY_COUNT + 1);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every(value => typeof value === 'string' && value.length === 32)).toBe(true);
    validateProject(first);
  });

  it('reports precise diagnostics for stale gameplay and event continuation edges', () => {
    {
      const {project, candidate, target} = singleCandidateProject();
      requireBlock(target, 'write').next = 'primitive-successor';
      target.blocks['primitive-successor'] = [10, 'not a statement'];
      expect(() => applyGameplayStateProtection(project, generator('bad-gameplay-next'), [candidate]))
        .toThrow('anti-cheat gameplay write successor is unavailable');
    }

    {
      const project = emptyProject();
      const stage = stageOf(project);
      stage.blocks['hat'] = block('event_whenflagclicked', 'primitive-successor', null, true);
      stage.blocks['primitive-successor'] = [10, 'not a statement'];
      expect(() => applyAntiCheatTransform(project, generator('bad-hat-next')))
        .toThrow('anti-cheat guarded continuation is unavailable');
    }

    {
      const {project, candidate, target} = singleCandidateProject();
      const writer = requireBlock(target, 'write');
      writer.parent = null;
      writer.topLevel = true;
      expect(() => applyGameplayStateProtection(project, generator('unattached-gameplay'), [candidate]))
        .toThrow('anti-cheat gameplay statement is unavailable');
    }
  });
});

class CollisionGenerator extends DeterministicGenerator {
  #calls = 0;

  constructor() {
    super(new Uint8Array(32), 'test:anti-tamper:collisions');
  }

  override fork(domain: string): CollisionGenerator {
    void domain;
    return new CollisionGenerator();
  }

  override integer(maxExclusive: number): number {
    const band = Math.floor(this.#calls / 32);
    this.#calls += 1;
    return band % maxExclusive;
  }
}

function generator(domain: string): DeterministicGenerator {
  return new DeterministicGenerator(
    Uint8Array.from({length: 32}, (_, index) => ((index * 37) + 11) & 0xff),
    `test:anti-tamper-coverage:${domain}`
  );
}

function emptyProject(): ScratchProject {
  const project = createFixtureProject();
  const stage = stageOf(project);
  project.targets = [stage];
  project.monitors = [];
  stage.variables = {};
  stage.lists = {};
  stage.broadcasts = {};
  stage.blocks = {};
  stage.comments = {};
  return project;
}

function singleCandidateProject(onSprite = false): {
  project: ScratchProject;
  candidate: VariableCandidate;
  target: ScratchTarget;
} {
  const project = emptyProject();
  const target = onSprite ? appendSprite(project, 'Sprite') : stageOf(project);
  const targetIndex = project.targets.indexOf(target);
  target.variables['value'] = ['value', 0];
  target.blocks['hat'] = block('event_whenflagclicked', 'write', null, true);
  target.blocks['write'] = variableWriter('hat', 'value', 'value');
  const candidate = requireCandidate(collectVariableCandidates(project), 'value', targetIndex);
  return {project, candidate, target};
}

function appendSprite(project: ScratchProject, name: string): ScratchTarget {
  const fixtureSprite = createFixtureProject().targets.find(target => !target.isStage);
  if (!fixtureSprite) throw new Error('fixture Sprite is unavailable');
  const sprite = structuredClone(fixtureSprite);
  sprite.name = name;
  sprite.variables = {};
  sprite.lists = {};
  sprite.broadcasts = {};
  sprite.blocks = {};
  sprite.comments = {};
  project.targets.push(sprite);
  return sprite;
}

function variableWriter(parent: string, id: string, name: string): ScratchBlock {
  return block(
    'data_setvariableto',
    null,
    parent,
    false,
    {VALUE: [1, [4, '1']]},
    {VARIABLE: [name, id]}
  );
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
    ...(topLevel ? {x: 0, y: 0} : {})
  };
}

function requireBlock(target: ScratchTarget, id: string): ScratchBlock {
  const value = target.blocks[id];
  if (!isScratchBlock(value)) throw new Error(`block ${id} is unavailable`);
  return value;
}

function requireCandidate(
  candidates: readonly VariableCandidate[],
  id: string,
  targetIndex?: number
): VariableCandidate {
  const candidate = candidates.find(value => value.id === id && (
    targetIndex === undefined || value.targetIndex === targetIndex
  ));
  if (!candidate) throw new Error(`candidate ${id} is unavailable`);
  return candidate;
}

function variableMonitor(id: string, name: string): Record<string, JsonValue> {
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
