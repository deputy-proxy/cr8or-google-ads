import { createHmac, timingSafeEqual } from 'node:crypto';
import { enums } from 'google-ads-api';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { getCustomer, getCustomerFor } from './google-ads.js';

const TTL = 10 * 60 * 1000;
const MAX_HEADLINES = 15;
const MAX_DESCRIPTIONS = 4;
const HEADLINE_MAX = 30;
const DESCRIPTION_MAX = 90;
const PATH_MAX = 15;

type LeadPlan = { version: 1; kind: 'lead_form_goal'; customerId: string; campaignId: string; resourceName: string; expectedBiddable: boolean; expiresAt: number };
type RsaSpec = { campaignId: string; adGroupId: string; finalUrl: string; headlines: string[]; descriptions: string[]; path1?: string; path2?: string; status?: 'ENABLED' | 'PAUSED' };
type RsaPlan = { version: 1; kind: 'rsa_create'; customerId: string; spec: RsaSpec; adGroupResourceName: string; expiresAt: number };
type Plan = LeadPlan | RsaPlan;

const secret = () => { const value = process.env.MCP_AUTH_TOKEN; if (!value) throw new Error('Missing required environment variable: MCP_AUTH_TOKEN'); return value; };
const sign = (value: string) => createHmac('sha256', secret()).update(value).digest('base64url');
const encode = (plan: Plan) => { const payload = Buffer.from(JSON.stringify(plan)).toString('base64url'); return `${payload}.${sign(payload)}`; };
function decode(token: string): Plan { const [payload, signature] = token.split('.'); if (!payload || !signature) throw new Error('Invalid confirmation token.'); const expected = Buffer.from(sign(payload)); const actual = Buffer.from(signature); if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid confirmation token.'); let plan: Plan; try { plan = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Plan; } catch { throw new Error('Invalid confirmation token.'); } if (plan.version !== 1 || Date.now() > plan.expiresAt) throw new Error('Confirmation token has expired. Generate a new preview.'); return plan; }
const assertId = (value: string, name: string) => { if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric Google Ads ID.`); };
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);

async function campaign(campaignId: string) {
  assertId(campaignId, 'campaignId');
  const [row] = await getCustomer().query(`SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`);
  if (!row?.campaign?.resource_name || !row.campaign) throw new Error(`Campaign ${campaignId} was not found or is not accessible.`);
  return { campaign: row.campaign };
}

async function adGroup(campaignId: string, adGroupId: string) {
  assertId(campaignId, 'campaignId'); assertId(adGroupId, 'adGroupId');
  const [row] = await getCustomer().query(`SELECT campaign.id, ad_group.resource_name, ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.id = ${adGroupId} AND ad_group.status != 'REMOVED' LIMIT 1`);
  if (!row?.ad_group?.resource_name || !row.ad_group) throw new Error(`Ad group ${adGroupId} does not belong to campaign ${campaignId} or is not accessible.`);
  return { ad_group: row.ad_group };
}

async function leadGoal(campaignId: string) {
  const loadedCampaign = await campaign(campaignId); const [goalRow] = await getCustomer().query(`SELECT campaign_conversion_goal.resource_name, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign.id = ${campaignId} AND campaign_conversion_goal.category = SUBMIT_LEAD_FORM AND campaign_conversion_goal.origin = GOOGLE_HOSTED LIMIT 1`);
  const goal = goalRow?.campaign_conversion_goal;
  if (!goal || typeof goal.resource_name !== 'string') throw new Error(`Google-hosted lead-form conversion goal was not found for campaign ${campaignId}.`);
  const [customerRow] = await getCustomer().query('SELECT customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer LIMIT 1');
  const conversionCustomerResource = customerRow?.customer?.conversion_tracking_setting?.google_ads_conversion_customer;
  const conversionCustomerId = typeof conversionCustomerResource === 'string' && conversionCustomerResource ? conversionCustomerResource.split('/')[1] : getCustomer().credentials.customer_id;
  const actions = await getCustomerFor(conversionCustomerId).query(`SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.status FROM conversion_action WHERE conversion_action.category = SUBMIT_LEAD_FORM AND conversion_action.origin = GOOGLE_HOSTED AND conversion_action.status != 'REMOVED'`);
  if (!actions.length) throw new Error(`No active Google-hosted lead-form conversion action was found for campaign ${campaignId}.`);
  return { campaign: loadedCampaign.campaign, goal, conversionCustomerId, actions };
}

export async function validateLeadFormGoalChange(campaignId: string, biddable = false) {
  const loaded = await leadGoal(campaignId); const current = Boolean(loaded.goal.biddable);
  if (current === biddable) throw new Error(`Google-hosted lead-form conversion goal is already ${biddable ? 'enabled' : 'disabled'} for bidding.`);
  return { valid: true as const, campaign: { id: loaded.campaign.id, name: loaded.campaign.name }, goal: { resourceName: loaded.goal.resource_name, category: loaded.goal.category, origin: loaded.goal.origin, currentBiddable: current, requestedBiddable: biddable }, conversionCustomerId: loaded.conversionCustomerId, conversionActions: loaded.actions.map((row) => ({ id: String(row?.conversion_action?.id ?? ''), name: row?.conversion_action?.name, type: row?.conversion_action?.type, status: row?.conversion_action?.status })) };
}

export async function previewLeadFormGoalChange(campaignId: string, biddable = false) { const validation = await validateLeadFormGoalChange(campaignId, biddable); const expiresAt = Date.now() + TTL; return { ...validation, expiresAt: new Date(expiresAt).toISOString(), confirmationToken: encode({ version: 1, kind: 'lead_form_goal', customerId: getCustomer().credentials.customer_id, campaignId, resourceName: validation.goal.resourceName, expectedBiddable: validation.goal.currentBiddable, expiresAt }) }; }

export async function applyLeadFormGoalChange(token: string) { const plan = decode(token); if (plan.kind !== 'lead_form_goal') throw new Error('Confirmation token is not for a lead-form goal change.'); const loaded = await leadGoal(plan.campaignId); if (String(loaded.goal.resource_name) !== plan.resourceName || Boolean(loaded.goal.biddable) !== plan.expectedBiddable) throw new Error('Google-hosted lead-form conversion goal changed since the preview. Generate a new preview.'); try { const result = await getCustomer().mutateResources([{ entity: 'campaign_conversion_goal', operation: 'update', resource: { resource_name: plan.resourceName, biddable: !plan.expectedBiddable } }] as never[], { partial_failure: false }); return { applied: true, campaignId: plan.campaignId, goalResourceName: plan.resourceName, biddable: !plan.expectedBiddable, result }; } catch (error) { throw new Error(`Google Ads mutation failed: ${json(error)}`); } }

function validateRsaSpec(spec: RsaSpec) { assertId(spec.campaignId, 'campaignId'); assertId(spec.adGroupId, 'adGroupId'); let url: URL; try { url = new URL(spec.finalUrl); } catch { throw new Error('finalUrl must be an absolute URL.'); } if (!['http:', 'https:'].includes(url.protocol)) throw new Error('finalUrl must use http or https.'); if (spec.headlines.length < 3 || spec.headlines.length > MAX_HEADLINES) throw new Error(`headlines must contain between 3 and ${MAX_HEADLINES} assets.`); if (spec.descriptions.length < 2 || spec.descriptions.length > MAX_DESCRIPTIONS) throw new Error(`descriptions must contain between 2 and ${MAX_DESCRIPTIONS} assets.`); if (spec.headlines.some((text) => !text.trim() || text.length > HEADLINE_MAX)) throw new Error(`Each headline must be non-empty and at most ${HEADLINE_MAX} characters.`); if (spec.descriptions.some((text) => !text.trim() || text.length > DESCRIPTION_MAX)) throw new Error(`Each description must be non-empty and at most ${DESCRIPTION_MAX} characters.`); if (spec.path1 !== undefined && (!spec.path1.trim() || spec.path1.length > PATH_MAX)) throw new Error(`path1 must be non-empty and at most ${PATH_MAX} characters.`); if (spec.path2 !== undefined && (!spec.path2.trim() || spec.path2.length > PATH_MAX)) throw new Error(`path2 must be non-empty and at most ${PATH_MAX} characters.`); if (spec.path2 !== undefined && spec.path1 === undefined) throw new Error('path2 requires path1.'); }
function rsaFingerprint(spec: RsaSpec) { return JSON.stringify({ finalUrl: spec.finalUrl, headlines: spec.headlines.map((text) => text.trim()), descriptions: spec.descriptions.map((text) => text.trim()), path1: spec.path1?.trim(), path2: spec.path2?.trim() }); }

async function validateRsaReferences(spec: RsaSpec) { validateRsaSpec(spec); const loaded = await adGroup(spec.campaignId, spec.adGroupId); const group = loaded.ad_group; if (typeof group.resource_name !== 'string') throw new Error('Ad group resource name is unavailable.'); const rows = await getCustomer().query(`SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2 FROM ad_group_ad WHERE campaign.id = ${spec.campaignId} AND ad_group.id = ${spec.adGroupId} AND ad_group_ad.ad.type = RESPONSIVE_SEARCH_AD AND ad_group_ad.status != 'REMOVED'`); const duplicate = rows.some((row) => { const rsa = row?.ad_group_ad?.ad?.responsive_search_ad; const urls = row?.ad_group_ad?.ad?.final_urls; if (!rsa || !Array.isArray(urls) || !urls[0]) return false; return rsaFingerprint({ campaignId: spec.campaignId, adGroupId: spec.adGroupId, finalUrl: String(urls[0]), headlines: (rsa.headlines ?? []).map((asset) => String(asset?.text ?? '')), descriptions: (rsa.descriptions ?? []).map((asset) => String(asset?.text ?? '')), path1: rsa.path1 ? String(rsa.path1) : undefined, path2: rsa.path2 ? String(rsa.path2) : undefined }) === rsaFingerprint(spec); }); if (duplicate) throw new Error(`An identical responsive search ad already exists in ad group ${spec.adGroupId}.`); return { valid: true as const, campaign: { id: spec.campaignId }, adGroup: { id: group.id, name: group.name, resourceName: group.resource_name }, existingResponsiveSearchAds: rows.length, spec }; }

export async function validateRsaCreate(spec: RsaSpec) { return validateRsaReferences(spec); }
export async function previewRsaCreate(spec: RsaSpec) { const validation = await validateRsaReferences(spec); const expiresAt = Date.now() + TTL; return { ...validation, expiresAt: new Date(expiresAt).toISOString(), confirmationToken: encode({ version: 1, kind: 'rsa_create', customerId: getCustomer().credentials.customer_id, spec, adGroupResourceName: validation.adGroup.resourceName, expiresAt }) }; }
export async function applyRsaCreate(token: string) { const plan = decode(token); if (plan.kind !== 'rsa_create') throw new Error('Confirmation token is not for a responsive search ad creation.'); const validation = await validateRsaReferences(plan.spec); if (validation.adGroup.resourceName !== plan.adGroupResourceName) throw new Error('The destination ad group changed since the preview. Generate a new preview.'); const rsa = { headlines: plan.spec.headlines.map((text) => ({ text: text.trim() })), descriptions: plan.spec.descriptions.map((text) => ({ text: text.trim() })), ...(plan.spec.path1 !== undefined ? { path1: plan.spec.path1.trim() } : {}), ...(plan.spec.path2 !== undefined ? { path2: plan.spec.path2.trim() } : {}) }; try { const result = await getCustomer().mutateResources([{ entity: 'ad_group_ad', operation: 'create', resource: { ad_group: plan.adGroupResourceName, status: plan.spec.status === 'PAUSED' ? enums.AdGroupAdStatus.PAUSED : enums.AdGroupAdStatus.ENABLED, ad: { final_urls: [plan.spec.finalUrl], responsive_search_ad: rsa } } }] as never[], { partial_failure: false }); return { applied: true, campaignId: plan.spec.campaignId, adGroupId: plan.spec.adGroupId, result }; } catch (error) { throw new Error(`Google Ads mutation failed: ${json(error)}`); } }

const leadInput = z.object({ campaignId: z.string().regex(/^\d+$/), biddable: z.boolean().default(false) });
const rsaInput = z.object({ campaignId: z.string().regex(/^\d+$/), adGroupId: z.string().regex(/^\d+$/), finalUrl: z.string().url(), headlines: z.array(z.string().trim().min(1).max(HEADLINE_MAX)).min(3).max(MAX_HEADLINES), descriptions: z.array(z.string().trim().min(1).max(DESCRIPTION_MAX)).min(2).max(MAX_DESCRIPTIONS), path1: z.string().trim().min(1).max(PATH_MAX).optional(), path2: z.string().trim().min(1).max(PATH_MAX).optional(), status: z.enum(['ENABLED', 'PAUSED']).default('ENABLED') }).refine((value) => value.path2 === undefined || value.path1 !== undefined, { message: 'path2 requires path1.', path: ['path2'] });

export function registerPhaseCTools(server: McpServer): void {
  server.registerTool('validate_lead_form_goal_change', { title: 'Validate Google-hosted lead-form goal change', description: 'Validate the SUBMIT_LEAD_FORM + GOOGLE_HOSTED campaign goal. Defaults to disabling bidding and never modifies Google Ads.', inputSchema: leadInput }, async ({ campaignId, biddable }) => ({ content: [{ type: 'text', text: json(await validateLeadFormGoalChange(campaignId, biddable)) }] }));
  server.registerTool('preview_lead_form_goal_change', { title: 'Preview Google-hosted lead-form goal change', description: 'Validate the Google-hosted lead-form campaign goal and return a short-lived confirmation token.', inputSchema: leadInput }, async ({ campaignId, biddable }) => ({ content: [{ type: 'text', text: json(await previewLeadFormGoalChange(campaignId, biddable)) }] }));
  server.registerTool('apply_lead_form_goal_change', { title: 'Apply confirmed Google-hosted lead-form goal change', description: 'Apply a previously previewed lead-form campaign goal change after live state revalidation.', inputSchema: z.object({ confirmationToken: z.string().min(20) }) }, async ({ confirmationToken }) => { try { return { content: [{ type: 'text', text: json(await applyLeadFormGoalChange(confirmationToken)) }] }; } catch (error) { return { content: [{ type: 'text', text: json({ error: error instanceof Error ? error.message : String(error) }) }], isError: true }; } });
  server.registerTool('validate_rsa_create', { title: 'Validate responsive search ad creation', description: 'Validate an intent-specific responsive search ad for an existing campaign ad group without modifying Google Ads.', inputSchema: rsaInput }, async (input) => ({ content: [{ type: 'text', text: json(await validateRsaCreate(input)) }] }));
  server.registerTool('preview_rsa_create', { title: 'Preview responsive search ad creation', description: 'Validate an intent-specific responsive search ad and return a short-lived confirmation token.', inputSchema: rsaInput }, async (input) => ({ content: [{ type: 'text', text: json(await previewRsaCreate(input)) }] }));
  server.registerTool('apply_rsa_create', { title: 'Apply confirmed responsive search ad creation', description: 'Create a previously previewed responsive search ad after revalidating the destination ad group and duplicate state.', inputSchema: z.object({ confirmationToken: z.string().min(20) }) }, async ({ confirmationToken }) => { try { return { content: [{ type: 'text', text: json(await applyRsaCreate(confirmationToken)) }] }; } catch (error) { return { content: [{ type: 'text', text: json({ error: error instanceof Error ? error.message : String(error) }) }], isError: true }; } });
}
