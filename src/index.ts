import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { registerReadTools } from './tools.js';
import { registerMutationTools } from './mutation-tools.js';
import { handleOAuthAuthorize, handleOAuthCallback, handleOAuthToken, oauthMetadata, protectedResourceMetadata, verifyOAuthAccessToken } from './oauth.js';

const port = Number(process.env.PORT ?? 3000);
const authToken = process.env.MCP_AUTH_TOKEN;
const issuer = process.env.OAUTH_ISSUER ?? 'https://cr8or-google-ads-production.up.railway.app';

if (!authToken) throw new Error('Missing required environment variable: MCP_AUTH_TOKEN');

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'cr8or-google-ads', version: '0.1.0' });
  registerReadTools(server);
  registerMutationTools(server);
  return server;
}

const mcpHandler = createMcpHandler(createMcpServer);
const nodeHandler = toNodeHandler(mcpHandler);

async function isAuthorized(req: IncomingMessage): Promise<boolean> {
  const authorization = req.headers.authorization;
  if (authorization === `Bearer ${authToken}`) return true;
  if (!authorization?.startsWith('Bearer ')) return false;
  try {
    await verifyOAuthAccessToken(authorization.slice('Bearer '.length));
    return true;
  } catch {
    return false;
  }
}

function jsonResponse(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function redirectResponse(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', issuer);

  if (url.pathname === '/health' && req.method === 'GET') {
    jsonResponse(res, 200, { status: 'ok', service: 'cr8or-google-ads', version: '0.1.0' });
    return;
  }
  if (url.pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
    jsonResponse(res, 200, protectedResourceMetadata());
    return;
  }
  if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
    jsonResponse(res, 200, oauthMetadata());
    return;
  }
  if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
    try { redirectResponse(res, (await handleOAuthAuthorize(url)).location); }
    catch (error) { jsonResponse(res, 400, { error: error instanceof Error ? error.message : 'Invalid authorization request' }); }
    return;
  }
  if (url.pathname === '/oauth/callback' && req.method === 'GET') {
    try { redirectResponse(res, (await handleOAuthCallback(url)).location); }
    catch (error) { jsonResponse(res, 400, { error: error instanceof Error ? error.message : 'OAuth callback failed' }); }
    return;
  }
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const request = new Request(`${issuer}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      const result = await handleOAuthToken(request);
      res.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      res.end(await result.text());
    } catch (error) { jsonResponse(res, 400, { error: error instanceof Error ? error.message : 'OAuth token request failed' }); }
    return;
  }

  if (url.pathname !== '/mcp' && url.pathname !== '/mcp/') {
    jsonResponse(res, 404, { error: 'Not found' });
    return;
  }
  if (!(await isAuthorized(req))) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try { await nodeHandler(req, res); }
  catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) jsonResponse(res, 500, { error: 'Internal server error' });
  }
});

httpServer.listen(port, '0.0.0.0', () => console.error(`cr8or-google-ads listening on port ${port}`));

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
