import {isPrimitive, isScratchBlock} from '../model/blocks.js';
import type {DeterministicGenerator} from '../deterministic.js';
import type {
  JsonValue,
  ObfuscationMode,
  ObfuscationStats,
  ScratchBlock,
  ScratchInput,
  ScratchProject,
  ScratchTarget
} from '../types.js';
import {
  blockAt,
  certifyRegionsEffects,
  collectCertifiedNestedLinearRuns,
  collectNumericLiteralSites,
  collectStringLiteralSites,
  collectVariableCandidates,
  countBlockEquivalents,
  countObjectBlocks,
  hardenInactiveShadows,
  isVirtualizableStackBlock,
  type LinearRunEntryConnector,
  type LinearRun,
  type NumericLiteralSite,
  type RegionEffectRequest,
  type StringLiteralSite,
  type VariableCandidate
} from './analysis.js';

export type AggressiveMode = Extract<ObfuscationMode, 'lossy' | 'no-preserve'>;
type ConnectableLinearRun = LinearRun & {readonly connector?: LinearRunEntryConnector};

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

interface FixedListUsage {
  readonly targetIndex: number;
  readonly blockId: string;
  readonly originalIndex: number | null;
}

interface FixedListCandidate {
  readonly targetIndex: number;
  readonly id: string;
  readonly name: string;
  readonly values: readonly JsonValue[];
  readonly usages: readonly FixedListUsage[];
}

interface MutableFixedListCandidate {
  readonly targetIndex: number;
  readonly id: string;
  readonly name: string;
  readonly values: readonly JsonValue[];
  readonly usages: FixedListUsage[];
  safe: boolean;
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

interface IndexedStore {
  readonly values: Array<string | number>;
  readonly modulus: number;
}

interface DispatcherHandler {
  readonly originalId: string;
  readonly changeKeyId: string;
  readonly keyDeltaReporterId: string;
  readonly keyDeltaIndexId: string;
  readonly setStateId: string;
  readonly transitionReporterId: string;
  readonly transitionIndexId: string;
  readonly setTagId: string;
  readonly tagReporterId: string;
  readonly tagIndexId: string;
  readonly dispatchCallId: string | null;
  readonly stateCode: number;
  readonly tagCode: number;
  readonly tagFirst: boolean;
}

interface DispatcherHandlerBucket {
  readonly definitionId: string;
  readonly prototypeId: string;
  readonly proccode: string;
  readonly handlers: readonly DispatcherHandler[];
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

interface FakeBroadcast {
  readonly id: string;
  readonly name: string;
}

type LiveReporterOpcode = 'sensing_answer' | 'sensing_mousex' | 'sensing_mousey' | 'sensing_timer';
type LiveExpressionTemplate = 'direct' | 'length' | 'letter' | 'mod';
type LiveConditionOpcode = 'operator_contains' | 'operator_equals' | 'operator_gt' | 'operator_lt';

interface LiveGuardPlan {
  readonly reporterOpcode: LiveReporterOpcode;
  readonly expression: LiveExpressionTemplate;
  readonly conditionOpcode: LiveConditionOpcode;
  readonly growth: 8 | 10 | 11;
}

interface LocalGrowth {
  readonly equivalents: number;
  readonly objects: number;
}

const COHERENT_DECOY_GROWTH = 38;
const MAX_COHERENT_EXTRA_GROWTH = 18;
const ENCODED_OPAQUE_GUARD_GROWTH = 6;
const ENCODED_DUAL_RAIL_GROWTH = 10;

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
      ...Object.values(target.lists).map(tuple => tuple[0]).filter((value): value is string => typeof value === 'string'),
      ...Object.values(target.broadcasts)
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

  symbol(prefix: 'v_' | 'l_' | 'c_', domain: string): string {
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
        : rng.id('x_', 28);
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
  const originalListCandidates = collectFixedListCandidates(project);
  const stringPools = new Map<number, StringPoolState>();
  const privateStates = new Map<number, PrivateState>();
  const decoyStates = new Map<number, PrivateState>();
  const getState = (targetIndex: number): PrivateState => {
    const present = privateStates.get(targetIndex);
    if (present) return present;
    const target = requireTarget(project, targetIndex);
    const state = createPrivateState(target, targetIndex, mode, factory, rng.fork(`state-${targetIndex}`), 'live');
    privateStates.set(targetIndex, state);
    return state;
  };
  const getDecoyState = (targetIndex: number): PrivateState => {
    const present = decoyStates.get(targetIndex);
    if (present) return present;
    const target = requireTarget(project, targetIndex);
    const state = mode === 'no-preserve'
      ? createPrivateState(target, targetIndex, mode, factory, rng.fork(`decoy-state-${targetIndex}`), 'decoy')
      : createPrivateVariableState(
          target,
          targetIndex,
          mode,
          factory,
          rng.fork(`decoy-state-${targetIndex}`),
          'decoy',
          getState(targetIndex)
        );
    decoyStates.set(targetIndex, state);
    return state;
  };

  const poisonRng = rng.fork('inactive-shadows');
  hardenInactiveShadows(project, primitive => poisonPrimitive(primitive, poisonRng));
  const originalVariableCandidates = collectVariableCandidates(project);
  const originalNumericSites = collectNumericLiteralSites(project);
  const originalStringSites = collectStringLiteralSites(project);
  const originalConditionSites = collectConditionSites(project);
  const eligibleVariableCandidates = mode === 'lossy'
    ? filterCertifiedVariableCandidates(project, originalVariableCandidates)
    : originalVariableCandidates;
  const eligibleNumericSites = mode === 'lossy'
    ? filterCertifiedInputSites(project, originalNumericSites)
    : originalNumericSites;
  const eligibleStringSites = mode === 'lossy'
    ? filterCertifiedInputSites(project, originalStringSites)
    : originalStringSites;
  const eligibleConditionSites = filterCertifiedConditionSites(project, originalConditionSites, mode);
  const certifiedRuns = collectCertifiedNestedLinearRuns(project, mode, {
    includeProcedureBodies: mode === 'no-preserve'
  }).filter(candidate => candidate.certificate.eligible);

  if (mode === 'lossy') {
    const runs = rng.fork('outline-order').shuffle(certifiedRuns.map(candidate => candidate.run));
    for (const run of runs) {
      if (!budget.trySpend(3, 0)) continue;
      outlineRun(project, run, factory);
    }
  }

  if (mode === 'no-preserve') {
    const runs = rng.fork('run-order').shuffle(
      certifiedRuns.flatMap(candidate => boundDispatcherRuns(project, candidate.run))
    );
    for (const [index, run] of runs.entries()) {
      const growth = estimateDispatcherGrowth(run.blockIds.length);
      if (!budget.trySpend(growth, 0)) continue;
      fragmentRun(project, run, getDecoyState(run.targetIndex), factory, rng.fork(`run-${index}`));
      stats.virtualizedBlocks += run.blockIds.length;
    }
  }

  if (originalListCandidates.length > 0) {
    const packed = packFixedLists(
      project,
      rng.fork('fixed-list-order').shuffle(originalListCandidates),
      getState,
      rng.fork('fixed-list-heap')
    );
    stats.listsVirtualized = (stats.listsVirtualized ?? 0) + packed;
  }

  if (eligibleVariableCandidates.length > 0) {
    const variables = rng.fork('variable-order').shuffle(eligibleVariableCandidates);
    const selected: SelectedVariable[] = [];
    for (const [index, candidate] of variables.entries()) {
      if (candidate.estimatedGrowth > (mode === 'lossy' ? 64 : 256)) continue;
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
      stats.variablesVirtualized = (stats.variablesVirtualized ?? 0) + 1;
    }
  }

  const numericSites = rng.fork('numeric-order').shuffle(eligibleNumericSites);
  for (const [index, site] of numericSites.entries()) {
    if (!budget.trySpend(site.growth, 1)) continue;
    encodeNumericLiteral(project, site, factory, rng.fork(`numeric-${index}`), poisonRng);
  }

  const stringSites = rng.fork('literal-order').shuffle(eligibleStringSites);
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

  for (const [index, site] of rng.fork('condition-order').shuffle(eligibleConditionSites).entries()) {
    if (!budget.trySpend(site.growth, 2)) continue;
    invertCondition(project, site, factory, `condition-${index}`);
  }


  const dualRailCandidates = collectInsertionEdges(project);
  const dualRailEdges = mode === 'no-preserve'
    ? dualRailCandidates
    : filterCertifiedEdges(project, dualRailCandidates, mode);
  for (const [index, edge] of rng.fork('dual-rail-order').shuffle(dualRailEdges).entries()) {
    const target = requireTarget(project, edge.targetIndex);
    const predecessor = blockAt(target, edge.predecessorId);
    if (!predecessor || predecessor.next !== edge.successorId || !blockAt(target, edge.successorId)) continue;
    if (!budget.trySpend(ENCODED_DUAL_RAIL_GROWTH, 2)) continue;
    insertDualRail(
      target,
      edge,
      getDecoyState(edge.targetIndex),
      factory,
      rng.fork(`dual-rail-${index}`),
      `dual-rail-${index}`
    );
  }

  const guards: GuardSite[] = [];
  const guardCandidates = mode === 'no-preserve'
    ? collectTopLevelSequentialEdges(project)
    : collectInsertionEdges(project);
  const guardEdges = mode === 'no-preserve'
    ? guardCandidates
    : filterCertifiedEdges(project, guardCandidates, mode);
  const edges = rng.fork('guard-order').shuffle(guardEdges);
  for (const [index, edge] of edges.entries()) {
    const target = requireTarget(project, edge.targetIndex);
    const predecessor = blockAt(target, edge.predecessorId);
    if (!predecessor || predecessor.next !== edge.successorId || !blockAt(target, edge.successorId)) continue;
    const livePlan = mode === 'no-preserve'
      ? makeLiveGuardPlan(rng.fork(`guard-live-plan-${index}`))
      : undefined;
    const growth = livePlan?.growth ?? ENCODED_OPAQUE_GUARD_GROWTH;
    if (!budget.trySpend(growth, 2)) continue;
    const state = getDecoyState(edge.targetIndex);
    const guard = livePlan
      ? insertLiveRailGuard(target, edge, state, factory, `edge-${index}`, livePlan)
      : insertOpaqueGuard(target, edge, state, factory, `edge-${index}`);
    guards.push(guard);
  }

  const fallbackLivePlan = mode === 'no-preserve'
    ? makeLiveGuardPlan(rng.fork('fallback-live-plan'))
    : undefined;
  const fallbackGuardGrowth = fallbackLivePlan
    ? fallbackLivePlan.growth + 1
    : ENCODED_OPAQUE_GUARD_GROWTH;
  if (guards.length === 0 && budget.trySpend(fallbackGuardGrowth, 2)) {
    const targetIndex = rng.fork('guard-target').integer(project.targets.length);
    const target = requireTarget(project, targetIndex);
    const state = getDecoyState(targetIndex);
    guards.push(fallbackLivePlan
      ? createLiveRailDriver(target, targetIndex, state, factory, 'top-level', fallbackLivePlan)
      : createTopLevelGuard(target, targetIndex, state, factory, 'top-level'));
  }

  addCoherentDecoySubsystems(
    project,
    mode,
    budget,
    Math.max(0, cap - countBlockEquivalents(project)),
    guards,
    getDecoyState,
    factory,
    rng.fork('coherent-decoys'),
    decoyVocabulary,
    stats
  );

  fillDecoyBudget(
    project,
    mode,
    budget,
    Math.max(0, cap - countBlockEquivalents(project)),
    guards,
    getDecoyState,
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

function filterCertifiedVariableCandidates(
  project: ScratchProject,
  candidates: readonly VariableCandidate[]
): VariableCandidate[] {
  const indexedRequests: Array<{readonly candidateIndex: number; readonly request: RegionEffectRequest}> = [];
  for (const [candidateIndex, candidate] of candidates.entries()) {
    for (const usage of candidate.usages) {
      indexedRequests.push({
        candidateIndex,
        request: evaluationRegionRequest(project, usage.targetIndex, usage.blockId)
      });
    }
  }
  const certificates = certifyRegionsEffects(
    project,
    indexedRequests.map(item => item.request),
    'lossy'
  );
  const rejected = new Set<number>();
  for (const [index, certificate] of certificates.entries()) {
    if (!certificate?.eligible) {
      const candidateIndex = indexedRequests[index]?.candidateIndex;
      if (candidateIndex !== undefined) rejected.add(candidateIndex);
    }
  }
  return candidates.filter((_, index) => !rejected.has(index));
}

function filterCertifiedInputSites<T extends NumericLiteralSite | StringLiteralSite>(
  project: ScratchProject,
  sites: readonly T[]
): T[] {
  const requests = sites.map(site => evaluationRegionRequest(project, site.targetIndex, site.ownerId));
  const certificates = certifyRegionsEffects(project, requests, 'lossy');
  return sites.filter((_, index) => certificates[index]?.eligible === true);
}

function filterCertifiedConditionSites(
  project: ScratchProject,
  sites: readonly ConditionSite[],
  mode: AggressiveMode
): ConditionSite[] {
  const requests: RegionEffectRequest[] = sites.map(site => ({
    targetIndex: site.targetIndex,
    blockIds: [site.blockId]
  }));
  const certificates = certifyRegionsEffects(project, requests, mode);
  return sites.filter((_, index) => certificates[index]?.eligible === true);
}

function filterCertifiedEdges(
  project: ScratchProject,
  edges: readonly InsertionEdge[],
  mode: AggressiveMode
): InsertionEdge[] {
  const requests: RegionEffectRequest[] = edges.map(edge => ({
    targetIndex: edge.targetIndex,
    blockIds: [edge.predecessorId, edge.successorId]
  }));
  const certificates = certifyRegionsEffects(project, requests, mode);
  return edges.filter((_, index) => certificates[index]?.eligible === true);
}

function evaluationRegionRequest(
  project: ScratchProject,
  targetIndex: number,
  ownerId: string
): RegionEffectRequest {
  const target = requireTarget(project, targetIndex);
  let currentId = ownerId;
  const visited = new Set<string>();
  while (!visited.has(currentId)) {
    visited.add(currentId);
    const current = blockAt(target, currentId);
    if (!current || current.parent === null) break;
    const parent = blockAt(target, current.parent);
    if (!parent || parent.next === currentId) break;
    const containingInput = Object.entries(parent.inputs).find(([, input]) => input[1] === currentId);
    if (!containingInput || containingInput[0] === 'SUBSTACK' || containingInput[0] === 'SUBSTACK2') break;
    currentId = current.parent;
  }
  return {targetIndex, blockIds: [currentId]};
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
  return `\ue000${ordinal.toString(36)}_${rng.id('x_', 18)}`;
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
  rng: DeterministicGenerator,
  domain: string
): PrivateState {
  const variableId = factory.symbol('v_', `${domain}-state-${targetIndex}`);
  const listId = factory.symbol('l_', `${domain}-store-${targetIndex}`);
  const variableName = factory.name(mode, `${domain}-state-${targetIndex}`);
  const listName = factory.name(mode, `${domain}-store-${targetIndex}`);
  const token = `q_${rng.id('t_', 18)}`;
  const mismatch = `z_${rng.id('u_', 18)}`;
  target.variables[variableId] = [variableName, token];
  target.lists[listId] = [listName, [`j_${rng.id('d_', 12)}`, rng.integer(1_000_000)]];
  return {variableId, variableName, listId, listName, token, mismatch};
}

function createPrivateVariableState(
  target: ScratchTarget,
  targetIndex: number,
  mode: AggressiveMode,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string,
  store: Pick<PrivateState, 'listId' | 'listName'>
): PrivateState {
  const variableId = factory.symbol('v_', `${domain}-state-${targetIndex}`);
  const variableName = factory.name(mode, `${domain}-state-${targetIndex}`);
  const token = `q_${rng.id('t_', 18)}`;
  const mismatch = `z_${rng.id('u_', 18)}`;
  target.variables[variableId] = [variableName, token];
  return {...store, variableId, variableName, token, mismatch};
}

function collectFixedListCandidates(project: ScratchProject): FixedListCandidate[] {
  const stageIndex = project.targets.findIndex(target => target.isStage);
  const mutable: MutableFixedListCandidate[] = [];
  const byTarget = project.targets.map(() => new Map<string, MutableFixedListCandidate>());

  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [id, declaration] of Object.entries(target.lists)) {
      const name = declaration[0];
      const values = declaration[1];
      if (typeof name !== 'string' || !Array.isArray(values)) continue;
      const candidate: MutableFixedListCandidate = {
        targetIndex,
        id,
        name,
        values,
        usages: [],
        safe: !isMonitoredList(project, id)
      };
      mutable.push(candidate);
      byTarget[targetIndex]?.set(id, candidate);
    }
  }

  const resolve = (
    usageTargetIndex: number,
    id: unknown,
    name: unknown
  ): MutableFixedListCandidate[] => {
    if (typeof id === 'string' && id.length > 0) {
      const local = byTarget[usageTargetIndex]?.get(id);
      if (local) return [local];
      const global = stageIndex < 0 ? undefined : byTarget[stageIndex]?.get(id);
      return global ? [global] : [];
    }
    if (typeof name !== 'string') return [];
    const possible = mutable.filter(candidate => (
      candidate.name === name
      && (candidate.targetIndex === usageTargetIndex || candidate.targetIndex === stageIndex)
    ));
    return possible;
  };

  const rejectPrimitiveReference = (usageTargetIndex: number, value: unknown): void => {
    if (!isPrimitive(value) || value[0] !== 13) return;
    for (const candidate of resolve(usageTargetIndex, value[2], value[1])) candidate.safe = false;
  };

  for (const [usageTargetIndex, target] of project.targets.entries()) {
    for (const [blockId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value)) {
        rejectPrimitiveReference(usageTargetIndex, value);
        continue;
      }
      for (const input of Object.values(value.inputs)) {
        rejectPrimitiveReference(usageTargetIndex, input[1]);
        rejectPrimitiveReference(usageTargetIndex, input[2]);
      }

      const field = value.fields['LIST'];
      if (!field) continue;
      const possible = resolve(usageTargetIndex, field[1], field[0]);
      if (possible.length !== 1) {
        for (const candidate of possible) candidate.safe = false;
        continue;
      }
      const candidate = requireItem(possible, 0, 'fixed list candidate');
      if (!hasExactFixedListBlockShape(value)) {
        candidate.safe = false;
        continue;
      }
      const index = staticListIndex(value.inputs['INDEX'], candidate.values.length);
      if (index === undefined) {
        candidate.safe = false;
        continue;
      }
      candidate.usages.push({targetIndex: usageTargetIndex, blockId, originalIndex: index});
    }
  }

  return mutable.flatMap(candidate => candidate.safe && candidate.usages.length > 0 ? [{
    targetIndex: candidate.targetIndex,
    id: candidate.id,
    name: candidate.name,
    values: candidate.values,
    usages: candidate.usages
  }] : []);
}

function isMonitoredList(project: ScratchProject, id: string): boolean {
  for (const monitor of project.monitors) {
    if (monitor['opcode'] !== 'data_listcontents' && monitor['mode'] !== 'list') continue;
    if (monitor['id'] === id) return true;
    const params = monitor['params'];
    if (params && typeof params === 'object' && !Array.isArray(params) && params['LIST'] === id) return true;
  }
  return false;
}

function hasExactFixedListBlockShape(block: ScratchBlock): boolean {
  if (block.shadow || Object.keys(block.fields).length !== 1 || block.fields['LIST'] === undefined) return false;
  const inputs = Object.keys(block.inputs).sort();
  if (block.opcode === 'data_itemoflist') {
    return block.next === null && inputs.length === 1 && inputs[0] === 'INDEX';
  }
  return block.opcode === 'data_replaceitemoflist'
    && inputs.length === 2
    && inputs[0] === 'INDEX'
    && inputs[1] === 'ITEM';
}

/** Match the official Cast.toListIndex behavior without consuming its random source. */
function staticListIndex(input: ScratchInput | undefined, length: number): number | null | undefined {
  const active = input?.[1];
  if (!isPrimitive(active)) return undefined;
  const primitiveCode = active[0];
  if (typeof primitiveCode !== 'number' || ![4, 5, 6, 7, 8, 10].includes(primitiveCode)) return undefined;
  const raw = active[1];
  if (raw === 'random' || raw === 'any') return undefined;
  if (raw === 'last') return length > 0 ? length : null;
  if (raw === 'all') return null;
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean' && raw !== null) {
    return undefined;
  }
  const numeric = Number(raw);
  if (Number.isNaN(numeric)) return null;
  const index = Math.floor(numeric);
  return index >= 1 && index <= length ? index : null;
}

function packFixedLists(
  project: ScratchProject,
  candidates: readonly FixedListCandidate[],
  getState: (targetIndex: number) => PrivateState,
  rng: DeterministicGenerator
): number {
  const byTarget = new Map<number, FixedListCandidate[]>();
  for (const candidate of candidates) {
    const list = byTarget.get(candidate.targetIndex) ?? [];
    list.push(candidate);
    byTarget.set(candidate.targetIndex, list);
  }

  let packed = 0;
  for (const [targetIndex, targetCandidates] of byTarget) {
    const target = requireTarget(project, targetIndex);
    const state = getState(targetIndex);
    const declaration = target.lists[state.listId];
    const heap = declaration?.[1];
    if (!Array.isArray(heap)) throw new Error('private list heap has an invalid declaration');

    const records = targetCandidates.flatMap(candidate => candidate.values.map((value, offset) => ({
      key: `${candidate.id}\u0000${offset + 1}`,
      value
    })));
    const junkCount = Math.min(4096, Math.max(targetCandidates.length, Math.ceil(records.length / 3)));
    const junk = Array.from({length: junkCount}, (_, index) => ({
      key: null,
      value: makeFixedListJunk(rng.fork(`target-${targetIndex}-junk-${index}`), index)
    }));
    const slots = new Map<string, number>();
    for (const record of rng.fork(`target-${targetIndex}-layout`).shuffle([...records, ...junk])) {
      heap.push(record.value);
      if (record.key !== null) slots.set(record.key, heap.length);
    }

    for (const candidate of targetCandidates) {
      for (const usage of candidate.usages) {
        const usageTarget = requireTarget(project, usage.targetIndex);
        const block = requireBlock(usageTarget, usage.blockId);
        const slot = usage.originalIndex === null
          ? 0
          : slots.get(`${candidate.id}\u0000${usage.originalIndex}`);
        if (slot === undefined) throw new Error('fixed list heap is missing an element slot');
        block.fields = {LIST: [state.listName, state.listId]};
        block.inputs['INDEX'] = numericInput(slot);
      }
      delete target.lists[candidate.id];
      packed += 1;
    }
  }
  return packed;
}

function makeFixedListJunk(rng: DeterministicGenerator, ordinal: number): string | number {
  return ordinal % 2 === 0 ? `j_${rng.id('h_', 16)}` : rng.integer(0x4000_0000);
}

function fragmentRun(
  project: ScratchProject,
  run: ConnectableLinearRun,
  railState: PrivateState,
  factory: UniqueFactory,
  rng: DeterministicGenerator
): void {
  const target = requireTarget(project, run.targetIndex);
  const firstId = requireItem(run.blockIds, 0, 'dispatcher run');

  const existingCodes = collectProcedureCodes(target);
  const stateId = factory.symbol('v_', `dispatcher-state-${run.targetIndex}-${firstId}`);
  const stateName = factory.name('no-preserve', `dispatcher-state-${run.targetIndex}-${firstId}`);
  const tagId = factory.symbol('v_', `dispatcher-tag-${run.targetIndex}-${firstId}`);
  const tagName = factory.name('no-preserve', `dispatcher-tag-${run.targetIndex}-${firstId}`);
  const keyId = factory.symbol('v_', `dispatcher-key-${run.targetIndex}-${firstId}`);
  const keyName = factory.name('no-preserve', `dispatcher-key-${run.targetIndex}-${firstId}`);
  const transitionListId = factory.symbol('l_', `dispatcher-transitions-${run.targetIndex}-${firstId}`);
  const transitionListName = factory.name('no-preserve', `dispatcher-transitions-${run.targetIndex}-${firstId}`);
  const tagListId = factory.symbol('l_', `dispatcher-tags-${run.targetIndex}-${firstId}`);
  const tagListName = factory.name('no-preserve', `dispatcher-tags-${run.targetIndex}-${firstId}`);
  const keyListId = factory.symbol('l_', `dispatcher-keys-${run.targetIndex}-${firstId}`);
  const keyListName = factory.name('no-preserve', `dispatcher-keys-${run.targetIndex}-${firstId}`);
  const stateCodes = uniqueDispatcherNumbers(run.blockIds.length + 2, rng.fork('state-codes'));
  const tagCodes = uniqueDispatcherTagNumbers(stateCodes, rng.fork('tag-codes'));
  const storeModuli = rng.fork('store-moduli').shuffle([17, 19, 23] as const);
  const stateModulus = requireItem(storeModuli, 0, 'dispatcher state modulus');
  const tagModulus = requireItem(storeModuli, 1, 'dispatcher tag modulus');
  const keyModulus = requireItem(storeModuli, 2, 'dispatcher key modulus');
  const keys = uniqueDispatcherKeys(
    run.blockIds.length + 2,
    [stateModulus, tagModulus, keyModulus],
    rng.fork('path-keys')
  );
  const stateCiphers = stateCodes.map((code, index) => code + requireItem(keys, index, 'dispatcher state key'));
  const tagCiphers = tagCodes.map((code, index) => code - requireItem(keys, index, 'dispatcher tag key'));
  const exitState = requireItem(stateCiphers, run.blockIds.length, 'dispatcher exit state');
  const exitTag = requireItem(tagCiphers, run.blockIds.length, 'dispatcher exit tag');
  const exitKey = requireItem(keys, run.blockIds.length, 'dispatcher exit key');
  const fakeStateCode = requireItem(stateCodes, run.blockIds.length + 1, 'dispatcher fake state');
  const fakeTagCode = requireItem(tagCodes, run.blockIds.length + 1, 'dispatcher fake tag');
  const stateStore = makeIndexedStore(
    keys.slice(0, run.blockIds.length + 1),
    stateCiphers.slice(0, run.blockIds.length + 1),
    stateModulus,
    rng.fork('state-store')
  );
  const tagStore = makeIndexedStore(
    keys.slice(0, run.blockIds.length + 1),
    tagCiphers.slice(0, run.blockIds.length + 1),
    tagModulus,
    rng.fork('tag-store')
  );
  const deltas = run.blockIds.map((_, index) => (
    requireItem(keys, index + 1, 'dispatcher next key') - requireItem(keys, index, 'dispatcher current key')
  ));
  const keyStore = makeIndexedStore(
    [exitKey, ...keys.slice(0, run.blockIds.length)],
    [requireItem(keys, 0, 'dispatcher entry key'), ...deltas],
    keyModulus,
    rng.fork('key-store')
  );
  target.variables[stateId] = [stateName, exitState];
  target.variables[tagId] = [tagName, exitTag];
  target.variables[keyId] = [keyName, exitKey];
  target.lists[transitionListId] = [transitionListName, stateStore.values];
  target.lists[tagListId] = [tagListName, tagStore.values];
  target.lists[keyListId] = [keyListName, keyStore.values];

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
  const fakeTagBodyId = factory.block(`fake-tag-body-${run.targetIndex}-${firstId}`);
  const fakeKeyBodyId = factory.block(`fake-key-body-${run.targetIndex}-${firstId}`);
  const handlers: DispatcherHandler[] = run.blockIds.map((originalId, index) => {
    const changeKeyId = factory.block(`handler-key-${run.targetIndex}-${originalId}`);
    const keyDeltaReporterId = factory.block(`handler-key-delta-${run.targetIndex}-${originalId}`);
    const keyDeltaIndexId = factory.block(`handler-key-index-${run.targetIndex}-${originalId}`);
    const setStateId = factory.block(`handler-state-${run.targetIndex}-${originalId}`);
    const transitionReporterId = factory.block(`handler-transition-${run.targetIndex}-${originalId}`);
    const transitionIndexId = factory.block(`handler-transition-index-${run.targetIndex}-${originalId}`);
    const setTagId = factory.block(`handler-tag-${run.targetIndex}-${originalId}`);
    const tagReporterId = factory.block(`handler-transition-tag-${run.targetIndex}-${originalId}`);
    const tagIndexId = factory.block(`handler-tag-index-${run.targetIndex}-${originalId}`);
    const dispatchCallId = index + 1 < run.blockIds.length
      ? factory.block(`handler-dispatch-${run.targetIndex}-${originalId}`)
      : null;
    return {
      originalId,
      changeKeyId,
      keyDeltaReporterId,
      keyDeltaIndexId,
      setStateId,
      transitionReporterId,
      transitionIndexId,
      setTagId,
      tagReporterId,
      tagIndexId,
      dispatchCallId,
      stateCode: requireItem(stateCodes, index, 'dispatcher state code'),
      tagCode: requireItem(tagCodes, index, 'dispatcher tag code'),
      tagFirst: rng.fork(`handler-rail-order-${index}`).integer(2) === 0
    };
  });
  const handlerBuckets = makeDispatcherHandlerBuckets(
    handlers,
    run.targetIndex,
    firstId,
    factory,
    rng.fork('handler-buckets'),
    allocateCode
  );
  const handlerCodeByOriginal = new Map<string, string>();
  for (const bucket of handlerBuckets) {
    for (const handler of bucket.handlers) handlerCodeByOriginal.set(handler.originalId, bucket.proccode);
  }
  const entryKeySetId = factory.block(`dispatcher-entry-key-${run.targetIndex}-${firstId}`);
  const entryKeyReporterId = factory.block(`dispatcher-entry-key-value-${run.targetIndex}-${firstId}`);
  const entryKeyIndexId = factory.block(`dispatcher-entry-key-index-${run.targetIndex}-${firstId}`);
  const entrySetId = factory.block(`dispatcher-entry-state-${run.targetIndex}-${firstId}`);
  const entryReporterId = factory.block(`dispatcher-entry-transition-${run.targetIndex}-${firstId}`);
  const entryIndexId = factory.block(`dispatcher-entry-transition-index-${run.targetIndex}-${firstId}`);
  const entryTagSetId = factory.block(`dispatcher-entry-tag-${run.targetIndex}-${firstId}`);
  const entryTagReporterId = factory.block(`dispatcher-entry-transition-tag-${run.targetIndex}-${firstId}`);
  const entryTagIndexId = factory.block(`dispatcher-entry-tag-index-${run.targetIndex}-${firstId}`);
  const entryCallId = factory.block(`dispatcher-entry-call-${run.targetIndex}-${firstId}`);
  const entryTagFirst = rng.fork('entry-rail-order').integer(2) === 0;

  for (const handler of handlers) {
    const original = requireBlock(target, handler.originalId);
    original.topLevel = false;
    delete original.x;
    delete original.y;
    original.next = handler.changeKeyId;
    const firstRailId = handler.tagFirst ? handler.setTagId : handler.setStateId;
    const secondRailId = handler.tagFirst ? handler.setStateId : handler.setTagId;
    target.blocks[handler.changeKeyId] = makeChangeStateFromListBlock(
      handler.originalId,
      firstRailId,
      keyName,
      keyId,
      handler.keyDeltaReporterId
    );
    addKeyIndexedListReporter(
      target,
      handler.keyDeltaReporterId,
      handler.keyDeltaIndexId,
      handler.changeKeyId,
      keyListName,
      keyListId,
      keyName,
      keyId,
      keyStore.modulus
    );
    target.blocks[handler.setStateId] = makeSetStateFromListBlock(
      handler.tagFirst ? handler.setTagId : handler.changeKeyId,
      handler.tagFirst ? handler.dispatchCallId : handler.setTagId,
      stateName,
      stateId,
      handler.transitionReporterId,
      false
    );
    addKeyIndexedListReporter(
      target,
      handler.transitionReporterId,
      handler.transitionIndexId,
      handler.setStateId,
      transitionListName,
      transitionListId,
      keyName,
      keyId,
      stateStore.modulus
    );
    target.blocks[handler.setTagId] = makeSetStateFromListBlock(
      handler.tagFirst ? handler.changeKeyId : handler.setStateId,
      handler.tagFirst ? handler.setStateId : handler.dispatchCallId,
      tagName,
      tagId,
      handler.tagReporterId,
      false
    );
    addKeyIndexedListReporter(
      target,
      handler.tagReporterId,
      handler.tagIndexId,
      handler.setTagId,
      tagListName,
      tagListId,
      keyName,
      keyId,
      tagStore.modulus
    );
    if (handler.dispatchCallId) {
      target.blocks[handler.dispatchCallId] = makeProcedureCall(dispatcherCode, secondRailId, null, false);
    }
  }

  const entryParent = run.connector?.kind === 'top-level'
    ? null
    : (run.connector?.ownerId ?? run.predecessorId);
  const entryFirstRailId = entryTagFirst ? entryTagSetId : entrySetId;
  const entrySecondRailId = entryTagFirst ? entrySetId : entryTagSetId;
  target.blocks[entryKeySetId] = makeSetStateFromListBlock(
    entryParent,
    entryFirstRailId,
    keyName,
    keyId,
    entryKeyReporterId,
    run.wasTopLevel,
    run.x,
    run.y
  );
  addKeyIndexedListReporter(
    target,
    entryKeyReporterId,
    entryKeyIndexId,
    entryKeySetId,
    keyListName,
    keyListId,
    keyName,
    keyId,
    keyStore.modulus
  );
  target.blocks[entrySetId] = makeSetStateFromListBlock(
    entryTagFirst ? entryTagSetId : entryKeySetId,
    entryTagFirst ? entryCallId : entryTagSetId,
    stateName,
    stateId,
    entryReporterId,
    false
  );
  addKeyIndexedListReporter(
    target,
    entryReporterId,
    entryIndexId,
    entrySetId,
    transitionListName,
    transitionListId,
    keyName,
    keyId,
    stateStore.modulus
  );
  target.blocks[entryTagSetId] = makeSetStateFromListBlock(
    entryTagFirst ? entryKeySetId : entrySetId,
    entryTagFirst ? entrySetId : entryCallId,
    tagName,
    tagId,
    entryTagReporterId,
    false
  );
  addKeyIndexedListReporter(
    target,
    entryTagReporterId,
    entryTagIndexId,
    entryTagSetId,
    tagListName,
    tagListId,
    keyName,
    keyId,
    tagStore.modulus
  );
  target.blocks[entryCallId] = makeProcedureCall(dispatcherCode, entrySecondRailId, run.successorId, false);
  replaceRunEntry(target, run, entryKeySetId);
  const successor = run.successorId ? blockAt(target, run.successorId) : undefined;
  if (successor) successor.parent = entryCallId;
  insertDualRail(
    target,
    {targetIndex: run.targetIndex, predecessorId: entrySecondRailId, successorId: entryCallId},
    railState,
    factory,
    rng.fork('entry-dual-rail'),
    `dispatcher-dual-${run.targetIndex}-${firstId}`
  );

  const routeRecords = handlers.map((handler, index) => ({
    stateCode: handler.stateCode,
    tagCode: handler.tagCode,
    proccode: requireMapItem(handlerCodeByOriginal, handler.originalId, 'dispatcher handler code'),
    ifId: factory.block(`dispatcher-if-${run.targetIndex}-${firstId}-${index}`),
    andId: factory.block(`dispatcher-and-${run.targetIndex}-${firstId}-${index}`),
    equalsId: factory.block(`dispatcher-equals-${run.targetIndex}-${firstId}-${index}`),
    reporterId: factory.block(`dispatcher-variable-${run.targetIndex}-${firstId}-${index}`),
    stateExpectedId: factory.block(`dispatcher-state-expected-${run.targetIndex}-${firstId}-${index}`),
    stateKeyReporterId: factory.block(`dispatcher-state-key-${run.targetIndex}-${firstId}-${index}`),
    tagEqualsId: factory.block(`dispatcher-tag-equals-${run.targetIndex}-${firstId}-${index}`),
    tagReporterId: factory.block(`dispatcher-tag-variable-${run.targetIndex}-${firstId}-${index}`),
    tagExpectedId: factory.block(`dispatcher-tag-expected-${run.targetIndex}-${firstId}-${index}`),
    tagKeyReporterId: factory.block(`dispatcher-tag-key-${run.targetIndex}-${firstId}-${index}`),
    callId: factory.block(`dispatcher-route-${run.targetIndex}-${firstId}-${index}`)
  }));
  routeRecords.push({
    stateCode: fakeStateCode,
    tagCode: fakeTagCode,
    proccode: fakeCode,
    ifId: factory.block(`dispatcher-if-${run.targetIndex}-${firstId}-fake`),
    andId: factory.block(`dispatcher-and-${run.targetIndex}-${firstId}-fake`),
    equalsId: factory.block(`dispatcher-equals-${run.targetIndex}-${firstId}-fake`),
    reporterId: factory.block(`dispatcher-variable-${run.targetIndex}-${firstId}-fake`),
    stateExpectedId: factory.block(`dispatcher-state-expected-${run.targetIndex}-${firstId}-fake`),
    stateKeyReporterId: factory.block(`dispatcher-state-key-${run.targetIndex}-${firstId}-fake`),
    tagEqualsId: factory.block(`dispatcher-tag-equals-${run.targetIndex}-${firstId}-fake`),
    tagReporterId: factory.block(`dispatcher-tag-variable-${run.targetIndex}-${firstId}-fake`),
    tagExpectedId: factory.block(`dispatcher-tag-expected-${run.targetIndex}-${firstId}-fake`),
    tagKeyReporterId: factory.block(`dispatcher-tag-key-${run.targetIndex}-${firstId}-fake`),
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
      route.andId,
      route.callId,
      nextRoute?.ifId ?? null,
      template
    );
    target.blocks[route.andId] = makeDispatcherConjunction(route.ifId, route.equalsId, route.tagEqualsId);
    target.blocks[route.equalsId] = makeReporterEquality(route.andId, route.reporterId, route.stateExpectedId);
    target.blocks[route.reporterId] = makeVariableReporter(route.equalsId, {variableId: stateId, variableName: stateName});
    target.blocks[route.stateExpectedId] = makeKeyedRouteExpression(
      route.equalsId,
      route.stateKeyReporterId,
      route.stateCode,
      'operator_add'
    );
    target.blocks[route.stateKeyReporterId] = makeVariableReporter(
      route.stateExpectedId,
      {variableId: keyId, variableName: keyName}
    );
    target.blocks[route.tagEqualsId] = makeReporterEquality(route.andId, route.tagReporterId, route.tagExpectedId);
    target.blocks[route.tagReporterId] = makeVariableReporter(
      route.tagEqualsId,
      {variableId: tagId, variableName: tagName}
    );
    target.blocks[route.tagExpectedId] = makeKeyedRouteExpression(
      route.tagEqualsId,
      route.tagKeyReporterId,
      route.tagCode,
      'operator_subtract'
    );
    target.blocks[route.tagKeyReporterId] = makeVariableReporter(
      route.tagExpectedId,
      {variableId: keyId, variableName: keyName}
    );
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
    next: fakeTagBodyId,
    parent: fakeDefinitionId,
    inputs: {},
    fields: {LIST: [transitionListName, transitionListId]},
    shadow: false,
    topLevel: false
  };
  target.blocks[fakeTagBodyId] = {
    opcode: 'data_deletealloflist',
    next: fakeKeyBodyId,
    parent: fakeBodyId,
    inputs: {},
    fields: {LIST: [tagListName, tagListId]},
    shadow: false,
    topLevel: false
  };
  target.blocks[fakeKeyBodyId] = {
    opcode: 'data_deletealloflist',
    next: null,
    parent: fakeTagBodyId,
    inputs: {},
    fields: {LIST: [keyListName, keyListId]},
    shadow: false,
    topLevel: false
  };
  for (const [bucketIndex, bucket] of rng.fork('definition-order').shuffle(handlerBuckets).entries()) {
    buildDispatcherHandlerBucket(
      target,
      bucket,
      stateName,
      stateId,
      tagName,
      tagId,
      factory,
      `${run.targetIndex}-${firstId}-${bucketIndex}`
    );
  }
}

function makeIndexedStore(
  keys: readonly number[],
  source: readonly number[],
  modulus: number,
  rng: DeterministicGenerator
): IndexedStore {
  if (keys.length !== source.length) throw new Error('dispatcher indexed store inputs are inconsistent');
  const values: Array<string | number> = Array.from({length: modulus - 1}, (_, index) => (
    index % 2 === 0 ? rng.integer(0x3fff_ffff) : `j_${rng.id('q_', 10)}`
  ));
  const occupied = new Set<number>();
  for (const [index, key] of keys.entries()) {
    const slot = scratchPositiveRemainder(key, modulus);
    if (slot === 0 || occupied.has(slot)) throw new Error('dispatcher indexed store key collision');
    occupied.add(slot);
    values[slot - 1] = requireItem(source, index, 'dispatcher indexed store value');
  }
  return {values, modulus};
}

function scratchPositiveRemainder(value: number, modulus: number): number {
  const remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}

function outlineRun(
  project: ScratchProject,
  run: ConnectableLinearRun,
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
    run.connector?.kind === 'top-level' ? null : (run.connector?.ownerId ?? run.predecessorId),
    run.successorId,
    run.wasTopLevel,
    false,
    run.x,
    run.y
  );
  replaceRunEntry(target, run, callId);
  if (run.successorId) {
    const successor = requireBlock(target, run.successorId);
    successor.parent = callId;
  }
}

function replaceRunEntry(target: ScratchTarget, run: ConnectableLinearRun, replacementId: string): void {
  const connector = run.connector;
  if (connector?.kind === 'input') {
    const owner = requireBlock(target, connector.ownerId);
    const input = owner.inputs[connector.inputName];
    if (!input || input[1] !== connector.blockId) throw new Error('nested run input connector changed before splicing');
    const replacement = [...input];
    replacement[1] = replacementId;
    owner.inputs[connector.inputName] = replacement;
    return;
  }
  if (connector?.kind === 'next') {
    const owner = requireBlock(target, connector.ownerId);
    if (owner.next !== connector.blockId) throw new Error('nested run next connector changed before splicing');
    owner.next = replacementId;
    return;
  }
  if (connector?.kind === 'top-level') return;
  if (run.predecessorId) requireBlock(target, run.predecessorId).next = replacementId;
}

function estimateDispatcherGrowth(length: number): number {
  return (40 * length) + 44;
}

function boundDispatcherRuns(project: ScratchProject, run: ConnectableLinearRun): ConnectableLinearRun[] {
  const maximumLength = 5;
  const target = requireTarget(project, run.targetIndex);
  if (run.blockIds.length <= maximumLength) return [run];
  const bounded: ConnectableLinearRun[] = [];
  let cursor = 0;
  while (run.blockIds.length - cursor >= 4) {
    const remaining = run.blockIds.length - cursor;
    const length = remaining === maximumLength + 4
      ? maximumLength - 1
      : Math.min(maximumLength, remaining);
    const blockIds = run.blockIds.slice(cursor, cursor + length);
    requireBlock(target, requireItem(blockIds, 0, 'bounded dispatcher run'));
    const predecessorId = cursor === 0
      ? run.predecessorId
      : requireItem(run.blockIds, cursor - 1, 'dispatcher separator');
    bounded.push({
      targetIndex: run.targetIndex,
      blockIds,
      predecessorId,
      successorId: run.blockIds[cursor + length] ?? run.successorId,
      wasTopLevel: cursor === 0 && run.wasTopLevel,
      ...(cursor === 0 && run.connector !== undefined
        ? {connector: run.connector}
        : predecessorId === null
          ? {}
          : {connector: {kind: 'next' as const, ownerId: predecessorId, blockId: requireItem(blockIds, 0, 'dispatcher entry')}}),
      ...(cursor === 0 && run.x !== undefined ? {x: run.x} : {}),
      ...(cursor === 0 && run.y !== undefined ? {y: run.y} : {})
    });
    cursor += length;
    if (run.blockIds.length - cursor >= 5) cursor += 1;
  }
  return bounded;
}

function uniqueDispatcherNumbers(count: number, rng: DeterministicGenerator): number[] {
  const values = new Set<number>();
  while (values.size < count) {
    values.add(0x1_0000 + rng.integer(0x1fff_0000));
  }
  return [...values];
}

function uniqueDispatcherKeys(
  count: number,
  moduli: readonly number[],
  rng: DeterministicGenerator
): number[] {
  const values: number[] = [];
  const occupied = moduli.map(() => new Set<number>());
  while (values.length < count) {
    const candidate = 0x1_0000 + rng.integer(0x1fff_0000);
    const residues = moduli.map(modulus => scratchPositiveRemainder(candidate, modulus));
    if (residues.some((residue, index) => residue === 0 || occupied[index]?.has(residue) === true)) continue;
    values.push(candidate);
    for (const [index, residue] of residues.entries()) occupied[index]?.add(residue);
  }
  return values;
}

function uniqueDispatcherTagNumbers(
  stateCodes: readonly number[],
  rng: DeterministicGenerator
): number[] {
  const values = new Set<number>();
  const sums = new Set<number>();
  const result: number[] = [];
  for (const stateCode of stateCodes) {
    for (;;) {
      const candidate = 0x1_0000 + rng.integer(0x1fff_0000);
      const sum = stateCode + candidate;
      if (values.has(candidate) || sums.has(sum)) continue;
      values.add(candidate);
      sums.add(sum);
      result.push(candidate);
      break;
    }
  }
  return result;
}

function makeDispatcherHandlerBuckets(
  handlers: readonly DispatcherHandler[],
  targetIndex: number,
  firstId: string,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  allocateCode: (domain: string, ordinal: number) => string
): DispatcherHandlerBucket[] {
  const order = rng.fork('membership').shuffle(handlers);
  const bucketCount = 1;
  const buckets: DispatcherHandlerBucket[] = [];
  let cursor = 0;
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const remaining = order.length - cursor;
    const remainingBuckets = bucketCount - bucketIndex;
    const size = Math.ceil(remaining / remainingBuckets);
    const members = order.slice(cursor, cursor + size);
    cursor += size;
    buckets.push({
      definitionId: factory.block(`handler-bucket-def-${targetIndex}-${firstId}-${bucketIndex}`),
      prototypeId: factory.block(`handler-bucket-proto-${targetIndex}-${firstId}-${bucketIndex}`),
      proccode: allocateCode(`handler-bucket-code-${bucketIndex}`, bucketIndex),
      handlers: members
    });
  }
  return buckets;
}

function buildDispatcherHandlerBucket(
  target: ScratchTarget,
  bucket: DispatcherHandlerBucket,
  stateName: string,
  stateId: string,
  tagName: string,
  tagId: string,
  factory: UniqueFactory,
  domain: string
): void {
  const buildSelection = (index: number, parentId: string): string => {
    const handler = requireItem(bucket.handlers, index, 'dispatcher bucket handler');
    const next = bucket.handlers[index + 1];
    if (!next) {
      requireBlock(target, handler.originalId).parent = parentId;
      return handler.originalId;
    }

    const branchId = factory.block(`handler-bucket-branch-${domain}-${index}`);
    const equalsId = factory.block(`handler-bucket-equals-${domain}-${index}`);
    const sumId = factory.block(`handler-bucket-sum-${domain}-${index}`);
    const stateReporterId = factory.block(`handler-bucket-state-${domain}-${index}`);
    const tagReporterId = factory.block(`handler-bucket-tag-${domain}-${index}`);
    const alternateId = buildSelection(index + 1, branchId);
    requireBlock(target, handler.originalId).parent = branchId;
    target.blocks[branchId] = {
      opcode: 'control_if_else',
      next: null,
      parent: parentId,
      inputs: {
        CONDITION: [2, equalsId],
        SUBSTACK: [2, handler.originalId],
        SUBSTACK2: [2, alternateId]
      },
      fields: {},
      shadow: false,
      topLevel: false
    };
    target.blocks[equalsId] = {
      opcode: 'operator_equals',
      next: null,
      parent: branchId,
      inputs: {
        OPERAND1: [2, sumId],
        OPERAND2: numericInput(handler.stateCode + handler.tagCode)
      },
      fields: {},
      shadow: false,
      topLevel: false
    };
    target.blocks[sumId] = {
      opcode: 'operator_add',
      next: null,
      parent: equalsId,
      inputs: {NUM1: [2, stateReporterId], NUM2: [2, tagReporterId]},
      fields: {},
      shadow: false,
      topLevel: false
    };
    target.blocks[stateReporterId] = makeVariableReporter(sumId, {variableId: stateId, variableName: stateName});
    target.blocks[tagReporterId] = makeVariableReporter(sumId, {variableId: tagId, variableName: tagName});
    return branchId;
  };

  const entryId = buildSelection(0, bucket.definitionId);
  target.blocks[bucket.definitionId] = makeProcedureDefinition(bucket.prototypeId, entryId);
  target.blocks[bucket.prototypeId] = makeProcedurePrototype(bucket.definitionId, bucket.proccode);
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
    inputs: {VALUE: [2, reporterId]},
    fields: {VARIABLE: [variableName, variableId]},
    shadow: false,
    topLevel,
    ...(x === undefined ? {} : {x}),
    ...(y === undefined ? {} : {y})
  };
}

function makeChangeStateFromListBlock(
  parent: string,
  next: string,
  variableName: string,
  variableId: string,
  reporterId: string
): ScratchBlock {
  return {
    opcode: 'data_changevariableby',
    next,
    parent,
    inputs: {VALUE: [2, reporterId]},
    fields: {VARIABLE: [variableName, variableId]},
    shadow: false,
    topLevel: false
  };
}

function makeDispatcherBranch(
  parentId: string,
  conditionId: string,
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
        CONDITION: [2, conditionId],
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
      CONDITION: [2, conditionId],
      SUBSTACK: [2, handlerCallId],
      SUBSTACK2: [2, nextBranchId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
}

function makeDispatcherConjunction(parentId: string, stateEqualsId: string, tagEqualsId: string): ScratchBlock {
  return {
    opcode: 'operator_and',
    next: null,
    parent: parentId,
    inputs: {OPERAND1: [2, stateEqualsId], OPERAND2: [2, tagEqualsId]},
    fields: {},
    shadow: false,
    topLevel: false
  };
}

function makeReporterEquality(parentId: string, reporterId: string, expectedReporterId: string): ScratchBlock {
  return {
    opcode: 'operator_equals',
    next: null,
    parent: parentId,
    inputs: {OPERAND1: [2, reporterId], OPERAND2: [2, expectedReporterId]},
    fields: {},
    shadow: false,
    topLevel: false
  };
}

function makeKeyedRouteExpression(
  parentId: string,
  keyReporterId: string,
  code: number,
  opcode: 'operator_add' | 'operator_subtract'
): ScratchBlock {
  return {
    opcode,
    next: null,
    parent: parentId,
    inputs: {NUM1: numericInput(code), NUM2: [2, keyReporterId]},
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
  for (const [usageIndex, usage] of candidate.usages.entries()) {
    if (usage.kind !== 'inline') continue;
    const target = requireTarget(project, usage.targetIndex);
    const block = requireBlock(target, usage.blockId);
    const input = block.inputs[usage.inputName] ?? [];
    requireItem(input, 1, 'inline variable input');
    const reporterId = factory.block(`virtual-inline-${candidate.targetIndex}-${usage.targetIndex}-${ordinal}-${usageIndex}`);
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
  for (const [usageIndex, usage] of candidate.usages.entries()) {
    if (usage.kind !== 'field') continue;
    const target = requireTarget(project, usage.targetIndex);
    const block = requireBlock(target, usage.blockId);
    if (block.opcode === 'data_variable') {
      block.opcode = 'data_itemoflist';
      block.fields = {LIST: [state.listName, state.listId]};
      block.inputs = {INDEX: numericInput(slot)};
    } else if (block.opcode === 'data_setvariableto') {
      const value = block.inputs['VALUE'];
      if (!value) throw new Error('eligible variable setter is missing its VALUE input');
      block.opcode = 'data_replaceitemoflist';
      block.fields = {LIST: [state.listName, state.listId]};
      block.inputs = {INDEX: numericInput(slot), ITEM: value};
    } else if (block.opcode === 'data_changevariableby') {
      const delta = block.inputs['VALUE'] ?? numericInput(0);
      const itemId = factory.block(`virtual-current-${candidate.targetIndex}-${usage.targetIndex}-${ordinal}-${usageIndex}`);
      const addId = factory.block(`virtual-add-${candidate.targetIndex}-${usage.targetIndex}-${ordinal}-${usageIndex}`);
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

function addKeyIndexedListReporter(
  target: ScratchTarget,
  reporterId: string,
  indexId: string,
  parent: string,
  listName: string,
  listId: string,
  keyName: string,
  keyId: string,
  modulus: number
): void {
  target.blocks[reporterId] = {
    opcode: 'data_itemoflist',
    next: null,
    parent,
    inputs: {INDEX: [2, indexId]},
    fields: {LIST: [listName, listId]},
    shadow: false,
    topLevel: false
  };
  target.blocks[indexId] = {
    opcode: 'operator_mod',
    next: null,
    parent: reporterId,
    inputs: {
      NUM1: [1, [12, keyName, keyId]],
      NUM2: numericInput(modulus)
    },
    fields: {},
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
    return {left: canonicalNumber(left), right: canonicalNumber(0.5)};
  }
  const safeFactor = Math.abs(value) > Number.MAX_VALUE / 2 ? 2 : 0.5;
  let equation = {
    left: canonicalNumber(value / safeFactor),
    right: canonicalNumber(safeFactor)
  };
  const exponents = rng.shuffle([-32, -16, -8, -4, -2, -1, 1, 2, 4, 8, 16, 32]);
  const sign = rng.integer(2) === 0 ? 1 : -1;
  for (const exponent of exponents) {
    const factor = sign * (2 ** exponent);
    const quotient = value / factor;
    if (!Number.isFinite(quotient) || !Object.is(quotient * factor, value)) continue;
    equation = {left: canonicalNumber(quotient), right: canonicalNumber(factor)};
    break;
  }
  return equation;
}

function canonicalNumber(value: number): string {
  return Object.is(value, -0) ? '-0' : value.toExponential(17);
}

function collectConditionSites(project: ScratchProject): ConditionSite[] {
  const sites: ConditionSite[] = [];
  for (const [targetIndex, target] of project.targets.entries()) {
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
  for (const [targetIndex, target] of project.targets.entries()) {
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

function collectTopLevelSequentialEdges(project: ScratchProject): InsertionEdge[] {
  const edges: InsertionEdge[] = [];
  for (const [targetIndex, target] of project.targets.entries()) {
    for (const [topId, topValue] of Object.entries(target.blocks)) {
      if (!isScratchBlock(topValue) || !topValue.topLevel || topValue.opcode === 'procedures_definition') continue;
      const visited = new Set<string>();
      let currentId: string | null = topId;
      while (currentId !== null && !visited.has(currentId)) {
        visited.add(currentId);
        const block = blockAt(target, currentId);
        if (!block) break;
        const successorId = block.next;
        if (successorId && blockAt(target, successorId)) {
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
  const encodedId = factory.block(`${domain}-encoded`);
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
  target.blocks[equalsId] = makeEncodedOpaqueEquality(
    railId,
    encodedId,
    state
  );
  target.blocks[encodedId] = makeEncodedOpaqueToken(equalsId, firstRailIsLive ? state.token : state.mismatch);
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
  const encodedId = factory.block(`guard-encoded-${domain}`);
  target.blocks[guardId] = makeGuard(edge.predecessorId, edge.successorId, equalsId);
  target.blocks[equalsId] = makeEncodedFalseEquality(guardId, encodedId, state);
  target.blocks[encodedId] = makeEncodedOpaqueToken(equalsId, state.mismatch);
  predecessor.next = guardId;
  successor.parent = guardId;
  return {
    targetIndex: edge.targetIndex,
    guardId,
    tailId: null,
    chainDepth: 1,
    growth: ENCODED_OPAQUE_GUARD_GROWTH
  };
}

function insertLiveRailGuard(
  target: ScratchTarget,
  edge: InsertionEdge,
  state: PrivateState,
  factory: UniqueFactory,
  domain: string,
  plan: LiveGuardPlan
): GuardSite {
  const predecessor = requireBlock(target, edge.predecessorId);
  const successor = requireBlock(target, edge.successorId);
  const updateId = factory.block(`guard-update-${domain}`);
  const guardId = factory.block(`guard-${domain}`);
  const equalsId = makeLiveOpaqueCondition(target, guardId, state, factory, domain, plan);
  target.blocks[updateId] = {
    opcode: 'data_changevariableby',
    next: guardId,
    parent: edge.predecessorId,
    inputs: {VALUE: numericInput(1)},
    fields: {VARIABLE: [state.variableName, state.variableId]},
    shadow: false,
    topLevel: false
  };
  target.blocks[guardId] = makeGuard(updateId, edge.successorId, equalsId);
  predecessor.next = updateId;
  successor.parent = guardId;
  return {targetIndex: edge.targetIndex, guardId, tailId: null, chainDepth: 2, growth: plan.growth};
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
  const encodedId = factory.block(`guard-encoded-${domain}`);
  target.blocks[guardId] = makeGuard(null, null, equalsId, true);
  target.blocks[equalsId] = makeEncodedFalseEquality(guardId, encodedId, state);
  target.blocks[encodedId] = makeEncodedOpaqueToken(equalsId, state.mismatch);
  return {
    targetIndex,
    guardId,
    tailId: null,
    chainDepth: 1,
    growth: ENCODED_OPAQUE_GUARD_GROWTH
  };
}

function createLiveRailDriver(
  target: ScratchTarget,
  targetIndex: number,
  state: PrivateState,
  factory: UniqueFactory,
  domain: string,
  plan: LiveGuardPlan
): GuardSite {
  const hatId = factory.block(`guard-driver-hat-${domain}`);
  const updateId = factory.block(`guard-driver-update-${domain}`);
  const guardId = factory.block(`guard-${domain}`);
  const equalsId = makeLiveOpaqueCondition(target, guardId, state, factory, domain, plan);
  target.blocks[hatId] = {
    opcode: 'event_whenflagclicked',
    next: updateId,
    parent: null,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: true,
    x: 0,
    y: 0
  };
  target.blocks[updateId] = {
    opcode: 'data_changevariableby',
    next: guardId,
    parent: hatId,
    inputs: {VALUE: numericInput(1)},
    fields: {VARIABLE: [state.variableName, state.variableId]},
    shadow: false,
    topLevel: false
  };
  target.blocks[guardId] = makeGuard(updateId, null, equalsId);
  return {targetIndex, guardId, tailId: null, chainDepth: 3, growth: plan.growth + 1};
}

function makeLiveGuardPlan(rng: DeterministicGenerator): LiveGuardPlan {
  const reporterOpcodes: readonly LiveReporterOpcode[] = [
    'sensing_answer',
    'sensing_mousex',
    'sensing_mousey',
    'sensing_timer'
  ];
  const expressions: readonly LiveExpressionTemplate[] = ['direct', 'length', 'letter', 'mod'];
  const conditionOpcodes: readonly LiveConditionOpcode[] = [
    'operator_contains',
    'operator_equals',
    'operator_gt',
    'operator_lt'
  ];
  const reporterOpcode = requireItem(reporterOpcodes, rng.integer(reporterOpcodes.length), 'live reporter template');
  const expression = requireItem(expressions, rng.integer(expressions.length), 'live expression template');
  const conditionOpcode = requireItem(
    conditionOpcodes,
    rng.integer(conditionOpcodes.length),
    'live condition template'
  );
  return {
    reporterOpcode,
    expression,
    conditionOpcode,
    growth: expression === 'direct' ? 8 : expression === 'length' ? 10 : 11
  };
}

function liveGuardObjectGrowth(plan: LiveGuardPlan, includesHat: boolean): number {
  return 5 + (plan.expression === 'direct' ? 0 : 1) + (includesHat ? 1 : 0);
}

function makeLiveOpaqueCondition(
  target: ScratchTarget,
  guardId: string,
  state: PrivateState,
  factory: UniqueFactory,
  domain: string,
  plan: LiveGuardPlan
): string {
  const conditionId = factory.block(`guard-condition-${domain}`);
  const liveReporterId = factory.block(`guard-live-reporter-${domain}`);
  const stateReporterId = factory.block(`guard-variable-${domain}`);
  const expressionId = plan.expression === 'direct'
    ? liveReporterId
    : factory.block(`guard-live-expression-${domain}`);

  const firstInputName = plan.conditionOpcode === 'operator_contains' ? 'STRING1' : 'OPERAND1';
  const secondInputName = plan.conditionOpcode === 'operator_contains' ? 'STRING2' : 'OPERAND2';
  const fallbackCode = plan.conditionOpcode === 'operator_contains' ? 10 : 4;
  target.blocks[conditionId] = {
    opcode: plan.conditionOpcode,
    next: null,
    parent: guardId,
    inputs: {
      [firstInputName]: [3, expressionId, [fallbackCode, '']],
      [secondInputName]: [3, stateReporterId, [fallbackCode, '']]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[liveReporterId] = {
    opcode: plan.reporterOpcode,
    next: null,
    parent: plan.expression === 'direct' ? conditionId : expressionId,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[stateReporterId] = makeVariableReporter(conditionId, state);

  if (plan.expression === 'length') {
    target.blocks[expressionId] = {
      opcode: 'operator_length',
      next: null,
      parent: conditionId,
      inputs: {STRING: [3, liveReporterId, [10, '']]},
      fields: {},
      shadow: false,
      topLevel: false
    };
  } else if (plan.expression === 'letter') {
    target.blocks[expressionId] = {
      opcode: 'operator_letter_of',
      next: null,
      parent: conditionId,
      inputs: {LETTER: numericInput(1), STRING: [3, liveReporterId, [10, '']]},
      fields: {},
      shadow: false,
      topLevel: false
    };
  } else if (plan.expression === 'mod') {
    target.blocks[expressionId] = {
      opcode: 'operator_mod',
      next: null,
      parent: conditionId,
      inputs: {NUM1: [3, liveReporterId, [4, '0']], NUM2: numericInput(997)},
      fields: {},
      shadow: false,
      topLevel: false
    };
  }
  return conditionId;
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

function makeEncodedFalseEquality(parentId: string, encodedId: string, state: PrivateState): ScratchBlock {
  return makeEncodedOpaqueEquality(parentId, encodedId, state);
}

function makeEncodedOpaqueEquality(
  parentId: string,
  encodedId: string,
  state: PrivateState
): ScratchBlock {
  return {
    opcode: 'operator_equals',
    next: null,
    parent: parentId,
    inputs: {
      OPERAND1: [1, [12, state.variableName, state.variableId]],
      OPERAND2: [2, encodedId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
}

function makeEncodedOpaqueToken(parentId: string, value: string): ScratchBlock {
  const [left, right] = splitOpaqueToken(value);
  return {
    opcode: 'operator_join',
    next: null,
    parent: parentId,
    inputs: {STRING1: textInput(left), STRING2: textInput(right)},
    fields: {},
    shadow: false,
    topLevel: false
  };
}

function splitOpaqueToken(value: string): readonly [string, string] {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  const split = 1 + (hash % (value.length - 1));
  return [value.slice(0, split), value.slice(split)];
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

function addCoherentDecoySubsystems(
  project: ScratchProject,
  mode: AggressiveMode,
  budget: GrowthBudget,
  maximumAdditionalGrowth: number,
  guards: GuardSite[],
  getDecoyState: (targetIndex: number) => PrivateState,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  vocabulary: DecoyVocabulary,
  stats: ObfuscationStats
): void {
  if (mode !== 'no-preserve') return;
  const maximumDepth = 128;
  const maximumSiteGrowth = 256;
  let remainingGrowth = maximumAdditionalGrowth;
  let ordinal = 0;
  const entryBroadcasts: FakeBroadcast[] = [];

  while (project.targets.length > 0) {
    if (budget.remaining < COHERENT_DECOY_GROWTH || remainingGrowth < COHERENT_DECOY_GROWTH) break;
    const eligibleAnchors = guards.filter(site => (
      site.chainDepth < maximumDepth
      && site.growth + COHERENT_DECOY_GROWTH <= maximumSiteGrowth
    ));
    if (eligibleAnchors.length === 0) {
      const driverPlan = makeLiveGuardPlan(rng.fork(`driver-plan-${guards.length}`));
      const driverGrowth = driverPlan.growth + 1;
      if (
        budget.remaining < COHERENT_DECOY_GROWTH + driverGrowth
        || remainingGrowth < COHERENT_DECOY_GROWTH + driverGrowth
        || !budget.trySpend(driverGrowth, 3)
      ) break;
      const targetIndex = rng.fork(`driver-target-${guards.length}`).integer(project.targets.length);
      const target = requireTarget(project, targetIndex);
      guards.push(createLiveRailDriver(
        target,
        targetIndex,
        getDecoyState(targetIndex),
        factory,
        `coherent-${guards.length}`,
        driverPlan
      ));
      remainingGrowth -= driverGrowth;
      stats.decoysAdded += liveGuardObjectGrowth(driverPlan, true);
      continue;
    }
    const anchor = requireItem(
      eligibleAnchors,
      rng.fork(`anchor-${ordinal}`).integer(eligibleAnchors.length),
      'coherent decoy anchor'
    );
    const available = Math.min(
      budget.remaining,
      remainingGrowth,
      maximumSiteGrowth - anchor.growth
    );
    const reservedForAnother = available >= COHERENT_DECOY_GROWTH * 2 ? COHERENT_DECOY_GROWTH : 0;
    const maximumExtra = Math.min(
      MAX_COHERENT_EXTRA_GROWTH,
      available - COHERENT_DECOY_GROWTH - reservedForAnother
    );
    const extraGrowth = maximumExtra > 0
      ? rng.fork(`extra-growth-${ordinal}`).integer(maximumExtra + 1)
      : 0;
    const plannedGrowth = COHERENT_DECOY_GROWTH + extraGrowth;
    if (!budget.trySpend(plannedGrowth, 3)) break;
    const growth = addCoherentDecoySubsystem(
      project,
      mode,
      anchor,
      ordinal,
      getDecoyState(anchor.targetIndex),
      factory,
      rng.fork(`subsystem-${ordinal}`),
      vocabulary,
      extraGrowth,
      entryBroadcasts
    );
    if (growth.equivalents !== plannedGrowth) {
      throw new Error(`coherent decoy growth accounting failed (${growth.equivalents} !== ${plannedGrowth})`);
    }
    anchor.growth += growth.equivalents;
    remainingGrowth -= growth.equivalents;
    stats.decoysAdded += growth.objects;
    ordinal += 1;
  }
}

function addCoherentDecoySubsystem(
  project: ScratchProject,
  mode: AggressiveMode,
  anchor: GuardSite,
  ordinal: number,
  railState: PrivateState,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  vocabulary: DecoyVocabulary,
  extraGrowth: number,
  entryBroadcasts: FakeBroadcast[]
): LocalGrowth {
  const target = requireTarget(project, anchor.targetIndex);
  const stage = project.targets.find(candidate => candidate.isStage);
  if (!stage) throw new Error('validated project has no Stage for fake broadcasts');
  const state = createPrivateVariableState(
    target,
    anchor.targetIndex,
    mode,
    factory,
    rng.fork('state'),
    `coherent-${ordinal}`,
    railState
  );
  const firstBroadcast = createFakeBroadcast(stage, mode, ordinal, 'entry', factory);
  const secondBroadcast = entryBroadcasts.length === 0
    ? firstBroadcast
    : requireItem(
        entryBroadcasts,
        rng.fork('continuation-link').integer(entryBroadcasts.length),
        'coherent continuation broadcast'
      );
  entryBroadcasts.push(firstBroadcast);
  const template = ordinal % 3;
  const warp = template !== 2;
  const existingCodes = collectProcedureCodes(target);
  let proccode = factory.name(mode, `coherent-procedure-${anchor.targetIndex}-${ordinal}`);
  for (let collision = 0; existingCodes.has(proccode); collision += 1) {
    proccode = factory.name(mode, `coherent-procedure-${anchor.targetIndex}-${ordinal}-${collision}`);
  }

  const firstSenderId = factory.block(`coherent-sender-entry-${anchor.targetIndex}-${ordinal}`);
  const firstHatId = factory.block(`coherent-hat-entry-${anchor.targetIndex}-${ordinal}`);
  const firstCallId = factory.block(`coherent-call-entry-${anchor.targetIndex}-${ordinal}`);
  const definitionId = factory.block(`coherent-definition-${anchor.targetIndex}-${ordinal}`);
  const prototypeId = factory.block(`coherent-prototype-${anchor.targetIndex}-${ordinal}`);
  const appendId = factory.block(`coherent-append-${anchor.targetIndex}-${ordinal}`);
  const joinId = factory.block(`coherent-join-${anchor.targetIndex}-${ordinal}`);
  const joinVariableId = factory.block(`coherent-join-variable-${anchor.targetIndex}-${ordinal}`);
  const joinListItemId = factory.block(`coherent-join-item-${anchor.targetIndex}-${ordinal}`);
  const branchId = factory.block(`coherent-branch-${anchor.targetIndex}-${ordinal}`);
  const andId = factory.block(`coherent-and-${anchor.targetIndex}-${ordinal}`);
  const variableEqualsId = factory.block(`coherent-variable-equals-${anchor.targetIndex}-${ordinal}`);
  const conditionVariableId = factory.block(`coherent-condition-variable-${anchor.targetIndex}-${ordinal}`);
  const listEqualsId = factory.block(`coherent-list-equals-${anchor.targetIndex}-${ordinal}`);
  const conditionListItemId = factory.block(`coherent-condition-item-${anchor.targetIndex}-${ordinal}`);
  const secondSenderId = factory.block(`coherent-sender-continuation-${anchor.targetIndex}-${ordinal}`);
  const secondHatId = factory.block(`coherent-hat-continuation-${anchor.targetIndex}-${ordinal}`);
  const waitId = factory.block(`coherent-wait-${anchor.targetIndex}-${ordinal}`);
  const divideId = factory.block(`coherent-wait-divide-${anchor.targetIndex}-${ordinal}`);
  const modId = factory.block(`coherent-wait-mod-${anchor.targetIndex}-${ordinal}`);
  const lengthId = factory.block(`coherent-wait-length-${anchor.targetIndex}-${ordinal}`);
  const secondCallId = factory.block(`coherent-call-continuation-${anchor.targetIndex}-${ordinal}`);
  const createdIds = [
    firstSenderId,
    firstHatId,
    firstCallId,
    definitionId,
    prototypeId,
    appendId,
    joinId,
    joinVariableId,
    joinListItemId,
    branchId,
    andId,
    variableEqualsId,
    conditionVariableId,
    listEqualsId,
    conditionListItemId,
    secondSenderId,
    secondHatId,
    waitId,
    divideId,
    modId,
    lengthId,
    secondCallId
  ];

  const firstSenderParent = anchor.tailId ?? anchor.guardId;
  target.blocks[firstSenderId] = makeBroadcastCommand(firstSenderParent, null, firstBroadcast);
  if (anchor.tailId) {
    requireBlock(target, anchor.tailId).next = firstSenderId;
  } else {
    requireBlock(target, anchor.guardId).inputs['SUBSTACK'] = [2, firstSenderId];
  }
  anchor.tailId = firstSenderId;
  anchor.chainDepth += 1;

  target.blocks[firstHatId] = makeBroadcastHat(firstCallId, firstBroadcast);
  target.blocks[firstCallId] = makeProcedureCall(proccode, firstHatId, null, false, warp);
  target.blocks[definitionId] = makeProcedureDefinition(prototypeId, template === 1 ? branchId : appendId);
  target.blocks[prototypeId] = makeProcedurePrototype(definitionId, proccode, warp);
  target.blocks[appendId] = {
    opcode: 'data_addtolist',
    next: template === 1 ? null : branchId,
    parent: template === 1 ? branchId : definitionId,
    inputs: {ITEM: [3, joinId, [10, '']]},
    fields: {LIST: [state.listName, state.listId]},
    shadow: false,
    topLevel: false
  };
  target.blocks[joinId] = {
    opcode: 'operator_join',
    next: null,
    parent: appendId,
    inputs: {
      STRING1: [3, template === 2 ? joinListItemId : joinVariableId, [10, '']],
      STRING2: [3, template === 2 ? joinVariableId : joinListItemId, [10, '']]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[joinVariableId] = makeVariableReporter(joinId, state);
  target.blocks[joinListItemId] = makeListItemReporter(joinId, state, 1);
  target.blocks[branchId] = {
    opcode: 'control_if',
    next: template === 1 ? appendId : null,
    parent: template === 1 ? definitionId : appendId,
    inputs: {CONDITION: [2, andId], SUBSTACK: [2, secondSenderId]},
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[andId] = {
    opcode: 'operator_or',
    next: null,
    parent: branchId,
    inputs: {
      OPERAND1: [2, template === 2 ? listEqualsId : variableEqualsId],
      OPERAND2: [2, template === 2 ? variableEqualsId : listEqualsId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[variableEqualsId] = makeOpaqueEquality(
    andId,
    conditionVariableId,
    railState,
    railState.mismatch
  );
  target.blocks[conditionVariableId] = makeVariableReporter(variableEqualsId, railState);
  target.blocks[listEqualsId] = {
    opcode: 'operator_equals',
    next: null,
    parent: andId,
    inputs: {
      OPERAND1: [3, conditionListItemId, [10, '']],
      OPERAND2: textInput(state.mismatch)
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[conditionListItemId] = makeListItemReporter(listEqualsId, state, 1);
  target.blocks[secondSenderId] = makeBroadcastCommand(branchId, null, secondBroadcast);
  let decoyTailId = secondSenderId;
  let remainingExtraGrowth = extraGrowth;
  for (let extraOrdinal = 0; remainingExtraGrowth > 0; extraOrdinal += 1) {
    const predecessor = requireBlock(target, decoyTailId);
    const useSeparator = isDecoyMutationOpcode(predecessor.opcode);
    const cost = useSeparator
      ? 1
      : chooseDecoyCost(
          rng.fork(`coherent-extra-cost-${extraOrdinal}`),
          Math.min(3, remainingExtraGrowth)
        );
    const decoyId = factory.block(`coherent-extra-${anchor.targetIndex}-${ordinal}-${extraOrdinal}`);
    createdIds.push(decoyId);
    target.blocks[decoyId] = useSeparator
      ? makePrivateSeparatorBlock(
          state,
          decoyTailId,
          rng.fork(`coherent-extra-separator-${extraOrdinal}`)
        )
      : makeDecoyBlock(
          state,
          cost,
          decoyTailId,
          null,
          false,
          (ordinal * (MAX_COHERENT_EXTRA_GROWTH + 1)) + extraOrdinal,
          vocabulary,
          rng.fork(`coherent-extra-opcode-${extraOrdinal}`)
        );
    requireBlock(target, decoyTailId).next = decoyId;
    decoyTailId = decoyId;
    remainingExtraGrowth -= cost;
  }

  target.blocks[secondHatId] = makeBroadcastHat(waitId, secondBroadcast);
  target.blocks[waitId] = {
    opcode: 'control_wait',
    next: secondCallId,
    parent: secondHatId,
    inputs: {DURATION: [3, divideId, [4, '0']]},
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[divideId] = {
    opcode: template === 0 ? 'operator_divide' : template === 1 ? 'operator_multiply' : 'operator_subtract',
    next: null,
    parent: waitId,
    inputs: {
      NUM1: [3, modId, [4, '0']],
      NUM2: numericInput(template === 0 ? 1000 : template === 1 ? 0.001 : -7)
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[modId] = {
    opcode: template === 0 ? 'operator_mod' : template === 1 ? 'operator_add' : 'operator_multiply',
    next: null,
    parent: divideId,
    inputs: {
      NUM1: [3, lengthId, [4, '0']],
      NUM2: numericInput(template === 0 ? 3 : template === 1 ? 2 : -7)
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[lengthId] = {
    opcode: 'data_lengthoflist',
    next: null,
    parent: modId,
    inputs: {},
    fields: {LIST: [state.listName, state.listId]},
    shadow: false,
    topLevel: false
  };
  target.blocks[secondCallId] = makeProcedureCall(proccode, waitId, null, false, warp);
  return {
    equivalents: createdIds.reduce((growth, id) => growth + blockEquivalentGrowth(requireBlock(target, id)), 0),
    objects: createdIds.length
  };
}

function createFakeBroadcast(
  stage: ScratchTarget,
  mode: AggressiveMode,
  ordinal: number,
  role: string,
  factory: UniqueFactory
): FakeBroadcast {
  const id = factory.symbol('c_', `coherent-broadcast-${role}-${ordinal}`);
  const name = factory.name(mode, `coherent-broadcast-${role}-${ordinal}`);
  stage.broadcasts[id] = name;
  return {id, name};
}

function makeBroadcastHat(next: string | null, broadcast: FakeBroadcast): ScratchBlock {
  return {
    opcode: 'event_whenbroadcastreceived',
    next,
    parent: null,
    inputs: {},
    fields: {BROADCAST_OPTION: [broadcast.name, broadcast.id]},
    shadow: false,
    topLevel: true,
    x: 0,
    y: 0
  };
}

function makeBroadcastCommand(parent: string, next: string | null, broadcast: FakeBroadcast): ScratchBlock {
  return {
    opcode: 'event_broadcast',
    next,
    parent,
    inputs: {BROADCAST_INPUT: [1, [11, broadcast.name, broadcast.id]]},
    fields: {},
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
    let site: GuardSite | undefined;
    for (let attempts = 0; attempts < sites.length; attempts += 1) {
      const candidate = sites[siteCursor % sites.length];
      siteCursor += 1;
      if (
        candidate
        && candidate.chainDepth < maximumDepth
        && candidate.growth < maximumSiteGrowth
      ) {
        site = candidate;
        break;
      }
    }
    if (!site) {
      const targetIndex = rng.fork(`decoy-target-${sites.length}`).integer(project.targets.length);
      const target = requireTarget(project, targetIndex);
      const state = getState(targetIndex);
      const driverPlan = mode === 'no-preserve'
        ? makeLiveGuardPlan(rng.fork(`decoy-driver-plan-${sites.length}`))
        : undefined;
      const guardGrowth = driverPlan
        ? driverPlan.growth + 1
        : ENCODED_OPAQUE_GUARD_GROWTH;
      if (budget.remaining >= guardGrowth && remainingGrowth >= guardGrowth) {
        site = driverPlan
          ? createLiveRailDriver(target, targetIndex, state, factory, `decoy-${sites.length}`, driverPlan)
          : createTopLevelGuard(target, targetIndex, state, factory, `decoy-${sites.length}`);
        if (!budget.trySpend(guardGrowth, 3)) throw new Error('decoy guard budget changed during allocation');
        remainingGrowth -= guardGrowth;
        stats.decoysAdded += driverPlan ? liveGuardObjectGrowth(driverPlan, true) : 3;
        sites.push(site);
        continue;
      }
      const rootCost = chooseDecoyCost(
        rng.fork(`decoy-root-cost-${decoyOrdinal}`),
        Math.min(3, budget.remaining, remainingGrowth)
      );
      const rootId = factory.block(`decoy-root-${sites.length}`);
      target.blocks[rootId] = makeDecoyBlock(
        state,
        rootCost,
        null,
        null,
        true,
        decoyOrdinal,
        vocabulary,
        rng.fork(`decoy-opcode-${decoyOrdinal}`)
      );
      if (!budget.trySpend(rootCost, 3)) throw new Error('decoy root budget changed during allocation');
      remainingGrowth -= rootCost;
      stats.decoysAdded += 1;
      decoyOrdinal += 1;
      site = {targetIndex, guardId: rootId, tailId: rootId, chainDepth: 1, growth: rootCost};
      sites.push(site);
      continue;
    }

    const target = requireTarget(project, site.targetIndex);
    const state = getState(site.targetIndex);
    const maxCost = Math.min(3, budget.remaining, remainingGrowth, maximumSiteGrowth - site.growth);
    const parentId = site.tailId ?? site.guardId;
    const predecessor = requireBlock(target, parentId);
    const useSeparator = mode === 'no-preserve' && isDecoyMutationOpcode(predecessor.opcode);
    const cost = useSeparator ? 1 : chooseDecoyCost(rng.fork(`decoy-cost-${decoyOrdinal}`), maxCost);
    budget.trySpend(cost, 3);
    remainingGrowth -= cost;
    const id = factory.block(`decoy-${site.targetIndex}-${decoyOrdinal}`);
    target.blocks[id] = useSeparator
      ? makePrivateSeparatorBlock(state, parentId, rng.fork(`decoy-separator-${decoyOrdinal}`))
      : makeDecoyBlock(
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
  }
}

function chooseDecoyCost(rng: DeterministicGenerator, maximum: number): 1 | 2 | 3 {
  if (maximum <= 1) return 1;
  return (1 + rng.integer(maximum)) as 1 | 2 | 3;
}

function isDecoyMutationOpcode(opcode: string): opcode is DecoyOpcode {
  return opcode === 'data_addtolist'
    || opcode === 'data_changevariableby'
    || opcode === 'data_deletealloflist'
    || opcode === 'data_deleteoflist'
    || opcode === 'data_insertatlist'
    || opcode === 'data_replaceitemoflist'
    || opcode === 'data_setvariableto';
}

function makePrivateSeparatorBlock(
  state: PrivateState,
  parent: string,
  rng: DeterministicGenerator
): ScratchBlock {
  const hideVariable = rng.integer(2) === 0;
  return {
    opcode: hideVariable ? 'data_hidevariable' : 'data_hidelist',
    next: null,
    parent,
    inputs: {},
    fields: hideVariable
      ? {VARIABLE: [state.variableName, state.variableId]}
      : {LIST: [state.listName, state.listId]},
    shadow: false,
    topLevel: false
  };
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

function blockEquivalentGrowth(block: ScratchBlock): number {
  let growth = 1;
  for (const input of Object.values(block.inputs)) {
    if (Array.isArray(input[1])) growth += 1;
    if (Array.isArray(input[2])) growth += 1;
  }
  return growth;
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

function requireMapItem<K, V>(values: ReadonlyMap<K, V>, key: K, description: string): V {
  const value = values.get(key);
  if (value === undefined) throw new Error(`${description} is unavailable`);
  return value;
}
