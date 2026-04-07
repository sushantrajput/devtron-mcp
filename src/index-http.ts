// src/index-http.ts
// HTTP transport entry point for remote MCP clients (e.g. GitLab Duo).
//
// Exposes the same Devtron MCP server as index.ts but over HTTP instead of stdio.
// GitLab Duo cannot reach local stdio processes, so this server must be accessible
// at a public URL (e.g. via ngrok or deployed to a cloud host).
//
// Endpoint: POST /mcp  (MCP Streamable HTTP transport)
//
// Usage:
//   node dist/index-http.js              # listens on PORT env var (default 3000)
//   MCP_PORT=8080 node dist/index-http.js

import http from 'node:http';
import { createServer } from './server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from './utils/logger.js';
import { config } from './config/index.js';

const PORT = Number(process.env.MCP_PORT ?? 3000);

async function main(): Promise<void> {
  const mcpServer = await createServer();

  // Stateless mode: no session IDs, each request is independent.
  // This is the correct mode for GitLab Duo which does not maintain MCP sessions.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await mcpServer.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: config.server.name, version: config.server.version }));
      return;
    }

    // MCP endpoint — accept both GET (SSE) and POST (JSON-RPC)
    if (req.url === '/mcp') {
      if (req.method === 'POST') {
        // Parse body then delegate to MCP transport
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
          try {
            await transport.handleRequest(req, res, parsedBody);
          } catch (err) {
            logger.error('MCP request handling error', { error: err });
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal server error' }));
            }
          }
        });
        return;
      }

      if (req.method === 'GET') {
        // SSE stream for server-initiated messages
        try {
          await transport.handleRequest(req, res);
        } catch (err) {
          logger.error('MCP SSE error', { error: err });
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        }
        return;
      }

      if (req.method === 'DELETE') {
        try {
          await transport.handleRequest(req, res);
        } catch (err) {
          logger.error('MCP DELETE error', { error: err });
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        }
        return;
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use POST /mcp for MCP requests.' }));
  });

  httpServer.listen(PORT, () => {
    logger.info(`Devtron MCP HTTP Server listening on port ${PORT}`);
    logger.info(`MCP endpoint: http://localhost:${PORT}/mcp`);
    logger.info(`Health check: http://localhost:${PORT}/health`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    httpServer.close();
    await mcpServer.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start HTTP server: ${String(error)}\n`);
  process.exit(1);
});
