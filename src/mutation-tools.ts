import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { applyMutation, previewMutation, validateMutation } from './mutations.js';
import type { AdGroupChange, KeywordChange, MutationTarget } from './mutations.js';

const statusChange = z.object({ status: z.enum(['ENABLED', 'PAUSED']) });

function json(data: unknown): string {
  return JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
}

export function registerMutationTools(server: McpServer): void {
  server.registerTool('validate_ad_group_change', {
    title: 'Validate an ad group change',
    description: 'Validate an ad group status change without modifying Google Ads.',
    inputSchema: z.object({ adGroupId: z.string().regex(/^\d+$/), change: statusChange }),
  }, async ({ adGroupId, change }) => ({
    content: [{ type: 'text', text: json(await validateMutation({ type: 'ad_group', id: adGroupId, change: change as AdGroupChange })) }],
  }));

  server.registerTool('preview_ad_group_change', {
    title: 'Preview an ad group change',
    description: 'Validate an ad group status change and return a short-lived confirmation token. This tool never modifies Google Ads.',
    inputSchema: z.object({ adGroupId: z.string().regex(/^\d+$/), change: statusChange }),
  }, async ({ adGroupId, change }) => ({
    content: [{ type: 'text', text: json(await previewMutation({ type: 'ad_group', id: adGroupId, change: change as AdGroupChange })) }],
  }));

  server.registerTool('apply_ad_group_change', {
    title: 'Apply a confirmed ad group change',
    description: 'Apply a previously previewed ad group status change using its short-lived confirmation token.',
    inputSchema: z.object({ confirmationToken: z.string().min(20) }),
  }, async ({ confirmationToken }) => ({
    content: [{ type: 'text', text: json(await applyMutation(confirmationToken)) }],
  }));

  server.registerTool('validate_keyword_change', {
    title: 'Validate a keyword change',
    description: 'Validate a keyword status change without modifying Google Ads.',
    inputSchema: z.object({ keywordId: z.string().regex(/^\d+$/), change: statusChange }),
  }, async ({ keywordId, change }) => ({
    content: [{ type: 'text', text: json(await validateMutation({ type: 'keyword', id: keywordId, change: change as KeywordChange })) }],
  }));

  server.registerTool('preview_keyword_change', {
    title: 'Preview a keyword change',
    description: 'Validate a keyword status change and return a short-lived confirmation token. This tool never modifies Google Ads.',
    inputSchema: z.object({ keywordId: z.string().regex(/^\d+$/), change: statusChange }),
  }, async ({ keywordId, change }) => ({
    content: [{ type: 'text', text: json(await previewMutation({ type: 'keyword', id: keywordId, change: change as KeywordChange })) }],
  }));

  server.registerTool('apply_keyword_change', {
    title: 'Apply a confirmed keyword change',
    description: 'Apply a previously previewed keyword status change using its short-lived confirmation token.',
    inputSchema: z.object({ confirmationToken: z.string().min(20) }),
  }, async ({ confirmationToken }) => ({
    content: [{ type: 'text', text: json(await applyMutation(confirmationToken)) }],
  }));
}
