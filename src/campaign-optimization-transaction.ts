import { enums } from 'google-ads-api';
import { getCustomer, getCustomerFor } from './google-ads.js';
import type { CampaignOptimization } from './optimization.js';
import type { ResolvedCampaign } from './campaign-resolution.js';

type Operation = CampaignOptimization['operations'][number];
type Mutation = Record<string, unknown>;

function update(resource: Record<string, unknown>, paths: string[]): Mutation {
  return {
    entity: resourceEntity(resource),
    operation: 'update',
    resource,
    update_mask: { paths },
  };
}

function resourceEntity(resource: Record<string, unknown>): string {
  const resourceName = String(resource.resource_name ?? '');
  if (resourceName.includes('/campaignConversionGoals/')) return 'campaign_conversion_goal';
  if (resourceName.includes('/conversionGoalCampaignConfigs/')) return 'conversion_goal_campaign_config';
  if (resourceName.includes('/campaignBudgets/')) return 'campaign_budget';
  if (resourceName.includes('/campaigns/')) return 'campaign';
  if (resourceName.includes('/adGroups/')) return 'ad_group';
  if (resourceName.includes('/adGroupCriteria/')) return 'ad_group_criterion';
  if (resourceName.includes('/campaignCriteria/')) return 'campaign_criterion';
  if (resourceName.includes('/adGroupAds/')) return 'ad_group_ad';
  throw new Error(`Unable to determine Google Ads resource type for ${resourceName}.`);
}

function escapeGaqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function conversionCustomerId(): Promise<string> {
  const [row] = await getCustomer().query('SELECT customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer LIMIT 1');
  const resourceName = row?.customer?.conversion_tracking_setting?.google_ads_conversion_customer;
  return typeof resourceName === 'string' && resourceName ? resourceName.split('/')[1] : getCustomer().credentials.customer_id;
}

async function ensureCustomConversionGoal(operation: Extract<Operation, { type: 'custom_conversion_goal' }>): Promise<{ resourceName: string; created: boolean; customerId: string }> {
  const customerId = await conversionCustomerId();
  const customer = getCustomerFor(customerId);
  const wanted = operation.conversionActionIds.map((id) => `customers/${customerId}/conversionActions/${id}`).sort();
  const escapedName = escapeGaqlString(operation.name.trim());
  const existing = await customer.query(`SELECT custom_conversion_goal.resource_name, custom_conversion_goal.conversion_actions FROM custom_conversion_goal WHERE custom_conversion_goal.name = '${escapedName}' AND custom_conversion_goal.status = ENABLED`);

  for (const row of existing) {
    const resourceName = row?.custom_conversion_goal?.resource_name;
    const actions = [...(row?.custom_conversion_goal?.conversion_actions ?? [])].sort();
    if (typeof resourceName === 'string' && JSON.stringify(actions) === JSON.stringify(wanted)) {
      return { resourceName, created: false, customerId };
    }
  }

  await customer.mutateResources([{
    entity: 'custom_conversion_goal',
    operation: 'create',
    resource: { name: operation.name.trim(), conversion_actions: wanted },
  }] as never[], { partial_failure: false });

  const createdRows = await customer.query(`SELECT custom_conversion_goal.resource_name, custom_conversion_goal.conversion_actions FROM custom_conversion_goal WHERE custom_conversion_goal.name = '${escapedName}' AND custom_conversion_goal.status = ENABLED`);
  for (const row of createdRows) {
    const resourceName = row?.custom_conversion_goal?.resource_name;
    const actions = [...(row?.custom_conversion_goal?.conversion_actions ?? [])].sort();
    if (typeof resourceName === 'string' && JSON.stringify(actions) === JSON.stringify(wanted)) {
      return { resourceName, created: true, customerId };
    }
  }

  throw new Error('Google Ads created the custom conversion goal but it could not be resolved afterwards.');
}

function bidding(operation: Extract<Operation, { type: 'campaign_bidding' }>): { resource: Record<string, unknown>; paths: string[] } {
  switch (operation.strategy) {
    case 'MANUAL_CPC': return { resource: { manual_cpc: { enhanced_cpc_enabled: false } }, paths: ['manual_cpc.enhanced_cpc_enabled'] };
    case 'MAXIMIZE_CONVERSIONS': return operation.targetCpaMicros === undefined
      ? { resource: { maximize_conversions: {} }, paths: ['maximize_conversions'] }
      : { resource: { maximize_conversions: { target_cpa_micros: operation.targetCpaMicros } }, paths: ['maximize_conversions.target_cpa_micros'] };
    case 'MAXIMIZE_CONVERSION_VALUE': return operation.targetRoas === undefined
      ? { resource: { maximize_conversion_value: {} }, paths: ['maximize_conversion_value'] }
      : { resource: { maximize_conversion_value: { target_roas: operation.targetRoas } }, paths: ['maximize_conversion_value.target_roas'] };
    case 'TARGET_CPA': return { resource: { target_cpa: { target_cpa_micros: operation.targetCpaMicros } }, paths: ['target_cpa.target_cpa_micros'] };
    case 'TARGET_ROAS': return { resource: { target_roas: { target_roas: operation.targetRoas } }, paths: ['target_roas.target_roas'] };
  }
}

async function keywordResource(campaignId: string, keywordId: string, adGroupId: string): Promise<string> {
  const [row] = await getCustomer().query(`SELECT ad_group_criterion.resource_name FROM ad_group_criterion WHERE campaign.id = ${campaignId} AND ad_group.id = ${adGroupId} AND ad_group_criterion.criterion_id = ${keywordId} AND ad_group_criterion.type = KEYWORD AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED' LIMIT 1`);
  const resourceName = row?.ad_group_criterion?.resource_name;
  if (typeof resourceName !== 'string' || !resourceName) throw new Error(`Positive keyword ${keywordId} was not found in ad group ${adGroupId}.`);
  return resourceName;
}

async function adResource(campaignId: string, adId: string): Promise<string> {
  const [row] = await getCustomer().query(`SELECT ad_group_ad.resource_name FROM ad_group_ad WHERE campaign.id = ${campaignId} AND ad_group_ad.ad.id = ${adId} LIMIT 1`);
  const resourceName = row?.ad_group_ad?.resource_name;
  if (typeof resourceName !== 'string' || !resourceName) throw new Error(`Ad ${adId} was not found.`);
  return resourceName;
}

export async function applyCampaignOptimizationTransaction(input: CampaignOptimization, campaign: ResolvedCampaign): Promise<unknown> {
  const customer = getCustomer();
  const customerId = customer.credentials.customer_id;
  const mutations: Mutation[] = [];
  let customGoal: { resourceName: string; created: boolean; customerId: string } | undefined;

  const customGoalOperation = input.operations.find((operation): operation is Extract<Operation, { type: 'custom_conversion_goal' }> => operation.type === 'custom_conversion_goal');
  if (customGoalOperation) customGoal = await ensureCustomConversionGoal(customGoalOperation);

  try {
    for (const operation of input.operations) {
      switch (operation.type) {
        case 'campaign_status':
          mutations.push(update({ resource_name: campaign.resourceName, status: operation.status === 'ENABLED' ? enums.CampaignStatus.ENABLED : enums.CampaignStatus.PAUSED }, ['status']));
          break;
        case 'campaign_budget':
          if (!campaign.budgetResourceName) throw new Error('Campaign budget resource is unavailable.');
          mutations.push(update({ resource_name: campaign.budgetResourceName, amount_micros: operation.dailyBudgetMicros }, ['amount_micros']));
          break;
        case 'campaign_bidding': {
          const value = bidding(operation);
          mutations.push(update({ resource_name: campaign.resourceName, ...value.resource }, value.paths));
          break;
        }
        case 'ad_group_create':
          mutations.push({
            entity: 'ad_group',
            operation: 'create',
            resource: {
              name: operation.name.trim(),
              campaign: campaign.resourceName,
              type: enums.AdGroupType.SEARCH_STANDARD,
              status: operation.status === 'PAUSED' ? enums.AdGroupStatus.PAUSED : enums.AdGroupStatus.ENABLED,
              ...(operation.cpcBidMicros !== undefined ? { cpc_bid_micros: operation.cpcBidMicros } : {}),
            },
          });
          break;
        case 'ad_group_status':
          mutations.push(update({ resource_name: `customers/${customerId}/adGroups/${operation.adGroupId}`, status: operation.status === 'ENABLED' ? enums.AdGroupStatus.ENABLED : enums.AdGroupStatus.PAUSED }, ['status']));
          break;
        case 'ad_group_bid': {
          const resource: Record<string, unknown> = { resource_name: `customers/${customerId}/adGroups/${operation.adGroupId}` };
          const paths: string[] = [];
          if (operation.cpcBidMicros !== undefined) { resource.cpc_bid_micros = operation.cpcBidMicros; paths.push('cpc_bid_micros'); }
          if (operation.targetCpaMicros !== undefined) { resource.target_cpa_micros = operation.targetCpaMicros; paths.push('target_cpa_micros'); }
          if (operation.targetRoas !== undefined) { resource.target_roas = operation.targetRoas; paths.push('target_roas'); }
          if (!paths.length) throw new Error(`Ad group ${operation.adGroupId} bid operation has no fields to update.`);
          mutations.push(update(resource, paths));
          break;
        }
        case 'keyword_status':
          mutations.push(update({ resource_name: await keywordResource(campaign.id, operation.keywordId, operation.adGroupId), status: operation.status === 'ENABLED' ? enums.AdGroupCriterionStatus.ENABLED : enums.AdGroupCriterionStatus.PAUSED }, ['status']));
          break;
        case 'keyword_remove':
          mutations.push({ entity: 'ad_group_criterion', operation: 'remove', resource: { resource_name: await keywordResource(campaign.id, operation.keywordId, operation.adGroupId) } });
          break;
        case 'negative_keyword_add': {
          const matchType = operation.matchType === 'EXACT' ? enums.KeywordMatchType.EXACT : operation.matchType === 'PHRASE' ? enums.KeywordMatchType.PHRASE : enums.KeywordMatchType.BROAD;
          if (operation.adGroupId) {
            mutations.push({ entity: 'ad_group_criterion', operation: 'create', resource: { ad_group: `customers/${customerId}/adGroups/${operation.adGroupId}`, negative: true, keyword: { text: operation.text.trim(), match_type: matchType }, status: enums.AdGroupCriterionStatus.ENABLED }});
          } else {
            mutations.push({ entity: 'campaign_criterion', operation: 'create', resource: { campaign: campaign.resourceName, negative: true, keyword: { text: operation.text.trim(), match_type: matchType }, status: enums.CampaignCriterionStatus.ENABLED }});
          }
          break;
        }
        case 'negative_keyword_remove':
          mutations.push({ entity: operation.adGroupId ? 'ad_group_criterion' : 'campaign_criterion', operation: 'remove', resource: { resource_name: operation.adGroupId ? `customers/${customerId}/adGroupCriteria/${operation.adGroupId}~${operation.criterionId}` : `customers/${customerId}/campaignCriteria/${campaign.id}~${operation.criterionId}` } });
          break;
        case 'ad_status':
          mutations.push(update({ resource_name: await adResource(campaign.id, operation.adId), status: operation.status === 'ENABLED' ? enums.AdGroupAdStatus.ENABLED : enums.AdGroupAdStatus.PAUSED }, ['status']));
          break;
        case 'ad_remove':
          mutations.push({ entity: 'ad_group_ad', operation: 'remove', resource: { resource_name: await adResource(campaign.id, operation.adId) } });
          break;
        case 'campaign_goal':
          mutations.push(update({ resource_name: `customers/${customerId}/campaignConversionGoals/${campaign.id}~${operation.category}~${operation.origin}`, biddable: operation.biddable }, ['biddable']));
          break;
        case 'campaign_goal_reset_to_customer':
          if (!customGoalOperation) mutations.push(update({ resource_name: `customers/${customerId}/conversionGoalCampaignConfigs/${campaign.id}`, goal_config_level: enums.GoalConfigLevel.CUSTOMER }, ['goal_config_level']));
          break;
        case 'custom_conversion_goal':
          if (!customGoal) throw new Error('Custom conversion goal was not prepared.');
          mutations.push(update({ resource_name: `customers/${customerId}/conversionGoalCampaignConfigs/${campaign.id}`, custom_conversion_goal: customGoal.resourceName }, ['custom_conversion_goal']));
          break;
      }
    }

    if (!mutations.length) throw new Error('No campaign mutations were produced.');
    const result = await customer.mutateResources(mutations as never[], { partial_failure: false });
    return { applied: true, atomic: true, campaignId: campaign.id, campaignName: campaign.name, operationCount: input.operations.length, result };
  } catch (error) {
    if (customGoal?.created) {
      try {
        await getCustomerFor(customGoal.customerId).mutateResources([{
          entity: 'custom_conversion_goal',
          operation: 'remove',
          resource: { resource_name: customGoal.resourceName },
        }] as never[], { partial_failure: false });
      } catch (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`Campaign optimization failed and rollback of the newly created custom conversion goal also failed: ${rollbackMessage}`);
      }
    }
    throw error;
  }
}
