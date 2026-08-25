### v0.7.0

#### Added

- Added `-antisave` Unicode canaries, signed-zero resave detection, and guarded event entry.
- Added compact growth caps and opt-in `-allowsize` expanded caps.
- Added progress bars, `-verbose`, `-verbose max`, and packaged coverage reporting.
- Added pass-attributed verification with transactional rollback.
- Added `-extra` name and metadata privacy with compatibility caveats.
- Added chained two-word instruction records, rolling state, cross-return transitions, and shuffled handlers.
- Added broader eligible scalar/list packing, exact constant folding, and inactive fallback removal.
- Added anti-cheat gameplay tags, decoys, session latching, and guarded event entry.
- Added path-sensitive recovery tests and packed/browser QA on Windows, Ubuntu, and macOS.
- Added dependency advisory, signature, and exact-policy gates.
- Added behavior-driven coverage for hardening, verifier, schema, and archive fault paths.

#### Fixed

- Fixed excessive default no-preserve growth; expanded finite growth now requires `-allowsize`.
- Fixed repeated sprite-local IDs being rejected as project-wide collisions.
- Fixed unsafe namespace freezes, stale hidden values, and active null-shadow handling.
- Fixed selector coercion, monitor binding, and `-extra` verifier scope.
- Fixed fractional dispatcher-state aliases and incomplete table validation.
- Fixed non-atomic publication and macOS/POSIX force-replacement recovery.
- Fixed packed-install selection, fuzz timeouts, and obsolete release artifacts.
- Fixed official-VM QA cross-talk by serializing test files.
- Fixed anti-save growth rejection on valid multi-target and many-hat projects.
- Fixed anti-save verification accepting unrelated or detached stop paths.
- Fixed repeated in-project branding references; the watermark variable is now inert.
- Fixed safe bounded dispatcher tails being discarded by larger non-private runs.
- Fixed expanded `-allowsize` dispatch suppressing eligible scalar packing.
- Fixed release assertions dropping the `-allowsize` context on privacy combinations.
- Fixed the watchdog QA oracle to exclude the inert watermark and cover all eight live sentinels.
- Fixed coverage instrumentation affecting VM scheduler-step assertions by freezing only its frame-budget clock.
- Fixed the all-seed attacker coverage timeout by bounding each exact digest case independently.
- Updated the exact release coverage snapshot after hardening tests.
- Fixed hosted runtime deprecations with immutable Node 24 pins and CLI artifact retrieval.
- Removed unreachable legacy dispatcher and camouflage branches.
- Updated ESLint to 10.9.1 and typescript-eslint to 8.68.0; retained compatible `@types/yauzl` 2.10.3.
- Fixed deprecated dependency edges with reviewed local shims and maintained overrides.

#### Vulnerabilities

##### Glass Maze - 10/10

- How: shared suffix identities and affine continuation exposed complete dispatcher chains.
- Fixed: predecessor-keyed records now authenticate each transition under rolling state.

##### Railway Map - 10/10

- How: handler-major lookup coordinates revealed every logical transition.
- Fixed: serialized selectors were removed and shuffled records decode only under the current key.

##### Rosetta Stone - 10/10

- How: packed producer words exposed polynomial coefficients, orientation, and seals.
- Fixed: coefficient packets were replaced by encrypted next-key and tag pairs.

##### Open Vault - 9/10

- How: a bounded coordinate domain made the central transition polynomial enumerable.
- Fixed: the coordinate polynomial was removed in favor of chained authenticated records.

##### Master Key - 9/10

- How: polynomial record relations exposed complete dispatcher transitions.
- Fixed: polynomial record authority was replaced by chained, predecessor-keyed authenticated records.

##### Pigeonhole - 9/10

- How: dividing two packet banks canceled their mask and recovered route values.
- Fixed: quotient-paired banks were removed and packet decoding was bound to rolling state.

##### Achilles' Heel - 9/10

- How: split affine producer and completion shares recombined into each successor.
- Fixed: recombinable shares were removed; result-bound transition material crosses procedure returns.

##### House of Cards - 9/10

- How: reduced finite-field packets remained enumerable despite nonlinear masking.
- Fixed: expanded runtime tables, larger state domains, and exact canonical checks replaced that packet.

##### Open Book - 9/10

- How: normalized affine permutations canceled and revealed every tested transition.
- Fixed: independently shuffled runtime tables and authenticated result transitions replaced affine routing.

##### Skeleton Key - 9/10

- How: aliases with equal successor sets grouped into the original logical command chain.
- Fixed: physical handlers admit all logical commands through independently permuted authenticated slots.

##### Counterweight - 8/10

- How: balanced packet edits canceled additive checksum kernels.
- Fixed: per-cell authentication and linked integrity state reject offsetting edits.

##### Marked Deck - 8/10

- How: repeated table values passed aggregate seen-value checks.
- Fixed: an exact seen bitmap rejects duplicate, missing, and noncanonical permutation cells.

##### False Start - 8/10

- How: an antisave watchdog could run after original event stacks had already changed state.
- Fixed: every supported native event hat enters its guard before the original continuation.

##### False Witness - 8/10

- How: presence-only checks could accept a detached or unrelated anti-save stop path.
- Fixed: trusted manifests now prove every exact signed-zero guard and native-hat binding.

##### Blank Cheque - 8/10

- How: a broad `-extra` waiver could conceal unrelated executable or monitor changes.
- Fixed: narrow selector waivers and independent runtime, binding, and monitor snapshots replaced it.

##### False Floor - 8/10

- How: fractional dispatcher state could round to a valid Scratch list index.
- Fixed: integer, parity, capability, and state-relation gates reject fractional aliases.

##### Bottomless Bag - 7/10

- How: negative instrumentation growth could pass the `-allowsize` upper-cap waiver.
- Fixed: signed accounting rejects negative growth before applying any upper-cap waiver.

##### Crowded Room - 6/10

- How: expanded dispatch consumed staged quota and left eligible scalar state native.
- Fixed: total and staged growth accounting were separated within the same hard cap.

##### Paper Shield - 6/10

- How: structural anti-cheat counts missed disconnected refresh, latch, trip, or watchdog paths.
- Fixed: path-aware metrics require each writer refresh and reachable response channel.

##### Blind Guard - 5/10

- How: temporary fake monitors distorted eligibility and monitor preservation.
- Fixed: internal reservation keys replaced monitor-based reservations; real monitors remain authoritative.

##### Cherryblood - 3/10

- How: legacy QA dependency edges installed deprecated registry packages.
- Fixed: reviewed local compatibility shims and maintained exact overrides replaced those edges.
