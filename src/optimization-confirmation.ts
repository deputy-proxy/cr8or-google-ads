import { randomBytes } from 'node:crypto';
import { resolveCampaignById, resolveCampaignByName } from './campaign-resolution.js';
import { applyCampaignOptimizationTransaction } from './campaign-optimization-transaction.js';
import { previewCampaignOptimization, validateCampaignOptimization } from './optimization.js';
import type { CampaignOptimization } from './optimization.js';

const CONFIRMATION_TTL_MS = 30 * 60 * 1000;

export interface McpCampaignOptimizationInput {
  campaignName?: string;
  campaignId?: string;
  operations: CampaignOptimization['operations'];
}

interface PendingConfirmation {
  input: CampaignOptimization;
  campaignName?: string;
  campaignResourceName: string;
  campaignStatus: string;
  budgetMicros: string;
  expiresAt: number;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

function cleanup(): void {
  const now = Date.now();
  for (const [id, confirmation] of pendingConfirmations) {
    if (confirmation.expiresAt <= now) pendingConfirmations.delete(id);
  }
}

async function resolveInput(input: McpCampaignOptimizationInput) {
  if (input.campaignName && input.campaignId) throw new Error('Provide campaignName or campaignId, not both.');
  if (!input.campaignName && !input.campaignId) throw new Error('Provide campaignName or campaignId.');
  const campaign = input.campaignName
    ? await resolveCampaignByName(input.campaignName)
    : await resolveCampaignById(input.campaignId as string);
  return {
    campaign,
    optimization: { campaignId: campaign.id, operations: input.operations } satisfies CampaignOptimization,
  };
}

export async function previewCampaignOptimizationForMcp(input: McpCampaignOptimizationInput) {
  cleanup();
  const { campaign, optimization } = await resolveInput(input);
  const preview = await previewCampaignOptimization(optimization);
  const id = randomBytes(18).toString('base64url');
  const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
  pendingConfirmations.set(id, {
    input: optimization,
    campaignName: input.campaignName?.trim(),
    campaignResourceName: campaign.resourceName,
    campaignStatus: String(preview.campaign.status),
    budgetMicros: preview.campaign.dailyBudgetMicros,
    expiresAt,
  });
  return {
    ...preview,
    campaign: { ...preview.campaign, resourceName: campaign.resourceName },
    confirmationToken: id,
    confirmationTokenExpiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function applyCampaignOptimizationForMcp(confirmationToken: string) {
  cleanup();
  const id = confirmationToken.trim();
  const confirmation = pendingConfirmations.get(id);
  if (!confirmation) throw new Error('Invalid or expired confirmation token. Generate a new preview.');
  if (confirmation.expiresAt <= Date.now()) {
    pendingConfirmations.delete(id);
    throw new Error('Confirmation token has expired. Generate a new preview.');
  }

  const campaign = confirmation.campaignName
    ? await resolveCampaignByName(confirmation.campaignName)
    : await resolveCampaignById(confirmation.input.campaignId);

  if (campaign.resourceName !== confirmation.campaignResourceName || campaign.id !== confirmation.input.campaignId) {
    throw new Error('Campaign resource changed since the preview. Generate a new preview.');
  }
  if (campaign.status !== confirmation.campaignStatus || campaign.budgetMicros !== confirmation.budgetMicros) {
    throw new Error('Campaign state changed since the preview. Generate a new preview.');
  }

  const current = await validateCampaignOptimization(confirmation.input);
  if (String(current.campaign.status) !== confirmation.campaignStatus || current.campaign.dailyBudgetMicros !== confirmation.budgetMicros) {
    throw new Error('Campaign state changed since the preview. Generate a new preview.');
  }

  const result = await applyCampaignOptimizationTransaction(confirmation.input, campaign);
  pendingConfirmations.delete(id);
  return result;
}
