import { createHmac, timingSafeEqual } from 'node:crypto';
import { enums } from 'google-ads-api';
import { getCustomer, getCustomerFor } from './google-ads.js';

const PLAN_TTL_MS = 10 * 60 * 1000;
type MatchType = 'EXACT' | 'PHRASE' | 'BROAD';
type CriterionStatus = 'ENABLED' | 'PAUSED';
type OptimizationOperation =
  | { type: 'campaign_status'; status: 'ENABLED' | 'PAUSED' }
  | { type: 'campaign_budget'; dailyBudgetMicros: number }
  | { type: 'campaign_bidding'; strategy: 'MANUAL_CPC' | 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE' | 'TARGET_CPA' | 'TARGET_ROAS'; targetCpaMicros?: number; targetRoas?: number }
  | { type: 'ad_group_status'; adGroupId: string; status: CriterionStatus }
  | { type: 'ad_group_bid'; adGroupId: string; cpcBidMicros?: number; targetCpaMicros?: number; targetRoas?: number }
  | { type: 'keyword_status'; keywordId: string; status: CriterionStatus }
  | { type: 'keyword_remove'; keywordId: string }
  | { type: 'negative_keyword_add'; adGroupId?: string; text: string; matchType: MatchType }
  | { type: 'negative_keyword_remove'; criterionId: string; adGroupId?: string }
  | { type: 'ad_status'; adId: string; status: CriterionStatus }
  | { type: 'ad_remove'; adId: string }
  | { type: 'campaign_goal'; category: string; origin: string; biddable: boolean }
  | { type: 'campaign_goal_reset_to_customer' }
  | { type: 'custom_conversion_goal'; name: string; conversionActionIds: string[] };

export interface CampaignOptimization { campaignId: string; operations: OptimizationOperation[]; }
interface OptimizationPlan { version: 1; customerId: string; campaignId: string; operations: OptimizationOperation[]; expectedCampaignStatus: string; expectedBudgetMicros: string; expiresAt: number; }

function mutationSecret(): string { const secret = process.env.MCP_AUTH_TOKEN; if (!secret) throw new Error('Missing required environment variable: MCP_AUTH_TOKEN'); return secret; }
function sign(value: string): string { return createHmac('sha256', mutationSecret()).update(value).digest('base64url'); }
function encodePlan(plan: OptimizationPlan): string { const payload = Buffer.from(JSON.stringify(plan)).toString('base64url'); return `${payload}.${sign(payload)}`; }
function decodePlan(token: string): OptimizationPlan {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new Error('Invalid confirmation token.');
  const expected = Buffer.from(sign(payload)); const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid confirmation token.');
  let plan: OptimizationPlan;
  try { plan = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OptimizationPlan; } catch { throw new Error('Invalid confirmation token.'); }
  if (plan.version !== 1 || Date.now() > plan.expiresAt) throw new Error('Confirmation token has expired. Generate a new preview.');
  return plan;
}
function assertId(value: string, name: string): void { if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric Google Ads ID.`); }

function validateOperation(operation: OptimizationOperation): void {
  switch (operation.type) {
    case 'campaign_budget': if (!Number.isSafeInteger(operation.dailyBudgetMicros) || operation.dailyBudgetMicros < 1_000_000 || operation.dailyBudgetMicros > 100_000_000_000) throw new Error('dailyBudgetMicros must be a safe integer between 1000000 and 100000000000.'); break;
    case 'campaign_bidding':
      if ((operation.strategy === 'TARGET_CPA' || operation.strategy === 'MAXIMIZE_CONVERSIONS') && operation.targetCpaMicros !== undefined && (!Number.isSafeInteger(operation.targetCpaMicros) || operation.targetCpaMicros < 1_000_000)) throw new Error('targetCpaMicros must be a safe integer of at least 1000000.');
      if ((operation.strategy === 'TARGET_ROAS' || operation.strategy === 'MAXIMIZE_CONVERSION_VALUE') && operation.targetRoas !== undefined && (operation.targetRoas < 0.01 || operation.targetRoas > 1000)) throw new Error('targetRoas must be between 0.01 and 1000.');
      break;
    case 'ad_group_status': case 'ad_group_bid': assertId(operation.adGroupId, 'adGroupId'); break;
    case 'keyword_status': case 'keyword_remove': assertId(operation.keywordId, 'keywordId'); break;
    case 'negative_keyword_remove': assertId(operation.criterionId, 'criterionId'); if (operation.adGroupId) assertId(operation.adGroupId, 'adGroupId'); break;
    case 'negative_keyword_add': if (operation.adGroupId) assertId(operation.adGroupId, 'adGroupId'); if (!operation.text.trim()) throw new Error('Negative keyword text cannot be empty.'); break;
    case 'ad_status': case 'ad_remove': assertId(operation.adId, 'adId'); break;
    case 'campaign_goal': if (!operation.category || !operation.origin) throw new Error('Campaign goal category and origin are required.'); break;
    case 'custom_conversion_goal': if (!operation.name.trim()) throw new Error('Custom conversion goal name cannot be empty.'); if (!operation.conversionActionIds.length) throw new Error('At least one conversion action is required.'); operation.conversionActionIds.forEach((id) => assertId(id, 'conversionActionId')); break;
    default: break;
  }
}

async function loadCampaign(campaignId: string) {
  assertId(campaignId, 'campaignId');
  const [row] = await getCustomer().query(`SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type, campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`);
  if (!row?.campaign?.resource_name) throw new Error(`Campaign ${campaignId} was not found or is not accessible.`);
  return row;
}

async function validateResourceReferences(campaignId: string, operations: OptimizationOperation[]): Promise<void> {
  const customer = getCustomer();
  for (const operation of operations) {
    switch (operation.type) {
      case 'ad_group_status': case 'ad_group_bid': {
        const [row] = await customer.query(`SELECT ad_group.resource_name FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.id = ${operation.adGroupId} LIMIT 1`);
        if (!row?.ad_group?.resource_name) throw new Error(`Ad group ${operation.adGroupId} does not belong to campaign ${campaignId}.`); break;
      }
      case 'keyword_status': case 'keyword_remove': {
        const [row] = await customer.query(`SELECT ad_group_criterion.resource_name FROM keyword_view WHERE campaign.id = ${campaignId} AND ad_group_criterion.criterion_id = ${operation.keywordId} LIMIT 1`);
        if (!row?.ad_group_criterion?.resource_name) throw new Error(`Keyword ${operation.keywordId} does not belong to campaign ${campaignId}.`); break;
      }
      case 'negative_keyword_remove': {
        const campaignRows = await customer.query(`SELECT campaign_criterion.resource_name FROM campaign_criterion WHERE campaign.id = ${campaignId} AND campaign_criterion.criterion_id = ${operation.criterionId} AND campaign_criterion.negative = TRUE LIMIT 1`);
        if (!campaignRows[0]?.campaign_criterion?.resource_name && operation.adGroupId) {
          const [row] = await customer.query(`SELECT ad_group_criterion.resource_name FROM ad_group_criterion WHERE campaign.id = ${campaignId} AND ad_group.id = ${operation.adGroupId} AND ad_group_criterion.criterion_id = ${operation.criterionId} AND ad_group_criterion.negative = TRUE LIMIT 1`);
          if (!row?.ad_group_criterion?.resource_name) throw new Error(`Negative keyword ${operation.criterionId} was not found.`);
        } else if (!campaignRows[0]?.campaign_criterion?.resource_name) throw new Error(`Campaign negative keyword ${operation.criterionId} was not found.`);
        break;
      }
      case 'ad_status': case 'ad_remove': {
        const [row] = await customer.query(`SELECT ad_group_ad.resource_name FROM ad_group_ad WHERE campaign.id = ${campaignId} AND ad_group_ad.ad.id = ${operation.adId} LIMIT 1`);
        if (!row?.ad_group_ad?.resource_name) throw new Error(`Ad ${operation.adId} does not belong to campaign ${campaignId}.`); break;
      }
      case 'campaign_goal': {
        const [row] = await customer.query(`SELECT campaign_conversion_goal.resource_name FROM campaign_conversion_goal WHERE campaign.id = ${campaignId} AND campaign_conversion_goal.category = '${operation.category}' AND campaign_conversion_goal.origin = '${operation.origin}' LIMIT 1`);
        if (!row?.campaign_conversion_goal?.resource_name) throw new Error(`Campaign conversion goal ${operation.category}/${operation.origin} was not found.`); break;
      }
      case 'custom_conversion_goal': {
        const conversionCustomer = await conversionCustomerId();
        const rows = await getCustomerFor(conversionCustomer).query(`SELECT conversion_action.id FROM conversion_action WHERE conversion_action.id IN (${operation.conversionActionIds.join(',')})`);
        if (rows.length !== operation.conversionActionIds.length) throw new Error('One or more conversion actions are not accessible from the conversion customer.'); break;
      }
      default: break;
    }
  }
}

async function conversionCustomerId(): Promise<string> {
  const [row] = await getCustomer().query('SELECT customer.id, customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer LIMIT 1');
  const resourceName = row?.customer?.conversion_tracking_setting?.google_ads_conversion_customer;
  return typeof resourceName === 'string' && resourceName ? resourceName.split('/')[1] : getCustomer().credentials.customer_id;
}

export async function validateCampaignOptimization(input: CampaignOptimization) {
  if (!/^\d+$/.test(input.campaignId)) throw new Error('campaignId must be numeric.');
  if (input.operations.length === 0 || input.operations.length > 100) throw new Error('operations must contain between 1 and 100 changes.');
  input.operations.forEach(validateOperation);
  const campaign = await loadCampaign(input.campaignId);
  const campaignData = campaign.campaign;
  if (!campaignData) throw new Error('Campaign data is unavailable.');
  await validateResourceReferences(input.campaignId, input.operations);
  return { valid: true as const, campaign: { id: campaignData.id, name: campaignData.name, status: campaignData.status, biddingStrategyType: campaignData.bidding_strategy_type, dailyBudgetMicros: String(campaign.campaign_budget?.amount_micros ?? 0) }, operations: input.operations };
}
export async function previewCampaignOptimization(input: CampaignOptimization) {
  const validation = await validateCampaignOptimization(input); const expiresAt = Date.now() + PLAN_TTL_MS;
  const plan: OptimizationPlan = { version: 1, customerId: getCustomer().credentials.customer_id, campaignId: input.campaignId, operations: input.operations, expectedCampaignStatus: String(validation.campaign.status), expectedBudgetMicros: validation.campaign.dailyBudgetMicros, expiresAt };
  return { ...validation, expiresAt: new Date(expiresAt).toISOString(), confirmationToken: encodePlan(plan) };
}

function campaignBiddingResource(operation: Extract<OptimizationOperation, { type: 'campaign_bidding' }>) {
  switch (operation.strategy) {
    case 'MANUAL_CPC': return { manual_cpc: { enhanced_cpc_enabled: false } };
    case 'MAXIMIZE_CONVERSIONS': return { maximize_conversions: operation.targetCpaMicros === undefined ? {} : { target_cpa_micros: operation.targetCpaMicros } };
    case 'MAXIMIZE_CONVERSION_VALUE': return { maximize_conversion_value: operation.targetRoas === undefined ? {} : { target_roas: operation.targetRoas } };
    case 'TARGET_CPA': return { target_cpa: { target_cpa_micros: operation.targetCpaMicros } };
    case 'TARGET_ROAS': return { target_roas: { target_roas: operation.targetRoas } };
  }
}
async function mutate(operation: Record<string, unknown>) { return getCustomer().mutateResources([operation as never], { partial_failure: false }); }
async function keywordResource(campaignId: string, keywordId: string): Promise<string> { const [row] = await getCustomer().query(`SELECT ad_group_criterion.resource_name FROM keyword_view WHERE campaign.id = ${campaignId} AND ad_group_criterion.criterion_id = ${keywordId} LIMIT 1`); if (!row?.ad_group_criterion?.resource_name) throw new Error(`Keyword ${keywordId} was not found.`); return row.ad_group_criterion.resource_name; }
async function adResource(campaignId: string, adId: string): Promise<string> { const [row] = await getCustomer().query(`SELECT ad_group_ad.resource_name FROM ad_group_ad WHERE campaign.id = ${campaignId} AND ad_group_ad.ad.id = ${adId} LIMIT 1`); if (!row?.ad_group_ad?.resource_name) throw new Error(`Ad ${adId} was not found.`); return row.ad_group_ad.resource_name; }

async function applyOperation(campaignId: string, operation: OptimizationOperation): Promise<unknown> {
  const customer = getCustomer(); const customerId = customer.credentials.customer_id; const campaignResource = `customers/${customerId}/campaigns/${campaignId}`;
  switch (operation.type) {
    case 'campaign_status': return mutate({ entity: 'campaign', operation: 'update', resource: { resource_name: campaignResource, status: operation.status === 'ENABLED' ? enums.CampaignStatus.ENABLED : enums.CampaignStatus.PAUSED } });
    case 'campaign_budget': { const [row] = await customer.query(`SELECT campaign_budget.resource_name FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`); if (!row?.campaign_budget?.resource_name) throw new Error('Campaign budget resource is unavailable.'); return mutate({ entity: 'campaign_budget', operation: 'update', resource: { resource_name: row.campaign_budget.resource_name, amount_micros: operation.dailyBudgetMicros } }); }
    case 'campaign_bidding': return mutate({ entity: 'campaign', operation: 'update', resource: { resource_name: campaignResource, ...campaignBiddingResource(operation) } });
    case 'ad_group_status': return mutate({ entity: 'ad_group', operation: 'update', resource: { resource_name: `customers/${customerId}/adGroups/${operation.adGroupId}`, status: operation.status === 'ENABLED' ? enums.AdGroupStatus.ENABLED : enums.AdGroupStatus.PAUSED } });
    case 'ad_group_bid': return mutate({ entity: 'ad_group', operation: 'update', resource: { resource_name: `customers/${customerId}/adGroups/${operation.adGroupId}`, ...(operation.cpcBidMicros !== undefined ? { cpc_bid_micros: operation.cpcBidMicros } : {}), ...(operation.targetCpaMicros !== undefined ? { target_cpa_micros: operation.targetCpaMicros } : {}), ...(operation.targetRoas !== undefined ? { target_roas: operation.targetRoas } : {}) } });
    case 'keyword_status': return mutate({ entity: 'ad_group_criterion', operation: 'update', resource: { resource_name: await keywordResource(campaignId, operation.keywordId), status: operation.status === 'ENABLED' ? enums.AdGroupCriterionStatus.ENABLED : enums.AdGroupCriterionStatus.PAUSED } });
    case 'keyword_remove': return mutate({ entity: 'ad_group_criterion', operation: 'remove', resource: { resource_name: await keywordResource(campaignId, operation.keywordId) } });
    case 'negative_keyword_add': { const matchType = operation.matchType === 'EXACT' ? enums.KeywordMatchType.EXACT : operation.matchType === 'PHRASE' ? enums.KeywordMatchType.PHRASE : enums.KeywordMatchType.BROAD; if (operation.adGroupId) return mutate({ entity: 'ad_group_criterion', operation: 'create', resource: { ad_group: `customers/${customerId}/adGroups/${operation.adGroupId}`, negative: true, keyword: { text: operation.text.trim(), match_type: matchType }, status: enums.AdGroupCriterionStatus.ENABLED } }); return mutate({ entity: 'campaign_criterion', operation: 'create', resource: { campaign: campaignResource, negative: true, keyword: { text: operation.text.trim(), match_type: matchType }, status: enums.CampaignCriterionStatus.ENABLED } }); }
    case 'negative_keyword_remove': return mutate({ entity: operation.adGroupId ? 'ad_group_criterion' : 'campaign_criterion', operation: 'remove', resource: { resource_name: operation.adGroupId ? `customers/${customerId}/adGroupCriteria/${operation.adGroupId}~${operation.criterionId}` : `customers/${customerId}/campaignCriteria/${campaignId}~${operation.criterionId}` } });
    case 'ad_status': return mutate({ entity: 'ad_group_ad', operation: 'update', resource: { resource_name: await adResource(campaignId, operation.adId), status: operation.status === 'ENABLED' ? enums.AdGroupAdStatus.ENABLED : enums.AdGroupAdStatus.PAUSED } });
    case 'ad_remove': return mutate({ entity: 'ad_group_ad', operation: 'remove', resource: { resource_name: await adResource(campaignId, operation.adId) } });
    case 'campaign_goal': return mutate({ entity: 'campaign_conversion_goal', operation: 'update', resource: { resource_name: `customers/${customerId}/campaignConversionGoals/${campaignId}~${operation.category}~${operation.origin}`, biddable: operation.biddable } });
    case 'campaign_goal_reset_to_customer': return mutate({ entity: 'conversion_goal_campaign_config', operation: 'update', resource: { resource_name: `customers/${customerId}/conversionGoalCampaignConfigs/${campaignId}`, goal_config_level: enums.GoalConfigLevel.CUSTOMER } });
    case 'custom_conversion_goal': {
      const conversionCustomerId = await conversionCustomerId(); const conversionCustomer = getCustomerFor(conversionCustomerId);
      const created = await conversionCustomer.customConversionGoals.create([{ name: operation.name, conversion_actions: operation.conversionActionIds.map((id) => `customers/${conversionCustomerId}/conversionActions/${id}`) }]);
      const resourceName = created.results?.[0]?.resource_name;
      if (!resourceName) throw new Error('Google Ads did not return the created custom conversion goal resource name.');
      await mutate({ entity: 'conversion_goal_campaign_config', operation: 'update', resource: { resource_name: `customers/${customerId}/conversionGoalCampaignConfigs/${campaignId}`, custom_conversion_goal: resourceName } });
      const goals = await customer.query(`SELECT campaign_conversion_goal.resource_name FROM campaign_conversion_goal WHERE campaign.id = ${campaignId}`);
      const goalResources = goals.map((row) => row.campaign_conversion_goal?.resource_name).filter((name): name is string => Boolean(name));
      if (goalResources.length) await customer.mutateResources(goalResources.map((name) => ({ entity: 'campaign_conversion_goal', operation: 'update', resource: { resource_name: name, biddable: false } })) as never[], { partial_failure: false });
      return { created, resourceName };
    }
  }
}

export async function applyCampaignOptimization(confirmationToken: string) {
  const plan = decodePlan(confirmationToken); const campaign = await loadCampaign(plan.campaignId); const campaignData = campaign.campaign;
  if (!campaignData) throw new Error('Campaign data is unavailable.');
  if (String(campaignData.status) !== plan.expectedCampaignStatus || String(campaign.campaign_budget?.amount_micros ?? 0) !== plan.expectedBudgetMicros) throw new Error('Campaign state changed since the preview. Generate a new preview.');
  await validateResourceReferences(plan.campaignId, plan.operations);
  const results: Array<{ operation: OptimizationOperation; result: unknown }> = [];
  for (const operation of plan.operations) results.push({ operation, result: await applyOperation(plan.campaignId, operation) });
  return { applied: true, campaignId: plan.campaignId, operationCount: results.length, results };
}
