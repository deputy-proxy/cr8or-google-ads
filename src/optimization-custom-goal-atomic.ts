import { enums } from 'google-ads-api';
import { getCustomer, getCustomerFor } from './google-ads.js';
import type { CampaignOptimization } from './optimization.js';

type Operation = CampaignOptimization['operations'][number];

type Mutation = {
  entity: string;
  operation: 'create' | 'update' | 'remove';
  resource: Record<string, unknown>;
};

function asCustomGoal(operation: Operation): Extract<Operation, { type: 'custom_conversion_goal' }> {
  if (operation.type !== 'custom_conversion_goal') throw new Error('Internal error: expected custom conversion goal operation.');
  return operation;
}

async function conversionCustomerId(): Promise<string> {
  const [row] = await getCustomer().query('SELECT customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer LIMIT 1');
  const resourceName = row?.customer?.conversion_tracking_setting?.google_ads_conversion_customer;
  return typeof resourceName === 'string' && resourceName ? resourceName.split('/')[1] : getCustomer().credentials.customer_id;
}

async function createOrReuseCustomGoal(operation: Extract<Operation, { type: 'custom_conversion_goal' }>): Promise<{ resourceName: string; created: boolean; customerId: string }> {
  const customerId = await conversionCustomerId();
  const customer = getCustomerFor(customerId);
  const escapedName = operation.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const existing = await customer.query(`SELECT custom_conversion_goal.resource_name, custom_conversion_goal.conversion_actions FROM custom_conversion_goal WHERE custom_conversion_goal.name = '${escapedName}' AND custom_conversion_goal.status = ENABLED`);
  const wanted = [...operation.conversionActionIds].map((id) => `customers/${customerId}/conversionActions/${id}`).sort();
  for (const row of existing) {
    const resourceName = row?.custom_conversion_goal?.resource_name;
    const actions = [...(row?.custom_conversion_goal?.conversion_actions ?? [])].sort();
    if (typeof resourceName === 'string' && JSON.stringify(actions) === JSON.stringify(wanted)) {
      return { resourceName, created: false, customerId };
    }
  }

  const response = await customer.mutateResources([{
    entity: 'custom_conversion_goal',
    operation: 'create',
    resource: {
      name: operation.name,
      conversion_actions: wanted,
    },
  }] as never[], { partial_failure: false });
  const resourceName = (response as unknown as {
    mutate_operation_responses?: Array<{ custom_conversion_goal_result?: { resource_name?: string } }>;
  }).mutate_operation_responses?.[0]?.custom_conversion_goal_result?.resource_name;
  if (typeof resourceName !== 'string' || !resourceName) {
    throw new Error('Google Ads created the custom conversion goal but did not return its resource name.');
  }
  return { resourceName, created: true, customerId };
}

async function keywordResource(campaignId: string, keywordId: string): Promise<string> {
  const [row] = await getCustomer().query(`SELECT ad_group_criterion.resource_name FROM keyword_view WHERE campaign.id = ${campaignId} AND ad_group_criterion.criterion_id = ${keywordId} LIMIT 1`);
  const resourceName = row?.ad_group_criterion?.resource_name;
  if (typeof resourceName !== 'string' || !resourceName) throw new Error(`Keyword ${keywordId} was not found.`);
  return resourceName;
}

async function buildCampaignMutations(input: CampaignOptimization, customGoalResourceName: string): Promise<Mutation[]> {
  const customerId = getCustomer().credentials.customer_id;
  const campaignResource = `customers/${customerId}/campaigns/${input.campaignId}`;
  const mutations: Mutation[] = [];

  for (const operation of input.operations) {
    switch (operation.type) {
      case 'campaign_goal_reset_to_customer':
        mutations.push({
          entity: 'conversion_goal_campaign_config',
          operation: 'update',
          resource: {
            resource_name: `customers/${customerId}/conversionGoalCampaignConfigs/${input.campaignId}`,
            goal_config_level: enums.GoalConfigLevel.CUSTOMER,
          },
        });
        break;
      case 'custom_conversion_goal':
        mutations.push({
          entity: 'conversion_goal_campaign_config',
          operation: 'update',
          resource: {
            resource_name: `customers/${customerId}/conversionGoalCampaignConfigs/${input.campaignId}`,
            custom_conversion_goal: customGoalResourceName,
          },
        });
        break;
      case 'keyword_remove':
        mutations.push({ entity: 'ad_group_criterion', operation: 'remove', resource: { resource_name: await keywordResource(input.campaignId, operation.keywordId) } });
        break;
      default:
        throw new Error(`Custom conversion goal batches currently support campaign goal reset, custom conversion goal assignment, and keyword removal. Unsupported operation: ${operation.type}.`);
    }
  }

  void campaignResource;
  return mutations;
}

export async function applyCustomGoalOptimizationAtomically(input: CampaignOptimization): Promise<unknown> {
  const customGoalOperation = input.operations.find((operation) => operation.type === 'custom_conversion_goal');
  if (!customGoalOperation) throw new Error('Internal error: atomic custom goal apply requires a custom conversion goal operation.');

  const customGoal = await createOrReuseCustomGoal(asCustomGoal(customGoalOperation));
  try {
    const mutations = await buildCampaignMutations(input, customGoal.resourceName);
    if (mutations.length === 0) throw new Error('No campaign mutations were produced.');
    const result = await getCustomer().mutateResources(mutations as never[], { partial_failure: false });
    return {
      applied: true,
      campaignId: input.campaignId,
      operationCount: input.operations.length,
      atomic: true,
      customConversionGoal: customGoal.resourceName,
      result,
    };
  } catch (error) {
    if (customGoal.created) {
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
