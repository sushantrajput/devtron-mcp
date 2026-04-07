// tests/deployment.tool.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDevtronService } = vi.hoisted(() => {
  return {
    mockDevtronService: {
      getAppByName: vi.fn(),
      getDeploymentStatus: vi.fn(),
      triggerDeployment: vi.fn(),
      getAllApps: vi.fn(),
    },
  };
});

vi.mock('../src/services/devtron.service.js', () => ({
  devtronService: mockDevtronService,
}));

vi.mock('../src/config/index.js', () => ({
  config: {
    devtron: {
      baseUrl: 'https://test.example.com',
      apiToken: 'test-token',
      timeoutMs: 5000,
    },
    server: { name: 'test', version: '1.0.0', logLevel: 'error' },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  handleGetDeploymentStatus,
  handleTriggerDeployment,
  handleListAllApps,
} from '../src/tools/deployment.tool.js';
import { DevtronApiError } from '../src/utils/errors.js';

// ── Shared test data ──────────────────────────────────────────────────────────

const mockApp = {
  id: 42,
  name: 'payment-service',
  environments: [
    { id: 1, name: 'staging', pipelineId: 101 },
    { id: 2, name: 'production', pipelineId: 202 },
  ],
};

const mockStatus = {
  appId: 42,
  appName: 'payment-service',
  environmentName: 'staging',
  status: 'Healthy' as const,
  releaseVersion: 'v1.2.3',
  lastDeployedAt: '2025-01-15T10:30:00.000Z',
  deployedBy: 'ci-bot',
  podCount: { running: 3, total: 3 },
};

// ── handleGetDeploymentStatus ─────────────────────────────────────────────────

describe('handleGetDeploymentStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns formatted status string for a healthy deployment', async () => {
    mockDevtronService.getAppByName.mockResolvedValue(mockApp);
    mockDevtronService.getDeploymentStatus.mockResolvedValue(mockStatus);

    const result = await handleGetDeploymentStatus({
      appName: 'payment-service',
      environment: 'staging',
    });

    expect(typeof result).toBe('string');
    expect(result).toContain('payment-service');
    expect(result).toContain('staging');
    expect(result).toContain('Healthy');
    expect(result).toContain('v1.2.3');
    expect(result).toContain('3/3');
    expect(result).toContain('ci-bot');
  });

  it('returns error string when environment does not exist', async () => {
    mockDevtronService.getAppByName.mockResolvedValue(mockApp);

    const result = await handleGetDeploymentStatus({
      appName: 'payment-service',
      environment: 'nonexistent-env',
    });

    expect(typeof result).toBe('string');
    expect(result).toContain('❌');
    expect(result).toContain('nonexistent-env');
    expect(result).toContain('staging');
    expect(result).toContain('production');
    expect(mockDevtronService.getDeploymentStatus).not.toHaveBeenCalled();
  });

  it('returns error string when app is not found', async () => {
    mockDevtronService.getAppByName.mockRejectedValue(
      new DevtronApiError("App 'ghost-service' not found in Devtron", 404)
    );

    const result = await handleGetDeploymentStatus({
      appName: 'ghost-service',
      environment: 'staging',
    });

    expect(typeof result).toBe('string');
    expect(result).toContain('❌');
    expect(result).toContain('not found');
  });

  it('returns degraded status when pods are partially down', async () => {
    mockDevtronService.getAppByName.mockResolvedValue(mockApp);
    mockDevtronService.getDeploymentStatus.mockResolvedValue({
      ...mockStatus,
      status: 'Degraded',
      podCount: { running: 1, total: 3 },
    });

    const result = await handleGetDeploymentStatus({
      appName: 'payment-service',
      environment: 'staging',
    });

    expect(result).toContain('Degraded');
    expect(result).toContain('1/3');
  });

  it('matches environment name case-insensitively', async () => {
    mockDevtronService.getAppByName.mockResolvedValue(mockApp);
    mockDevtronService.getDeploymentStatus.mockResolvedValue(mockStatus);

    const result = await handleGetDeploymentStatus({
      appName: 'payment-service',
      environment: 'STAGING',
    });

    expect(result).not.toContain('❌');
    expect(result).toContain('Healthy');
  });
});

// ── handleTriggerDeployment ───────────────────────────────────────────────────

describe('handleTriggerDeployment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success message when deployment is triggered', async () => {
    mockDevtronService.getAppByName.mockResolvedValue(mockApp);
    mockDevtronService.triggerDeployment.mockResolvedValue({
      workflowId: 8888,
      status: 'Triggered',
      message: 'CD pipeline triggered',
    });

    const result = await handleTriggerDeployment({
      appName: 'payment-service',
      environment: 'staging',
      dockerImage: 'registry.example.com/payment-service:v2.0.0',
    });

    expect(result).toContain('✅');
    expect(result).toContain('payment-service');
    expect(result).toContain('staging');
    expect(result).toContain('v2.0.0');
    expect(result).toContain('8888');
  });

  it('uses correct pipelineId for the requested environment', async () => {
    mockDevtronService.getAppByName.mockResolvedValue(mockApp);
    mockDevtronService.triggerDeployment.mockResolvedValue({
      workflowId: 1,
      status: 'Triggered',
      message: 'ok',
    });

    await handleTriggerDeployment({
      appName: 'payment-service',
      environment: 'production',
      dockerImage: 'registry.example.com/payment-service:v3.0.0',
    });

    expect(mockDevtronService.triggerDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 202,
        appId: 42,
        cdWorkflowType: 'CD',
      })
    );
  });

  it('returns error string when environment is not found', async () => {
    mockDevtronService.getAppByName.mockResolvedValue(mockApp);

    const result = await handleTriggerDeployment({
      appName: 'payment-service',
      environment: 'qa-env',
      dockerImage: 'registry.example.com/payment-service:v1',
    });

    expect(result).toContain('❌');
    expect(result).toContain('qa-env');
    expect(mockDevtronService.triggerDeployment).not.toHaveBeenCalled();
  });

  it('returns warning when Devtron returns non-Triggered status', async () => {
    mockDevtronService.getAppByName.mockResolvedValue(mockApp);
    mockDevtronService.triggerDeployment.mockResolvedValue({
      workflowId: 0,
      status: 'Failed',
      message: 'Image not found in registry',
    });

    const result = await handleTriggerDeployment({
      appName: 'payment-service',
      environment: 'staging',
      dockerImage: 'registry.example.com/payment-service:bad-tag',
    });

    expect(result).toContain('⚠️');
    expect(result).toContain('Image not found in registry');
  });

  it('returns error string when Devtron is unreachable', async () => {
    mockDevtronService.getAppByName.mockRejectedValue(
      new DevtronApiError('Cannot reach Devtron', 503)
    );

    const result = await handleTriggerDeployment({
      appName: 'payment-service',
      environment: 'staging',
      dockerImage: 'registry.example.com/payment-service:v1',
    });

    expect(typeof result).toBe('string');
    expect(result).toContain('❌');
  });
});

// ── handleListAllApps ─────────────────────────────────────────────────────────

describe('handleListAllApps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns list of all apps with environments', async () => {
    mockDevtronService.getAllApps.mockResolvedValue([
      {
        id: 1,
        name: 'meraevents',
        environments: [{ id: 1, name: 'devtron-demo', pipelineId: 10 }],
      },
      {
        id: 2,
        name: 'labmate',
        environments: [{ id: 1, name: 'devtron-demo', pipelineId: 20 }],
      },
    ]);

    const result = await handleListAllApps({});

    expect(result).toContain('meraevents');
    expect(result).toContain('labmate');
    expect(result).toContain('devtron-demo');
    expect(result).toContain('2 total');
  });

  it('returns error when no apps found', async () => {
    mockDevtronService.getAllApps.mockResolvedValue([]);

    const result = await handleListAllApps({});

    expect(result).toContain('❌');
    expect(result).toContain('No apps found');
  });

  it('returns error string when service fails', async () => {
    mockDevtronService.getAllApps.mockRejectedValue(
      new DevtronApiError('Cannot reach Devtron', 503)
    );

    const result = await handleListAllApps({});

    expect(typeof result).toBe('string');
    expect(result).toContain('❌');
  });
});