import { createHmac, timingSafeEqual } from 'node:crypto';
import { enums } from 'google-ads-api';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { getCustomer } from './google-ads.js';

const TTL_MS = 10 * 60 * 1000;
const MAX_GROUPS = 20;
const MAX_MOVES = 200;
const MAX_HEADLINES = 15;
const MAX_DESCRIPTIONS = 4;
const HEADLINE_MAX = 30;
const DESCRIPTION_MAX = 90;
const PATH_MAX = 15;

type MatchType = 'EXACT' | 'PHRASE' | 'BROAD';
type Status = 'ENABLED' | 'PAUSED';
type LoadedMove = { resourceName: string; text: string; matchType: string; status: string };
type GroupSpec = {
  name: string;
  status?: Status;
  cpcBidMicros?: number;
  moves: Array<{ keywordId: string; sourceAdGroupId: string; __loaded?: LoadedMove }>;
  rsa?: { finalUrl: string; headlines: string[]; descriptions: string[]; path1?: string; path2?: string; status?: Status };
};
type Plan = { version: 1; kind: 'campaign_restructure'; customerId: string; campaignId: string; groups: GroupSpec[]; leadFormBiddable?: boolean; expectedCampaignStatus: string; expectedGroups: Array<{ id: string; name: string; status: string }>; expectedKeywords: Array<{ resourceName: string; status: string; sourceAdGroupId: string }>; expectedLeadGoalBiddable?: boolean; expiresAt: number };

const secret = () => { const value = process.env.MCP_AUTH_TOKEN; if (!value) throw new Error('Missing required environment variable: MCP_AUTH_TOKEN'); return value; };
const sign = (value: string) => createHmac('sha256', secret()).update(value).digest('base64url');
const encode = (plan: Plan) => { const payload = Buffer.from(JSON.stringify(plan)).toString('base64url'); return `${payload}.${sign(payload)}`; };
function decode(token: string): Plan { const [payload, signature] = token.split('.'); if (!payload || !signature) throw new Error('Invalid confirmation token.'); const expected = Buffer.from(sign(payload)); const actual = Buffer.from(signature); if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid confirmation token.'); let plan: Plan; try { plan = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Plan; } catch { throw new Error('Invalid confirmation token.'); } if (plan.version !== 1 || plan.kind !== 'campaign_restructure' || Date.now() > plan.expiresAt) throw new Error('Confirmation token has expired. Generate a new preview.'); return plan; }
const assertId = (value: string, name: string) => { if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric Google Ads ID.`); };
const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);

function validateSpec(campaignId: string, groups: GroupSpec[]): void {
  assertId(campaignId, 'campaignId');
  if (!groups.length || groups.length > MAX_GROUPS) throw new Error(`groups must contain between 1 and ${MAX_GROUPS} entries.`);
  const names = new Set<string>(); let moveCount = 0;
  for (const group of groups) {
    const normalized = normalize(group.name);
    if (!normalized || normalized.length > 255) throw new Error('Each ad group name must contain 1-255 non-whitespace characters.');
    if (names.has(normalized)) throw new Error(`Duplicate destination ad group '${group.name.trim()}'.`);
    names.add(normalized);
    if (group.cpcBidMicros !== undefined && (!Number.isSafeInteger(group.cpcBidMicros) || group.cpcBidMicros < 0 || group.cpcBidMicros > 100_000_000_000)) throw new Error(`Invalid cpcBidMicros for '${group.name}'.`);
    for (const move of group.moves) { assertId(move.keywordId, 'keywordId'); assertId(move.sourceAdGroupId, 'sourceAdGroupId'); moveCount++; }
    if (group.rsa) validateRsa(group.rsa);
  }
  if (moveCount > MAX_MOVES) throw new Error(`moves cannot exceed ${MAX_MOVES}.`);
}
function validateRsa(rsa: NonNullable<GroupSpec['rsa']>): void {
  let url: URL; try { url = new URL(rsa.finalUrl); } catch { throw new Error('RSA finalUrl must be an absolute URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RSA finalUrl must use http or https.');
  if (rsa.headlines.length < 3 || rsa.headlines.length > MAX_HEADLINES) throw new Error(`RSA headlines must contain 3-${MAX_HEADLINES} assets.`);
  if (rsa.descriptions.length < 2 || rsa.descriptions.length > MAX_DESCRIPTIONS) throw new Error(`RSA descriptions must contain 2-${MAX_DESCRIPTIONS} assets.`);
  if (rsa.headlines.some((text) => !text.trim() || text.length > HEADLINE_MAX)) throw new Error(`Each RSA headline must be non-empty and at most ${HEADLINE_MAX} characters.`);
  if (rsa.descriptions.some((text) => !text.trim() || text.length > DESCRIPTION_MAX)) throw new Error(`Each RSA description must be non-empty and at most ${DESCRIPTION_MAX} characters.`);
  if (rsa.path1 !== undefined && (!rsa.path1.trim() || rsa.path1.length > PATH_MAX)) throw new Error(`RSA path1 must be non-empty and at most ${PATH_MAX} characters.`);
  if (rsa.path2 !== undefined && (!rsa.path2.trim() || rsa.path2.length > PATH_MAX)) throw new Error(`RSA path2 must be non-empty and at most ${PATH_MAX} characters.`);
  if (rsa.path2 !== undefined && rsa.path1 === undefined) throw new Error('RSA path2 requires path1.');
}
async function loadCampaign(campaignId: string) { const [row] = await getCustomer().query(`SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`); if (!row?.campaign?.resource_name) throw new Error(`Campaign ${campaignId} was not found or is not accessible.`); return row.campaign; }

async function validateReferences(campaignId: string, groups: GroupSpec[], leadFormBiddable?: boolean) {
  const customer = getCustomer(); const campaign = await loadCampaign(campaignId);
  const existingGroups = await customer.query(`SELECT ad_group.id, ad_group.resource_name, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.status != 'REMOVED'`);
  const existingNames = new Set(existingGroups.map((row) => normalize(String(row?.ad_group?.name ?? '')))); const plannedNames = new Set<string>();
  for (const group of groups) { const name = normalize(group.name); if (existingNames.has(name)) throw new Error(`Destination ad group '${group.name.trim()}' already exists in campaign ${campaignId}.`); if (plannedNames.has(name)) throw new Error(`Destination ad group '${group.name.trim()}' is duplicated in the restructure.`); plannedNames.add(name); }
  const expectedKeywords: Plan['expectedKeywords'] = []; const seenSources = new Set<string>();
  for (const group of groups) for (const move of group.moves) {
    const sourceKey = `${move.sourceAdGroupId}:${move.keywordId}`; if (seenSources.has(sourceKey)) throw new Error(`Keyword ${move.keywordId} from ad group ${move.sourceAdGroupId} appears more than once.`); seenSources.add(sourceKey);
    const [row] = await customer.query(`SELECT ad_group_criterion.resource_name, ad_group_criterion.status, ad_group_criterion.criterion_id, ad_group_criterion.negative, ad_group_criterion.type, keyword.text, keyword.match_type FROM ad_group_criterion WHERE campaign.id = ${campaignId} AND ad_group.id = ${move.sourceAdGroupId} AND ad_group_criterion.criterion_id = ${move.keywordId} AND ad_group_criterion.type = KEYWORD AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED' LIMIT 1`);
    const criterion = row?.ad_group_criterion; if (!criterion?.resource_name) throw new Error(`Positive keyword ${move.keywordId} was not found in source ad group ${move.sourceAdGroupId}.`); if (!row?.keyword?.text || !row?.keyword?.match_type) throw new Error(`Keyword ${move.keywordId} has incomplete keyword data.`);
    const loaded: LoadedMove = { resourceName: String(criterion.resource_name), text: String(row.keyword.text), matchType: String(row.keyword.match_type), status: String(criterion.status) }; expectedKeywords.push({ resourceName: loaded.resourceName, status: loaded.status, sourceAdGroupId: move.sourceAdGroupId }); move.__loaded = loaded;
  }
  let leadGoal: { resourceName: string; biddable: boolean } | undefined;
  if (leadFormBiddable !== undefined) { const [row] = await customer.query(`SELECT campaign_conversion_goal.resource_name, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign.id = ${campaignId} AND campaign_conversion_goal.category = SUBMIT_LEAD_FORM AND campaign_conversion_goal.origin = GOOGLE_HOSTED LIMIT 1`); if (!row?.campaign_conversion_goal?.resource_name) throw new Error(`Google-hosted lead-form conversion goal was not found for campaign ${campaignId}.`); leadGoal = { resourceName: String(row.campaign_conversion_goal.resource_name), biddable: Boolean(row.campaign_conversion_goal.biddable) }; if (leadGoal.biddable === leadFormBiddable) throw new Error(`Google-hosted lead-form conversion goal is already ${leadFormBiddable ? 'enabled' : 'disabled'} for bidding.`); }
  return { campaign, existingGroups, expectedKeywords, leadGoal };
}
function loadedMove(move: GroupSpec['moves'][number]): LoadedMove { if (!move.__loaded) throw new Error(`Keyword ${move.keywordId} was not loaded during validation.`); return move.__loaded; }

export async function validateCampaignRestructure(input: { campaignId: string; groups: GroupSpec[]; leadFormBiddable?: boolean }) {
  validateSpec(input.campaignId, input.groups); const loaded = await validateReferences(input.campaignId, input.groups, input.leadFormBiddable); const customerId = getCustomer().credentials.customer_id;
  return { valid: true as const, campaign: { id: loaded.campaign.id, name: loaded.campaign.name, status: loaded.campaign.status }, destinationAdGroups: input.groups.map((group, index) => ({ temporaryResourceName: `customers/${customerId}/adGroups/-${index + 1}`, name: group.name.trim(), status: group.status ?? 'ENABLED', moves: group.moves.map((move) => { const data = loadedMove(move); return { keywordId: move.keywordId, sourceAdGroupId: move.sourceAdGroupId, text: data.text, matchType: data.matchType, status: data.status }; }), rsa: group.rsa ? { ...group.rsa, status: group.rsa.status ?? 'ENABLED' } : undefined })), leadFormGoal: loaded.leadGoal ? { resourceName: loaded.leadGoal.resourceName, currentBiddable: loaded.leadGoal.biddable, requestedBiddable: input.leadFormBiddable } : undefined };
}
export async function previewCampaignRestructure(input: { campaignId: string; groups: GroupSpec[]; leadFormBiddable?: boolean }) {
  const validation = await validateCampaignRestructure(input); const expiresAt = Date.now() + TTL_MS; const loaded = await validateReferences(input.campaignId, input.groups, input.leadFormBiddable);
  const plan: Plan = { version: 1, kind: 'campaign_restructure', customerId: getCustomer().credentials.customer_id, campaignId: input.campaignId, groups: input.groups, leadFormBiddable: input.leadFormBiddable, expectedCampaignStatus: String(loaded.campaign.status), expectedGroups: loaded.existingGroups.map((row) => ({ id: String(row.ad_group.id), name: String(row.ad_group.name), status: String(row.ad_group.status) })), expectedKeywords: loaded.expectedKeywords, expectedLeadGoalBiddable: loaded.leadGoal?.biddable, expiresAt };
  return { ...validation, expiresAt: new Date(expiresAt).toISOString(), confirmationToken: encode(plan) };
}
export async function applyCampaignRestructure(token: string) {
  const plan = decode(token); const current = await validateReferences(plan.campaignId, plan.groups, plan.leadFormBiddable);
  if (String(current.campaign.status) !== plan.expectedCampaignStatus) throw new Error('Campaign status changed since the preview. Generate a new preview.');
  if (current.existingGroups.length !== plan.expectedGroups.length || current.existingGroups.some((row) => !plan.expectedGroups.some((expected) => expected.id === String(row.ad_group.id) && expected.name === String(row.ad_group.name) && expected.status === String(row.ad_group.status)))) throw new Error('Campaign ad-group structure changed since the preview. Generate a new preview.');
  if (current.expectedKeywords.length !== plan.expectedKeywords.length || current.expectedKeywords.some((keyword) => !plan.expectedKeywords.some((expected) => expected.resourceName === keyword.resourceName && expected.status === keyword.status && expected.sourceAdGroupId === keyword.sourceAdGroupId))) throw new Error('One or more source keywords changed since the preview. Generate a new preview.');
  if (plan.leadFormBiddable !== undefined && current.leadGoal?.biddable !== plan.expectedLeadGoalBiddable) throw new Error('The lead-form conversion goal changed since the preview. Generate a new preview.');
  const customerId = getCustomer().credentials.customer_id; const operations: Record<string, unknown>[] = []; const destinationResources: string[] = [];
  for (let index = 0; index < plan.groups.length; index++) { const group = plan.groups[index]; const destination = `customers/${customerId}/adGroups/-${index + 1}`; destinationResources.push(destination); operations.push({ entity: 'ad_group', operation: 'create', resource: { resource_name: destination, campaign: `customers/${customerId}/campaigns/${plan.campaignId}`, name: group.name.trim(), status: group.status === 'PAUSED' ? enums.AdGroupStatus.PAUSED : enums.AdGroupStatus.ENABLED, ...(group.cpcBidMicros !== undefined ? { cpc_bid_micros: group.cpcBidMicros } : {}) } }); }
  for (let index = 0; index < plan.groups.length; index++) { const group = plan.groups[index]; const destination = destinationResources[index]; for (const move of group.moves) { const data = loadedMove(move); operations.push({ entity: 'ad_group_criterion', operation: 'create', resource: { ad_group: destination, status: data.status === 'PAUSED' ? enums.AdGroupCriterionStatus.PAUSED : enums.AdGroupCriterionStatus.ENABLED, keyword: { text: data.text, match_type: data.matchType } } }); operations.push({ entity: 'ad_group_criterion', operation: 'remove', resource: { resource_name: data.resourceName } }); } if (group.rsa) { const rsa = { headlines: group.rsa.headlines.map((text) => ({ text: text.trim() })), descriptions: group.rsa.descriptions.map((text) => ({ text: text.trim() })), ...(group.rsa.path1 !== undefined ? { path1: group.rsa.path1.trim() } : {}), ...(group.rsa.path2 !== undefined ? { path2: group.rsa.path2.trim() } : {}) }; operations.push({ entity: 'ad_group_ad', operation: 'create', resource: { ad_group: destination, status: group.rsa.status === 'PAUSED' ? enums.AdGroupAdStatus.PAUSED : enums.AdGroupAdStatus.ENABLED, ad: { final_urls: [group.rsa.finalUrl], responsive_search_ad: rsa } } }); } }
  if (plan.leadFormBiddable !== undefined && current.leadGoal) operations.push({ entity: 'campaign_conversion_goal', operation: 'update', resource: { resource_name: current.leadGoal.resourceName, biddable: plan.leadFormBiddable } });
  try { const result = await getCustomer().mutateResources(operations as never[], { partial_failure: false }); return { applied: true, atomic: true, campaignId: plan.campaignId, createdAdGroups: destinationResources, movedKeywords: plan.groups.flatMap((group) => group.moves.map((move) => ({ keywordId: move.keywordId, sourceAdGroupId: move.sourceAdGroupId, destinationAdGroup: group.name.trim() }))), createdRsaCount: plan.groups.filter((group) => group.rsa).length, leadFormBiddable: plan.leadFormBiddable, result }; } catch (error) { throw new Error(`Google Ads campaign restructure failed: ${json(error)}`); }
}
const groupInput = z.object({ name: z.string().trim().min(1).max(255), status: z.enum(['ENABLED', 'PAUSED']).optional(), cpcBidMicros: z.number().int().min(0).max(100_000_000_000).optional(), moves: z.array(z.object({ keywordId: z.string().regex(/^\d+$/), sourceAdGroupId: z.string().regex(/^\d+$/) })).max(MAX_MOVES), rsa: z.object({ finalUrl: z.string().url(), headlines: z.array(z.string().trim().min(1).max(HEADLINE_MAX)).min(3).max(MAX_HEADLINES), descriptions: z.array(z.string().trim().min(1).max(DESCRIPTION_MAX)).min(2).max(MAX_DESCRIPTIONS), path1: z.string().trim().min(1).max(PATH_MAX).optional(), path2: z.string().trim().min(1).max(PATH_MAX).optional(), status: z.enum(['ENABLED', 'PAUSED']).optional() }).refine((value) => value.path2 === undefined || value.path1 !== undefined, { message: 'path2 requires path1.', path: ['path2'] }).optional() });
const input = z.object({ campaignId: z.string().regex(/^\d+$/), groups: z.array(groupInput).min(1).max(MAX_GROUPS), leadFormBiddable: z.boolean().optional() });
export function registerPhaseDTools(server: McpServer): void {
  server.registerTool('validate_campaign_restructure', { title: 'Validate campaign restructure', description: 'Validate creation of intent-specific ad groups, positive keyword moves, optional RSAs, and optional Google-hosted lead-form goal changes. No Google Ads changes are made.', inputSchema: input }, async (value) => ({ content: [{ type: 'text', text: json(await validateCampaignRestructure(value)) }] }));
  server.registerTool('preview_campaign_restructure', { title: 'Preview campaign restructure', description: 'Validate a complete intent-based campaign restructure and return a short-lived confirmation token. The preview captures source keyword state and existing ad-group structure.', inputSchema: input }, async (value) => ({ content: [{ type: 'text', text: json(await previewCampaignRestructure(value)) }] }));
  server.registerTool('apply_campaign_restructure', { title: 'Apply confirmed campaign restructure', description: 'Apply a previously previewed campaign restructure as one non-partial-failure Google Ads mutation request. New ad groups, positive keyword copies/removals, RSAs, and optional lead-form goal changes are submitted together after live state revalidation.', inputSchema: z.object({ confirmationToken: z.string().min(20) }) }, async ({ confirmationToken }) => { try { return { content: [{ type: 'text', text: json(await applyCampaignRestructure(confirmationToken)) }] }; } catch (error) { return { content: [{ type: 'text', text: json({ error: error instanceof Error ? error.message : String(error) }) }], isError: true }; } });
}
