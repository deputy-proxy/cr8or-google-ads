import type { McpServer } from '@modelcontextprotocol/server';
import { registerReadTools as register } from '../../tools.js';

export function registerReadTools(server: McpServer): void {
  register(server);
}
