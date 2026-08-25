# Scratch Obfuscator

Scratch Obfuscator is a deterministic command-line transformer for Scratch 3 `.sb3`
projects. It renames safe identifiers, cleans editor-only data, and adds bounded
data and control-flow indirection. It is part of the PrioSDK Gen 4 suite.

It supports Windows, macOS, and Linux on Node.js 22 or newer. The public
[repository](https://github.com/priospire/scratch-obfuscator) keeps the npm package
private only to prevent accidental registry publication.

## Install

From the public repository:

```sh
npm install --global git+https://github.com/priospire/scratch-obfuscator.git
scratch-obfuscator --help
```

From a checkout:

```sh
npm ci
npm run build
npm link
scratch-obfuscator --help
```

Or run `npm pack` and install the resulting `.tgz` globally. Quote paths containing spaces.

## Run

```text
scratch-obfuscator <input.sb3> [-o <output.sb3>]
  [-lossless | -lossy | -no-preserve]
  [-anticheat] [-antisave] [-extra] [-allowsize]
  [-verbose [max]] [--force]
```

```sh
scratch-obfuscator game.sb3
scratch-obfuscator game.sb3 -lossy -verbose
scratch-obfuscator game.sb3 -no-preserve -anticheat -antisave
scratch-obfuscator game.sb3 -no-preserve -extra -allowsize -verbose max
```

Mode and modifier flags accept single- and double-hyphen spellings. Modes are
mutually exclusive and default to `-lossless`. Without `-o`, output is
`<input-stem>.obfuscated.sb3`. Existing output requires `--force`; input and output
cannot be the same file or link.

| Option | Behavior |
|---|---|
| `-lossless` | Renames and cleans serialized data without changing the original executable opcode graph or VM step topology. |
| `-lossy` | Adds statically admitted non-yielding rewrites, packing, encoded literals, branches, and decoys. Unsafe regions fall back. |
| `-no-preserve` | Uses the strongest bounded virtualization and data indirection, while waiving timing, responsiveness, redraw, and thread-interleaving equivalence. |
| `-anticheat` | Adds decoys, integrity checks for eligible gameplay state, session latching, and stop paths. It combines with any mode. |
| `-antisave` | Adds Unicode canaries and signed-zero guards that make an editor-resaved copy stop guarded event stacks on its next run. |
| `-extra` | Renames project-visible identities and strips optional metadata under an explicit compatibility waiver. |
| `-allowsize` | Raises finite block/JSON growth caps in stronger modes. Hard safety limits remain; it is inert in lossless mode. |
| `-verbose` | Prints named progress stages and warnings. |
| `-verbose max` | Adds safe pass details and counts, without printing source values or rename maps. |
| `--force` | Replaces existing output through a backup/restore transaction. |

With no verbosity flag, stderr shows a progress bar. Every successful run reports
completion, counts, warnings, caveats, and bundled coverage. Exit codes are `0`
success, `2` usage, `3` invalid input, `4` filesystem, and `5` internal failure.

## What it protects

All modes remap block and symbol IDs, rename safely renamable symbols and custom
procedures, remove comments and inactive reporter fallbacks, obscure layout, and
minify `project.json`. Runtime-required names remain unchanged; ambiguous regions stay native.

Every output has exactly one branded in-project declaration: the inert, readable Stage
variable named `Obfuscated by PrioSDK Gen 4.`. No costume, sound, comment, list,
procedure, or metadata watermark is added.

Lossy and no-preserve can pack eligible scalars, virtualize supported list access,
fold exact constants, encode literals, and add bounded decoys. No-preserve also
virtualizes eligible linear regions. Unsafe or unsupported behavior remains native.

`-anticheat` is tamper resistance, not permanent or cryptographic protection. It
adds seven opaque decoys, integrity guards, and a session latch. A determined
editor can remove checks or restore a clean archive. It adds blocks, state, file
size, and runtime work even when paired with `-lossless`.

`-antisave` is a resave deterrent, not guaranteed save prevention. The official
Scratch editor can save, but normalizes its sentinel from `-0` to `+0`. After
reopening, guarded event stacks stop on their next run. Archive editing can remove
the guards, and the option adds bounded startup work. Canaries avoid unsafe text.

`-extra` can break projects or external tools that rely on display names,
computed name dispatch, monitor presentation, or optional metadata. Costume and
sound asset bytes are not encrypted or transcoded: official Scratch cannot
decode and install replacement assets from project blocks at runtime.

A self-contained executable project contains enough information to run it.
Obfuscation raises analysis cost but cannot make recovery impossible.

## Determinism and verification

Identical payloads, flags, algorithm version, and tool version produce identical
bytes across ZIP metadata/order, paths, locale, timezone, and supported systems.
Assets and all non-`project.json` entries remain byte-for-byte unchanged.

The verifier checks schema, references, graph/scope invariants, procedures,
monitors, extensions, assets, growth, and mode boundaries. Failed candidates roll
back; the finished archive is reopened before atomic publication. Static checks
cannot prove exact state, timing, or pixels for every project, so release QA also
uses pinned runtime traces and browser load/save/reload fixtures.

Coverage describes the source release suite, not the input or a correctness
guarantee. Statement coverage measures executed statements; branch coverage
measures exercised decision outcomes. Function and line coverage are analogous.
Gates are 97% statements, 93% branches, 100% functions, and 99% lines; the CLI
also states whether each category reached 100%.

## Development

```sh
npm run qa
npm pack
```

Hosted checks use Node.js 22 and 24 on Windows, Ubuntu, and macOS, compare hashes,
and run browser smoke tests. See [CHANGELOG.md](CHANGELOG.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
