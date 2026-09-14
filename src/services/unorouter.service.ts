import 'dotenv/config';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText } from 'ai';

export const UNO_FREE_MODELS = {
  GEMINI_3_5_FLASH: 'gemini-3.5-flash-lite:free',
  GEMINI_3_1_FLASH: 'gemini-3.1-flash-lite:free',
  STEP_FLASH: 'step-3.7-flash:free',
  GLM_5_2: 'glm-5.2:free',
  GLM_5_3_FLASH: 'glm-5.3-flash:free',
} as const;

export function getUnoRouterProvider() {
  const apiKey = process.env.UNOROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('UNOROUTER_API_KEY is missing in .env');
  }
  const baseURL = process.env.UNOROUTER_BASE_URL || 'https://api.unorouter.com/v1';
  return createOpenRouter({
    apiKey,
    baseURL,
    headers: {
      'HTTP-Referer': 'http://localhost:4111',
      'X-Title': 'Mastra Search Agent',
    },
  });
}

export function getUnoModel(modelId: string = UNO_FREE_MODELS.GEMINI_3_5_FLASH) {
  const uno = getUnoRouterProvider();
  return uno(modelId);
}

export interface UnoFallbackOptions {
  timeoutMs?: number;
  models?: string[];
}

/**
 * Generates text sequentially across UnoRouter free models with per-model timeouts.
 */
export async function generateWithUnoFallback(
  prompt: string,
  systemInstruction?: string,
  options: UnoFallbackOptions = {}
): Promise<{ text: string; modelUsed: string }> {
  const uno = getUnoRouterProvider();
  const timeoutMs = options.timeoutMs ?? 20000;
  const modelChain = options.models ?? [
    UNO_FREE_MODELS.GEMINI_3_5_FLASH,
    UNO_FREE_MODELS.GEMINI_3_1_FLASH,
    UNO_FREE_MODELS.STEP_FLASH,
    UNO_FREE_MODELS.GLM_5_2,
    UNO_FREE_MODELS.GLM_5_3_FLASH,
  ];

  for (const modelId of modelChain) {
    try {
      console.log(`[UnoRouter Fallback] Trying model: ${modelId}...`);
      const start = Date.now();
      const result = await generateText({
        model: uno(modelId),
        prompt,
        system: systemInstruction,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });

      const elapsed = Date.now() - start;
      const text = result.text?.trim() || '';
      if (text.length > 0) {
        console.log(`[UnoRouter Fallback] Success with ${modelId} (${elapsed}ms, ${text.length} chars)`);
        return { text, modelUsed: modelId };
      }
      console.warn(`[UnoRouter Fallback] Model ${modelId} returned empty response. Trying next...`);
    } catch (err) {
      console.warn(`[UnoRouter Fallback] Model ${modelId} failed: ${(err as Error).message}. Trying next...`);
    }
  }

  throw new Error('All UnoRouter models in fallback chain failed or timed out.');
}

export interface UnoTribunalOptions {
  expert1TimeoutMs?: number;
  expert2TimeoutMs?: number;
  judgeTimeoutMs?: number;
}

/**
 * Generates text using an AI Consensus Tribunal (Expert 1 + Expert 2 -> Arbiter Judge C).
 * Resilient against single-model failure via Promise.allSettled.
 */
export async function generateWithUnoTribunal(
  prompt: string,
  systemInstruction?: string,
  options: UnoTribunalOptions = {}
): Promise<{ text: string; modelUsed: string; consensus: boolean }> {
  const uno = getUnoRouterProvider();
  const expert1Timeout = options.expert1TimeoutMs ?? 20000;
  const expert2Timeout = options.expert2TimeoutMs ?? 20000;
  const judgeTimeout = options.judgeTimeoutMs ?? 18000;

  console.log('[UnoRouter Tribunal] Convening AI Tribunal with Expert 1 (Gemini) and Expert 2 (Step/GLM)...');

  // Step 1: Run Expert 1 and Expert 2 concurrently
  const [draft1Result, draft2Result] = await Promise.allSettled([
    generateText({
      model: uno(UNO_FREE_MODELS.GEMINI_3_5_FLASH),
      prompt,
      system: systemInstruction,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(expert1Timeout),
    }),
    generateText({
      model: uno(UNO_FREE_MODELS.STEP_FLASH),
      prompt,
      system: systemInstruction,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(expert2Timeout),
    }),
  ]);

  const draft1 =
    draft1Result.status === 'fulfilled' && draft1Result.value.text?.trim()
      ? draft1Result.value.text.trim()
      : null;
  const draft2 =
    draft2Result.status === 'fulfilled' && draft2Result.value.text?.trim()
      ? draft2Result.value.text.trim()
      : null;

  if (draft1Result.status === 'rejected') {
    console.warn(`[UnoRouter Tribunal] Expert 1 (Gemini) failed: ${draft1Result.reason?.message || draft1Result.reason}`);
  }
  if (draft2Result.status === 'rejected') {
    console.warn(`[UnoRouter Tribunal] Expert 2 (Step) failed: ${draft2Result.reason?.message || draft2Result.reason}`);
  }

  // Case A: Both experts generated drafts -> Arbiter Judge cross-examines
  if (draft1 && draft2) {
    console.log('[UnoRouter Tribunal] Both experts generated drafts. Submitting to Arbiter Judge (GLM-5.3 Flash)...');
    const judgePrompt = `You are the Master Arbiter Judge for data research.
Two independent expert agents produced candidate listings JSON for the same query.

--- DRAFT 1 (from Expert Gemini) ---
${draft1}

--- DRAFT 2 (from Expert Step) ---
${draft2}

--- YOUR JUDICIAL TASK ---
1. Compare Draft 1 and Draft 2.
2. If both drafts agree on a business's details, retain them.
3. If there is any discrepancy in phone numbers, emails, addresses, or websites, choose the most specific, accurate, and realistic values. NEVER invent phone numbers or emails.
4. Output the single unified final JSON array of listings. Return ONLY the JSON array without markdown formatting, code blocks, or explanatory text.`;

    try {
      const judgeResult = await generateText({
        model: uno(UNO_FREE_MODELS.GLM_5_3_FLASH),
        prompt: judgePrompt,
        system: systemInstruction,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(judgeTimeout),
      });

      const judgeText = judgeResult.text?.trim() || '';
      if (judgeText.length > 0) {
        console.log('[UnoRouter Tribunal] Arbiter Judge delivered consensus verdict successfully.');
        return { text: judgeText, modelUsed: 'tribunal:consensus(gemini+step->glm5.3)', consensus: true };
      }
    } catch (judgeErr) {
      console.warn(`[UnoRouter Tribunal] Arbiter Judge failed: ${(judgeErr as Error).message}. Adopting cleaner draft...`);
    }

    // If Judge failed, pick the draft that looks most like valid JSON
    return {
      text: draft1.startsWith('[') || draft1.includes('"name"') ? draft1 : draft2,
      modelUsed: 'tribunal:expert1(judge_fallback)',
      consensus: false,
    };
  }

  // Case B: Only Expert 1 succeeded
  if (draft1) {
    console.log('[UnoRouter Tribunal] Expert 1 succeeded; Expert 2 was unavailable. Adopting Expert 1 draft.');
    return { text: draft1, modelUsed: UNO_FREE_MODELS.GEMINI_3_5_FLASH, consensus: false };
  }

  // Case C: Only Expert 2 succeeded
  if (draft2) {
    console.log('[UnoRouter Tribunal] Expert 2 succeeded; Expert 1 was unavailable. Adopting Expert 2 draft.');
    return { text: draft2, modelUsed: UNO_FREE_MODELS.STEP_FLASH, consensus: false };
  }

  // Case D: Both parallel experts failed -> Fallback to sequential waterfall
  console.warn('[UnoRouter Tribunal] Both parallel experts failed. Falling back to sequential waterfall...');
  const fallbackRes = await generateWithUnoFallback(prompt, systemInstruction);
  return { text: fallbackRes.text, modelUsed: fallbackRes.modelUsed, consensus: false };
}
