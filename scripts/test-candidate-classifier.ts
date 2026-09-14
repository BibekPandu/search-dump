import fs from 'fs';
import path from 'path';
import { filterSearchResults } from '../src/services/candidate-classifier.service';
import { type UnifiedSearchResult } from '../src/services/search-fallback.service';

async function runClassifierBenchmark() {
  console.log('===============================================================');
  console.log('🧪 TESTING DETERMINISTIC CANDIDATE CLASSIFIER (ZERO API COST)');
  console.log('===============================================================\n');

  // Load real Kathmandu hotels search fixture
  const fixturePath = path.resolve(process.cwd(), 'output/runs/2026-09-10T07-38-41-840Z-hotels/1-broad-search.json');
  let candidates: UnifiedSearchResult[] = [];

  if (fs.existsSync(fixturePath)) {
    const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    candidates = fixtureData.results || [];
  } else {
    // Hardcoded fallback fixture identical to Kathmandu hotels run
    candidates = [
      { rank: 1, title: '10 Best Kathmandu Hotels, Nepal', url: 'https://booking.com/city/np/kathmandu.html', originalUrl: '', domain: 'booking.com', description: 'Hotel Barahi Kathmandu provides air-conditioned rooms', extraSnippets: [], provider: 'serper' },
      { rank: 2, title: '10 Best Luxury Hotels in Kathmandu', url: 'https://hotels.com/luxury-hotels-kathmandu-nepal', originalUrl: '', domain: 'hotels.com', description: 'Luxury Hotels in Kathmandu · 1. The Dwarika\'s', extraSnippets: [], provider: 'serper' },
      { rank: 3, title: '11 Best Hotels in Kathmandu, Nepal', url: 'https://agoda.com/city/kathmandu-np.html', originalUrl: '', domain: 'agoda.com', description: 'Find hotels in Kathmandu, Nepal', extraSnippets: [], provider: 'serper' },
      { rank: 4, title: 'Hotels in Kathmandu', url: 'https://goibibo.com/hotels-international/hotels-in-kathmandu-ct', originalUrl: '', domain: 'goibibo.com', description: 'Best luxury hotels in Kathmandu are Kavya Himalayas', extraSnippets: [], provider: 'serper' },
      { rank: 5, title: 'THE 10 BEST Hotels in Kathmandu, Nepal 2026', url: 'https://tripadvisor.com/Hotels-g293890-Kathmandu-Hotels.html', originalUrl: '', domain: 'tripadvisor.com', description: 'Find the right hotel for you', extraSnippets: [], provider: 'serper' },
      { rank: 6, title: 'Where to Stay in Kathmandu, Nepal: Hotels, Guesthouses ...', url: 'https://thecommonwanderer.com/blog/where-to-stay-in-kathmandu-nepal', originalUrl: '', domain: 'thecommonwanderer.com', description: 'LUXURY HOTELS IN KATHMANDU · DWARIKA\'S HOTEL', extraSnippets: [], provider: 'serper' },
      { rank: 7, title: '5 Star Hotels in Kathmandu | IHCL Hotels', url: 'https://tajhotels.com/en-in/destination/hotels-in-kathmandu', originalUrl: '', domain: 'tajhotels.com', description: 'Located in the vibrant Patan district, our luxury hotel in Kathmandu whisks guests into an oasis of modern comforts', extraSnippets: [], provider: 'serper' },
      { rank: 8, title: 'List of Kathmandu Hotels', url: 'https://hotelscombined.com/Kathmandu-Hotels.hotelist.ksp', originalUrl: '', domain: 'hotelscombined.com', description: 'Directory of 2,269 Kathmandu Hotels', extraSnippets: [], provider: 'serper' },
      { rank: 9, title: 'Hotels in Kathmandu Book with FREE Cancellation', url: 'https://makemytrip.com/hotels-international/nepal/kathmandu-hotels', originalUrl: '', domain: 'makemytrip.com', description: 'Some popular Kathmandu hotels include Norbulinka Boutique Hotel', extraSnippets: [], provider: 'serper' },
    ];
  }

  console.log(`Evaluating ${candidates.length} search results from Kathmandu hotels fixture...`);
  const { usable, excluded, ambiguous } = filterSearchResults(candidates);

  console.log(`\n--- Classification Summary ---`);
  console.log(`Usable Candidates:   ${usable.length}`);
  console.log(`Excluded Candidates: ${excluded.length}`);
  console.log(`Ambiguous Candidates: ${ambiguous.length}\n`);

  console.log('✅ Usable Candidate:');
  for (const u of usable) {
    console.log(`  - [${u.decision.classification}] ${u.candidate.title} (${u.candidate.url}) -> ${u.decision.reason}`);
  }

  console.log('\n❌ Excluded Candidates:');
  for (const e of excluded) {
    console.log(`  - [${e.decision.classification}] ${e.candidate.title} (${e.candidate.url}) -> ${e.decision.reason}`);
  }

  // Verification Assertions
  const tajSurvives = usable.some((u) => u.candidate.domain.includes('tajhotels.com') && u.decision.classification === 'business');
  const aggregatorsExcluded = excluded.filter((e) => e.decision.classification === 'aggregator').length === 7;
  const articleExcluded = excluded.filter((e) => e.decision.classification === 'article').length === 1;
  const zeroAmbiguous = ambiguous.length === 0;

  console.log('\n--- Verification Checks ---');
  console.log(`Taj Hotels classified as usable business: ${tajSurvives ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`7 Aggregators classified & excluded:       ${aggregatorsExcluded ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`1 Blog/Article classified & excluded:      ${articleExcluded ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`0 Unresolved ambiguous items:              ${zeroAmbiguous ? 'PASS ✅' : 'FAIL ❌'}`);

  if (tajSurvives && aggregatorsExcluded && articleExcluded && zeroAmbiguous) {
    console.log('\n🎉 CLASSIFIER BENCHMARK PASSED 100%! All 9 items accurately classified without any LLM cost.\n');
  } else {
    console.error('\n❌ CLASSIFIER BENCHMARK FAILED. Details:', { tajSurvives, aggregatorsExcluded, articleExcluded, zeroAmbiguous });
    process.exit(1);
  }
}

runClassifierBenchmark().catch(console.error);
