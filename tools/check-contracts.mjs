// @ts-check

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractCallContract, listWorkflowFiles } from './extract-contracts.mjs';

/**
 * @typedef {import('./extract-contracts.mjs').Contract} Contract
 */

/**
 * @typedef {object} ContractDiff
 * @property {string[]} breaking entries that would break consumers
 * @property {string[]} additions entries requiring a baseline regeneration
 */

/**
 * Diff two contracts. Rules:
 * - removed entry → breaking; new entry → addition
 * - input type/default change or required false→true → breaking
 * - input required true→false → addition ("relaxed"); same for secrets
 * - output descriptions are cosmetic and ignored
 *
 * @param {Contract} baseline
 * @param {Contract} current
 * @returns {ContractDiff}
 */
export function diffContracts(baseline, current) {
  /** @type {string[]} */
  const breaking = [];
  /** @type {string[]} */
  const additions = [];

  /**
   * @param {string} kind
   * @param {{name: string}[]} baseList
   * @param {{name: string}[]} currList
   * @param {(b: any, c: any) => void} [check]
   */
  const compare = (kind, baseList, currList, check) => {
    const base = new Map(baseList.map((e) => [e.name, e]));
    const curr = new Map(currList.map((e) => [e.name, e]));

    for (const [name, entry] of base) {
      const other = curr.get(name);
      if (!other) {
        breaking.push(`${kind} removed: ${name}`);
        continue;
      }
      check?.(entry, other);
    }

    for (const name of curr.keys()) {
      if (!base.has(name)) additions.push(`${kind} added: ${name}`);
    }
  };

  compare('input', baseline.inputs, current.inputs, (b, c) => {
    if (b.type !== c.type || JSON.stringify(b.default) !== JSON.stringify(c.default) || (b.required === false && c.required === true)) {
      breaking.push(`input changed: ${b.name}`);
    } else if (b.required === true && c.required === false) {
      additions.push(`input relaxed: ${b.name}`);
    }
  });

  compare('output', baseline.outputs, current.outputs);

  compare('secret', baseline.secrets, current.secrets, (b, c) => {
    if (b.required === false && c.required === true) {
      breaking.push(`secret changed: ${b.name}`);
    } else if (b.required === true && c.required === false) {
      additions.push(`secret relaxed: ${b.name}`);
    }
  });

  return { breaking, additions };
}

/**
 * Extract current contracts for every workflow_call workflow in a directory.
 *
 * @param {string} workflowsDir
 * @returns {Map<string, Contract>}
 */
export function extractCurrentContracts(workflowsDir) {
  /** @type {Map<string, Contract>} */
  const current = new Map();

  for (const file of listWorkflowFiles(workflowsDir)) {
    const name = basename(file, '.yml').replace(/\.ya?ml$/, '');
    const contract = extractCallContract(readFileSync(join(workflowsDir, file), 'utf8'), name);
    if (contract) current.set(name, contract);
  }

  return current;
}

function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const workflowsDir = '.github/workflows';
  const contractsDir = 'contracts';

  /** @type {Map<string, Contract>} */
  const baseline = new Map();
  if (existsSync(contractsDir)) {
    for (const file of readdirSync(contractsDir).filter((f) => f.endsWith('.json'))) {
      const contract = /** @type {Contract} */ (JSON.parse(readFileSync(join(contractsDir, file), 'utf8')));
      baseline.set(contract.workflow, contract);
    }
  }

  const current = extractCurrentContracts(workflowsDir);

  /** @type {string[]} */
  const breaking = [];
  /** @type {string[]} */
  const additions = [];

  for (const name of baseline.keys()) {
    if (!current.has(name)) breaking.push(`[${name}] workflow removed`);
  }

  for (const [name, contract] of current) {
    const base = baseline.get(name);
    if (!base) {
      additions.push(`[${name}] workflow added`);
      continue;
    }
    const diff = diffContracts(base, contract);
    breaking.push(...diff.breaking.map((m) => `[${name}] ${m}`));
    additions.push(...diff.additions.map((m) => `[${name}] ${m}`));
  }

  for (const message of breaking) console.error(`breaking: ${message}`);
  for (const message of additions) console.error(`stale baseline: ${message}`);

  if (breaking.length > 0) {
    console.error('Contract breaking changes detected — refusing to continue.');
    process.exit(1);
  }

  if (update) {
    mkdirSync(contractsDir, { recursive: true });
    for (const [name, contract] of current) {
      writeFileSync(join(contractsDir, `${name}.json`), `${JSON.stringify(contract, null, 2)}\n`);
      console.log(`wrote contracts/${name}.json`);
    }
    process.exit(0);
  }

  if (additions.length > 0) {
    console.error('Run `npm run contracts -- --update` to regenerate the baseline.');
    process.exit(1);
  }

  console.log('contracts OK');
}

// Only run the CLI when invoked directly, so tests can import diffContracts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
