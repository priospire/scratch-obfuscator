import {isScratchBlock} from '../model/blocks.js';
import type {DeterministicGenerator} from '../deterministic.js';
import type {
  ObfuscationMode,
  ObfuscationStats,
  ScratchBlock,
  ScratchInput,
  ScratchProject,
  ScratchTarget
} from '../types.js';
import {
  blockAt,
  collectLinearRuns,
  collectNumericLiteralSites,
  collectStringLiteralSites,
  collectVariableCandidates,
  countBlockEquivalents,
  countObjectBlocks,
  hardenInactiveShadows,
  isLossyLiveTransformSafe,
  isVirtualizableStackBlock,
  type LinearRun,
  type NumericLiteralSite,
  type VariableCandidate
} from './analysis.js';

export type AggressiveMode = Extract<ObfuscationMode, 'lossy' | 'no-preserve'>;

interface PrivateState {
  readonly variableId: string;
  readonly variableName: string;
  readonly listId: string;
  readonly listName: string;
  readonly token: string;
  readonly mismatch: string;
}

interface GuardSite {
  readonly targetIndex: number;
  readonly guardId: string;
  tailId: string | null;
  chainDepth: number;
  growth: number;
}

interface InsertionEdge {
  readonly targetIndex: number;
  readonly predecessorId: string;
  readonly successorId: string;
}

interface ConditionSite {
  readonly targetIndex: number;
  readonly blockId: string;
  readonly growth: 1 | 2;
}

interface SelectedVariable {
  readonly candidate: VariableCandidate;
  readonly state: PrivateState;
  readonly ordinal: number;
  readonly slot: number;
}

type DispatcherTemplate = 'nested-if-else' | 'sequential-if';

type DecoyOpcode =
  | 'data_addtolist'
  | 'data_changevariableby'
  | 'data_deletealloflist'
  | 'data_deleteoflist'
  | 'data_insertatlist'
  | 'data_replaceitemoflist'
  | 'data_setvariableto';

interface DecoyVocabulary {
  readonly byCost: Readonly<Record<1 | 2 | 3, readonly DecoyOpcode[]>>;
}

interface TransitionTable {
  readonly values: Array<string | number>;
  readonly slots: readonly number[];
}

interface StringPoolState {
  readonly listId: string;
  readonly listName: string;
  readonly values: string[];
  readonly slots: Map<string, number>;
}

interface StringPoolPlan {
  readonly parts: readonly string[];
  readonly growth: 1 | 2 | 6 | 7;
}

class GrowthBudget {
  readonly #growth: number;
  readonly #boundaries: readonly [number, number, number, number];
  #spent = 0;

  constructor(growth: number, mode: AggressiveMode) {
    this.#growth = growth;
    this.#boundaries = mode === 'lossy'
      ? [Math.floor(growth * 0.3), Math.floor(growth * 0.5), Math.floor(growth * 0.8), growth]
      : [Math.floor(growth * 0.55), Math.floor(growth * 0.7), Math.floor(growth * 0.9), growth];
  }

  trySpend(amount: number, stage: 0 | 1 | 2 | 3): boolean {
    const boundary = this.#boundaries[stage];
    if (this.#spent + amount > boundary) return false;
    this.#spent += amount;
    return true;
  }

  get remaining(): number {
    return this.#growth - this.#spent;
  }
}

class UniqueFactory {
  readonly #rng: DeterministicGenerator;
  readonly #blockIds: Set<string>;
  readonly #symbolIds: Set<string>;
  readonly #names: Set<string>;
  #nameOrdinal = 0;

  constructor(project: ScratchProject, rng: DeterministicGenerator) {
    this.#rng = rng;
    this.#blockIds = new Set(project.targets.flatMap(target => Object.keys(target.blocks)));
    this.#symbolIds = new Set(project.targets.flatMap(target => [
      ...Object.keys(target.variables),
      ...Object.keys(target.lists),
      ...Object.keys(target.broadcasts)
    ]));
    this.#names = new Set(project.targets.flatMap(target => [
      ...Object.values(target.variables).map(tuple => tuple[0]).filter((value): value is string => typeof value === 'string'),
      ...Object.values(target.lists).map(tuple => tuple[0]).filter((value): value is string => typeof value === 'string')
    ]));
  }

  block(domain: string): string {
    const rng = this.#rng.fork(`block\u0000${domain}`);
    for (;;) {
      const id = rng.id('b_', 20);
      if (!this.#blockIds.has(id)) {
        this.#blockIds.add(id);
        return id;
      }
    }
  }

  symbol(prefix: 'v_' | 'l_', domain: string): string {
    const rng = this.#rng.fork(`symbol\u0000${domain}`);
    for (;;) {
      const id = rng.id(prefix, 20);
      if (!this.#symbolIds.has(id)) {
        this.#symbolIds.add(id);
        return id;
      }
    }
  }

  name(mode: AggressiveMode, domain: string): string {
    const rng = this.#rng.fork(`name\u0000${domain}`);
    for (;;) {
      const ordinal = this.#nameOrdinal;
      this.#nameOrdinal += 1;
      const candidate = mode === 'no-preserve'
        ? makeInvisibleDisplayName(rng, ordinal)
        : rng.id('n_', 16);
      if (!this.#names.has(candidate)) {
        this.#names.add(candidate);
        return candidate;
      }
    }
  }
}

/**
 * Apply deterministic high-overhead passes after common identifier renaming.
 * The function mutates the supplied project and stats in place.
 */
export function applyAggressiveTransforms(
  project: ScratchProject,
  mode: AggressiveMode,
  rng: DeterministicGenerator,
  stats: ObfuscationStats
): void {
  const initialEquivalents = countBlockEquivalents(project);
  const cap = mode === 'lossy'
    ? Math.max(initialEquivalents, Math.min(initialEquivalents * 4, 50_000))
    : Math.max(initialEquivalents, Math.min((initialEquivalents * 25) + 512, 100_000));
  const budget = new GrowthBudget(cap - initialEquivalents, mode);
  const factory = new UniqueFactory(project, rng.fork('aggressive-ids'));
  const decoyVocabulary = collectDecoyVocabulary(project);
  const stringPools = new Map<number, StringPoolState>();
  const privateStates = new Map<number, PrivateState>();
  const getState = (targetIndex: number): PrivateState => {
    const present = privateStates.get(targetIndex);
    if (present) return present;
    const target = requireTarget(project, targetIndex);
    const state = createPrivateState(target, targetIndex, mode, factory, rng.fork(`state-${targetIndex}`));
    privateStates.set(targetIndex, state);
    return state;
  };

  const poisonRng = rng.fork('inactive-shadows');
  hardenInactiveShadows(project, primitive => poisonPrimitive(primitive, poisonRng));
  const allowLiveLossyChanges = mode === 'no-preserve' || isLossyLiveTransformSafe(project);
  const conditionSites = allowLiveLossyChanges
    ? rng.fork('condition-order').shuffle(collectConditionSites(project))
    : [];
  const numericSites = allowLiveLossyChanges
    ? rng.fork('numeric-order').shuffle(collectNumericLiteralSites(project))
    : [];
  const dualRailEdges = allowLiveLossyChanges
    ? rng.fork('dual-rail-order').shuffle(collectInsertionEdges(project))
    : [];

  const originalVariableCandidates = mode === 'no-preserve' ? collectVariableCandidates(project) : [];

  if (mode === 'lossy' && allowLiveLossyChanges) {
    const runs = rng.fork('outline-order').shuffle(collectLinearRuns(project));
    for (const run of runs) {
      if (!budget.trySpend(3, 0)) continue;
      outlineRun(project, run, factory);
    }
  }

  if (mode === 'no-preserve') {
    const runs = rng.fork('run-order').shuffle(collectLinearRuns(project).flatMap(run => boundDispatcherRuns(project, run)));
    for (const [index, run] of runs.entries()) {
      const growth = estimateDispatcherGrowth(run.blockIds.length);
      if (!budget.trySpend(growth, 0)) continue;
      fragmentRun(project, run, getState(run.targetIndex), factory, rng.fork(`run-${index}`));
      stats.virtualizedBlocks += run.blockIds.length;
    }
  }

  for (const [index, site] of numericSites.entries()) {
    if (!budget.trySpend(site.growth, 1)) continue;
    encodeNumericLiteral(project, site, factory, rng.fork(`numeric-${index}`), poisonRng);
  }

  if (mode === 'no-preserve') {
    const variables = rng.fork('variable-order').shuffle(originalVariableCandidates);
    const selected: SelectedVariable[] = [];
    for (const [index, candidate] of variables.entries()) {
      if (candidate.estimatedGrowth > 256) continue;
      if (!budget.trySpend(candidate.estimatedGrowth, 1)) continue;
      const state = getState(candidate.targetIndex);
      selected.push({
        candidate,
        state,
        ordinal: index,
        slot: reserveVariableSlot(project, candidate, state)
      });
    }
    for (const selection of selected) virtualizeVariableInputs(project, selection, factory);
    for (const selection of selected) {
      virtualizeVariableFields(project, selection, factory);
      const target = requireTarget(project, selection.candidate.targetIndex);
      delete target.variables[selection.candidate.id];
    }
  }

  const stringSites = allowLiveLossyChanges ? rng.fork('literal-order').shuffle(collectStringLiteralSites(project)) : [];
  for (const [index, site] of stringSites.entries()) {
    const target = requireTarget(project, site.targetIndex);
    const owner = requireBlock(target, site.ownerId);
    const input = owner.inputs[site.inputName];
    const active = input?.[1];
    if (!input || !Array.isArray(active) || active[0] !== 10 || active[1] !== site.value) continue;
    const literalRng = rng.fork(`literal-${index}`);
    const shouldPool = mode === 'no-preserve' && (index === 0 || literalRng.integer(2) === 0);
    if (shouldPool) {
      const plan = makeStringPoolPlan(site.value, input[2] !== undefined, literalRng.fork('pool-plan'));
      if (budget.trySpend(plan.growth, 1)) {
        const pool = getStringPool(project, site.targetIndex, stringPools, factory);
        poolStringLiteral(target, site.ownerId, owner, site.inputName, site.value, plan, pool, factory, poisonRng);
        continue;
      }
    }
    const splitGrowth = input[2] === undefined ? 3 : 2;
    if (!budget.trySpend(splitGrowth, 1)) continue;
    splitStringLiteral(target, site.ownerId, owner, site.inputName, site.value, factory, literalRng, poisonRng);
  }

  for (const [index, site] of conditionSites.entries()) {
    if (!budget.trySpend(site.growth, 2)) continue;
    invertCondition(project, site, factory, `condition-${index}`);
  }


  for (const [index, edge] of dualRailEdges.entries()) {
    const target = requireTarget(project, edge.targetIndex);
    const predecessor = blockAt(target, edge.predecessorId);
    if (!predecessor || predecessor.next !== edge.successorId || !blockAt(target, edge.successorId)) continue;
    if (!budget.trySpend(9, 2)) continue;
    insertDualRail(
      target,
      edge,
      getState(edge.targetIndex),
      factory,
      rng.fork(`dual-rail-${index}`),
      `dual-rail-${index}`
    );
  }

  const guards: GuardSite[] = [];
  const edges = allowLiveLossyChanges ? rng.fork('guard-order').shuffle(collectInsertionEdges(project)) : [];
  for (const [index, edge] of edges.entries()) {
    if (!budget.trySpend(5, 2)) continue;
    const target = requireTarget(project, edge.targetIndex);
    const state = getState(edge.targetIndex);
    const guard = insertOpaqueGuard(target, edge, state, factory, `edge-${index}`);
    guards.push(guard);
  }

  if (guards.length === 0 && budget.trySpend(5, 2)) {
    const targetIndex = rng.fork('guard-target').integer(project.targets.length);
    const target = requireTarget(project, targetIndex);
    const state = getState(targetIndex);
    guards.push(createTopLevelGuard(target, targetIndex, state, factory, 'top-level'));
  }

  fillDecoyBudget(
    project,
    mode,
    budget,
    Math.max(0, cap - countBlockEquivalents(project)),
    guards,
    getState,
    factory,
    rng.fork('decoys'),
    decoyVocabulary,
    stats
  );
  stats.blocksAfter = countObjectBlocks(project);

  const finalEquivalents = countBlockEquivalents(project);
  if (finalEquivalents > cap) {
    throw new Error(`aggressive transform exceeded its block-equivalent cap (${finalEquivalents} > ${cap})`);
  }
}

export function makeInvisibleDisplayName(rng: DeterministicGenerator, ordinal: number): string {
  const marker = '\u2063';
  const bits = ((ordinal + 1) * 0x9e3779b1) ^ rng.integer(0x1_0000_0000);
  let name = marker;
  for (let shift = 0; shift < 32; shift += 1) {
    name += ((bits >>> shift) & 1) === 0 ? '\u200b' : '\u2060';
  }
  return safeInvisibleDisplayName(name, rng, ordinal);
}

export function safeInvisibleDisplayName(candidate: string, rng: DeterministicGenerator, ordinal: number): string {
  if (
    candidate.length > 0
    && candidate.normalize('NFC') === candidate
    && Array.from(candidate).every(character => isSafeDisplayNameCodePoint(character.codePointAt(0)))
  ) return candidate;
  return `\ue000${ordinal.toString(36)}_${rng.id('n_', 10)}`;
}

function isSafeDisplayNameCodePoint(codePoint: number | undefined): boolean {
  if (codePoint === undefined || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  if (codePoint === 0x061c || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0x200e || codePoint === 0x200f) return false;
  if ((codePoint >= 0x202a && codePoint <= 0x202e) || codePoint === 0x2028 || codePoint === 0x2029) return false;
  if ((codePoint >= 0x2066 && codePoint <= 0x206f) || codePoint === 0xfeff) return false;
  return true;
}

function createPrivateState(
  target: ScratchTarget,
  targetIndex: number,
  mode: AggressiveMode,
  factory: UniqueFactory,
  rng: DeterministicGenerator
): PrivateState {
  const variableId = factory.symbol('v_', `state-${targetIndex}`);
  const listId = factory.symbol('l_', `store-${targetIndex}`);
  const variableName = factory.name(mode, `state-${targetIndex}`);
  const listName = factory.name(mode, `store-${targetIndex}`);
  const token = `q_${rng.id('t_', 18)}`;
  const mismatch = `z_${rng.id('u_', 18)}`;
  target.variables[variableId] = [variableName, token];
  target.lists[listId] = [listName, [`j_${rng.id('d_', 12)}`, rng.integer(1_000_000)]];
  return {variableId, variableName, listId, listName, token, mismatch};
}

function fragmentRun(
  project: ScratchProject,
  run: LinearRun,
  railState: PrivateState,
  factory: UniqueFactory,
  rng: DeterministicGenerator
): void {
  const target = requireTarget(project, run.targetIndex);
  const firstId = requireItem(run.blockIds, 0, 'dispatcher run');

  const existingCodes = collectProcedureCodes(target);
  const stateId = factory.symbol('v_', `dispatcher-state-${run.targetIndex}-${firstId}`);
  const stateName = factory.name('no-preserve', `dispatcher-state-${run.targetIndex}-${firstId}`);
  const transitionListId = factory.symbol('l_', `dispatcher-transitions-${run.targetIndex}-${firstId}`);
  const transitionListName = factory.name('no-preserve', `dispatcher-transitions-${run.targetIndex}-${firstId}`);
  const labels = uniqueLabels(run.blockIds.length + 2, rng.fork('labels'));
  const exitLabel = requireItem(labels, run.blockIds.length, 'dispatcher exit label');
  const fakeLabel = requireItem(labels, run.blockIds.length + 1, 'dispatcher fake label');
  const transitionTable = makeTransitionTable(
    labels.slice(0, run.blockIds.length + 1),
    rng.fork('transition-table')
  );
  target.variables[stateId] = [stateName, exitLabel];
  target.lists[transitionListId] = [transitionListName, transitionTable.values];

  const allocateCode = (domain: string, ordinal: number): string => {
    let code = makeInvisibleDisplayName(rng.fork(domain), ordinal);
    for (let suffix = 0; existingCodes.has(code); suffix += 1) code += suffix % 2 === 0 ? '\u200b' : '\u2060';
    existingCodes.add(code);
    return code;
  };
  const dispatcherCode = allocateCode('dispatcher-code', run.blockIds.length + 1);
  const fakeCode = allocateCode('fake-code', run.blockIds.length + 2);
  const dispatcherDefinitionId = factory.block(`dispatcher-def-${run.targetIndex}-${firstId}`);
  const dispatcherPrototypeId = factory.block(`dispatcher-proto-${run.targetIndex}-${firstId}`);
  const fakeDefinitionId = factory.block(`fake-def-${run.targetIndex}-${firstId}`);
  const fakePrototypeId = factory.block(`fake-proto-${run.targetIndex}-${firstId}`);
  const fakeBodyId = factory.block(`fake-body-${run.targetIndex}-${firstId}`);
  const handlers = run.blockIds.map((originalId, index) => {
    const definitionId = factory.block(`handler-def-${run.targetIndex}-${originalId}`);
    const prototypeId = factory.block(`handler-proto-${run.targetIndex}-${originalId}`);
    const setStateId = factory.block(`handler-state-${run.targetIndex}-${originalId}`);
    const transitionReporterId = factory.block(`handler-transition-${run.targetIndex}-${originalId}`);
    const dispatchCallId = index + 1 < run.blockIds.length
      ? factory.block(`handler-dispatch-${run.targetIndex}-${originalId}`)
      : null;
    return {
      originalId,
      definitionId,
      prototypeId,
      setStateId,
      transitionReporterId,
      dispatchCallId,
      label: requireItem(labels, index, 'dispatcher label'),
      transitionSlot: requireItem(transitionTable.slots, index + 1, 'dispatcher transition slot'),
      proccode: allocateCode(`handler-code-${index}`, index)
    };
  });
  const entrySetId = factory.block(`dispatcher-entry-state-${run.targetIndex}-${firstId}`);
  const entryReporterId = factory.block(`dispatcher-entry-transition-${run.targetIndex}-${firstId}`);
  const entryCallId = factory.block(`dispatcher-entry-call-${run.targetIndex}-${firstId}`);

  for (const handler of handlers) {
    const original = requireBlock(target, handler.originalId);
    original.topLevel = false;
    delete original.x;
    delete original.y;
    original.parent = handler.definitionId;
    original.next = handler.setStateId;
    target.blocks[handler.setStateId] = makeSetStateFromListBlock(
      handler.originalId,
      handler.dispatchCallId,
      stateName,
      stateId,
      handler.transitionReporterId,
      false
    );
    target.blocks[handler.transitionReporterId] = makeNamedListItemReporter(
      handler.setStateId,
      transitionListName,
      transitionListId,
      handler.transitionSlot
    );
    if (handler.dispatchCallId) {
      target.blocks[handler.dispatchCallId] = makeProcedureCall(dispatcherCode, handler.setStateId, null, false);
    }
  }

  const entryParent = run.predecessorId;
  target.blocks[entrySetId] = makeSetStateFromListBlock(
    entryParent,
    entryCallId,
    stateName,
    stateId,
    entryReporterId,
    run.wasTopLevel,
    run.x,
    run.y
  );
  target.blocks[entryReporterId] = makeNamedListItemReporter(
    entrySetId,
    transitionListName,
    transitionListId,
    requireItem(transitionTable.slots, 0, 'dispatcher entry slot')
  );
  target.blocks[entryCallId] = makeProcedureCall(dispatcherCode, entrySetId, run.successorId, false);
  if (entryParent) {
    const predecessor = requireBlock(target, entryParent);
    predecessor.next = entrySetId;
  }
  const successor = run.successorId ? blockAt(target, run.successorId) : undefined;
  if (successor) successor.parent = entryCallId;
  insertDualRail(
    target,
    {targetIndex: run.targetIndex, predecessorId: entrySetId, successorId: entryCallId},
    railState,
    factory,
    rng.fork('entry-dual-rail'),
    `dispatcher-dual-${run.targetIndex}-${firstId}`
  );

  const routeRecords = handlers.map((handler, index) => ({
    label: handler.label,
    proccode: handler.proccode,
    ifId: factory.block(`dispatcher-if-${run.targetIndex}-${firstId}-${index}`),
    equalsId: factory.block(`dispatcher-equals-${run.targetIndex}-${firstId}-${index}`),
    reporterId: factory.block(`dispatcher-variable-${run.targetIndex}-${firstId}-${index}`),
    callId: factory.block(`dispatcher-route-${run.targetIndex}-${firstId}-${index}`)
  }));
  routeRecords.push({
    label: fakeLabel,
    proccode: fakeCode,
    ifId: factory.block(`dispatcher-if-${run.targetIndex}-${firstId}-fake`),
    equalsId: factory.block(`dispatcher-equals-${run.targetIndex}-${firstId}-fake`),
    reporterId: factory.block(`dispatcher-variable-${run.targetIndex}-${firstId}-fake`),
    callId: factory.block(`dispatcher-route-${run.targetIndex}-${firstId}-fake`)
  });
  const dispatchOrder = rng.fork('dispatch-order').shuffle(routeRecords);
  const template: DispatcherTemplate = rng.fork('dispatcher-template').integer(2) === 0
    ? 'nested-if-else'
    : 'sequential-if';
  let branchParentId = dispatcherDefinitionId;
  for (let index = 0; index < dispatchOrder.length; index += 1) {
    const route = requireItem(dispatchOrder, index, 'dispatcher route');
    const nextRoute = dispatchOrder[index + 1];
    target.blocks[route.ifId] = makeDispatcherBranch(
      branchParentId,
      route.equalsId,
      route.callId,
      nextRoute?.ifId ?? null,
      template
    );
    target.blocks[route.equalsId] = makeStateEquality(route.ifId, route.reporterId, route.label);
    target.blocks[route.reporterId] = makeVariableReporter(route.equalsId, {variableId: stateId, variableName: stateName});
    target.blocks[route.callId] = makeProcedureCall(route.proccode, route.ifId, null, false);
    branchParentId = route.ifId;
  }

  const firstRouteId = requireItem(dispatchOrder, 0, 'dispatcher route').ifId;
  target.blocks[dispatcherDefinitionId] = makeProcedureDefinition(dispatcherPrototypeId, firstRouteId);
  target.blocks[dispatcherPrototypeId] = makeProcedurePrototype(dispatcherDefinitionId, dispatcherCode);
  target.blocks[fakeDefinitionId] = makeProcedureDefinition(fakePrototypeId, fakeBodyId);
  target.blocks[fakePrototypeId] = makeProcedurePrototype(fakeDefinitionId, fakeCode);
  target.blocks[fakeBodyId] = {
    opcode: 'data_deletealloflist',
    next: null,
    parent: fakeDefinitionId,
    inputs: {},
    fields: {LIST: [transitionListName, transitionListId]},
    shadow: false,
    topLevel: false
  };
  for (const handler of rng.fork('definition-order').shuffle(handlers)) {
    target.blocks[handler.definitionId] = makeProcedureDefinition(handler.prototypeId, handler.originalId);
    target.blocks[handler.prototypeId] = makeProcedurePrototype(handler.definitionId, handler.proccode);
  }
}

function makeTransitionTable(labels: readonly number[], rng: DeterministicGenerator): TransitionTable {
  const values: Array<string | number> = [];
  const slots: number[] = [];
  const widthOffset = rng.integer(4);
  for (const [index, label] of labels.entries()) {
    const width = 1 + ((widthOffset + index) % 4);
    values.push(`r_${rng.id('r_', 8)}`, width);
    for (let junk = 0; junk < width; junk += 1) {
      values.push(junk % 2 === 0 ? `j_${rng.id('j_', 8)}` : rng.integer(0x3fff_ffff));
    }
    slots.push(values.length + 1);
    values.push(label);
  }
  return {values, slots};
}

function outlineRun(
  project: ScratchProject,
  run: LinearRun,
  factory: UniqueFactory
): void {
  const target = requireTarget(project, run.targetIndex);
  const firstId = requireItem(run.blockIds, 0, 'outlined run');
  const lastId = requireItem(run.blockIds, run.blockIds.length - 1, 'outlined run');
  const existingCodes = collectProcedureCodes(target);
  let proccode = factory.name('lossy', `outline-${run.targetIndex}-${firstId}`);
  while (existingCodes.has(proccode)) proccode += '_';
  const definitionId = factory.block(`outline-def-${run.targetIndex}-${firstId}`);
  const prototypeId = factory.block(`outline-proto-${run.targetIndex}-${firstId}`);
  const callId = factory.block(`outline-call-${run.targetIndex}-${firstId}`);
  const first = requireBlock(target, firstId);
  const last = requireBlock(target, lastId);
  first.parent = definitionId;
  first.topLevel = false;
  delete first.x;
  delete first.y;
  last.next = null;
  target.blocks[definitionId] = makeProcedureDefinition(prototypeId, firstId);
  target.blocks[prototypeId] = makeProcedurePrototype(definitionId, proccode, false);
  target.blocks[callId] = makeProcedureCall(
    proccode,
    run.predecessorId,
    run.successorId,
    run.wasTopLevel,
    false,
    run.x,
    run.y
  );
  if (run.predecessorId) requireBlock(target, run.predecessorId).next = callId;
  if (run.successorId) {
    const successor = requireBlock(target, run.successorId);
    successor.parent = callId;
  }
}

function estimateDispatcherGrowth(length: number): number {
  return (13 * length) + 24;
}

function boundDispatcherRuns(project: ScratchProject, run: LinearRun): LinearRun[] {
  const maximumLength = 17;
  const target = requireTarget(project, run.targetIndex);
  if (run.blockIds.length <= maximumLength) return [run];
  const bounded: LinearRun[] = [];
  let cursor = 0;
  while (run.blockIds.length - cursor >= 4) {
    const remaining = run.blockIds.length - cursor;
    const length = remaining === maximumLength + 4
      ? maximumLength - 1
      : Math.min(maximumLength, remaining);
    const blockIds = run.blockIds.slice(cursor, cursor + length);
    requireBlock(target, requireItem(blockIds, 0, 'bounded dispatcher run'));
    bounded.push({
      targetIndex: run.targetIndex,
      blockIds,
      predecessorId: cursor === 0 ? run.predecessorId : requireItem(run.blockIds, cursor - 1, 'dispatcher separator'),
      successorId: run.blockIds[cursor + length] ?? run.successorId,
      wasTopLevel: cursor === 0 && run.wasTopLevel,
      ...(cursor === 0 && run.x !== undefined ? {x: run.x} : {}),
      ...(cursor === 0 && run.y !== undefined ? {y: run.y} : {})
    });
    cursor += length;
    if (run.blockIds.length - cursor >= 5) cursor += 1;
  }
  return bounded;
}

function uniqueLabels(count: number, rng: DeterministicGenerator): number[] {
  const labels = new Set<number>();
  while (labels.size < count) labels.add(1 + rng.integer(0x3fff_ffff));
  return [...labels];
}

function makeProcedureDefinition(prototypeId: string, bodyId: string): ScratchBlock {
  return {
    opcode: 'procedures_definition',
    next: bodyId,
    parent: null,
    inputs: {custom_block: [1, prototypeId]},
    fields: {},
    shadow: false,
    topLevel: true,
    x: 0,
    y: 0
  };
}

function makeProcedurePrototype(definitionId: string, proccode: string, warp = true): ScratchBlock {
  return {
    opcode: 'procedures_prototype',
    next: null,
    parent: definitionId,
    inputs: {},
    fields: {},
    shadow: true,
    topLevel: false,
    mutation: {
      tagName: 'mutation',
      children: [],
      proccode,
      argumentids: '[]',
      argumentnames: '[]',
      argumentdefaults: '[]',
      warp: warp ? 'true' : 'false'
    }
  };
}

function makeProcedureCall(
  proccode: string,
  parent: string | null,
  next: string | null,
  topLevel: boolean,
  warp = true,
  x?: number,
  y?: number
): ScratchBlock {
  return {
    opcode: 'procedures_call',
    next,
    parent,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel,
    ...(x === undefined ? {} : {x}),
    ...(y === undefined ? {} : {y}),
    mutation: {
      tagName: 'mutation',
      children: [],
      proccode,
      argumentids: '[]',
      warp: warp ? 'true' : 'false'
    }
  };
}

function makeSetStateFromListBlock(
  parent: string | null,
  next: string | null,
  variableName: string,
  variableId: string,
  reporterId: string,
  topLevel: boolean,
  x?: number,
  y?: number
): ScratchBlock {
  return {
    opcode: 'data_setvariableto',
    next,
    parent,
    inputs: {VALUE: [3, reporterId, [4, '0']]},
    fields: {VARIABLE: [variableName, variableId]},
    shadow: false,
    topLevel,
    ...(x === undefined ? {} : {x}),
    ...(y === undefined ? {} : {y})
  };
}

function makeDispatcherBranch(
  parentId: string,
  equalsId: string,
  handlerCallId: string,
  nextBranchId: string | null,
  template: DispatcherTemplate
): ScratchBlock {
  if (template === 'sequential-if') {
    return {
      opcode: 'control_if',
      next: nextBranchId,
      parent: parentId,
      inputs: {
        CONDITION: [2, equalsId],
        SUBSTACK: [2, handlerCallId]
      },
      fields: {},
      shadow: false,
      topLevel: false
    };
  }
  return {
    opcode: 'control_if_else',
    next: null,
    parent: parentId,
    inputs: {
      CONDITION: [2, equalsId],
      SUBSTACK: [2, handlerCallId],
      SUBSTACK2: [2, nextBranchId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
}

function makeStateEquality(
  parentId: string,
  reporterId: string,
  label: number
): ScratchBlock {
  return {
    opcode: 'operator_equals',
    next: null,
    parent: parentId,
    inputs: {
      OPERAND1: [3, reporterId, [10, '']],
      OPERAND2: numericInput(label)
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
}

function collectProcedureCodes(target: ScratchTarget): Set<string> {
  const codes = new Set<string>();
  for (const value of Object.values(target.blocks)) {
    if (!isScratchBlock(value)) continue;
    const code = value.mutation?.['proccode'];
    if (typeof code === 'string') codes.add(code);
  }
  return codes;
}

function reserveVariableSlot(
  project: ScratchProject,
  candidate: VariableCandidate,
  state: PrivateState
): number {
  const target = requireTarget(project, candidate.targetIndex);
  const listDeclaration = requireItem(target.lists[state.listId] ?? [], 1, 'private state list');
  if (!Array.isArray(listDeclaration)) throw new Error('private state list has an invalid value');
  const slot = listDeclaration.length + 1;
  listDeclaration.push(candidate.initialValue);
  return slot;
}

function virtualizeVariableInputs(
  project: ScratchProject,
  selection: SelectedVariable,
  factory: UniqueFactory
): void {
  const {candidate, state, ordinal, slot} = selection;
  const target = requireTarget(project, candidate.targetIndex);
  for (const [usageIndex, usage] of candidate.usages.entries()) {
    if (usage.kind !== 'inline') continue;
    const block = requireBlock(target, usage.blockId);
    const input = block.inputs[usage.inputName] ?? [];
    requireItem(input, 1, 'inline variable input');
    const reporterId = factory.block(`virtual-inline-${candidate.targetIndex}-${ordinal}-${usageIndex}`);
    target.blocks[reporterId] = makeListItemReporter(blockIdOrNull(usage.blockId), state, slot);
    block.inputs[usage.inputName] = [3, reporterId, [10, '']];
  }
}

function virtualizeVariableFields(
  project: ScratchProject,
  selection: SelectedVariable,
  factory: UniqueFactory
): void {
  const {candidate, state, ordinal, slot} = selection;
  const target = requireTarget(project, candidate.targetIndex);
  for (const [usageIndex, usage] of candidate.usages.entries()) {
    if (usage.kind !== 'field') continue;
    const block = requireBlock(target, usage.blockId);
    if (block.opcode === 'data_variable') {
      block.opcode = 'data_itemoflist';
      block.fields = {LIST: [state.listName, state.listId]};
      block.inputs = {INDEX: numericInput(slot)};
    } else if (block.opcode === 'data_setvariableto') {
      const value = block.inputs['VALUE'] ?? textInput('');
      block.opcode = 'data_replaceitemoflist';
      block.fields = {LIST: [state.listName, state.listId]};
      block.inputs = {INDEX: numericInput(slot), ITEM: value};
    } else if (block.opcode === 'data_changevariableby') {
      const delta = block.inputs['VALUE'] ?? numericInput(0);
      const itemId = factory.block(`virtual-current-${candidate.targetIndex}-${ordinal}-${usageIndex}`);
      const addId = factory.block(`virtual-add-${candidate.targetIndex}-${ordinal}-${usageIndex}`);
      reparentInputReferences(target, delta, addId);
      target.blocks[itemId] = makeListItemReporter(addId, state, slot);
      target.blocks[addId] = {
        opcode: 'operator_add',
        next: null,
        parent: usage.blockId,
        inputs: {NUM1: [2, itemId], NUM2: delta},
        fields: {},
        shadow: false,
        topLevel: false
      };
      block.opcode = 'data_replaceitemoflist';
      block.fields = {LIST: [state.listName, state.listId]};
      block.inputs = {INDEX: numericInput(slot), ITEM: [3, addId, [10, '']]};
    }
  }
}

function makeListItemReporter(parent: string | null, state: PrivateState, slot: number): ScratchBlock {
  return makeNamedListItemReporter(parent, state.listName, state.listId, slot);
}

function makeNamedListItemReporter(
  parent: string | null,
  listName: string,
  listId: string,
  slot: number
): ScratchBlock {
  return {
    opcode: 'data_itemoflist',
    next: null,
    parent,
    inputs: {INDEX: numericInput(slot)},
    fields: {LIST: [listName, listId]},
    shadow: false,
    topLevel: false
  };
}

function blockIdOrNull(id: string): string {
  return id;
}

function reparentInputReferences(target: ScratchTarget, input: ScratchInput, parentId: string): void {
  for (let index = 1; index < input.length; index += 1) {
    const reference = input[index];
    if (typeof reference !== 'string') continue;
    const child = blockAt(target, reference);
    if (child) child.parent = parentId;
  }
}

function splitStringLiteral(
  target: ScratchTarget,
  ownerId: string,
  owner: ScratchBlock,
  inputName: string,
  original: string,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  poisonRng: DeterministicGenerator
): void {
  const points = Array.from(original);
  const split = points.length < 2 ? points.length : 1 + rng.integer(points.length - 1);
  const left = points.slice(0, split).join('');
  const right = points.slice(split).join('');
  const joinId = factory.block(`string-${inputName}-${rng.id('s_', 10)}`);
  target.blocks[joinId] = {
    opcode: 'operator_join',
    next: null,
    parent: ownerId,
    inputs: {STRING1: textInput(left), STRING2: textInput(right)},
    fields: {},
    shadow: false,
    topLevel: false
  };
  const existingFallback = owner.inputs[inputName]?.[2];
  owner.inputs[inputName] = [
    3,
    joinId,
    existingFallback ?? poisonPrimitive([10, original], poisonRng)
  ];
}

function makeStringPoolPlan(
  value: string,
  hasFallback: boolean,
  rng: DeterministicGenerator
): StringPoolPlan {
  const points = Array.from(value);
  if (points.length < 2) return {parts: [value], growth: hasFallback ? 1 : 2};
  const split = 1 + rng.integer(points.length - 1);
  return {
    parts: [points.slice(0, split).join(''), points.slice(split).join('')],
    growth: hasFallback ? 6 : 7
  };
}

function getStringPool(
  project: ScratchProject,
  targetIndex: number,
  pools: Map<number, StringPoolState>,
  factory: UniqueFactory
): StringPoolState {
  const present = pools.get(targetIndex);
  if (present) return present;
  const target = requireTarget(project, targetIndex);
  const listId = factory.symbol('l_', `string-pool-${targetIndex}`);
  const listName = factory.name('no-preserve', `string-pool-${targetIndex}`);
  const values: string[] = [];
  const pool: StringPoolState = {listId, listName, values, slots: new Map()};
  target.lists[listId] = [listName, values];
  pools.set(targetIndex, pool);
  return pool;
}

function reserveStringPoolSlot(pool: StringPoolState, value: string): number {
  const present = pool.slots.get(value);
  if (present !== undefined) return present;
  pool.values.push(value);
  const slot = pool.values.length;
  pool.slots.set(value, slot);
  return slot;
}

function poolStringLiteral(
  target: ScratchTarget,
  ownerId: string,
  owner: ScratchBlock,
  inputName: string,
  original: string,
  plan: StringPoolPlan,
  pool: StringPoolState,
  factory: UniqueFactory,
  poisonRng: DeterministicGenerator
): void {
  const existingFallback = owner.inputs[inputName]?.[2];
  const ownerFallback = existingFallback ?? poisonPrimitive([10, original], poisonRng);
  const firstPart = requireItem(plan.parts, 0, 'string pool plan');
  const firstReporterId = factory.block(`string-pool-${ownerId}-${inputName}-0`);
  const firstSlot = reserveStringPoolSlot(pool, firstPart);
  if (plan.parts.length === 1) {
    target.blocks[firstReporterId] = makeNamedListItemReporter(ownerId, pool.listName, pool.listId, firstSlot);
    owner.inputs[inputName] = [3, firstReporterId, ownerFallback];
    return;
  }
  const secondPart = requireItem(plan.parts, 1, 'string pool plan');
  const joinId = factory.block(`string-pool-${ownerId}-${inputName}-join`);
  const secondReporterId = factory.block(`string-pool-${ownerId}-${inputName}-1`);
  const secondSlot = reserveStringPoolSlot(pool, secondPart);
  target.blocks[joinId] = {
    opcode: 'operator_join',
    next: null,
    parent: ownerId,
    inputs: {
      STRING1: [3, firstReporterId, [10, '']],
      STRING2: [3, secondReporterId, [10, '']]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[firstReporterId] = makeNamedListItemReporter(joinId, pool.listName, pool.listId, firstSlot);
  target.blocks[secondReporterId] = makeNamedListItemReporter(joinId, pool.listName, pool.listId, secondSlot);
  owner.inputs[inputName] = [3, joinId, ownerFallback];
}

function encodeNumericLiteral(
  project: ScratchProject,
  site: NumericLiteralSite,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  poisonRng: DeterministicGenerator
): void {
  const target = requireTarget(project, site.targetIndex);
  const owner = requireBlock(target, site.ownerId);
  const input = owner.inputs[site.inputName];
  const active = input?.[1];
  if (
    !input
    || !Array.isArray(active)
    || active[0] !== site.primitiveCode
    || active[1] !== site.value
  ) return;
  const numericValue = Number(site.value);
  const equation = exactNumericEquation(numericValue, rng);
  const equationId = factory.block(`numeric-equation-${site.targetIndex}-${site.ownerId}-${site.inputName}`);
  target.blocks[equationId] = {
    opcode: 'operator_multiply',
    next: null,
    parent: site.ownerId,
    inputs: {NUM1: numericInputString(equation.left), NUM2: numericInputString(equation.right)},
    fields: {},
    shadow: false,
    topLevel: false
  };
  owner.inputs[site.inputName] = [
    3,
    equationId,
    poisonPrimitive([site.primitiveCode, site.value], poisonRng)
  ];
}

function exactNumericEquation(value: number, rng: DeterministicGenerator): {readonly left: string; readonly right: string} {
  if (value === 0) {
    const left = Object.is(value, -0) ? -Number.MIN_VALUE : Number.MIN_VALUE;
    if (!Object.is(left * 0.5, value)) throw new Error('signed-zero equation failed its exact-domain check');
    return {left: canonicalNumber(left), right: canonicalNumber(0.5)};
  }
  const exponents = rng.shuffle([-32, -16, -8, -4, -2, -1, 1, 2, 4, 8, 16, 32]);
  const sign = rng.integer(2) === 0 ? 1 : -1;
  for (const exponent of exponents) {
    const factor = sign * (2 ** exponent);
    const quotient = value / factor;
    if (!Number.isFinite(quotient) || !Object.is(quotient * factor, value)) continue;
    return {left: canonicalNumber(quotient), right: canonicalNumber(factor)};
  }
  if (!Object.is(value * 1, value)) throw new Error('numeric equation failed its exact-domain check');
  return {left: canonicalNumber(value), right: canonicalNumber(1)};
}

function canonicalNumber(value: number): string {
  return Object.is(value, -0) ? '-0' : value.toExponential(17);
}

function collectConditionSites(project: ScratchProject): ConditionSite[] {
  const sites: ConditionSite[] = [];
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
    for (const [blockId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value) || (value.opcode !== 'control_if' && value.opcode !== 'control_if_else')) continue;
      sites.push({
        targetIndex,
        blockId,
        growth: value.inputs['CONDITION'] === undefined ? 2 : 1
      });
    }
  }
  return sites;
}

function invertCondition(
  project: ScratchProject,
  site: ConditionSite,
  factory: UniqueFactory,
  domain: string
): void {
  const target = requireTarget(project, site.targetIndex);
  const block = requireBlock(target, site.blockId);
  const originalCondition = block.inputs['CONDITION'] ?? textInput('');
  const notId = factory.block(`condition-not-${domain}`);
  reparentInputReferences(target, originalCondition, notId);
  target.blocks[notId] = {
    opcode: 'operator_not',
    next: null,
    parent: site.blockId,
    inputs: {OPERAND: originalCondition},
    fields: {},
    shadow: false,
    topLevel: false
  };
  block.inputs['CONDITION'] = [2, notId];
  if (block.opcode === 'control_if') {
    const originalBranch = block.inputs['SUBSTACK'] ?? [2, null];
    block.opcode = 'control_if_else';
    block.inputs['SUBSTACK'] = [2, null];
    block.inputs['SUBSTACK2'] = originalBranch;
  } else {
    const firstBranch = block.inputs['SUBSTACK'] ?? [2, null];
    const secondBranch = block.inputs['SUBSTACK2'] ?? [2, null];
    block.inputs['SUBSTACK'] = secondBranch;
    block.inputs['SUBSTACK2'] = firstBranch;
  }
}

function collectInsertionEdges(project: ScratchProject): InsertionEdge[] {
  const edges: InsertionEdge[] = [];
  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
    for (const [topId, topValue] of Object.entries(target.blocks)) {
      if (!isScratchBlock(topValue) || !topValue.topLevel || topValue.opcode === 'procedures_definition') continue;
      const visited = new Set<string>();
      let currentId: string | null = topId;
      while (currentId !== null && !visited.has(currentId)) {
        visited.add(currentId);
        const block = blockAt(target, currentId);
        if (!block) break;
        const successorId = block.next;
        if (successorId && (isVirtualizableStackBlock(block) || isHatOpcode(block.opcode))) {
          edges.push({targetIndex, predecessorId: currentId, successorId});
        }
        currentId = successorId;
      }
    }
  }
  return edges;
}

function isHatOpcode(opcode: string): boolean {
  return opcode.startsWith('event_when') || opcode === 'control_start_as_clone';
}

function insertDualRail(
  target: ScratchTarget,
  edge: InsertionEdge,
  state: PrivateState,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string
): void {
  const predecessor = requireBlock(target, edge.predecessorId);
  const successor = requireBlock(target, edge.successorId);
  const railId = factory.block(`${domain}-branch`);
  const equalsId = factory.block(`${domain}-equals`);
  const reporterId = factory.block(`${domain}-variable`);
  const firstRailId = factory.block(`${domain}-first`);
  const secondRailId = factory.block(`${domain}-second`);
  const firstRailIsLive = rng.integer(2) === 0;
  target.blocks[railId] = {
    opcode: 'control_if_else',
    next: edge.successorId,
    parent: edge.predecessorId,
    inputs: {
      CONDITION: [2, equalsId],
      SUBSTACK: [2, firstRailId],
      SUBSTACK2: [2, secondRailId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[equalsId] = makeOpaqueEquality(
    railId,
    reporterId,
    state,
    firstRailIsLive ? state.token : state.mismatch
  );
  target.blocks[reporterId] = makeVariableReporter(equalsId, state);
  target.blocks[firstRailId] = {
    opcode: 'data_setvariableto',
    next: null,
    parent: railId,
    inputs: {VALUE: textInput(state.token)},
    fields: {VARIABLE: [state.variableName, state.variableId]},
    shadow: false,
    topLevel: false
  };
  target.blocks[secondRailId] = {
    opcode: 'data_addtolist',
    next: null,
    parent: railId,
    inputs: {ITEM: textInput(`r_${rng.id('d_', 10)}`)},
    fields: {LIST: [state.listName, state.listId]},
    shadow: false,
    topLevel: false
  };
  predecessor.next = railId;
  successor.parent = railId;
}

function insertOpaqueGuard(
  target: ScratchTarget,
  edge: InsertionEdge,
  state: PrivateState,
  factory: UniqueFactory,
  domain: string
): GuardSite {
  const predecessor = requireBlock(target, edge.predecessorId);
  const successor = requireBlock(target, edge.successorId);
  const guardId = factory.block(`guard-${domain}`);
  const equalsId = factory.block(`guard-equals-${domain}`);
  const reporterId = factory.block(`guard-variable-${domain}`);
  target.blocks[guardId] = makeGuard(edge.predecessorId, edge.successorId, equalsId);
  target.blocks[equalsId] = makeFalseEquality(guardId, reporterId, state);
  target.blocks[reporterId] = makeVariableReporter(equalsId, state);
  predecessor.next = guardId;
  successor.parent = guardId;
  return {targetIndex: edge.targetIndex, guardId, tailId: null, chainDepth: 1, growth: 5};
}

function createTopLevelGuard(
  target: ScratchTarget,
  targetIndex: number,
  state: PrivateState,
  factory: UniqueFactory,
  domain: string
): GuardSite {
  const guardId = factory.block(`guard-${domain}`);
  const equalsId = factory.block(`guard-equals-${domain}`);
  const reporterId = factory.block(`guard-variable-${domain}`);
  target.blocks[guardId] = makeGuard(null, null, equalsId, true);
  target.blocks[equalsId] = makeFalseEquality(guardId, reporterId, state);
  target.blocks[reporterId] = makeVariableReporter(equalsId, state);
  return {targetIndex, guardId, tailId: null, chainDepth: 1, growth: 5};
}

function makeGuard(parent: string | null, next: string | null, equalsId: string, topLevel = false): ScratchBlock {
  return {
    opcode: 'control_if',
    next,
    parent,
    inputs: {CONDITION: [2, equalsId], SUBSTACK: [2, null]},
    fields: {},
    shadow: false,
    topLevel,
    ...(topLevel ? {x: 0, y: 0} : {})
  };
}

function makeFalseEquality(parentId: string, reporterId: string, state: PrivateState): ScratchBlock {
  return makeOpaqueEquality(parentId, reporterId, state, state.mismatch);
}

function makeOpaqueEquality(
  parentId: string,
  reporterId: string,
  state: PrivateState,
  expected: string
): ScratchBlock {
  return {
    opcode: 'operator_equals',
    next: null,
    parent: parentId,
    inputs: {
      OPERAND1: [3, reporterId, [10, '']],
      OPERAND2: textInput(expected)
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
}

function makeVariableReporter(
  parentId: string,
  state: Pick<PrivateState, 'variableId' | 'variableName'>
): ScratchBlock {
  return {
    opcode: 'data_variable',
    next: null,
    parent: parentId,
    inputs: {},
    fields: {VARIABLE: [state.variableName, state.variableId]},
    shadow: false,
    topLevel: false
  };
}

function collectDecoyVocabulary(project: ScratchProject): DecoyVocabulary {
  const costByOpcode = new Map<DecoyOpcode, 1 | 2 | 3>([
    ['data_deletealloflist', 1],
    ['data_addtolist', 2],
    ['data_changevariableby', 2],
    ['data_deleteoflist', 2],
    ['data_setvariableto', 2],
    ['data_insertatlist', 3],
    ['data_replaceitemoflist', 3]
  ]);
  const present = new Set<DecoyOpcode>();
  for (const target of project.targets) {
    for (const value of Object.values(target.blocks)) {
      if (!isScratchBlock(value) || !costByOpcode.has(value.opcode as DecoyOpcode)) continue;
      present.add(value.opcode as DecoyOpcode);
    }
  }
  const byCost: Record<1 | 2 | 3, DecoyOpcode[]> = {1: [], 2: [], 3: []};
  for (const opcode of [...present].sort()) {
    const cost = costByOpcode.get(opcode);
    if (cost) byCost[cost].push(opcode);
  }
  return {
    byCost: {
      1: byCost[1].length > 0 ? byCost[1] : ['data_deletealloflist'],
      2: byCost[2].length > 0 ? byCost[2] : ['data_addtolist', 'data_setvariableto'],
      3: byCost[3].length > 0 ? byCost[3] : ['data_replaceitemoflist']
    }
  };
}

function fillDecoyBudget(
  project: ScratchProject,
  mode: AggressiveMode,
  budget: GrowthBudget,
  maximumAdditionalGrowth: number,
  guards: GuardSite[],
  getState: (targetIndex: number) => PrivateState,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  vocabulary: DecoyVocabulary,
  stats: ObfuscationStats
): void {
  const maximumDepth = mode === 'lossy' ? 32 : 128;
  const maximumSiteGrowth = mode === 'lossy' ? 64 : 256;
  const sites = [...guards];
  let siteCursor = 0;
  let decoyOrdinal = 0;
  let remainingGrowth = maximumAdditionalGrowth;

  while (budget.remaining > 0 && remainingGrowth > 0 && project.targets.length > 0) {
    let site = sites.length === 0 ? undefined : sites[siteCursor % sites.length];
    if (!site || site.chainDepth >= maximumDepth || site.growth >= maximumSiteGrowth) {
      const targetIndex = rng.fork(`decoy-target-${sites.length}`).integer(project.targets.length);
      const target = requireTarget(project, targetIndex);
      const rootId = factory.block(`decoy-root-${sites.length}`);
      const state = getState(targetIndex);
      target.blocks[rootId] = makeDecoyBlock(
        state,
        1,
        null,
        null,
        true,
        decoyOrdinal,
        vocabulary,
        rng.fork(`decoy-opcode-${decoyOrdinal}`)
      );
      budget.trySpend(1, 3);
      remainingGrowth -= 1;
      stats.decoysAdded += 1;
      decoyOrdinal += 1;
      site = {targetIndex, guardId: rootId, tailId: rootId, chainDepth: 1, growth: 1};
      sites.push(site);
      siteCursor += 1;
      continue;
    }

    const target = requireTarget(project, site.targetIndex);
    const state = getState(site.targetIndex);
    const maxCost = Math.min(3, budget.remaining, remainingGrowth, maximumSiteGrowth - site.growth);
    const cost = chooseDecoyCost(rng.fork(`decoy-cost-${decoyOrdinal}`), maxCost);
    budget.trySpend(cost, 3);
    remainingGrowth -= cost;
    const id = factory.block(`decoy-${site.targetIndex}-${decoyOrdinal}`);
    const parentId = site.tailId ?? site.guardId;
    target.blocks[id] = makeDecoyBlock(
      state,
      cost,
      parentId,
      null,
      false,
      decoyOrdinal,
      vocabulary,
      rng.fork(`decoy-opcode-${decoyOrdinal}`)
    );
    if (site.tailId) {
      requireBlock(target, site.tailId).next = id;
    } else {
      requireBlock(target, site.guardId).inputs['SUBSTACK'] = [2, id];
    }
    site.tailId = id;
    site.chainDepth += 1;
    site.growth += cost;
    stats.decoysAdded += 1;
    decoyOrdinal += 1;
    siteCursor += 1;
  }
}

function chooseDecoyCost(rng: DeterministicGenerator, maximum: number): 1 | 2 | 3 {
  if (maximum <= 1) return 1;
  return (1 + rng.integer(maximum)) as 1 | 2 | 3;
}

function makeDecoyBlock(
  state: PrivateState,
  cost: 1 | 2 | 3,
  parent: string | null,
  next: string | null,
  topLevel: boolean,
  ordinal: number,
  vocabulary: DecoyVocabulary,
  rng: DeterministicGenerator
): ScratchBlock {
  const opcode = requireItem(vocabulary.byCost[cost], rng.integer(vocabulary.byCost[cost].length), 'decoy vocabulary');
  if (opcode === 'data_deletealloflist') {
    return {
      opcode: 'data_deletealloflist',
      next,
      parent,
      inputs: {},
      fields: {LIST: [state.listName, state.listId]},
      shadow: false,
      topLevel,
      ...(topLevel ? {x: 0, y: 0} : {})
    };
  }
  if (opcode === 'data_setvariableto' || opcode === 'data_changevariableby') {
    return {
      opcode,
      next,
      parent,
      inputs: {VALUE: opcode === 'data_changevariableby' ? numericInput(ordinal + 1) : textInput(`d_${ordinal.toString(36)}`)},
      fields: {VARIABLE: [state.variableName, state.variableId]},
      shadow: false,
      topLevel,
      ...(topLevel ? {x: 0, y: 0} : {})
    };
  }
  if (opcode === 'data_addtolist') {
    return {
      opcode,
      next,
      parent,
      inputs: {ITEM: textInput(`d_${ordinal.toString(36)}`)},
      fields: {LIST: [state.listName, state.listId]},
      shadow: false,
      topLevel,
      ...(topLevel ? {x: 0, y: 0} : {})
    };
  }
  if (opcode === 'data_deleteoflist') {
    return {
      opcode,
      next,
      parent,
      inputs: {INDEX: numericInput(1)},
      fields: {LIST: [state.listName, state.listId]},
      shadow: false,
      topLevel,
      ...(topLevel ? {x: 0, y: 0} : {})
    };
  }
  return {
    opcode,
    next,
    parent,
    inputs: {INDEX: numericInput(1), ITEM: textInput(`d_${ordinal.toString(36)}`)},
    fields: {LIST: [state.listName, state.listId]},
    shadow: false,
    topLevel,
    ...(topLevel ? {x: 0, y: 0} : {})
  };
}

function numericInput(value: number): ScratchInput {
  return numericInputString(String(value));
}

function numericInputString(value: string): ScratchInput {
  return [1, [4, value]];
}

function textInput(value: string): ScratchInput {
  return [1, [10, value]];
}

function poisonPrimitive(primitive: ScratchInput, rng: DeterministicGenerator): ScratchInput {
  const code = primitive[0] as number;
  if (code >= 4 && code <= 8) return [code, `-${1_000_000 + rng.integer(999_000_000)}`];
  if (code === 9) return [9, `#${Buffer.from(rng.bytes(3)).toString('hex')}`];
  if (code === 10) return [10, `\u2063${rng.id('p_', 18)}`];
  return [...primitive];
}

function requireTarget(project: ScratchProject, index: number): ScratchTarget {
  const target = project.targets[index];
  if (!target) throw new Error(`validated project is missing target ${index}`);
  return target;
}

function requireBlock(target: ScratchTarget, id: string): ScratchBlock {
  const block = blockAt(target, id);
  if (!block) throw new Error(`validated project is missing block ${JSON.stringify(id)}`);
  return block;
}

function requireItem<T>(values: readonly T[], index: number, description: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`${description} is incomplete`);
  return value;
}
