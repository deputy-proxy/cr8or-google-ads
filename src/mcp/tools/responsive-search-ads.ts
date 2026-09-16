import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { applyRsaCreate, previewRsaCreate, validateRsaCreate } from '../../phase-c.js';

const HEADLINE_MAX = 30, DESCRIPTION_MAX = 90, PATH_MAX = 15, MAX_HEADLINES = 15, MAX_DESCRIPTIONS = 4;
const inputSchema = z.object({ campaignId: z.string().regex(/^\d+$/), adGroupId: z.string().regex(/^\d+$/), finalUrl: z.string().url(), headlines: z.array(z.string().trim().min(1).max(HEADLINE_MAX)).min(3).max(MAX_HEADLINES), descriptions: z.array(z.string().trim().min(1).max(DESCRIPTION_MAX)).min(2).max(MAX_DESCRIPTIONS), path1: z.string().trim().min(1).max(PATH_MAX).optional(), path2: z.string().trim().min(1).max(PATH_MAX).optional(), status: z.enum(['ENABLED', 'PAUSED']).default('ENABLED') }).refine((value) => value.path2 === undefined || value.path1 !== undefined, { message: 'path2 requires path1.', path: ['path2'] });
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);

export function registerResponsiveSearchAdTools(server: McpServer): void {
  server.registerTool('validate_rsa_create', { title: 'Validate responsive search ad creation', description: 'Validate an intent-specific responsive search ad for an existing campaign ad group without modifying Google Ads.', inputSchema }, async (input) => ({ content: [{ type: 'text', text: json(await validateRsaCreate(input)) }] }));
  server.registerTool('preview_rsa_create', { title: 'Preview responsive search ad creation', description: 'Validate an intent-specific responsive search ad and return a short-lived confirmation token.', inputSchema }, async (input) => ({ content: [{ type: 'text', text: json(await previewRsaCreate(input)) }] }));
  server.registerTool('apply_rsa_create', { title: 'Apply confirmed responsive search ad creation', description: 'Create a previously previewed responsive search ad after revalidating the destination ad group and duplicate state.', inputSchema: z.object({ confirmationToken: z.string().min(20) }) }, async ({ confirmationToken }) => { try { return { content: [{ type: 'text', text: json(await applyRsaCreate(confirmationToken)) }] }; } catch (error) { return { content: [{ type: 'text', text: json({ error: error instanceof Error ? error.message : String(error) }) }], isError: true }; } });
}
