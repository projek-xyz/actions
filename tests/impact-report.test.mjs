import test from 'node:test';
import assert from 'node:assert/strict';
import { changedWorkflowFiles, changedContractWorkflows, renderImpactReport } from '../tools/impact-report.mjs';

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

const DIFF_WITH_CONTRACT = `${DIFF}diff --git a/contracts/prepare.json b/contracts/prepare.json
index 4444444..5555555 100644
--- a/contracts/prepare.json
+++ b/contracts/prepare.json
@@ -1 +1 @@
-{ }
+{  }
`;

const CONTRACTS = {
  prepare: {
    workflow: 'prepare',
    inputs: [
      { name: 'php-version', type: 'string', required: false, default: null },
      { name: 'base-branch', type: 'string', required: false, default: null },
    ],
    outputs: [],
    secrets: [],
  },
};

const INVENTORY = [
  {
    repo: 'org-a/one',
    path: '.github/workflows/ci.yml',
    manual: false,
    calls: [{ workflow: 'prepare', inputs: ['php-version'] }],
  },
  {
    repo: 'org-b/two',
    path: '.github/workflows/build.yml',
    manual: false,
    calls: [{ workflow: 'prepare', inputs: ['gone-input'] }],
  },
];

test('changedWorkflowFiles extracts workflow basenames and ignores other paths', () => {
  assert.deepEqual(changedWorkflowFiles(DIFF), ['prepare.yml']);
  assert.deepEqual(changedWorkflowFiles('no diffs here\n'), []);
});

test('changedContractWorkflows extracts contract workflow names', () => {
  assert.deepEqual(changedContractWorkflows(DIFF_WITH_CONTRACT), ['prepare']);
  assert.deepEqual(changedContractWorkflows(DIFF), []);
});

test('renderImpactReport lists consumers with contract-intersected inputs used', () => {
  const report = renderImpactReport(['prepare.yml'], INVENTORY, CONTRACTS);

  assert.ok(report.includes('### prepare.yml'));
  assert.ok(report.includes('`org-a/one`'), 'first consumer listed');
  assert.ok(report.includes('`org-b/two`'), 'second consumer listed');
  assert.ok(report.includes('php-version'), 'recorded input in contract shown as used');
  assert.ok(!report.includes('gone-input'), 'recorded input missing from contract excluded');
  assert.ok(!report.includes('⚠ contract changed'), 'no contract marker without contract diff');
});

test('renderImpactReport says so when a changed workflow has no known consumers', () => {
  const report = renderImpactReport(['docker.yml'], INVENTORY, CONTRACTS);

  assert.ok(report.includes('No known consumers'));
});

test('renderImpactReport marks workflows whose contract file changed in the PR', () => {
  const report = renderImpactReport(['prepare.yml'], INVENTORY, CONTRACTS, ['prepare']);

  assert.ok(report.includes('⚠ contract changed'));
});

test('renderImpactReport with no workflow changes says nothing to report', () => {
  const report = renderImpactReport([], INVENTORY, CONTRACTS);

  assert.ok(report.includes('No workflow file changes'));
});
