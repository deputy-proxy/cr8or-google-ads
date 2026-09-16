import { McpServer } from '@modelcontextprotocol/server';
import { registerReadTools } from './tools/read.js';
import { registerMutationTools } from './tools/mutations.js';
import { registerConversionGoalTools } from './tools/conversion-goals.js';
import { registerResponsiveSearchAdTools } from './tools/responsive-search-ads.js';
import { registerCampaignRestructureTools } from './tools/campaign-restructure.js';
import { registerCampaignAuditTools } from './tools/campaign-audit.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'cr8or-google-ads', version: '0.1.0' });

  registerReadTools(server);
  registerMutationTools(server);
  registerConversionGoalTools(server);
  registerResponsiveSearchAdTools(server);
  registerCampaignRestructureTools(server);
  registerCampaignAuditTools(server);

  return server;
}
