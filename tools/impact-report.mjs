// @ts-check
//
// PR impact report: maps the workflow files changed in a PR to the consumers
// recorded in `consumers.yml`, so reviewers see at a glance which repos a
// contract change can break. Purely advisory — always exits 0; the guaranteed
// channels are the job summary and the sticky PR comment (via github-script).

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readPrevEntries } from './inventory.mjs';

/**
 * @typedef {import('./inventory.mjs').Entry} Entry
 * @typedef {import('./extract-contracts.mjs').Contract} Contract
 */

const WORKFLOW_PATH_RE = /^\.github\/workflows\/[\w.-]+\.ya?ml$/;
const CONTRACT_PATH_RE = /^contracts\/([\w-]+)\.json$/;

/**
 * B-side paths from a unified-diff text (`diff --git a/<p> b/<p>` headers).
 *
 * @param {string} diffText
 * @returns {string[]}
 */
function changedPaths(diffText) {
  /** @type {string[]} */
  const paths = [];
  for (const line of diffText.split('\n')) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (match) paths.push(match[1]);
  }
  return paths;
}

/**
 * Workflow basenames touched by the diff, sorted and deduped.
 *
 * @param {string} diffText
 * @returns {string[]}
 */
export function changedWorkflowFiles(diffText) {
  return [...new Set(changedPaths(diffText).filter((p) => WORKFLOW_PATH_RE.test(p)).map((p) => basename(p)))].sort();
}

/**
 * Workflow names whose contract baseline (`contracts/<name>.json`) changed.
 *
 * @param {string} diffText
 * @returns {string[]}
 */
export function changedContractWorkflows(diffText) {
  return [
    ...new Set(
      changedPaths(diffText)
        .map((p) => p.match(CONTRACT_PATH_RE)?.[1])
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Render the markdown impact report.
 *
 * @param {string[]} changed workflow basenames (e.g. ['prepare.yml'])
 * @param {Entry[]} inventoryEntries
 * @param {Record<string, Contract>} contracts keyed by workflow name
 * @param {string[]} [contractChanged] workflow names with a changed contract file
 * @returns {string}
 */
export function renderImpactReport(changed, inventoryEntries, contracts, contractChanged = []) {
  const lines = ['## Impact report', ''];

  if (changed.length === 0) {
    lines.push('No workflow file changes in this PR — no consumer impact to report.');
    return `${lines.join('\n')}\n`;
  }

  for (const file of changed) {
    const name = basename(file).replace(/\.ya?ml$/, '');
    lines.push(`### ${file}`);
    lines.push('');

    const consumers = inventoryEntries.filter((e) => e.calls.some((c) => c.workflow === name));
    if (consumers.length === 0) {
      lines.push('No known consumers (private repos may need a `manual: true` entry in consumers.yml).');
    } else {
      const contractInputs = new Set((contracts[name]?.inputs ?? []).map((i) => i.name));
      for (const entry of consumers) {
        /** @type {Set<string>} */
        const used = new Set();
        for (const call of entry.calls) {
          if (call.workflow !== name) continue;
          for (const input of call.inputs) {
            if (contractInputs.has(input)) used.add(input);
          }
        }
        const suffix =
          used.size > 0
            ? ` (inputs used: ${[...used].sort().map((i) => `\`${i}\``).join(', ')})`
            : '';
        lines.push(`- \`${entry.repo}\` — \`${entry.path}\`${suffix}`);
      }
    }

    if (contractChanged.includes(name)) {
      lines.push('');
      lines.push('> [!WARNING]');
      lines.push(
        `> contract changed — this PR modifies \`contracts/${name}.json\`; verify compatibility for the consumers above.`,
      );
    }

    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf('--base');
  // The CLI builds `origin/<base>...HEAD`, so tolerate a passed-in `origin/` prefix.
  const base = (baseIdx !== -1 && args[baseIdx + 1] ? args[baseIdx + 1] : 'main').replace(/^origin\//, '');

  let diffText = '';
  try {
    // --no-ext-diff/--no-textconv keep the output parseable even when a
    // developer has diff.external (e.g. difftastic) configured locally.
    diffText = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', `origin/${base}...HEAD`], {
      encoding: 'utf8',
    });
  } catch (err) {
    console.warn(`could not diff against origin/${base}: ${String(err)} — reporting no changes`);
  }

  /** @type {Record<string, Contract>} */
  const contracts = {};
  if (existsSync('contracts')) {
    for (const file of readdirSync('contracts').filter((f) => f.endsWith('.json'))) {
      const contract = /** @type {Contract} */ (JSON.parse(readFileSync(join('contracts', file), 'utf8')));
      contracts[contract.workflow] = contract;
    }
  }

  const inventory = readPrevEntries('consumers.yml');
  const report = renderImpactReport(changedWorkflowFiles(diffText), inventory, contracts, changedContractWorkflows(diffText));

  writeFileSync('impact.md', report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  console.log(report);
}

// Only run the CLI when invoked directly, so tests can import the pure functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
