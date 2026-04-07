// src/tools/troubleshoot.tool.ts
// Feature 6: Deployment Troubleshooting
//
// NOTE: Devtron does not expose pod logs or K8s events via REST API in this version.
// Pod logs are streamed via WebSocket from the Devtron UI.
// This tool provides the next best thing: deployment history with status/messages,
// current deployment status, and the applied deployment template config — which
// is sufficient for Claude to diagnose most deployment failures.

import { z } from 'zod';
import { devtronService } from '../services/devtron.service.js';
import { logger } from '../utils/logger.js';
import { McpToolError } from '../utils/errors.js';

export const troubleshootDeploymentSchema = z.object({
  appName: z.string().describe('Name of the application to troubleshoot'),
  environment: z.string().describe('Environment where the issue is occurring'),
  includeTemplate: z.boolean().default(true).describe(
    'Include the current deployment template config (default: true). ' +
    'Helps diagnose misconfigured resource limits, env vars, or probes.'
  ),
});

export type TroubleshootDeploymentInput = z.infer<typeof troubleshootDeploymentSchema>;

export async function handleTroubleshootDeployment(
  input: TroubleshootDeploymentInput
): Promise<string> {
  logger.info('Tool: troubleshoot_deployment called', {
    appName: input.appName,
    environment: input.environment,
  });

  try {
    const ctx = await devtronService.resolveAppEnv(input.appName, input.environment);

    // Fetch status, recent history, and template in parallel
    const [status, history, template] = await Promise.all([
      devtronService.getDeploymentStatus(ctx.appId, ctx.envId),

      devtronService.getDeploymentHistory(ctx.appId, ctx.envId, 5),

      input.includeTemplate
        ? devtronService.getDeploymentTemplate(ctx.appId, ctx.envId, ctx.pipelineId)
            .catch((err) => {
              logger.warn('Could not fetch deployment template', { error: err });
              return null;
            })
        : Promise.resolve(null),
    ]);

    const sections: string[] = [
      `🔍 **Troubleshooting Report: ${input.appName} / ${input.environment}**`,
      '',
    ];

    // 1. Current status
    sections.push('## Current Status');
    sections.push(`• **Status:** ${status.status}`);
    sections.push(`• **Image:** ${status.releaseVersion || 'unknown'}`);
    sections.push(`• **Deployment type:** ${status.deploymentAppType || 'unknown'}`);
    sections.push(`• **Pipeline triggered:** ${status.isPipelineTriggered ? 'Yes' : 'No'}`);
    if (status.lastDeployedAt) {
      sections.push(`• **Last deployed:** ${new Date(status.lastDeployedAt).toLocaleString()} by ${status.deployedBy}`);
    }
    sections.push('');

    // 2. Recent deployment history with messages
    sections.push('## Recent Deployment History');
    if (history.length === 0) {
      sections.push('_No deployment history found._');
    } else {
      for (const item of history) {
        const icon = item.status === 'Succeeded' ? '✅' : item.status === 'Failed' ? '❌' : '⏳';
        const date = new Date(item.deployedAt).toLocaleString();
        sections.push(`${icon} **ID ${item.id}** | ${date} | \`${item.dockerImage}\` | by ${item.deployedBy}`);
        if (item.message) {
          sections.push(`   ↳ _${item.message}_`);
        }
      }
    }
    sections.push('');

    // 3. Deployment template config
    if (input.includeTemplate) {
      sections.push('## Applied Deployment Template');
      if (!template || !template.deploymentTemplate.trim()) {
        sections.push('_Could not fetch deployment template._');
      } else {
        if (template.strategy) sections.push(`_Strategy: ${template.strategy}_`);
        sections.push('```yaml');
        const lines = template.deploymentTemplate.split('\n');
        const MAX = 150;
        if (lines.length > MAX) {
          sections.push(...lines.slice(0, MAX));
          sections.push(`... (${lines.length - MAX} more lines — view full template in Devtron UI)`);
        } else {
          sections.push(template.deploymentTemplate);
        }
        sections.push('```');
      }
      sections.push('');
    }

    // 4. Diagnostic hints
    sections.push('## Common Failure Patterns');
    sections.push('• `OOMKilled` — Pod exceeded memory limit. Increase `resources.limits.memory`.');
    sections.push('• `CrashLoopBackOff` — App is crashing on startup. Check container logs in Devtron UI.');
    sections.push('• `ImagePullBackOff` — Invalid image tag or missing registry credentials.');
    sections.push('• `Pending` pods — Insufficient cluster resources or bad node selectors.');
    sections.push('• `Progressing` stuck — Previous deploy interrupted. Check history messages above.');
    sections.push('• Probe failures — Liveness/readiness probe path or port is wrong in the template.');
    sections.push('');
    sections.push(`_To rollback: "Roll back ${input.appName} in ${input.environment} to deployment ID <id>"_`);
    sections.push(`_To view live logs: Open Devtron UI → ${input.appName} → ${input.environment} → App Details → Logs_`);

    return sections.join('\n');
  } catch (error) {
    if (error instanceof McpToolError) return `❌ Troubleshooting failed: ${error.message}`;
    throw error;
  }
}
