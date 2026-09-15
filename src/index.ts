import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { registerReadTools } from './tools.js';

const port = Number(process.env.PORT ?? 3000);
const authToken = process.env.MCP_AUTH_TOKEN;

if (!authToken) {
  throw new Error('Missing required environment variable: MCP_AUTH_TOKEN');
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'cr8or-google-ads',
    version: '0.1.0',
  });

  registerReadTools(server);
  return server;
}

const mcpHandler = createMcpHandler(createMcpServer);
const nodeHandler = toNodeHandler(mcpHandler);

function isAuthorized(req: IncomingMessage): boolean {
  const authorization = req.headers.authorization;
  return authorization === `Bearer ${authToken}`;
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'cr8or-google-ads', version: '0.1.0' }));
    return;
  }

  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer',
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    await nodeHandler(req, res);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

httpServer.listen(port, '0.0.0.0', () => {
  console.error(`cr8or-google-ads listening on port ${port}`);
});
