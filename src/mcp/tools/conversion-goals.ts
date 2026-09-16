import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { applyLeadFormGoalChange, previewLeadFormGoalChange, validateLeadFormGoalChange } from '../../phase-c.js';

const inputSchema = z.object({ campaignId: z.string().regex(/^\d+$/), biddable: z.boolean().default(false) });
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);

export function registerConversionGoalTools(server: McpServer): void {
  server.registerTool('validate_lead_form_goal_change', { title: 'Validate Google-hosted lead-form goal change', description: 'Validate the SUBMIT_LEAD_FORM + GOOGLE_HOSTED campaign goal. Defaults to disabling bidding and never modifies Google Ads.', inputSchema }, async ({ campaignId, biddable }) => ({ content: [{ type: 'text', text: json(await validateLeadFormGoalChange(campaignId, biddable)) }] }));
  server.registerTool('preview_lead_form_goal_change', { title: 'Preview Google-hosted lead-form goal change', description: 'Validate the Google-hosted lead-form campaign goal and return a short-lived confirmation token.', inputSchema }, async ({ campaignId, biddable }) => ({ content: [{ type: 'text', text: json(await previewLeadFormGoalChange(campaignId, biddable)) }] }));
  server.registerTool('apply_lead_form_goal_change', { title: 'Apply confirmed Google-hosted lead-form goal change', description: 'Apply a previously previewed lead-form campaign goal change after live state revalidation.', inputSchema: z.object({ confirmationToken: z.string().min(20) }) }, async ({ confirmationToken }) => { try { return { content: [{ type: 'text', text: json(await applyLeadFormGoalChange(confirmationToken)) }] }; } catch (error) { return { content: [{ type: 'text', text: json({ error: error instanceof Error ? error.message : String(error) }) }], isError: true }; } });
}
