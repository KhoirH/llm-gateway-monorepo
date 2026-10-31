export interface ConfidenceComponents {
  topSimilarity: number;
  intentAgreement: number;
  selfReported: number;
}

export interface ConfidenceResult {
  value: number;
  components: ConfidenceComponents;
}

export function computeConfidence(topSimilarity: number, modelIntent: string, entryIntents: string[], selfReported: number): ConfidenceResult {
  const agreement = entryIntents.length === 0 ? 0 : entryIntents.filter((i) => i === modelIntent).length / entryIntents.length;
  const value = 0.4 * topSimilarity + 0.3 * agreement + 0.3 * selfReported;
  return {
    value,
    components: { topSimilarity, intentAgreement: agreement, selfReported },
  };
}
