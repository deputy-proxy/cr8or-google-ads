import { createHmac, timingSafeEqual } from 'node:crypto';
import { getCustomer } from './google-ads.js';
import { enums } from 'google-ads-api';

export type CampaignChange =
  | { status: 'ENABLED' | 'PAUSED'; dailyBudgetMicros?: never }
  | { dailyBudgetMicros: number; status?: never };
export type AdGroupChange = { status: 'ENABLED' | 'PAUSED' };
export type KeywordChange = { status: 'ENABLED' | 'PAUSED' };
export type MutationTarget =
  | { type: 'campaign'; id: string; change: CampaignChange }
  | { type: 'ad_group'; id: string; change: AdGroupChange }
  | { type: 'keyword'; id: string; change: KeywordChange };
interface Snapshot {
  campaign?: { resource_name: string; id?: string | number; name?: string; status?: string };
  campaign_budget?: { resource_name: string; amount_micros?: string | number };
  ad_group?: { resource_name: string; id?: string | number; name?: string; status?: string };
  ad_group_criterion?: { resource_name: string; criterion_id?: string | number; status?: string; keyword?: { text?: string } };
}
interface MutationPlan {
  version: 2;
  customerId: string;
  target: MutationTarget;
  resourceName: string;
  expectedStatus?: string;
  expectedBudgetMicros?: string;
  expiresAt: number;
}
const PLAN_TTL_MS = 10 * 60 * 1000;
const MIN_DAILY_BUDGET_MICROS = 1_000_000;
const MAX_DAILY_BUDGET_MICROS = 100_000_000_000;
type StatusChange = { status: 'ENABLED' | 'PAUSED' };
function mutationSecret(): string {
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!secret) throw new Error('Missing required environment variable: MCP_AUTH_TOKEN');
  return secret;
}
function sign(value: string): string { return createHmac('sha256', mutationSecret()).update(value).digest('base64url'); }
function encodePlan(plan: MutationPlan): string { const payload = Buffer.from(JSON.stringify(plan)).toString('base64url'); return `${payload}.${sign(payload)}`; }
function decodePlan(token: string): MutationPlan {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new Error('Invalid confirmation token.');
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid confirmation token.');
  let plan: MutationPlan;
  try { plan = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as MutationPlan; } catch { throw new Error('Invalid confirmation token.'); }
  if (plan.version !== 2 || !plan.expiresAt || Date.now() > plan.expiresAt) throw new Error('Confirmation token has expired. Generate a new preview.');
  return plan;
}
function validateStatus(status: 'ENABLED' | 'PAUSED'): void { if (status !== 'ENABLED' && status !== 'PAUSED') throw new Error('Status must be ENABLED or PAUSED.'); }
function validateCampaignMutationChange(change: CampaignChange): void {
  if ('status' in change) { validateStatus(change.status as 'ENABLED' | 'PAUSED'); return; }
  if (!Number.isSafeInteger(change.dailyBudgetMicros)) throw new Error('dailyBudgetMicros must be a safe integer.');
  if (change.dailyBudgetMicros < MIN_DAILY_BUDGET_MICROS || change.dailyBudgetMicros > MAX_DAILY_BUDGET_MICROS) throw new Error(`dailyBudgetMicros must be between ${MIN_DAILY_BUDGET_MICROS} and ${MAX_DAILY_BUDGET_MICROS}.`);
}
async function loadTarget(target: MutationTarget): Promise<Snapshot> {
  const customer = getCustomer();
  let rows: Snapshot[];
  if (target.type === 'campaign') rows = await customer.query(`SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${target.id} LIMIT 1`) as Snapshot[];
  else if (target.type === 'ad_group') rows = await customer.query(`SELECT ad_group.resource_name, ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.id = ${target.id} LIMIT 1`) as Snapshot[];
  else rows = await customer.query(`SELECT ad_group_criterion.resource_name, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.keyword.text FROM keyword_view WHERE ad_group_criterion.criterion_id = ${target.id} LIMIT 1`) as Snapshot[];
  if (!rows[0]) throw new Error(`${target.type} ${target.id} was not found or is not accessible.`);
  return rows[0];
}
function snapshotStatus(snapshot: Snapshot, type: MutationTarget['type']): string | undefined { return type === 'campaign' ? snapshot.campaign?.status : type === 'ad_group' ? snapshot.ad_group?.status : snapshot.ad_group_criterion?.status; }
function snapshotResource(snapshot: Snapshot, type: MutationTarget['type']): string | undefined { return type === 'campaign' ? snapshot.campaign?.resource_name : type === 'ad_group' ? snapshot.ad_group?.resource_name : snapshot.ad_group_criterion?.resource_name; }
export async function validateMutation(target: MutationTarget) {
  if ('status' in target.change) validateStatus((target.change as StatusChange).status); else validateCampaignMutationChange(target.change);
  const current = await loadTarget(target);
  const status = snapshotStatus(current, target.type);
  const resourceName = snapshotResource(current, target.type);
  if (!resourceName || !status) throw new Error(`${target.type} ${target.id} is missing required mutable state.`);
  if ('status' in target.change && target.change.status === status) throw new Error(`${target.type} is already ${target.change.status}.`);
  if ('dailyBudgetMicros' in target.change && target.change.dailyBudgetMicros === Number(current.campaign_budget?.amount_micros ?? 0)) throw new Error('Campaign budget is already set to that amount.');
  return { type: target.type, id: target.id, resourceName, current: { status, dailyBudgetMicros: Number(current.campaign_budget?.amount_micros ?? 0), name: current.campaign?.name ?? current.ad_group?.name, keywordText: current.ad_group_criterion?.keyword?.text }, requested: target.change, valid: true as const };
}
export async function previewMutation(target: MutationTarget) {
  const validation = await validateMutation(target);
  const current = await loadTarget(target);
  const expiresAt = Date.now() + PLAN_TTL_MS;
  const plan: MutationPlan = { version: 2, customerId: getCustomer().credentials.customer_id, target, resourceName: validation.resourceName, expectedStatus: snapshotStatus(current, target.type), expectedBudgetMicros: String(current.campaign_budget?.amount_micros ?? 0), expiresAt };
  return { ...validation, expiresAt: new Date(expiresAt).toISOString(), confirmationToken: encodePlan(plan) };
}
export async function applyMutation(confirmationToken: string) {
  const plan = decodePlan(confirmationToken);
  const current = await loadTarget(plan.target);
  if (snapshotResource(current, plan.target.type) !== plan.resourceName || snapshotStatus(current, plan.target.type) !== plan.expectedStatus) throw new Error('Resource state changed since the preview. Generate a new preview.');
  if (plan.target.type === 'campaign' && 'dailyBudgetMicros' in plan.target.change && String(current.campaign_budget?.amount_micros ?? 0) !== String(plan.expectedBudgetMicros ?? 0)) throw new Error('Campaign budget changed since the preview. Generate a new preview.');
  const customer = getCustomer();
  if (plan.target.type === 'campaign') {
    if ('status' in plan.target.change) {
      const status = plan.target.change.status === 'ENABLED' ? enums.CampaignStatus.ENABLED : enums.CampaignStatus.PAUSED;
      const result = await customer.campaigns.update([{ resource_name: plan.resourceName, status }]);
      return { applied: true, target: plan.target, resourceName: plan.resourceName, result };
    }
    const budgetResourceName = current.campaign_budget?.resource_name;
    if (!budgetResourceName) throw new Error('Campaign budget resource is unavailable. Generate a new preview.');
    const result = await customer.campaignBudgets.update([{ resource_name: budgetResourceName, amount_micros: plan.target.change.dailyBudgetMicros }]);
    return { applied: true, target: plan.target, resourceName: budgetResourceName, result };
  }
  if (plan.target.type === 'ad_group') {
    const status = plan.target.change.status === 'ENABLED' ? enums.AdGroupStatus.ENABLED : enums.AdGroupStatus.PAUSED;
    const result = await customer.adGroups.update([{ resource_name: plan.resourceName, status }]);
    return { applied: true, target: plan.target, resourceName: plan.resourceName, result };
  }
  const status = plan.target.change.status === 'ENABLED' ? enums.AdGroupCriterionStatus.ENABLED : enums.AdGroupCriterionStatus.PAUSED;
  const result = await customer.adGroupCriteria.update([{ resource_name: plan.resourceName, status }]);
  return { applied: true, target: plan.target, resourceName: plan.resourceName, result };
}
export async function validateCampaignChange(campaignId: string, change: CampaignChange) { return validateMutation({ type: 'campaign', id: campaignId, change }); }
export async function previewCampaignChange(campaignId: string, change: CampaignChange) { return previewMutation({ type: 'campaign', id: campaignId, change }); }
export async function applyCampaignChange(confirmationToken: string) { return applyMutation(confirmationToken); }
