// src/tools/promotion.tool.ts
// Feature 5: Environment Promotion Workflows

import { z } from 'zod';
import { devtronService } from '../services/devtron.service.js';
import { logger } from '../utils/logger.js';
import { McpToolError } from '../utils/errors.js';

export const promoteToEnvironmentSchema = z.object({
  appName: z.string().describe('The Devtron application name to promote.'),
  sourceEnvironment: z.string().describe(
    'The environment to promote FROM (e.g. "devtron-demo"). ' +
    'The image currently running here will be deployed to the target.'
  ),
  targetEnvironment: z.string().describe(
    'The environment to promote TO (e.g. "production"). ' +
    'Must differ from sourceEnvironment.'
  ),
  force: z.boolean().default(false).describe(
    'Set true to promote even when the source is not Healthy (not recommended for production).'
  ),
});

export type PromoteToEnvironmentInput = z.infer<typeof promoteToEnvironmentSchema>;

const PROMOTABLE_STATUSES = new Set(['Healthy', 'Progressing']);

export async function handlePromoteToEnvironment(
  input: PromoteToEnvironmentInput
): Promise<string> {
  logger.info('Tool: promote_to_environment called', {
    appName: input.appName,
    source: input.sourceEnvironment,
    target: input.targetEnvironment,
    force: input.force,
  });

  if (input.sourceEnvironment.toLowerCase() === input.targetEnvironment.toLowerCase()) {
    return '❌ sourceEnvironment and targetEnvironment must be different.';
  }

  try {
    // Resolve both environments in parallel
    const [sourceCtx, targetCtx] = await Promise.all([
      devtronService.resolveAppEnv(input.appName, input.sourceEnvironment),
      devtronService.resolveAppEnv(input.appName, input.targetEnvironment),
    ]);

    // Step 1: Check source health
    const sourceStatus = await devtronService.getDeploymentStatus(
      sourceCtx.appId,
      sourceCtx.envId
    );

    if (!input.force && !PROMOTABLE_STATUSES.has(sourceStatus.status)) {
      return [
        `🚫 **Promotion blocked** — source environment is not healthy.`,
        '',
        `• App: ${input.appName}`,
        `• Source: **${input.sourceEnvironment}** → Status: **${sourceStatus.status}**`,
        `• Target: **${input.targetEnvironment}**`,
        '',
        `Promoting a ${sourceStatus.status} deployment would propagate the failure.`,
        '',
        '**Options:**',
        `1. Fix ${input.sourceEnvironment} first, then promote.`,
        `2. Set \`force: true\` to override (not recommended for production).`,
        `3. Use \`troubleshoot_deployment\` to diagnose the issue.`,
      ].join('\n');
    }

    // Step 2: Get the image from latest source history
    const history = await devtronService.getDeploymentHistory(
      sourceCtx.appId,
      sourceCtx.envId,
      1
    );

    if (history.length === 0) {
      return `❌ No deployment history found for **${input.appName}** in **${input.sourceEnvironment}**. Deploy there first.`;
    }

    const image = history[0]!.dockerImage;
    if (!image) {
      return `❌ Could not determine the Docker image for the latest deployment in ${input.sourceEnvironment}.`;
    }

    // Step 3: Trigger in target
    const result = await devtronService.triggerDeployment({
      appId: targetCtx.appId,
      pipelineId: targetCtx.pipelineId,
      dockerImage: image,
      cdWorkflowType: 'CD',
    });

    if (result.status !== 'Triggered') {
      return [
        `⚠️ Promotion to **${input.targetEnvironment}** may have failed.`,
        `• Devtron response: ${result.status} — ${result.message}`,
      ].join('\n');
    }

    const forcedNote = input.force && !PROMOTABLE_STATUSES.has(sourceStatus.status)
      ? `\n⚠️ Promoted from a **${sourceStatus.status}** source (force=true).`
      : '';

    return [
      `✅ **Promotion triggered successfully!**`,
      '',
      `• App: ${input.appName}`,
      `• From: **${input.sourceEnvironment}** (${sourceStatus.status})`,
      `• To: **${input.targetEnvironment}**`,
      `• Image: \`${image}\``,
      `• Workflow ID: ${result.workflowId}`,
      forcedNote,
      '',
      `Monitor: "What is the status of ${input.appName} in ${input.targetEnvironment}?"`,
    ].filter((l) => l !== '').join('\n');
  } catch (error) {
    if (error instanceof McpToolError) return `❌ Promotion failed: ${error.message}`;
    throw error;
  }
}
