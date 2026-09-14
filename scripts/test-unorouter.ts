import 'dotenv/config';
import {
  generateWithUnoFallback,
  generateWithUnoTribunal,
  getUnoModel,
  UNO_FREE_MODELS,
} from '../src/services/unorouter.service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASS: ${message}`);
  }
}

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 UNOROUTER SERVICE & AI TRIBUNAL VERIFICATION SUITE');
  console.log('===============================================================');

  // --- TEST 1: Model Provider Creation ---
  console.log('\n--- TEST 1: Provider & Model Factory ---');
  const model = getUnoModel(UNO_FREE_MODELS.GEMINI_3_5_FLASH);
  assert(typeof model === 'object' || typeof model === 'function', 'getUnoModel returns valid model instance');
  assert(Boolean(process.env.UNOROUTER_API_KEY), 'UNOROUTER_API_KEY is defined in environment');

  // --- TEST 2: Single-Model Generation via Fallback Waterfall ---
  console.log('\n--- TEST 2: Single-Model Generation (generateWithUnoFallback) ---');
  const startFallback = Date.now();
  const fallbackRes = await generateWithUnoFallback(
    'Answer with exactly: {"test":"ok"}',
    'Output only JSON'
  );
  const elapsedFallback = Date.now() - startFallback;
  console.log(`Model used: ${fallbackRes.modelUsed} in ${elapsedFallback}ms`);
  console.log(`Output: ${fallbackRes.text}`);
  assert(fallbackRes.text.includes('ok'), 'Fallback generation produced valid response');
  assert(Boolean(fallbackRes.modelUsed), 'Recorded modelUsed');

  // --- TEST 3: AI Consensus Tribunal (Parallel Drafts + Arbiter Judge) ---
  console.log('\n--- TEST 3: AI Consensus Tribunal (generateWithUnoTribunal) ---');
  const mockPrompt = `Given the following candidate:
Name: Kathmandu Specialty Roastery
Location: Thamel, Kathmandu
Extracted Phone: 9801122334
Extracted Email: contact@roastery.com
Generate a JSON array with one business listing having fields name, location, phones, emails. Return ONLY the JSON array.`;

  const startTribunal = Date.now();
  const tribunalRes = await generateWithUnoTribunal(mockPrompt);
  const elapsedTribunal = Date.now() - startTribunal;
  console.log(`Tribunal completed in ${elapsedTribunal}ms`);
  console.log(`Model / Mode used: ${tribunalRes.modelUsed} (consensus: ${tribunalRes.consensus})`);
  console.log(`Tribunal text output:\n${tribunalRes.text}`);

  assert(tribunalRes.text.length > 0, 'Tribunal produced non-empty text');
  assert(
    tribunalRes.text.includes('Kathmandu Specialty Roastery') ||
      tribunalRes.text.includes('9801122334') ||
      tribunalRes.text.includes('roastery.com'),
    'Tribunal preserved candidate facts'
  );

  let parsed: any = null;
  try {
    const cleaned = tribunalRes.text.replace(/```json/gi, '').replace(/```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    const match = tribunalRes.text.match(/\[[\s\S]*\]/) || tribunalRes.text.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
  }

  assert(parsed !== null, 'Tribunal text successfully parsed as valid JSON');
  const listings = Array.isArray(parsed) ? parsed : parsed?.listings || [parsed];
  assert(listings.length > 0, 'Parsed at least 1 listing record');
  console.log('Parsed Listing 0:', listings[0]);

  // --- TEST 4: Single-Expert Resilience (When 1 Expert Times Out) ---
  console.log('\n--- TEST 4: Tribunal Partial-Failure Resilience ---');
  // Pass 1ms timeout for expert 2 to simulate it timing out; expert 1 should seamlessly take over
  const resilienceRes = await generateWithUnoTribunal(
    'Return JSON array: [{"name":"Resilience Test"}]',
    undefined,
    { expert2TimeoutMs: 1 }
  );
  console.log(`Resilience mode used: ${resilienceRes.modelUsed} (consensus: ${resilienceRes.consensus})`);
  assert(resilienceRes.text.length > 0, 'Resilience test produced output even when Expert 2 timed out');
  assert(resilienceRes.consensus === false, 'Consensus cleanly marked false when only 1 expert responded');

  console.log('\n===============================================================');
  console.log('🎉 ALL UNOROUTER & AI TRIBUNAL TESTS PASSED (100%)');
  console.log('===============================================================');
}

runTests().catch((err) => {
  console.error('UnoRouter test failed:', err);
  process.exit(1);
});
