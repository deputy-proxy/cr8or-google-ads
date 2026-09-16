import { createHmac, timingSafeEqual } from 'node:crypto';
import { enums } from 'google-ads-api';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { getCustomer } from './google-ads.js';

const TTL = 10 * 60 * 1000;
type Move = { keywordId: string; sourceAdGroupId: string };
type LoadedMove = Move & { resourceName: string; text: string; matchType: string; status: string };
type Group = { name: string; status?: 'ENABLED' | 'PAUSED'; cpcBidMicros?: number; moves: Move[] };
type LoadedGroup = Omit<Group, 'moves'> & { moves: LoadedMove[] };
type Plan = { version: 1; kind: 'campaign_restructure'; customerId: string; campaignId: string; groups: LoadedGroup[]; expectedCampaignStatus: string; expectedGroups: Array<{ id: string; name: string; status: string }>; expiresAt: number };

const secret = () => {
  const value = process.env.MCP_AUTH_TOKEN;
  if (!value) throw new Error('Missing required environment variable: MCP_AUTH_TOKEN');
  return value;
};
const sign = (value: string) => createHmac('sha256', secret()).update(value).digest('base64url');
const encode = (plan: Plan) => {
  const payload = Buffer.from(JSON.stringify(plan)).toString('base64url');
  return `${payload}.${sign(payload)}`;
};
function decode(token: string): Plan {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new Error('Invalid confirmation token.');
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid confirmation token.');
  let plan: Plan;
  try {
    plan = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Plan;
  } catch {
    throw new Error('Invalid confirmation token.');
  }
  if (plan.version !== 1 || plan.kind !== 'campaign_restructure' || Date.now() > plan.expiresAt) throw new Error('Confirmation token has expired. Generate a new preview.');
  return plan;
}
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
function id(value: string, name: string): void {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric Google Ads ID.`);
}
function validateInput(campaignId: string, groups: Group[]): void {
  id(campaignId, 'campaignId');
  if (!groups.length || groups.length > 20) throw new Error('groups must contain 1-20 entries.');
  const names = new Set<string>();
  const moves = new Set<string>();
  let count = 0;
  for (const group of groups) {
    const name = group.name.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!name) throw new Error('Ad group name cannot be empty.');
    if (names.has(name)) throw new Error(`Duplicate destination ad group '${group.name.trim()}'.`);
    names.add(name);
    if (group.cpcBidMicros !== undefined && (!Number.isSafeInteger(group.cpcBidMicros) || group.cpcBidMicros < 0 || group.cpcBidMicros > 100_000_000_000)) throw new Error(`Invalid cpcBidMicros for '${group.name}'.`);
    for (const move of group.moves) {
      id(move.keywordId, 'keywordId');
      id(move.sourceAdGroupId, 'sourceAdGroupId');
      const key = `${move.sourceAdGroupId}:${move.keywordId}`;
      if (moves.has(key)) throw new Error(`Keyword ${move.keywordId} from ad group ${move.sourceAdGroupId} appears more than once.`);
      moves.add(key);
      count++;
      if (count > 200) throw new Error('A restructure cannot move more than 200 keywords.');
    }
  }
}
async function resolve(campaignId: string, groups: Group[]) {
  const customer = getCustomer();
  const [campaignRow] = await customer.query(`SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`);
  if (!campaignRow?.campaign?.resource_name) throw new Error(`Campaign ${campaignId} was not found or is not accessible.`);
  const existing = await customer.query(`SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.status != 'REMOVED'`);
  const existingNames = new Set(existing.map((row) => String(row?.ad_group?.name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()));
  const loadedGroups: LoadedGroup[] = [];
  for (const group of groups) {
    if (existingNames.has(group.name.trim().replace(/\s+/g, ' ').toLowerCase())) throw new Error(`Destination ad group '${group.name.trim()}' already exists.`);
    const loadedMoves: LoadedMove[] = [];
    for (const move of group.moves) {
      const [row] = await customer.query(`SELECT ad_group_criterion.resource_name, ad_group_criterion.status, keyword.text, keyword.match_type FROM ad_group_criterion WHERE campaign.id = ${campaignId} AND ad_group.id = ${move.sourceAdGroupId} AND ad_group_criterion.criterion_id = ${move.keywordId} AND ad_group_criterion.type = KEYWORD AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED' LIMIT 1`);
      if (!row?.ad_group_criterion?.resource_name || !row?.keyword?.text || !row?.keyword?.match_type) throw new Error(`Positive keyword ${move.keywordId} was not found in source ad group ${move.sourceAdGroupId}.`);
      loadedMoves.push({ ...move, resourceName: String(row.ad_group_criterion.resource_name), text: String(row.keyword.text), matchType: String(row.keyword.match_type), status: String(row.ad_group_criterion.status) });
    }
    loadedGroups.push({ ...group, moves: loadedMoves });
  }
  return { campaign: campaignRow.campaign, existing, groups: loadedGroups };
}
export async function validateCampaignRestructure(input: { campaignId: string; groups: Group[] }) {
  validateInput(input.campaignId, input.groups);
  const r = await resolve(input.campaignId, input.groups);
  const customerId = String(getCustomer().credentials.customer_id);
  return { valid: true as const, campaign: { id: r.campaign.id, name: r.campaign.name, status: r.campaign.status }, destinationAdGroups: r.groups.map((g, i) => ({ temporaryResourceName: `customers/${customerId}/adGroups/-${i + 1}`, name: g.name, status: g.status ?? 'ENABLED', moves: g.moves.map(({ keywordId, sourceAdGroupId, text, matchType, status }) => ({ keywordId, sourceAdGroupId, text, matchType, status })) })) };
}
export async function previewCampaignRestructure(input: { campaignId: string; groups: Group[] }) {
  validateInput(input.campaignId, input.groups);
  const r = await resolve(input.campaignId, input.groups);
  const expiresAt = Date.now() + TTL;
  const customerId = String(getCustomer().credentials.customer_id);
  const plan: Plan = { version: 1, kind: 'campaign_restructure', customerId, campaignId: input.campaignId, groups: r.groups, expectedCampaignStatus: String(r.campaign.status), expectedGroups: r.existing.map((row) => ({ id: String(row.ad_group.id), name: String(row.ad_group.name), status: String(row.ad_group.status) })), expiresAt };
  return { valid: true as const, campaign: { id: r.campaign.id, name: r.campaign.name, status: r.campaign.status }, destinationAdGroups: r.groups.map((g, i) => ({ temporaryResourceName: `customers/${plan.customerId}/adGroups/-${i + 1}`, name: g.name, moves: g.moves.map(({ keywordId, sourceAdGroupId, text, matchType, status }) => ({ keywordId, sourceAdGroupId, text, matchType, status })) })), expiresAt: new Date(expiresAt).toISOString(), confirmationToken: encode(plan) };
}
export async function applyCampaignRestructure(token: string) {
  const plan = decode(token);
  const inputGroups: Group[] = plan.groups.map((g) => ({ name: g.name, status: g.status, cpcBidMicros: g.cpcBidMicros, moves: g.moves.map(({ keywordId, sourceAdGroupId }) => ({ keywordId, sourceAdGroupId })) }));
  const r = await resolve(plan.campaignId, inputGroups);
  if (String(r.campaign.status) !== plan.expectedCampaignStatus) throw new Error('Campaign status changed since preview. Generate a new preview.');
  if (r.existing.length !== plan.expectedGroups.length || r.existing.some((row) => !plan.expectedGroups.some((expected) => expected.id === String(row.ad_group.id) && expected.name === String(row.ad_group.name) && expected.status === String(row.ad_group.status)))) throw new Error('Campaign ad-group structure changed since preview. Generate a new preview.');
  const customerId = String(getCustomer().credentials.customer_id);
  const operations: Record<string, unknown>[] = [];
  const destinations: string[] = [];
  plan.groups.forEach((group, index) => {
    const destination = `customers/${customerId}/adGroups/-${index + 1}`;
    destinations.push(destination);
    operations.push({ entity: 'ad_group', operation: 'create', resource: { resource_name: destination, campaign: `customers/${customerId}/campaigns/${plan.campaignId}`, name: group.name.trim(), status: group.status === 'PAUSED' ? enums.AdGroupStatus.PAUSED : enums.AdGroupStatus.ENABLED, ...(group.cpcBidMicros !== undefined ? { cpc_bid_micros: group.cpcBidMicros } : {}) } });
  });
  plan.groups.forEach((group, index) => {
    const destination = destinations[index];
    group.moves.forEach((move) => {
      operations.push({ entity: 'ad_group_criterion', operation: 'create', resource: { ad_group: destination, status: move.status === 'PAUSED' ? enums.AdGroupCriterionStatus.PAUSED : enums.AdGroupCriterionStatus.ENABLED, keyword: { text: move.text, match_type: move.matchType } } });
      operations.push({ entity: 'ad_group_criterion', operation: 'remove', resource: { resource_name: move.resourceName } });
    });
  });
  try {
    const result = await getCustomer().mutateResources(operations as never[], { partial_failure: false });
    return { applied: true as const, atomic: true as const, campaignId: plan.campaignId, createdAdGroups: destinations, movedKeywordCount: plan.groups.reduce((count, group) => count + group.moves.length, 0), result };
  } catch (error) {
    throw new Error(`Google Ads campaign restructure failed: ${json(error)}`);
  }
}
const groupInput = z.object({ name: z.string().trim().min(1).max(255), status: z.enum(['ENABLED', 'PAUSED']).optional(), cpcBidMicros: z.number().int().min(0).max(100_000_000_000).optional(), moves: z.array(z.object({ keywordId: z.string().regex(/^\d+$/), sourceAdGroupId: z.string().regex(/^\d+$/) })).max(200) });
const input = z.object({ campaignId: z.string().regex(/^\d+$/), groups: z.array(groupInput).min(1).max(20) });
export function registerPhaseDTools(server: McpServer): void {
  server.registerTool('validate_campaign_restructure', { title: 'Validate campaign restructure', description: 'Validate creation of intent-specific ad groups and positive keyword moves without modifying Google Ads.', inputSchema: input }, async (value) => ({ content: [{ type: 'text', text: json(await validateCampaignRestructure(value)) }] }));
  server.registerTool('preview_campaign_restructure', { title: 'Preview campaign restructure', description: 'Preview creation of intent-specific ad groups and positive keyword moves and return a short-lived confirmation token.', inputSchema: input }, async (value) => ({ content: [{ type: 'text', text: json(await previewCampaignRestructure(value)) }] }));
  server.registerTool('apply_campaign_restructure', { title: 'Apply confirmed campaign restructure', description: 'Apply a previously previewed restructure as one non-partial-failure Google Ads mutation request after live state revalidation.', inputSchema: z.object({ confirmationToken: z.string().min(20) }) }, async ({ confirmationToken }) => {
    try {
      return { content: [{ type: 'text', text: json(await applyCampaignRestructure(confirmationToken)) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: json({ error: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  });
}
