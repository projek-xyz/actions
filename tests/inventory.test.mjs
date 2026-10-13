import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCallSites,
  mergeManual,
  renderInventoryYaml,
  readPrevEntries,
  searchAndCollect,
} from '../tools/inventory.mjs';

const CONSUMER_CI_YAML = `
name: CI
on: [push]
jobs:
  prepare:
    uses: projek-xyz/actions/.github/workflows/prepare.yml@main
    with:
      php-version: '8.3'
      base-branch: dev
    secrets: inherit
  build:
    needs: prepare
    uses: projek-xyz/actions/.github/workflows/build.yml@main
    with:
      branch: \${{ needs.prepare.outputs.branch-name }}
      build-path: dist
  other-org:
    uses: someone/actions/.github/workflows/prepare.yml@v1
    with:
      foo: bar
  local:
    uses: ./.github/workflows/local.yml
    with:
      nothing: true
`;

const CONSUMER_RELEASE_YAML = `
name: Release
on: workflow_dispatch
jobs:
  upload:
    uses: projek-xyz/actions/.github/workflows/uploads.yml@main
`;

const CONSUMER_OUTPUTS_YAML = `
name: Out
on: push
jobs:
  prep:
    uses: projek-xyz/actions/.github/workflows/prepare.yml@main
  ci:
    runs-on: ubuntu-latest
    needs: [prep]
    env:
      BRANCH: \${{ needs.prep.outputs.branch-name }}
      NOT_MINE: \${{ needs.someone-else.outputs.nope }}
    steps:
      - if: \${{ needs.prep.outputs['should-build'] == '1' }}
        run: echo hi
  other:
    uses: projek-xyz/actions/.github/workflows/report.yml@main
`;

const silentLog = { warn: () => {}, info: () => {} };

function makeFetch({ searches, contents }) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('/search/code')) {
        const token = String(options.headers?.Authorization ?? '').replace('Bearer ', '');
        const name = url.includes('prepare.yml') ? 'prepare' : 'build';
        return { ok: true, status: 200, json: async () => ({ items: searches[`${token}:${name}`] ?? [] }) };
      }
      if (url.includes('/contents/')) {
        const key = Object.keys(contents).find((k) => url.includes(k));
        if (!key) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
        return { ok: true, status: 200, json: async () => ({}), text: async () => contents[key] };
      }
      throw new Error(`unexpected url: ${url}`);
    },
  };
}

test('searchAndCollect paginates code search past the first 100 results', async () => {
  const pageOne = Array.from({ length: 100 }, (_, i) => ({
    repository: { full_name: `org/p${i}` },
    path: '.github/workflows/ci.yml',
  }));
  const pageTwo = Array.from({ length: 30 }, (_, i) => ({
    repository: { full_name: `org/q${i}` },
    path: '.github/workflows/ci.yml',
  }));
  let lastPage = '0';
  const warnings = [];
  const fetchImpl = async (/** @type {string} */ url) => {
    if (url.includes('/search/code')) {
      const page = new URL(url).searchParams.get('page') ?? '1';
      lastPage = page;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 130,
          incomplete_results: false,
          items: page === '1' ? pageOne : pageTwo,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => 'name: x\non: push\njobs: {}\n' };
  };

  const entries = await searchAndCollect({
    tokens: ['tok'],
    workflows: ['prepare'],
    fetchImpl,
    log: { warn: (/** @type {string} */ m) => warnings.push(m) },
  });

  assert.equal(lastPage, '2', 'second page requested');
  assert.equal(entries.length, 130, 'every page of results collected');
  assert.equal(warnings.length, 0);
});

test('incomplete_results marks the search failed so a partial inventory is refused', async () => {
  let failures = 0;
  const warnings = [];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ total_count: 3, incomplete_results: true, items: [] }),
  });

  const entries = await searchAndCollect({
    tokens: ['tok'],
    workflows: ['prepare'],
    fetchImpl,
    log: { warn: (/** @type {string} */ m) => warnings.push(m) },
    onSearchFailure: () => {
      failures += 1;
    },
  });

  assert.equal(failures, 1);
  assert.equal(entries.length, 0);
  assert.ok(warnings.some((w) => w.includes('incomplete')));
});

test('a total_count above the 1000-result cap marks the search failed', async () => {
  let failures = 0;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ total_count: 1200, incomplete_results: false, items: [] }),
  });

  const entries = await searchAndCollect({
    tokens: ['tok'],
    workflows: ['prepare'],
    fetchImpl,
    log: silentLog,
    onSearchFailure: () => {
      failures += 1;
    },
  });

  assert.equal(failures, 1);
  assert.equal(entries.length, 0);
});

test('parseCallSites extracts our call sites with with: input names and ignores others', () => {
  assert.deepEqual(parseCallSites(CONSUMER_CI_YAML, '.github/workflows/ci.yml'), [
    { workflow: 'prepare', inputs: ['php-version', 'base-branch'], outputs: ['branch-name'] },
    { workflow: 'build', inputs: ['branch', 'build-path'], outputs: [] },
  ]);
});

test('parseCallSites attributes needs.<caller>.outputs reads to that caller only', () => {
  assert.deepEqual(parseCallSites(CONSUMER_OUTPUTS_YAML, '.github/workflows/out.yml'), [
    { workflow: 'prepare', inputs: [], outputs: ['branch-name', 'should-build'] },
    { workflow: 'report', inputs: [], outputs: [] },
  ]);
});

test('searchAndCollect unions and dedupes hits across tokens; content fetched once per unique file', async () => {
  const { fetchImpl, calls } = makeFetch({
    searches: {
      'tok1:prepare': [
        { repository: { full_name: 'org-a/repo-one' }, path: '.github/workflows/ci.yml' },
        { repository: { full_name: 'org-a/repo-one' }, path: 'README.md' },
      ],
      'tok2:prepare': [
        { repository: { full_name: 'org-a/repo-one' }, path: '.github/workflows/ci.yml' },
        { repository: { full_name: 'org-b/repo-two' }, path: '.github/workflows/release.yml' },
      ],
      'tok1:build': [{ repository: { full_name: 'org-a/repo-one' }, path: '.github/workflows/ci.yml' }],
      'tok2:build': [],
    },
    contents: {
      'org-a/repo-one/contents/.github/workflows/ci.yml': CONSUMER_CI_YAML,
      'org-b/repo-two/contents/.github/workflows/release.yml': CONSUMER_RELEASE_YAML,
    },
  });

  const entries = await searchAndCollect({
    tokens: ['tok1', 'tok2'],
    workflows: ['prepare', 'build'],
    fetchImpl,
    log: silentLog,
  });

  // README.md hit filtered out; repo-one deduped despite appearing in 3 searches
  assert.equal(entries.length, 2);
  const repoOne = entries.find((e) => e.repo === 'org-a/repo-one');
  assert.ok(repoOne);
  assert.equal(repoOne.path, '.github/workflows/ci.yml');
  assert.equal(repoOne.manual, false);
  assert.deepEqual(repoOne.calls.map((c) => c.workflow), ['prepare', 'build']);

  const repoTwo = entries.find((e) => e.repo === 'org-b/repo-two');
  assert.deepEqual(repoTwo.calls, [{ workflow: 'uploads', inputs: [], outputs: [] }]);

  const contentFetches = calls.filter((c) => c.url.includes('/contents/'));
  assert.equal(contentFetches.length, 2, 'raw content fetched once per unique repo+path');
});

test('searchAndCollect keeps the entry with calls: [] when content fetch fails', async () => {
  const { fetchImpl } = makeFetch({
    searches: { 'tok1:prepare': [{ repository: { full_name: 'org-c/private' }, path: '.github/workflows/ci.yml' }] },
    contents: {},
  });
  const warnings = [];

  const entries = await searchAndCollect({
    tokens: ['tok1'],
    workflows: ['prepare'],
    fetchImpl,
    log: { warn: (msg) => warnings.push(msg) },
  });

  assert.deepEqual(entries, [{ repo: 'org-c/private', path: '.github/workflows/ci.yml', manual: false, calls: [] }]);
  assert.equal(warnings.length, 1);
});

test('searchAndCollect retries content fetch with the next token before giving up', async () => {
  let contentAttempts = 0;
  /** @param {string} url @param {{ headers?: Record<string, string> }} [options] */
  const fetchImpl = async (url, options = {}) => {
    const token = String(options.headers?.Authorization ?? '');
    if (url.includes('/search/code')) {
      const items =
        token.includes('tok1') && url.includes('prepare.yml')
          ? [{ repository: { full_name: 'org-d/two-tokens' }, path: '.github/workflows/ci.yml' }]
          : [];
      return { ok: true, status: 200, json: async () => ({ items }) };
    }
    if (url.includes('/contents/')) {
      contentAttempts += 1;
      if (token.includes('tok1')) return { ok: false, status: 403, json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, json: async () => ({}), text: async () => CONSUMER_RELEASE_YAML };
    }
    throw new Error(`unexpected url: ${url}`);
  };

  const warnings = [];
  const entries = await searchAndCollect({
    tokens: ['tok1', 'tok2'],
    workflows: ['prepare'],
    fetchImpl: /** @type {any} */ (fetchImpl),
    log: { warn: (msg) => warnings.push(msg) },
  });

  assert.equal(contentAttempts, 2, 'first token 403 → second token tried');
  assert.deepEqual(entries, [
    { repo: 'org-d/two-tokens', path: '.github/workflows/ci.yml', manual: false, calls: [{ workflow: 'uploads', inputs: [], outputs: [] }] },
  ]);
  assert.equal(warnings.length, 1, 'one warning for the failed token, none after success');
  assert.ok(warnings[0].includes('trying next token'));
});

test('mergeManual preserves manual entries and drops stale non-manual ones', () => {
  const prev = [
    { repo: 'x/manual', path: '.github/workflows/ci.yml', manual: true, calls: [{ workflow: 'prepare', inputs: [] }] },
    { repo: 'x/stale', path: '.github/workflows/old.yml', manual: false, calls: [] },
    { repo: 'x/found', path: '.github/workflows/ci.yml', manual: false, calls: [] },
  ];
  const next = [
    { repo: 'x/found', path: '.github/workflows/ci.yml', manual: false, calls: [{ workflow: 'build', inputs: ['branch'] }] },
  ];

  const merged = mergeManual(prev, next);

  assert.equal(merged.length, 2);
  const found = merged.find((e) => e.repo === 'x/found');
  assert.deepEqual(found.calls, [{ workflow: 'build', inputs: ['branch'] }], 'found entry updated to fresh data');
  assert.ok(merged.some((e) => e.repo === 'x/manual' && e.manual === true), 'manual entry preserved');
  assert.ok(!merged.some((e) => e.repo === 'x/stale'), 'stale non-manual entry dropped');
});

test('renderInventoryYaml produces the exact spec schema, sorted, with manual always present', () => {
  const entries = [
    { repo: 'org-b/second', path: '.github/workflows/ci.yml', manual: true, calls: [] },
    {
      repo: 'org-a/first',
      path: '.github/workflows/release.yml',
      manual: false,
      calls: [
        { workflow: 'prepare', inputs: ['base-branch', 'php-version'], outputs: ['branch-name', 'should-build'] },
        { workflow: 'uploads', inputs: [], outputs: [] },
      ],
    },
  ];

  assert.equal(
    renderInventoryYaml(entries, '2026-10-13'),
    `# generated by tools/inventory.mjs — untracked scratch state (gitignored);
# hand-maintained entries live in consumers-manual.yml and survive refreshes
updated: '2026-10-13'
consumers:
  - repo: org-a/first
    path: .github/workflows/release.yml
    manual: false
    calls:
      - workflow: prepare
        inputs: [base-branch, php-version]
        outputs: [branch-name, should-build]
      - workflow: uploads
        inputs: []
        outputs: []
  - repo: org-b/second
    path: .github/workflows/ci.yml
    manual: true
    calls: []
`,
  );
});

test('readPrevEntries round-trips rendered inventory including outputs, tolerates missing file', () => {
  const entries = [
    {
      repo: 'org/a',
      path: '.github/workflows/ci.yml',
      manual: false,
      calls: [{ workflow: 'prepare', inputs: ['php-version'], outputs: ['branch-name'] }],
    },
  ];

  const file = join(tmpdir(), `consumers-${process.pid}.yml`);
  writeFileSync(file, renderInventoryYaml(entries, '2026-10-13'));

  assert.deepEqual(readPrevEntries(file), entries);
  assert.deepEqual(readPrevEntries(join(tmpdir(), 'definitely-not-here.yml')), []);
  rmSync(file, { force: true });
});
