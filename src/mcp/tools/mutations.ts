import type { McpServer } from '@modelcontextprotocol/server';
import { registerMutationTools as register } from '../../mutation-tools.js';

export function registerMutationTools(server: McpServer): void {
  register(server);
}
