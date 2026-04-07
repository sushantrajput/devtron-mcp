// src/tools/deployment.tool.ts
// Feature 1: Conversational Deployments + Status + List Apps

import { z } from 'zod';
import { devtronService } from '../services/devtron.service.js';
import { logger } from '../utils/logger.js';
import { McpToolError } from '../utils/errors.js';

// ── get_deployment_status ────────────────────────────────────────────────────

export const getDeploymentStatusSchema = z.object({
  appName: z.string().describe('The name of the application in Devtron'),
  environment: z.string().describe(
    'The environment to check (e.g. devtron-demo, staging, production)'
  ),
});

export type GetDeploymentStatusInput = z.infer<typeof getDeploymentStatusSchema>;

export async function handleGetDeploymentStatus(
  input: GetDeploymentStatusInput
): Promise<string> {
  logger.info('Tool: get_deployment_status called', input);

  try {
    const ctx = await devtronService.resolveAppEnv(input.appName, input.environment);
    const status = await devtronService.getDeploymentStatus(ctx.appId, ctx.envId);

    const lastDeployed = status.lastDeployedAt
      ? new Date(status.lastDeployedAt).toLocaleString()
      : 'unknown';

    return [
      `📊 **Deployment Status — ${input.appName} / ${input.environment}**`,
      '',
      `• Status: **${status.status}**`,
      `• Image: ${status.releaseVersion || 'unknown'}`,
      `• Deployment type: ${status.deploymentAppType || 'unknown'}`,
      `• Pipeline triggered: ${status.isPipelineTriggered ? 'Yes' : 'No'}`,
      `• Last deployed: ${lastDeployed}`,
      `• Deployed by: ${status.deployedBy || 'unknown'}`,
    ].join('\n');
  } catch (error) {
    if (error instanceof McpToolError) return `❌ ${error.message}`;
    throw error;
  }
}

// ── trigger_deployment ───────────────────────────────────────────────────────

export const triggerDeploymentSchema = z.object({
  appName: z.string().describe('The name of the application to deploy'),
  environment: z.string().describe('Target environment (e.g. devtron-demo, staging, production)'),
  dockerImage: z.string().describe(
    'Full Docker image URI with tag (e.g. registry.example.com/app:v1.2.3)'
  ),
});

export type TriggerDeploymentInput = z.infer<typeof triggerDeploymentSchema>;

export async function handleTriggerDeployment(
  input: TriggerDeploymentInput
): Promise<string> {
  logger.info('Tool: trigger_deployment called', {
    appName: input.appName,
    environment: input.environment,
  });

  try {
    const ctx = await devtronService.resolveAppEnv(input.appName, input.environment);

    const result = await devtronService.triggerDeployment({
      appId: ctx.appId,
      pipelineId: ctx.pipelineId,
      dockerImage: input.dockerImage,
      cdWorkflowType: 'CD',
    });

    if (result.status === 'Triggered') {
      return [
        `✅ **Deployment triggered successfully!**`,
        '',
        `• App: ${input.appName}`,
        `• Environment: ${input.environment}`,
        `• Image: ${input.dockerImage}`,
        `• Workflow ID: ${result.workflowId}`,
        '',
        `Monitor: "What is the status of ${input.appName} in ${input.environment}?"`,
      ].join('\n');
    }

    return `⚠️ Deployment returned status: ${result.status}. Message: ${result.message}`;
  } catch (error) {
    if (error instanceof McpToolError) return `❌ Deployment failed: ${error.message}`;
    throw error;
  }
}

// ── list_all_apps ────────────────────────────────────────────────────────────

export const listAllAppsSchema = z.object({});

export type ListAllAppsInput = z.infer<typeof listAllAppsSchema>;

export async function handleListAllApps(_input: ListAllAppsInput): Promise<string> {
  logger.info('Tool: list_all_apps called');

  try {
    const apps = await devtronService.getAllApps();

    if (apps.length === 0) {
      return '❌ No apps found in Devtron.';
    }

    const lines = apps.map(
      (app) => `• **${app.name}** (ID: ${app.id})${app.description ? ` — ${app.description}` : ''}`
    );

    return [
      `📋 **Apps in Devtron** (${apps.length} total)`,
      '',
      ...lines,
      '',
      `To check an app: "What is the deployment status of ${apps[0]!.name}?"`,
    ].join('\n');
  } catch (error) {
    if (error instanceof McpToolError) return `❌ ${error.message}`;
    throw error;
  }
}
