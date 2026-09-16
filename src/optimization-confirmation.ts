import { randomBytes } from 'node:crypto';
import { applyCustomGoalOptimizationAtomically } from './optimization-custom-goal-atomic.js';
import { applyCampaignOptimization, previewCampaignOptimization, validateCampaignOptimization } from './optimization.js';
import type { CampaignOptimization } from './optimization.js';

const CONFIRMATION_TTL_MS = 30 * 60 * 1000;
const pendingConfirmations = new Map<string, { token: string; input: CampaignOptimization; campaignStatus: string; budgetMicros: string; expiresAt: number }>();

function cleanup(): void {
  const now = Date.now();
  for (const [id, confirmation] of pendingConfirmations) {
    if (confirmation.expiresAt <= now) pendingConfirmations.delete(id);
  }
}

export async function previewCampaignOptimizationForMcp(input: CampaignOptimization) {
  cleanup();
  const preview = await previewCampaignOptimization(input);
  const id = randomBytes(18).toString('base64url');
  const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
  pendingConfirmations.set(id, {
    token: preview.confirmationToken,
    input,
    campaignStatus: String(preview.campaign.status),
    budgetMicros: preview.campaign.dailyBudgetMicros,
    expiresAt,
  });
  return { ...preview, confirmationToken: id, confirmationTokenExpiresAt: new Date(expiresAt).toISOString() };
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

  const current = await validateCampaignOptimization(confirmation.input);
  if (String(current.campaign.status) !== confirmation.campaignStatus || current.campaign.dailyBudgetMicros !== confirmation.budgetMicros) {
    throw new Error('Campaign state changed since the preview. Generate a new preview.');
  }

  const hasCustomGoal = confirmation.input.operations.some((operation) => operation.type === 'custom_conversion_goal');
  const result = hasCustomGoal
    ? await applyCustomGoalOptimizationAtomically(confirmation.input)
    : await applyCampaignOptimization(confirmation.token);
  pendingConfirmations.delete(id);
  return result;
}
