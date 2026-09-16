import type { McpServer } from '@modelcontextprotocol/server';
import { registerAuditTools } from '../../audit-tools.js';

export function registerCampaignAuditTools(server: McpServer): void {
  registerAuditTools(server);
}
