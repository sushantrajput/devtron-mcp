// src/tools/rollback.tool.ts
// Feature 2: AI-Assisted Rollbacks

import { z } from 'zod';
import { devtronService } from '../services/devtron.service.js';
import { logger } from '../utils/logger.js';
import { McpToolError } from '../utils/errors.js';

// ── get_deployment_history ────────────────────────────────────────────────────

export const getDeploymentHistorySchema = z.object({
  appName: z.string().describe('Application name in Devtron'),
  environment: z.string().describe('Environment name (e.g. devtron-demo, staging, production)'),
  limit: z.number().min(1).max(20).default(5).describe(
    'Number of recent deployments to return (default: 5, max: 20)'
  ),
});

export type GetDeploymentHistoryInput = z.infer<typeof getDeploymentHistorySchema>;

export async function handleGetDeploymentHistory(
  input: GetDeploymentHistoryInput
): Promise<string> {
  logger.info('Tool: get_deployment_history called', input);

  try {
    const ctx = await devtronService.resolveAppEnv(input.appName, input.environment);
    const history = await devtronService.getDeploymentHistory(ctx.appId, ctx.envId, input.limit);

    if (history.length === 0) {
      return `No deployment history found for ${input.appName} in ${input.environment}.`;
    }

    const lines = history.map((item, idx) => {
      const date = new Date(item.deployedAt).toLocaleString();
      const icon = item.status === 'Succeeded' ? '✅' : item.status === 'Failed' ? '❌' : '⏳';
      return `${idx + 1}. ${icon} ID: ${item.id} | ${date} | ${item.dockerImage} | by ${item.deployedBy}`;
    });

    return [
      `📜 **Deployment History — ${input.appName} / ${input.environment}**`,
      '',
      ...lines,
      '',
      '**Next steps:**',
      `• Config diff: "Show config diff for ${input.appName} in ${input.environment} between ID <old> and <new>"`,
      `• Rollback: "Roll back ${input.appName} in ${input.environment} to deployment ID <id>"`,
    ].join('\n');
  } catch (error) {
    if (error instanceof McpToolError) return `❌ ${error.message}`;
    throw error;
  }
}

// ── get_deployment_config_diff ────────────────────────────────────────────────

export const getDeploymentConfigDiffSchema = z.object({
  appName: z.string().describe('Application name in Devtron'),
  environment: z.string().describe('Environment name'),
  baseDeploymentId: z.number().describe(
    'The "before" deployment ID (current/broken). Get from get_deployment_history.'
  ),
  targetDeploymentId: z.number().describe(
    'The "after" deployment ID (rollback target / known-good). Get from get_deployment_history.'
  ),
});

export type GetDeploymentConfigDiffInput = z.infer<typeof getDeploymentConfigDiffSchema>;

export async function handleGetDeploymentConfigDiff(
  input: GetDeploymentConfigDiffInput
): Promise<string> {
  logger.info('Tool: get_deployment_config_diff called', input);

  if (input.baseDeploymentId === input.targetDeploymentId) {
    return '❌ baseDeploymentId and targetDeploymentId must be different.';
  }

  try {
    const ctx = await devtronService.resolveAppEnv(input.appName, input.environment);

    const [baseConfig, targetConfig] = await Promise.all([
      devtronService.getDeploymentTemplateConfig(
        ctx.pipelineId, input.baseDeploymentId, ctx.appId, ctx.envId
      ),
      devtronService.getDeploymentTemplateConfig(
        ctx.pipelineId, input.targetDeploymentId, ctx.appId, ctx.envId
      ),
    ]);

    if (!baseConfig.deploymentTemplate && !targetConfig.deploymentTemplate) {
      return [
        `⚠️ Deployment template configs are empty for both deployments.`,
        'This app may not use Devtron-managed deployment templates.',
      ].join('\n');
    }

    const diff = computeLineDiff(baseConfig.deploymentTemplate, targetConfig.deploymentTemplate);

    return [
      `📋 **Config Diff — ${input.appName} / ${input.environment}**`,
      '',
      `• **Base (current):** Deployment ID ${input.baseDeploymentId}`,
      `• **Target (rollback to):** Deployment ID ${input.targetDeploymentId}`,
      '',
      '```diff',
      diff,
      '```',
      '',
      '`-` lines exist in base but not target (will be removed). `+` lines will be added.',
      '',
      `To apply: "Roll back ${input.appName} in ${input.environment} to deployment ID ${input.targetDeploymentId}"`,
    ].join('\n');
  } catch (error) {
    if (error instanceof McpToolError) return `❌ Config diff failed: ${error.message}`;
    throw error;
  }
}

// ── trigger_rollback ──────────────────────────────────────────────────────────

export const triggerRollbackSchema = z.object({
  appName: z.string().describe('Application name'),
  environment: z.string().describe('Environment to roll back'),
  deploymentId: z.number().describe(
    'The deployment history ID to roll back to. Obtain from get_deployment_history.'
  ),
});

export type TriggerRollbackInput = z.infer<typeof triggerRollbackSchema>;

export async function handleTriggerRollback(
  input: TriggerRollbackInput
): Promise<string> {
  logger.info('Tool: trigger_rollback called', input);

  try {
    const ctx = await devtronService.resolveAppEnv(input.appName, input.environment);

    const result = await devtronService.rollbackDeployment({
      appId: ctx.appId,
      envId: ctx.envId,
      pipelineId: ctx.pipelineId,
      deploymentId: input.deploymentId,
    });

    return [
      `✅ **Rollback triggered successfully!**`,
      '',
      `• App: ${input.appName}`,
      `• Environment: ${input.environment}`,
      `• Rolling back to: \`${result.dockerImage}\` (deployment ID ${input.deploymentId})`,
      `• ${result.message}`,
      '',
      `Monitor: "What is the status of ${input.appName} in ${input.environment}?"`,
    ].join('\n');
  } catch (error) {
    if (error instanceof McpToolError) return `❌ Rollback failed: ${error.message}`;
    throw error;
  }
}

// ── LCS diff algorithm ────────────────────────────────────────────────────────

function computeLineDiff(oldText: string, newText: string): string {
  if (oldText === newText) return '(no changes between these two deployments)';
  if (!oldText.trim()) return newText.split('\n').map((l) => `+ ${l}`).join('\n');
  if (!newText.trim()) return oldText.split('\n').map((l) => `- ${l}`).join('\n');

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const lcs = longestCommonSubsequence(oldLines, newLines);
  const result: string[] = [];
  const changeRanges: Array<[number, number]> = [];

  let oi = 0, ni = 0, li = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (
      li < lcs.length &&
      oi < oldLines.length &&
      ni < newLines.length &&
      oldLines[oi] === lcs[li] &&
      newLines[ni] === lcs[li]
    ) {
      result.push(` ${oldLines[oi]}`);
      oi++; ni++; li++;
    } else {
      const start = result.length;
      while (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
        result.push(`- ${oldLines[oi]}`); oi++;
      }
      while (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
        result.push(`+ ${newLines[ni]}`); ni++;
      }
      changeRanges.push([start, result.length - 1]);
    }
  }

  if (changeRanges.length === 0) return '(no differences detected)';

  const CONTEXT = 3;
  const keep = new Set<number>();
  for (const [s, e] of changeRanges) {
    for (let i = Math.max(0, s - CONTEXT); i <= Math.min(result.length - 1, e + CONTEXT); i++) {
      keep.add(i);
    }
  }

  const output: string[] = [];
  let lastKept = -1;
  for (let i = 0; i < result.length; i++) {
    if (keep.has(i)) {
      if (lastKept !== -1 && i > lastKept + 1) {
        output.push(`@@ ... ${i - lastKept - 1} unchanged line(s) ... @@`);
      }
      output.push(result[i]!);
      lastKept = i;
    }
  }

  const MAX_LINES = 200;
  if (output.length > MAX_LINES) {
    return [
      ...output.slice(0, MAX_LINES),
      `@@ ... diff truncated (${output.length - MAX_LINES} more lines) ... @@`,
    ].join('\n');
  }

  return output.join('\n');
}

function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  const lcs: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { lcs.unshift(a[i - 1]!); i--; j--; }
    else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) { i--; }
    else { j--; }
  }
  return lcs;
}
