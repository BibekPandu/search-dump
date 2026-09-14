import 'dotenv/config';
import { searchWithFallback } from '../src/services/search-fallback.service';
import { isUsableOfficialWebsite } from '../src/services/entity-resolution.service';

async function testLookups() {
  const queries = [
    'MountBrew Coffee Kathmandu',
    'The Third Space Cafe Kathmandu',
    'Dhaulagiri specialty coffee and roastery Kathmandu',
    'Arabica Specialty Coffee House Kathmandu',
  ];

  for (const q of queries) {
    console.log(`\n--- Searching: "${q}" ---`);
    const res = await searchWithFallback(q, undefined, 5, 1);
    for (const r of res.results) {
      const usable = isUsableOfficialWebsite(r.url);
      console.log(`- [${usable ? 'OFFICIAL' : 'EXCLUDED'}] ${r.title}: ${r.url}`);
      if (r.description) {
        console.log(`  Snippet: ${r.description.slice(0, 100)}...`);
      }
    }
  }
}

testLookups();
