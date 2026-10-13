# AGENTS.md

Reusable GitHub Actions workflows (`projek-xyz/actions`) consumed via
`uses: projek-xyz/actions/.github/workflows/<name>.yml@<ref>` by repos in three scopes:
the owner's personal GitHub account, the `projek-xyz` org, and the `creasico` org —
a contract change ripples across all three. This is not an app: there is no build of
its own. Verification is the four-tier CI in `_ci.yml` (lint, contracts, smoke,
inventory/impact), mirrored by `npm run verify` locally.

## Repository shape

- `.github/workflows/*.yml` — the product. Everything else is support.
- `.github/workflows/_ci.yml` — internal CI only; the leading `_` marks it
  non-reusable (consumers must never `uses:` it). Jobs: `lint`, `contracts`, `test`,
  `smoke-node`/`smoke-php`/`smoke-bun` + `smoke-assert`, `impact` (PR only,
  advisory; refreshes the consumer inventory in-job before generating).
- `.github/scripts/*.js` — ESM helper modules loaded at runtime by `actions/github-script`.
- `tools/` — CI tooling (Node ESM; `js-yaml` is the only dependency): contract
  extraction/checking, action pin check, consumer inventory, impact report.
  Deliberately NOT under `.github/` — that tree is sparse-checked-out into consumers
  (see Gotchas).
- `contracts/*.json` — committed call-contract baselines for every `workflow_call`
  workflow. `npm run contracts` fails on breaking diffs or stale baselines;
  regenerate additive changes with `npm run contracts -- --update`.
- `tests/` — `node:test` unit tests; the pre-merge guarantee for script logic
  (scripts only run from `main` in consumers).
- `consumers.yml` — generated inventory of consumer repos and their call sites;
  **untracked scratch state** (gitignored), rebuilt inside the impact job per PR
  run with step-scoped `DEFAULT_PAT` (refresh failure → report renders with an
  inventory-unavailable warning instead of failing). `consumers-manual.yml` is
  the tracked home for entries code search cannot see (private/hidden repos);
  the refresh merges it in.
- Fixture branches (consumed by the smoke jobs through `prepare.yml`'s
  `project-ref` input): `fixtures/prepare-php-laravel` (composer.json, executable
  artisan, wp-cli.yml, deliberately no package.json) and
  `fixtures/prepare-node-bun` (package.json + bun.lock).
- `package.json` — npm scripts (`verify`, `lint`, `contracts`, `test`, `consumers`,
  `impact`) plus `@actions/github-script` types for `// @ts-check` JSDoc.

Workflow roles (all are `workflow_call` unless noted):

- `prepare.yml` — the hub most callers start with. Detects PHP/Node/package manager,
  computes version/branch/PR info, and emits `should-build` / `should-deploy` /
  `should-tests` change-detection outputs.
- `configure.yml` — legacy counterpart of `prepare.yml`; also has its own
  `pull_request: [main]` trigger. Emits composer cache keys, deploy target, image tag.
- `build.yml` — despite its top-level `name: Release` (historical quirk, not a bug to
  "fix" silently), it runs composer + frontend build and uploads a `build-<env>` artifact.
- `docker.yml` — multi-arch build/push to `ghcr.io` with attestations; emits `image-url`.
- `uploads.yml` — uploads files or workflow artifacts to a GitHub release.
- `release.yml` — `npx changelogithub`.
- `report.yml` — finishes Coveralls reporting.

## Gotchas

- **Script loading is a three-part contract.** `prepare.yml` sparse-checks-out this
  repo into `.github/xyz-actions` (`repository: projek-xyz/actions`, no `ref` → its
  default branch), then `cp -r` the scripts to `.github/scripts/`, and `github-script`
  steps do `await import('${{github.workspace}}/.github/scripts/<name>.js')`.
  Renaming/moving a script requires updating the sparse-checkout, the copy step, and
  the import path together. Script changes only reach consumers after merging to
  `main`; workflow changes reach consumers only at the ref callers pin.
- **Scripts are factories**, not scripts: `export function changedFiles({ context, core, exec, github, glob })`
  returns the async main. Callers pass the `github-script` context object as a single argument.
- **Outputs are strings `'0'`/`'1'`**, written to `$GITHUB_OUTPUT` by shell steps, then
  wired through three layers: step → `jobs.<id>.outputs` → workflow-level `outputs`.
  Deprecated outputs (`project-branch-name`, `has-codeclimate`, …) are kept for caller
  compatibility — don't remove them as cleanup.
- **Release parsing depends on the exact commit subject** `chore(release): vX.Y.Z`:
  `prepare.yml` matches it with `[[ $COMMIT_TITLE =~ chore\(release\) ]]` (unquoted
  escaped regex — equivalent to the old quoted literal, shellcheck-clean) and
  `uploads.yml` derives the tag via `sed 's/chore(release): /v/'`. Preserve that prefix.
- **Known latent bug (unfixed, owner decision pending)**: in `prepare.yml`'s Project
  step, `APP_VERSION=${COMMIT#chore\(release\): }` reads an undefined `$COMMIT`
  (only `COMMIT_MESSAGE` is in env), so release-tagged commits get an empty `version`
  output. The sibling `${PKG_VERSION}` abort for php-only projects was fixed; this one
  changes release behavior, so it is deliberately untouched.
- **Smoke assertions read workflow-level outputs only** (`needs.*.outputs` of the
  called reusable workflow); job-level outputs are invisible to callers, and
  `previous-run`/`changed-files` values vary per event — never assert on those.
- **Pin format matters**: every third-party action is pinned to a full commit SHA with
  a trailing `# vX.Y.Z` comment. Dependabot (`.github/dependabot.yml`, weekly,
  grouped) maintains both — match the format when adding actions.
- Input naming is inconsistent by file: `uploads.yml` uses `snake_case`, the rest
  `kebab-case`. Mirror each file's local style rather than normalizing.

## Verification

Four tiers, enforced by `_ci.yml` on every PR and mirrored locally:

```sh
npm install          # js-yaml; lockfiles stay gitignored
npm run verify       # actionlint (on PATH, e.g. `brew install actionlint`) + pin check + contracts + tests
```

1. **Lint** — `actionlint` (CI pins v1.7.7; zero findings required) plus
   `tools/check-pins.sh`: every `uses:` needs a full 40-hex SHA with a version
   comment (`# vX.Y.Z` or the no-`v` form used by `setup-php`); `uses: ./…` is
   exempt. The CI runner's shellcheck (0.9.0) reports style findings newer local
   versions dropped — CI is the authoritative gate.
2. **Contracts** — `contracts/*.json` is the committed contract of every
   reusable workflow. Removing/renaming an input/output/secret, changing a type or
   default, or tightening `required` fails `npm run contracts` outright; purely
   additive changes fail until regenerated with `npm run contracts -- --update`.
   Wire-level changes (run blocks) don't touch the contract.
3. **Smoke** — `prepare.yml` is called three times per PR: against the PR itself and
   against both fixture branches via `project-ref`; `smoke-assert` checks the
   detection outputs (`needs-*`, `node-pm-name`, `is-laravel`, …) using
   workflow-level outputs only.
4. **Consumers + impact** — the `impact` job refreshes `consumers.yml` per run
   (code search + call-site parsing with the `DEFAULT_PAT` org secret, classic
   PAT, `repo`+`workflow` scopes, granted to all public repos of the `projek-xyz`
   org; step-scoped, `continue-on-error` so a refresh failure only adds an
   inventory-unavailable warning). Repos code search cannot see are listed in
   `consumers-manual.yml` and merged in on every refresh. Every PR gets an
   advisory sticky impact comment (upserted, marker `<!-- xyz-impact-report -->`)
   keyed off interface **removals** vs the `contracts/*.json` baseline at the
   merge base: `[!CAUTION]` per changed workflow whose removed inputs/outputs are
   still passed/read by recorded consumers (grouped repo → file → passes/reads),
   `[!NOTE]` when nothing recorded uses the removed items; non-removal breaking
   rows stay with the Contracts job. The job is `continue-on-error`, so fork PRs
   without a write token never fail the build.

Limits: `.github/scripts` load from this repo's default branch, so script changes
only run in consumers after merge to `main` — the unit tests in `tests/` are the
pre-merge guarantee. Keep `prepare.yml` output contracts backward-compatible regardless.

## Style

- The conventions here (SHA-pinned actions, kebab-case inputs, `'0'`/`'1'` outputs)
  are the owner's house style across their PHP/JS/TS repos — follow them, don't normalize.
- Indent: 2 spaces for `*.yml`/`*.yaml`/`*.js`/`*.css`/`*.xml`/`*.svg`, 4 elsewhere;
  LF everywhere (`.editorconfig`, `.gitattributes`).
- All lockfiles are intentionally gitignored (`.gitignore` bans `package-lock.json`,
  `pnpm-lock.yaml`, `yarn.lock`, `bun.lock*`) — do not commit one.
- `README.md` is empty; this file and the workflow sources are the documentation.
