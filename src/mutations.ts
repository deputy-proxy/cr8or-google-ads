import { createHmac, timingSafeEqual } from 'node:crypto';
import { getCustomer } from './google-ads.js';
import { enums } from 'google-ads-api';

export type CampaignChange =
  | { status: 'ENABLED' | 'PAUSED'; dailyBudgetMicros?: never }
  | { dailyBudgetMicros: number; status?: never };

interface CampaignSnapshot {
  campaign: {
    resource_name: string;
    id?: string | number;
    name?: string;
    status?: string;
  };
  campaign_budget: {
    resource_name: string;
    amount_micros?: string | number;
  };
}

interface MutationPlan {
  version: 1;
  customerId: string;
  campaignId: string;
  campaignResourceName: string;
  campaignBudgetResourceName: string;
  action: CampaignChange;
  expected: {
    campaignStatus?: string;
    budgetMicros?: string;
  };
  expiresAt: number;
}

const PLAN_TTL_MS = 10 * 60 * 1000;
const MIN_DAILY_BUDGET_MICROS = 1_000_000;
const MAX_DAILY_BUDGET_MICROS = 100_000_000_000;

function mutationSecret(): string {
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!secret) throw new Error('Missing required environment variable: MCP_AUTH_TOKEN');
  return secret;
}

function sign(value: string): string {
  return createHmac('sha256', mutationSecret()).update(value).digest('base64url');
}

function encodePlan(plan: MutationPlan): string {
  const payload = Buffer.from(JSON.stringify(plan)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function decodePlan(token: string): MutationPlan {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new Error('Invalid confirmation token.');

  const expectedSignature = sign(payload);
  const actual = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Invalid confirmation token.');
  }

  let plan: MutationPlan;
  try {
    plan = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as MutationPlan;
  } catch {
    throw new Error('Invalid confirmation token.');
  }

  if (plan.version !== 1 || !plan.expiresAt || Date.now() > plan.expiresAt) {
    throw new Error('Confirmation token has expired. Generate a new preview.');
  }

  return plan;
}

function validateChange(change: CampaignChange): void {
  const hasStatus = 'status' in change && change.status !== undefined;
  const hasBudget = 'dailyBudgetMicros' in change && change.dailyBudgetMicros !== undefined;

  if (hasStatus === hasBudget) {
    throw new Error('Provide exactly one change: status or dailyBudgetMicros.');
  }

  if (hasBudget) {
    const amount = change.dailyBudgetMicros;
    if (!Number.isSafeInteger(amount)) throw new Error('dailyBudgetMicros must be a safe integer.');
    if (amount < MIN_DAILY_BUDGET_MICROS || amount > MAX_DAILY_BUDGET_MICROS) {
      throw new Error(`dailyBudgetMicros must be between ${MIN_DAILY_BUDGET_MICROS} and ${MAX_DAILY_BUDGET_MICROS}.`);
    }
  }
}

async function loadCampaign(campaignId: string): Promise<CampaignSnapshot> {
  const customer = getCustomer();
  const rows = await customer.query(`
    SELECT
      campaign.resource_name,
      campaign.id,
      campaign.name,
      campaign.status,
      campaign_budget.resource_name,
      campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.id = ${campaignId}
    LIMIT 1
  `) as CampaignSnapshot[];

  if (!rows[0]?.campaign?.resource_name || !rows[0]?.campaign_budget?.resource_name) {
    throw new Error(`Campaign ${campaignId} was not found or has no accessible budget.`);
  }

  return rows[0];
}

export async function validateCampaignChange(campaignId: string, change: CampaignChange) {
  validateChange(change);
  const current = await loadCampaign(campaignId);

  if ('status' in change && change.status === current.campaign.status) {
    throw new Error(`Campaign is already ${change.status}.`);
  }

  const currentBudget = Number(current.campaign_budget.amount_micros ?? 0);
  if ('dailyBudgetMicros' in change && change.dailyBudgetMicros === currentBudget) {
    throw new Error('Campaign budget is already set to that amount.');
  }

  return {
    campaignId,
    campaignResourceName: current.campaign.resource_name,
    campaignBudgetResourceName: current.campaign_budget.resource_name,
    current: {
      name: current.campaign.name,
      status: current.campaign.status,
      dailyBudgetMicros: currentBudget,
    },
    requested: change,
    valid: true as const,
  };
}

export async function previewCampaignChange(campaignId: string, change: CampaignChange) {
  const validation = await validateCampaignChange(campaignId, change);
  const current = await loadCampaign(campaignId);
  const expiresAt = Date.now() + PLAN_TTL_MS;

  const plan: MutationPlan = {
    version: 1,
    customerId: getCustomer().credentials.customer_id,
    campaignId,
    campaignResourceName: validation.campaignResourceName,
    campaignBudgetResourceName: validation.campaignBudgetResourceName,
    action: change,
    expected: {
      campaignStatus: current.campaign.status,
      budgetMicros: String(current.campaign_budget.amount_micros ?? 0),
    },
    expiresAt,
  };

  return {
    ...validation,
    expiresAt: new Date(expiresAt).toISOString(),
    confirmationToken: encodePlan(plan),
  };
}

export async function applyCampaignChange(confirmationToken: string) {
  const plan = decodePlan(confirmationToken);
  const current = await loadCampaign(plan.campaignId);

  if (current.campaign.resource_name !== plan.campaignResourceName ||
      current.campaign_budget.resource_name !== plan.campaignBudgetResourceName) {
    throw new Error('Campaign resources changed since the preview. Generate a new preview.');
  }

  if (String(current.campaign.status) !== String(plan.expected.campaignStatus) ||
      String(current.campaign_budget.amount_micros ?? 0) !== String(plan.expected.budgetMicros ?? 0)) {
    throw new Error('Campaign state changed since the preview. Generate a new preview.');
  }

  validateChange(plan.action);
  const customer = getCustomer();

  if ('status' in plan.action) {
    const status = plan.action.status === 'ENABLED'
      ? enums.CampaignStatus.ENABLED
      : enums.CampaignStatus.PAUSED;
    const result = await customer.campaigns.update([{
      resource_name: plan.campaignResourceName,
      status,
    }]);
    return {
      applied: true,
      action: plan.action,
      resourceName: plan.campaignResourceName,
      result,
    };
  }

  const result = await customer.campaignBudgets.update([{
    resource_name: plan.campaignBudgetResourceName,
    amount_micros: plan.action.dailyBudgetMicros,
  }]);

  return {
    applied: true,
    action: plan.action,
    resourceName: plan.campaignBudgetResourceName,
    result,
  };
}
