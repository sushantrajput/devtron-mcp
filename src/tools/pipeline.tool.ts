// src/tools/pipeline.tool.ts
// Feature 4: Cross-Pipeline Triggers — GitLab CI → Devtron CD

import { z } from 'zod';
import { devtronService } from '../services/devtron.service.js';
import { logger } from '../utils/logger.js';
import { McpToolError } from '../utils/errors.js';

export const getPipelineWebhookInfoSchema = z.object({
  appName: z.string().describe(
    'The Devtron application name to get webhook details for. ' +
    'An "External CI" pipeline must already exist on this app in Devtron.'
  ),
});

export type GetPipelineWebhookInfoInput = z.infer<typeof getPipelineWebhookInfoSchema>;

export async function handleGetPipelineWebhookInfo(
  input: GetPipelineWebhookInfoInput
): Promise<string> {
  logger.info('Tool: get_pipeline_webhook_info called', { appName: input.appName });

  try {
    const apps = await devtronService.getAllApps();
    const app = apps.find((a) => a.name.toLowerCase() === input.appName.toLowerCase());

    if (!app) {
      const names = apps.map((a) => a.name).join(', ');
      return `❌ App '${input.appName}' not found. Available apps: ${names}`;
    }

    const webhookInfo = await devtronService.getPipelineWebhookInfo(app.id);
    const snippet = buildGitlabCiSnippet(webhookInfo.webhookUrl);

    return [
      `🔗 **Devtron Webhook Info for \`${input.appName}\`**`,
      '',
      `**Webhook URL:**`,
      `\`${webhookInfo.webhookUrl}\``,
      '',
      `**Access Key:**`,
      `\`${webhookInfo.accessKey}\``,
      '_(Store as GitLab CI/CD variable: DEVTRON_API_TOKEN)_',
      '',
      '---',
      '',
      '**Ready-to-use `.gitlab-ci.yml` deploy stage:**',
      '',
      '```yaml',
      snippet,
      '```',
      '',
      '**Setup steps:**',
      '1. In GitLab: Settings → CI/CD → Variables',
      `2. Add \`DEVTRON_WEBHOOK_URL\` = \`${webhookInfo.webhookUrl}\``,
      `3. Add \`DEVTRON_API_TOKEN\` = \`${webhookInfo.accessKey}\` (masked)`,
      '4. Paste the stage above into your `.gitlab-ci.yml` and push to `main`.',
    ].join('\n');
  } catch (error) {
    if (error instanceof McpToolError) return `❌ Could not fetch webhook info: ${error.message}`;
    throw error;
  }
}

function buildGitlabCiSnippet(webhookUrl: string): string {
  return [
    'stages:',
    '  - build',
    '  - deploy',
    '',
    'build-image:',
    '  stage: build',
    '  script:',
    '    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA .',
    '    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA',
    '  only:',
    '    - main',
    '',
    `# Webhook URL: ${webhookUrl}`,
    'deploy-to-devtron:',
    '  stage: deploy',
    '  image: curlimages/curl:latest',
    '  script:',
    '    - |',
    '      curl --silent --fail --show-error \\',
    '        --request POST "${DEVTRON_WEBHOOK_URL}" \\',
    '        --header "Content-Type: application/json" \\',
    '        --header "token: ${DEVTRON_API_TOKEN}" \\',
    '        --data-raw "{\\"dockerImage\\": \\"${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHA}\\"}"',
    '  needs:',
    '    - build-image',
    '  only:',
    '    - main',
  ].join('\n');
}
