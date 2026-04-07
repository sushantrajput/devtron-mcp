// src/index.ts
// IMPORTANT: The very first thing we do is intercept stdout.
// A VS Code dotenv extension writes "◇ injecting env..." to stdout
// which corrupts the MCP JSON protocol.
// We redirect ALL stdout writes to stderr before any imports run.

const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk: any, encoding?: any, callback?: any): boolean => {
  // Only allow through if it looks like JSON (starts with { or [)
  // Everything else (like "◇ injecting...") gets silently dropped
  const text = chunk.toString();
  if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
    return originalWrite(chunk, encoding, callback);
  }
  // Send non-JSON output to stderr so it doesn't corrupt MCP protocol
  process.stderr.write(chunk, encoding);
  if (callback) callback();
  return true;
};

import { createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('Devtron MCP Server is running and ready for connections');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start server: ${String(error)}\n`);
  process.exit(1);
});