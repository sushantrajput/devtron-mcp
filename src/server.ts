// src/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';

import {
  getDeploymentStatusSchema,
  handleGetDeploymentStatus,
  triggerDeploymentSchema,
  handleTriggerDeployment,
  listAllAppsSchema,
  handleListAllApps,
} from './tools/deployment.tool.js';

import {
  getDeploymentHistorySchema,
  handleGetDeploymentHistory,
  getDeploymentConfigDiffSchema,
  handleGetDeploymentConfigDiff,
  triggerRollbackSchema,
  handleTriggerRollback,
} from './tools/rollback.tool.js';

import {
  manageCanarySchema,
  handleManageCanary,
} from './tools/canary.tool.js';

import {
  troubleshootDeploymentSchema,
  handleTroubleshootDeployment,
} from './tools/troubleshoot.tool.js';

import {
  getPipelineWebhookInfoSchema,
  handleGetPipelineWebhookInfo,
} from './tools/pipeline.tool.js';

import {
  promoteToEnvironmentSchema,
  handlePromoteToEnvironment,
} from './tools/promotion.tool.js';

// ── Tool registry ─────────────────────────────────────────────────────────────
// Each entry declares the tool's name, a description the LLM uses for routing,
// a Zod schema for input validation, and the async handler function.

const TOOLS = [
  // ── Feature 1: Conversational Deployments ──────────────────────────────────
  {
    name: 'get_deployment_status',
    description:
      'Get the current deployment status of an application in a specific environment on Devtron. ' +
      'Returns status, image version, pod counts, and who last deployed. ' +
      'Use when asked "what is the status of X?" or "is Y deployed in production?"',
    schema: getDeploymentStatusSchema,
    handler: handleGetDeploymentStatus,
  },
  {
    name: 'trigger_deployment',
    description:
      'Deploy a specific Docker image to an environment via Devtron CD pipeline. ' +
      'Use when asked to "deploy X to staging" or "release image Y to production".',
    schema: triggerDeploymentSchema,
    handler: handleTriggerDeployment,
  },
  {
    name: 'list_all_apps',
    description:
      'List all applications registered in Devtron along with their environments. ' +
      'Use when asked "what apps are available?", "list all apps", or "what can I deploy?"',
    schema: listAllAppsSchema,
    handler: handleListAllApps,
  },

  // ── Feature 2: AI-Assisted Rollbacks ──────────────────────────────────────
  {
    name: 'get_deployment_history',
    description:
      'Fetch recent deployment history for an application in Devtron. ' +
      'Returns deployment IDs, timestamps, images, and statuses. ' +
      'Always call this before trigger_rollback to obtain a valid deployment ID.',
    schema: getDeploymentHistorySchema,
    handler: handleGetDeploymentHistory,
  },
  {
    name: 'get_deployment_config_diff',
    description:
      'Show the YAML diff between two deployments to understand what changed in the deployment ' +
      'template (resource limits, env vars, probes, etc.). ' +
      'Use before rolling back to understand the difference between the current (broken) ' +
      'deployment and a previous (healthy) one. ' +
      'Example: "show config diff between deployment 502 and 499 for payment-service in production".',
    schema: getDeploymentConfigDiffSchema,
    handler: handleGetDeploymentConfigDiff,
  },
  {
    name: 'trigger_rollback',
    description:
      'Roll back an application to a specific previously deployed version in Devtron. ' +
      'Call get_deployment_history first to get valid deployment IDs. ' +
      'Optionally call get_deployment_config_diff first to review what will change.',
    schema: triggerRollbackSchema,
    handler: handleTriggerRollback,
  },

  // ── Feature 3: Canary & Blue-Green Deployments ────────────────────────────
  {
    name: 'manage_canary_deployment',
    description:
      'Manage a canary or blue-green deployment: shift traffic weight, promote to 100%, or roll back. ' +
      'Use for "start canary with 10% traffic", "promote canary to 50%", "roll back canary".',
    schema: manageCanarySchema,
    handler: handleManageCanary,
  },

  // ── Feature 4: Cross-Pipeline Triggers (GitLab CI → Devtron CD) ──────────
  {
    name: 'get_pipeline_webhook_info',
    description:
      'Get Devtron\'s external-CI webhook URL for an app and generate a ready-to-paste ' +
      '.gitlab-ci.yml deploy stage. ' +
      'Use when asked "how do I connect my GitLab pipeline to Devtron?" or ' +
      '"give me the webhook URL for payment-service".',
    schema: getPipelineWebhookInfoSchema,
    handler: handleGetPipelineWebhookInfo,
  },

  // ── Feature 5: Environment Promotion Workflows ────────────────────────────
  {
    name: 'promote_to_environment',
    description:
      'Promote an application from one environment to another by deploying the same image ' +
      'that is currently running in the source environment. ' +
      'Blocks promotion if the source environment is unhealthy (unless force=true). ' +
      'Use for "promote payment-service from staging to production" or ' +
      '"push the current staging image to production".',
    schema: promoteToEnvironmentSchema,
    handler: handlePromoteToEnvironment,
  },

  // ── Feature 6: Deployment Troubleshooting ────────────────────────────────
  {
    name: 'troubleshoot_deployment',
    description:
      'Collect pod logs, Kubernetes events, and the current deployment template config ' +
      'for an app to diagnose deployment failures. ' +
      'Use when asked "why is my deployment failing?", "show logs for X", or ' +
      '"what is wrong with order-service in production?".',
    schema: troubleshootDeploymentSchema,
    handler: handleTroubleshootDeployment,
  },
] as const;

// ── JSON Schema conversion ────────────────────────────────────────────────────
// We convert Zod schemas to JSON Schema manually because zod-to-json-schema
// has compatibility issues with Zod v4's internal structure.

function zodSchemaToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const typeName: string =
      (fieldSchema as any)._def?.typeName ??
      (fieldSchema as any)._zod?.def?.type ??
      'ZodString';

    const isOptional =
      typeName === 'ZodOptional' || typeName === 'ZodDefault' ||
      typeName === 'optional'    || typeName === 'default';

    if (!isOptional) {
      required.push(key);
    }

    // Unwrap Optional/Default to reach the inner type
    const innerDef =
      (fieldSchema as any)._def?.innerType?._def ??
      (fieldSchema as any)._zod?.def?.innerType?._zod?.def ??
      (fieldSchema as any)._def;

    const innerTypeName: string =
      innerDef?.typeName ?? innerDef?.type ?? typeName;

    let jsonType = 'string';
    const extra: Record<string, unknown> = {};

    if (innerTypeName === 'ZodNumber' || innerTypeName === 'number') {
      jsonType = 'number';
    } else if (innerTypeName === 'ZodBoolean' || innerTypeName === 'boolean') {
      jsonType = 'boolean';
    } else if (innerTypeName === 'ZodEnum' || innerTypeName === 'enum') {
      jsonType = 'string';
      const enumValues =
        (fieldSchema as any)._def?.values ??
        (fieldSchema as any)._zod?.def?.entries ??
        [];
      extra['enum'] = Array.isArray(enumValues) ? enumValues : Object.keys(enumValues);
    }

    const description: string = (fieldSchema as any).description ?? '';
    properties[key] = { type: jsonType, description, ...extra };
  }

  return { type: 'object', properties, required };
}

// ── Create and configure the MCP server ──────────────────────────────────────

export async function createServer(): Promise<Server> {
  const server = new Server(
    { name: config.server.name, version: config.server.version },
    { capabilities: { tools: {} } }
  );

  // Handler: LLM asks "what tools do you have?"
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.info('tools/list requested', { count: TOOLS.length });
    return {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodSchemaToJsonSchema(tool.schema),
      })),
    };
  });

  // Handler: LLM calls a specific tool
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;
    logger.info('Tool called', { tool: name });

    const tool = TOOLS.find((t) => t.name === name);

    if (!tool) {
      return {
        content: [{
          type: 'text' as const,
          text: `❌ Unknown tool: "${name}". Available tools: ${TOOLS.map((t) => t.name).join(', ')}`,
        }],
        isError: true,
      };
    }

    try {
      const validatedInput = tool.schema.parse(args);
      const resultText = await (tool.handler as (input: any) => Promise<string>)(validatedInput);
      return {
        content: [{ type: 'text' as const, text: resultText }],
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(', ');
        logger.warn('Tool input validation failed', { tool: name, issues });
        return {
          content: [{
            type: 'text' as const,
            text: `❌ Invalid input for "${name}": ${issues}`,
          }],
          isError: true,
        };
      }
      logger.error('Tool execution failed', { tool: name, error });
      return {
        content: [{
          type: 'text' as const,
          text: `❌ Error running "${name}". Check server logs for details.`,
        }],
        isError: true,
      };
    }
  });

  return server;
}
