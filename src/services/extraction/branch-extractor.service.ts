/**
 * Structured branch-block extraction and address cleanup.
 *
 * Phase 4 split of `src/services/business-extractor.service.ts`. Every declaration
 * below is copied byte-exact from the monolith; only the import block is new.
 */

import { NEPAL_BRANCH_LOCALITIES } from '@/config/token-vocabulary.config';
import { extractEmails } from '@/services/extraction/contact-extractor.service';
import { classifyNepalPhone, extractPhones, extractMobiles, extractLandlinesAndIntl } from '@/services/extraction/phone-extractor.service';

export function cleanBranchAddress(
  rawContextOrAddress: string,
  businessName?: string
): string | undefined {
  if (!rawContextOrAddress) return undefined;

  let cleaned = rawContextOrAddress
    // 1. Remove Markdown images, links, and orphaned link brackets
    .replace(/!\[.*?\]\([^)]*\)/g, '')
    .replace(/\[(.*?)\]\([^)]*\)/g, '$1')
    .replace(/\]\s*\([^\)]*\)?/g, ' ')
    .replace(/\[[^\]]*$/g, ' ')
    // 2. Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // 3. Remove URLs
    .replace(/https?:\/\/\S+/g, '')
    // 4. Remove Markdown formatting characters
    .replace(/[#*`_~]/g, '')
    // 5. Remove image file paths and artifacts
    .replace(/[a-zA-Z0-9_\-\.\/]*\.(?:png|jpe?g|webp|gif|svg)\b/gi, '')
    // 6. Remove HTML attribute fragments (e.g. mage" ="\" loading="lazy" /> or loading="lazy")
    .replace(/\b(?:loading|alt|src|href|class|style|id|target|rel|width|height)=["'][^"']*["']/gi, '')
    .replace(/\b(?:loading|alt|src|href|class|style|id|target|rel|width|height)=\S+/gi, '')
    .replace(/\b(?:mage|image)\s*["'=]/gi, '')
    // 7. Remove phone numbers & emails (including partial or international)
    .replace(/(?:\+?977[-.\s]?)?(?:\(?0?\d{1,4}\)?[-.\s]?)?\d{4,10}\b/g, '')
    .replace(/\+\d{1,4}[-.\s]?\d+/g, '')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '')
    // 8. Remove common CTA / navigation / noise phrases
    .replace(/\b(?:get direction|get directions|view direction|view on map|view map|view location|find us|find our offices?|our offices?|free consultation|send email|follow us on|testimonials?|real students|read more|more about us|about us|click here|contact us|call now|open hours?|opening hours?|office hours?)\b/gi, '')
    // 9. Clean quotes, brackets, slashes
    .replace(/["'\\/<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip leading/trailing non-alphanumeric punctuation
  cleaned = cleaned.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9)]+$/, '').trim();

  // If business name is at the start (e.g. "CSC New Baneshwor, Kathmandu"), clean it
  if (businessName && cleaned.toLowerCase().startsWith(businessName.toLowerCase())) {
    const afterName = cleaned.slice(businessName.length).replace(/^[\s,:-]+/, '').trim();
    if (afterName.length >= 3) {
      cleaned = afterName;
    }
  }

  // Final check: must be meaningful length and not look like standalone noise
  if (cleaned.length < 3 || /^(?:branch|office|outlet|location|contact|phone|tel|email|fax)$/i.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}

export interface StructuredBranchBlock {
  blockId: string;
  heading: string;
  branchLabel: string;
  address?: string;
  phones: string[];
  mobiles: string[];
  emails: string[];
  rawContent: string;
  pageUrl?: string;
}

export function extractStructuredBranchBlocks(
  htmlOrContent: string,
  businessName?: string,
  pageUrl?: string
): StructuredBranchBlock[] {
  if (!htmlOrContent) return [];

  const blocks: StructuredBranchBlock[] = [];
  const sectionSplitPattern = /(?:<h[1-6][^>]*>([^<]{1,200})<\/h[1-6]>|<(?:strong|b)[^>]*>([^<]{1,200})<\/(?:strong|b)>|(?:\r?\n|^)\s*#{1,6}\s+([^\r\n#]{1,200})|(?:\r?\n|^)\s*\*\*([^*\r\n]{1,200})\*\*)/gi;

  const matches: Array<{ heading: string; index: number; length: number }> = [];
  let m: RegExpExecArray | null;

  while ((m = sectionSplitPattern.exec(htmlOrContent)) !== null) {
    const rawHeading = (m[1] || m[2] || m[3] || m[4] || '').split(/\r?\n/)[0];
    const cleanHeading = rawHeading.replace(/<[^>]*>/g, '').replace(/[*#]/g, '').replace(/\s+/g, ' ').trim();
    if (!cleanHeading || cleanHeading.length < 2 || cleanHeading.length > 150) continue;

    const lower = cleanHeading.toLowerCase();
    const hasBranchWord = /\b(branch|branches|office|offices|outlet|outlets|center|centre|location|locations)\b/i.test(lower);
    const hasLocality = NEPAL_BRANCH_LOCALITIES.some((loc) => {
      const regex = new RegExp(`\\b${loc}\\b`, 'i');
      return regex.test(lower);
    });

    if (hasBranchWord || hasLocality) {
      matches.push({
        heading: cleanHeading,
        index: m.index,
        length: m[0].length,
      });
    }
  }

  if (matches.length === 0) return [];

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const startIndex = current.index;
    const nextStart = i < matches.length - 1 ? matches[i + 1].index : htmlOrContent.length;
    const blockContent = htmlOrContent.slice(startIndex, Math.min(startIndex + 1500, nextStart));

    let branchLabel = current.heading;
    const lowerHeading = current.heading.toLowerCase();
    const matchedLocality = NEPAL_BRANCH_LOCALITIES.find((loc) => {
      const regex = new RegExp(`\\b${loc}\\b`, 'i');
      return regex.test(lowerHeading);
    });

    if (matchedLocality) {
      const formattedLoc = matchedLocality.charAt(0).toUpperCase() + matchedLocality.slice(1);
      if (!lowerHeading.includes('branch') && !lowerHeading.includes('office')) {
        branchLabel = `${formattedLoc} Branch`;
      } else {
        branchLabel = current.heading;
      }
    }

    const cleanAddr = cleanBranchAddress(current.heading + '\n' + blockContent.slice(0, 300), businessName);

    const blockPhones = extractLandlinesAndIntl(blockContent);
    const blockMobiles = extractMobiles(blockContent);
    const blockEmails = extractEmails(blockContent);

    const landlines: string[] = [];
    const mobiles: string[] = [];
    for (const p of blockPhones) {
      const classified = classifyNepalPhone(p);
      if (classified.type === 'mobile') {
        if (!mobiles.includes(p)) mobiles.push(p);
      } else {
        if (!landlines.includes(p)) landlines.push(p);
      }
    }
    for (const p of blockMobiles) {
      if (!mobiles.includes(p)) mobiles.push(p);
    }

    // Skip generic section wrappers (e.g. "<h2>Our Offices</h2>") that lack contacts and specific locality
    if (landlines.length === 0 && mobiles.length === 0 && blockEmails.length === 0 && !matchedLocality) {
      continue;
    }

    const blockId = `branch-${(matchedLocality || branchLabel).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    blocks.push({
      blockId,
      heading: current.heading,
      branchLabel,
      address: cleanAddr,
      phones: landlines,
      mobiles,
      emails: blockEmails,
      rawContent: blockContent,
      pageUrl,
    });
  }

  return blocks;
}
