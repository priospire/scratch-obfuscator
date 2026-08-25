export type ObfuscationMode = 'lossless' | 'lossy' | 'no-preserve';

export interface ObfuscationOptions {
  readonly antiCheat?: boolean;
  readonly antiSave?: boolean;
  readonly allowSize?: boolean;
  readonly extra?: boolean;
  readonly onProgress?: (event: ObfuscationProgressEvent) => void;
}

export interface ObfuscationProgressEvent {
  /** Stable machine-readable name for the current transformation stage. */
  readonly stage: string;
  /** Completion within the in-memory transformation, from 0 through 100. */
  readonly percentage: number;
  /** Safe operational detail. Identifier mappings and project values are never included. */
  readonly detail?: string;
  readonly metrics?: Readonly<Record<string, number | string | boolean>>;
}

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue};

export type ScratchInput = JsonValue[];
export type ScratchField = JsonValue[];

export interface ScratchBlock {
  opcode: string;
  next: string | null;
  parent: string | null;
  inputs: Record<string, ScratchInput>;
  fields: Record<string, ScratchField>;
  shadow: boolean;
  topLevel: boolean;
  x?: number;
  y?: number;
  comment?: string | null;
  mutation?: Record<string, JsonValue>;
  [key: string]: JsonValue | Record<string, ScratchInput> | Record<string, ScratchField> | undefined;
}

export type ScratchBlockValue = ScratchBlock | ScratchInput;

export interface ScratchComment {
  blockId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  text: string;
  [key: string]: JsonValue;
}

export interface ScratchTarget {
  isStage: boolean;
  name: string;
  variables: Record<string, JsonValue[]>;
  lists: Record<string, JsonValue[]>;
  broadcasts: Record<string, string>;
  blocks: Record<string, ScratchBlockValue>;
  comments: Record<string, ScratchComment>;
  currentCostume: number;
  costumes: Array<Record<string, JsonValue>>;
  sounds: Array<Record<string, JsonValue>>;
  [key: string]: JsonValue | Record<string, ScratchBlockValue> | Record<string, ScratchComment> | undefined;
}

export interface ScratchProject {
  targets: ScratchTarget[];
  monitors: Array<Record<string, JsonValue>>;
  extensions: string[];
  meta: Record<string, JsonValue>;
  [key: string]: JsonValue | ScratchTarget[] | Array<Record<string, JsonValue>> | Record<string, JsonValue> | undefined;
}

export type ArchiveEntryContent =
  | {readonly kind: 'memory'; readonly data: Uint8Array}
  | {readonly kind: 'file'; readonly path: string};

export interface ArchiveEntry {
  readonly name: string;
  readonly content: ArchiveEntryContent;
  readonly contentHash: Uint8Array;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

export interface LoadedArchive {
  readonly projectBytes: Uint8Array;
  readonly project: ScratchProject;
  readonly entries: readonly ArchiveEntry[];
  readonly seed: Uint8Array;
  cleanup(): Promise<void>;
}

export interface ObfuscationStats {
  mode: ObfuscationMode;
  blocksBefore: number;
  blocksAfter: number;
  identifiersRenamed: number;
  symbolsRenamed: number;
  commentsRemoved: number;
  decoysAdded: number;
  virtualizedBlocks: number;
  variablesVirtualized?: number;
  listsVirtualized?: number;
  constantsFolded?: number;
  inactiveFallbacksRemoved?: number;
  antiCheatDecoys?: number;
  antiSaveCanaries?: number;
  privacyNamesRenamed?: number;
  privacyMonitorsCanonicalized?: number;
  privacyMetadataPropertiesRemoved?: number;
  warnings: string[];
  caveats?: string[];
  verification?: ObfuscationVerificationSummary;
}

export interface ObfuscationVerificationSummary {
  readonly scope: 'static-project-structure';
  readonly verdict: 'verified-with-caveats';
  readonly provenInvariants: number;
  readonly attributedPasses: number;
  readonly caveats: number;
}

export interface ObfuscationResult {
  project: ScratchProject;
  stats: ObfuscationStats;
}

export interface ResourceLimits {
  maxEntries: number;
  maxProjectBytes: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxTotalCompressedBytes: number;
  maxInflationRatio: number;
  maxPathComponents: number;
}

export const DEFAULT_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxEntries: 10_000,
  maxProjectBytes: 64 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxTotalCompressedBytes: 1024 * 1024 * 1024,
  maxInflationRatio: 200,
  maxPathComponents: 32
});
