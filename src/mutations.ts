import { createHmac, timingSafeEqual } from 'node:crypto';
import { getCustomer } from './google-ads.js';
import { enums } from 'google-ads-api';

export type CampaignChange =
  | { status: 'ENABLED' | 'PAUSED'; dailyBudgetMicros?: never };

export type AdGroupChange =
  | { status: 'ENABLED' | 'PAUSED' };

export type KeywordChange =
  | { status: 'ENABLED' | 'PAUSED' };

export type MutationTarget =
  | { type: 'campaign'; id: string; change: CampaignChange }
  | { type: 'ad_group'; id: string; change: AdGroupChange }
  | { type: 'keyword'; id: string; change: KeywordChange };

interface MutationSnapshot {
  type: MutationTarget['type'];
  resourceName: string;
  status?: string;
  campaignId?: string | number;
  adGroupId?: string | number;
  keywordText?: string;
}

interface MutationPlan {
  version: 2;
  customerId: string;
  target: MutationTarget;
  resourceName: string;
  expectedStatus: string;
  label: string;
  expiresAt: number;
}

const PLAN_TTL_MS = 10 * 60 * 1000;

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

  if (plan.version !== 2 || !plan.expiresAt || Date.now() > plan.expiresAt) {
    throw new Error('Confirmation token has expired. Generate a new preview.');
  }

  return plan;
}

function validateStatusChange(status: 'ENABLED' | 'PAUSED'): void {
  if (status !== 'ENABLED' && status !== 'PAUSED') {
    throw new Error('Status must be ENABLED or PAUSED.');
  }
}

async function loadTarget(target: MutationTarget): Promise<MutationSnapshot> {
  const customer = getCustomer();
  let rows: MutationSnapshot[];

  if (target.type === 'campaign') {
    rows = await customer.query(`
      SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status
      FROM campaign
      WHERE campaign.id = ${target.id}
      LIMIT 1
    `) as MutationSnapshot[];
  } else if (target.type === 'ad_group') {
    rows = await customer.query(`
      SELECT ad_group.resource_name, ad_group.id, ad_group.name, ad_group.status, campaign.id
      FROM ad_group
      WHERE ad_group.id = ${target.id}
      LIMIT 1
    `) as MutationSnapshot[];
  } else {
    rows = await customer.query(`
      SELECT
        ad_group_criterion.resource_name,
        ad_group_criterion.criterion_id,
        ad_group_criterion.status,
        ad_group_criterion.keyword.text,
        ad_group.id,
        campaign.id
      FROM keyword_view
      WHERE ad_group_criterion.criterion_id = ${target.id}
      LIMIT 1
    `) as MutationSnapshot[];
  }

  const row = rows[0];
  if (!row?.resourceName || !row.status) {
    throw new Error(`${target.type} ${target.id} was not found or is not accessible.`);
  }

  return row;
}

export async function validateMutation(target: MutationTarget) {
  validateStatusChange(target.change.status);
  const current = await loadTarget(target);

  if (current.status === target.change.status) {
    throw new Error(`${target.type} is already ${target.change.status}.`);
  }

  return {
    type: target.type,
    id: target.id,
    resourceName: current.resourceName,
    current: {
      status: current.status,
      campaignId: current.campaignId,
      adGroupId: current.adGroupId,
      keywordText: current.keywordText,
    },
    requested: target.change,
    valid: true as const,
  };
}

export async function previewMutation(target: MutationTarget) {
  const validation = await validateMutation(target);
  const current = await loadTarget(target);
  const expiresAt = Date.now() + PLAN_TTL_MS;
  const label = `${target.type}:${target.id}`;

  const plan: MutationPlan = {
    version: 2,
    customerId: getCustomer().credentials.customer_id,
    target,
    resourceName: validation.resourceName,
    expectedStatus: String(current.status),
    label,
    expiresAt,
  };

  return {
    ...validation,
    expiresAt: new Date(expiresAt).toISOString(),
    confirmationToken: encodePlan(plan),
  };
}

export async function applyMutation(confirmationToken: string) {
  const plan = decodePlan(confirmationToken);
  const current = await loadTarget(plan.target);

  if (current.resourceName !== plan.resourceName || String(current.status) !== plan.expectedStatus) {
    throw new Error('Resource state changed since the preview. Generate a new preview.');
  }

  validateStatusChange(plan.target.change.status);
  const customer = getCustomer();
  const status = plan.target.change.status === 'ENABLED'
    ? enums.AdGroupStatus.ENABLED
    : enums.AdGroupStatus.PAUSED;

  if (plan.target.type === 'campaign') {
    const campaignStatus = plan.target.change.status === 'ENABLED'
      ? enums.CampaignStatus.ENABLED
      : enums.CampaignStatus.PAUSED;
    const result = await customer.campaigns.update([{
      resource_name: plan.resourceName,
      status: campaignStatus,
    }]);
    return { applied: true, target: plan.target, resourceName: plan.resourceName, result };
  }

  if (plan.target.type === 'ad_group') {
    const result = await customer.adGroups.update([{
      resource_name: plan.resourceName,
      status,
    }]);
    return { applied: true, target: plan.target, resourceName: plan.resourceName, result };
  }

  const keywordStatus = plan.target.change.status === 'ENABLED'
    ? enums.AdGroupCriterionStatus.ENABLED
    : enums.AdGroupCriterionStatus.PAUSED;
  const result = await customer.adGroupCriteria.update([{
    resource_name: plan.resourceName,
    status: keywordStatus,
  }]);
  return { applied: true, target: plan.target, resourceName: plan.resourceName, result };
}

export async function validateCampaignChange(campaignId: string, change: CampaignChange) {
  return validateMutation({ type: 'campaign', id: campaignId, change });
}

export async function previewCampaignChange(campaignId: string, change: CampaignChange) {
  return previewMutation({ type: 'campaign', id: campaignId, change });
}

export async function applyCampaignChange(confirmationToken: string) {
  return applyMutation(confirmationToken);
}
