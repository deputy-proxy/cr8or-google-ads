import { getCustomer } from './google-ads.js';

export interface ResolvedCampaign {
  id: string;
  name: string;
  resourceName: string;
  status: string;
  budgetResourceName: string;
  budgetMicros: string;
}

function escapeGaqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function resolveCampaignByName(name: string): Promise<ResolvedCampaign> {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('campaignName cannot be empty.');

  const rows = await getCustomer().query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.resource_name,
      campaign.status,
      campaign_budget.resource_name,
      campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.name = '${escapeGaqlString(normalizedName)}'
      AND campaign.status != 'REMOVED'
  `);

  if (rows.length === 0) throw new Error(`Campaign '${normalizedName}' was not found or is not accessible.`);
  if (rows.length > 1) throw new Error(`Campaign name '${normalizedName}' is not unique in the authenticated customer. Use campaignId to disambiguate.`);

  const campaign = rows[0]?.campaign;
  const budget = rows[0]?.campaign_budget;
  if (!campaign?.resource_name || campaign.id === undefined || campaign.name === undefined) {
    throw new Error(`Campaign '${normalizedName}' returned incomplete resource data.`);
  }

  return {
    id: String(campaign.id),
    name: String(campaign.name),
    resourceName: String(campaign.resource_name),
    status: String(campaign.status),
    budgetResourceName: String(budget?.resource_name ?? ''),
    budgetMicros: String(budget?.amount_micros ?? 0),
  };
}

export async function resolveCampaignById(id: string): Promise<ResolvedCampaign> {
  if (!/^\d+$/.test(id)) throw new Error('campaignId must be numeric.');
  const [row] = await getCustomer().query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.resource_name,
      campaign.status,
      campaign_budget.resource_name,
      campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.id = ${id}
      AND campaign.status != 'REMOVED'
    LIMIT 1
  `);

  const campaign = row?.campaign;
  const budget = row?.campaign_budget;
  if (!campaign?.resource_name) throw new Error(`Campaign ${id} was not found or is not accessible.`);

  return {
    id: String(campaign.id),
    name: String(campaign.name),
    resourceName: String(campaign.resource_name),
    status: String(campaign.status),
    budgetResourceName: String(budget?.resource_name ?? ''),
    budgetMicros: String(budget?.amount_micros ?? 0),
  };
}
