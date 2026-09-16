import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { resolveCampaignById, resolveCampaignByName } from './campaign-resolution.js';
import { applyCampaignOptimizationForMcp, previewCampaignOptimizationForMcp } from './optimization-confirmation.js';
import { validateCampaignOptimization } from './optimization.js';
import { applyMutation, previewMutation, validateMutation } from './mutations.js';
import type { AdGroupChange, KeywordChange } from './mutations.js';

const statusChange = z.object({ status: z.enum(['ENABLED', 'PAUSED']) });
const keywordMatchType = z.enum(['EXACT', 'PHRASE', 'BROAD']);

const optimizationOperation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('campaign_status'), status: z.enum(['ENABLED', 'PAUSED']) }),
  z.object({ type: z.literal('campaign_budget'), dailyBudgetMicros: z.number().int().min(1_000_000).max(100_000_000_000) }),
  z.object({ type: z.literal('campaign_bidding'), strategy: z.enum(['MANUAL_CPC', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS']), targetCpaMicros: z.number().int().min(1_000_000).optional(), targetRoas: z.number().min(0.01).max(1000).optional() }),
  z.object({ type: z.literal('ad_group_status'), adGroupId: z.string().regex(/^\d+$/), status: z.enum(['ENABLED', 'PAUSED']) }),
  z.object({ type: z.literal('ad_group_bid'), adGroupId: z.string().regex(/^\d+$/), cpcBidMicros: z.number().int().min(0).optional(), targetCpaMicros: z.number().int().min(1_000_000).optional(), targetRoas: z.number().min(0.01).max(1000).optional() }),
  z.object({ type: z.literal('keyword_status'), keywordId: z.string().regex(/^\d+$/), adGroupId: z.string().regex(/^\d+$/), status: z.enum(['ENABLED', 'PAUSED']) }),
  z.object({ type: z.literal('keyword_remove'), keywordId: z.string().regex(/^\d+$/), adGroupId: z.string().regex(/^\d+$/) }),
  z.object({ type: z.literal('keyword_create'), adGroupId: z.string().regex(/^\d+$/), text: z.string().trim().min(1).max(80), matchType: keywordMatchType, status: z.enum(['ENABLED', 'PAUSED']).optional() }),
  z.object({ type: z.literal('negative_keyword_add'), adGroupId: z.string().regex(/^\d+$/).optional(), text: z.string().min(1).max(80), matchType: keywordMatchType }),
  z.object({ type: z.literal('negative_keyword_remove'), criterionId: z.string().regex(/^\d+$/), adGroupId: z.string().regex(/^\d+$/).optional() }),
  z.object({ type: z.literal('ad_status'), adId: z.string().regex(/^\d+$/), status: z.enum(['ENABLED', 'PAUSED']) }),
  z.object({ type: z.literal('ad_remove'), adId: z.string().regex(/^\d+$/) }),
  z.object({ type: z.literal('campaign_goal'), category: z.string().min(1), origin: z.string().min(1), biddable: z.boolean() }),
  z.object({ type: z.literal('campaign_goal_reset_to_customer') }),
  z.object({ type: z.literal('custom_conversion_goal'), name: z.string().min(1).max(255), conversionActionIds: z.array(z.string().regex(/^\d+$/)).min(1).max(50) }),
]);

const optimizationInput = z.object({ campaignName: z.string().min(1).optional(), campaignId: z.string().regex(/^\d+$/).optional(), operations: z.array(optimizationOperation).min(1).max(100) }).refine((value) => Boolean(value.campaignName) !== Boolean(value.campaignId), { message: 'Provide exactly one of campaignName or campaignId.', path: ['campaignName'] });

function json(data: unknown): string { return JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2); }
async function resolveOptimizationCampaign(campaignName?: string, campaignId?: string) {
  if (campaignName && campaignId) throw new Error('Provide campaignName or campaignId, not both.');
  if (!campaignName && !campaignId) throw new Error('Provide campaignName or campaignId.');
  return campaignName ? resolveCampaignByName(campaignName) : resolveCampaignById(campaignId as string);
}

export function registerMutationTools(server: McpServer): void {
  server.registerTool('validate_ad_group_change', { title: 'Validate an ad group change', description: 'Validate an ad group status change without modifying Google Ads.', inputSchema: z.object({ adGroupId: z.string().regex(/^\d+$/), change: statusChange }) }, async ({ adGroupId, change }) => ({ content: [{ type: 'text', text: json(await validateMutation({ type: 'ad_group', id: adGroupId, change: change as AdGroupChange })) }] }));
  server.registerTool('preview_ad_group_change', { title: 'Preview an ad group change', description: 'Validate an ad group status change and return a short-lived confirmation token. This tool never modifies Google Ads.', inputSchema: z.object({ adGroupId: z.string().regex(/^\d+$/), change: statusChange }) }, async ({ adGroupId, change }) => ({ content: [{ type: 'text', text: json(await previewMutation({ type: 'ad_group', id: adGroupId, change: change as AdGroupChange })) }] }));
  server.registerTool('apply_ad_group_change', { title: 'Apply a confirmed ad group change', description: 'Apply a previously previewed ad group status change using its short-lived confirmation token.', inputSchema: z.object({ confirmationToken: z.string().min(20) }) }, async ({ confirmationToken }) => ({ content: [{ type: 'text', text: json(await applyMutation(confirmationToken)) }] }));
  server.registerTool('validate_keyword_change', { title: 'Validate a keyword change', description: 'Validate a positive keyword status change without modifying Google Ads. adGroupId is required because Google Ads criterion IDs are only unique within an ad group.', inputSchema: z.object({ keywordId: z.string().regex(/^\d+$/), adGroupId: z.string().regex(/^\d+$/), change: statusChange }) }, async ({ keywordId, adGroupId, change }) => ({ content: [{ type: 'text', text: json(await validateMutation({ type: 'keyword', id: keywordId, adGroupId, change: change as KeywordChange })) }] }));
  server.registerTool('preview_keyword_change', { title: 'Preview a keyword change', description: 'Validate a positive keyword status change and return a short-lived confirmation token. adGroupId is required because Google Ads criterion IDs are only unique within an ad group.', inputSchema: z.object({ keywordId: z.string().regex(/^\d+$/), adGroupId: z.string().regex(/^\d+$/), change: statusChange }) }, async ({ keywordId, adGroupId, change }) => ({ content: [{ type: 'text', text: json(await previewMutation({ type: 'keyword', id: keywordId, adGroupId, change: change as KeywordChange })) }] }));
  server.registerTool('apply_keyword_change', { title: 'Apply a confirmed keyword change', description: 'Apply a previously previewed positive keyword status change using its short-lived confirmation token.', inputSchema: z.object({ confirmationToken: z.string().min(20) }) }, async ({ confirmationToken }) => ({ content: [{ type: 'text', text: json(await applyMutation(confirmationToken)) }] }));
  server.registerTool('validate_campaign_optimization', { title: 'Validate campaign optimization', description: 'Validate a batch of campaign optimization changes without modifying Google Ads. Prefer exact campaignName so the server resolves the live campaign resource itself. campaignId remains supported for compatibility.', inputSchema: optimizationInput }, async ({ campaignName, campaignId, operations }) => { const campaign = await resolveOptimizationCampaign(campaignName, campaignId); return { content: [{ type: 'text', text: json(await validateCampaignOptimization({ campaignId: campaign.id, operations })) }] }; });
  server.registerTool('preview_campaign_optimization', { title: 'Preview campaign optimization', description: 'Resolve the live campaign, validate the complete batch, and return an opaque short-lived confirmation token. No Google Ads changes are made.', inputSchema: optimizationInput }, async (input) => ({ content: [{ type: 'text', text: json(await previewCampaignOptimizationForMcp(input)) }] }));
  server.registerTool('apply_campaign_optimization', { title: 'Apply confirmed campaign optimization', description: 'Apply a previously previewed campaign optimization as one grouped Google Ads transaction. The server re-resolves and revalidates the campaign immediately before mutation.', inputSchema: z.object({ confirmationToken: z.string().min(20) }) }, async ({ confirmationToken }) => { try { return { content: [{ type: 'text', text: json(await applyCampaignOptimizationForMcp(confirmationToken)) }] }; } catch (error) { return { content: [{ type: 'text', text: json({ error: error instanceof Error ? error.message : String(error) }) }], isError: true }; } });
  server.registerTool('validate_keyword_create', { title: 'Validate a positive keyword creation', description: 'Validate creation of a positive keyword in an existing ad group without modifying Google Ads. Use this to add an exact, phrase, or broad keyword.', inputSchema: z.object({ adGroupId: z.string().regex(/^\d+$/), text: z.string().trim().min(1).max(80), matchType: keywordMatchType, status: z.enum(['ENABLED', 'PAUSED']).optional() }) }, async ({ adGroupId, text, matchType, status }) => ({ content: [{ type: 'text', text: json(await validateCampaignOptimization({ campaignId: (await resolveAdGroupCampaignId(adGroupId)), operations: [{ type: 'keyword_create', adGroupId, text, matchType, status }] })) }] }));
  server.registerTool('preview_keyword_create', { title: 'Preview a positive keyword creation', description: 'Validate creation of a positive keyword and return a short-lived confirmation token. This tool never modifies Google Ads.', inputSchema: z.object({ campaignId: z.string().regex(/^\d+$/), adGroupId: z.string().regex(/^\d+$/), text: z.string().trim().min(1).max(80), matchType: keywordMatchType, status: z.enum(['ENABLED', 'PAUSED']).optional() }), async ({ campaignId, adGroupId, text, matchType, status }) => ({ content: [{ type: 'text', text: json(await previewCampaignOptimization({ campaignId, operations: [{ type: 'keyword_create', adGroupId, text, matchType, status }] })) }] }));
  server.registerTool('apply_keyword_create', { title: 'Apply a confirmed positive keyword creation', description: 'Apply a previously previewed positive keyword creation using its short-lived confirmation token.', inputSchema: z.object({ confirmationToken: z.string().min(20) }) }, async ({ confirmationToken }) => ({ content: [{ type: 'text', text: json(await applyCampaignOptimization(confirmationToken)) }] }));
}

async function resolveAdGroupCampaignId(adGroupId: string): Promise<string> {
  const { getCustomer } = await import('./google-ads.js');
  const [row] = await getCustomer().query(`SELECT campaign.id FROM ad_group WHERE ad_group.id = ${adGroupId} LIMIT 1`);
  if (!row?.campaign?.id) throw new Error(`Ad group ${adGroupId} was not found or is not accessible.`);
  return String(row.campaign.id);
}
