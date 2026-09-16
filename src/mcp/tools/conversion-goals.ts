import type { McpServer } from '@modelcontextprotocol/server';
import { registerConversionGoalTools as register } from '../../phase-c.js';

export function registerConversionGoalTools(server: McpServer): void {
  register(server);
}
