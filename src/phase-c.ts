import { createHmac, timingSafeEqual } from 'node:crypto';
import { enums } from 'google-ads-api';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { getCustomer, getCustomerFor } from './google-ads.js';

const PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_HEADLINES = 15;
const MAX_DESCRIPTIONS = 4;
const HEADLINE_MAX_LENGTH = 30;
const DESCRIPTION_MAX_LENGTH = 90;
const PATH_MAX_LENGTH = 15;

type LeadFormPlan = {
  version: 1;
  kind: 'lead_form_goal';
  customerId: string;
  campaignId: string;
  resourceName: string;
  expectedBiddable: boolean;
  expiresAt: number;
};

type RsaSpec = {
  campaignId: string;
  adGroupId: string;
  finalUrl: string;
  headlines: string[];
  descriptions: string[];
  path1?: string;
  path2?: string;
  status?: 'ENABLED' | 'PAUSED';
};

type RsaPlan = {
  version: 1;
  kind: 'rsa_create';
  customerId: string;
  spec: RsaSpec;
  adGroupResourceName: string;
  expiresAt: number;
};

function mutationSecret(): string {
  const secret = process.env.MCP_AUTH_TOKEN;
  if (!secret) throw new Error('Missing required environment variable: MCP_AUTH_TOKEN');
  return secret;
}

function sign(value: string): string {
  return createHmac('sha256', mutationSecret()).update(value).digest('base64url');
}

function encodePlan(plan: LeadFormPlan | RsaPlan): string {
  const payload = Buffer.from(JSON.stringify(plan)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function decodePlan(token: string): LeadFormPlan | RsaPlan {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new Error('Invalid confirmation token.');
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid confirmation token.');

  let plan: LeadFormPlan | RsaPlan;
  try {
    plan = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LeadFormPlan | RsaPlan;
  } catch {
    throw new Error('Invalid confirmation token.');
  }
  if (plan.version !== 1 || !plan.expiresAt || Date.now() > plan.expiresAt) throw new Error('Confirmation token has expired. Generate a new preview.');
  return plan;
}

function assertId(value: string, name: string): void {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric Google Ads ID.`);
}

function escapeGaqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function json(data: unknown): string {
  return JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
}

function validateRsaSpec(spec: RsaSpec): void {
  assertId(spec.campaignId, 'campaignId');
  assertId(spec.adGroupId, 'adGroupId');
  let url: URL;
  try {
    url = new URL(spec.finalUrl);
  } catch {
    throw new Error('finalUrl must be an absolute URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('finalUrl must use http or https.');
  if (spec.headlines.length < 3 || spec.headlines.length > MAX_HEADLINES) throw new Error(`headlines must contain between 3 and ${MAX_HEADLINES} assets.`);
  if (spec.descriptions.length < 2 || spec.descriptions.length > MAX_DESCRIPTIONS) throw new Error(`descriptions must contain between 2 and ${MAX_DESCRIPTIONS} assets.`);
  if (spec.headlines.some((headline) => !headline.trim() || headline.length > HEADLINE_MAX_LENGTH)) throw new Error(`Each headline must be non-empty and at most ${HEADLINE_MAX_LENGTH} characters.`);
  if (spec.descriptions.some((description) => !description.trim() || description.length > DESCRIPTION_MAX_LENGTH)) throw new Error(`Each description must be non-empty and at most ${DESCRIPTION_MAX_LENGTH} characters.`);
  if (spec.path1 !== undefined && (!spec.path1.trim() || spec.path1.length > PATH_MAX_LENGTH)) throw new Error(`path1 must be non-empty and at most ${PATH_MAX_LENGTH} characters.`);
  if (spec.path2 !== undefined && (!spec.path2.trim() || spec.path2.length > PATH_MAX_LENGTH)) throw new Error(`path2 must be non-empty and at most ${PATH_MAX_LENGTH} characters.`);
  if (spec.path2 !== undefined && spec.path1 === undefined) throw new Error('path2 requires path1.');
}

async function loadCampaign(campaignId: string) {
  assertId(campaignId, 'campaignId');
  const [row] = await getCustomer().query(`SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`);
  if (!row?.campaign?.resource_name) throw new Error(`Campaign ${campaignId} was not found or is not accessible.`);
  return row;
}

async function loadAdGroup(campaignId: string, adGroupId: string) {
  assertId(campaignId, 'campaignId');
  assertId(adGroupId, 'adGroupId');
  const [row] = await getCustomer().query(`SELECT campaign.id, ad_group.resource_name, ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.id = ${adGroupId} AND ad_group.status != 'REMOVED' LIMIT 1`);
  if (!row?.ad_group?.resource_name) throw new Error(`Ad group ${adGroupId} does not belong to campaign ${campaignId} or is not accessible.`);
  return row;
}

async function loadLeadFormGoal(campaignId: string) {
  const campaign = await loadCampaign(campaignId);
  const customerId = getCustomer().credentials.customer_id;
  const [goal] = await getCustomer().query(`SELECT campaign_conversion_goal.resource_name, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign.id = ${campaignId} AND campaign_conversion_goal.category = SUBMIT_LEAD_FORM AND campaign_conversion_goal.origin = GOOGLE_HOSTED LIMIT 1`);
  if (!goal?.campaign_conversion_goal?.resource_name) throw new Error(`Google-hosted lead-form conversion goal was not found for campaign ${campaignId}.`);

  const conversionCustomerResource = await getCustomer().query('SELECT customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer LIMIT 1');
  const conversionCustomerResourceName = conversionCustomerResource[0]?.customer?.conversion_tracking_setting?.google_ads_conversion_customer;
  const conversionCustomerId = typeof conversionCustomerResourceName === 'string' && conversionCustomerResourceName
    ? conversionCustomerResourceName.split('/')[1]
    : customerId;
  const conversionCustomer = getCustomerFor(conversionCustomerId);
  const actions = await conversionCustomer.query(`SELECT conversion_action.id, conversion_action.name, conversion_action.category, conversion_action.origin, conversion_action.type, conversion_action.status FROM conversion_action WHERE conversion_action.category = SUBMIT_LEAD_FORM AND conversion_action.origin = GOOGLE_HOSTED AND conversion_action.status != 'REMOVED'`);
  if (!actions.length) throw new Error(`No active Google-hosted lead-form conversion action was found for campaign ${campaignId}.`);

  return {
    campaign,
    goal: goal.campaign_conversion_goal,
    conversionCustomerId,
    conversionActions: actions.map((row) => ({ id: String(row?.conversion_action?.id ?? ''), name: row?.conversion_action?.name, type: row?.conversion_action?.type, status: row?.conversion_action?.status })),
  };
}

export async function validateLeadFormGoalChange(campaignId: string, biddable = false) {
  const loaded = await loadLeadFormGoal(campaignId);
  const current = Boolean(loaded.goal.biddable);
  if (current === biddable) throw new Error(`Google-hosted lead-form conversion goal is already ${biddable ? 'enabled' : 'disabled'} for bidding.`);
  return {
    valid: true as const,
    campaign: { id: loaded.campaign.campaign.id, name: loaded.campaign.campaign.name },
    goal: { resourceName: loaded.goal.resource_name, category: loaded.goal.category, origin: loaded.goal.origin, currentBiddable: current, requestedBiddable: biddable },
    conversionCustomerId: loaded.conversionCustomerId,
    conversionActions: loaded.conversionActions,
  };
}

export async function previewLeadFormGoalChange(campaignId: string, biddable = false) {
  const validation = await validateLeadFormGoalChange(campaignId, biddable);
  const expiresAt = Date.now() + PLAN_TTL_MS;
  const plan: LeadFormPlan = {
    version: 1,
    kind: 'lead_form_goal',
    customerId: getCustomer().credentials.customer_id,
    campaignId,
    resourceName: validation.goal.resourceName,
    expectedBiddable: validation.goal.currentBiddable,
    expiresAt,
  };
  return { ...validation, expiresAt: new Date(expiresAt).toISOString(), confirmationToken: encodePlan(plan) };
}

export async function applyLeadFormGoalChange(confirmationToken: string) {
  const plan = decodePlan(confirmationToken);
  if (plan.kind !== 'lead_form_goal') throw new Error('Confirmation token is not for a lead-form goal change.');
  const loaded = await loadLeadFormGoal(plan.campaignId);
  if (String(loaded.goal.resource_name) !== plan.resourceName || Boolean(loaded.goal.biddable) !== plan.expectedBiddable) throw new Error('Google-hosted lead-form conversion goal changed since the preview. Generate a new preview.');
  try {
    const result = await getCustomer().mutateResources([{
      entity: 'campaign_conversion_goal',
      operation: 'update',
      resource: { resource_name: plan.resourceName, biddable: !plan.expectedBiddable },
    }] as never[], { partial_failure: false });
    return { applied: true, campaignId: plan.campaignId, goalResourceName: plan.resourceName, biddable: !plan.expectedBiddable, result };
  } catch (error) {
    throw new Error(`Google Ads mutation failed: ${json(error)}`);
  }
}

function rsaFingerprint(spec: RsaSpec): string {
  return JSON.stringify({
    finalUrl: spec.finalUrl,
    headlines: spec.headlines.map((value) => value.trim()),
    descriptions: spec.descriptions.map((value) => value.trim()),
    path1: spec.path1?.trim(),
    path2: spec.path2?.trim(),
  });
}

async function validateRsaReferences(spec: RsaSpec) {
  validateRsaSpec(spec);
  const adGroup = await loadAdGroup(spec.campaignId, spec.adGroupId);
  const rows = await getCustomer().query(`SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2 FROM ad_group_ad WHERE campaign.id = ${spec.campaignId} AND ad_group.id = ${spec.adGroupId} AND ad_group_ad.ad.type = RESPONSIVE_SEARCH_AD AND ad_group_ad.status != 'REMOVED'`);
  const requestedFingerprint = rsaFingerprint(spec);
  const duplicate = rows.some((row) => {
    const rsa = row?.ad_group_ad?.ad?.responsive_search_ad;
    const finalUrls = row?.ad_group_ad?.ad?.final_urls;
    if (!rsa || !Array.isArray(finalUrls) || !finalUrls[0]) return false;
    return rsaFingerprint({
      campaignId: spec.campaignId,
      adGroupId: spec.adGroupId,
      finalUrl: String(finalUrls[0]),
      headlines: (rsa.headlines ?? []).map((asset: { text?: string }) => String(asset?.text ?? '')),
      descriptions: (rsa.descriptions ?? []).map((asset: { text?: string }) => String(asset?.text ?? '')),
      path1: rsa.path1 ? String(rsa.path1) : undefined,
      path2: rsa.path2 ? String(rsa.path2) : undefined,
    }) === requestedFingerprint;
  });
  if (duplicate) throw new Error(`An identical responsive search ad already exists in ad group ${spec.adGroupId}.`);
  return {
    valid: true as const,
    campaign: { id: spec.campaignId },
    adGroup: { id: adGroup.ad_group.id, name: adGroup.ad_group.name, resourceName: adGroup.ad_group.resource_name },
    existingResponsiveSearchAds: rows.length,
    spec,
  };
}

export async function validateRsaCreate(spec: RsaSpec) {
  return validateRsaReferences(spec);
}

export async function previewRsaCreate(spec: RsaSpec) {
  const validation = await validateRsaReferences(spec);
  const expiresAt = Date.now() + PLAN_TTL_MS;
  const plan: RsaPlan = {
    version: 1,
    kind: 'rsa_create',
    customerId: getCustomer().credentials.customer_id,
    spec,
    adGroupResourceName: validation.adGroup.resourceName,
    expiresAt,
  };
  return { ...validation, expiresAt: new Date(expiresAt).toISOString(), confirmationToken: encodePlan(plan) };
}

export async function applyRsaCreate(confirmationToken: string) {
  const plan = decodePlan(confirmationToken);
  if (plan.kind !== 'rsa_create') throw new Error('Confirmation token is not for a responsive search ad creation.');
  const validation = await validateRsaReferences(plan.spec);
  if (validation.adGroup.resourceName !== plan.adGroupResourceName) throw new Error('The destination ad group changed since the preview. Generate a new preview.');
  const customer = getCustomer();
  const customerId = customer.credentials.customer_id;
  const rsa = {
    headlines: plan.spec.headlines.map((text) => ({ text: text.trim() })),
    descriptions: plan.spec.descriptions.map((text) => ({ text: text.trim() })),
    ...(plan.spec.path1 !== undefined ? { path1: plan.spec.path1.trim() } : {}),
    ...(plan.spec.path2 !== undefined ? { path2: plan.spec.path2.trim() } : {}),
  };
  try {
    const result = await customer.mutateResources([{
      entity: 'ad_group_ad',
      operation: 'create',
      resource: {
        ad_group: plan.adGroupResourceName,
        status: plan.spec.status === 'PAUSED' ? enums.AdGroupAdStatus.PAUSED : enums.AdGroupAdStatus.ENABLED,
        ad: { final_urls: [plan.spec.finalUrl], responsive_search_ad: rsa },
      },
    }] as never[], { partial_failure: false });
    return { applied: true, campaignId: plan.spec.campaignId, adGroupId: plan.spec.adGroupId, result };
  } catch (error) {
    throw new Error(`Google Ads mutation failed: ${json(error)}`);
  }
}

const campaignRef = z.object({ campaignId: z.string().regex(/^\d+$/) });
const leadFormChangeInput = campaignRef.extend({ biddable: z.boolean().default(false) });
const rsaInput = z.object({
  campaignId: z.string().regex(/^\d+$/),
  adGroupId: z.string().regex(/^\d+$/),
  finalUrl: z.string().url(),
  headlines: z.array(z.string().trim().min(1).max(HEADLINE_MAX_LENGTH)).min(3).max(MAX_HEADLINES),
  descriptions: z.array(z.string().trim().min(1).max(DESCRIPTION_MAX_LENGTH)).min(2).max(MAX_DESCRIPTIONS),
  path1: z.string().trim().min(1).max(PATH_MAX_LENGTH).optional(),
  path2: z.string().trim().min(1).max(PATH_MAX_LENGTH).optional(),
  status: z.enum(['ENABLED', 'PAUSED']).default('ENABLED'),
}).refine((value) => value.path2 === undefined || value.path1 !== undefined, { message: 'path2 requires path1.', path: ['path2'] });

export function registerPhaseCTools(server: McpServer): void {
  server.registerTool('validate_lead_form_goal_change', {
    title: 'Validate Google-hosted lead-form goal change',
    description: 'Validate the campaign conversion goal for SUBMIT_LEAD_FORM from GOOGLE_HOSTED. Defaults to disabling bidding for this goal and never changes Google Ads.',
    inputSchema: leadFormChangeInput,
  }, async ({ campaignId, biddable }) => ({ content: [{ type: 'text', text: json(await validateLeadFormGoalChange(campaignId, biddable)) }] }));

  server.registerTool('preview_lead_form_goal_change', {
    title: 'Preview Google-hosted lead-form goal change',
    description: 'Validate the Google-hosted lead-form campaign goal and return a short-lived confirmation token. No Google Ads changes are made.',
    inputSchema: leadFormChangeInput,
  }, async ({ campaignId, biddable }) => ({ content: [{ type: 'text', text: json(await previewLeadFormGoalChange(campaignId, biddable)) }] }));

  server.registerTool('apply_lead_form_goal_change', {
    title: 'Apply confirmed Google-hosted lead-form goal change',
    description: 'Apply a previously previewed Google-hosted lead-form campaign goal change after revalidating its live state.',
    inputSchema: z.object({ confirmationToken: z.string().min(20) }),
  }, async ({ confirmationToken }) => {
    try {
      return { content: [{ type: 'text', text: json(await applyLeadFormGoalChange(confirmationToken)) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: json({ error: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  });

  server.registerTool('validate_rsa_create', {
    title: 'Validate responsive search ad creation',
    description: 'Validate an intent-specific responsive search ad for an existing campaign ad group. No Google Ads changes are made.',
    inputSchema: rsaInput,
  }, async (input) => ({ content: [{ type: 'text', text: json(await validateRsaCreate(input)) }] }));

  server.registerTool('preview_rsa_create', {
    title: 'Preview responsive search ad creation',
    description: 'Validate an intent-specific responsive search ad and return a short-lived confirmation token. The destination ad group is revalidated before application.',
    inputSchema: rsaInput,
  }, async (input) => ({ content: [{ type: 'text', text: json(await previewRsaCreate(input)) }] }));

  server.registerTool('apply_rsa_create', {
    title: 'Apply confirmed responsive search ad creation',
    description: 'Create a previously previewed responsive search ad. The server revalidates the destination ad group and rejects an identical existing ad before mutation.',
    inputSchema: z.object({ confirmationToken: z.string().min(20) }),
  }, async ({ confirmationToken }) => {
    try {
      return { content: [{ type: 'text', text: json(await applyRsaCreate(confirmationToken)) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: json({ error: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  });
}
