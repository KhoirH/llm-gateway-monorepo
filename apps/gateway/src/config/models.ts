export type ModelTier = "fast" | "strong";

export interface ModelPrice {
  provider: string;
  priceInPer1m: number;
  priceOutPer1m: number;
}

export const MODEL_PRICES: Record<ModelTier, ModelPrice> = {
  fast: { provider: "groq", priceInPer1m: 0.05, priceOutPer1m: 0.08 },
  strong: { provider: "gemini", priceInPer1m: 0.1, priceOutPer1m: 0.4 },
};

export function estimateCost(tier: ModelTier, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICES[tier];
  if (!price) return 0;
  return (inputTokens / 1_000_000) * price.priceInPer1m + (outputTokens / 1_000_000) * price.priceOutPer1m;
}
