import test from 'node:test';
import assert from 'node:assert/strict';
import { changedWorkflowFiles, analyzeChanges, renderImpactReport } from '../tools/impact-report.mjs';

const DIFF = `diff --git a/.github/workflows/prepare.yml b/.github/workflows/prepare.yml
index 1111111..2222222 100644
--- a/.github/workflows/prepare.yml
+++ b/.github/workflows/prepare.yml
@@ -1 +1 @@
-old
+new
diff --git a/tools/x.mjs b/tools/x.mjs
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/tools/x.mjs
@@ -0,0 +1 @@
+export const x = 1;
`;

test('changedWorkflowFiles lists only .github/workflows files from the diff, sorted', () => {
  assert.deepEqual(changedWorkflowFiles(DIFF), ['.github/workflows/prepare.yml']);
});

test('changedWorkflowFiles ignores contract files and non-workflow paths', () => {
  const diff = `diff --git a/contracts/prepare.json b/contracts/prepare.json
diff --git a/README.md b/README.md
diff --git a/.github/workflows/_ci.yml b/.github/workflows/_ci.yml
`;
  assert.deepEqual(changedWorkflowFiles(diff), ['.github/workflows/_ci.yml']);
});

const contract = (inputs, outputs) => ({
  workflow: 'x',
  inputs: inputs.map((name) => ({ name, type: 'string', required: false, default: null })),
  outputs: outputs.map((name) => ({ name, description: '' })),
  secrets: [],
});

// _ci.yml is internal (no contract in either side) → dropped entirely.
const MIXED_CHANGES = [
  '.github/workflows/_ci.yml',
  '.github/workflows/build.yml',
  '.github/workflows/docker.yml',
  '.github/workflows/new-flow.yml',
  '.github/workflows/prepare.yml',
];

const MIXED_BASE = new Map([
  ['build', contract(['php-version', 'uploads-path'], ['image-url'])],
  ['docker', contract([], ['image-url'])],
  ['prepare', contract(['php-version'], [])],
]);

const MIXED_CURRENT = new Map([
  // php-version input and image-url output removed
  ['build', contract(['uploads-path'], [])],
  ['docker', contract([], ['image-url'])],
  // type change only — non-removal breaking, deferred to phase 2
  ['prepare', { workflow: 'x', inputs: [{ name: 'php-version', type: 'number', required: false, default: null }], outputs: [], secrets: [] }],
  // new reusable workflow — no baseline to compare
  ['new-flow', contract([], [])],
]);

const MIXED_INVENTORY = [
  {
    repo: 'creasico/laravel-nusa',
    path: '.github/workflows/deploy.yml',
    manual: false,
    calls: [
      { workflow: 'build', inputs: ['php-version', 'uploads-path'], outputs: [] },
      { workflow: 'prepare', inputs: ['php-version'], outputs: [] },
    ],
  },
  {
    repo: 'projek-xyz/laravel-starter',
    path: '.github/workflows/main.yml',
    manual: false,
    calls: [{ workflow: 'build', inputs: ['uploads-path'], outputs: ['image-url'] }],
  },
  {
    // uses build.yml but not the removed items → not impacted
    repo: 'projek-xyz/other',
    path: '.github/workflows/ci.yml',
    manual: false,
    calls: [{ workflow: 'build', inputs: ['uploads-path'], outputs: [] }],
  },
];

test('analyzeChanges buckets workflows by removals and filters consumers by overlap', () => {
  const model = analyzeChanges({
    changedFiles: MIXED_CHANGES,
    baseContracts: MIXED_BASE,
    currentContracts: MIXED_CURRENT,
    inventory: MIXED_INVENTORY,
  });

  assert.equal(model.inventoryEmpty, false);
  assert.equal(model.noChanges, false);
  assert.deepEqual(model.noImpact, ['docker.yml']);
  assert.deepEqual(model.nonRemovalBreaking, ['prepare.yml']);
  assert.deepEqual(model.introduced, ['new-flow.yml']);

  assert.equal(model.sections.length, 1);
  const [section] = model.sections;
  assert.equal(section.file, 'build.yml');
  assert.equal(section.status, 'impacted');
  assert.equal(section.consumerCount, 3);
  assert.deepEqual(section.impacted, [
    {
      repo: 'creasico/laravel-nusa',
      files: [{ path: '.github/workflows/deploy.yml', passes: ['php-version', 'uploads-path'], reads: [] }],
    },
    {
      repo: 'projek-xyz/laravel-starter',
      files: [{ path: '.github/workflows/main.yml', passes: ['uploads-path'], reads: ['image-url'] }],
    },
  ]);
});

test('renderImpactReport formats CAUTION sections, grouping and trailing lines', () => {
  const model = analyzeChanges({
    changedFiles: MIXED_CHANGES,
    baseContracts: MIXED_BASE,
    currentContracts: MIXED_CURRENT,
    inventory: MIXED_INVENTORY,
  });

  assert.equal(
    renderImpactReport(model),
    `### \`build.yml\`

> [!CAUTION]
> This PR changes the \`workflow_call\` interface of \`build.yml\`; the contract baseline and diff show what changed. The consumers below still use the old interface.

Impacted consumers (2 of 3):
- \`creasico/laravel-nusa\`:
  - \`deploy.yml\` — passes: \`php-version\`, \`uploads-path\`
- \`projek-xyz/laravel-starter\`:
  - \`main.yml\` — passes: \`uploads-path\`; reads: \`image-url\`

Changed with non-removal interface changes (see the Contracts job): \`prepare.yml\`
Changed with no interface impact: \`docker.yml\`
Baseline introduced in this PR (nothing to compare): \`new-flow.yml\`
`,
  );
});

test('removals with no consumer overlap render as a NOTE section', () => {
  const model = analyzeChanges({
    changedFiles: ['.github/workflows/build.yml'],
    baseContracts: new Map([['build', contract(['gone-input'], [])]]),
    currentContracts: new Map([['build', contract([], [])]]),
    inventory: [
      {
        repo: 'org/r',
        path: '.github/workflows/ci.yml',
        manual: false,
        calls: [{ workflow: 'build', inputs: ['other'], outputs: [] }],
      },
    ],
  });

  assert.equal(model.sections[0].status, 'clean');
  assert.deepEqual(model.sections[0].impacted, []);
  assert.match(renderImpactReport(model), /> \[!NOTE\]/);
});

test('a deleted reusable workflow impacts every recorded consumer', () => {
  const model = analyzeChanges({
    changedFiles: ['.github/workflows/build.yml'],
    baseContracts: new Map([['build', contract(['a', 'b'], ['o'])]]),
    currentContracts: new Map(),
    inventory: [
      {
        repo: 'org/r',
        path: '.github/workflows/ci.yml',
        manual: false,
        calls: [{ workflow: 'build', inputs: ['b'], outputs: ['o'] }],
      },
    ],
  });

  const [section] = model.sections;
  assert.equal(section.status, 'impacted');
  assert.deepEqual(section.impacted, [
    { repo: 'org/r', files: [{ path: '.github/workflows/ci.yml', passes: ['b'], reads: ['o'] }] },
  ]);
});

test('empty inventory flags the report and renders clean sections', () => {
  const model = analyzeChanges({
    changedFiles: ['.github/workflows/build.yml'],
    baseContracts: new Map([['build', contract(['gone'], [])]]),
    currentContracts: new Map([['build', contract([], [])]]),
    inventory: [],
  });

  assert.equal(model.inventoryEmpty, true);
  assert.equal(
    renderImpactReport(model),
    `> [!WARNING]
> Inventory unavailable (refresh failed or no token) — consumer lists below may be incomplete.

### \`build.yml\`

> [!NOTE]
> Interface changed, but no recorded consumer uses the removed items.
`,
  );
});

test('no reusable workflow changes yields the no-changes line', () => {
  const empty = analyzeChanges({
    changedFiles: [],
    baseContracts: new Map(),
    currentContracts: new Map(),
    inventory: MIXED_INVENTORY,
  });
  assert.equal(empty.noChanges, true);
  assert.equal(
    renderImpactReport(empty),
    'No reusable workflow changes in this PR — no consumer impact to report.\n',
  );

  // internal-only changes (no contract on either side) are also no-changes
  const internalOnly = analyzeChanges({
    changedFiles: ['.github/workflows/_ci.yml'],
    baseContracts: new Map(),
    currentContracts: new Map(),
    inventory: MIXED_INVENTORY,
  });
  assert.equal(internalOnly.noChanges, true);
});
