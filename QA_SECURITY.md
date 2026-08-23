# QA dependency boundary

The production CLI ships only `ajv`, `fflate`, and `yauzl`. The release gate
`npm run audit:runtime` audits that production dependency set.

For the 0.6 release review on 2026-08-23, the production tree, complete root
development tree, and isolated browser-QA tree each report zero npm advisories.
All 330 exact resolved versions across the reviewed lockfiles were also checked
against live registry deprecation metadata and the OSV advisory database: no
installed package is deprecated, vulnerable, or withdrawn. Registry signatures,
provenance where published, and locked SHA-512 integrity values validate. The
previously reported `inflight`, `read-package-json`, `glob@7`, registry
`text-encoding`, `audio-context`, `hull.js`, and `uuid@8` installations are not
present in either resolved package tree.

The pinned compatibility harness installs the official
`@scratch/scratch-vm@15.1.0` package and `scratch-parser@6.0.1` as
development-only dependencies. The VM package still declares legacy renderer,
audio, encoding, `immutable`, and `uuid` versions that are unnecessary or
unsafe in this headless harness. The root lockfile replaces the unused browser
edges with private, local compatibility boundaries: renderer and audio imports
fail closed, while the encoding bridge delegates to Node.js 22's standards-based
implementation. `immutable@4.3.9` and `uuid@11.1.1` supply the exercised runtime
APIs. The VM load, serialize, reload, and differential suites verify that these
substitutions preserve the QA behavior relied on by this project.

The separate `qa/gui` lockfile uses the maintained,
Scratch-compatible `@turbowarp/scaffolding@0.4.0` browser runtime and
`puppeteer-core@25.8.0` for load/save/reload roundtrips. Its type-only Git
dependency is replaced by the exact registry release `@turbowarp/types@0.0.15`
so every installed artifact is covered by the npm lockfile and registry
integrity metadata. A clean install contains 27 packages: `npm audit` reports
zero vulnerabilities, no lockfile package is marked deprecated, and all 27
packages pass npm registry-signature verification.

Scaffolding is distributed as a prebuilt browser bundle. Its published source
map identifies bundled `uuid@8.3.2` code even though that package is not an
installed dependency. The applicable advisory concerns the optional output
buffer accepted by UUID v3/v5; the Scratch runtime does not expose that API to
the tested project. This is a materially smaller attack surface than the old
GUI tree, but removing the dormant bundled implementation would require a
separately maintained, patched runtime build rather than a dependency override.

This browser runner replaces the former full editor-workspace smoke test; it is
not represented as the official Scratch editor. It independently exercises
archive loading, stage creation, VM serialization, and reload in Chromium. The
official VM package remains the separate loader, serializer, and semantic
compatibility oracle described above.

The compatibility dependencies are not included in the packed CLI. They run
only against generated or reviewed local fixtures, receive no credentials, and
are not used to process untrusted network input. A full dependency and bundle
review is still required before releases, and these boundaries must be
reconsidered whenever a pinned compatibility version changes.

Registry signatures, provenance attestations, locked SHA-512 integrity values,
deprecation metadata, and advisory scans provide independently checkable
supply-chain evidence. They cannot prove that a legitimately published package
contains no hostile or compromised source, so release review must still inspect
dependency changes and the browser bundle boundary.
