/**
 * Favicon, page business name, multi-business detection and page aggregation.
 *
 * Phase 4 split of `src/services/business-extractor.service.ts`. Every declaration
 * below is copied byte-exact from the monolith; only the import block is new.
 */

import type { WebsitePageEvidence, WebsiteEvidence, PhoneEvidenceRecord } from '@/types/verification.js';
import type { ClassifiedContact } from '@/types/contact.js';
import { incrementTelemetry } from '@/services/telemetry.service';
import { EXCLUDED_LEGAL_AND_GOV_ENTITIES, QUESTION_STARTER_WORDS } from '@/config/token-vocabulary.config';
import { stripVendorAttribution, isGenericName, domainFromUrlOrHost, extractContextAroundMatch } from '@/services/extraction/content-normalization.service';
import { extractEmails, classifyEmailRole, deduplicateClassifiedContacts } from '@/services/extraction/contact-extractor.service';
import { extractSocialLinks } from '@/services/extraction/social-extractor.service';
import { formatPhoneDisplay, classifyNepalPhone, extractPhones, extractMobiles, extractLandlinesAndIntl, classifyPhoneRole } from '@/services/extraction/phone-extractor.service';
import { extractStructuredBranchBlocks } from '@/services/extraction/branch-extractor.service';
import type { StructuredBranchBlock } from '@/services/extraction/branch-extractor.service';

export function detectTemplateContent(text: string, contextUrl?: string): boolean {
  if (!text) return false;
  let signals = 0;

  // Signal 1: Dummy / celebrity placeholder names in staff / leadership sections
  if (/\b(apollo\s+creed|john\s+doe|jane\s+doe|lorem\s+ipsum|themeforest|envato|templatemonster)\b/i.test(text)) {
    signals++;
  }

  // Signal 2: Template / demo email pattern occurrences
  if (/\b[a-zA-Z0-9._%+-]+@(?:ourschool|myschool|yourschool|demomail|demotheme|template|dummy)\.(?:edu|com|org|net)\b/i.test(text)) {
    signals++;
  }

  // Signal 3: Dummy / template phone format (e.g. +1 6335..., 1234567890, +1 234 567 890, 0123456789)
  if (/(?:\+1[-.\s]?6335\d{3,6}|\+1[-.\s]?234[-.\s]?567[-.\s]?890|\+44[-.\s]?1234[-.\s]?567890|\b1234567890\b|\b0123456789\b)/i.test(text)) {
    signals++;
  }

  // Signal 4: Demo placeholder address / domain indicators
  if (/\b(?:123\s+(?:fake|main|sample)\s+street|your\s+company\s+address|domain\.com|yourdomain\.com)\b/i.test(text)) {
    signals++;
  }

  if (signals >= 2) {
    incrementTelemetry('templateFingerprintMatches');
    return true;
  }
  return false;
}

export function extractFaviconFromHtml(baseUrl: string, html: string): string | undefined {
  if (!html) return undefined;
  const match =
    html.match(/<link\b[^>]*\brel=["'](?:shortcut )?icon["'][^>]*\bhref=["']([^"']+)["']/i) ||
    html.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["'](?:shortcut )?icon["']/i);
  if (match && match[1]) {
    try {
      return new URL(match[1], baseUrl).href;
    } catch {
      return match[1];
    }
  }
  return undefined;
}

export function extractFavicon(
  pages: Array<{ url: string; favicon?: string }>
): string | undefined {
  for (const page of pages) {
    if (page.favicon && page.favicon.trim().length > 0) return page.favicon.trim();
  }
  return undefined;
}

export function extractBusinessInfo(content: string): {
  services: string[];
  hours?: string;
} {
  const result: { services: string[]; hours?: string } = { services: [] };

  if (!content) return result;

  // Hours: first HH:MM AM/PM or HH AM/PM range.
  const hoursMatch = content.match(
    /((?:\d{1,2})(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\s*[-–—to]\s*(?:\d{1,2})(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.))/i
  );
  if (hoursMatch) result.hours = hoursMatch[1].trim();

  // Services: lines following a services-style heading, up to next heading/blank.
  const servicesRegex = /(?:^|\n)\s*(?:our\s+)?(?:services?|what\s+we\s+offer|products?)(?:\s*:)?\s*\n([^\n]{0,1200})/i;
  const match = servicesRegex.exec(content);
  if (match) {
    const block = match[1];
    const lines = block
      .split(/\n|,|•|\u2022|;|\||- {1,3}/)
      .map((l) => l.trim().replace(/^[-•\s]+/, ''))
      .filter((l) => l.length >= 3 && l.length <= 80 && !/^[a-z]+$/i.test(l))
      .slice(0, 10);
    result.services = [...new Set(lines)];
  }

  return result;
}

export interface ExtractedPageBusinessName {
  name: string;
  source: 'schema' | 'h1' | 'og' | 'title';
}

export function extractPageBusinessName(
  rawHtml?: string,
  markdown?: string
): ExtractedPageBusinessName | null {
  // 1. JSON-LD Schema.org name
  if (rawHtml) {
    const schemaMatches = rawHtml.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    );
    for (const match of schemaMatches) {
      try {
        const json = JSON.parse(match[1]);
        const entities = Array.isArray(json) ? json : [json];
        for (const item of entities) {
          const type = (item['@type'] || '').toString().toLowerCase();
          if (
            type.includes('organization') ||
            type.includes('business') ||
            type.includes('store') ||
            type.includes('restaurant') ||
            type.includes('company') ||
            type.includes('service') ||
            type.includes('hotel')
          ) {
            if (
              typeof item.name === 'string' &&
              item.name.trim().length >= 3 &&
              item.name.trim().length <= 70
            ) {
              const cleaned = item.name.trim();
              if (!isGenericName(cleaned)) {
                return { name: cleaned, source: 'schema' };
              }
            }
          }
        }
      } catch {}
    }

    // 2. OpenGraph site_name
    const ogMatch =
      rawHtml.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i) ||
      rawHtml.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
    if (ogMatch && ogMatch[1]) {
      const ogName = ogMatch[1].trim();
      if (ogName.length >= 3 && ogName.length <= 60 && !isGenericName(ogName)) {
        return { name: ogName, source: 'og' };
      }
    }

    // 3. Clean <h1> from HTML
    const h1Match = rawHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match && h1Match[1]) {
      const h1Text = h1Match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (h1Text.length >= 3 && h1Text.length <= 60 && !isGenericName(h1Text)) {
        return { name: h1Text, source: 'h1' };
      }
    }
  }

  // 4. Markdown # Heading
  if (markdown) {
    const mdH1 = markdown.match(/^#\s+([^\n\r]+)/m);
    if (mdH1 && mdH1[1]) {
      const heading = mdH1[1].trim();
      if (heading.length >= 3 && heading.length <= 60 && !isGenericName(heading)) {
        return { name: heading, source: 'h1' };
      }
    }
  }

  // 5. HTML <title> tag (stripping common marketing / location suffixes)
  if (rawHtml) {
    const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      let titleText = titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      titleText = titleText
        .split(/\s*[-–|:]\s*(?:home|official|welcome|about|contact|best|top|kathmandu|nepal|services)/i)[0]
        .trim();
      if (titleText.length >= 3 && titleText.length <= 60 && !isGenericName(titleText)) {
        return { name: titleText, source: 'title' };
      }
    }
  }

  return null;
}

export let llmMultiBusinessCallCount = 0;

export function getLlmMultiBusinessCallCount(): number {
  return llmMultiBusinessCallCount;
}

export function resetLlmMultiBusinessCallCount(): void {
  llmMultiBusinessCallCount = 0;
}

export function detectMultiBusinessPage(
  content: string,
  url?: string,
  businessName?: string
): boolean {
  if (!content) return false;
  const boundedContent = content.length > 50000 ? content.slice(0, 50000) : content;

  if (url) {
    const lowerUrl = url.toLowerCase();
    if (
      lowerUrl.includes('/directory') ||
      lowerUrl.includes('/yellow-pages') ||
      lowerUrl.includes('/yellowpages') ||
      lowerUrl.includes('/listings') ||
      lowerUrl.includes('/category/') ||
      lowerUrl.includes('/categories/') ||
      lowerUrl.includes('/listing/') ||
      lowerUrl.includes('/eatery/') ||
      lowerUrl.includes('skillsewa.com')
    ) {
      return true;
    }
  }

  // 1. Numbered listicle headings (e.g. <h2>1. Apex Hotel... <h2>2. Kathmandu Guest House...)
  // Exclude FAQ questions (e.g. "1. How much does it cost?", "2. Can a foreign company..."), steps, services
  const listicleMatches =
    boundedContent.match(/(?:<h[1-6][^>]*>|^|\n|\.\s+)\s*\d{1,2}\.?\s+(?:Top|Best|[A-Z])[A-Za-z0-9\s&'-]{3,60}/gi) || [];

  const realListicles = listicleMatches.filter((m) => {
    const cleaned = m.replace(/^[^A-Za-z0-9]+/, '').replace(/^\d{1,2}\.?\s*/, '').trim();
    if (cleaned.endsWith('?')) return false;
    if (QUESTION_STARTER_WORDS.test(cleaned)) return false;
    if (/\b(branch|office|step|faq|question|practice|service|publication|attorney|lawyer|doctor|teacher|team)\b/i.test(cleaned)) return false;
    return true;
  });

  if (realListicles.length >= 3) {
    return true;
  }

  // 2. Distinct standalone corporate entities (e.g. "X Pvt Ltd", "Y Suppliers", "Z Traders", "W Enterprises")
  // Strip team rosters and FAQ sections first
  const sanitizedContent = boundedContent
    .replace(/(?:##?\s*(?:Meet Our|Our Team|Attorneys?|Lawyers?|Doctors?|Faculty|Staff|Leadership|Board)[^\n#]{1,1000})/gi, ' ')
    .replace(/(?:##?\s*(?:Frequently Asked Questions|FAQ|Q&A)[^\n#]{1,1000})/gi, ' ');

  const text = sanitizedContent.replace(/<[^>]+>/g, ' ');
  const entityMatches =
    text.match(
      /\b[A-Z][A-Za-z0-9\s&'-]{2,35}\s+(?:Pvt\.?\s*Ltd\.?|Suppliers?|Traders?|Enterprises?|Pvt\b|Limited\b)\b/gi
    ) || [];

  const bTokens = businessName
    ? businessName.toLowerCase().split(/\s+/).filter((t) => t.length > 2)
    : [];

  const filteredEntities = entityMatches.filter((e) => {
    const lower = e.toLowerCase().trim();
    if (lower.includes('branch') || lower.includes('office') || lower.includes('counter')) return false;
    if (EXCLUDED_LEGAL_AND_GOV_ENTITIES.has(lower)) return false;
    if (bTokens.length > 0 && bTokens.some((t) => lower.includes(t))) return false;
    return true;
  });

  const uniqueEntities = new Set(filteredEntities.map((e) => e.trim().toLowerCase()));
  if (uniqueEntities.size >= 4) {
    return true;
  }

  // 3. Multi-business directory / listicle phone dump
  const phones = extractPhones(content);
  const mobiles = extractMobiles(content);
  const totalPhones = new Set([...phones, ...mobiles]);
  if (realListicles.length >= 2 && totalPhones.size >= 4) {
    return true;
  }
  if (uniqueEntities.size >= 3 && totalPhones.size >= 5) {
    return true;
  }

  return false;
}

export async function detectMultiBusinessPageWithLlmFallback(
  content: string,
  url?: string,
  businessName?: string,
  options?: { agent?: any }
): Promise<{ isMulti: boolean; usedLlm: boolean; reason: string }> {
  // Tier 1: Deterministic evaluation
  if (detectMultiBusinessPage(content, url, businessName)) {
    return { isMulti: true, usedLlm: false, reason: 'DETERMINISTIC_MULTI_PAGE' };
  }

  // Borderline check: If page mentions blog-like listicle keywords or 2 distinct entities
  const lowerContent = content.toLowerCase();
  const isBorderline =
    /\b(?:top\s*\d+|best\s*\d+|list\s*of|directory|companies\s*in|services\s*in)\b/i.test(
      lowerContent.slice(0, 4000)
    );

  if (isBorderline && options?.agent && llmMultiBusinessCallCount < 10) {
    llmMultiBusinessCallCount++;
    try {
      const promptSnippet = content.slice(0, 4000);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const prompt = `Analyze this webpage content snippet. Is this a multi-business aggregator/directory/blog listing multiple companies, or is it the official single business website for "${businessName || 'the company'}"? Respond ONLY with a JSON object: {"isMultiBusiness": true/false, "reason": "short explanation"}`;

      const res = await options.agent.generate([
        { role: 'user', content: `${prompt}\n\nContent:\n${promptSnippet}` },
      ]);
      clearTimeout(timeoutId);

      const parsed = JSON.parse(res.text?.trim() || '{}');
      return {
        isMulti: Boolean(parsed.isMultiBusiness),
        usedLlm: true,
        reason: parsed.reason || 'LLM_CLASSIFICATION',
      };
    } catch {
      return { isMulti: false, usedLlm: true, reason: 'LLM_FALLBACK_TIMEOUT' };
    }
  }

  return { isMulti: false, usedLlm: false, reason: 'DETERMINISTIC_SINGLE_PAGE' };
}

export function extractAllFromPages(
  pages: WebsitePageEvidence[],
  businessName?: string,
  websiteUrl?: string
): Omit<WebsiteEvidence, 'url' | 'domain' | 'pages'> {
  const successful = pages.filter((p) => p.success && (p.content || p.rawHtml)).map((p) => ({
    ...p,
    content: stripVendorAttribution(p.content || ''),
    rawHtml: stripVendorAttribution(p.rawHtml || ''),
  }));

  const combinedMarkdown = successful.map((p) => p.content).filter(Boolean).join('\n\n');
  const websiteDomain = websiteUrl ? domainFromUrlOrHost(websiteUrl) : undefined;

  // 1. Emails: extracted from both clean markdown and rawHtml safety net
  const emailSet = new Set<string>();
  const phoneSet = new Set<string>();        // display strings (landlines + intl)
  const mobileSet = new Set<string>();       // display strings (mobiles)
  const phoneDigitsSeen = new Set<string>(); // canonical dedup for phones
  const mobileDigitsSeen = new Set<string>(); // canonical dedup for mobiles
  const allPhoneEvidence: PhoneEvidenceRecord[] = [];
  const allClassifiedContacts: ClassifiedContact[] = [];

  // Extract structured branch blocks across pages
  const pageBranchBlocks = new Map<string, StructuredBranchBlock[]>();
  for (const page of successful) {
    const blocks = extractStructuredBranchBlocks(page.rawHtml || page.content || '', businessName, page.url);
    if (blocks.length > 0) {
      pageBranchBlocks.set(page.url, blocks);
    }
  }

  const findMatchingBranchBlock = (pageUrl: string, contactValue: string): StructuredBranchBlock | undefined => {
    const blocks = pageBranchBlocks.get(pageUrl) || [];
    const digits = contactValue.replace(/\D/g, '');
    for (const b of blocks) {
      if (b.emails.includes(contactValue)) return b;
      if (digits.length >= 7) {
        const hasPhone = [...b.phones, ...b.mobiles].some((p) => p.replace(/\D/g, '').includes(digits) || digits.includes(p.replace(/\D/g, '')));
        if (hasPhone) return b;
      }
      if (b.rawContent.includes(contactValue)) return b;
    }
    return undefined;
  };

  // Classify extracted emails with context
  for (const page of successful) {
    const pageUrl = page.url;
    const pageText = (page.content || '') + '\n' + (page.rawHtml || '');

    // Phase 8g: Multi-entity directory gate — reject contacts if page mentions >=3 distinct businesses
    if (detectMultiBusinessPage(pageText, pageUrl, businessName)) {
      continue;
    }

    for (const email of extractEmails(pageText)) {
      emailSet.add(email);
      const matchingBlock = findMatchingBranchBlock(pageUrl, email);
      const ctx = matchingBlock
        ? `${matchingBlock.branchLabel}: ${matchingBlock.address || matchingBlock.heading}`
        : extractContextAroundMatch(pageText, email);
      const role = classifyEmailRole(email, ctx, businessName, websiteDomain);
      allClassifiedContacts.push({
        value: email,
        type: 'email',
        role: role.role,
        owner: matchingBlock ? 'branch' : role.owner,
        channels: [],
        context: ctx || undefined,
        blockId: matchingBlock?.blockId,
        pageUrl,
      });
    }
  }

  const processCandidate = (raw: string, source: PhoneEvidenceRecord['source'], pageUrl: string, pageText?: string) => {
    const classified = classifyNepalPhone(raw);
    const display = formatPhoneDisplay(classified.digits, classified.type, raw);
    const evidence: PhoneEvidenceRecord = {
      raw,
      canonicalDigits: classified.digits,
      display,
      type: classified.type,
      source,
      pageUrl,
      reason: classified.reason,
    };
    allPhoneEvidence.push(evidence);

    const matchingBlock = findMatchingBranchBlock(pageUrl, raw);
    const context = matchingBlock
      ? `${matchingBlock.branchLabel}: ${matchingBlock.address || matchingBlock.heading}`
      : pageText
      ? extractContextAroundMatch(pageText, raw)
      : '';

    // Group E (W3-10): Demo / Template placeholder filter
    if (
      detectTemplateContent(context) ||
      detectTemplateContent(raw) ||
      /(?:\+1[-.\s]?6335\d{3,6}|\+1[-.\s]?234[-.\s]?567[-.\s]?890|\+44[-.\s]?1234[-.\s]?567890|\b1234567890\b|\b0123456789\b)/i.test(raw)
    ) {
      return;
    }

    const phoneRole = classifyPhoneRole(raw, context, businessName, classified, pageUrl);

    if (classified.type !== 'invalid') {
      allClassifiedContacts.push({
        value: display,
        canonicalDigits: classified.digits,
        type: 'phone',
        phoneType: classified.type,
        role: phoneRole.role,
        owner: matchingBlock ? 'branch' : phoneRole.owner,
        channels: phoneRole.channels,
        associatedPerson: phoneRole.associatedPerson,
        associatedJobTitle: phoneRole.associatedJobTitle,
        context: context || undefined,
        blockId: matchingBlock?.blockId,
        pageUrl,
      });
    }

    if (classified.type === 'mobile') {
      if (!mobileDigitsSeen.has(classified.digits)) {
        mobileDigitsSeen.add(classified.digits);
        mobileSet.add(display);
      }
    } else if (classified.type === 'landline' || classified.type === 'international') {
      if (!phoneDigitsSeen.has(classified.digits)) {
        phoneDigitsSeen.add(classified.digits);
        phoneSet.add(display);
      }
    }
  };

  for (const page of successful) {
    const pageUrl = page.url;
    const pageText = (page.content || '') + '\n' + (page.rawHtml || '');

    // Phase 8g: Multi-entity directory gate — reject contacts if page mentions >=3 distinct businesses
    if (detectMultiBusinessPage(pageText, pageUrl, businessName)) {
      continue;
    }

    if (page.content) {
      for (const raw of extractLandlinesAndIntl(page.content)) processCandidate(raw, 'markdown', pageUrl, page.content);
      for (const raw of extractMobiles(page.content)) processCandidate(raw, 'markdown', pageUrl, page.content);
    }

    if (page.rawHtml) {
      for (const raw of extractLandlinesAndIntl(page.rawHtml)) processCandidate(raw, 'rawHtml', pageUrl, page.rawHtml);
      for (const raw of extractMobiles(page.rawHtml)) processCandidate(raw, 'rawHtml', pageUrl, page.rawHtml);
    }
  }

  // 3. Socials: extracted from markdown links + raw HTML href attributes
  const allSocialSources = [
    combinedMarkdown,
    ...successful.map((p) => p.rawHtml).filter(Boolean) as string[],
  ].join('\n');
  const socialLinks = extractSocialLinks(allSocialSources, { businessName, websiteDomain });

  // 4. Services and Hours: ONLY from markdown prose (clean text, no HTML tags)
  const info = extractBusinessInfo(combinedMarkdown);

  // 5. Favicon: from Tavily first, or extracted from raw HTML
  let favicon = extractFavicon(successful) || '';
  if (!favicon) {
    for (const p of successful) {
      if (p.rawHtml) {
        const fav = extractFaviconFromHtml(p.url, p.rawHtml);
        if (fav) {
          favicon = fav;
          break;
        }
      }
    }
  }

  // Lean summary: from clean markdown ONLY, never raw HTML
  const summaryParts = successful
    .filter((p) => p.content)
    .slice(0, 3)
    .map((p) => p.content.replace(/\s+/g, ' ').slice(0, 200));
  const rawContentSummary = summaryParts.join(' ... ').slice(0, 600);

  const deduplicatedContacts = deduplicateClassifiedContacts(allClassifiedContacts);

  return {
    extractedEmails: [...emailSet],
    extractedPhones: [...phoneSet],
    extractedMobiles: [...mobileSet],
    extractedPhoneEvidence: allPhoneEvidence.length > 0 ? allPhoneEvidence : undefined,
    extractedClassifiedContacts: deduplicatedContacts.length > 0 ? deduplicatedContacts : undefined,
    extractedSocialLinks: socialLinks,
    extractedServices: info.services,
    extractedHours: info.hours,
    favicon,
    rawContentSummary: rawContentSummary || undefined,
  };
}
