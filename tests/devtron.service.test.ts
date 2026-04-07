import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAxiosInstance } = vi.hoisted(() => ({
  mockAxiosInstance: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  },
}));

vi.mock('axios', () => ({
  default: { create: vi.fn(() => mockAxiosInstance) },
}));

vi.mock('../src/config/index.js', () => ({
  config: {
    devtron: {
      baseUrl: 'https://devtron-test.example.com',
      apiToken: 'test-token',
      timeoutMs: 5000,
    },
    server: { name: 'test', version: '1.0.0', logLevel: 'error' },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DevtronService } from '../src/services/devtron.service.js';
import { DevtronApiError } from '../src/utils/errors.js';

describe('DevtronService', () => {
  let service: DevtronService;

  beforeEach(() => {
    service = new DevtronService();
    vi.clearAllMocks();
  });

  describe('resolveAppEnv', () => {
    it('throws DevtronApiError when app is not found in autocomplete', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: { result: [] } })           // app autocomplete → empty
        .mockResolvedValueOnce({ data: { result: [] } });          // env autocomplete → empty
      await expect(service.resolveAppEnv('ghost-app', 'prod')).rejects.toThrow(DevtronApiError);
    });

    it('throws DevtronApiError when env is not found in autocomplete', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: { result: [{ id: 1, name: 'my-app' }] } })   // app found
        .mockResolvedValueOnce({ data: { result: [] } });                            // env not found
      await expect(service.resolveAppEnv('my-app', 'ghost-env')).rejects.toThrow(DevtronApiError);
    });

    it('resolves app+env context when both are found', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: { result: [{ id: 2, name: 'labmate' }] } })
        .mockResolvedValueOnce({ data: { result: [{ id: 1, environment_name: 'devtron-demo', cluster_id: 1, cluster_name: 'default', namespace: 'devtron-demo' }] } })
        .mockResolvedValueOnce({ data: { result: { cdPipelineId: 20, environmentId: 1, environmentName: 'devtron-demo' } } });

      const ctx = await service.resolveAppEnv('labmate', 'devtron-demo');
      expect(ctx.appId).toBe(2);
      expect(ctx.envId).toBe(1);
      expect(ctx.pipelineId).toBe(20);
    });
  });

  describe('triggerDeployment', () => {
    it('returns triggered status on success', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          result: { workflowId: 9999, status: 'Triggered', message: 'ok' },
        },
      });

      const result = await service.triggerDeployment({
        appId: 42,
        pipelineId: 101,
        dockerImage: 'registry.example.com/app:v2.0.0',
        cdWorkflowType: 'CD',
      });

      expect(result.status).toBe('Triggered');
      expect(result.workflowId).toBe(9999);
    });
  });

  describe('rollbackDeployment', () => {
    it('returns success on rollback', async () => {
      mockAxiosInstance.put.mockResolvedValue({
        data: { result: { success: true, message: 'Rolled back' } },
      });

      const result = await service.rollbackDeployment({
        appId: 42,
        pipelineId: 101,
        deploymentId: 500,
      });

      expect(result.success).toBe(true);
    });
  });
});
