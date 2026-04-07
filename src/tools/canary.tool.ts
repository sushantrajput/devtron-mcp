// src/tools/canary.tool.ts
// Feature 3: Canary & Blue-Green Deployment Orchestration

import { z } from 'zod';
import { devtronService } from '../services/devtron.service.js';
import { logger } from '../utils/logger.js';
import { McpToolError } from '../utils/errors.js';

export const manageCanarySchema = z.object({
  appName: z.string().describe('Application name'),
  environment: z.string().describe('Target environment'),
  action: z.enum(['set-weight', 'promote', 'rollback']).describe(
    '"set-weight" to shift traffic %, "promote" to send 100% to canary, "rollback" to restore stable'
  ),
  trafficPercentage: z.number().min(0).max(100).optional().describe(
    'Traffic % to route to the canary (0-100). Required when action is "set-weight".'
  ),
});

export type ManageCanaryInput = z.infer<typeof manageCanarySchema>;

export async function handleManageCanary(input: ManageCanaryInput): Promise<string> {
  logger.info('Tool: manage_canary called', input);

  if (input.action === 'set-weight' && input.trafficPercentage === undefined) {
    return '❌ trafficPercentage is required when action is "set-weight".';
  }

  try {
    const ctx = await devtronService.resolveAppEnv(input.appName, input.environment);

    const percentage =
      input.action === 'promote'   ? 100 :
      input.action === 'rollback'  ? 0   :
      (input.trafficPercentage ?? 0);

    const result = await devtronService.updateCanaryDeployment({
      appId: ctx.appId,
      pipelineId: ctx.pipelineId,
      trafficPercentage: percentage,
      action: input.action,
    });

    const actionMessages: Record<string, string> = {
      'set-weight': `🚦 Canary traffic set to **${percentage}%** for ${input.appName} in ${input.environment}`,
      promote:      `✅ Canary **promoted to 100%** — full traffic now going to new version of ${input.appName}`,
      rollback:     `↩️ Canary **rolled back** — 100% traffic restored to stable version of ${input.appName}`,
    };

    return `${actionMessages[input.action]}\n\n${result.message}`;
  } catch (error) {
    if (error instanceof McpToolError) return `❌ Canary operation failed: ${error.message}`;
    throw error;
  }
}
