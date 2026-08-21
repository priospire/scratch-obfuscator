# Scratch Obfuscator

`scratch-obfuscator` is a deterministic command-line transformer for official
Scratch 3 `.sb3` projects. It renames identifiers, obscures editor metadata and,
in the stronger modes, adds bounded data/control-flow indirection. Every output
is graph-validated before publication and every non-`project.json` archive
member is preserved byte-for-byte.

The package is private and is not published to the public npm registry. It
requires Node.js 22 or newer and supports Windows, macOS, and Linux.

## Installation

From a checkout:

```sh
npm ci
npm run build
node dist/cli.js --help
```

Authenticated users can install the private Git repository directly; the
package's prepare hook builds the executable during installation:

```sh
npm install --global git+ssh://git@github.com/priospire/scratch-obfuscator.git
```

An internal tarball is also installable through npm:

```sh
npm pack
npm install --global ./scratch-obfuscator-0.1.0.tgz
```

Both installed forms expose the `scratch-obfuscator` executable. Version 1 has
no public JavaScript library API, configuration file, seed option, network
operation, or stdin/stdout archive mode.

## CLI

```text
scratch-obfuscator <input.sb3> [-o <output.sb3>]
  [-lossless | -lossy | -no-preserve]
  [--force]
```

GNU spellings (`--lossless`, `--lossy`, and `--no-preserve`) are equivalent to
the requested single-hyphen forms. Modes are mutually exclusive and default to
`-lossless`. `--help` and `--version` are also available.

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

All modes remap block, variable, list, broadcast, and procedure-argument IDs;
rename eligible non-cloud variables, lists, procedure labels, and arguments;
strip comments; overlap top-level stacks; poison inactive obscured shadows; and
minify `project.json`. Target order, block-map order, input/field order,
declaration order, and hat order remain stable.

### `-lossless`

Lossless mode changes no executable operation graph, runtime state, stack
frame, variable/list/monitor count, hat, or procedure count. It adds and removes
zero block-equivalents. “No overhead” means the same executable opcode graph
and VM step topology; exact wall-clock equality across machines is not a
meaningful guarantee.

### `-lossy`

Lossy mode permits bounded CPU and archive-size overhead. A conservative static
eligibility gate admits live rewrites only for a single-threaded core-block
surface with no timer, randomness, live-input, asynchronous, clone, broadcast,
extension, procedure, or yield hazard. Eligible regions receive custom-block
outlining of maximal non-yielding top-level runs, interior string splitting,
contextual exact-domain finite numeric equations, condition inversion, opaque
predicates, dual-rail private branches, and bounded safe data/list decoys.
Hazardous projects fall back to the common lossless transforms plus inert
decoys.

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
two branch templates, trampolines, and fake states. Additional passes pool
and split eligible strings, encode exact numeric domains, move eligible private
sprite variables into shuffled list slots, add opaque branches and fake
data/procedures, and select decoys from the project's supported data/list opcode
vocabulary.

Regions that fail eligibility are left native rather than being speculatively
rewritten. This selective fallback is part of the contract.

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

## Runtime compatibility

Version 1 accepts projects in the current Scratch VM serializer shape and
validates them against the bundled `scratch-parser` 6.0.1 schema plus stricter
graph, ownership, scope, procedure, monitor, extension, and asset invariants.
The VM-supported name-resolved broadcast tuple is accepted as a deliberate
schema overlay. Legacy archives that omit current serializer collections are
rejected rather than silently normalized.

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
payload, mode, algorithm version, and package version, output bytes do not
depend on source ZIP order/metadata, destination path, working directory,
locale, timezone, or operating system.

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

Pinned compatibility tools have a separate security boundary; see
[`QA_SECURITY.md`](QA_SECURITY.md). Third-party schema licensing and trademark
notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

An executable Scratch project necessarily contains the information required to
run it. This tool provides deterministic, bounded resistance to human and
automated structural analysis; it is not encryption and cannot prevent a
purpose-built interpreter or deobfuscator from recovering behavior.
