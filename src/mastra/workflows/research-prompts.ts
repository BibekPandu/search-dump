/**
 * Supervisor prompt synthesis for research workflow.
 */
import type { UnifiedSearchResult } from '@/types/search';
import type { VerifiedBusinessEvidence } from '@/types/verification';

export function buildSupervisorPrompt(
  query: string,
  location: string | undefined,
  candidates: Array<UnifiedSearchResult>,
  extractions: Array<{ url: string; content: string; favicon: string; success: boolean }>,
  verifiedEvidence?: Array<VerifiedBusinessEvidence>
): string {
  const candidateList = candidates
    .map((c, i) => {
      if (c.source === 'google_maps') {
        const hasSite = c.domain && !c.domain.includes('google.com');
        return `${c.rank ?? i + 1}. ${c.title} [Google Maps Verified Business]
   Address: ${c.address || location || 'N/A'}
   Phone: ${c.phoneNumber || 'N/A'}
   Rating: ${c.rating ? `${c.rating} (${c.ratingCount || 0} reviews)` : 'N/A'}
   Category: ${c.businessType || 'Business'}
   Website: ${hasSite ? c.url : 'None (Local Tradesman / Storefront)'}
   GPS: ${c.latitude && c.longitude ? `${c.latitude}, ${c.longitude}` : 'N/A'}`;
      }
      return `${c.rank ?? i + 1}. ${c.title}${c.domain ? ` [${c.domain}]` : ''}\n   URL: ${c.url}\n   Snippet: ${c.description}`;
    })
    .join('\n\n');

  const deepVerified = verifiedEvidence && verifiedEvidence.length > 0;

  // Evidence-first mode: authoritative verified blocks replace raw page dumps.
  // The supervisor gets structured contact fields to use EXACTLY, plus a small
  // page-context summary (≤5k per candidate) for description/summary purposes.
  let evidenceBlocks = '';
  let extractionBlocks = extractions
    .filter((e) => e.success && e.content)
    .map(
      (e) =>
        `--- EXTRACTION from ${e.url} ---\nFavicon: ${e.favicon}\n\n${e.content.slice(0, 30000)}\n--- END ---`
    )
    .join('\n\n');

  if (deepVerified && verifiedEvidence) {
    evidenceBlocks = verifiedEvidence
      .map((ev, i) => {
        const c = ev.candidate;
        const w = ev.websiteEvidence;
        const lines = [
          `--- VERIFIED EVIDENCE ${i + 1}: ${c.name} ---`,
          `Identity (Google Maps authority — never overwrite): address=${c.location || 'N/A'}; phone=${c.phone || 'N/A'}; gps=${c.coordinates ? `${c.coordinates.lat}, ${c.coordinates.lng}` : 'N/A'}; rating=${c.rating ?? 'N/A'} (${c.ratingCount ?? 0} reviews); placeId=${c.sources.googleMaps?.placeId || 'N/A'}; category=${c.category || 'N/A'}`,
          `Official website: ${c.website || 'NONE'}`,
          `Verification: status=${ev.verification.status}; confidence=${ev.verification.overallConfidence}`,
        ];
        if (w) {
          lines.push(
            `EVIDENCE-BACKED CONTACT FIELDS (use these EXACTLY — do not invent or merge other values):
  emails: ${JSON.stringify(w.extractedEmails)}
  phones: ${JSON.stringify(w.extractedPhones)}
  mobiles: ${JSON.stringify(w.extractedMobiles)}
  socialLinks: ${JSON.stringify(w.extractedSocialLinks)}
  services: ${JSON.stringify(w.extractedServices)}
  hours: ${w.extractedHours || 'N/A'}
  favicon: ${w.favicon || 'N/A'}`
          );
          if (w.rawContentSummary) {
            lines.push(`PAGE CONTEXT (for otherDetails summary ONLY):\n${w.rawContentSummary}`);
          }
        } else {
          lines.push(
            `NO WEBSITE EVIDENCE — leave emails and socialLinks empty; the ONLY supported phone is the Maps phone above.`
          );
        }
        lines.push(`--- END EVIDENCE ${i + 1} ---`);
        return lines.join('\n');
      })
      .join('\n\n');

    // Raw content is context-only in evidence mode: much smaller slices.
    extractionBlocks = extractions
      .filter((e) => e.success && e.content)
      .map((e) => `--- RAW CONTEXT from ${e.url} (for summary ONLY — not a contact source) ---\n${e.content.slice(0, 5000)}\n--- END ---`)
      .join('\n\n');
  }

  return `You are an expert business data research supervisor. Your job is to cross-examine Google Maps verified places and extracted website content to produce accurate, structured business listings.

USER QUERY: "${query}"${location ? ` in ${location}` : ''}

SEARCH RESULTS & VERIFIED PLACES:

${candidateList}

${evidenceBlocks ? `\nVERIFIED EVIDENCE (authoritative — deterministic extraction):\n\n${evidenceBlocks}\n` : ''}

EXTRACTED WEBSITE CONTENT (from Tavily):

${extractionBlocks || 'No extracted content available.'}

CRITICAL EVIDENCE RULES (structured contact fields):
${deepVerified ? `- The VERIFIED EVIDENCE blocks above are AUTHORITATIVE for emails, phones, mobiles, socialLinks, and websites. Use those EXACT values. NEVER invent, guess, or merge contact values from raw page context.\n- Raw page context is for otherDetails summary ONLY — never a contact source.` : `- Only include emails/phones/mobiles/socialLinks that are explicitly present in the content above. If none are present, leave them empty.`}
- Leave every field empty when no supported value exists. An empty field is always correct; an invented value is always wrong.
- Never modify Google Maps identity fields (address, Maps phone, GPS, rating, ratingCount, placeId).

YOUR TASK:
1. Synthesize all verified businesses. Note that local tradesmen or storefronts from Google Maps may NOT have websites — ALWAYS include them with verified phone numbers, address, and ratings!
2. For each business, extract/populate the following fields:
   - name: Official business name
   - location: Street address, area, city (e.g. "Durbar Marg, Kathmandu")
   - emails: Array of email addresses found on the website (or empty)
   - phones: Array of landline numbers (e.g. "+977-1-4240520")
   - mobiles: Array of mobile numbers (e.g. "+977-9801234567" or "982-9469962")
   - websites: Array of official website URLs (empty array if no website)
   - icon: Favicon URL from extracted content (or empty)
   - socialLinks: { facebook, tiktok, instagram, other: {} }
   - otherDetails: { address, rating, ratingCount, category, description, ... }
   - gpsCoordinates: { latitude, longitude } if available from Google Maps
   - rating: numeric rating (e.g. 4.8)
   - ratingCount: review count
   - businessType: category or trade (e.g. "Plumber", "Hotel")
   - placeId: place identifier if provided
   - metadata: { source: "google_maps" or URL, extractedAt: current ISO timestamp, confidence: 0.0-1.0 }
   - process: How you verified this listing (e.g. "Verified via Google Maps Places" or "Verified via official website")
   - links: All relevant URLs discovered

3. Deduplicate: If the same business appears in both Google Maps and Web search, merge the data.
4. Filter: Remove results that are clearly aggregators, blogs, or directory portals (e.g. booking.com, tripadvisor, yellowpages).
5. Confidence scoring:
   - 0.9-1.0: Verified Google Maps business or official website
   - 0.7-0.8: Found in search results with some extracted data
   - 0.5-0.6: Found in search results only, limited data
   - Below 0.5: Uncertain or incomplete data

6. Return the listings as a JSON object matching the output schema exactly. No markdown, no explanation — just valid JSON.`;
}
