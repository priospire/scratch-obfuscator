import {isPrimitive, isScratchBlock} from '../model/blocks.js';
import type {DeterministicGenerator} from '../deterministic.js';
import {
  aggressiveBlockEquivalentCap,
  aggressivePerSiteBlockEquivalentCap
} from '../growth-policy.js';
import type {
  JsonValue,
  ObfuscationMode,
  ObfuscationProgressEvent,
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
  isOfficialHatOpcode,
  isProjectVariableSensed,
  isVirtualizableStackBlock,
  type LinearRunEntryConnector,
  type LinearRun,
  type NumericLiteralSite,
  type RegionEffectSummary,
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

interface FixedListIndexedUsage {
  readonly kind: 'indexed';
  readonly targetIndex: number;
  readonly blockId: string;
  readonly staticIndex: number | null | undefined;
}

interface FixedListLengthUsage {
  readonly kind: 'length';
  readonly targetIndex: number;
  readonly blockId: string;
}

type FixedListUsage = FixedListIndexedUsage | FixedListLengthUsage;

interface FixedListCandidate {
  readonly targetIndex: number;
  readonly id: string;
  readonly name: string;
  readonly values: readonly JsonValue[];
  readonly usages: readonly FixedListUsage[];
  readonly growth: number;
}

interface MutableFixedListCandidate {
  readonly targetIndex: number;
  readonly id: string;
  readonly name: string;
  readonly values: readonly JsonValue[];
  readonly usages: FixedListUsage[];
  safe: boolean;
}

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

interface DispatcherWitnessPlan {
  readonly opcode: string;
  readonly fields: Readonly<Record<string, readonly JsonValue[]>>;
  readonly protectedListId?: string;
  readonly resultBound: boolean;
}

interface DispatcherFrameVariable {
  readonly variableId: string;
  readonly variableName: string;
}

interface DispatcherHandler {
  readonly originalId: string;
  readonly setWitnessId: string;
  readonly witnessModId: string;
  readonly witnessLengthId: string;
  readonly witnessReporterId: string;
  readonly setArmedId: string;
  readonly routeIndex: number;
  readonly witness: DispatcherWitnessPlan;
}

interface DispatcherPacketList {
  readonly listId: string;
  readonly listName: string;
  readonly digitOrder: readonly number[];
}

interface DispatcherPacketDescriptor {
  readonly row: number;
  readonly rho: number;
  readonly routeIndex: number;
  readonly lane: number;
}

interface DispatcherRoutePolynomial {
  readonly slope: number;
}

interface DispatcherExpandedRecord {
  readonly cellIndex: number;
  readonly routeIndex: number;
  readonly handlerIndex: number;
  readonly localSlot: number;
  readonly transitionSlot: number;
  readonly currentLabel: number;
  readonly continuationShare: number;
  readonly salt: number;
  readonly routeSeed?: number;
  readonly producerWords?: readonly [number, number, number];
  readonly baseKeyLeft?: number;
  readonly baseKeyRight?: number;
}

interface DispatcherThreadedRecord {
  readonly nonce: number;
  readonly routeIndex: number;
  readonly handlerIndex: number;
  readonly nextHandlerIndex: number;
  readonly words: readonly [number, number];
}

interface DispatcherThreadedProgram {
  readonly prime: number;
  readonly records: readonly DispatcherThreadedRecord[];
  readonly roundABase: number;
  readonly roundAStep: number;
  readonly roundBBase: number;
  readonly roundBStep: number;
  readonly nonceScale: number;
  readonly wordScale: number;
  readonly handlerScale: number;
  readonly selectedHandlerScale: number;
  readonly stepScale: number;
  readonly terminalScale: number;
  readonly routeCount: number;
  readonly aliasCount: number;
  readonly tagConstants: readonly number[];
  readonly slotConstants: readonly number[];
}

interface DispatcherExpandedBridge {
  readonly program: DispatcherPacketList;
  readonly powers: DispatcherPacketList;
  readonly delimiter: string;
  readonly aliasCount: number;
  readonly records: readonly (readonly DispatcherExpandedRecord[])[];
  readonly fieldMasks: readonly DispatcherExpandedFieldMask[];
  readonly tagCoefficients: readonly number[];
  readonly powerSlots: readonly number[];
  readonly programChecksum: number;
  readonly logicalEntrySeed?: number;
  readonly logicalRecurrenceAdd?: number;
  readonly aliasStride?: number;
  readonly aliasOffset?: number;
  readonly transitionInputStride?: number;
  readonly entryRecord: DispatcherExpandedRecord;
  readonly terminalRecords?: readonly DispatcherExpandedRecord[];
  readonly threadedProgram?: DispatcherThreadedProgram;
}

interface DispatcherExpandedFieldMask {
  readonly indexSlope: number;
  readonly epochSlope: number;
  readonly offset: number;
}

interface DispatcherExpandedAliasHandler {
  readonly routeIndex: number;
  readonly handlerIndex: number;
  readonly localSlot: number;
  readonly currentLabel: number;
  readonly continuationShare: number;
  readonly salt: number;
  readonly routeSeed?: number;
  readonly producerWords?: readonly [number, number, number];
  readonly commandId: string;
}

interface DispatcherPacketScheme {
  readonly modulus: number;
  readonly packetDomain: number;
  readonly descriptors: readonly DispatcherPacketDescriptor[];
  readonly bank0: DispatcherPacketList;
  readonly bank1: DispatcherPacketList;
  readonly routePolynomials: readonly DispatcherRoutePolynomial[];
  readonly routeMaskTemplate: 0 | 1;
  readonly checksum: number;
  readonly expandedBridge?: DispatcherExpandedBridge;
  readonly entry: {
    readonly key: number;
    readonly witness: number;
    readonly rho: number;
    readonly y: number;
  };
}

type DispatcherPacketFrameKey =
  | 'step'
  | 'witness'
  | 'hash'
  | 'key'
  | 'epoch'
  | 'y'
  | 'rho'
  | 'checksum'
  | 'index'
  | 'row'
  | 'word'
  | 'label'
  | 'handler'
  | 'slot'
  | 'continuation'
  | 'salt'
  | 'tag'
  | 'armed';

type DispatcherPacketFrame = Readonly<Record<DispatcherPacketFrameKey, DispatcherFrameVariable>>;

type DispatcherThreadedFrameKey =
  | 'recordIndex'
  | 'wordDomain'
  | 'round'
  | 'word'
  | 'left'
  | 'right'
  | 'mix'
  | 'roundValue'
  | 'temporary'
  | 'matches'
  | 'selectedHandler'
  | 'nextKeyLeft'
  | 'nextKeyRight'
  | 'tagLeft'
  | 'tagRight'
  | 'selectedSlot'
  | 'selectedKeyLeft'
  | 'selectedKeyRight';

type DispatcherThreadedFrame = Readonly<Record<
  DispatcherThreadedFrameKey,
  DispatcherFrameVariable
>>;

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
const ENCODED_DUAL_RAIL_GROWTH = 11;
const DISPATCHER_PACKET_PRIMES = [251, 257, 263, 269] as const;
const DISPATCHER_CHECKSUM_MODULUS = 2_147_483_647;
const DISPATCHER_CHECKSUM_STATE_MODULUS = 1_000_003;
const DISPATCHER_CHECKSUM_BANK_MODULUS = 1_000_033;
const DISPATCHER_CHECKSUM_BANK_OFFSET = 65_537;
const EXPANDED_DISPATCHER_DOMAIN = 257;
const THREADED_RECORD_PRIME = 67_108_859;
const THREADED_RECORD_WORDS = 2;
const THREADED_FEISTEL_ROUNDS = 8;
const MAX_EXPANDED_DISPATCHER_ALIASES = 4;

class GrowthBudget {
  readonly #growth: number;
  readonly #boundaries: readonly [number, number, number, number];
  #spent = 0;
  #stagedSpent = 0;

  constructor(growth: number, mode: AggressiveMode) {
    this.#growth = growth;
    this.#boundaries = mode === 'lossy'
      ? [Math.floor(growth * 0.3), Math.floor(growth * 0.5), Math.floor(growth * 0.8), growth]
      : [Math.floor(growth * 0.55), Math.floor(growth * 0.7), Math.floor(growth * 0.9), growth];
  }

  trySpend(amount: number, stage: 0 | 1 | 2 | 3): boolean {
    const boundary = this.#boundaries[stage];
    if (this.#stagedSpent + amount > boundary || this.#spent + amount > this.#growth) return false;
    this.#stagedSpent += amount;
    this.#spent += amount;
    return true;
  }

  trySpendExpanded(amount: number): boolean {
    if (this.#spent + amount > this.#growth) return false;
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
  stats: ObfuscationStats,
  onProgress?: (event: ObfuscationProgressEvent) => void,
  allowSize = false,
  reservedVariableKeys: ReadonlySet<string> = new Set()
): void {
  const progress = (
    stage: string,
    percentage: number,
    detail: string,
    metrics?: Readonly<Record<string, number | string | boolean>>
  ): void => onProgress?.({stage, percentage, detail, ...(metrics === undefined ? {} : {metrics})});
  progress('analyzing-regions', 0, 'collecting transform candidates and executable-effect constraints');
  const initialEquivalents = countBlockEquivalents(project);
  const cap = aggressiveBlockEquivalentCap(initialEquivalents, mode, allowSize);
  const budget = new GrowthBudget(cap - initialEquivalents, mode);
  const factory = new UniqueFactory(project, rng.fork('aggressive-ids'));
  const decoyVocabulary = collectDecoyVocabulary(project);
  const originalListCandidates = collectFixedListCandidates(project);
  const stringPools = new Map<number, StringPoolState>();
  const privateStates = new Map<number, PrivateState>();
  const decoyStates = new Map<number, PrivateState>();
  const dispatcherWitnessListIds = new Set<string>();
  const variableIsReserved = (candidate: VariableCandidate): boolean => (
    reservedVariableKeys.has(`${candidate.targetIndex}\u0000${candidate.id}`)
  );
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
  const eligibleVariableCandidates = (mode === 'lossy'
    ? filterCertifiedVariableCandidates(project, originalVariableCandidates)
    : originalVariableCandidates).filter(candidate => !variableIsReserved(candidate));
  const eligibleNumericSites = mode === 'lossy'
    ? filterCertifiedInputSites(project, originalNumericSites)
    : originalNumericSites;
  const eligibleStringSites = mode === 'lossy'
    ? filterCertifiedInputSites(project, originalStringSites)
    : originalStringSites;
  const eligibleConditionSites = filterCertifiedConditionSites(project, originalConditionSites, mode);
  const discoveredRuns = collectCertifiedNestedLinearRuns(project, mode, {
    includeProcedureBodies: mode === 'no-preserve'
  });
  const certifiedRuns = mode === 'no-preserve'
    ? discoveredRuns.flatMap(candidate => {
        if (
          !candidate.certificate.eligible
          || candidate.certificate.owningEntry?.reentrant === true
        ) return [];
        const boundedRuns = boundDispatcherRuns(project, candidate.run);
        if (dispatcherWritesArePrivate(
          project,
          candidate.run.targetIndex,
          candidate.run.blockIds,
          candidate.certificate.effects
        )) {
          return boundedRuns.map(run => ({run, certificate: candidate.certificate}));
        }
        const certificates = certifyRegionsEffects(
          project,
          boundedRuns.map(run => ({...run, introducesProcedureFrame: true})),
          mode
        );
        return boundedRuns.flatMap((run, index) => {
          const certificate = certificates[index];
          return certificate?.eligible === true
            && certificate.owningEntry?.reentrant !== true
            && dispatcherWritesArePrivate(
              project,
              run.targetIndex,
              run.blockIds,
              certificate.effects
            )
            ? [{run, certificate}]
            : [];
        });
      })
    : discoveredRuns.filter(candidate => candidate.certificate.eligible);
  progress('analyzing-regions', 8, 'candidate analysis complete', {
    variables: eligibleVariableCandidates.length,
    numbers: eligibleNumericSites.length,
    strings: eligibleStringSites.length,
    conditions: eligibleConditionSites.length,
    linearRuns: certifiedRuns.length
  });

  if (mode === 'lossy') {
    const runs = rng.fork('outline-order').shuffle(certifiedRuns.map(candidate => candidate.run));
    for (const run of runs) {
      if (!budget.trySpend(3, 0)) continue;
      outlineRun(project, run, factory);
    }
  }
  progress('outlining-control-flow', 16, mode === 'lossy'
    ? 'eligible non-yielding runs outlined'
    : 'procedure outlining replaced by authenticated dispatch in this mode');

  if (mode === 'no-preserve') {
    let expandedDispatcherEmitted = false;
    const runs = rng.fork('run-order').shuffle(certifiedRuns.map(candidate => candidate.run));
    const compactGrowthReservations = allowSize
      ? runs.map((run, index): number | undefined => {
          const target = requireTarget(project, run.targetIndex);
          const witnesses = collectDispatcherWitnessPlans(target, run.blockIds);
          if (witnesses.some(witness => !witness.resultBound)) return undefined;
          const candidateTarget = structuredClone(target);
          const candidateProject: ScratchProject = {
            ...project,
            targets: project.targets.map((candidate, targetIndex) => (
              targetIndex === run.targetIndex ? candidateTarget : candidate
            ))
          };
          const beforeFragment = countBlockEquivalents(candidateProject);
          fragmentRun(
            candidateProject,
            run,
            witnesses,
            new UniqueFactory(candidateProject, rng.fork(`compact-reservation-ids-${index}`)),
            rng.fork(`run-${index}`).fork('compact-fallback'),
            0
          );
          const growth = countBlockEquivalents(candidateProject) - beforeFragment;
          const siteCap = aggressivePerSiteBlockEquivalentCap(mode, allowSize)
            * Math.ceil(run.blockIds.length / 4);
          return growth >= 0 && growth <= siteCap ? growth : undefined;
        })
      : [];
    const reservedCompactGrowth = (startIndex: number, available: number): number => {
      let reserved = 0;
      for (let index = startIndex; index < compactGrowthReservations.length; index += 1) {
        const growth = compactGrowthReservations[index];
        if (growth === undefined || reserved + growth > available) continue;
        reserved += growth;
      }
      return reserved;
    };
    for (const [index, run] of runs.entries()) {
      const target = requireTarget(project, run.targetIndex);
      for (const blockId of run.blockIds) requireBlock(target, blockId);
      const witnesses = collectDispatcherWitnessPlans(target, run.blockIds);
      if (witnesses.some(witness => !witness.resultBound)) continue;
      const runRng = rng.fork(`run-${index}`);
      const siteCount = Math.ceil(run.blockIds.length / 4);
      const dispatcherSiteCap = aggressivePerSiteBlockEquivalentCap(mode, allowSize);
      const buildDraft = (expandedAliasCount: number): {
        readonly target: ScratchTarget;
        readonly dispatcherGrowth: number;
        readonly growth: number;
        readonly expanded: boolean;
      } => {
        const candidateTarget = structuredClone(target);
        const candidateProject: ScratchProject = {
          ...project,
          targets: project.targets.map((candidate, targetIndex) => (
            targetIndex === run.targetIndex ? candidateTarget : candidate
          ))
        };
        const beforeFragment = countBlockEquivalents(candidateProject);
        fragmentRun(
          candidateProject,
          run,
          witnesses,
          factory,
          expandedAliasCount > 0
            ? runRng.fork(`expanded-aliases-${expandedAliasCount}`)
            : (allowSize ? runRng.fork('compact-fallback') : runRng),
          expandedAliasCount
        );
        const dispatcherGrowth = countBlockEquivalents(candidateProject) - beforeFragment;
        return {
          target: candidateTarget,
          dispatcherGrowth,
          growth: dispatcherGrowth,
          expanded: expandedAliasCount > 0
        };
      };
      let draft: ReturnType<typeof buildDraft> | undefined;
      if (
        allowSize
        && !expandedDispatcherEmitted
        && run.blockIds.every(blockId => expandedAliasCloneEligible(target, blockId))
      ) {
        const compactGrowth = compactGrowthReservations[index];
        const reservedGrowth = reservedCompactGrowth(index, budget.remaining);
        const maximumGrowthWithoutDisplacingCompact = compactGrowth === undefined
          ? 0
          : compactGrowth + (budget.remaining - reservedGrowth);
        const fitsExpandedBudget = (candidate: ReturnType<typeof buildDraft>): boolean => (
          candidate.dispatcherGrowth >= 0
          && candidate.growth <= dispatcherSiteCap * siteCount
          && candidate.growth <= budget.remaining
          && candidate.growth <= maximumGrowthWithoutDisplacingCompact
        );
        for (
          let aliasCount = MAX_EXPANDED_DISPATCHER_ALIASES;
          aliasCount >= MIN_EXPANDED_DISPATCHER_ALIASES && draft === undefined;
          aliasCount -= 1
        ) {
          const universal = buildDraft(aliasCount);
          if (fitsExpandedBudget(universal)) draft = universal;
        }
      }
      draft ??= buildDraft(0);
      if (draft.dispatcherGrowth < 0 || draft.growth > dispatcherSiteCap * siteCount) continue;
      const budgetAccepted = allowSize
        ? budget.trySpendExpanded(draft.growth)
        : budget.trySpend(draft.growth, 0);
      if (!budgetAccepted) continue;
      project.targets[run.targetIndex] = draft.target;
      if (draft.expanded) expandedDispatcherEmitted = true;
      for (const witness of witnesses) {
        if (witness.protectedListId !== undefined) dispatcherWitnessListIds.add(witness.protectedListId);
      }
      stats.virtualizedBlocks += run.blockIds.length;
    }
  }
  progress('virtualizing-control-flow', 28, mode === 'no-preserve'
    ? 'eligible linear runs routed through authenticated dispatchers'
    : 'control-flow virtualization is disabled in lossy mode', {
    virtualizedBlocks: stats.virtualizedBlocks
  });

  if (originalListCandidates.length > 0) {
    const listSiteCap = aggressivePerSiteBlockEquivalentCap(mode, allowSize);
    const selectedListCandidates = rng.fork('fixed-list-order').shuffle(
      originalListCandidates.filter(candidate => !dispatcherWitnessListIds.has(candidate.id))
    ).filter(candidate => (
      candidate.growth <= listSiteCap
      && budget.trySpend(candidate.growth, 1)
    ));
    const packed = packFixedLists(
      project,
      selectedListCandidates,
      getState,
      factory,
      mode,
      rng.fork('fixed-list-heap')
    );
    stats.listsVirtualized = (stats.listsVirtualized ?? 0) + packed;
  }
  progress('virtualizing-lists', 38, 'eligible fixed lists packed into shuffled private storage', {
    packedLists: stats.listsVirtualized ?? 0,
    candidates: originalListCandidates.length
  });

  if (eligibleVariableCandidates.length > 0) {
    const originalVariableKeys = new Set(originalVariableCandidates.map(candidate => (
      `${candidate.targetIndex}\u0000${candidate.id}`
    )));
    const refreshedVariableCandidates = mode === 'no-preserve'
      ? collectVariableCandidates(project).filter(candidate => (
          originalVariableKeys.has(`${candidate.targetIndex}\u0000${candidate.id}`)
          && !variableIsReserved(candidate)
        ))
      : eligibleVariableCandidates;
    const variables = rng.fork('variable-order').shuffle(refreshedVariableCandidates);
    const selected: SelectedVariable[] = [];
    for (const [index, candidate] of variables.entries()) {
      const variableSiteCap = aggressivePerSiteBlockEquivalentCap(mode, allowSize);
      if (candidate.estimatedGrowth > variableSiteCap) continue;
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
  progress('virtualizing-variables', 50, 'eligible scalar variables packed into private list slots', {
    packedVariables: stats.variablesVirtualized ?? 0,
    candidates: eligibleVariableCandidates.length
  });

  const numericSites = rng.fork('numeric-order').shuffle(eligibleNumericSites);
  for (const [index, site] of numericSites.entries()) {
    if (!blockAt(requireTarget(project, site.targetIndex), site.ownerId)) continue;
    if (!budget.trySpend(site.growth, 1)) continue;
    encodeNumericLiteral(project, site, factory, rng.fork(`numeric-${index}`), poisonRng);
  }
  progress('encoding-numbers', 59, 'eligible numeric literals replaced with exact-domain expressions', {
    candidates: numericSites.length
  });

  const stringSites = rng.fork('literal-order').shuffle(eligibleStringSites);
  for (const [index, site] of stringSites.entries()) {
    const target = requireTarget(project, site.targetIndex);
    const owner = blockAt(target, site.ownerId);
    if (!owner) continue;
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
  progress('encoding-strings', 68, 'eligible strings split or pooled behind indirection', {
    candidates: stringSites.length,
    pools: stringPools.size
  });

  for (const [index, site] of rng.fork('condition-order').shuffle(eligibleConditionSites).entries()) {
    if (!blockAt(requireTarget(project, site.targetIndex), site.blockId)) continue;
    if (!budget.trySpend(site.growth, 2)) continue;
    invertCondition(project, site, factory, `condition-${index}`);
  }
  progress('rewriting-branches', 75, 'eligible branches inverted behind equivalent conditions', {
    candidates: eligibleConditionSites.length
  });


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
  progress('installing-dual-rails', 83, 'state transitions coupled to encoded dual-rail checks', {
    candidates: dualRailEdges.length
  });

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
  progress('installing-integrity-guards', 90, 'opaque and live integrity guards installed', {
    guards: guards.length
  });

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
    stats,
    aggressivePerSiteBlockEquivalentCap(mode, allowSize)
  );
  progress('building-decoy-graphs', 95, 'coherent project-shaped decoy subsystems generated', {
    decoyBlocks: stats.decoysAdded
  });

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
    stats,
    aggressivePerSiteBlockEquivalentCap(mode, allowSize)
  );
  progress('filling-decoy-budget', 99, 'remaining bounded growth allocated to decoy graphs', {
    decoyBlocks: stats.decoysAdded
  });
  stats.blocksAfter = countObjectBlocks(project);

  const finalEquivalents = countBlockEquivalents(project);
  if (finalEquivalents > cap) {
    throw new Error(`aggressive transform exceeded its block-equivalent cap (${finalEquivalents} > ${cap})`);
  }
  progress('aggressive-transforms-complete', 100, 'bounded structural transforms complete', {
    blockEquivalents: finalEquivalents,
    cap
  });
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

function dispatcherWritesArePrivate(
  project: ScratchProject,
  executionTargetIndex: number,
  runBlockIds: readonly string[],
  effects: RegionEffectSummary
): boolean {
  const executionTarget = project.targets[executionTargetIndex];
  if (!executionTarget) return false;
  const ownedBlockIds = collectDispatcherOwnedBlockIds(executionTarget, runBlockIds);
  const writes = [...effects.variableWrites, ...effects.listWrites];
  for (const write of writes) {
    if (write.targetIndex !== executionTargetIndex || write.scope === 'unresolved') return false;
    const declarations = write.kind === 'variable' ? executionTarget.variables : executionTarget.lists;
    const declaration = declarations[write.id];
    if (!declaration) return false;
    if (write.kind === 'variable' && declaration.length === 3 && declaration[2] === true) return false;
    if (write.kind === 'variable' && isProjectVariableSensed(project, write.targetIndex, write.id)) return false;
    if (isMonitoredDispatcherSymbol(project, executionTarget, write.kind, write.id)) return false;
    if (targetReferencesDispatcherSymbol(executionTarget, write.kind, write.id, ownedBlockIds)) return false;
    if (executionTarget.isStage && project.targets.some((target, targetIndex) => {
      if (targetIndex === executionTargetIndex) return false;
      const localDeclarations = write.kind === 'variable' ? target.variables : target.lists;
      if (localDeclarations[write.id] !== undefined) return false;
      return targetReferencesDispatcherSymbol(target, write.kind, write.id);
    })) return false;
  }
  return true;
}

function collectDispatcherOwnedBlockIds(
  target: ScratchTarget,
  runBlockIds: readonly string[]
): ReadonlySet<string> {
  const owned = new Set(runBlockIds);
  const visitInput = (input: ScratchInput): void => {
    for (let index = 1; index < input.length; index += 1) {
      const blockId = input[index];
      if (typeof blockId !== 'string' || owned.has(blockId) || target.blocks[blockId] === undefined) continue;
      owned.add(blockId);
      const block = target.blocks[blockId];
      if (!isScratchBlock(block)) continue;
      for (const nested of Object.values(block.inputs)) visitInput(nested);
    }
  };
  for (const blockId of runBlockIds) {
    const block = target.blocks[blockId];
    if (!isScratchBlock(block)) continue;
    for (const input of Object.values(block.inputs)) visitInput(input);
  }
  return owned;
}

function isMonitoredDispatcherSymbol(
  project: ScratchProject,
  target: ScratchTarget,
  kind: 'variable' | 'list',
  id: string
): boolean {
  const opcode = kind === 'variable' ? 'data_variable' : 'data_listcontents';
  return project.monitors.some(monitor => {
    if (monitor['opcode'] !== opcode || monitor['id'] !== id) return false;
    const spriteName = monitor['spriteName'];
    if (target.isStage) {
      if (typeof spriteName !== 'string' || spriteName.length === 0) return true;
      const requestedTarget = project.targets.find(candidate => !candidate.isStage && candidate.name === spriteName);
      if (!requestedTarget) return true;
      const localDeclarations = kind === 'variable' ? requestedTarget.variables : requestedTarget.lists;
      return localDeclarations[id] === undefined;
    }
    return spriteName === target.name;
  });
}

function targetReferencesDispatcherSymbol(
  target: ScratchTarget,
  kind: 'variable' | 'list',
  id: string,
  ignoredBlockIds: ReadonlySet<string> = new Set()
): boolean {
  const fieldName = kind === 'variable' ? 'VARIABLE' : 'LIST';
  const primitiveCode = kind === 'variable' ? 12 : 13;
  const inputReferences = (input: ScratchInput): boolean => {
    for (let index = 1; index < input.length; index += 1) {
      const value = input[index];
      if (Array.isArray(value) && value[0] === primitiveCode && value[2] === id) return true;
    }
    return false;
  };
  for (const [blockId, value] of Object.entries(target.blocks)) {
    if (ignoredBlockIds.has(blockId)) continue;
    if (isPrimitive(value)) {
      if (value[0] === primitiveCode && value[2] === id) return true;
      continue;
    }
    if (!isScratchBlock(value)) continue;
    if (value.fields[fieldName]?.[1] === id) return true;
    if (Object.values(value.inputs).some(inputReferences)) return true;
  }
  return false;
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
      if (value.opcode === 'data_lengthoflist') {
        candidate.usages.push({kind: 'length', targetIndex: usageTargetIndex, blockId});
      } else {
        candidate.usages.push({
          kind: 'indexed',
          targetIndex: usageTargetIndex,
          blockId,
          staticIndex: staticListIndex(value.inputs['INDEX'], candidate.values.length)
        });
      }
    }
  }

  return mutable.flatMap(candidate => candidate.safe && candidate.usages.length > 0 ? [{
    targetIndex: candidate.targetIndex,
    id: candidate.id,
    name: candidate.name,
    values: candidate.values,
    usages: candidate.usages,
    growth: candidate.usages.filter(usage => usage.kind === 'indexed' && usage.staticIndex === undefined).length
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
  if (block.opcode === 'data_lengthoflist') return block.next === null && inputs.length === 0;
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
  factory: UniqueFactory,
  mode: AggressiveMode,
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
      const logicalSlots = candidate.values.map((_, offset) => {
        const slot = slots.get(`${candidate.id}\u0000${offset + 1}`);
        if (slot === undefined) throw new Error('fixed list heap is missing an element slot');
        return slot;
      });
      const mapId = factory.symbol('l_', `fixed-list-map-${candidate.targetIndex}-${candidate.id}`);
      const mapName = factory.name(mode, `fixed-list-map-${candidate.targetIndex}-${candidate.id}`);
      target.lists[mapId] = [mapName, logicalSlots];
      for (const usage of candidate.usages) {
        const usageTarget = requireTarget(project, usage.targetIndex);
        const block = requireBlock(usageTarget, usage.blockId);
        if (usage.kind === 'length') {
          block.fields = {LIST: [mapName, mapId]};
          continue;
        }
        block.fields = {LIST: [state.listName, state.listId]};
        if (usage.staticIndex !== undefined) {
          const slot = usage.staticIndex === null ? 0 : logicalSlots[usage.staticIndex - 1];
          if (slot === undefined) throw new Error('fixed list heap is missing a static element slot');
          block.inputs['INDEX'] = numericInput(slot);
          continue;
        }
        const logicalIndex = block.inputs['INDEX'];
        if (!logicalIndex) throw new Error('dynamic fixed list access is missing its INDEX input');
        const mapReporterId = factory.block(
          `fixed-list-map-read-${candidate.targetIndex}-${usage.targetIndex}-${candidate.id}-${usage.blockId}`
        );
        reparentInputReferences(usageTarget, logicalIndex, mapReporterId);
        usageTarget.blocks[mapReporterId] = {
          opcode: 'data_itemoflist',
          next: null,
          parent: usage.blockId,
          inputs: {INDEX: logicalIndex},
          fields: {LIST: [mapName, mapId]},
          shadow: false,
          topLevel: false
        };
        block.inputs['INDEX'] = [2, mapReporterId];
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

function collectDispatcherWitnessPlans(
  target: ScratchTarget,
  blockIds: readonly string[]
): DispatcherWitnessPlan[] {
  return blockIds.map(blockId => dispatcherWitnessPlan(target, requireBlock(target, blockId)));
}

function dispatcherWitnessPlan(target: ScratchTarget, block: ScratchBlock): DispatcherWitnessPlan {
  if (block.opcode === 'data_setvariableto' || block.opcode === 'data_changevariableby') {
    const field = block.fields['VARIABLE'];
    const id = field?.[1];
    if (field && typeof id === 'string') {
      return {opcode: 'data_variable', fields: {VARIABLE: [...field]}, resultBound: true};
    }
  }
  if (
    block.opcode === 'data_addtolist'
    || block.opcode === 'data_deletealloflist'
    || block.opcode === 'data_deleteoflist'
    || block.opcode === 'data_insertatlist'
    || block.opcode === 'data_replaceitemoflist'
  ) {
    const field = block.fields['LIST'];
    const id = field?.[1];
    if (field && typeof id === 'string') {
      return {opcode: 'data_listcontents', fields: {LIST: [...field]}, protectedListId: id, resultBound: true};
    }
  }
  if (!target.isStage) {
    if (
      block.opcode === 'motion_changexby'
      || block.opcode === 'motion_ifonedgebounce'
      || block.opcode === 'motion_movesteps'
      || block.opcode === 'motion_setx'
    ) return {opcode: 'motion_xposition', fields: {}, resultBound: true};
    if (block.opcode === 'motion_changeyby' || block.opcode === 'motion_sety') {
      return {opcode: 'motion_yposition', fields: {}, resultBound: true};
    }
    if (
      block.opcode === 'motion_pointindirection'
      || block.opcode === 'motion_turnleft'
      || block.opcode === 'motion_turnright'
    ) return {opcode: 'motion_direction', fields: {}, resultBound: true};
    if (block.opcode === 'looks_changesizeby' || block.opcode === 'looks_setsizeto') {
      return {opcode: 'looks_size', fields: {}, resultBound: true};
    }
    if (block.opcode === 'looks_nextcostume' || block.opcode === 'looks_switchcostumeto') {
      return {opcode: 'looks_costumenumbername', fields: {NUMBER_NAME: ['number', null]}, resultBound: true};
    }
  }
  if (block.opcode === 'looks_nextbackdrop' || block.opcode === 'looks_switchbackdropto') {
    return {opcode: 'looks_backdropnumbername', fields: {NUMBER_NAME: ['number', null]}, resultBound: true};
  }
  if (block.opcode === 'sound_changevolumeby' || block.opcode === 'sound_setvolumeto') {
    return {opcode: 'sound_volume', fields: {}, resultBound: true};
  }
  return target.isStage
    ? {opcode: 'looks_backdropnumbername', fields: {NUMBER_NAME: ['number', null]}, resultBound: false}
    : {opcode: 'motion_xposition', fields: {}, resultBound: false};
}

function expandedCommandInputGraphIds(target: ScratchTarget, rootId: string): Set<string> {
  const collected = new Set<string>();
  const visit = (blockId: string): void => {
    if (collected.has(blockId)) return;
    const block = target.blocks[blockId];
    if (block === undefined) throw new Error('expanded command input graph is incomplete');
    collected.add(blockId);
    if (!isScratchBlock(block)) return;
    for (const input of Object.values(block.inputs)) {
      for (const value of [input[1], input[2]]) {
        if (typeof value !== 'string') continue;
        const child = target.blocks[value];
        if (child !== undefined) visit(value);
      }
    }
  };
  visit(rootId);
  return collected;
}

function expandedAliasCloneEligible(target: ScratchTarget, rootId: string): boolean {
  let ids: ReadonlySet<string>;
  try {
    ids = expandedCommandInputGraphIds(target, rootId);
  } catch {
    return false;
  }
  for (const blockId of ids) {
    const block = target.blocks[blockId];
    if (block === undefined) return false;
    if (!isScratchBlock(block)) continue;
    if (block.mutation !== undefined) return false;
    if (blockId !== rootId && block.next !== null) return false;
    if (blockId === rootId) continue;
    if (block.opcode === 'operator_random' || block.opcode.startsWith('sensing_')) return false;
    if (
      !block.shadow
      && !block.opcode.startsWith('operator_')
      && !block.opcode.startsWith('data_')
      && !block.opcode.startsWith('motion_')
      && !block.opcode.startsWith('looks_')
      && !block.opcode.startsWith('sound_')
    ) return false;
  }
  return true;
}

function cloneExpandedCommandInputGraph(
  target: ScratchTarget,
  sourceRootId: string,
  cloneRootId: string,
  factory: UniqueFactory,
  domain: string
): void {
  const clonedIds = new Map<string, string>([[sourceRootId, cloneRootId]]);
  let ordinal = 0;
  const cloneBlock = (sourceId: string, parentId: string | null): string => {
    const existing = clonedIds.get(sourceId);
    if (existing !== undefined && sourceId !== sourceRootId) return existing;
    const cloneId = sourceId === sourceRootId
      ? cloneRootId
      : factory.block(`${domain}-input-${ordinal++}`);
    clonedIds.set(sourceId, cloneId);
    const source = target.blocks[sourceId];
    if (source === undefined) throw new Error('expanded clone source is unavailable');
    if (!isScratchBlock(source)) {
      target.blocks[cloneId] = structuredClone(source);
      return cloneId;
    }
    const clone = structuredClone(source);
    clone.next = null;
    clone.parent = parentId;
    clone.topLevel = false;
    delete clone.x;
    delete clone.y;
    clone.inputs = Object.fromEntries(Object.entries(source.inputs).map(([name, input]) => {
      const clonedInput = structuredClone(input);
      for (const position of [1, 2]) {
        const value = clonedInput[position];
        if (typeof value !== 'string') continue;
        const child = target.blocks[value];
        if (child !== undefined) {
          clonedInput[position] = cloneBlock(value, cloneId);
        }
      }
      return [name, clonedInput];
    }));
    target.blocks[cloneId] = clone;
    return cloneId;
  };
  cloneBlock(sourceRootId, null);
}

function fragmentRun(
  project: ScratchProject,
  run: ConnectableLinearRun,
  witnesses: readonly DispatcherWitnessPlan[],
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  expandedAliasCount: number
): void {
  const target = requireTarget(project, run.targetIndex);
  const firstId = requireItem(run.blockIds, 0, 'dispatcher run');
  if (witnesses.length !== run.blockIds.length) throw new Error('dispatcher witness plan is incomplete');
  const domain = `dispatcher-packet-${run.targetIndex}-${firstId}`;
  const scheme = makeDispatcherPacketScheme(
    target,
    run.blockIds.length,
    factory,
    rng.fork('packet-scheme'),
    domain,
    expandedAliasCount
  );
  const initialValues: Readonly<Record<DispatcherPacketFrameKey, number>> = {
    step: 0,
    witness: scheme.entry.witness,
    hash: 0,
    key: scheme.entry.key,
    epoch: scheme.entry.key,
    y: scheme.entry.y,
    rho: scheme.entry.rho,
    checksum: 0,
    index: 1,
    row: 0,
    word: 0,
    label: 0,
    handler: 0,
    slot: 0,
    continuation: 0,
    salt: 0,
    tag: 0,
    armed: 0
  };
  const frame = Object.fromEntries(
    (Object.keys(initialValues) as DispatcherPacketFrameKey[]).map(key => [key, {
      variableId: factory.symbol('v_', `${domain}-${key}`),
      variableName: factory.name('no-preserve', `${domain}-${key}`)
    }])
  ) as DispatcherPacketFrame;
  const declarations = (Object.keys(initialValues) as DispatcherPacketFrameKey[]).map(key => ({
    variable: frame[key],
    value: initialValues[key]
  }));
  for (const declaration of rng.fork('variable-declaration-order').shuffle(declarations)) {
    target.variables[declaration.variable.variableId] = [
      declaration.variable.variableName,
      declaration.value
    ];
  }

  const existingCodes = collectProcedureCodes(target);
  const makeCode = (label: string, ordinal: number): string => {
    let code = makeInvisibleDisplayName(rng.fork(label), ordinal);
    for (let suffix = 0; existingCodes.has(code); suffix += 1) {
      code += suffix % 2 === 0 ? '\u200b' : '\u2060';
    }
    existingCodes.add(code);
    return code;
  };
  const dispatcherCode = makeCode('dispatcher-code', run.blockIds.length + 1);
  const dispatcherDefinitionId = factory.block(`${domain}-definition`);
  const dispatcherPrototypeId = factory.block(`${domain}-prototype`);
  const handlers: DispatcherHandler[] = run.blockIds.map((originalId, routeIndex) => ({
    originalId,
    setWitnessId: factory.block(`${domain}-leaf-witness-${routeIndex}`),
    witnessModId: factory.block(`${domain}-leaf-witness-mod-${routeIndex}`),
    witnessLengthId: factory.block(`${domain}-leaf-witness-length-${routeIndex}`),
    witnessReporterId: factory.block(`${domain}-leaf-witness-reporter-${routeIndex}`),
    setArmedId: factory.block(`${domain}-leaf-armed-${routeIndex}`),
    routeIndex,
    witness: requireItem(witnesses, routeIndex, 'dispatcher witness')
  }));
  if (scheme.expandedBridge === undefined) {
    for (const handler of rng.fork('leaf-emission-order').shuffle(handlers)) {
      const original = requireBlock(target, handler.originalId);
      original.topLevel = false;
      delete original.x;
      delete original.y;
      original.parent = null;
      original.next = handler.setWitnessId;
      target.blocks[handler.setWitnessId] = {
        opcode: 'data_setvariableto',
        next: handler.setArmedId,
        parent: handler.originalId,
        inputs: {VALUE: [2, handler.witnessModId]},
        fields: {VARIABLE: [frame.witness.variableName, frame.witness.variableId]},
        shadow: false,
        topLevel: false
      };
      addDispatcherWitnessBucket(target, handler, scheme.modulus);
      target.blocks[handler.setArmedId] = {
        opcode: 'data_setvariableto',
        next: null,
        parent: handler.setWitnessId,
        inputs: {VALUE: [1, [12, frame.y.variableName, frame.y.variableId]]},
        fields: {VARIABLE: [frame.armed.variableName, frame.armed.variableId]},
        shadow: false,
        topLevel: false
      };
    }
  }

  if (scheme.expandedBridge !== undefined) {
    emitExpandedDispatcher(
      target,
      run,
      handlers,
      frame,
      scheme,
      dispatcherDefinitionId,
      dispatcherPrototypeId,
      dispatcherCode,
      factory,
      rng.fork('expanded-dispatcher'),
      domain
    );
    return;
  }

  emitPacketDispatcherProcedure(
    target,
    run,
    handlers,
    frame,
    scheme,
    dispatcherDefinitionId,
    dispatcherPrototypeId,
    dispatcherCode,
    factory,
    rng.fork('dispatcher-procedure'),
    domain
  );
  emitPacketDispatcherEntry(
    target,
    run,
    frame,
    scheme,
    dispatcherCode,
    factory,
    domain
  );
}

function emitExpandedDispatcher(
  target: ScratchTarget,
  run: ConnectableLinearRun,
  handlers: readonly DispatcherHandler[],
  frame: DispatcherPacketFrame,
  scheme: DispatcherPacketScheme,
  definitionId: string,
  prototypeId: string,
  dispatcherCode: string,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string
): void {
  const bridge = scheme.expandedBridge;
  if (bridge === undefined) throw new Error('expanded dispatcher bridge is unavailable');
  const aliases = makeTransientExpandedAliasHandlers(
    target,
    handlers,
    frame,
    bridge,
    factory,
    rng.fork('transient-alias-handlers'),
    `${domain}-transient-aliases`
  );
  emitTransientExpandedDispatcherProcedure(
    target,
    run,
    aliases,
    frame,
    bridge,
    definitionId,
    prototypeId,
    dispatcherCode,
    factory,
    rng.fork('transient-body'),
    `${domain}-transient-body`
  );
  emitTransientExpandedDispatcherEntry(
    target,
    run,
    frame,
    scheme,
    bridge,
    dispatcherCode,
    factory,
    `${domain}-transient-entry`
  );
}

function emitDispatcherReplaceListItem(
  target: ScratchTarget,
  id: string,
  parent: string | null,
  next: string | null,
  list: DispatcherPacketList,
  index: DispatcherExpression,
  value: DispatcherExpression,
  factory: UniqueFactory,
  domain: string
): void {
  target.blocks[id] = {
    opcode: 'data_replaceitemoflist',
    next,
    parent,
    inputs: {
      INDEX: emitDispatcherExpression(target, id, index, factory, `${domain}-index`),
      ITEM: emitDispatcherExpression(target, id, value, factory, `${domain}-value`)
    },
    fields: {LIST: [list.listName, list.listId]},
    shadow: false,
    topLevel: false
  };
}

const TRANSIENT_EXPANDED_STATE_CELLS = 7;
const MIN_EXPANDED_DISPATCHER_ALIASES = 4;

function threadedCanonical(value: DispatcherExpression): DispatcherExpression {
  return dispatcherMod(
    dispatcherAdd(
      dispatcherMod(value, THREADED_RECORD_PRIME),
      dispatcherNumber(THREADED_RECORD_PRIME)
    ),
    THREADED_RECORD_PRIME
  );
}

function threadedProduct(
  left: DispatcherExpression,
  right: DispatcherExpression
): DispatcherExpression {
  return dispatcherMod(dispatcherMultiply(left, right), THREADED_RECORD_PRIME);
}

function threadedSum(...values: readonly DispatcherExpression[]): DispatcherExpression {
  if (values.length === 0) return dispatcherNumber(0);
  let result = requireItem(values, 0, 'threaded sum operand');
  for (let index = 1; index < values.length; index += 1) {
    const value = requireItem(values, index, 'threaded sum operand');
    result = dispatcherMod(dispatcherAdd(result, value), THREADED_RECORD_PRIME);
  }
  return result;
}

function threadedTagMixExpression(
  left: DispatcherExpression,
  right: DispatcherExpression,
  constant: number
): DispatcherExpression {
  return threadedSum(
    threadedProduct(left, right),
    dispatcherNumber(threadedField(BigInt(constant)))
  );
}

function threadedRecordTagContextExpression(
  frame: DispatcherPacketFrame,
  threaded: DispatcherThreadedFrame,
  program: DispatcherThreadedProgram
): DispatcherExpression {
  const variable = dispatcherVariable;
  const constant = (index: number): number => requireItem(
    program.tagConstants,
    index,
    'threaded runtime tag constant'
  );
  const nextStep = threadedSum(variable(frame.step), dispatcherNumber(1));
  const terminal = dispatcherEquals(nextStep, dispatcherNumber(program.routeCount));
  const multiplier = dispatcherNumber(constant(1));
  let context = threadedSum(variable(threaded.recordIndex), dispatcherNumber(constant(0)));
  for (const value of [
    threadedSum(variable(frame.handler), dispatcherNumber(1)),
    threadedSum(variable(threaded.selectedHandler), dispatcherNumber(1)),
    variable(frame.step),
    nextStep,
    terminal
  ]) {
    context = threadedSum(threadedProduct(context, multiplier), value);
  }
  return threadedSum(context, dispatcherNumber(constant(2)));
}

type ThreadedPairExpressions = readonly [DispatcherExpression, DispatcherExpression];

function threadedRecordTagExpressions(
  frame: DispatcherPacketFrame,
  threaded: DispatcherThreadedFrame,
  program: DispatcherThreadedProgram
): ThreadedPairExpressions {
  const variable = dispatcherVariable;
  const constant = (index: number): number => requireItem(
    program.tagConstants,
    index,
    'threaded runtime tag constant'
  );
  const left = threadedSum(
    threadedProduct(
      threadedSum(
        variable(frame.label),
        variable(threaded.nextKeyLeft),
        variable(threaded.mix)
      ),
      threadedSum(
        variable(frame.continuation),
        variable(threaded.nextKeyRight),
        variable(threaded.mix)
      )
    ),
    dispatcherNumber(constant(3))
  );
  const right = threadedSum(
    threadedProduct(
      threadedSum(
        variable(frame.label),
        variable(threaded.nextKeyRight),
        variable(threaded.mix)
      ),
      threadedSum(
        variable(frame.continuation),
        variable(threaded.nextKeyLeft),
        variable(threaded.mix),
        variable(threaded.recordIndex)
      )
    ),
    dispatcherNumber(constant(4))
  );
  return [left, right];
}

function threadedSlotExpression(
  keyLeft: DispatcherExpression,
  keyRight: DispatcherExpression,
  step: DispatcherExpression,
  handler: DispatcherExpression,
  program: DispatcherThreadedProgram
): DispatcherExpression {
  const constant = (index: number): DispatcherExpression => dispatcherNumber(requireItem(
    program.slotConstants,
    index,
    'threaded runtime slot constant'
  ));
  const stateOrdinal = threadedSum(
    threadedProduct(step, dispatcherNumber(program.aliasCount)),
    handler,
    dispatcherNumber(1)
  );
  const slotField = threadedSum(
    threadedProduct(keyLeft, keyRight),
    threadedProduct(stateOrdinal, constant(0)),
    constant(1)
  );
  return dispatcherAdd(
    dispatcherNumber(1),
    dispatcherMod(slotField, THREADED_RECORD_PRIME - 1)
  );
}

function threadedStateTag(
  frame: DispatcherPacketFrame,
  bridge: DispatcherExpandedBridge
): DispatcherExpression {
  const variable = dispatcherVariable;
  const coefficient = (index: number): number => requireItem(
    bridge.tagCoefficients,
    index,
    'threaded state tag coefficient'
  );
  return threadedSum(
    threadedProduct(
      threadedSum(
        variable(frame.handler), variable(frame.slot), variable(frame.label),
        variable(frame.salt), variable(frame.key), variable(frame.step),
        dispatcherNumber(coefficient(0))
      ),
      threadedSum(
        variable(frame.continuation), variable(frame.row), variable(frame.hash),
        dispatcherNumber(coefficient(1))
      )
    ),
    threadedProduct(
      threadedSum(variable(frame.label), variable(frame.row), dispatcherNumber(coefficient(2))),
      threadedSum(
        variable(frame.continuation), variable(frame.salt), dispatcherNumber(coefficient(3))
      )
    ),
    dispatcherNumber(coefficient(4))
  );
}

function threadedRawAuthority(
  frame: DispatcherPacketFrame,
  bridge: DispatcherExpandedBridge,
  tag: DispatcherExpression = threadedStateTag(frame, bridge)
): DispatcherExpression {
  return dispatcherJoin(
    dispatcherVariable(frame.witness),
    dispatcherJoin(dispatcherString(bridge.delimiter), tag)
  );
}

function threadedHandlerAuthority(
  frame: DispatcherPacketFrame,
  bridge: DispatcherExpandedBridge
): DispatcherExpression {
  const variable = dispatcherVariable;
  const coefficient = (index: number): number => requireItem(
    bridge.tagCoefficients,
    index,
    'threaded handler authority coefficient'
  );
  return threadedSum(
    threadedProduct(
      threadedSum(variable(frame.handler), variable(frame.label), dispatcherNumber(coefficient(5))),
      threadedSum(variable(frame.slot), variable(frame.continuation), dispatcherNumber(coefficient(6)))
    ),
    threadedProduct(
      threadedSum(variable(frame.salt), variable(frame.step), dispatcherNumber(coefficient(7))),
      threadedSum(variable(frame.row), variable(frame.key), dispatcherNumber(coefficient(8)))
    )
  );
}

function threadedTimerNonce(): DispatcherExpression {
  return threadedCanonical(dispatcherRound(dispatcherMultiply(
    dispatcherOperator('sensing_timer', {}),
    dispatcherNumber(1_000)
  )));
}

function threadedWitnessMix(frame: DispatcherPacketFrame): DispatcherExpression {
  const witness = dispatcherVariable(frame.witness);
  const boundedLength = threadedCanonical(dispatcherLength(witness));
  return threadedSum(
    threadedProduct(boundedLength, dispatcherNumber(65_537)),
    dispatcherGreater(witness, dispatcherNumber(0))
  );
}

function threadedChecksumFoldExpression(
  checksum: DispatcherExpression,
  word: DispatcherExpression,
  index: DispatcherExpression
): DispatcherExpression {
  const left = dispatcherFloor(dispatcherBinary(
    'operator_divide', 'NUM1', word, 'NUM2', dispatcherNumber(THREADED_RECORD_PRIME)
  ));
  const right = dispatcherMod(word, THREADED_RECORD_PRIME);
  const cross = dispatcherMod(
    dispatcherMultiply(
      dispatcherAdd(left, dispatcherMultiply(index, dispatcherNumber(17))),
      dispatcherAdd(
        right,
        dispatcherAdd(dispatcherMultiply(index, dispatcherNumber(31)), dispatcherNumber(7))
      )
    ),
    DISPATCHER_CHECKSUM_MODULUS
  );
  return dispatcherMod(
    dispatcherAdd(
      dispatcherMod(dispatcherMultiply(checksum, dispatcherNumber(37)), DISPATCHER_CHECKSUM_MODULUS),
      dispatcherAdd(
        cross,
        dispatcherAdd(
          dispatcherMod(
            dispatcherMultiply(left, dispatcherNumber(41)),
            DISPATCHER_CHECKSUM_MODULUS
          ),
          dispatcherAdd(
            dispatcherMod(
              dispatcherMultiply(right, dispatcherNumber(43)),
              DISPATCHER_CHECKSUM_MODULUS
            ),
            index
          )
        )
      )
    ),
    DISPATCHER_CHECKSUM_MODULUS
  );
}

function makeTransientExpandedAliasHandlers(
  target: ScratchTarget,
  handlers: readonly DispatcherHandler[],
  frame: DispatcherPacketFrame,
  bridge: DispatcherExpandedBridge,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string
): DispatcherExpandedAliasHandler[] {
  const aliases: DispatcherExpandedAliasHandler[] = [];
  for (const handler of handlers) {
    const sourceIds = expandedCommandInputGraphIds(target, handler.originalId);
    const routeRecords = requireItem(bridge.records, handler.routeIndex, 'transient expanded records');
    for (const record of routeRecords) {
      const aliasDomain = `${domain}-route-${handler.routeIndex}-handler-${record.handlerIndex}`;
      const commandId = factory.block(`${aliasDomain}-command`);
      const witnessId = factory.block(`${aliasDomain}-witness`);
      const witnessReporterId = factory.block(`${aliasDomain}-witness-reporter`);
      const armedId = factory.block(`${aliasDomain}-armed`);
      cloneExpandedCommandInputGraph(target, handler.originalId, commandId, factory, `${aliasDomain}-clone`);
      const command = requireBlock(target, commandId);
      command.next = witnessId;
      target.blocks[witnessId] = {
        opcode: 'data_setvariableto',
        next: armedId,
        parent: commandId,
        inputs: {VALUE: [2, witnessReporterId]},
        fields: {VARIABLE: [frame.witness.variableName, frame.witness.variableId]},
        shadow: false,
        topLevel: false
      };
      addDispatcherRawWitness(target, {
        setWitnessId: witnessId,
        witnessReporterId,
        witness: handler.witness
      });
      emitDispatcherSetVariable(
        target,
        armedId,
        witnessId,
        null,
        frame.armed,
        dispatcherNumber(1),
        factory,
        `${aliasDomain}-armed-value`
      );
      aliases.push({
        routeIndex: handler.routeIndex,
        handlerIndex: record.handlerIndex,
        localSlot: record.localSlot,
        currentLabel: record.currentLabel,
        continuationShare: record.continuationShare,
        salt: record.salt,
        ...(record.routeSeed === undefined ? {} : {routeSeed: record.routeSeed}),
        commandId
      });
    }
    for (const sourceId of sourceIds) delete target.blocks[sourceId];
  }
  return rng.fork('transient-alias-emission-order').shuffle(aliases);
}

function emitTransientExpandedDispatcherProcedure(
  target: ScratchTarget,
  run: ConnectableLinearRun,
  handlers: readonly DispatcherExpandedAliasHandler[],
  frame: DispatcherPacketFrame,
  bridge: DispatcherExpandedBridge,
  definitionId: string,
  prototypeId: string,
  proccode: string,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string
): void {
  if (bridge.program.digitOrder.length !== 0) {
    throw new Error('legacy transient dispatcher program is unavailable');
  }
  emitRuntimeBoundTransientDispatcherProcedure(
    target,
    run,
    handlers,
    frame,
    bridge,
    definitionId,
    prototypeId,
    proccode,
    factory,
    rng,
    `${domain}-runtime-bound`
  );
  return;
}


function makeDispatcherThreadedFrame(
  target: ScratchTarget,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string
): DispatcherThreadedFrame {
    const keys: readonly DispatcherThreadedFrameKey[] = [
        'recordIndex', 'wordDomain', 'round', 'word', 'left', 'right', 'mix',
        'roundValue', 'temporary', 'matches', 'selectedHandler', 'nextKeyLeft',
        'nextKeyRight', 'tagLeft', 'tagRight', 'selectedSlot', 'selectedKeyLeft',
        'selectedKeyRight'
    ];
    const frame = Object.fromEntries(keys.map(key => [key, {
            variableId: factory.symbol('v_', `${domain}-${key}`),
            variableName: factory.name('no-preserve', `${domain}-${key}`)
        }])) as DispatcherThreadedFrame;
    for (const key of rng.fork('declaration-order').shuffle(keys)) {
        const variable = frame[key];
        target.variables[variable.variableId] = [variable.variableName, 0];
    }
    return frame;
}
function threadedRoundTExpression(
  frame: DispatcherPacketFrame,
  threaded: DispatcherThreadedFrame,
  program: DispatcherThreadedProgram
): DispatcherExpression {
    const variable = dispatcherVariable;
    const roundKey = threadedSum(variable(frame.label), threadedProduct(variable(frame.continuation), variable(threaded.round)));
    const tweak = threadedSum(
      threadedProduct(variable(threaded.recordIndex), dispatcherNumber(program.nonceScale)),
      threadedProduct(variable(threaded.wordDomain), dispatcherNumber(program.wordScale)),
      threadedProduct(variable(frame.handler), dispatcherNumber(program.handlerScale)),
      threadedProduct(
        variable(threaded.selectedHandler),
        dispatcherNumber(program.selectedHandlerScale)
      ),
      threadedProduct(variable(frame.step), dispatcherNumber(program.stepScale)),
      threadedProduct(
        dispatcherEquals(
          dispatcherAdd(variable(frame.step), dispatcherNumber(1)),
          dispatcherNumber(program.routeCount)
        ),
        dispatcherNumber(program.terminalScale)
      )
    );
    return threadedSum(variable(threaded.left), threadedSum(roundKey, tweak));
}
function threadedRoundValueExpression(
  threaded: DispatcherThreadedFrame,
  program: DispatcherThreadedProgram
): DispatcherExpression {
    const variable = dispatcherVariable;
    const a = threadedSum(dispatcherNumber(program.roundABase), threadedProduct(dispatcherNumber(program.roundAStep), variable(threaded.round)));
    const b = threadedSum(dispatcherNumber(program.roundBBase), threadedProduct(dispatcherNumber(program.roundBStep), variable(threaded.round)));
    return threadedSum(threadedProduct(variable(threaded.mix), variable(threaded.mix)), threadedSum(threadedProduct(a, variable(threaded.mix)), b));
}
function emitThreadedDecryptProcedure(
  target: ScratchTarget,
  frame: DispatcherPacketFrame,
  threaded: DispatcherThreadedFrame,
  program: DispatcherThreadedProgram,
  definitionId: string,
  prototypeId: string,
  proccode: string,
  factory: UniqueFactory,
  domain: string
): void {
    const leftId = factory.block(`${domain}-left`);
    const rightId = factory.block(`${domain}-right`);
    const roundId = factory.block(`${domain}-round`);
    const repeatId = factory.block(`${domain}-repeat`);
    const mixId = factory.block(`${domain}-mix`);
    const roundValueId = factory.block(`${domain}-round-value`);
    const temporaryId = factory.block(`${domain}-temporary`);
    const leftUpdateId = factory.block(`${domain}-left-update`);
    const rightUpdateId = factory.block(`${domain}-right-update`);
    const roundChangeId = factory.block(`${domain}-round-change`);
    emitDispatcherSetVariable(target, leftId, definitionId, rightId, threaded.left, dispatcherFloor(dispatcherBinary('operator_divide', 'NUM1', dispatcherVariable(threaded.word), 'NUM2', dispatcherNumber(THREADED_RECORD_PRIME))), factory, `${domain}-left-value`);
    emitDispatcherSetVariable(target, rightId, leftId, roundId, threaded.right, dispatcherMod(dispatcherVariable(threaded.word), THREADED_RECORD_PRIME), factory, `${domain}-right-value`);
    emitDispatcherSetVariable(target, roundId, rightId, repeatId, threaded.round, dispatcherNumber(THREADED_FEISTEL_ROUNDS), factory, `${domain}-round-value`);
    target.blocks[repeatId] = {
        opcode: 'control_repeat',
        next: null,
        parent: roundId,
        inputs: { TIMES: numericInput(THREADED_FEISTEL_ROUNDS), SUBSTACK: [2, mixId] },
        fields: {}, shadow: false, topLevel: false
    };
    emitDispatcherSetVariable(target, mixId, repeatId, roundValueId, threaded.mix, threadedRoundTExpression(frame, threaded, program), factory, `${domain}-mix-value`);
    emitDispatcherSetVariable(target, roundValueId, mixId, temporaryId, threaded.roundValue, threadedRoundValueExpression(threaded, program), factory, `${domain}-round-function-value`);
    emitDispatcherSetVariable(target, temporaryId, roundValueId, leftUpdateId, threaded.temporary, dispatcherVariable(threaded.left), factory, `${domain}-temporary-value`);
    emitDispatcherSetVariable(target, leftUpdateId, temporaryId, rightUpdateId, threaded.left, threadedCanonical(dispatcherSubtract(dispatcherVariable(threaded.right), dispatcherVariable(threaded.roundValue))), factory, `${domain}-left-update-value`);
    emitDispatcherSetVariable(target, rightUpdateId, leftUpdateId, roundChangeId, threaded.right, dispatcherVariable(threaded.temporary), factory, `${domain}-right-update-value`);
    emitDispatcherChangeVariable(target, roundChangeId, rightUpdateId, null, threaded.round, -1);
    target.blocks[definitionId] = makeProcedureDefinition(prototypeId, leftId);
    target.blocks[prototypeId] = makeProcedurePrototype(definitionId, proccode, true);
}
function emitThreadedTransientDispatcherProcedure(
  target: ScratchTarget,
  run: ConnectableLinearRun,
  handlers: readonly DispatcherExpandedAliasHandler[],
  frame: DispatcherPacketFrame,
  bridge: DispatcherExpandedBridge,
  program: DispatcherThreadedProgram,
  definitionId: string,
  prototypeId: string,
  proccode: string,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string
): void {
    const number = dispatcherNumber;
    const variable = dispatcherVariable;
    const threaded = makeDispatcherThreadedFrame(target, factory, rng.fork('threaded-frame'), `${domain}-threaded-frame`);
    const existingCodes = collectProcedureCodes(target);
    existingCodes.add(proccode);
    let decryptCode = factory.name('no-preserve', `${domain}-decrypt-code`);
    for (let suffix = 0; existingCodes.has(decryptCode); suffix += 1) {
        decryptCode += suffix % 2 === 0 ? '\u200b' : '\u2060';
    }
    const decryptDefinitionId = factory.block(`${domain}-decrypt-definition`);
    const decryptPrototypeId = factory.block(`${domain}-decrypt-prototype`);
    emitThreadedDecryptProcedure(target, frame, threaded, program, decryptDefinitionId, decryptPrototypeId, decryptCode, factory, `${domain}-decrypt`);
    const stateVariables = [
        frame.handler,
        frame.slot,
        frame.label,
        frame.continuation,
        frame.salt,
        frame.tag,
        frame.row
    ];
    const stateLoadIds = stateVariables.map((_, index) => factory.block(`${domain}-state-${index}`));
    const checksumResetId = factory.block(`${domain}-checksum-reset`);
    const invalidResetId = factory.block(`${domain}-invalid-reset`);
    const wordIndexResetId = factory.block(`${domain}-word-index-reset`);
    const checksumRepeatId = factory.block(`${domain}-checksum-repeat`);
    const checksumWordId = factory.block(`${domain}-checksum-word`);
    const checksumCanonicalId = factory.block(`${domain}-checksum-canonical`);
    const checksumInvalidId = factory.block(`${domain}-checksum-invalid`);
    const checksumFoldId = factory.block(`${domain}-checksum-fold`);
    const checksumIndexChangeId = factory.block(`${domain}-checksum-index-change`);
    const commonCheckId = factory.block(`${domain}-common-check`);
    const commonStopId = factory.block(`${domain}-common-stop`);
    const phaseId = factory.block(`${domain}-phase`);
    const terminalCheckId = factory.block(`${domain}-terminal-check`);
    const terminalCommitId = factory.block(`${domain}-terminal-commit`);
    const terminalStopId = factory.block(`${domain}-terminal-stop`);
    const liveCheckId = factory.block(`${domain}-live-check`);
    const liveStopId = factory.block(`${domain}-live-stop`);
    const failureSentinelId = factory.block(`${domain}-failure-sentinel`);
    const armedFailureId = factory.block(`${domain}-armed-failure`);
    const armedStopId = factory.block(`${domain}-armed-stop`);
    const nonceCacheId = factory.block(`${domain}-nonce-cache`);
    const resultHashId = factory.block(`${domain}-result-hash`);
    const rollingKeyId = factory.block(`${domain}-rolling-key`);
    const selectedHandlerId = factory.block(`${domain}-selected-handler`);
    const matchesResetId = factory.block(`${domain}-matches-reset`);
    const recordIndexResetId = factory.block(`${domain}-record-index-reset`);
    const scanRepeatId = factory.block(`${domain}-scan-repeat`);
    const recordWordIndexId = factory.block(`${domain}-record-word-index`);
    const recordWordIds = Array.from({ length: THREADED_RECORD_WORDS }, (_, index) => factory.block(`${domain}-record-word-${index}`));
    const wordDomainIds = Array.from({ length: THREADED_RECORD_WORDS }, (_, index) => factory.block(`${domain}-word-domain-${index}`));
    const decryptCallIds = Array.from({ length: THREADED_RECORD_WORDS }, (_, index) => factory.block(`${domain}-decrypt-call-${index}`));
    const decodedLeftIds = Array.from({ length: THREADED_RECORD_WORDS }, (_, index) => factory.block(`${domain}-decoded-left-${index}`));
    const decodedRightIds = Array.from({ length: THREADED_RECORD_WORDS }, (_, index) => factory.block(`${domain}-decoded-right-${index}`));
    const nextWordIds = Array.from({ length: THREADED_RECORD_WORDS - 1 }, (_, index) => factory.block(`${domain}-next-word-${index}`));
    const tagContextId = factory.block(`${domain}-tag-context`);
    const recordMatchId = factory.block(`${domain}-record-match`);
    const matchIncrementId = factory.block(`${domain}-match-increment`);
    const selectedSlotId = factory.block(`${domain}-selected-slot`);
    const selectedKeyLeftId = factory.block(`${domain}-selected-key-left`);
    const selectedKeyRightId = factory.block(`${domain}-selected-key-right`);
    const recordIndexChangeId = factory.block(`${domain}-record-index-change`);
    const scanFailureId = factory.block(`${domain}-scan-failure`);
    const scanStopId = factory.block(`${domain}-scan-stop`);
    const stepChangeId = factory.block(`${domain}-step`);
    const wrapId = factory.block(`${domain}-wrap`);
    const handlerCommitId = factory.block(`${domain}-handler-commit`);
    const slotCommitId = factory.block(`${domain}-slot-commit`);
    const keyLeftCommitId = factory.block(`${domain}-key-left-commit`);
    const keyRightCommitId = factory.block(`${domain}-key-right-commit`);
    const tagCommitId = factory.block(`${domain}-tag-commit`);
    const stateWriteIds = Array.from({ length: TRANSIENT_EXPANDED_STATE_CELLS }, (_, index) => factory.block(`${domain}-state-write-${index}`));
    const authorityId = factory.block(`${domain}-authority`);
    const rhoId = factory.block(`${domain}-rho`);
    const armedCommitId = factory.block(`${domain}-armed-commit`);
    for (let index = 0; index < stateLoadIds.length; index += 1) {
        emitDispatcherSetVariable(target, requireItem(stateLoadIds, index, 'threaded state load'), index === 0 ? definitionId : requireItem(stateLoadIds, index - 1, 'prior threaded state load'), stateLoadIds[index + 1] ?? checksumResetId, requireItem(stateVariables, index, 'threaded state variable'), dispatcherListItem(bridge.program, number(index + 1)), factory, `${domain}-state-value-${index}`);
    }
    emitDispatcherSetVariable(target, checksumResetId, requireItem(stateLoadIds, stateLoadIds.length - 1, 'final state load'), invalidResetId, frame.checksum, number(0), factory, `${domain}-checksum-reset-value`);
    emitDispatcherSetVariable(target, invalidResetId, checksumResetId, wordIndexResetId, frame.epoch, number(0), factory, `${domain}-invalid-reset-value`);
    emitDispatcherSetVariable(target, wordIndexResetId, invalidResetId, checksumRepeatId, frame.index, number(1), factory, `${domain}-word-index-reset-value`);
    const recordWordCount = program.records.length * THREADED_RECORD_WORDS;
    target.blocks[checksumRepeatId] = {
        opcode: 'control_repeat',
        next: commonCheckId,
        parent: wordIndexResetId,
        inputs: { TIMES: numericInput(recordWordCount), SUBSTACK: [2, checksumWordId] },
        fields: {}, shadow: false, topLevel: false
    };
    emitDispatcherSetVariable(target, checksumWordId, checksumRepeatId, checksumCanonicalId, threaded.word, dispatcherListItem(bridge.powers, variable(frame.index)), factory, `${domain}-checksum-word-value`);
    const packedLimit = THREADED_RECORD_PRIME ** 2;
    target.blocks[checksumCanonicalId] = {
        opcode: 'control_if',
        next: checksumFoldId,
        parent: checksumWordId,
        inputs: {
            CONDITION: emitDispatcherExpression(target, checksumCanonicalId, dispatcherNot(dispatcherAll([
                dispatcherEquals(variable(threaded.word), dispatcherFloor(variable(threaded.word))),
                dispatcherGreater(variable(threaded.word), number(-1)),
                dispatcherNot(dispatcherGreater(variable(threaded.word), number(packedLimit - 1)))
            ])), factory, `${domain}-checksum-canonical-condition`),
            SUBSTACK: [2, checksumInvalidId]
        },
        fields: {}, shadow: false, topLevel: false
    };
    emitDispatcherSetVariable(target, checksumInvalidId, checksumCanonicalId, null, frame.epoch, number(1), factory, `${domain}-checksum-invalid-value`);
    emitDispatcherSetVariable(target, checksumFoldId, checksumCanonicalId, checksumIndexChangeId, frame.checksum, threadedChecksumFoldExpression(variable(frame.checksum), variable(threaded.word), variable(frame.index)), factory, `${domain}-checksum-fold-value`);
    emitDispatcherChangeVariable(target, checksumIndexChangeId, checksumFoldId, null, frame.index, 1);
    const canonicalField = (
      value: DispatcherExpression,
      nonzero = false
    ): DispatcherExpression => dispatcherAll([
        dispatcherEquals(value, dispatcherFloor(value)),
        dispatcherGreater(value, number(nonzero ? 0 : -1)),
        dispatcherNot(dispatcherGreater(value, number(THREADED_RECORD_PRIME - 1)))
    ]);
    target.blocks[commonCheckId] = {
        opcode: 'control_if',
        next: phaseId,
        parent: checksumRepeatId,
        inputs: {
            CONDITION: emitDispatcherExpression(target, commonCheckId, dispatcherNot(dispatcherAll([
                dispatcherEquals(dispatcherListLength(bridge.program), number(TRANSIENT_EXPANDED_STATE_CELLS)),
                dispatcherEquals(dispatcherListLength(bridge.powers), number(recordWordCount)),
                dispatcherEquals(variable(frame.checksum), number(bridge.programChecksum)),
                dispatcherEquals(variable(frame.epoch), number(0)),
                canonicalField(variable(frame.handler)),
                dispatcherNot(dispatcherGreater(variable(frame.handler), number(bridge.aliasCount - 1))),
                canonicalField(variable(frame.slot), true),
                canonicalField(variable(frame.label), true),
                canonicalField(variable(frame.continuation), true),
                canonicalField(variable(frame.salt)),
                canonicalField(variable(frame.row)),
                canonicalField(variable(frame.tag)),
                dispatcherEquals(variable(frame.tag), threadedStateTag(frame, bridge)),
                dispatcherEquals(variable(frame.y), threadedRawAuthority(frame, bridge, variable(frame.tag))),
                dispatcherEquals(variable(frame.rho), threadedHandlerAuthority(frame, bridge))
            ])), factory, `${domain}-common-condition`),
            SUBSTACK: [2, commonStopId]
        },
        fields: {}, shadow: false, topLevel: false
    };
    target.blocks[commonStopId] = makeDispatcherStop(commonCheckId);
    target.blocks[phaseId] = {
        opcode: 'control_if_else',
        next: null,
        parent: commonCheckId,
        inputs: {
            CONDITION: emitDispatcherExpression(target, phaseId, dispatcherEquals(variable(frame.armed), number(2)), factory, `${domain}-phase-condition`),
            SUBSTACK: [2, terminalCheckId],
            SUBSTACK2: [2, liveCheckId]
        },
        fields: {}, shadow: false, topLevel: false
    };
    const terminalRecords = bridge.terminalRecords;
    if (terminalRecords === undefined || terminalRecords.length !== bridge.aliasCount) {
        throw new Error('threaded terminal selector set is incomplete');
    }
    const terminalSelector = dispatcherAny(terminalRecords.map(record => dispatcherAll([
        dispatcherEquals(variable(frame.handler), number(record.handlerIndex)),
        dispatcherEquals(variable(frame.slot), number(record.localSlot))
    ])));
    target.blocks[terminalCheckId] = {
        opcode: 'control_if_else',
        next: null,
        parent: phaseId,
        inputs: {
            CONDITION: emitDispatcherExpression(target, terminalCheckId, dispatcherAll([
                dispatcherEquals(variable(frame.step), number(run.blockIds.length)),
                terminalSelector
            ]), factory, `${domain}-terminal-condition`),
            SUBSTACK: [2, terminalCommitId],
            SUBSTACK2: [2, terminalStopId]
        },
        fields: {}, shadow: false, topLevel: false
    };
    emitDispatcherSetVariable(target, terminalCommitId, terminalCheckId, null, frame.armed, number(0), factory, `${domain}-terminal-commit-value`);
    target.blocks[terminalStopId] = makeDispatcherStop(terminalCheckId);
    target.blocks[liveCheckId] = {
        opcode: 'control_if_else',
        next: null,
        parent: phaseId,
        inputs: {
            CONDITION: emitDispatcherExpression(target, liveCheckId, dispatcherAll([
                dispatcherEquals(variable(frame.armed), number(0)),
                dispatcherNot(dispatcherGreater(variable(frame.step), number(run.blockIds.length - 1)))
            ]), factory, `${domain}-live-condition`),
            SUBSTACK: [2, failureSentinelId],
            SUBSTACK2: [2, liveStopId]
        },
        fields: {}, shadow: false, topLevel: false
    };
    target.blocks[liveStopId] = makeDispatcherStop(liveCheckId);
    emitDispatcherSetVariable(target, failureSentinelId, liveCheckId, '', frame.armed, number(-1), factory, `${domain}-failure-sentinel-value`);
    const handlerOrder = rng.fork('handler-order').shuffle(Array.from({ length: bridge.aliasCount }, (_, value) => value));
    const routes = handlerOrder.map(handlerIndex => {
        const owned = rng.fork(`handler-${handlerIndex}-slot-order`).shuffle(handlers.filter(candidate => candidate.handlerIndex === handlerIndex));
        if (owned.length !== run.blockIds.length) {
            throw new Error('threaded universal handler command set is incomplete');
        }
        return {
            handlerIndex,
            outerIfId: factory.block(`${domain}-handler-${handlerIndex}`),
            inner: owned.map(candidate => ({
                handler: candidate,
                ifId: factory.block(`${domain}-handler-${handlerIndex}-slot-${candidate.localSlot}`)
            }))
        };
    });
    requireBlock(target, failureSentinelId).next = requireItem(routes, 0, 'first threaded handler').outerIfId;
    for (const [routeOrdinal, route] of routes.entries()) {
        const priorId = routeOrdinal === 0
            ? failureSentinelId
            : requireItem(routes, routeOrdinal - 1, 'prior threaded handler').outerIfId;
        const nextId = routes[routeOrdinal + 1]?.outerIfId ?? armedFailureId;
        const firstInner = requireItem(route.inner, 0, 'first threaded command');
        target.blocks[route.outerIfId] = {
            opcode: 'control_if',
            next: nextId,
            parent: priorId,
            inputs: {
                CONDITION: emitDispatcherExpression(target, route.outerIfId, dispatcherEquals(variable(frame.handler), number(route.handlerIndex)), factory, `${domain}-handler-condition-${route.handlerIndex}`),
                SUBSTACK: [2, firstInner.ifId]
            },
            fields: {}, shadow: false, topLevel: false
        };
        for (const [innerOrdinal, command] of route.inner.entries()) {
            target.blocks[command.ifId] = {
                opcode: 'control_if',
                next: route.inner[innerOrdinal + 1]?.ifId ?? null,
                parent: innerOrdinal === 0
                    ? route.outerIfId
                    : requireItem(route.inner, innerOrdinal - 1, 'prior threaded command').ifId,
                inputs: {
                    CONDITION: emitDispatcherExpression(target, command.ifId, dispatcherEquals(variable(frame.slot), number(command.handler.localSlot)), factory, `${domain}-slot-condition-${route.handlerIndex}-${command.handler.localSlot}`),
                    SUBSTACK: [2, command.handler.commandId]
                },
                fields: {}, shadow: false, topLevel: false
            };
            requireBlock(target, command.handler.commandId).parent = command.ifId;
        }
    }
    target.blocks[armedFailureId] = {
        opcode: 'control_if',
        next: nonceCacheId,
        parent: requireItem(routes, routes.length - 1, 'final threaded handler').outerIfId,
        inputs: {
            CONDITION: emitDispatcherExpression(target, armedFailureId, dispatcherNot(dispatcherEquals(variable(frame.armed), number(1))), factory, `${domain}-armed-condition`),
            SUBSTACK: [2, armedStopId]
        },
        fields: {}, shadow: false, topLevel: false
    };
    target.blocks[armedStopId] = makeDispatcherStop(armedFailureId);
    emitDispatcherSetVariable(target, nonceCacheId, armedFailureId, resultHashId, frame.row, threadedTimerNonce(), factory, `${domain}-nonce-cache-value`);
    emitDispatcherSetVariable(target, resultHashId, nonceCacheId, rollingKeyId, frame.hash, threadedSum(threadedTagMixExpression(variable(frame.hash), threadedWitnessMix(frame), 65_537), threadedTagMixExpression(variable(frame.salt), variable(frame.row), 131_071), variable(frame.step)), factory, `${domain}-result-hash-value`);
    emitDispatcherSetVariable(target, rollingKeyId, resultHashId, selectedHandlerId, frame.key, threadedSum(threadedTagMixExpression(variable(frame.key), variable(frame.hash), 262_147), threadedTagMixExpression(variable(frame.label), variable(frame.continuation), 524_309), threadedWitnessMix(frame), variable(frame.row)), factory, `${domain}-rolling-key-value`);
    emitDispatcherSetVariable(target, selectedHandlerId, rollingKeyId, matchesResetId, threaded.selectedHandler, dispatcherMod(dispatcherAdd(variable(frame.handler), dispatcherAdd(dispatcherMod(threadedSum(variable(frame.row), threadedWitnessMix(frame), variable(frame.key), variable(frame.hash), variable(frame.salt)), bridge.aliasCount), number(1))), bridge.aliasCount), factory, `${domain}-selected-handler-value`);
    emitDispatcherSetVariable(target, matchesResetId, selectedHandlerId, recordIndexResetId, threaded.matches, number(0), factory, `${domain}-matches-reset-value`);
    emitDispatcherSetVariable(target, recordIndexResetId, matchesResetId, scanRepeatId, threaded.recordIndex, number(1), factory, `${domain}-record-index-reset-value`);
    target.blocks[scanRepeatId] = {
        opcode: 'control_repeat',
        next: scanFailureId,
        parent: recordIndexResetId,
        inputs: { TIMES: numericInput(program.records.length), SUBSTACK: [2, recordWordIndexId] },
        fields: {}, shadow: false, topLevel: false
    };
    emitDispatcherSetVariable(target, recordWordIndexId, scanRepeatId, requireItem(recordWordIds, 0, 'first threaded record word'), frame.index, dispatcherAdd(dispatcherMultiply(dispatcherSubtract(variable(threaded.recordIndex), number(1)), number(THREADED_RECORD_WORDS)), number(1)), factory, `${domain}-record-word-index-value`);
    const decodedPairs: readonly (readonly [
      DispatcherFrameVariable,
      DispatcherFrameVariable
    ])[] = [
        [threaded.nextKeyLeft, threaded.nextKeyRight],
        [threaded.tagLeft, threaded.tagRight]
    ];
    for (let wordIndex = 0; wordIndex < THREADED_RECORD_WORDS; wordIndex += 1) {
        const priorId = wordIndex === 0
            ? recordWordIndexId
            : requireItem(nextWordIds, wordIndex - 1, 'prior threaded word advance');
        emitDispatcherSetVariable(target, requireItem(recordWordIds, wordIndex, 'threaded record word'), priorId, requireItem(wordDomainIds, wordIndex, 'threaded word domain'), threaded.word, dispatcherListItem(bridge.powers, variable(frame.index)), factory, `${domain}-record-word-value-${wordIndex}`);
        emitDispatcherSetVariable(target, requireItem(wordDomainIds, wordIndex, 'threaded word domain'), requireItem(recordWordIds, wordIndex, 'threaded record word'), requireItem(decryptCallIds, wordIndex, 'threaded decrypt call'), threaded.wordDomain, number(wordIndex + 1), factory, `${domain}-word-domain-value-${wordIndex}`);
        target.blocks[requireItem(decryptCallIds, wordIndex, 'threaded decrypt call')] = makeProcedureCall(decryptCode, requireItem(wordDomainIds, wordIndex, 'threaded word domain'), requireItem(decodedLeftIds, wordIndex, 'threaded decoded left'), false, true);
        const decodedPair = requireItem(decodedPairs, wordIndex, 'threaded decoded pair');
        emitDispatcherSetVariable(target, requireItem(decodedLeftIds, wordIndex, 'threaded decoded left'), requireItem(decryptCallIds, wordIndex, 'threaded decrypt call'), requireItem(decodedRightIds, wordIndex, 'threaded decoded right'), decodedPair[0], variable(threaded.left), factory, `${domain}-decoded-left-value-${wordIndex}`);
        emitDispatcherSetVariable(target, requireItem(decodedRightIds, wordIndex, 'threaded decoded right'), requireItem(decodedLeftIds, wordIndex, 'threaded decoded left'), wordIndex + 1 < THREADED_RECORD_WORDS
            ? requireItem(nextWordIds, wordIndex, 'threaded word advance')
            : tagContextId, decodedPair[1], variable(threaded.right), factory, `${domain}-decoded-right-value-${wordIndex}`);
        if (wordIndex + 1 < THREADED_RECORD_WORDS) {
            emitDispatcherChangeVariable(target, requireItem(nextWordIds, wordIndex, 'threaded word advance'), requireItem(decodedRightIds, wordIndex, 'threaded decoded right'), requireItem(recordWordIds, wordIndex + 1, 'next threaded record word'), frame.index, 1);
        }
    }
    const tagContext = threadedRecordTagContextExpression(
      frame,
      threaded,
      program
    );
    emitDispatcherSetVariable(
      target,
      tagContextId,
      requireItem(decodedRightIds, THREADED_RECORD_WORDS - 1, 'final decoded word'),
      recordMatchId,
      threaded.mix,
      tagContext,
      factory,
      `${domain}-tag-context-value`
    );
    const [expectedTagLeft, expectedTagRight] = threadedRecordTagExpressions(
      frame,
      threaded,
      program
    );
    target.blocks[recordMatchId] = {
        opcode: 'control_if',
        next: recordIndexChangeId,
        parent: tagContextId,
        inputs: {
            CONDITION: emitDispatcherExpression(target, recordMatchId, dispatcherAll([
                dispatcherGreater(variable(threaded.nextKeyLeft), number(0)),
                dispatcherGreater(variable(threaded.nextKeyRight), number(0)),
                dispatcherEquals(variable(threaded.tagLeft), expectedTagLeft),
                dispatcherEquals(variable(threaded.tagRight), expectedTagRight)
            ]), factory, `${domain}-record-match-condition`),
            SUBSTACK: [2, matchIncrementId]
        },
        fields: {}, shadow: false, topLevel: false
    };
    emitDispatcherChangeVariable(target, matchIncrementId, recordMatchId, selectedKeyLeftId, threaded.matches, 1);
    emitDispatcherSetVariable(target, selectedKeyLeftId, matchIncrementId, selectedKeyRightId, threaded.selectedKeyLeft, variable(threaded.nextKeyLeft), factory, `${domain}-selected-key-left-value`);
    emitDispatcherSetVariable(target, selectedKeyRightId, selectedKeyLeftId, null, threaded.selectedKeyRight, variable(threaded.nextKeyRight), factory, `${domain}-selected-key-right-value`);
    emitDispatcherChangeVariable(target, recordIndexChangeId, recordMatchId, null, threaded.recordIndex, 1);
    target.blocks[scanFailureId] = {
        opcode: 'control_if',
        next: selectedSlotId,
        parent: scanRepeatId,
        inputs: {
            CONDITION: emitDispatcherExpression(target, scanFailureId, dispatcherNot(dispatcherEquals(variable(threaded.matches), number(1))), factory, `${domain}-scan-failure-condition`),
            SUBSTACK: [2, scanStopId]
        },
        fields: {}, shadow: false, topLevel: false
    };
    target.blocks[scanStopId] = makeDispatcherStop(scanFailureId);
    emitDispatcherSetVariable(
      target,
      selectedSlotId,
      scanFailureId,
      stepChangeId,
      threaded.selectedSlot,
      threadedSlotExpression(
        variable(threaded.selectedKeyLeft),
        variable(threaded.selectedKeyRight),
        dispatcherAdd(variable(frame.step), number(1)),
        variable(threaded.selectedHandler),
        program
      ),
      factory,
      `${domain}-selected-slot-value`
    );
    emitDispatcherChangeVariable(target, stepChangeId, selectedSlotId, wrapId, frame.step, 1);
    emitDispatcherSetVariable(target, wrapId, stepChangeId, handlerCommitId, frame.salt, threadedSum(threadedTagMixExpression(variable(frame.salt), variable(frame.row), 1_048_583), threadedTagMixExpression(variable(threaded.selectedKeyLeft), variable(threaded.selectedKeyRight), 2_097_169), threadedProduct(variable(threaded.selectedHandler), variable(threaded.selectedSlot)), threadedWitnessMix(frame), variable(frame.key), variable(frame.hash), variable(frame.step)), factory, `${domain}-wrap-value`);
    emitDispatcherSetVariable(target, handlerCommitId, wrapId, slotCommitId, frame.handler, variable(threaded.selectedHandler), factory, `${domain}-handler-commit-value`);
    emitDispatcherSetVariable(target, slotCommitId, handlerCommitId, keyLeftCommitId, frame.slot, variable(threaded.selectedSlot), factory, `${domain}-slot-commit-value`);
    emitDispatcherSetVariable(target, keyLeftCommitId, slotCommitId, keyRightCommitId, frame.label, variable(threaded.selectedKeyLeft), factory, `${domain}-key-left-commit-value`);
    emitDispatcherSetVariable(target, keyRightCommitId, keyLeftCommitId, tagCommitId, frame.continuation, variable(threaded.selectedKeyRight), factory, `${domain}-key-right-commit-value`);
    emitDispatcherSetVariable(target, tagCommitId, keyRightCommitId, requireItem(stateWriteIds, 0, 'first threaded state write'), frame.tag, threadedStateTag(frame, bridge), factory, `${domain}-tag-commit-value`);
    const stateValues = [
        variable(frame.handler),
        variable(frame.slot),
        variable(frame.label),
        variable(frame.continuation),
        variable(frame.salt),
        variable(frame.tag),
        variable(frame.row)
    ];
    for (let index = 0; index < stateWriteIds.length; index += 1) {
        emitDispatcherReplaceListItem(target, requireItem(stateWriteIds, index, 'threaded state write'), index === 0 ? tagCommitId : requireItem(stateWriteIds, index - 1, 'prior threaded state write'), stateWriteIds[index + 1] ?? authorityId, bridge.program, number(index + 1), requireItem(stateValues, index, 'threaded state value'), factory, `${domain}-state-write-${index}`);
    }
    emitDispatcherSetVariable(target, authorityId, requireItem(stateWriteIds, stateWriteIds.length - 1, 'final threaded state write'), rhoId, frame.y, threadedRawAuthority(frame, bridge, variable(frame.tag)), factory, `${domain}-authority-value`);
    emitDispatcherSetVariable(target, rhoId, authorityId, armedCommitId, frame.rho, threadedHandlerAuthority(frame, bridge), factory, `${domain}-rho-value`);
    emitDispatcherSetVariable(target, armedCommitId, rhoId, null, frame.armed, number(0), factory, `${domain}-armed-commit-value`);
    target.blocks[definitionId] = makeProcedureDefinition(prototypeId, requireItem(stateLoadIds, 0, 'threaded dispatcher state entry'));
    target.blocks[prototypeId] = makeProcedurePrototype(definitionId, proccode, true);
}
function emitRuntimeBoundTransientDispatcherProcedure(
  target: ScratchTarget,
  run: ConnectableLinearRun,
  handlers: readonly DispatcherExpandedAliasHandler[],
  frame: DispatcherPacketFrame,
  bridge: DispatcherExpandedBridge,
  definitionId: string,
  prototypeId: string,
  proccode: string,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string
): void {
  if (bridge.threadedProgram === undefined) {
    throw new Error('threaded dispatcher program is unavailable');
  }
  emitThreadedTransientDispatcherProcedure(
    target,
    run,
    handlers,
    frame,
    bridge,
    bridge.threadedProgram,
    definitionId,
    prototypeId,
    proccode,
    factory,
    rng.fork('threaded-program'),
    `${domain}-threaded`
  );
  return;
}

function emitThreadedTransientDispatcherEntry(
  target: ScratchTarget,
  run: ConnectableLinearRun,
  frame: DispatcherPacketFrame,
  scheme: DispatcherPacketScheme,
  bridge: DispatcherExpandedBridge,
  dispatcherCode: string,
  factory: UniqueFactory,
  domain: string
): void {
  const entryParent = run.connector?.kind === 'top-level'
    ? null
    : (run.connector?.ownerId ?? run.predecessorId);
  const entryLeft = bridge.entryRecord.baseKeyLeft;
  const entryRight = bridge.entryRecord.baseKeyRight;
  if (entryLeft === undefined || entryRight === undefined) {
    throw new Error('threaded dispatcher entry key pair is unavailable');
  }
  const program = bridge.threadedProgram;
  if (program === undefined) throw new Error('threaded dispatcher program is unavailable');
  const setters: readonly {
    readonly key: DispatcherPacketFrameKey;
    readonly value: DispatcherExpression;
  }[] = [
    {key: 'step', value: dispatcherNumber(0)},
    {key: 'witness', value: dispatcherNumber(scheme.entry.witness)},
    {key: 'hash', value: threadedWitnessMix(frame)},
    {key: 'key', value: dispatcherNumber(scheme.entry.key)},
    {key: 'row', value: dispatcherNumber(scheme.entry.rho)},
    {key: 'handler', value: dispatcherNumber(bridge.entryRecord.handlerIndex)},
    {
      key: 'slot',
      value: threadedSlotExpression(
        dispatcherNumber(entryLeft),
        dispatcherNumber(entryRight),
        dispatcherNumber(0),
        dispatcherNumber(bridge.entryRecord.handlerIndex),
        program
      )
    },
    {key: 'label', value: dispatcherNumber(entryLeft)},
    {key: 'continuation', value: dispatcherNumber(entryRight)},
    {
      key: 'salt',
      value: threadedSum(
        dispatcherVariable(frame.key),
        dispatcherVariable(frame.hash),
        dispatcherVariable(frame.row),
        dispatcherVariable(frame.handler),
        dispatcherVariable(frame.slot)
      )
    },
    {key: 'tag', value: threadedStateTag(frame, bridge)},
    {key: 'armed', value: dispatcherNumber(-1)}
  ];
  const setterIds = setters.map((_, index) => factory.block(`${domain}-set-${index}`));
  const stateWriteIds = Array.from(
    {length: TRANSIENT_EXPANDED_STATE_CELLS},
    (_, index) => factory.block(`${domain}-state-write-${index}`)
  );
  const authorityId = factory.block(`${domain}-authority`);
  const rhoId = factory.block(`${domain}-rho`);
  const armedId = factory.block(`${domain}-armed`);
  const driverCallIds = Array.from(
    {length: run.blockIds.length},
    (_, index) => factory.block(`${domain}-call-${index}`)
  );
  const terminalPhaseId = factory.block(`${domain}-terminal-phase`);
  const terminalCallId = factory.block(`${domain}-terminal-call`);
  const terminalFailureId = factory.block(`${domain}-terminal-failure`);
  for (let index = 0; index < setters.length; index += 1) {
    const setter = requireItem(setters, index, 'threaded entry setter');
    emitDispatcherSetVariable(
      target,
      requireItem(setterIds, index, 'threaded entry setter id'),
      index === 0 ? entryParent : requireItem(setterIds, index - 1, 'prior threaded entry setter'),
      setterIds[index + 1] ?? requireItem(stateWriteIds, 0, 'first threaded entry state write'),
      frame[setter.key],
      setter.value,
      factory,
      `${domain}-set-value-${index}`,
      index === 0 ? run.wasTopLevel : false,
      index === 0 ? run.x : undefined,
      index === 0 ? run.y : undefined
    );
  }
  const stateValues = [
    dispatcherVariable(frame.handler),
    dispatcherVariable(frame.slot),
    dispatcherVariable(frame.label),
    dispatcherVariable(frame.continuation),
    dispatcherVariable(frame.salt),
    dispatcherVariable(frame.tag),
    dispatcherVariable(frame.row)
  ];
  for (let index = 0; index < stateWriteIds.length; index += 1) {
    emitDispatcherReplaceListItem(
      target,
      requireItem(stateWriteIds, index, 'threaded entry state write'),
      index === 0
        ? requireItem(setterIds, setterIds.length - 1, 'final threaded entry setter')
        : requireItem(stateWriteIds, index - 1, 'prior threaded entry state write'),
      stateWriteIds[index + 1] ?? authorityId,
      bridge.program,
      dispatcherNumber(index + 1),
      requireItem(stateValues, index, 'threaded entry state value'),
      factory,
      `${domain}-state-write-${index}`
    );
  }
  emitDispatcherSetVariable(
    target,
    authorityId,
    requireItem(stateWriteIds, stateWriteIds.length - 1, 'final threaded entry state write'),
    rhoId,
    frame.y,
    threadedRawAuthority(frame, bridge, dispatcherVariable(frame.tag)),
    factory,
    `${domain}-authority-value`
  );
  emitDispatcherSetVariable(
    target,
    rhoId,
    authorityId,
    armedId,
    frame.rho,
    threadedHandlerAuthority(frame, bridge),
    factory,
    `${domain}-rho-value`
  );
  emitDispatcherSetVariable(
    target,
    armedId,
    rhoId,
    requireItem(driverCallIds, 0, 'threaded dispatcher entry call'),
    frame.armed,
    dispatcherNumber(0),
    factory,
    `${domain}-armed-value`
  );
  for (const [index, callId] of driverCallIds.entries()) {
    target.blocks[callId] = makeProcedureCall(
      dispatcherCode,
      index === 0 ? armedId : requireItem(driverCallIds, index - 1, 'prior threaded call'),
      driverCallIds[index + 1] ?? terminalPhaseId,
      false,
      true
    );
  }
  emitDispatcherChangeVariable(
    target,
    terminalPhaseId,
    requireItem(driverCallIds, driverCallIds.length - 1, 'final threaded call'),
    terminalCallId,
    frame.armed,
    2
  );
  target.blocks[terminalCallId] = makeProcedureCall(
    dispatcherCode, terminalPhaseId, terminalFailureId, false, true
  );
  target.blocks[terminalFailureId] = {
    opcode: 'control_if_else',
    next: null,
    parent: terminalCallId,
    inputs: {
      CONDITION: [1, [12, frame.armed.variableName, frame.armed.variableId]],
      ...(run.successorId === null ? {} : {SUBSTACK2: [2, run.successorId]})
    },
    fields: {}, shadow: false, topLevel: false
  };
  replaceRunEntry(target, run, requireItem(setterIds, 0, 'threaded entry'));
  if (run.successorId !== null) requireBlock(target, run.successorId).parent = terminalFailureId;
}

function emitTransientExpandedDispatcherEntry(
  target: ScratchTarget,
  run: ConnectableLinearRun,
  frame: DispatcherPacketFrame,
  scheme: DispatcherPacketScheme,
  bridge: DispatcherExpandedBridge,
  dispatcherCode: string,
  factory: UniqueFactory,
  domain: string
): void {
  if (bridge.threadedProgram === undefined) {
    throw new Error('threaded dispatcher entry program is unavailable');
  }
  emitThreadedTransientDispatcherEntry(
    target,
    run,
    frame,
    scheme,
    bridge,
    dispatcherCode,
    factory,
    `${domain}-threaded`
  );
  return;
}

function emitPacketDispatcherEntry(
  target: ScratchTarget,
  run: ConnectableLinearRun,
  frame: DispatcherPacketFrame,
  scheme: DispatcherPacketScheme,
  dispatcherCode: string,
  factory: UniqueFactory,
  domain: string
): void {
  const entryParent = run.connector?.kind === 'top-level'
    ? null
    : (run.connector?.ownerId ?? run.predecessorId);
  const stepId = factory.block(`${domain}-entry-step`);
  const witnessId = factory.block(`${domain}-entry-witness`);
  const keyId = factory.block(`${domain}-entry-key`);
  const xId = factory.block(`${domain}-entry-x`);
  const yId = factory.block(`${domain}-entry-y`);
  const armedId = factory.block(`${domain}-entry-armed`);
  const driverCallIds = Array.from({length: run.blockIds.length}, (_, index) => (
    factory.block(`${domain}-entry-call-${index}`)
  ));
  const terminalPhaseId = factory.block(`${domain}-entry-terminal-phase`);
  const terminalCallId = factory.block(`${domain}-entry-terminal-call`);
  const terminalFailureId = factory.block(`${domain}-entry-terminal-failure`);
  emitDispatcherSetVariable(
    target,
    stepId,
    entryParent,
    witnessId,
    frame.step,
    dispatcherNumber(0),
    factory,
    `${domain}-entry-step-value`,
    run.wasTopLevel,
    run.x,
    run.y
  );
  emitDispatcherSetVariable(
    target,
    witnessId,
    stepId,
    keyId,
    frame.witness,
    dispatcherNumber(scheme.entry.witness),
    factory,
    `${domain}-entry-witness-value`
  );
  emitDispatcherSetVariable(
    target,
    keyId,
    witnessId,
    xId,
    frame.key,
    dispatcherNumber(scheme.entry.key),
    factory,
    `${domain}-entry-key-value`
  );
  emitDispatcherSetVariable(
    target,
    xId,
    keyId,
    yId,
    frame.rho,
    dispatcherNumber(scheme.entry.rho),
    factory,
    `${domain}-entry-x-value`
  );
  emitDispatcherSetVariable(
    target,
    yId,
    xId,
    armedId,
    frame.y,
    dispatcherNumber(scheme.entry.y),
    factory,
    `${domain}-entry-y-value`
  );
  emitDispatcherSetVariable(
    target,
    armedId,
    yId,
    requireItem(driverCallIds, 0, 'dispatcher entry call'),
    frame.armed,
    dispatcherNumber(0),
    factory,
    `${domain}-entry-armed-value`
  );
  for (const [index, callId] of driverCallIds.entries()) {
    target.blocks[callId] = makeProcedureCall(
      dispatcherCode,
      index === 0 ? armedId : requireItem(driverCallIds, index - 1, 'previous dispatcher entry call'),
      driverCallIds[index + 1] ?? terminalPhaseId,
      false,
      true
    );
  }
  emitDispatcherChangeVariable(
    target,
    terminalPhaseId,
    requireItem(driverCallIds, driverCallIds.length - 1, 'final dispatcher entry call'),
    terminalCallId,
    frame.armed,
    2
  );
  target.blocks[terminalCallId] = makeProcedureCall(
    dispatcherCode,
    terminalPhaseId,
    terminalFailureId,
    false,
    true
  );
  target.blocks[terminalFailureId] = {
    opcode: 'control_if_else',
    next: null,
    parent: terminalCallId,
    inputs: {
      CONDITION: [1, [12, frame.armed.variableName, frame.armed.variableId]],
      ...(run.successorId === null ? {} : {SUBSTACK2: [2, run.successorId]})
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  replaceRunEntry(target, run, stepId);
  if (run.successorId !== null) requireBlock(target, run.successorId).parent = terminalFailureId;
}

function emitPacketDispatcherProcedure(
  target: ScratchTarget,
  run: ConnectableLinearRun,
  handlers: readonly DispatcherHandler[],
  frame: DispatcherPacketFrame,
  scheme: DispatcherPacketScheme,
  definitionId: string,
  prototypeId: string,
  proccode: string,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string
): void {
  const number = dispatcherNumber;
  const variable = (value: DispatcherFrameVariable): DispatcherExpression => dispatcherVariable(value);
  const item = (list: DispatcherPacketList, index: DispatcherExpression): DispatcherExpression => (
    dispatcherListItem(list, index)
  );
  const equals = dispatcherEquals;
  const add = dispatcherAdd;
  const subtract = dispatcherSubtract;
  const multiply = dispatcherMultiply;
  const modulo = (value: DispatcherExpression, modulus = scheme.modulus): DispatcherExpression => (
    dispatcherMod(value, modulus)
  );
  const routeIdentity = (polynomial: DispatcherRoutePolynomial): DispatcherExpression => {
    return add(
      number(polynomial.slope),
      multiply(variable(frame.key), variable(frame.witness))
    );
  };
  const realRowCount = 2 * (run.blockIds.length + 1);
  const listLength = realRowCount;
  const packetLists = [
    scheme.bank0,
    scheme.bank1
  ];
  if (
    scheme.descriptors.length !== realRowCount
    || packetLists.some(list => {
      const values = target.lists[list.listId]?.[1];
      return !Array.isArray(values) || values.length !== listLength;
    })
  ) throw new Error('dispatcher table dimensions are inconsistent');

  const checksumResetId = factory.block(`${domain}-body-checksum-reset`);
  const indexResetId = factory.block(`${domain}-body-index-reset`);
  const rowResetId = factory.block(`${domain}-body-row-reset`);
  const scanRepeatId = factory.block(`${domain}-body-scan-repeat`);
  const checksumSetId = factory.block(`${domain}-body-checksum-set`);
  const routeMatchId = factory.block(`${domain}-body-route-match`);
  const routeRowBranchId = factory.block(`${domain}-body-route-row-branch`);
  const routeRowSetId = factory.block(`${domain}-body-route-row`);
  const routeDuplicateSetId = factory.block(`${domain}-body-route-duplicate`);
  const scanIndexChangeId = factory.block(`${domain}-body-scan-index`);
  const commonFailureId = factory.block(`${domain}-body-common-failure`);
  const commonStopId = factory.block(`${domain}-body-common-stop`);
  const phaseBranchId = factory.block(`${domain}-body-phase-branch`);
  const terminalFailureId = factory.block(`${domain}-body-terminal-failure`);
  const terminalStopId = factory.block(`${domain}-body-terminal-stop`);
  const failureSentinelId = factory.block(`${domain}-body-failure-sentinel`);
  const armedFailureId = factory.block(`${domain}-body-armed-failure`);
  const armedStopId = factory.block(`${domain}-body-armed-stop`);
  const packetWordBranchId = factory.block(`${domain}-body-packet-word-branch`);
  const packetWord0SetId = factory.block(`${domain}-body-packet-word-0`);
  const packetWord1SetId = factory.block(`${domain}-body-packet-word-1`);
  const packetFailureId = factory.block(`${domain}-body-packet-failure`);
  const packetStopId = factory.block(`${domain}-body-packet-stop`);
  const nextRhoSetId = factory.block(`${domain}-body-next-rho`);
  const oldKeySetId = factory.block(`${domain}-body-old-key`);
  const keySetId = factory.block(`${domain}-body-key`);
  const stepChangeId = factory.block(`${domain}-body-step`);
  const rhoCommitId = factory.block(`${domain}-body-rho-commit`);
  const ySetId = factory.block(`${domain}-body-y`);
  const armedCommitId = factory.block(`${domain}-body-armed-commit`);

  emitDispatcherSetVariable(
    target,
    checksumResetId,
    definitionId,
    indexResetId,
    frame.checksum,
    number(0),
    factory,
    `${domain}-body-checksum-reset-value`
  );
  emitDispatcherSetVariable(
    target,
    indexResetId,
    checksumResetId,
    rowResetId,
    frame.index,
    number(1),
    factory,
    `${domain}-body-index-reset-value`
  );
  emitDispatcherSetVariable(
    target,
    rowResetId,
    indexResetId,
    scanRepeatId,
    frame.row,
    number(0),
    factory,
    `${domain}-body-row-reset-value`
  );
  target.blocks[scanRepeatId] = {
    opcode: 'control_repeat',
    next: commonFailureId,
    parent: rowResetId,
    inputs: {
      TIMES: emitDispatcherExpression(
        target,
        scanRepeatId,
        dispatcherListLength(scheme.bank0),
        factory,
        `${domain}-body-scan-length`
      ),
      SUBSTACK: [2, checksumSetId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  const checksumBank0 = item(scheme.bank0, variable(frame.index));
  const checksumBank1 = item(scheme.bank1, variable(frame.index));
  const checksumExpression = add(
    multiply(
      add(
        dispatcherMod(variable(frame.checksum), DISPATCHER_CHECKSUM_STATE_MODULUS),
        checksumBank0
      ),
      add(
        dispatcherMod(checksumBank1, DISPATCHER_CHECKSUM_BANK_MODULUS),
        number(DISPATCHER_CHECKSUM_BANK_OFFSET)
      )
    ),
    checksumBank1
  );
  emitDispatcherSetVariable(
    target,
    checksumSetId,
    scanRepeatId,
    routeMatchId,
    frame.checksum,
    dispatcherMod(checksumExpression, DISPATCHER_CHECKSUM_MODULUS),
    factory,
    `${domain}-body-checksum-value`
  );
  target.blocks[routeMatchId] = {
    opcode: 'control_if',
    next: scanIndexChangeId,
    parent: checksumSetId,
    inputs: {
      CONDITION: emitDispatcherExpression(
        target,
        routeMatchId,
        equals(
          dispatcherPackedDigit(
            item(scheme.bank0, variable(frame.index)),
            scheme.bank0,
            0,
            scheme.modulus
          ),
          variable(frame.rho)
        ),
        factory,
        `${domain}-body-route-match-condition`
      ),
      SUBSTACK: [2, routeRowBranchId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[routeRowBranchId] = {
    opcode: 'control_if_else',
    next: null,
    parent: routeMatchId,
    inputs: {
      CONDITION: emitDispatcherExpression(
        target,
        routeRowBranchId,
        equals(variable(frame.row), number(0)),
        factory,
        `${domain}-body-route-row-empty`
      ),
      SUBSTACK: [2, routeRowSetId],
      SUBSTACK2: [2, routeDuplicateSetId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  emitDispatcherSetVariable(
    target,
    routeRowSetId,
    routeRowBranchId,
    null,
    frame.row,
    variable(frame.index),
    factory,
    `${domain}-body-route-row-value`
  );
  emitDispatcherSetVariable(
    target,
    routeDuplicateSetId,
    routeRowBranchId,
    null,
    frame.row,
    number(-1),
    factory,
    `${domain}-body-route-duplicate-value`
  );
  emitDispatcherChangeVariable(target, scanIndexChangeId, routeMatchId, null, frame.index, 1);

  const commonFailure = dispatcherNot(dispatcherAll([
    equals(dispatcherListLength(scheme.bank0), number(listLength)),
    equals(dispatcherListLength(scheme.bank1), number(listLength)),
    equals(variable(frame.checksum), number(scheme.checksum)),
    dispatcherBinary('operator_gt', 'OPERAND1', variable(frame.row), 'OPERAND2', number(0))
  ]));
  target.blocks[commonFailureId] = {
    opcode: 'control_if',
    next: oldKeySetId,
    parent: scanRepeatId,
    inputs: {
      CONDITION: emitDispatcherExpression(
        target,
        commonFailureId,
        commonFailure,
        factory,
        `${domain}-body-common-failure-condition`
      ),
      SUBSTACK: [2, commonStopId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[commonStopId] = makeDispatcherStop(commonFailureId);
  emitDispatcherSetVariable(
    target,
    oldKeySetId,
    commonFailureId,
    phaseBranchId,
    frame.index,
    multiply(variable(frame.key), variable(frame.witness)),
    factory,
    `${domain}-body-route-mask-value`
  );

  target.blocks[phaseBranchId] = {
    opcode: 'control_if_else',
    next: null,
    parent: oldKeySetId,
    inputs: {
      CONDITION: emitDispatcherExpression(
        target,
        phaseBranchId,
        equals(variable(frame.armed), number(2)),
        factory,
        `${domain}-body-phase-condition`
      ),
      SUBSTACK: [2, terminalFailureId],
      SUBSTACK2: [2, failureSentinelId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  const terminalValid = dispatcherAll([
    equals(
      variable(frame.y),
      routeIdentity(requireItem(
        scheme.routePolynomials,
        run.blockIds.length,
        'terminal route polynomial'
      ))
    ),
    equals(variable(frame.step), number(run.blockIds.length))
  ]);
  target.blocks[terminalFailureId] = {
    opcode: 'control_if',
    next: null,
    parent: phaseBranchId,
    inputs: {
      CONDITION: emitDispatcherExpression(
        target,
        terminalFailureId,
        terminalValid,
        factory,
        `${domain}-body-terminal-condition`
      ),
      SUBSTACK: [2, terminalStopId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  emitDispatcherSetVariable(
    target,
    terminalStopId,
    terminalFailureId,
    null,
    frame.armed,
    number(0),
    factory,
    `${domain}-body-terminal-success-value`
  );
  const routeRecords = handlers.map(handler => ({
    handler,
    ifId: factory.block(`${domain}-body-route-${handler.routeIndex}`),
    equalsId: factory.block(`${domain}-body-route-equals-${handler.routeIndex}`)
  }));
  const routeOrder = rng.fork('route-order').shuffle(routeRecords);
  const firstRouteId = requireItem(routeOrder, 0, 'dispatcher route').ifId;
  emitDispatcherSetVariable(
    target,
    failureSentinelId,
    phaseBranchId,
    firstRouteId,
    frame.armed,
    number(-1),
    factory,
    `${domain}-body-failure-sentinel-value`
  );
  for (const [routeOrdinal, route] of routeOrder.entries()) {
    const nextRouteId = routeOrder[routeOrdinal + 1]?.ifId ?? armedFailureId;
    const routePolynomial = requireItem(
      scheme.routePolynomials,
      route.handler.routeIndex,
      'dispatcher route polynomial'
    );
    target.blocks[route.ifId] = {
      opcode: 'control_if',
      next: nextRouteId,
      parent: routeOrdinal === 0 ? failureSentinelId : requireItem(routeOrder, routeOrdinal - 1, 'dispatcher route').ifId,
      inputs: {CONDITION: [2, route.equalsId], SUBSTACK: [2, route.handler.originalId]},
      fields: {},
      shadow: false,
      topLevel: false
    };
    target.blocks[route.equalsId] = {
      opcode: 'operator_equals',
      next: null,
      parent: route.ifId,
      inputs: {
        OPERAND1: [1, [12, frame.y.variableName, frame.y.variableId]],
        OPERAND2: emitDispatcherExpression(
          target,
          route.equalsId,
          routeIdentity(routePolynomial),
          factory,
          `${domain}-body-route-selector-${route.handler.routeIndex}`
        )
      },
      fields: {},
      shadow: false,
      topLevel: false
    };
    requireBlock(target, route.handler.originalId).parent = route.ifId;
  }
  target.blocks[armedFailureId] = {
    opcode: 'control_if',
    next: packetWordBranchId,
    parent: requireItem(routeOrder, routeOrder.length - 1, 'dispatcher route').ifId,
    inputs: {
      CONDITION: emitDispatcherExpression(
        target,
        armedFailureId,
        equals(variable(frame.armed), number(-1)),
        factory,
        `${domain}-body-armed-condition`
      ),
      SUBSTACK: [2, armedStopId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[armedStopId] = makeDispatcherStop(armedFailureId);

  const selectBank1 = dispatcherBinary(
    'operator_gt',
    'OPERAND1',
    multiply(variable(frame.key), variable(frame.witness)),
    'OPERAND2',
    number(Math.floor((scheme.modulus ** 2) / 2))
  );
  target.blocks[packetWordBranchId] = {
    opcode: 'control_if_else',
    next: packetFailureId,
    parent: armedFailureId,
    inputs: {
      CONDITION: emitDispatcherExpression(
        target,
        packetWordBranchId,
        selectBank1,
        factory,
        `${domain}-body-packet-bank-condition`
      ),
      SUBSTACK: [2, packetWord1SetId],
      SUBSTACK2: [2, packetWord0SetId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  emitDispatcherSetVariable(
    target,
    packetWord0SetId,
    packetWordBranchId,
    null,
    frame.checksum,
    item(scheme.bank0, variable(frame.row)),
    factory,
    `${domain}-body-packet-word-0-value`
  );
  emitDispatcherSetVariable(
    target,
    packetWord1SetId,
    packetWordBranchId,
    null,
    frame.checksum,
    item(scheme.bank1, variable(frame.row)),
    factory,
    `${domain}-body-packet-word-1-value`
  );
  const packet0Word = variable(frame.checksum);
  const selectedDigit = (logicalIndex: number): DispatcherExpression => (
    dispatcherPackedDigit(packet0Word, scheme.bank0, logicalIndex, scheme.modulus)
  );
  const packetWordIsCanonical = equals(
    packet0Word,
    dispatcherMod(dispatcherFloor(packet0Word), scheme.modulus ** 4)
  );
  target.blocks[packetFailureId] = {
    opcode: 'control_if',
    next: nextRhoSetId,
    parent: packetWordBranchId,
    inputs: {
      CONDITION: emitDispatcherExpression(
        target,
        packetFailureId,
        dispatcherNot(packetWordIsCanonical),
        factory,
        `${domain}-body-packet-domain-condition`
      ),
      SUBSTACK: [2, packetStopId]
    },
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[packetStopId] = makeDispatcherStop(packetFailureId);

  const rhoShare0 = selectedDigit(1);
  const rhoShare1 = selectedDigit(2);
  emitDispatcherSetVariable(
    target,
    nextRhoSetId,
    packetFailureId,
    keySetId,
    frame.row,
    modulo(multiply(rhoShare0, rhoShare1)),
    factory,
    `${domain}-body-next-rho-value`
  );
  const keyExpression = modulo(add(
    add(multiply(variable(frame.key), variable(frame.witness)), packet0Word),
    variable(frame.row)
  ));
  emitDispatcherSetVariable(
    target,
    keySetId,
    nextRhoSetId,
    stepChangeId,
    frame.key,
    keyExpression,
    factory,
    `${domain}-body-key-value`
  );
  emitDispatcherChangeVariable(target, stepChangeId, keySetId, ySetId, frame.step, 1);
  emitDispatcherSetVariable(
    target,
    rhoCommitId,
    ySetId,
    armedCommitId,
    frame.rho,
    variable(frame.row),
    factory,
    `${domain}-body-rho-commit-value`
  );
  emitDispatcherSetVariable(
    target,
    ySetId,
    stepChangeId,
    rhoCommitId,
    frame.y,
    add(
      modulo(subtract(
        selectedDigit(3),
        dispatcherRouteMaskExpression(
          scheme.routeMaskTemplate,
          subtract(variable(frame.armed), variable(frame.index)),
          variable(frame.rho),
          variable(frame.row),
          variable(frame.step)
        )
      )),
      multiply(variable(frame.key), variable(frame.witness))
    ),
    factory,
    `${domain}-body-y-value`
  );
  emitDispatcherSetVariable(
    target,
    armedCommitId,
    rhoCommitId,
    null,
    frame.armed,
    number(0),
    factory,
    `${domain}-body-armed-commit-value`
  );
  target.blocks[definitionId] = makeProcedureDefinition(prototypeId, checksumResetId);
  target.blocks[prototypeId] = makeProcedurePrototype(definitionId, proccode, true);
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

function boundDispatcherRuns(project: ScratchProject, run: ConnectableLinearRun): ConnectableLinearRun[] {
  const minimumLength = 4;
  const cohortLength = 8;
  const target = requireTarget(project, run.targetIndex);
  if (run.blockIds.length === minimumLength || run.blockIds.length === cohortLength) return [run];
  const bounded: ConnectableLinearRun[] = [];
  let cursor = 0;
  while (run.blockIds.length - cursor >= minimumLength) {
    const length = run.blockIds.length - cursor >= cohortLength ? cohortLength : minimumLength;
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
    if (run.blockIds.length - cursor >= minimumLength + 1) cursor += 1;
    else break;
  }
  return bounded;
}

function makeDispatcherPacketScheme(
  target: ScratchTarget,
  routeCount: number,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string,
  expandedAliasCount: number
): DispatcherPacketScheme {
  if (routeCount !== 4 && routeCount !== 8) {
    throw new Error('dispatcher packet scheme requires four or eight routes');
  }
  if (expandedAliasCount > 0) {
    return makeExpandedDispatcherScheme(target, routeCount, expandedAliasCount, factory, rng, domain);
  }
  const modulus = requireItem(
    DISPATCHER_PACKET_PRIMES,
    rng.fork('modulus').integer(DISPATCHER_PACKET_PRIMES.length),
    'dispatcher packet modulus'
  );
  const realRowCount = 2 * (routeCount + 1);
  const packetDomain = 2;
  const rhoDomain = rng.fork('rho').shuffle(
    Array.from({length: modulus - 1}, (_, index) => index + 1)
  );
  const physicalStates = rng.fork('physical-state-order').shuffle(
    Array.from({length: routeCount + 1}, (_, routeIndex) => (
      [0, 1].map(lane => ({routeIndex, lane}))
    )).flat()
  );
  const descriptors: DispatcherPacketDescriptor[] = physicalStates.map((state, index) => ({
    row: index + 1,
    rho: requireItem(rhoDomain, index, 'dispatcher physical rho'),
    routeIndex: state.routeIndex,
    lane: state.lane
  }));

  const routePolynomials = rng.fork('route-polynomials').shuffle(
    Array.from({length: modulus - 3}, (_, index): DispatcherRoutePolynomial => ({slope: index + 3}))
  ).slice(0, routeCount + 1);
  const routeMaskTemplate = rng.fork('route-mask-template').integer(2) as 0 | 1;

  const bankDigits: [number[][], number[][]] = [[], []];
  for (const descriptor of descriptors) {
    const targetRouteIndex = Math.min(descriptor.routeIndex + 1, routeCount);
    const physicalTargets = rng.fork('physical-targets-' + descriptor.row).shuffle(
      descriptors.filter(candidate => candidate.routeIndex === targetRouteIndex)
    );
    if (physicalTargets.length !== packetDomain) {
      throw new Error('dispatcher physical route pair is incomplete');
    }
    for (let witnessSlot = 0; witnessSlot < packetDomain; witnessSlot += 1) {
      const recordRng = rng.fork('packet-' + descriptor.row + '-' + witnessSlot);
      const next = requireItem(physicalTargets, witnessSlot, 'dispatcher physical target');
      const rhoShare0 = 1 + recordRng.fork('rho-share').integer(modulus - 1);
      const rhoShare1 = packetMod(next.rho * packetInverse(rhoShare0, modulus), modulus);
      if (rhoShare1 === 0) {
        throw new Error('dispatcher multiplicative share is zero');
      }
      const currentRoute = requireItem(
        routePolynomials,
        descriptor.routeIndex,
        'dispatcher current route identity'
      );
      const nextRoute = requireItem(
        routePolynomials,
        targetRouteIndex,
        'dispatcher successor route identity'
      );
      const routeCipher = packetMod(
        nextRoute.slope + packetRouteMask(
          routeMaskTemplate,
          currentRoute.slope,
          descriptor.rho,
          next.rho,
          targetRouteIndex,
          modulus
        ),
        modulus
      );
      requireItem(bankDigits, witnessSlot, 'dispatcher packet bank').push([
        descriptor.rho,
        rhoShare0,
        rhoShare1,
        routeCipher
      ]);
    }
  }
  const pendingLists: Array<{readonly list: DispatcherPacketList; readonly values: readonly number[]}> = [];
  const digitOrder = (label: string): readonly number[] => {
    const order = [
      0,
      ...rng.fork(`digit-order-compact-${label}`).shuffle([1, 2, 3])
    ];
    if (order.every((logicalIndex, power) => logicalIndex === power)) {
      const swappable = rng.fork(`digit-swap-${label}`).shuffle([1, 2, 3]);
      const first = requireItem(swappable, 0, 'dispatcher digit permutation');
      const second = requireItem(swappable, 1, 'dispatcher digit permutation');
      const firstValue = requireItem(order, first, 'dispatcher digit permutation');
      const secondValue = requireItem(order, second, 'dispatcher digit permutation');
      order[first] = secondValue;
      order[second] = firstValue;
    }
    return order;
  };
  const makeList = (
    label: string,
    rows: readonly (readonly number[])[],
    digitOrder: readonly number[]
  ): DispatcherPacketList => {
    const list: DispatcherPacketList = {
      listId: factory.symbol('l_', domain + '-' + label),
      listName: factory.name('no-preserve', domain + '-' + label),
      digitOrder
    };
    const values = rows.map(digits => packDispatcherWord(digits, list.digitOrder, modulus));
    for (const [index, word] of values.entries()) {
      const digits = requireItem(rows, index, 'dispatcher source word');
      for (let logicalIndex = 0; logicalIndex < 4; logicalIndex += 1) {
        if (
          unpackDispatcherWord(word, list.digitOrder, logicalIndex, modulus)
          !== requireItem(digits, logicalIndex, 'dispatcher source digit')
        ) throw new Error('dispatcher packet word roundtrip failed');
      }
    }
    pendingLists.push({list, values});
    return list;
  };
  const packetDigitOrder = digitOrder('packet-banks');
  const bank0 = makeList('packet-bank-0', bankDigits[0], packetDigitOrder);
  const bank1 = makeList('packet-bank-1', bankDigits[1], packetDigitOrder);
  for (const declaration of rng.fork('list-declaration-order').shuffle(pendingLists)) {
    target.lists[declaration.list.listId] = [declaration.list.listName, [...declaration.values]];
  }
  const listValues = (list: DispatcherPacketList): readonly number[] => {
    const values = target.lists[list.listId]?.[1];
    if (!Array.isArray(values) || !values.every(value => typeof value === 'number')) {
      throw new Error('dispatcher packet list is unavailable');
    }
    return values;
  };
  let checksum = 0;
  for (let index = 0; index < realRowCount; index += 1) {
    const bank0Word = requireItem(listValues(bank0), index, 'dispatcher checksum word');
    const bank1Word = requireItem(listValues(bank1), index, 'dispatcher checksum word');
    checksum = packetIntegrityFold(checksum, bank0Word, bank1Word);
  }
  const entryDescriptor = requireItem(
    rng.fork('entry-row').shuffle(descriptors.filter(descriptor => descriptor.routeIndex === 0)),
    0,
    'dispatcher entry state'
  );
  const entryKey = 1 + rng.fork('entry-key').integer(modulus - 1);
  const entryWitness = rng.fork('entry-witness').integer(modulus);
  const entryRoutePolynomial = requireItem(routePolynomials, 0, 'dispatcher entry route polynomial');
  return {
    modulus,
    packetDomain,
    descriptors,
    bank0,
    bank1,
    routePolynomials,
    routeMaskTemplate,
    checksum,
    entry: {
      key: entryKey,
      witness: entryWitness,
      rho: entryDescriptor.rho,
      y: entryRoutePolynomial.slope + (entryKey * entryWitness)
    }
  };
}

type ThreadedPair = readonly [number, number];

interface ThreadedFeistelParameters {
  readonly roundABase: number;
  readonly roundAStep: number;
  readonly roundBBase: number;
  readonly roundBStep: number;
  readonly nonceScale: number;
  readonly wordScale: number;
  readonly handlerScale: number;
  readonly selectedHandlerScale: number;
  readonly stepScale: number;
  readonly terminalScale: number;
}

function threadedField(value: bigint): number {
  const modulus = BigInt(THREADED_RECORD_PRIME);
  return Number(((value % modulus) + modulus) % modulus);
}

function threadedAdd(...values: readonly number[]): number {
  let result = 0n;
  for (const value of values) result = BigInt(threadedField(result + BigInt(value)));
  return Number(result);
}

function threadedMultiply(left: number, right: number): number {
  return threadedField(BigInt(left) * BigInt(right));
}

function threadedPack([left, right]: ThreadedPair): number {
  if (
    !Number.isSafeInteger(left)
    || !Number.isSafeInteger(right)
    || left < 0
    || right < 0
    || left >= THREADED_RECORD_PRIME
    || right >= THREADED_RECORD_PRIME
  ) throw new Error('threaded record rail is outside its canonical field range');
  const packed = Number((BigInt(left) * BigInt(THREADED_RECORD_PRIME)) + BigInt(right));
  if (!Number.isSafeInteger(packed)) throw new Error('threaded record packing exceeded exact arithmetic');
  return packed;
}

function threadedUnpack(word: number): ThreadedPair {
  const maximum = THREADED_RECORD_PRIME ** 2;
  if (!Number.isSafeInteger(word) || word < 0 || word >= maximum) {
    throw new Error('threaded record word is outside its canonical packed range');
  }
  const left = Math.floor(word / THREADED_RECORD_PRIME);
  const right = word % THREADED_RECORD_PRIME;
  if (threadedPack([left, right]) !== word) throw new Error('threaded record did not round trip');
  return [left, right];
}

function threadedRoundMaterial(
  key: ThreadedPair,
  nonce: number,
  wordDomain: number,
  handlerIndex: number,
  selectedHandlerIndex: number,
  step: number,
  terminalExpected: number,
  round: number,
  parameters: ThreadedFeistelParameters
): {readonly roundKey: number; readonly tweak: number; readonly a: number; readonly b: number} {
  const roundKey = threadedAdd(key[0], threadedMultiply(key[1], round));
  const tweak = threadedAdd(
    threadedMultiply(nonce, parameters.nonceScale),
    threadedMultiply(wordDomain, parameters.wordScale),
    threadedMultiply(handlerIndex, parameters.handlerScale),
    threadedMultiply(selectedHandlerIndex, parameters.selectedHandlerScale),
    threadedMultiply(step, parameters.stepScale),
    threadedMultiply(terminalExpected, parameters.terminalScale)
  );
  const a = threadedAdd(parameters.roundABase, threadedMultiply(parameters.roundAStep, round));
  const b = threadedAdd(parameters.roundBBase, threadedMultiply(parameters.roundBStep, round));
  if (a === 0) throw new Error('threaded Feistel round multiplier is zero');
  return {roundKey, tweak, a, b};
}

function threadedRoundFunction(
  right: number,
  material: ReturnType<typeof threadedRoundMaterial>
): number {
  const t = threadedAdd(right, threadedAdd(material.roundKey, material.tweak));
  const u = threadedMultiply(t, t);
  const v = threadedAdd(threadedMultiply(material.a, t), material.b);
  return threadedAdd(u, v);
}

function threadedEncrypt(
  pair: ThreadedPair,
  key: ThreadedPair,
  nonce: number,
  wordDomain: number,
  handlerIndex: number,
  selectedHandlerIndex: number,
  step: number,
  terminalExpected: number,
  parameters: ThreadedFeistelParameters
): ThreadedPair {
  let [left, right] = pair;
  for (let round = 1; round <= THREADED_FEISTEL_ROUNDS; round += 1) {
    const material = threadedRoundMaterial(
      key,
      nonce,
      wordDomain,
      handlerIndex,
      selectedHandlerIndex,
      step,
      terminalExpected,
      round,
      parameters
    );
    [left, right] = [right, threadedAdd(left, threadedRoundFunction(right, material))];
  }
  return [left, right];
}

function threadedDecrypt(
  pair: ThreadedPair,
  key: ThreadedPair,
  nonce: number,
  wordDomain: number,
  handlerIndex: number,
  selectedHandlerIndex: number,
  step: number,
  terminalExpected: number,
  parameters: ThreadedFeistelParameters
): ThreadedPair {
  let [left, right] = pair;
  for (let round = THREADED_FEISTEL_ROUNDS; round >= 1; round -= 1) {
    const material = threadedRoundMaterial(
      key,
      nonce,
      wordDomain,
      handlerIndex,
      selectedHandlerIndex,
      step,
      terminalExpected,
      round,
      parameters
    );
    [left, right] = [
      threadedAdd(right, -threadedRoundFunction(left, material)),
      left
    ];
  }
  return [left, right];
}

function threadedTag(
  currentKey: ThreadedPair,
  nonce: number,
  nextKey: ThreadedPair,
  currentHandlerIndex: number,
  selectedHandlerIndex: number,
  step: number,
  terminalExpected: number,
  constants: readonly number[]
): ThreadedPair {
  const constant = (index: number): number => requireItem(
    constants, index, 'threaded record tag constant'
  );
  const nextStep = step + 1;
  let context = threadedAdd(nonce, constant(0));
  for (const value of [
    currentHandlerIndex + 1,
    selectedHandlerIndex + 1,
    step,
    nextStep,
    terminalExpected
  ]) {
    context = threadedAdd(threadedMultiply(context, constant(1)), value);
  }
  context = threadedAdd(context, constant(2));
  const left = threadedAdd(
    threadedMultiply(
      threadedAdd(currentKey[0], nextKey[0], context),
      threadedAdd(currentKey[1], nextKey[1], context)
    ),
    constant(3)
  );
  const right = threadedAdd(
    threadedMultiply(
      threadedAdd(currentKey[0], nextKey[1], context),
      threadedAdd(currentKey[1], nextKey[0], context, nonce)
    ),
    constant(4)
  );
  return [left, right];
}

function threadedSlot(
  key: ThreadedPair,
  step: number,
  handlerIndex: number,
  aliasCount: number,
  constants: readonly number[]
): number {
  const constant = (index: number): number => requireItem(
    constants,
    index,
    'threaded slot constant'
  );
  const stateOrdinal = threadedAdd(
    threadedMultiply(step, aliasCount),
    handlerIndex,
    1
  );
  const slotField = threadedAdd(
    threadedMultiply(key[0], key[1]),
    threadedMultiply(stateOrdinal, constant(0)),
    constant(1)
  );
  return 1 + (slotField % (THREADED_RECORD_PRIME - 1));
}

function threadedProgramChecksum(words: readonly number[]): number {
  let checksum = 0;
  for (let index = 0; index < words.length; index += 1) {
    const [left, right] = threadedUnpack(requireItem(words, index, 'threaded record word'));
    const position = index + 1;
    const cross = Number(
      (BigInt(left + (position * 17)) * BigInt(right + (position * 31) + 7))
      % BigInt(DISPATCHER_CHECKSUM_MODULUS)
    );
    checksum = Number(
      (
        (BigInt(checksum) * 37n)
        + BigInt(cross)
        + (BigInt(left) * 41n)
        + (BigInt(right) * 43n)
        + BigInt(position)
      ) % BigInt(DISPATCHER_CHECKSUM_MODULUS)
    );
  }
  return checksum;
}

function threadedDistinctValues(
  count: number,
  rng: DeterministicGenerator,
  domain: string
): number[] {
  const values: number[] = [];
  const seen = new Set<number>();
  for (let attempt = 0; values.length < count && attempt < count * 1_024; attempt += 1) {
    const value = 1 + rng.fork(`${domain}-${attempt}`).integer(THREADED_RECORD_PRIME - 1);
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  if (values.length !== count) throw new Error('threaded field domain is exhausted');
  return values;
}

function makeThreadedTransientExpandedDispatcherScheme(
  target: ScratchTarget,
  routeCount: number,
  aliasCount: number,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string
): DispatcherPacketScheme {
  const stateCount = (routeCount + 1) * aliasCount;
  const keyLeftValues = threadedDistinctValues(
    stateCount,
    rng.fork('threaded-key-left'),
    'left'
  );
  const keyRightValues = threadedDistinctValues(
    stateCount,
    rng.fork('threaded-key-right'),
    'right'
  );
  const keyPairs = new Set<string>();
  for (let stateIndex = 0; stateIndex < stateCount; stateIndex += 1) {
    const keySignature = `${requireItem(keyLeftValues, stateIndex, 'threaded left base key')}:${requireItem(keyRightValues, stateIndex, 'threaded right base key')}`;
    if (keyPairs.has(keySignature)) throw new Error('threaded base key pair was reused');
    keyPairs.add(keySignature);
  }
  let slotConstants: readonly number[] | undefined;
  for (let attempt = 0; attempt < 1_024 && slotConstants === undefined; attempt += 1) {
    const candidate = Array.from(
      {length: 2},
      (_, index) => 1 + rng.fork(`threaded-slot-${attempt}-${index}`).integer(
        THREADED_RECORD_PRIME - 1
      )
    );
    const slots = Array.from({length: stateCount}, (_, stateIndex) => threadedSlot(
      [
        requireItem(keyLeftValues, stateIndex, 'threaded slot left key'),
        requireItem(keyRightValues, stateIndex, 'threaded slot right key')
      ],
      Math.floor(stateIndex / aliasCount),
      stateIndex % aliasCount,
      aliasCount,
      candidate
    ));
    if (slots.every(slot => slot > 0) && new Set(slots).size === stateCount) {
      slotConstants = candidate;
    }
  }
  if (slotConstants === undefined) throw new Error('threaded branch slot domain is exhausted');
  const baseRecords = Array.from({length: routeCount + 1}, (_, routeIndex) => (
    Array.from({length: aliasCount}, (_, handlerIndex): DispatcherExpandedRecord => {
      const stateIndex = (routeIndex * aliasCount) + handlerIndex;
      const baseKeyLeft = requireItem(keyLeftValues, stateIndex, 'threaded left base key');
      const baseKeyRight = requireItem(keyRightValues, stateIndex, 'threaded right base key');
      return {
        cellIndex: stateIndex,
        routeIndex,
        handlerIndex,
        localSlot: threadedSlot(
          [baseKeyLeft, baseKeyRight],
          routeIndex,
          handlerIndex,
          aliasCount,
          slotConstants
        ),
        transitionSlot: 0,
        currentLabel: 0,
        continuationShare: 0,
        salt: 0,
        baseKeyLeft,
        baseKeyRight
      };
    })
  ));
  const records = baseRecords.slice(0, routeCount);
  const terminalRecords = requireItem(baseRecords, routeCount, 'threaded terminal states');

  let parameters: ThreadedFeistelParameters | undefined;
  for (let attempt = 0; attempt < 1_024 && parameters === undefined; attempt += 1) {
    const parameterRng = rng.fork(`threaded-feistel-parameters-${attempt}`);
    const candidate: ThreadedFeistelParameters = {
      roundABase: 1 + parameterRng.fork('a-base').integer(THREADED_RECORD_PRIME - 1),
      roundAStep: 1 + parameterRng.fork('a-step').integer(THREADED_RECORD_PRIME - 1),
      roundBBase: parameterRng.fork('b-base').integer(THREADED_RECORD_PRIME),
      roundBStep: 1 + parameterRng.fork('b-step').integer(THREADED_RECORD_PRIME - 1),
      nonceScale: 1 + parameterRng.fork('nonce').integer(THREADED_RECORD_PRIME - 1),
      wordScale: 1 + parameterRng.fork('word').integer(THREADED_RECORD_PRIME - 1),
      handlerScale: 1 + parameterRng.fork('handler').integer(THREADED_RECORD_PRIME - 1),
      selectedHandlerScale: 1 + parameterRng.fork('selected-handler').integer(
        THREADED_RECORD_PRIME - 1
      ),
      stepScale: 1 + parameterRng.fork('step').integer(THREADED_RECORD_PRIME - 1),
      terminalScale: 1 + parameterRng.fork('terminal').integer(THREADED_RECORD_PRIME - 1)
    };
    const multipliers = Array.from({length: THREADED_FEISTEL_ROUNDS}, (_, index) => (
      threadedAdd(candidate.roundABase, threadedMultiply(candidate.roundAStep, index + 1))
    ));
    if (multipliers.every(value => value !== 0)) parameters = candidate;
  }
  if (parameters === undefined) throw new Error('threaded Feistel parameters are exhausted');
  const tagConstants = Array.from(
    {length: 5},
    (_, index) => 1 + rng.fork(`threaded-tag-${index}`).integer(THREADED_RECORD_PRIME - 1)
  );

  const logicalRecords = records.flatMap((routeRecords, routeIndex) => (
    routeRecords.flatMap(source => Array.from({length: aliasCount}, (_, nextHandlerIndex) => {
      const successor = requireItem(
        requireItem(baseRecords, routeIndex + 1, 'threaded successor states'),
        nextHandlerIndex,
        'threaded successor state'
      );
      const nextLeft = successor.baseKeyLeft;
      const nextRight = successor.baseKeyRight;
      const currentLeft = source.baseKeyLeft;
      const currentRight = source.baseKeyRight;
      if (
        nextLeft === undefined
        || nextRight === undefined
        || currentLeft === undefined
        || currentRight === undefined
      ) throw new Error('threaded base key material is unavailable');
      return {
        routeIndex,
        handlerIndex: source.handlerIndex,
        nextHandlerIndex,
        currentKey: [currentLeft, currentRight] as const,
        nextKey: [nextLeft, nextRight] as const
      };
    }))
  ));
  const threadedRecords = rng.fork('threaded-record-order').shuffle(logicalRecords).map(
    (logical, index): DispatcherThreadedRecord => {
      const nonce = index + 1;
      const tag = threadedTag(
        logical.currentKey,
        nonce,
        logical.nextKey,
        logical.handlerIndex,
        logical.nextHandlerIndex,
        logical.routeIndex,
        logical.routeIndex + 1 === routeCount ? 1 : 0,
        tagConstants
      );
      const plainWords = [logical.nextKey, tag] as const;
      const words = plainWords.map((plain, wordIndex) => {
        const encrypted = threadedEncrypt(
          plain,
          logical.currentKey,
          nonce,
          wordIndex + 1,
          logical.handlerIndex,
          logical.nextHandlerIndex,
          logical.routeIndex,
          logical.routeIndex + 1 === routeCount ? 1 : 0,
          parameters
        );
        const decrypted = threadedDecrypt(
          encrypted,
          logical.currentKey,
          nonce,
          wordIndex + 1,
          logical.handlerIndex,
          logical.nextHandlerIndex,
          logical.routeIndex,
          logical.routeIndex + 1 === routeCount ? 1 : 0,
          parameters
        );
        if (decrypted[0] !== plain[0] || decrypted[1] !== plain[1]) {
          throw new Error('threaded Feistel inverse did not round trip');
        }
        return threadedPack(encrypted);
      });
      if (words.length !== THREADED_RECORD_WORDS) {
        throw new Error('threaded record word count is invalid');
      }
      return {
        nonce,
        routeIndex: logical.routeIndex,
        handlerIndex: logical.handlerIndex,
        nextHandlerIndex: logical.nextHandlerIndex,
        words: words as unknown as readonly [number, number]
      };
    }
  );

  const decode = (
    record: DispatcherThreadedRecord,
    currentKey: ThreadedPair,
    handlerIndex: number,
    selectedHandlerIndex: number,
    step: number
  ): readonly [ThreadedPair, ThreadedPair] => {
    const decoded = record.words.map((word, wordIndex) => threadedDecrypt(
      threadedUnpack(word),
      currentKey,
      record.nonce,
      wordIndex + 1,
      handlerIndex,
      selectedHandlerIndex,
      step,
      step + 1 === routeCount ? 1 : 0,
      parameters
    ));
    return decoded as unknown as readonly [ThreadedPair, ThreadedPair];
  };
  const authenticatedNextKey = (
    record: DispatcherThreadedRecord,
    currentKey: ThreadedPair,
    handlerIndex: number,
    selectedHandlerIndex: number,
    step: number
  ): ThreadedPair | undefined => {
    const [nextKey, tag] = decode(
      record, currentKey, handlerIndex, selectedHandlerIndex, step
    );
    const expectedTag = threadedTag(
      currentKey,
      record.nonce,
      nextKey,
      handlerIndex,
      selectedHandlerIndex,
      step,
      step + 1 === routeCount ? 1 : 0,
      tagConstants
    );
    const valid = nextKey[0] > 0
      && nextKey[1] > 0
      && tag[0] === expectedTag[0]
      && tag[1] === expectedTag[1];
    return valid ? nextKey : undefined;
  };
  const ciphertextSignatures = threadedRecords.map(record => record.words.join(':'));
  if (new Set(ciphertextSignatures).size !== ciphertextSignatures.length) {
    throw new Error('threaded record ciphertext tuple was reused');
  }
  for (let routeIndex = 0; routeIndex < routeCount; routeIndex += 1) {
    for (let handlerIndex = 0; handlerIndex < aliasCount; handlerIndex += 1) {
      const current = requireItem(
        requireItem(records, routeIndex, 'threaded source records'),
        handlerIndex,
        'threaded source record'
      );
      if (current.baseKeyLeft === undefined || current.baseKeyRight === undefined) {
        throw new Error('threaded source key is unavailable');
      }
      const currentKey = [current.baseKeyLeft, current.baseKeyRight] as const;
      for (let selectedHandlerIndex = 0; selectedHandlerIndex < aliasCount; selectedHandlerIndex += 1) {
        const matches = threadedRecords.flatMap(record => {
          const nextKey = authenticatedNextKey(
            record,
            currentKey,
            handlerIndex,
            selectedHandlerIndex,
            routeIndex
          );
          return nextKey === undefined ? [] : [nextKey];
        });
        if (matches.length !== 1) {
          throw new Error('threaded record program does not have exactly one authenticated match');
        }
        const nextKey = requireItem(matches, 0, 'threaded authenticated next key');
        const successor = requireItem(
          requireItem(baseRecords, routeIndex + 1, 'threaded expected successor states'),
          selectedHandlerIndex,
          'threaded expected successor state'
        );
        if (
          successor.baseKeyLeft !== nextKey[0]
          || successor.baseKeyRight !== nextKey[1]
          || threadedSlot(
            nextKey,
            routeIndex + 1,
            selectedHandlerIndex,
            aliasCount,
            slotConstants
          )
            !== successor.localSlot
        ) {
          throw new Error('threaded record authenticated the wrong successor state');
        }
      }
    }
  }

  const makeList = (label: string): DispatcherPacketList => ({
    listId: factory.symbol('l_', `${domain}-threaded-${label}`),
    listName: factory.name('no-preserve', `${domain}-threaded-${label}`),
    digitOrder: []
  });
  const program = makeList('state');
  const powers = makeList('records');
  const recordWords = threadedRecords.flatMap(record => record.words);
  target.lists[program.listId] = [
    program.listName,
    Array.from({length: TRANSIENT_EXPANDED_STATE_CELLS}, () => 0)
  ];
  target.lists[powers.listId] = [powers.listName, recordWords];
  const entryRecord = requireItem(
    rng.fork('threaded-entry-record').shuffle(requireItem(records, 0, 'threaded entry states')),
    0,
    'threaded entry state'
  );
  if (entryRecord.baseKeyLeft === undefined || entryRecord.baseKeyRight === undefined) {
    throw new Error('threaded entry key is unavailable');
  }
  const entryKey = [entryRecord.baseKeyLeft, entryRecord.baseKeyRight] as const;
  if (
    threadedSlot(entryKey, 0, entryRecord.handlerIndex, aliasCount, slotConstants)
    !== entryRecord.localSlot
  ) {
    throw new Error('threaded entry slot did not match its key-derived value');
  }
  for (let selectedHandlerIndex = 0; selectedHandlerIndex < aliasCount; selectedHandlerIndex += 1) {
    const entryMatches = threadedRecords.filter(record => authenticatedNextKey(
      record,
      entryKey,
      entryRecord.handlerIndex,
      selectedHandlerIndex,
      0
    ) !== undefined);
    if (entryMatches.length !== 1) {
      throw new Error('threaded entry key did not expose exactly its outgoing records');
    }
  }
  for (let step = 1; step <= routeCount; step += 1) {
    for (let handlerIndex = 0; handlerIndex < aliasCount; handlerIndex += 1) {
      for (let selectedHandlerIndex = 0; selectedHandlerIndex < aliasCount; selectedHandlerIndex += 1) {
        if (threadedRecords.some(record => authenticatedNextKey(
          record,
          entryKey,
          handlerIndex,
          selectedHandlerIndex,
          step
        ) !== undefined)) {
          throw new Error('threaded entry key authenticated a non-entry record');
        }
      }
    }
  }
  const tagCoefficients = Array.from(
    {length: 13},
    (_, index) => 1 + rng.fork(`threaded-state-tag-${index}`).integer(
      THREADED_RECORD_PRIME - 1
    )
  );
  return {
    modulus: EXPANDED_DISPATCHER_DOMAIN,
    packetDomain: EXPANDED_DISPATCHER_DOMAIN,
    descriptors: [...records.flat(), ...terminalRecords].map(record => ({
      row: record.cellIndex + 1,
      rho: record.currentLabel,
      routeIndex: record.routeIndex,
      lane: record.handlerIndex
    })),
    bank0: program,
    bank1: powers,
    routePolynomials: Array.from({length: routeCount}, () => ({slope: 0})),
    routeMaskTemplate: 0,
    checksum: 0,
    expandedBridge: {
      program,
      powers,
      delimiter: String.fromCharCode(0xe000)
        + rng.fork('threaded-token-delimiter').integer(0x1000).toString(16)
        + String.fromCharCode(0xe001),
      aliasCount,
      records,
      fieldMasks: [],
      tagCoefficients,
      powerSlots: [],
      programChecksum: threadedProgramChecksum(recordWords),
      entryRecord,
      terminalRecords,
      threadedProgram: {
        prime: THREADED_RECORD_PRIME,
        records: threadedRecords,
        ...parameters,
        routeCount,
        aliasCount,
        tagConstants,
        slotConstants
      }
    },
    entry: {
      key: 1 + rng.fork('threaded-entry-rolling-key').integer(THREADED_RECORD_PRIME - 1),
      witness: rng.fork('threaded-entry-witness').integer(THREADED_RECORD_PRIME),
      rho: rng.fork('threaded-entry-nonce').integer(THREADED_RECORD_PRIME),
      y: 0
    }
  };
}

function makeTransientExpandedDispatcherScheme(
  target: ScratchTarget,
  routeCount: number,
  aliasCount: number,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string
): DispatcherPacketScheme {
  if (
    aliasCount < MIN_EXPANDED_DISPATCHER_ALIASES
    || aliasCount > MAX_EXPANDED_DISPATCHER_ALIASES
  ) {
    throw new Error('transient dispatcher handler domain is outside its bounded range');
  }
  return makeThreadedTransientExpandedDispatcherScheme(
    target,
    routeCount,
    aliasCount,
    factory,
    rng.fork('threaded-record-program'),
    domain
  );
}

function makeExpandedDispatcherScheme(
  target: ScratchTarget,
  routeCount: number,
  aliasCount: number,
  factory: UniqueFactory,
  rng: DeterministicGenerator,
  domain: string
): DispatcherPacketScheme {
  if (
    aliasCount < MIN_EXPANDED_DISPATCHER_ALIASES
    || aliasCount > MAX_EXPANDED_DISPATCHER_ALIASES
  ) {
    throw new Error('expanded universal dispatcher requires a bounded handler count');
  }
  if (routeCount !== 4 && routeCount !== 8) {
    throw new Error('expanded universal dispatcher requires a four- or eight-command cohort');
  }
  return makeTransientExpandedDispatcherScheme(
    target,
    routeCount,
    aliasCount,
    factory,
    rng.fork('transient-runtime-bridge'),
    domain
  );
}
function packetIntegrityFold(
  checksum: number,
  bank0Word: number,
  bank1Word: number
): number {
  const mixed = (
    ((checksum % DISPATCHER_CHECKSUM_STATE_MODULUS) + bank0Word)
    * ((bank1Word % DISPATCHER_CHECKSUM_BANK_MODULUS) + DISPATCHER_CHECKSUM_BANK_OFFSET)
  ) + bank1Word;
  if (!Number.isSafeInteger(mixed)) throw new Error('dispatcher checksum arithmetic exceeded the exact integer domain');
  return mixed % DISPATCHER_CHECKSUM_MODULUS;
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
  const product = (first * second) * secret;
  if (!Number.isSafeInteger(product)) throw new Error('dispatcher route-mask arithmetic exceeded the exact integer domain');
  return packetMod(product, modulus);
}

function packetMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function packetInverse(value: number, modulus: number): number {
  let result = 1;
  let base = packetMod(value, modulus);
  let exponent = modulus - 2;
  while (exponent > 0) {
    if ((exponent & 1) === 1) result = packetMod(result * base, modulus);
    base = packetMod(base * base, modulus);
    exponent = Math.floor(exponent / 2);
  }
  if (packetMod(value * result, modulus) !== 1) {
    throw new Error('dispatcher multiplicative share is not invertible');
  }
  return result;
}

function packDispatcherWord(
  logicalDigits: readonly number[],
  digitOrder: readonly number[],
  modulus: number
): number {
  if (logicalDigits.length !== 4 || digitOrder.length !== 4) {
    throw new Error('dispatcher packed word requires four digits');
  }
  let word = 0;
  for (let power = 0; power < 4; power += 1) {
    const logicalIndex = requireItem(digitOrder, power, 'dispatcher digit order');
    const digit = requireItem(logicalDigits, logicalIndex, 'dispatcher logical digit');
    if (!Number.isInteger(digit) || digit < 0 || digit >= modulus) {
      throw new Error('dispatcher packed digit is outside its field');
    }
    word += digit * (modulus ** power);
  }
  if (!Number.isSafeInteger(word)) throw new Error('dispatcher packed word exceeds exact arithmetic');
  return word;
}

function unpackDispatcherWord(
  word: number,
  digitOrder: readonly number[],
  logicalIndex: number,
  modulus: number
): number {
  const power = digitOrder.indexOf(logicalIndex);
  if (power < 0) throw new Error('dispatcher logical digit is unavailable');
  return Math.floor(word / (modulus ** power)) % modulus;
}

type DispatcherExpression =
  | {readonly kind: 'number'; readonly value: number}
  | {readonly kind: 'string'; readonly value: string}
  | {readonly kind: 'variable'; readonly variable: DispatcherFrameVariable}
  | {readonly kind: 'list-length'; readonly list: DispatcherPacketList}
  | {
      readonly kind: 'list-item';
      readonly list: DispatcherPacketList;
      readonly index: DispatcherExpression;
    }
  | {
      readonly kind: 'operator';
      readonly opcode: string;
      readonly inputs: Readonly<Record<string, DispatcherExpression>>;
      readonly fields?: Readonly<Record<string, readonly JsonValue[]>>;
    };

function dispatcherNumber(value: number): DispatcherExpression {
  return {kind: 'number', value};
}

function dispatcherString(value: string): DispatcherExpression {
  return {kind: 'string', value};
}

function dispatcherVariable(variable: DispatcherFrameVariable): DispatcherExpression {
  return {kind: 'variable', variable};
}

function dispatcherListItem(
  list: DispatcherPacketList,
  index: DispatcherExpression
): DispatcherExpression {
  return {kind: 'list-item', list, index};
}

function dispatcherListLength(list: DispatcherPacketList): DispatcherExpression {
  return {kind: 'list-length', list};
}

function dispatcherOperator(
  opcode: string,
  inputs: Readonly<Record<string, DispatcherExpression>>,
  fields?: Readonly<Record<string, readonly JsonValue[]>>
): DispatcherExpression {
  return {kind: 'operator', opcode, inputs, ...(fields === undefined ? {} : {fields})};
}

function emitDispatcherExpression(
  target: ScratchTarget,
  parentId: string,
  expression: DispatcherExpression,
  factory: UniqueFactory,
  domain: string
): ScratchInput {
  let ordinal = 0;
  const emit = (parent: string, value: DispatcherExpression): ScratchInput => {
    if (value.kind === 'number') return numericInput(value.value);
    if (value.kind === 'string') return [1, [10, value.value]];
    if (value.kind === 'variable') {
      return [1, [12, value.variable.variableName, value.variable.variableId]];
    }
    const id = factory.block(domain + '-' + ordinal);
    ordinal += 1;
    if (value.kind === 'list-length') {
      target.blocks[id] = {
        opcode: 'data_lengthoflist',
        next: null,
        parent,
        inputs: {},
        fields: {LIST: [value.list.listName, value.list.listId]},
        shadow: false,
        topLevel: false
      };
      return [2, id];
    }
    if (value.kind === 'list-item') {
      target.blocks[id] = {
        opcode: 'data_itemoflist',
        next: null,
        parent,
        inputs: {INDEX: emit(id, value.index)},
        fields: {LIST: [value.list.listName, value.list.listId]},
        shadow: false,
        topLevel: false
      };
      return [2, id];
    }
    target.blocks[id] = {
      opcode: value.opcode,
      next: null,
      parent,
      inputs: Object.fromEntries(
        Object.entries(value.inputs).map(([name, input]) => [name, emit(id, input)])
      ),
      fields: Object.fromEntries(
        Object.entries(value.fields ?? {}).map(([name, field]) => [name, [...field]])
      ),
      shadow: false,
      topLevel: false
    };
    return [2, id];
  };
  return emit(parentId, expression);
}

function dispatcherBinary(
  opcode: string,
  leftName: string,
  left: DispatcherExpression,
  rightName: string,
  right: DispatcherExpression
): DispatcherExpression {
  return dispatcherOperator(opcode, {[leftName]: left, [rightName]: right});
}

function dispatcherAdd(left: DispatcherExpression, right: DispatcherExpression): DispatcherExpression {
  return dispatcherBinary('operator_add', 'NUM1', left, 'NUM2', right);
}

function dispatcherSubtract(left: DispatcherExpression, right: DispatcherExpression): DispatcherExpression {
  return dispatcherBinary('operator_subtract', 'NUM1', left, 'NUM2', right);
}

function dispatcherMultiply(left: DispatcherExpression, right: DispatcherExpression): DispatcherExpression {
  return dispatcherBinary('operator_multiply', 'NUM1', left, 'NUM2', right);
}

function dispatcherJoin(left: DispatcherExpression, right: DispatcherExpression): DispatcherExpression {
  return dispatcherBinary('operator_join', 'STRING1', left, 'STRING2', right);
}

function dispatcherLength(value: DispatcherExpression): DispatcherExpression {
  return dispatcherOperator('operator_length', {STRING: value});
}

function dispatcherGreater(left: DispatcherExpression, right: DispatcherExpression): DispatcherExpression {
  return dispatcherBinary('operator_gt', 'OPERAND1', left, 'OPERAND2', right);
}

function dispatcherRouteMaskExpression(
  template: 0 | 1,
  secret: DispatcherExpression,
  currentRho: DispatcherExpression,
  nextRho: DispatcherExpression,
  nextStep: DispatcherExpression
): DispatcherExpression {
  const first = template === 0
    ? dispatcherAdd(secret, nextRho)
    : dispatcherAdd(secret, currentRho);
  const second = template === 0
    ? dispatcherAdd(currentRho, nextStep)
    : dispatcherAdd(nextRho, nextStep);
  return dispatcherMultiply(dispatcherMultiply(first, second), secret);
}

function dispatcherMod(value: DispatcherExpression, modulus: number): DispatcherExpression {
  return dispatcherBinary('operator_mod', 'NUM1', value, 'NUM2', dispatcherNumber(modulus));
}

function dispatcherEquals(left: DispatcherExpression, right: DispatcherExpression): DispatcherExpression {
  return dispatcherBinary('operator_equals', 'OPERAND1', left, 'OPERAND2', right);
}

function dispatcherAnd(left: DispatcherExpression, right: DispatcherExpression): DispatcherExpression {
  return dispatcherBinary('operator_and', 'OPERAND1', left, 'OPERAND2', right);
}

function dispatcherOr(left: DispatcherExpression, right: DispatcherExpression): DispatcherExpression {
  return dispatcherBinary('operator_or', 'OPERAND1', left, 'OPERAND2', right);
}

function dispatcherNot(value: DispatcherExpression): DispatcherExpression {
  return dispatcherOperator('operator_not', {OPERAND: value});
}

function dispatcherAll(expressions: readonly DispatcherExpression[]): DispatcherExpression {
  const first = requireItem(expressions, 0, 'dispatcher conjunction');
  return expressions.slice(1).reduce(
    (combined, expression) => dispatcherAnd(combined, expression),
    first
  );
}

function dispatcherAny(expressions: readonly DispatcherExpression[]): DispatcherExpression {
  const first = requireItem(expressions, 0, 'dispatcher disjunction');
  return expressions.slice(1).reduce(
    (combined, expression) => dispatcherOr(combined, expression),
    first
  );
}

function dispatcherFloor(value: DispatcherExpression): DispatcherExpression {
  return dispatcherOperator('operator_mathop', {NUM: value}, {OPERATOR: ['floor', null]});
}

function dispatcherRound(value: DispatcherExpression): DispatcherExpression {
  return dispatcherOperator('operator_round', {NUM: value});
}

function dispatcherPackedDigit(
  wordValue: DispatcherExpression,
  list: DispatcherPacketList,
  logicalIndex: number,
  modulus: number
): DispatcherExpression {
  const power = list.digitOrder.indexOf(logicalIndex);
  if (power < 0) throw new Error('dispatcher packed digit is unavailable');
  if (power === 0) return dispatcherMod(wordValue, modulus);
  const divided = dispatcherFloor(dispatcherBinary(
    'operator_divide',
    'NUM1',
    wordValue,
    'NUM2',
    dispatcherNumber(modulus ** power)
  ));
  return power === 3 ? divided : dispatcherMod(divided, modulus);
}

function emitDispatcherSetVariable(
  target: ScratchTarget,
  id: string,
  parent: string | null,
  next: string | null,
  variable: DispatcherFrameVariable,
  value: DispatcherExpression,
  factory: UniqueFactory,
  domain: string,
  topLevel = false,
  x?: number,
  y?: number
): void {
  target.blocks[id] = {
    opcode: 'data_setvariableto',
    next,
    parent,
    inputs: {VALUE: emitDispatcherExpression(target, id, value, factory, domain)},
    fields: {VARIABLE: [variable.variableName, variable.variableId]},
    shadow: false,
    topLevel,
    ...(x === undefined ? {} : {x}),
    ...(y === undefined ? {} : {y})
  };
}

function emitDispatcherChangeVariable(
  target: ScratchTarget,
  id: string,
  parent: string,
  next: string | null,
  variable: DispatcherFrameVariable,
  value: number
): void {
  target.blocks[id] = {
    opcode: 'data_changevariableby',
    next,
    parent,
    inputs: {VALUE: numericInput(value)},
    fields: {VARIABLE: [variable.variableName, variable.variableId]},
    shadow: false,
    topLevel: false
  };
}

function makeDispatcherStop(parent: string): ScratchBlock {
  return {
    opcode: 'control_stop',
    next: null,
    parent,
    inputs: {},
    fields: {STOP_OPTION: ['this script', null]},
    shadow: false,
    topLevel: false,
    mutation: {tagName: 'mutation', children: [], hasnext: 'false'}
  };
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

function addDispatcherWitnessBucket(
  target: ScratchTarget,
  handler: DispatcherHandler,
  modulus: number
): void {
  target.blocks[handler.witnessModId] = {
    opcode: 'operator_mod',
    next: null,
    parent: handler.setWitnessId,
    inputs: {NUM1: [2, handler.witnessLengthId], NUM2: numericInput(modulus)},
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[handler.witnessLengthId] = {
    opcode: 'operator_length',
    next: null,
    parent: handler.witnessModId,
    inputs: {STRING: [2, handler.witnessReporterId]},
    fields: {},
    shadow: false,
    topLevel: false
  };
  target.blocks[handler.witnessReporterId] = {
    opcode: handler.witness.opcode,
    next: null,
    parent: handler.witnessLengthId,
    inputs: {},
    fields: Object.fromEntries(
      Object.entries(handler.witness.fields).map(([name, field]) => [name, [...field]])
    ),
    shadow: false,
    topLevel: false
  };
}

function addDispatcherRawWitness(
  target: ScratchTarget,
  handler: Pick<DispatcherHandler, 'setWitnessId' | 'witnessReporterId' | 'witness'>
): void {
  target.blocks[handler.witnessReporterId] = {
    opcode: handler.witness.opcode,
    next: null,
    parent: handler.setWitnessId,
    inputs: {},
    fields: Object.fromEntries(
      Object.entries(handler.witness.fields).map(([name, field]) => [name, [...field]])
    ),
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
        if (successorId && (isVirtualizableStackBlock(block) || isOfficialHatOpcode(block.opcode))) {
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
    opcode: 'data_replaceitemoflist',
    next: null,
    parent: railId,
    inputs: {
      INDEX: numericInput(1),
      ITEM: textInput(`r_${rng.id('d_', 10)}`)
    },
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
  stats: ObfuscationStats,
  maximumSiteGrowth: number
): void {
  if (mode !== 'no-preserve') return;
  const maximumDepth = 128;
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
  stats: ObfuscationStats,
  maximumSiteGrowth: number
): void {
  const maximumDepth = mode === 'lossy' ? 32 : 128;
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
