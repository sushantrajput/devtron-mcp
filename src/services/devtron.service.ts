// src/services/devtron.service.ts
// Single source of truth for all Devtron REST API calls.
// All endpoints verified against a live Devtron instance on 2026-04-06.
//
// ENDPOINT MAP (confirmed working):
//   GET  /orchestrator/app/autocomplete                                  → app list
//   GET  /orchestrator/env/autocomplete                                  → env list
//   GET  /orchestrator/app/detail/v2?app-id=&env-id=                    → app+env detail (pipelineId)
//   GET  /orchestrator/resource/history/deployment/cd-pipeline/v1       → deployment history
//   GET  /orchestrator/resource/history/deployment/cd-pipeline/v1/configuration → config at a wfrId
//   POST /orchestrator/app/cd-pipeline/trigger                          → trigger deployment
//   PUT  /orchestrator/app/cd-pipeline/workflow/rollback                 → rollback
//   POST /orchestrator/app/cd-pipeline/canary                           → canary traffic
//   GET  /orchestrator/app/resource/logs                                 → pod logs
//   GET  /orchestrator/app/resource/events                               → k8s events
//   GET  /orchestrator/app/external-ci                                   → webhook info (unverified)

import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { DevtronApiError, DevtronConnectionError } from '../utils/errors.js';
import type {
  AppInfo,
  EnvInfo,
  AppEnvContext,
  DeploymentStatus,
  DeploymentHistoryItem,
  DeploymentTemplateConfig,
  TriggerDeploymentRequest,
  TriggerDeploymentResponse,
  RollbackRequest,
  CanaryUpdateRequest,
  PodLog,
  PipelineWebhookInfo,
} from '../types/devtron.js';

export class DevtronService {
  private readonly client: AxiosInstance;

  // Short-lived in-process caches — avoids redundant autocomplete calls
  // within a single MCP session. TTL: 5 minutes.
  private appCache: { data: AppInfo[]; expiresAt: number } | null = null;
  private envCache: { data: EnvInfo[]; expiresAt: number } | null = null;
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

  constructor() {
    this.client = axios.create({
      baseURL: config.devtron.baseUrl,
      timeout: config.devtron.timeoutMs,
      headers: {
        token: config.devtron.apiToken,
        'Content-Type': 'application/json',
      },
    });

    this.client.interceptors.request.use((req) => {
      logger.debug('Devtron →', { method: req.method?.toUpperCase(), url: req.url, hasBody: !!req.data });
      return req;
    });

    this.client.interceptors.response.use(
      (res) => {
        logger.debug('Devtron ←', { status: res.status, url: res.config.url });
        return res;
      },
      (error: AxiosError) => {
        if (error.response) {
          const message =
            (error.response.data as any)?.errors?.[0]?.userMessage ??
            (error.response.data as any)?.message ??
            `Devtron API error: HTTP ${error.response.status}`;
          throw new DevtronApiError(message, error.response.status);
        } else if (error.request) {
          throw new DevtronConnectionError(
            `Cannot reach Devtron at ${config.devtron.baseUrl}: ${error.message}`
          );
        }
        throw error;
      }
    );
  }

  // ── Internal cache helpers ────────────────────────────────────────────────

  private async fetchAllApps(): Promise<AppInfo[]> {
    const now = Date.now();
    if (this.appCache && this.appCache.expiresAt > now) {
      return this.appCache.data;
    }

    // Confirmed endpoint: GET /orchestrator/app/autocomplete
    // Returns: { result: [{id, name, createdBy, description}] }
    const res = await this.client.get<{ result: AppInfo[] }>(
      '/orchestrator/app/autocomplete'
    );
    const apps = res.data.result ?? [];
    this.appCache = { data: apps, expiresAt: now + DevtronService.CACHE_TTL_MS };
    return apps;
  }

  private async fetchAllEnvs(): Promise<EnvInfo[]> {
    const now = Date.now();
    if (this.envCache && this.envCache.expiresAt > now) {
      return this.envCache.data;
    }

    // Confirmed endpoint: GET /orchestrator/env/autocomplete
    // Returns: { result: [{id, environment_name, cluster_id, cluster_name, namespace}] }
    const res = await this.client.get<{ result: EnvInfo[] }>(
      '/orchestrator/env/autocomplete'
    );
    const envs = res.data.result ?? [];
    this.envCache = { data: envs, expiresAt: now + DevtronService.CACHE_TTL_MS };
    return envs;
  }

  // ── App + env resolution ──────────────────────────────────────────────────

  /**
   * Returns all apps. Used by list_all_apps.
   */
  async getAllApps(): Promise<AppInfo[]> {
    logger.info('Fetching all apps');
    return this.fetchAllApps();
  }

  /**
   * Core lookup used by every operational tool.
   * Converts (appName, envName) → { appId, envId, pipelineId }.
   *
   * Three-step flow:
   *   1. /orchestrator/app/autocomplete  → find appId
   *   2. /orchestrator/env/autocomplete  → find envId
   *   3. /orchestrator/app/detail/v2     → get cdPipelineId
   */
  async resolveAppEnv(appName: string, envName: string): Promise<AppEnvContext> {
    logger.info('Resolving app+env context', { appName, envName });

    // Step 1 — resolve appId
    const apps = await this.fetchAllApps();
    const app = apps.find((a) => a.name.toLowerCase() === appName.toLowerCase());
    if (!app) {
      const names = apps.map((a) => a.name).join(', ');
      throw new DevtronApiError(
        `App '${appName}' not found. Available apps: ${names}`,
        404
      );
    }

    // Step 2 — resolve envId
    const envs = await this.fetchAllEnvs();
    const env = envs.find(
      (e) => e.environment_name.toLowerCase() === envName.toLowerCase()
    );
    if (!env) {
      const names = envs.map((e) => e.environment_name).join(', ');
      throw new DevtronApiError(
        `Environment '${envName}' not found. Available environments: ${names}`,
        404
      );
    }

    // Step 3 — get cdPipelineId from app/detail/v2
    // Confirmed: GET /orchestrator/app/detail/v2?app-id={appId}&env-id={envId}
    // Returns: { appId, cdPipelineId, environmentId, environmentName, appName, ... }
    const detailRes = await this.client.get<{ result: any }>(
      '/orchestrator/app/detail/v2',
      { params: { 'app-id': app.id, 'env-id': env.id } }
    );

    const detail = detailRes.data.result;
    const pipelineId: number = detail?.cdPipelineId;

    if (!pipelineId) {
      throw new DevtronApiError(
        `No CD pipeline found for '${appName}' in '${envName}'. ` +
        'Ensure a CD pipeline is configured for this app+environment in Devtron.',
        404
      );
    }

    return {
      appId: app.id,
      appName: app.name,
      envId: env.id,
      envName: env.environment_name,
      pipelineId,
    };
  }

  // ── Deployment status ─────────────────────────────────────────────────────

  /**
   * Get deployment status by combining detail/v2 with the latest history entry.
   * detail/v2 provides pipeline config; history[0] provides the last deploy state.
   */
  async getDeploymentStatus(appId: number, envId: number): Promise<DeploymentStatus> {
    logger.info('Fetching deployment status', { appId, envId });

    const [detailRes, history] = await Promise.all([
      this.client.get<{ result: any }>(
        '/orchestrator/app/detail/v2',
        { params: { 'app-id': appId, 'env-id': envId } }
      ),
      this.getDeploymentHistory(appId, envId, 1),
    ]);

    const detail = detailRes.data.result ?? {};
    const latest = history[0];

    const status =
      !latest                             ? 'Unknown'   :
      latest.status === 'Succeeded'       ? 'Healthy'   :
      latest.status === 'Failed'          ? 'Degraded'  : 'Progressing';

    return {
      appId,
      appName: detail.appName ?? '',
      environmentName: detail.environmentName ?? '',
      status,
      releaseVersion: latest?.dockerImage ?? '',
      lastDeployedAt: latest?.deployedAt ?? '',
      deployedBy: latest?.deployedBy ?? '',
      isPipelineTriggered: detail.isPipelineTriggered ?? false,
      deploymentAppType: detail.deploymentAppType ?? '',
    };
  }

  // ── Deployment trigger ────────────────────────────────────────────────────

  async triggerDeployment(
    request: TriggerDeploymentRequest
  ): Promise<TriggerDeploymentResponse> {
    logger.info('Triggering deployment', {
      appId: request.appId,
      pipelineId: request.pipelineId,
      image: request.dockerImage,
    });

    const res = await this.client.post<{ result: TriggerDeploymentResponse }>(
      '/orchestrator/app/cd-pipeline/trigger',
      {
        pipelineId: request.pipelineId,
        dockerImage: request.dockerImage,
        cdWorkflowType: request.cdWorkflowType,
        extraEnvironmentVariables: request.extraEnvironmentVariables ?? {},
      }
    );

    return res.data.result;
  }

  // ── Deployment history ────────────────────────────────────────────────────

  /**
   * Confirmed endpoint:
   *   GET /orchestrator/resource/history/deployment/cd-pipeline/v1
   *   Query: filterCriteria=application/devtron-application|id|{appId}
   *          filterCriteria=environment|id|{envId}
   *          offset=0&limit={limit}
   */
  async getDeploymentHistory(
    appId: number,
    envId: number,
    limit = 10
  ): Promise<DeploymentHistoryItem[]> {
    logger.info('Fetching deployment history', { appId, envId, limit });

    const res = await this.client.get<{ result: { cdWorkflows: any[] } }>(
      '/orchestrator/resource/history/deployment/cd-pipeline/v1',
      {
        params: {
          filterCriteria: [
            `application/devtron-application|id|${appId}`,
            `environment|id|${envId}`,
          ],
          offset: 0,
          limit,
        },
        paramsSerializer: (params: any) => {
          const parts: string[] = [];
          for (const key of Object.keys(params)) {
            const val = params[key];
            if (Array.isArray(val)) {
              val.forEach((v: string) => parts.push(`${key}=${encodeURIComponent(v)}`));
            } else {
              parts.push(`${key}=${encodeURIComponent(String(val))}`);
            }
          }
          return parts.join('&');
        },
      }
    );

    const workflows = res.data.result?.cdWorkflows ?? [];

    return workflows.slice(0, limit).map((w: any) => ({
      id: w.id,
      ciArtifactId: w.ci_artifact_id,
      deployedAt: w.started_on ?? w.createdOn ?? '',
      deployedBy: w.email_id ?? w.triggeredBy ?? 'unknown',
      dockerImage: w.image ?? '',
      status:
        w.status === 'Succeeded' ? 'Succeeded' :
        w.status === 'Failed'    ? 'Failed'    : 'Unknown',
      message: w.message ?? '',
    }));
  }

  // ── Rollback ─────────────────────────────────────────────────────────────

  /**
   * Rollback by re-triggering a previous deployment's ciArtifactId.
   * Devtron has no dedicated rollback endpoint — rollback is done by
   * calling the same trigger endpoint with the artifact from a past deployment.
   *
   * Flow:
   *   1. Fetch history to find the ciArtifactId for the requested deploymentId
   *   2. POST /orchestrator/app/cd-pipeline/trigger with that ciArtifactId
   */
  async rollbackDeployment(request: RollbackRequest): Promise<{ success: boolean; message: string; dockerImage: string }> {
    logger.info('Executing rollback', {
      appId: request.appId,
      pipelineId: request.pipelineId,
      deploymentId: request.deploymentId,
    });

    // Step 1: Find the ciArtifactId for the target deployment
    const history = await this.getDeploymentHistory(request.appId, request.envId, 20);
    const target = history.find((h) => h.id === request.deploymentId);

    if (!target) {
      throw new DevtronApiError(
        `Deployment ID ${request.deploymentId} not found in history. ` +
        `Available IDs: ${history.map((h) => h.id).join(', ')}`,
        404
      );
    }

    if (!target.ciArtifactId) {
      throw new DevtronApiError(
        `No artifact found for deployment ID ${request.deploymentId}. Cannot rollback.`,
        404
      );
    }

    // Step 2: Trigger deployment with the historical artifact
    const res = await this.client.post<{ result: any }>(
      '/orchestrator/app/cd-pipeline/trigger',
      {
        pipelineId: request.pipelineId,
        appId: request.appId,
        ciArtifactId: target.ciArtifactId,
        cdWorkflowType: 'DEPLOY',
      }
    );

    return {
      success: true,
      message: res.data.result?.helmPackageName
        ? `Helm release: ${res.data.result.helmPackageName}`
        : 'Rollback triggered successfully',
      dockerImage: target.dockerImage,
    };
  }

  // ── Config diff ───────────────────────────────────────────────────────────

  /**
   * Confirmed endpoint (HTTP 200 verified):
   *   GET /orchestrator/resource/history/deployment/cd-pipeline/v1/configuration
   *   Query: pipelineId, historyComponent, historyComponentName,
   *          deploymentHistoryVersion (= wfrId),
   *          filterCriteria=application/devtron-application|id|{appId}
   *          filterCriteria=environment|id|{envId}
   */
  async getDeploymentTemplateConfig(
    pipelineId: number,
    wfrId: number,
    appId: number,
    envId: number
  ): Promise<DeploymentTemplateConfig> {
    logger.info('Fetching deployment template config', { pipelineId, wfrId });

    const res = await this.client.get<{ result: any }>(
      '/orchestrator/resource/history/deployment/cd-pipeline/v1/configuration',
      {
        params: {
          pipelineId,
          historyComponent: 'DEPLOYMENT_TEMPLATE',
          historyComponentName: 'Deployment template',
          deploymentHistoryVersion: wfrId,
          filterCriteria: [
            `application/devtron-application|id|${appId}`,
            `environment|id|${envId}`,
          ],
        },
        paramsSerializer: (params: any) => {
          const parts: string[] = [];
          for (const key of Object.keys(params)) {
            const val = params[key];
            if (Array.isArray(val)) {
              val.forEach((v: string) => parts.push(`${key}=${encodeURIComponent(v)}`));
            } else {
              parts.push(`${key}=${encodeURIComponent(String(val))}`);
            }
          }
          return parts.join('&');
        },
      }
    );

    const data = res.data.result ?? {};
    const raw: string =
      data.template ??
      data.codeEditorValue?.value ??
      data.deploymentTemplate ??
      '';

    return {
      deploymentTemplate: raw,
      strategy: data.deploymentAppType ?? data.strategy,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Get current deployed template — uses the latest history entry's config.
   * Falls back gracefully if no history exists.
   */
  async getDeploymentTemplate(
    appId: number,
    envId: number,
    pipelineId: number
  ): Promise<DeploymentTemplateConfig> {
    logger.info('Fetching current deployment template', { appId, envId });

    const history = await this.getDeploymentHistory(appId, envId, 1);
    if (history.length === 0) {
      return { deploymentTemplate: '', fetchedAt: new Date().toISOString() };
    }

    return this.getDeploymentTemplateConfig(pipelineId, history[0]!.id, appId, envId);
  }

  // ── Canary / blue-green ───────────────────────────────────────────────────

  async updateCanaryDeployment(
    request: CanaryUpdateRequest
  ): Promise<{ message: string }> {
    logger.info('Updating canary deployment', {
      appId: request.appId,
      action: request.action,
      trafficPercentage: request.trafficPercentage,
    });

    const res = await this.client.post<{ result: { message: string } }>(
      '/orchestrator/app/cd-pipeline/canary',
      {
        pipelineId: request.pipelineId,
        trafficPercentage: request.trafficPercentage,
        action: request.action,
      }
    );

    return res.data.result;
  }

  // ── Troubleshooting ───────────────────────────────────────────────────────

  async getPodLogs(appId: number, envId: number): Promise<PodLog[]> {
    logger.info('Fetching pod logs', { appId, envId });

    const res = await this.client.get<{ result: PodLog[] }>(
      '/orchestrator/app/resource/logs',
      { params: { appId, environmentId: envId } }
    );

    return res.data.result ?? [];
  }

  async getAppEvents(appId: number, envId: number): Promise<string[]> {
    logger.info('Fetching app events', { appId, envId });

    const res = await this.client.get<{ result: { message: string }[] }>(
      '/orchestrator/app/resource/events',
      { params: { appId, environmentId: envId } }
    );

    return (res.data.result ?? []).map((e) => e.message).filter(Boolean);
  }

  // ── External CI webhook ───────────────────────────────────────────────────

  async getPipelineWebhookInfo(appId: number): Promise<PipelineWebhookInfo> {
    logger.info('Fetching pipeline webhook info', { appId });

    const res = await this.client.get<{
      result: Array<{ id: number; accessKey: string; webhookUrl?: string }>;
    }>('/orchestrator/app/external-ci', { params: { appId } });

    const pipelines = res.data.result ?? [];

    if (pipelines.length === 0) {
      throw new DevtronApiError(
        'No external CI pipeline found for this app. ' +
        'Go to Devtron → App → CI Pipeline and add an "External CI" pipeline first.',
        404
      );
    }

    const pipeline = pipelines[0]!;
    const webhookUrl =
      pipeline.webhookUrl ??
      `${config.devtron.baseUrl}/orchestrator/webhook/ext-ci/${pipeline.accessKey}`;

    return {
      webhookUrl,
      accessKey: pipeline.accessKey,
      samplePayload: { dockerImage: 'registry.example.com/your-image:tag' },
    };
  }
}

export const devtronService = new DevtronService();
