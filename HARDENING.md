# Scratch Obfuscator 0.6 hardening record

## Status and security objective

This document records the implemented 0.6 hardening work, its attacker model,
the ideas deliberately rejected, and the remaining recovery paths. Release
publication remains conditional on semantic tests, adversarial evaluation,
packed/browser checks, and cross-platform golden hashes.

Scratch Obfuscator aims to make a self-contained `.sb3` project substantially
more expensive to understand and modify while keeping transformation behavior
deterministic and bounded. It does not claim cryptographic confidentiality or
irreversible tamper prevention. The person inspecting a project receives the
entire archive, can run or instrument the same public Scratch runtime, can edit
`project.json`, and can restore an earlier copy. No secret embedded in that
project can remain secret from such a person.

The mode contracts remain the first constraint:

- `-lossless` must retain the original executable opcode graph and VM step
  topology, apart from the documented watermark and inactive serialized data
  cleanup.
- `-lossy` may add bounded work, but live rewrites require a proof that original
  yields, random calls, input sampling, ordering, and observable results are
  preserved.
- `-no-preserve` may trade timing, responsiveness, redraw cadence, and thread
  interleaving for stronger protection, but eligible sequential regions must
  still retain their intended final behavior.
- `-anticheat` may add checks and authenticated private state in any mode. It can
  stop a tampered loaded session; it cannot prevent someone from removing the
  checks or restoring an unmodified archive.

Official Scratch behavior is the semantic authority. In particular, the design
is constrained by the official [SB3 serializer](https://github.com/scratchfoundation/scratch-editor/blob/develop/packages/scratch-vm/src/serialization/sb3.js),
[block store](https://github.com/scratchfoundation/scratch-editor/blob/develop/packages/scratch-vm/src/engine/blocks.js),
[sequencer](https://github.com/scratchfoundation/scratch-editor/blob/develop/packages/scratch-vm/src/engine/sequencer.js),
[data primitives](https://github.com/scratchfoundation/scratch-editor/blob/develop/packages/scratch-vm/src/blocks/scratch3_data.js),
[coercion rules](https://github.com/scratchfoundation/scratch-editor/blob/develop/packages/scratch-vm/src/util/cast.js),
and [target/clone implementation](https://github.com/scratchfoundation/scratch-editor/blob/develop/packages/scratch-vm/src/engine/target.js).

## Threat model

The evaluator assumes an adversary can:

- unzip, normalize, edit, and repack the project without using the Scratch GUI;
- canonicalize IDs, names, block-map order, coordinates, and other editor-only
  metadata;
- remove unreachable graphs, fold transparent expressions, inline simple custom
  blocks, and reconstruct direct control-flow edges;
- trace reads and writes, follow procedure calls, recover dispatcher states and
  transitions, and propagate constant list slots;
- run chosen inputs, compare traces and outputs, mutate candidate state, and
  compare multiple obfuscated builds; and
- delete a watchdog, replace authenticated state with plain state, or distribute
  a clean copy once the protection is understood.

The adversary does not receive an identifier map, but the design does not treat
opaque names or hidden monitors as secrets. Protection must survive normalization
of those superficial features. Network services, custom runtime extensions, and
trusted hardware are outside the v1 trust boundary.

Assets remain byte-for-byte inputs to the output archive. They may reveal game
meaning through filenames, images, sounds, or text embedded in media; changing
that contract is a separate feature with different compatibility and copyright
risks.

## Attacker-first evaluation

Every protection is evaluated against a stronger normalizer before it receives
implementation credit. The normalizer should first erase names, IDs, layout,
dead roots, transparent constants, and trivial custom-block wrappers. Its next
stage should build a call graph and control-flow graph, model known Scratch list
operations, propagate proven constant slots, identify encoded program counters
and tags, reconstruct transition tables, and collapse dispatcher handlers when
their semantics are recoverable. A mutation harness should then alter likely
gameplay state and report whether integrity checks are both triggered and
independent of obvious decoy state.

This ordering prevents block-count inflation from being mistaken for security.
A transformation earns value only when at least one of these measurements
improves after normalization:

1. more live dependencies must be understood before the original control flow
   or data representation can be recovered;
2. a single local rewrite no longer removes the protection;
3. semantic recovery requires correlating multiple procedures, stores, or
   execution boundaries; or
4. mutation of authenticated live state is detected without false trips on
   valid executions.

The release records normalized structural metrics, recovery rates, mutation
results, runtime operations, archive growth, fallback reasons, and semantic
differential results. It also retains simple transparent transforms in the
attacker because synthesis-based deobfuscation can recover surprisingly complex
expression semantics; [Syntia](https://www.usenix.org/conference/usenixsecurity17/technical-sessions/presentation/blazytko)
is the relevant primary example. Diverse expressions are useful only as one
layer: [LOKI](https://www.usenix.org/system/files/sec22-schloegel.pdf) likewise
motivates combining protections instead of relying on a single recognizable
grammar. Path-sensitive dependencies are evaluated separately, informed by
[path-oriented protections](https://arxiv.org/abs/1908.01549).

## Ranked release directions

| Rank | Direction | Expected resistance after normalization | Semantic risk | Runtime/size cost | Release disposition |
|---:|---|---|---|---|---|
| 1 | Per-region effect certificates | Foundational: safely admits more protected regions without weakening fallback | Low when rejection is conservative | Analysis only | Implemented |
| 2 | Nested control-flow virtualization | High for eligible live regions because direct substack chains disappear | Medium | High, bounded | Implemented for `-no-preserve` |
| 3 | Evolving-key, dual-rail dispatch with split stores | High when state, authentication, and transitions cannot be collapsed independently | Medium | High, bounded | Implemented for `-no-preserve` |
| 4 | Gameplay-state authentication with interlocking guards | Medium-high against casual variable editing and one-point watchdog removal | Medium | Medium-high, opt-in | Implemented for `-anticheat` |
| 5 | Fixed-list heap permutation | Medium-high for projects with statically addressable list state | Medium | Low-medium | Implemented for a proven subset |
| 6 | Standalone literal equations, dead graphs, or generic opaque predicates | Low after folding and reachability analysis | Low | Low-high | Retained as a supporting layer |

The rankings describe measured or expected value against the evaluator, not
mathematical security. On the dedicated five-command regression, the current
evaluator recognizes three rails, three indexed stores, six routes, and five
real handlers, but recovers zero transition edges and no original opcode chain;
four live edges remain unresolved and the result is classified
`structural-only`. This is stronger than the previous flow-insensitive
normalizer, not proof against execution-based recovery.

### 1. Per-region effect certificates

A whole-project safety gate leaves protectable code untouched when an unrelated
script contains a hazard. The implementation instead computes a certificate for each candidate
region. The analysis records:

- variables and lists read or written, their Stage/sprite ownership, cloud and
  monitor exposure, and possible dynamic-name aliases;
- procedure calls, argument evaluation order, warp status, recursion strongly
  connected components, and unknown callees;
- yields, redraw requests, timer reads, live input, random sampling, sound or
  asynchronous work;
- broadcasts, clones, re-entry, event restarts, stop behavior, and competing
  readers or writers; and
- the exact entry connector, exits, native C-block anchors, and nested substack
  ownership.

A certificate either admits one named transformation or rejects it with a
stable reason. Unknown opcodes and ambiguous references reject rather than
guess. Certificates are pass-specific: a region safe for renaming need not be
safe for outlining, store conversion, or dispatcher insertion. This makes
fallback local and auditable while respecting the scheduler's observable thread
and yield behavior.

### 2. Nested control-flow virtualization

Top-level linear scripts are only part of a real project. The design extends
region discovery into `SUBSTACK` and `SUBSTACK2` bodies while preserving their
native containing C-block. For an eligible non-yielding linear run, its parent
input or predecessor is redirected into a bounded dispatcher and all exits are
reconnected to the original continuation. Native hats, branches, loops, waits,
async operations, unsupported extension blocks, and yield anchors remain
outside the region.

Handlers share a deterministically shuffled custom-procedure bucket rather than
expose one procedure definition per original command. A nested selector couples
the decoded state and tag rails, while trampolines, shuffled labels, and fake
states increase the work required to reconstruct the original chain. Each
pattern has an explicit graph invariant and is validated after serialization. Regions with
recursion, warp uncertainty, re-entry, clone/broadcast races, or unresolved
ownership fall back intact.

### 3. Evolving-key dual-rail dispatcher with split stores

A fixed program-counter variable beside a fixed tag variable is easy to identify
and symbolically collapse. The implemented dispatcher advances encoded state,
authentication tag, and key rails together using exact Scratch arithmetic.
State values, tags, key deltas, and unrelated junk are split across three private
list stores. Each store uses a different deterministically permuted modulus, and
the evolving key computes the live index at runtime. Handler selection depends
on consistent decoded values from more than one rail.

The key is diversification material, not a secret: every formula and finite
store is in the archive. The value is structural coupling. Recovering or
patching one handler requires reconstructing the matching state transition, tag
update, key delta, modulo-indexed store layout, and fused selector. Generated
arithmetic is verified over Scratch's actual coercions, avoids runtime
randomness, and stays within depth and growth budgets. A small path-sensitive
interpreter can still start at the embedded exit key, execute the entry lookup,
solve each route, execute its handler, and repeat. Coupling future key evolution
to genuine handler-produced values could raise that cost further, but cannot
remove this self-contained recovery path.

### 4. Gameplay-state authentication and interlocking guards

Decoy sentinels detect edits only when the editor happens to change a decoy.
The stronger anti-tamper design protects eligible real gameplay scalars. Each
protected value is represented by encoded shares or a value plus an
authentication tag. Every statically understood read and write is rewritten as
one transaction, and checks are distributed among existing event, procedure,
and safe loop boundaries. Several guards validate different portions of the
state and protect each other's latch/control data, avoiding a single obvious
watchdog.

This direction follows the distributed-protection motivation of
[Protecting Software Code by Guards](https://doi.org/10.1007/3-540-47870-1_10),
but applies independently designed Scratch transformations. A state item is
eligible only when every access is understood and its additional operations are
allowed by the selected mode. Cloud variables, visible monitors, computed-name
access, unknown extensions, unsafe clone sharing, race-sensitive state, and
ambiguous procedure effects stay native. Mutation tests must target real state,
tags, guard control, and decoys separately and must also prove valid gameplay
does not trip a guard.

The required watermark is itself a protected sentinel. If the exact Stage
declaration already exists, its ID and current scalar value are preserved and
that value becomes the watchdog expectation; the transformer neither inserts a
duplicate nor silently resets project-owned state.

Because the checks execute in an attacker-controlled program, this raises the
cost of casual editing rather than establishing a trusted boundary. A skilled
person can remove all dependent checks, and no local mechanism can make a
project stop “forever” after an older clean file is restored.

### 5. Fixed-list heap permutation

General Scratch lists have subtle observable behavior, so the accepted design is
narrow. A list can enter a shared permuted heap only when static analysis proves
that it has fixed length and every access is a supported, constant, canonical
in-range item read or replacement. The transformer assigns its items to
deterministically shuffled heap slots, inserts bounded junk slots, rewrites all
certified accesses, and removes the original declaration only after the typed
reference walker proves no use remains.

Any add, delete, insert, dynamic index, `last`, `all`, `random`, `any`, item
search, contents/length observation, monitor, cloud exposure, unknown opcode, or
uncertain clone interaction rejects the entire list conversion. This boundary
is required because Scratch list indices use special coercion and random index
forms, and clone-local lists are copied as target state. A partial rewrite would
silently change behavior.

## Rejected or deferred directions

### Encryption and absolute secrecy

Encrypting blocks or data inside a self-contained `.sb3` cannot hide the
decryption logic and key from someone who can execute and inspect the project.
It can add another encoding layer, but describing it as encryption-backed
secrecy would be misleading. General virtual-black-box obfuscation is impossible
for broad program classes; the foundational result is
[On the (Im)possibility of Obfuscating Programs](https://www.wisdom.weizmann.ac.il/~oded/PS/obf3.pdf).
The release therefore promises bounded resistance, not unrecoverability.

### Archive self-hashing in Scratch

Ordinary Scratch blocks cannot read their own `.sb3` ZIP bytes or a canonical
serialization of `project.json`. ZIP order, compression, and metadata are also
outside project execution. A stored expected digest plus an in-project checker
would cover only values deliberately fed into that checker, and an offline
editor could remove both. Authenticated live state is more honest and testable.

### Remote authority

A server can keep authoritative currency, entitlements, or scores outside the
downloaded archive, which materially changes the trust boundary. It also adds
accounts, availability, privacy, network access, abuse handling, and usually a
custom extension or modified runtime. The CLI's v1 archive-only contract has no
network access, so server-backed authority is deferred to a separate product
design rather than smuggled into obfuscation.

### Random-source-consuming tricks

Generated protections must not consume Scratch's runtime random source. An
extra random call changes later values and call boundaries even when its result
looks irrelevant. Similar reasoning applies to timer, answer, keyboard, mouse,
loudness, and other live-input reporters. Deterministic generation uses the
archive-derived hash stream; runtime sampling is retained only at original sites
unless the no-preserve contract explicitly permits a proven, documented
divergence.

### Unsafe timing and concurrency rewrites

Procedure calls, warp mode, redraw requests, waits, broadcasts, clones, stop
blocks, event restarts, and concurrent variable access interact with the
sequencer. Moving an operation across one of those boundaries may change both
timing and final state. Lossy transformations therefore require effect
certificates and preserve original yield/sample boundaries. No-preserve waives
some temporal observations, but it still rejects regions whose intended final
effect is race-dependent or whose ownership/re-entry cannot be established.

### Generic dynamic-list virtualization

Reimplementing every list operation through a shared heap would need to match
Scratch's numeric/string coercion, one-based and special indices, random index
consumption, item comparison, length limits, monitor exposure, and clone-copy
behavior. It would also add substantial executable overhead and produce a large,
recognizable interpreter. Only the fixed-list subset above is accepted until an
exhaustive differential model proves broader behavior.

### Bidirectional controls and unsafe invisible names

Bidirectional controls, NUL, BOM, control newlines, unpaired surrogates,
zero-width joiners, and zero-width non-joiners are rejected. They create editor,
terminal, review, normalization, and interoperability hazards without protecting
runtime semantics. Any display-name hardening must be NFC-stable, collision
tested through VM/GUI round trips, and fall back to private-use characters or
opaque ASCII when normalization is uncertain.

### Unlicensed implementation copying

Public obfuscators and research prototypes may suggest techniques, but their code
is not copied unless a compatible license and provenance review explicitly
permit it. Papers define ideas and evaluation targets; this project implements
its own typed-reference, analysis, encoding, and validation logic against the
official runtime. Unknown or incompatible licensing is a hard rejection.

### Syntactic inflation as a primary defense

Dead blocks, simple literal splitting, one-template opaque predicates, and
single-use wrapper procedures are easy normalization targets. They remain useful
as bounded camouflage around live coupled structures, but are not counted as a
high-value protection by themselves. Flexible diversification can make
pattern-matching harder, as explored by
[Flexible Software Protection](https://arxiv.org/abs/2012.12603), but every
additional template still has to survive this project's attacker and semantic
tests.

## Release gates and limitations

An accepted implementation must pass strict structural validation before and
after archive publication, official VM load/serialize/reload checks, browser
load/save/reload smoke tests, semantic differential fixtures, mutation tests,
malformed-input fuzzing, deterministic archive hashes, packed-install tests, and
the Windows/macOS/Linux matrix. The evaluator must demonstrate that the new
structure survives its pre-existing simplifications and record what the new
recovery stages can still undo.

The remaining limitations are deliberate:

- a purpose-built interpreter or deobfuscator can eventually recover behavior;
- local anti-tamper has no external root of trust and can be removed;
- exact names for cloud or dynamically addressed state, visible asset/target
  metadata, and unsupported regions may remain readable for compatibility;
- conservative certificates will produce false rejections rather than unsafe
  rewrites, so protection strength varies by project structure; and
- stronger modes consume project size and execution budget under fixed caps.

The practical success criterion is not “nobody can see or change it.” It is that
the deterministic output remains compatible, transformations are honest about
their semantic boundary, and recovering or safely altering meaningful live
state requires materially more cross-region reasoning than normalizing names and
deleting decoys.
