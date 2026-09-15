import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { applyCampaignOptimization, previewCampaignOptimization, validateCampaignOptimization } from './optimization.js';
import { applyMutation, previewMutation, validateMutation } from './mutations.js';
import type { AdGroupChange, KeywordChange } from './mutations.js';

const statusChange = z.object({ status: z.enum(['ENABLED', 'PAUSED']) });

const optimizationOperation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('campaign_status'), status: z.enum(['ENABLED', 'PAUSED']) }),
  z.object({ type: z.literal('campaign_budget'), dailyBudgetMicros: z.number().int().min(1_000_000).max(100_000_000_000) }),
  z.object({
    type: z.literal('campaign_bidding'),
    strategy: z.enum(['MANUAL_CPC', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS']),
    targetCpaMicros: z.number().int().min(1_000_000).optional(),
    targetRoas: z.number().min(0.01).max(1000).optional(),
  }),
  z.object({ type: z.literal('ad_group_status'), adGroupId: z.string().regex(/^\d+$/), status: z.enum(['ENABLED', 'PAUSED']) }),
  z.object({
    type: z.literal('ad_group_bid'),
    adGroupId: z.string().regex(/^\d+$/),
    cpcBidMicros: z.number().int().min(0).optional(),
    targetCpaMicros: z.number().int().min(1_000_000).optional(),
    targetRoas: z.number().min(0.01).max(1000).optional(),
  }),
  z.object({ type: z.literal('keyword_status'), keywordId: z.string().regex(/^\d+$/), status: z.enum(['ENABLED', 'PAUSED']) }),
  z.object({ type: z.literal('keyword_remove'), keywordId: z.string().regex(/^\d+$/) }),
  z.object({
    type: z.literal('negative_keyword_add'),
    adGroupId: z.string().regex(/^\d+$/).optional(),
    text: z.string().min(1).max(80),
    matchType: z.enum(['EXACT', 'PHRASE', 'BROAD']),
  }),
  z.object({ type: z.literal('negative_keyword_remove'), criterionId: z.string().regex(/^\d+$/), adGroupId: z.string().regex(/^\d+$/).optional() }),
  z.object({ type: z.literal('ad_status'), adId: z.string().regex(/^\d+$/), status: z.enum(['ENABLED', 'PAUSED']) }),
  z.object({ type: z.literal('ad_remove'), adId: z.string().regex(/^\d+$/) }),
  z.object({ type: z.literal('campaign_goal'), category: z.string().min(1), origin: z.string().min(1), biddable: z.boolean() }),
  z.object({ type: z.literal('campaign_goal_reset_to_customer') }),
  z.object({ type: z.literal('custom_conversion_goal'), name: z.string().min(1).max(255), conversionActionIds: z.array(z.string().regex(/^\d+$/)).min(1).max(50) }),
]);

const optimizationInput = z.object({
  campaignId: z.string().regex(/^\d+$/),
  operations: z.array(optimizationOperation).min(1).max(100),
});

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

  server.registerTool('validate_campaign_optimization', {
    title: 'Validate campaign optimization',
    description: 'Validate a batch of campaign optimization changes without modifying Google Ads. Supports campaign budget and bidding, ad groups, keywords, negative keywords, ads, and conversion goals.',
    inputSchema: optimizationInput,
  }, async (input) => ({
    content: [{ type: 'text', text: json(await validateCampaignOptimization(input)) }],
  }));

  server.registerTool('preview_campaign_optimization', {
    title: 'Preview campaign optimization',
    description: 'Validate a batch of campaign optimization changes and return a short-lived confirmation token. No Google Ads changes are made.',
    inputSchema: optimizationInput,
  }, async (input) => ({
    content: [{ type: 'text', text: json(await previewCampaignOptimization(input)) }],
  }));

  server.registerTool('apply_campaign_optimization', {
    title: 'Apply confirmed campaign optimization',
    description: 'Apply a previously previewed batch of campaign optimization changes. The operation refuses to proceed if the campaign state changed after preview.',
    inputSchema: z.object({ confirmationToken: z.string().min(20) }),
  }, async ({ confirmationToken }) => {
    try {
      return { content: [{ type: 'text', text: json(await applyCampaignOptimization(confirmationToken)) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: json({ error: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  });
}
