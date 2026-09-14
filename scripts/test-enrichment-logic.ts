import 'dotenv/config';
import { searchSerperPlaces } from '../src/services/serper-places.service';
import { searchWithFallback } from '../src/services/search-fallback.service';
import { isUsableOfficialWebsite, rankWebsiteLookupTargets } from '../src/services/entity-resolution.service';
import { extractPhones, extractMobiles, extractSocialLinks } from '../src/services/business-extractor.service';

async function main() {
  console.log('--- Testing Serper Places Query ---');
  const places = await searchSerperPlaces('specialty coffee', { location: 'Kathmandu' });
  console.log(`Found ${places.length} raw places:`);
  places.slice(0, 10).forEach((p, i) => {
    console.log(`${i + 1}. "${p.title}" | phone: ${p.phoneNumber || 'NONE'} | site: ${p.website || 'NONE'}`);
  });

  const placesNeedingEnrichment = places.slice(0, 10).filter(
    (p) => !p.website || p.website.trim().length === 0 || !p.phoneNumber || p.phoneNumber.trim().length === 0
  );
  console.log(`\nPlaces needing enrichment: ${placesNeedingEnrichment.length}`);

  const targets = rankWebsiteLookupTargets(placesNeedingEnrichment, 10);
  console.log(`Target lookups count: ${targets.length}`);

  for (const place of targets) {
    console.log(`\nEnriching: "${place.title}"...`);
    const q = `${place.title} Kathmandu`;
    const res = await searchWithFallback(q, undefined, 5, 1);
    
    // Website
    if (!place.website) {
      const site = res.results.find((r) => isUsableOfficialWebsite(r.url));
      if (site) {
        place.website = site.url;
        console.log(`  -> Discovered Website: ${site.url}`);
      }
    }

    // Phone
    if (!place.phoneNumber) {
      const text = res.results.map((r) => `${r.title} ${r.description} ${(r.extraSnippets || []).join(' ')}`).join('\n');
      const phones = [...extractPhones(text), ...extractMobiles(text)];
      if (phones.length > 0) {
        place.phoneNumber = phones[0];
        console.log(`  -> Discovered Phone: ${place.phoneNumber}`);
      }
    }

    // Socials
    const socials = extractSocialLinks(res.results.map((r) => r.url).join(' '));
    console.log(`  -> Socials: ${JSON.stringify(socials)}`);
  }

  console.log('\n--- Final Enriched Places (Top 10) ---');
  places.slice(0, 10).forEach((p, i) => {
    console.log(`${i + 1}. "${p.title}" | phone: ${p.phoneNumber || 'NONE'} | site: ${p.website || 'NONE'}`);
  });
}

main().catch(console.error);
