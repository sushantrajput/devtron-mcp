// src/config/index.ts
// Loads and validates all environment variables at startup.
// If anything is missing the server crashes immediately with a clear message
// rather than failing silently mid-deployment.

import * as dotenv from 'dotenv';
import { z } from 'zod';

// Load .env file into process.env before reading anything
dotenv.config();

// --- Schema: describes what valid config looks like ---
// Zod v4: use { error: '...' } instead of { required_error: '...' }
const configSchema = z.object({
  devtron: z.object({
    // z.string() with a custom error message when the value is missing/undefined
    baseUrl: z
      .string({ error: 'DEVTRON_BASE_URL is required in your .env file' })
      .url('DEVTRON_BASE_URL must be a valid URL, e.g. https://devtron.mycompany.com'),

    apiToken: z
      .string({ error: 'DEVTRON_API_TOKEN is required in your .env file' })
      .min(1, 'DEVTRON_API_TOKEN cannot be an empty string'),

    // z.coerce.number() converts the string from process.env into a number
    timeoutMs: z.coerce.number().positive().default(30_000),
  }),

  server: z.object({
    name: z.string().default('devtron-mcp-server'),
    version: z.string().default('1.0.0'),
    // Only these exact values are allowed — typos caught at startup
    logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  }),
});

// --- Read raw values from process.env ---
const rawConfig = {
  devtron: {
    baseUrl: process.env['DEVTRON_BASE_URL'],
    apiToken: process.env['DEVTRON_API_TOKEN'],
    timeoutMs: process.env['DEVTRON_TIMEOUT_MS'],
  },
  server: {
    name: process.env['MCP_SERVER_NAME'],
    version: process.env['MCP_SERVER_VERSION'],
    logLevel: process.env['LOG_LEVEL'],
  },
};

// --- Validate and parse ---
// safeParse never throws — it returns { success, data } or { success, error }
const parseResult = configSchema.safeParse(rawConfig);

if (!parseResult.success) {
  // Format all validation issues into readable lines
  const issues = parseResult.error.issues
    .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  // Write to stderr directly — logger isn't set up yet at this point
  process.stderr.write(
    `\n❌ Server startup failed — fix your .env file:\n${issues}\n\n`
  );
  process.exit(1); // Non-zero exit = failure; Kubernetes/Docker will restart the pod
}

// Export the validated, fully-typed config
// All other files import from here — never read process.env directly elsewhere
export const config = parseResult.data;
export type Config = typeof config;