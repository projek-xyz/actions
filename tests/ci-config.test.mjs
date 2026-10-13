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

test('DEFAULT_PAT is scoped to the inventory step, not the job', () => {
  const job = ci.jobs['inventory-refresh'];

  assert.equal(job.env?.DEFAULT_PAT, undefined, 'job-level env must not hold the PAT');
  const step = job.steps.find((/** @type {any} */ s) => s.name === 'Rebuild consumer inventory');
  assert.ok(step);
  assert.equal(step.env.DEFAULT_PAT, '${{ secrets.DEFAULT_PAT }}');
});
