// @ts-check

/**
 * @typedef {object} PreviousRun
 * @property {null|string} sha
 * @property {null|string} branch
 * @property {null|string} message
 * @property {{id: number, name: string}[]} artifacts
 */

/** @param {import('@actions/github-script').AsyncFunctionArguments} _ */
export function previousRun({ context, core, exec, github }) {
  const { owner, repo } = context.repo;

  /** @type {PreviousRun} */
  const previous = {
    sha: null,
    branch: null,
    message: null,
    artifacts: [],
  }

  /**
   * @param {string[]} branches
   */
  return async function main (branches) {
    try {
      const { data: { workflows } } = await github.rest.actions.listRepoWorkflows({ owner, repo });
      const workflow = workflows.find(w => w.name === context.workflow);

      if (!workflow) {
        core.setOutput('available', 0);

        return previous;
      }

      found:

      for (const branch of branches) {
        const { data: { workflow_runs } } = await github.rest.actions.listWorkflowRuns({
          workflow_id: workflow.id,
          status: 'completed',
          conclusion: 'success',
          branch,
          owner,
          repo,
        });

        if (workflow_runs.length === 0) {
          core.info(`No previously successful run found from '${branch}' branch`);

          continue;
        }

        for (const run of workflow_runs) {
          if (!run.head_commit) {
            continue
          }

          const exitCode = await exec.exec(
            'git',
            ['cat-file', '-e', run.head_commit.id],
            { ignoreReturnCode: true, silent: true }
          );

          if (exitCode > 0) {
            console.log(`invalid: ${run.head_commit.id}`)
            continue;
          }

          previous.branch = branch;
          previous.sha = run.head_commit.id;
          previous.message = run.head_commit.message;

          core.info(`Found ${workflow_runs.length} previously successful run from '${branch}' branch`);
          core.debug(`Previous success run on '${branch}' branch commit sha: ${previous.sha}`);

          const { data: { artifacts } } = await github.rest.actions.listWorkflowRunArtifacts({
            run_id: run.id,
            owner,
            repo,
          });

          for (const artifact of artifacts) {
            previous.artifacts.push({
              id: artifact.id,
              name: artifact.name,
            })
          }

          break found;
        }

        if (previous.sha) {
          break;
        }
      }

      core.setOutput('available', !!previous.sha ? 1 : 0);

      return previous
    } catch (error) {
      if (error instanceof Error) {
        core.notice(`Failed to get previous run: ${error.message}`);
        core.setOutput('available', 0);
      }

      return previous;
    }
  }
}
