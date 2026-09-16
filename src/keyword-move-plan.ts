export interface KeywordMovePlan {
  keywordId: string;
  sourceAdGroupId: string;
  destinationAdGroupId: string;
}

export function validateKeywordMovePlan(plan: KeywordMovePlan): void {
  for (const [name, value] of Object.entries(plan)) {
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric Google Ads ID.`);
  }
  if (plan.sourceAdGroupId === plan.destinationAdGroupId) {
    throw new Error('sourceAdGroupId and destinationAdGroupId must be different.');
  }
}
