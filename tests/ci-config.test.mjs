import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

// Structural guarantees for _ci.yml that actionlint cannot express: GitHub
// reports SKIPPED jobs as 'Success', so the smoke tier's required check must
// never inherit the implicit success() condition.

/** @type {any} */
const ci = load(readFileSync('.github/workflows/_ci.yml', 'utf8'));

test('smoke-assert runs when a smoke leg fails and gates on leg results first', () => {
  const job = ci.jobs['smoke-assert'];

  assert.deepEqual(job.needs, ['smoke-node', 'smoke-php', 'smoke-bun']);
  assert.ok(
    typeof job.if === 'string' && job.if.includes('!cancelled'),
    `smoke-assert must run on failure (got if: ${JSON.stringify(job.if)})`,
  );

  const run = job.steps[0].run;
  const legIdx = run.indexOf('SELF_NODE_RESULT');
  const outputIdx = run.indexOf('check "self.needs-node"');
  assert.ok(legIdx !== -1, 'leg results must be asserted');
  assert.ok(outputIdx !== -1, 'output assertions present');
  assert.ok(legIdx < outputIdx, 'leg results gate the output assertions');
});

test('smoke call jobs declare permissions instead of inheriting repo defaults', () => {
  for (const name of ['smoke-node', 'smoke-php', 'smoke-bun']) {
    assert.deepEqual(
      ci.jobs[name].permissions,
      { contents: 'read', 'pull-requests': 'write' },
      `${name} permissions`,
    );
  }
});

test('impact job refreshes the inventory per run with step-scoped, failure-tolerant auth', () => {
  const refresh = ci.jobs.impact.steps.find((/** @type {any} */ s) => s.name === 'Refresh consumer inventory');
  assert.ok(refresh, 'impact job refreshes the inventory before generating the report');
  assert.equal(refresh['continue-on-error'], true, 'a refresh failure must not skip comment posting');
  assert.equal(refresh.env?.DEFAULT_PAT, '${{ secrets.DEFAULT_PAT }}');
  assert.equal(refresh.run, 'node tools/inventory.mjs');

  const refreshIdx = ci.jobs.impact.steps.indexOf(refresh);
  const generateIdx = ci.jobs.impact.steps.findIndex((/** @type {any} */ s) => s.name === 'Generate impact report');
  assert.ok(refreshIdx < generateIdx, 'refresh runs before the report is generated');
});

test('no scheduled refresh and no standalone inventory job — refresh is per impact run', () => {
  assert.equal(ci.jobs['inventory-refresh'], undefined);
  assert.equal(ci.on.schedule, undefined);
});
