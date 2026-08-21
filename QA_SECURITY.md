# QA dependency boundary

The production CLI ships only `ajv`, `fflate`, and `yauzl`. The release gate
`npm run audit:runtime` audits that production dependency set.

The exact upstream compatibility harness also installs
`@scratch/scratch-vm@15.1.0` and `scratch-parser@6.0.1` as development-only
dependencies. The separate `qa/gui` lockfile pins `@scratch/scratch-gui@15.1.0`
and `puppeteer-core@25.8.0` for browser roundtrips. These pinned upstream trees
currently contain known transitive security advisories, including high and
critical findings in packages that are not part of the production dependency
graph.

The compatibility dependencies are not included in the packed CLI. They run
only against generated or reviewed local fixtures, receive no credentials, and
are not used to process untrusted network input. A full dependency audit is
still reviewed before releases, and these scoped exceptions must be
reconsidered whenever a pinned compatibility version changes.
