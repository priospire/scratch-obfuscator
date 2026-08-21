# Scratch Obfuscator

`scratch-obfuscator` is a CLI transformer for `.sb3` projects. It renames identifiers, obscures editor metadata and,
in the stronger modes, adds bounded data/control-flow indirection. Every output
is graph-validated before publication and every non-`project.json` archive
member is preserved (BFB Byte For Byte). Scratch Obfuscator is part of PrioSDK Gen 4.

The package is private and is not published to the public npm registry. It
requires Node.js 22 or newer and supports Windows, macOS, and Linux.

## Installation

From a checkout:

```sh
npm ci
npm run build
node dist/cli.js --help
```

Authenticated users can install the private Git repository directly, the
package's prepare hook builds the executable during installation:

```sh
npm install --global git+ssh://git@github.com/priospire/scratch-obfuscator.git
```

An internal tarball is also installable through npm:

```sh
npm pack
npm install --global ./scratch-obfuscator-0.3.0.tgz
```

Both installed forms expose the `scratch-obfuscator` executable. This release has
no public JavaScript library API, configuration file, seed option, network
operation, or stdin/stdout archive mode.

## CLI

```text
scratch-obfuscator <input.sb3> [-o <output.sb3>]
  [-lossless | -lossy | -no-preserve]
  [-anticheat]
  [--force]
```

GNU spellings (`--lossless`, `--lossy`, `--no-preserve`, and `--anticheat`) are
equivalent to the requested single-hyphen forms. Modes are mutually exclusive
and default to `-lossless`. The anti-cheat modifier is independent and can be
combined with any mode. `--help` and `--version` are also available.

Without `-o`, the output is `<input-stem>.obfuscated.sb3` beside the input. An
existing output is rejected unless `--force` is present. Paths, symlinks, and
hardlinks that resolve the input and output to the same file are rejected.
Writes use a validated same-directory temporary file. Replacement uses a
durable backup/journal transaction so an interrupted later invocation can
recover the prior output.

| Exit | Meaning |
|---:|---|
| `0` | Success |
| `2` | Invalid CLI usage or conflicting options |
| `3` | Invalid or unsupported input |
| `4` | Filesystem, publication, or interruption failure |
| `5` | Unexpected internal failure |

Success summaries go to stdout. Diagnostics and deterministic warnings go to
stderr; the identifier mapping is never printed.

## Obfuscation modes

All modes remap block, variable, list, broadcast, and procedure-argument IDs.
rename eligible non-cloud variables, lists, procedure labels, and arguments.
strip comments, overlap top-level stacks, remove inactive saved defaults hidden
under active reporters, and minify `project.json`. Every output also contains
an intentionally readable Stage watermark variable. If that exact Stage
watermark already exists, its value is retained. Target order, block-map order,
input/field order, declaration order, and hat order remain stable. Every other
renamable display symbol receives a long deterministic opaque name; names that
Scratch resolves dynamically remain frozen when changing them could alter
behavior.

### `-lossless`

Lossless mode changes no original executable operation graph, stack frame,
live list/monitor count, hat, or procedure count. It does not fold or insert an
executed reporter or command. The mandatory watermark is the one deliberate
added Stage variable, and inactive saved fallback primitives may be removed
because Scratch never executes them. An invisible data monitor naming a missing
sprite may also be removed with a warning only when its typed ID resolves to no
live Stage declaration.
"No overhead" means the same executable
opcode graph and VM step topology; exact wall-clock equality across machines is
not a meaningful guarantee.

### `-lossy`

Lossy mode permits bounded CPU and archive-size overhead. A conservative static
eligibility gate admits live rewrites only for a single-threaded core-block
surface with no timer, randomness, live-input, asynchronous, clone, broadcast,
extension, procedure, or yield hazard. Eligible regions receive custom-block
outlining of maximal non-yielding top-level runs, portable exact-domain constant
folding, interior string splitting, contextual finite numeric equations,
condition inversion, opaque predicates, dual-rail private branches, bounded
guarded data/list decoys, and scalar packing. Lossy mode adds no event hats;
its generated data paths remain behind statically false private guards. Packing
uses one backing list for eligible Stage globals and one per sprite for
eligible locals so clone-local state remains local. Cloud, monitored,
dynamically addressed, unsupported,
malformed, and over-budget variables remain native. Hazardous projects fall
back to the common lossless transforms plus inert decoys.

The live passes add no deliberate yield point and preserve original random and
input sampling sites. The gate is intentionally conservative; it is not a
general proof system for arbitrary Scratch concurrency.

### `-no-preserve`

No-preserve mode is the strongest bounded transform. It preserves loadability
and targets the same sequential final effects, while explicitly waiving timer
and live-input sampling time, responsiveness, redraw cadence, thread
interleaving, race outcomes, and manual stack-click behavior.

Eligible top-level straight-line runs are split into dispatcher regions of 4–17
supported core commands and routed through encoded program counters. Native hats, C-blocks,
yield/async anchors, unknown regions, warp/procedure bodies, recursion, and
uncertain re-entrant ownership remain native. Dispatchers use shuffled handler
procedures, permuted labels, indirect transition lists with variable-width junk,
two branch templates, trampolines, and fake states. Additional passes pool and
split eligible strings, precompute portable static reporter trees, encode exact
numeric domains, pack eligible Stage and sprite scalars into shuffled per-scope
list slots, add opaque branches and fake data/procedures, and select decoys from
the project's supported data/list opcode vocabulary. Bounded coherent fake
subsystems connect paired opaque broadcasts, multiple receiver hats, shared
custom procedures, private state/list predicates, nested reporters, and finite
wait arithmetic. Read-only answer, mouse-position, and timer reporters feed
runtime-dependent sponsor guards. If one opens, its bounded path mutates only a
dedicated decoy variable/list store and terminates; it cannot touch packed or
dispatcher state. Separate impossible private state/list predicates retain the
requested never-true motifs, while the mixed dependency graph survives
constant propagation and dead-root pruning. Generated dispatcher and protection
state, cloud variables, monitored variables, and conservatively excluded
original state remain scalar exceptions.

Regions that fail eligibility are left native rather than being speculatively
rewritten. This selective fallback is part of the contract.

### `-anticheat`

Anti-cheat is an opt-in modifier, not a fourth obfuscation mode. The watermark
is present even without this flag. The modifier adds exactly six opaque Stage
sentinels and a private session latch. Changing any sentinel trips the latch at
the next watchdog check, stops all running scripts, and prevents the project's
pre-existing green-flag, key, broadcast, click, clone, and supported extension
hats from continuing during that loaded session. One shared hidden guard
procedure per affected target keeps the entry checks bounded.

The latch, checks, and decoys add executable blocks, state, archive size, and
runtime work. Consequently, `-lossless -anticheat` preserves the original
program through the lossless base passes but does not retain the lossless
no-overhead graph contract for the added protection layer. Detection occurs at
scheduler check points; it cannot make arbitrary editor changes literally
instantaneous.

This is tamper resistance, not cryptographic protection. A determined attacker
can inspect a self-contained project, remove checks, invoke a stack manually,
reload the project, or restore a clean copy. The latch is deliberately
irreversible through normal event entry within the current loaded session, but
it does not persist across a reload or damage the source archive.

### Growth bounds

Let `N` be the pre-aggressive normalized block-equivalent count, where object
blocks and inline primitives/shadows each count once.

| Mode | Maximum total block-equivalents | Per-site additions | Generated depth |
|---|---:|---:|---:|
| Lossless | `N` | `0` | unchanged |
| Lossy | `max(N, min(4N, 50,000))` | `64` | `32` |
| No-preserve | `max(N, min(25N + 512, 100,000))` | `256` | `128` |

Pass quotas follow the documented control/literal/opaque/decoy allocation and
unused capacity rolls forward. Each eligible pass is considered once in a
deterministic hashed order.

The anti-cheat layer is an explicit additive exception applied after the mode
cap. Let `T` be the number of targets with protected event hats and `H` the
number of protected hats. Each target guard checks the full protected sentinel
set before latching and stopping. The layer adds `36 + 36T + H` object blocks
when it creates the mandatory watermark, or `32 + 32T + H` when reusing one.
Including inline literal primitives, the corresponding normalized additions
are `45 + 45T + H` or `40 + 40T + H`.

## Runtime compatibility

This release accepts projects in the current Scratch VM serializer shape and
validates them against the bundled `scratch-parser` 6.0.1 schema plus stricter
graph, ownership, scope, procedure, monitor, extension, and asset invariants.
The VM-supported name-resolved broadcast tuple is accepted as a deliberate
schema overlay. Legacy archives that omit current serializer collections are
rejected rather than silently normalized.

Some official editors and project generators save runtime-recoverable metadata
that is stricter than the canonical graph shape. The input compatibility layer
disambiguates repeated IDs only when they belong to different sprite-local
scopes, removes inactive mode-3 shadow fallbacks whose serialized parent is
missing or whose fallback root was incorrectly marked top-level, and discards
invisible data monitors that still name a deleted sprite only when their typed
ID resolves to no live Stage declaration.
The transformed archive must then pass the normal strict validator. Same-target
collisions, Stage/local collisions, live or multiply-owned orphan blocks, and
visible dangling monitors remain errors because resolving them would require a
behavior-changing guess. Repeated data-monitor records on a reused local ID are
accepted only when every record resolves to the same declaration owner;
ambiguous multi-owner records and cross-owner show/hide coupling remain
rejected to preserve Scratch's monitor coalescing behavior.

Supported code is official Scratch 3 core code plus the bundled extension IDs
registered by Scratch VM 15.1.0: Boost, EV3, Face Sensing, Go Direct Force &
Acceleration, Makey Makey, micro:bit, Music, Pen, Text to Speech, Translate,
Video Sensing, and WeDo 2.0. Official extension payloads are retained. Custom or
nonstandard extension IDs/opcodes are rejected with an input diagnostic.

Cloud variable names are frozen because they identify remote state. Stage,
sprite, costume/backdrop, sound, and broadcast display names remain readable
where computed-name lookup can observe them. Name-based sensing and ambiguous
legacy references conservatively freeze the affected namespace. Comments,
workspace layout, and manual editing behavior are outside the equivalence
boundary.

## Deterministic archive and input limits

The generation stream is derived from domain-separated SHA-256/counter streams
over the source `project.json` bytes and sorted entry-name/content hashes. It
never consumes Scratch's runtime random source. For a fixed uncompressed archive
payload, mode, anti-cheat setting, algorithm version, and package version,
output bytes do not depend on source ZIP order/metadata, destination path,
working directory, locale, timezone, or operating system.

The writer emits `project.json` first, then other names in UTF-8 byte order,
using pinned pure-JavaScript DEFLATE settings and fixed timestamps, attributes,
permissions, flags, and separators. Every output is reopened, parsed, graph- and
asset-validated before commit.

Inputs reject duplicate/case-or-normalization-colliding paths, traversal or
absolute names, symlinks, encryption, unsupported compression, CRC or
local/central-header disagreement, duplicate JSON keys, invalid UTF-8/JSON,
missing assets, and decompression bombs.

| Resource | Limit |
|---|---:|
| ZIP entries | 10,000 |
| Input `project.json` | 64 MiB |
| One asset | 512 MiB |
| Total compressed content | 1 GiB |
| Total uncompressed content | 1 GiB |
| Inflation ratio | 200× per entry |
| Path components | 32 |
| Transformed JSON, lossless/lossy | 64 MiB |
| Transformed JSON, no-preserve | 128 MiB |

## Quality gates

```sh
npm run typecheck
npm run lint
npm run audit:runtime
npm test
npm run test:coverage
npm run build
npm pack
```

`npm run qa` runs the strict typecheck, lint, production-dependency audit,
coverage suite, and build. Coverage thresholds are 95% for statements,
functions, and lines and 90% for branches across all production source,
including the CLI.

The test suite includes deterministic/property transforms, official VM
load/serialize/reload and execution checks, per-step semantic traces, an
adversarial normalizer, malformed ZIP/JSON/reference corpora, output fault and
recovery injection, packed executable installation, Unicode paths, and archive
golden hashes. The hosted workflow runs Node 22 and 24 on Windows, Ubuntu, and
macOS, compares all six SHA-256 manifests, and runs a headless Scratch GUI
load/save/reload smoke test. Extended malformed/property fuzzing is available
through the manual workflow input.

The checkout also includes a deterministic structural-recovery evaluator:

```sh
node scripts/readability-metrics.mjs \
  --baseline original.sb3 \
  --candidate lossless=lossless.sb3 \
  --candidate lossy=lossy.sb3 \
  --candidate no-preserve=no-preserve.sb3 \
  --summary
```

It reports identifier exposure, direct-chain and normalized-chain recovery,
normalization-resistant component quality, indirection, dependency kinds,
paired event surfaces, repeated local signatures, and depth-2 topology
diversity. Its state-aware normalizer follows event/procedure reachability,
propagates finite declaration domains, mirrors Scratch numeric/string
comparison coercion, and prunes provably false graphs. The gates prove that
adding 2,000 repeated unreachable blocks cannot improve the score and that a
10,444-block stress output retains at least 8,000 blocks with bounded repeated
signatures and more than 1,800 normalized topology kinds.

This evaluator is an offline checkout QA utility for trusted local fixtures;
untrusted archives must go through the resource-limited production CLI.

On the fixed fallback-sensitive fixture the current resistance scores are
26.323 (original), 44.138 (lossless), 44.138 (lossy, conservatively fallen
back), and 94.243 (no-preserve); no-preserve direct and normalized chain
recovery are both 0.070. On the fully eligible comparison, no-preserve scores
95.477 versus lossy's 89.805 and recovers no original 3- or 4-block chain. The
previous no-preserve iteration scored 82.578 and trailed lossy by 1.668 on that
same class of fixture, so the regression measures a real structural
improvement rather than raw output growth. These are same-fixture structural
heuristics, not absolute security or subjective-readability guarantees.

Pinned compatibility tools have a separate security boundary; see
[`QA_SECURITY.md`](QA_SECURITY.md). Third-party schema licensing and trademark
notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

An executable Scratch project necessarily contains the information required to
run it. This tool provides deterministic, bounded resistance to human and
automated structural analysis; it is not encryption and cannot prevent a
purpose-built interpreter or deobfuscator from recovering behavior.
