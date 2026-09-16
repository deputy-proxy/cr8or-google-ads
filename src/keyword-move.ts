export interface KeywordMoveInput {
  keywordId: string;
  sourceAdGroupId: string;
  destinationAdGroupId: string;
}

export function validateKeywordMoveInput(input: KeywordMoveInput): void {
  for (const [name, value] of Object.entries(input)) {
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a numeric Google Ads ID.`);
  }
  if (input.sourceAdGroupId === input.destinationAdGroupId) {
    throw new Error('sourceAdGroupId and destinationAdGroupId must be different.');
  }
}
