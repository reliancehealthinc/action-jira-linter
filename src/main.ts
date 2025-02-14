import * as core from '@actions/core';
import * as github from '@actions/github';
import { AxiosError } from 'axios';

import {
  CreateIssueCommentParams,
  JIRADetails,
  JIRALintActionInputs,
  PullRequestParams,
  PullRequestUpdateParams,
  UpdateIssueParams,
} from './types';
import { DEFAULT_PR_ADDITIONS_THRESHOLD } from './constants';
import { GitHub } from './github';
import { Jira } from './jira';

const getInputs = (): JIRALintActionInputs => {
  const jiraUser: string = core.getInput('jira-user', { required: true });
  const jiraToken: string = core.getInput('jira-token', { required: true });
  const jiraBaseURL: string = core.getInput('jira-base-url', {
    required: true,
  });
  const githubToken: string = core.getInput('github-token', {
    required: true,
  });
  const branchIgnorePattern: string = core.getInput('skip-branches', { required: false }) || '';
  const skipComments: boolean = core.getInput('skip-comments', { required: false }) === 'true';
  const prThreshold = parseInt(core.getInput('pr-threshold', { required: false }), 10);
  const validateIssueStatus: boolean = core.getInput('validate-issue-status', { required: false }) === 'true';
  const allowedIssueStatuses: string[] = core.getMultilineInput('allowed-issue-statuses');
  const validateProject: boolean = core.getInput('validate-project', { required: false }) === 'true';
  const allowedProjects: string[] = core.getMultilineInput('allowed-projects');
  const validateType: boolean = core.getInput('validate-type', { required: false }) === 'true';
  const allowedTypes: string[] = core.getMultilineInput('allowed-types');
  const failOnError: boolean = core.getInput('fail-on-error', { required: false }) !== 'false';
  const ignoredLabelTypes: string[] = core.getMultilineInput('ignored-label-types', { required: false });
  const detailsOpen: boolean = core.getInput('details-open', { required: false }) !== 'false';

  return {
    jiraUser,
    jiraToken,
    githubToken,
    branchIgnorePattern,
    skipComments,
    prThreshold: isNaN(prThreshold) ? DEFAULT_PR_ADDITIONS_THRESHOLD : prThreshold,
    jiraBaseURL: jiraBaseURL.endsWith('/') ? jiraBaseURL.replace(/\/$/, '') : jiraBaseURL,
    validateIssueStatus,
    allowedIssueStatuses,
    validateProject,
    allowedProjects,
    validateType,
    allowedTypes,
    failOnError,
    ignoredLabelTypes,
    detailsOpen,
  };
};

async function run(): Promise<void> {
  try {
    const {
      jiraUser,
      jiraToken,
      jiraBaseURL,
      githubToken,
      branchIgnorePattern,
      skipComments,
      prThreshold,
      validateIssueStatus,
      allowedIssueStatuses,
      validateProject,
      allowedProjects,
      validateType,
      allowedTypes,
      failOnError,
      ignoredLabelTypes,
      detailsOpen,
    } = getInputs();

    const exit = (message: string): void => {
      let exitCode = 0;

      if (failOnError) {
        core.setFailed(message);
        exitCode = 1;
      } else {
        console.log(message);
      }

      process.exit(exitCode);
    };

    const defaultAdditionsCount = 800;
    const threshold: number = prThreshold ? Number(prThreshold) : defaultAdditionsCount;

    const {
      payload: { repository, pull_request: pullRequest },
    } = github.context;

    if (typeof repository === 'undefined') {
      // eslint-disable-next-line i18n-text/no-en
      return exit(`Missing 'repository' from github action context.`);
    }

    if (typeof pullRequest === 'undefined') {
      console.log(`Missing 'pull_request' from github action context. Skipping.`);
      return;
    }

    const {
      name: repo,
      owner: { login: owner },
    } = repository;

    const {
      base: { ref: baseBranch },
      head: { ref: headBranch },
      number: prNumber = 0,
      body: prBody = '',
      additions = 0,
      title = '',
    } = pullRequest as PullRequestParams;

    // common fields for both issue and comment
    const commonPayload: UpdateIssueParams = { owner, repo, issue: prNumber };
    const gh = new GitHub(githubToken);
    const jira = new Jira(jiraBaseURL, jiraUser, jiraToken);

    if (!headBranch && !baseBranch) {
      const commentBody = 'action-jira-linter is unable to determine the head and base branch.';
      const comment: CreateIssueCommentParams = {
        ...commonPayload,
        body: commentBody,
      };
      await gh.upsertComment('unable-to-determine-base-branch', comment);

      // eslint-disable-next-line i18n-text/no-en
      return exit('Unable to get the head and base branch.');
    }

    console.log('Base branch -> ', baseBranch);
    console.log('Head branch -> ', headBranch);

    if (GitHub.shouldSkipBranchLint(headBranch, branchIgnorePattern)) {
      process.exit(0);
    }

    const issueKeys = Jira.getJIRAIssueKeys(headBranch).concat(Jira.getJIRAIssueKeys(title));
    if (!issueKeys.length) {
      const body = Jira.getNoIdComment();
      const comment = { ...commonPayload, body };
      await gh.upsertComment('no-id', comment);

      return exit('JIRA issue id is missing in your branch or PR title.');
    }

    // use the last match (end of the branch name)
    const issueKey = issueKeys[issueKeys.length - 1];
    console.log(`JIRA key -> ${issueKey}`);

    try {
      const details: JIRADetails = await jira.getTicketDetails(issueKey);

      const podLabel: string = details?.project?.name || '';
      const hotfixLabel: string = GitHub.getHotfixLabel(baseBranch);
      const typeLabel: string = details?.type?.name || '';
      const labels: string[] = [
        ignoredLabelTypes.includes('project') ? null : podLabel,
        ignoredLabelTypes.includes('hotfix') ? null : hotfixLabel,
        ignoredLabelTypes.includes('type') ? null : typeLabel,
      ].filter(Boolean as unknown as (x: string | null) => x is string);
      console.log('Adding lables -> ', labels);

      await gh.addLabels({ ...commonPayload, labels });

      if (GitHub.shouldUpdatePRDescription(prBody)) {
        console.log('Updating PR description…', prBody);

        const description: string = Jira.getPRDescription(prBody, details, detailsOpen);

        const prData: PullRequestUpdateParams = {
          owner,
          repo,
          pullRequestNumber: prNumber,
          body: description,
        };
        await gh.updatePrDetails(prData);

        // add comment for PR title
        if (!skipComments) {
          const prTitleCommentBody = gh.getPRTitleComment(details.summary, title);
          const prTitleComment = { ...commonPayload, body: prTitleCommentBody };
          console.log('Adding comment for the PR title');
          gh.upsertComment('pr-title', prTitleComment);

          // add a comment if the PR is huge
          if (GitHub.isHumongousPR(additions, threshold)) {
            const hugePrCommentBody = GitHub.getHugePrComment(additions, threshold);
            const hugePrComment = { ...commonPayload, body: hugePrCommentBody };
            console.log('Adding comment for huge PR');
            gh.upsertComment('huge-pr', hugePrComment);
          }
        }
      } else {
        console.log('PR description will not be updated.');
      }

      if (!Jira.isIssueTypeValid(validateType, allowedTypes, details)) {
        const body = Jira.getInvalidIssueTypeComment(details.type.name, allowedTypes);
        const invalidIssueTypeComment = { ...commonPayload, body };
        console.log('Adding comment for invalid jira issue type');
        await gh.upsertComment('invalid-issuetype', invalidIssueTypeComment);

        // eslint-disable-next-line i18n-text/no-en
        return exit('The found jira issue is not an acceptable type');
      } else if (!Jira.isProjectValid(validateProject, allowedProjects, details)) {
        const body = Jira.getInvalidProjectComment(details.project.key, allowedProjects);
        const invalidProjectComment = { ...commonPayload, body };
        console.log('Adding comment for invalid jira project');
        await gh.upsertComment('invalid-project', invalidProjectComment);

        // eslint-disable-next-line i18n-text/no-en
        return exit('The found jira issue is not in an acceptable project');
      } else if (!Jira.isIssueStatusValid(validateIssueStatus, allowedIssueStatuses, details)) {
        const body = Jira.getInvalidIssueStatusComment(details.status, allowedIssueStatuses);
        const invalidIssueStatusComment = { ...commonPayload, body };
        console.log('Adding comment for invalid issue status');
        await gh.upsertComment('invalid-issue-status', invalidIssueStatusComment);

        // eslint-disable-next-line i18n-text/no-en
        return exit('The found jira issue does is not in acceptable statuses');
      } else {
        console.log('The issue status is valid.');
      }
    } catch (e) {
      // 404 is a valid way to say "Jira Ticket Not Found"
      if (e instanceof AxiosError) {
        const err = e as AxiosError;
        if (err.response && err.response.status && err.response.status === 404) {
          const body = Jira.getNoIdComment();
          const comment = { ...commonPayload, body };
          await gh.upsertComment('no-id', comment);

          return exit(
            // eslint-disable-next-line i18n-text/no-en
            'Invalid JIRA key. Please create a branch with a valid JIRA issue key in the name, or put a valid JIRA issue in the PR title.'
          );
        } else {
          throw e;
        }
      }
    }
  } catch (error) {
    console.log({ error });

    core.setFailed((error as Error)?.message ?? 'FATAL: An unknown error occurred');
    process.exit(1);
  }
}

run();
