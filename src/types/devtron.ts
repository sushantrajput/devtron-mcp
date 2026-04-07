// src/types/devtron.ts
// TypeScript interfaces that match Devtron's API responses.
// Verified against a live Devtron instance on 2026-04-06.

// ── App lookup ────────────────────────────────────────────────────────────────

/** Returned by GET /orchestrator/app/autocomplete */
export interface AppInfo {
  id: number;
  name: string;
  description?: string;
}

/** Returned by GET /orchestrator/env/autocomplete */
export interface EnvInfo {
  id: number;
  environment_name: string;
  cluster_id: number;
  cluster_name: string;
  namespace: string;
}

/**
 * Resolved context for a specific app+environment combination.
 * Populated by DevtronService.resolveAppEnv() and used by all operational tools.
 * Combines data from three endpoints:
 *   1. /orchestrator/app/autocomplete          → appId
 *   2. /orchestrator/env/autocomplete          → envId
 *   3. /orchestrator/app/detail/v2             → pipelineId
 */
export interface AppEnvContext {
  appId: number;
  appName: string;
  envId: number;
  envName: string;
  pipelineId: number;       // cdPipelineId from detail/v2
}

// ── Deployment status ─────────────────────────────────────────────────────────

export interface DeploymentStatus {
  appId: number;
  appName: string;
  environmentName: string;
  status: string;             // Derived from latest workflow: Succeeded → Healthy, etc.
  releaseVersion: string;     // Docker image tag of the last deployment
  lastDeployedAt: string;     // ISO timestamp
  deployedBy: string;
  isPipelineTriggered: boolean;
  deploymentAppType: string;  // "helm" or "argo_cd"
}

// ── Deployment history ────────────────────────────────────────────────────────

/** One row from GET /orchestrator/resource/history/deployment/cd-pipeline/v1 */
export interface DeploymentHistoryItem {
  id: number;             // cdWorkflowId — use as wfrId for config diff
  ciArtifactId: number;  // Required for rollback via trigger endpoint
  deployedAt: string;
  deployedBy: string;
  dockerImage: string;
  status: 'Succeeded' | 'Failed' | 'Unknown';
  message?: string;      // e.g. "A new deployment was initiated before this completed"
}

// ── Deployment template config ────────────────────────────────────────────────

/** Returned by the history configuration endpoint — the YAML applied at a specific deploy */
export interface DeploymentTemplateConfig {
  deploymentTemplate: string;
  strategy?: string;
  fetchedAt: string;
}

// ── CD pipeline trigger ───────────────────────────────────────────────────────

export interface TriggerDeploymentRequest {
  appId: number;
  pipelineId: number;
  dockerImage: string;
  cdWorkflowType: 'PRE' | 'CD' | 'POST';
  extraEnvironmentVariables?: Record<string, string>;
}

export interface TriggerDeploymentResponse {
  workflowId: number;
  status: 'Triggered' | 'Failed';
  message: string;
}

// ── Rollback ─────────────────────────────────────────────────────────────────

export interface RollbackRequest {
  appId: number;
  envId: number;
  pipelineId: number;
  deploymentId: number;
}

// ── Canary / blue-green ───────────────────────────────────────────────────────

export interface CanaryUpdateRequest {
  appId: number;
  pipelineId: number;
  trafficPercentage: number;
  action: 'promote' | 'rollback' | 'set-weight';
}

// ── Pod logs & events ─────────────────────────────────────────────────────────

export interface PodLog {
  podName: string;
  containerName: string;
  logs: string;
  namespace: string;
}

// ── External CI webhook ───────────────────────────────────────────────────────

export interface PipelineWebhookInfo {
  webhookUrl: string;
  accessKey: string;
  samplePayload: { dockerImage: string };
}
