import type { McpServer } from '@modelcontextprotocol/server';
import { registerPhaseDTools } from '../../phase-d.js';

export function registerCampaignRestructureTools(server: McpServer): void {
  registerPhaseDTools(server);
}
