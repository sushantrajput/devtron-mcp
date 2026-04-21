import http from 'node:http';
import { createServer } from './server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from './utils/logger.js';
import { config } from './config/index.js';

const PORT = Number(process.env.PORT ?? process.env.MCP_PORT ?? 3000);

async function main(): Promise<void> {
  const mcpServer = await createServer();
  
  // The crucial transport for GitLab Web UI (No SSE)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await mcpServer.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    console.log(`\n========================================`);
    console.log(`📡 [INCOMING REQUEST] ${req.method} ${req.url}`);
    console.log(`========================================\n`);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // The single stateless endpoint
    if (req.method === 'POST' && url.pathname === '/mcp') {
      
      // THE MAGIC BYPASS: Trick the MCP SDK into accepting the request
      req.headers['accept'] = 'application/json, text/event-stream';
      
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          console.log(`📦 [PAYLOAD]: ${body.substring(0, 200)}...`);
          const parsedBody = JSON.parse(body);
          await transport.handleRequest(req, res, parsedBody);
        } catch (err) {
          logger.error('Error handling request', { error: err });
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
          }
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  httpServer.listen(PORT, () => {
    logger.info(`Devtron Stateless HTTP Server listening on port ${PORT}`);
  });
}

main().catch(console.error);