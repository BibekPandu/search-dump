import 'dotenv/config';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

function getOpenRouterProvider() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is missing in .env');
  }
  return createOpenRouter({
    apiKey,
    headers: {
      'HTTP-Referer': 'http://localhost:4111',
      'X-Title': 'Mastra Search Agent',
    },
  });
}

// Recommended free models on OpenRouter
export const FREE_MODELS = {
  GEMMA_26B_A4B_FREE: 'google/gemma-4-26b-a4b-it:free',
  GEMMA_31B_FREE: 'google/gemma-4-31b-it:free',
  NEMOTRON_SUPER_FREE: 'nvidia/nemotron-3-super-120b-a12b:free',
  NEX_PRO_FREE: 'nex-agi/nex-n2.5-pro:free',
} as const;

export function getGemmaModel(modelId: string = FREE_MODELS.GEMMA_26B_A4B_FREE) {
  const openrouter = getOpenRouterProvider();
  return openrouter(modelId, {
    models: [
      FREE_MODELS.GEMMA_26B_A4B_FREE,
      FREE_MODELS.GEMMA_31B_FREE,
      FREE_MODELS.NEX_PRO_FREE,
    ],
    provider: {
      allow_fallbacks: true,
    },
  });
}
