import 'dotenv/config';

import { gemmaSupervisorAgent } from '../src/mastra/agents/gemma-supervisor/config';

async function runExperiment() {
  console.log('===============================================================');
  console.log('🚀 RUNNING OPENROUTER GOOGLE GEMMA 4 SUPERVISOR EXPERIMENT');
  console.log('===============================================================\n');

  // Test 1: Basic Reasoning & Connectivity
  console.log('--- TEST 1: Connectivity & Quick Reasoning Test ---');
  const startTime = Date.now();
  try {
    const quickResponse = await gemmaSupervisorAgent.generate(
      'Identify the capital of Nepal, its primary language, and country calling code in 2 short bullet points.'
    );
    const latency = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Gemma 4 responded in ${latency}s:\n`);
    console.log(quickResponse.text);
  } catch (err) {
    console.error('❌ Gemma 4 failed Test 1:', err);
    return;
  }

  // Test 2: Structured Data Synthesis with Scraped Content
  console.log('\n--- TEST 2: Structured Listing Synthesis from Raw Scraped Data ---');

  const sampleSearchSnippets = `
1. Himalayan Java Coffee - Thamel
   URL: https://himalayanjava.com/
   Snippet: Tridevi Marg-26, Thamel, Kathmandu. Phone: +977 1 4512536. info@himalayanjava.com. Opening hours 7:00 AM - 8:30 PM.

2. Mountain Coffee Roasters
   URL: https://mountaincoffee.com.np/contact
   Snippet: Kathmandu, Nepal. Phone: 9861803302. Email: info@mountaincoffee.com.np. Fresh roasted beans and cafe.
  `;

  const sampleMarkdown = `
# Himalayan Java Coffee Head Office
Welcome to Himalayan Java Coffee, Nepal's premier specialty coffee company founded in 1999.
Contact details:
- Address: Purva Dhoka, Nagpokhari Lane, Kathmandu
- Phone: +977 1 4512536 / 01-5919003
- Mobile: +977 9829221456
- Email: info@himalayanjava.com
- Social: https://facebook.com/himalayanjava
  `;

  const prompt = `
Cross-reference the following search snippets and website markdown to extract structured business listings.
Return a JSON object with a "listings" array containing verified: name, location, emails, phones, mobiles, websites, socialLinks, otherDetails, metadata (with confidence 0.0-1.0), and process.

SEARCH SNIPPETS:
${sampleSearchSnippets}

WEBSITE MARKDOWN:
${sampleMarkdown}
  `;

  console.log('Feeding search snippets + website markdown to Gemma Supervisor...');
  const synthStart = Date.now();

  try {
    const synthResponse = await gemmaSupervisorAgent.generate(prompt);
    const synthLatency = ((Date.now() - synthStart) / 1000).toFixed(2);
    console.log(`\n✅ Gemma 4 synthesized listings in ${synthLatency}s!\n`);

    const rawText = synthResponse.text || '';
    console.log('--- GEMMA 4 SUPERVISOR OUTPUT ---');
    console.log(rawText);

    // Verify JSON parseability
    let cleanJson = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
      const parsed = JSON.parse(cleanJson);
      console.log('\n🎉 SUCCESS: Gemma 4 output is 100% VALID JSON!');
      console.log(`Extracted listings count: ${parsed.listings ? parsed.listings.length : Array.isArray(parsed) ? parsed.length : 1}`);
    } catch (parseErr) {
      console.warn('\n⚠️ Output required regex cleanup or had formatting quirks.');
    }
  } catch (err) {
    console.error('❌ Gemma 4 failed Test 2:', err);
  }

  console.log('\n===============================================================');
  console.log('🏁 EXPERIMENT COMPLETED');
  console.log('===============================================================');
}

runExperiment().catch(console.error);
