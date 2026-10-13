// @ts-check

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

/**
 * @typedef {object} ContractInput
 * @property {string} name
 * @property {string} type
 * @property {boolean} required
 * @property {string|boolean|number|null} default
 */

/**
 * @typedef {object} ContractOutput
 * @property {string} name
 * @property {string} description
 */

/**
 * @typedef {object} ContractSecret
 * @property {string} name
 * @property {boolean} required
 */

/**
 * @typedef {object} Contract
 * @property {string} workflow
 * @property {ContractInput[]} inputs
 * @property {ContractOutput[]} outputs
 * @property {ContractSecret[]} secrets
 */

/**
 * Extract the `workflow_call` contract from workflow YAML text.
 *
 * @param {string} yamlText
 * @param {string} [workflow] filename without extension; defaults to ''
 * @returns {Contract|null} null when the workflow has no `workflow_call` trigger
 */
export function extractCallContract(yamlText, workflow = '') {
  /** @type {Record<string, any>} */
  const doc = /** @type {any} */ (load(yamlText)) ?? {};
  // `on` is a string key under YAML 1.2 (js-yaml default schema), but be
  // defensive about boolean-key parsing quirks.
  const raw = doc.on ?? doc[true];
  // Normalize the scalar (`on: workflow_call`) and sequence
  // (`on: [push, workflow_call]`) forms to the mapping form. Without this,
  // `'workflow_call' in <string>` throws an opaque TypeError.
  const on =
    raw === 'workflow_call'
      ? { workflow_call: {} }
      : Array.isArray(raw)
        ? Object.fromEntries(raw.map((k) => [String(k), {}]))
        : raw;

  if (!on || typeof on !== 'object' || !('workflow_call' in on)) {
    return null;
  }

  const spec = on.workflow_call ?? {};

  /** @type {ContractInput[]} */
  const inputs = Object.entries(spec.inputs ?? {}).map(([name, raw]) => {
    const s = /** @type {Record<string, any>} */ (raw ?? {});
    return {
      name,
      type: String(s.type ?? 'string'),
      required: s.required === true,
      default: 'default' in s ? (s.default ?? null) : null,
    };
  });

  /** @type {ContractOutput[]} */
  const outputs = Object.entries(spec.outputs ?? {}).map(([name, raw]) => {
    const s = /** @type {Record<string, any>} */ (raw ?? {});
    return { name, description: String(s.description ?? '') };
  });

  /** @type {ContractSecret[]} */
  const secrets = Object.entries(spec.secrets ?? {}).map(([name, raw]) => {
    const s = /** @type {Record<string, any>} */ (raw ?? {});
    return { name, required: s.required === true };
  });

  const byName = (/** @type {{name: string}} */ a, /** @type {{name: string}} */ b) =>
    a.name.localeCompare(b.name);

  return { workflow, inputs: inputs.sort(byName), outputs: outputs.sort(byName), secrets: secrets.sort(byName) };
}

/**
 * List workflow files in a directory that declare a `workflow_call` trigger.
 *
 * @param {string} dir
 * @returns {string[]} sorted filenames
 */
export function listWorkflowFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes('workflow_call'))
    .sort();
}
