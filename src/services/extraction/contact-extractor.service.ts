/**
 * Email extraction and contact-role evaluation.
 *
 * Phase 4 split of `src/services/business-extractor.service.ts`. Every declaration
 * below is copied byte-exact from the monolith; only the import block is new.
 */

import type { ContactRole, ContactOwner, ClassifiedContact } from '@/types/contact.js';
import { PLATFORM_DOMAINS, BUSINESS_EMAIL_PREFIXES, CONSUMER_EMAIL_DOMAINS, OWNER_LEADERSHIP_TITLES, STAFF_TITLES } from '@/config/token-vocabulary.config';
import { MEDIA_FILENAME_PATTERN, MEDIA_DPR_PATTERN, IMAGE_FILE_TLDS, EMAIL_REGEX, PLACEHOLDER_EMAIL_PATTERNS } from '@/services/extraction/extraction-regex';
import { classifyPageType } from '@/services/extraction/page-type.service';
import type { PageType } from '@/services/extraction/page-type.service';
import { stripHtmlTags, decodeCloudflareEmail, decodeObfuscatedEmails, extractMailtoEmails } from '@/services/extraction/content-normalization.service';

export function sanitizeEmailString(raw: string): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^[\s<(\['"`\\*]+/, '')
    .replace(/[\s>)\]'"`\\*.,;:!]+$/, '')
    .toLowerCase();
}

export function extractEmails(content: string): string[] {
  if (!content) return [];

  const cloudflareEmails = decodeCloudflareEmail(content);
  const obfuscatedEmails = decodeObfuscatedEmails(content);
  const mailtoEmails = extractMailtoEmails(content);

  const text = stripHtmlTags(content);
  const found = text.match(EMAIL_REGEX) || [];

  const allEmails = [...cloudflareEmails, ...obfuscatedEmails, ...mailtoEmails, ...found];
  const unique = new Set<string>();
  for (let raw of allEmails) {
    let email = raw.trim();
    if (!email) continue;
    // Detach glued words from markdown before lowercasing (e.g. gmail.comOpening -> gmail.com)
    const gluedMatch = email.match(
      /^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(?:edu\.np|com\.np|org\.np|gov\.np|net\.np|mil\.np|com|org|net|edu|gov|io|co|np|biz|info))([A-Z].*)$/
    );
    if (gluedMatch) {
      email = gluedMatch[1];
    }
    email = sanitizeEmailString(email);
    if (!email) continue;
    if (PLACEHOLDER_EMAIL_PATTERNS.some((pattern) => pattern.test(email))) continue;
    // Task 5: Reject media filenames and DPR retina assets misparsed as emails
    if (MEDIA_FILENAME_PATTERN.test(email) || MEDIA_DPR_PATTERN.test(email)) continue;
    if (email.includes(' ') || !email.includes('@')) continue;
    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?$/.test(email)) continue;

    // Reject emails whose final domain segment is a single character (e.g. .n)
    const emailDomain = email.split('@')[1]?.toLowerCase() ?? '';
    const tld = emailDomain.split('.').pop() ?? '';
    if (tld.length < 2) continue;

    // Phase 8g: Reject invalid / typo Nepal ccTLDs (e.g. .co.np is a typo for .com.np)
    if (emailDomain.endsWith('.co.np')) continue;

    // Task 5: Reject emails whose domain ends with an image/media file extension
    if (IMAGE_FILE_TLDS.has(tld)) continue;

    unique.add(email);
  }
  return [...unique];
}

export function classifyEmailRole(
  email: string,
  context: string = '',
  businessName?: string,
  websiteDomain?: string
): { role: ContactRole; owner: ContactOwner } {
  if (!email || !email.includes('@')) {
    return { role: 'unknown', owner: 'unknown' };
  }

  const parts = email.toLowerCase().trim().split('@');
  const prefix = parts[0];
  const domain = parts[1] || '';

  // 1. Platform domain check (allowlist + suffix match e.g. daraz.com, foodmandu.com)
  for (const plat of PLATFORM_DOMAINS) {
    if (domain === plat || domain.endsWith('.' + plat)) {
      return { role: 'unknown', owner: 'platform' };
    }
  }

  // 2. Known business prefixes -> primary_business, business
  if (BUSINESS_EMAIL_PREFIXES.has(prefix)) {
    return { role: 'primary_business', owner: 'business' };
  }

  // 3. First-party domain matching
  const isFirstPartyDomain = Boolean(
    websiteDomain &&
    (domain === websiteDomain.toLowerCase() ||
     domain.endsWith('.' + websiteDomain.toLowerCase()) ||
     websiteDomain.toLowerCase().endsWith('.' + domain))
  );

  // If on business domain and prefix matches brand name (e.g. narayani@narayanilawfirm.org.np)
  if (isFirstPartyDomain && businessName) {
    const brandTokens = businessName.toLowerCase().split(/[\s,.-]+/).filter((t) => t.length >= 3);
    if (brandTokens.some((token) => prefix.includes(token))) {
      return { role: 'primary_business', owner: 'business' };
    }
  }

  // 4. Consumer provider personal signal: domain is consumer provider AND prefix looks personal
  if (CONSUMER_EMAIL_DOMAINS.has(domain)) {
    // Phase 8k CONTACT-06: If consumer email prefix matches >= 2 brand name tokens, classify as business
    // (e.g. gurjudhara.dentalcare@gmail.com matches 'gurjudhara' and 'dental' from brand)
    if (businessName) {
      const brandTokens = businessName.toLowerCase().split(/[\s,.-]+/).filter((t) => t.length >= 3);
      const matchCount = brandTokens.filter((token) => prefix.includes(token)).length;
      if (matchCount >= 2) {
        return { role: 'primary_business', owner: 'business' };
      }
      // Single-token match with no digits/dots in prefix is still a business signal
      if (matchCount >= 1 && !/\d/.test(prefix) && !prefix.includes('_')) {
        return { role: 'primary_business', owner: 'business' };
      }
    }
    // Personal signal: digits, dots, or underscores in prefix strongly indicate personal email
    if (/\d/.test(prefix) || prefix.includes('.') || prefix.includes('_')) {
      return { role: 'staff_person', owner: 'person' };
    }
  }

  const lowerContext = context.toLowerCase();

  // Phase 8k Component 4 (CONTACT-06): Schema-aware & structured metadata email classification
  if (
    lowerContext.includes('schema.org') ||
    lowerContext.includes('jsonld') ||
    lowerContext.includes('json-ld') ||
    lowerContext.includes('@type')
  ) {
    if (/\b(person|physician|employee|author|founder|member)\b/i.test(lowerContext)) {
      return { role: 'staff_person', owner: 'person' };
    }
    if (
      /\b(localbusiness|organization|dentist|medicalbusiness|hospital|clinic|store|corporation|educationalorganization)\b/i.test(
        lowerContext
      )
    ) {
      return { role: 'primary_business', owner: 'business' };
    }
  }

  // 5. Personal honorifics / markers in context: "Dr.", "Mr.", "Mrs.", "Director", etc.
  if (/\b(dr\.|dr\s|mr\.|mrs\.|ms\.|prof\.|director|founder|doctor|owner:)/i.test(lowerContext)) {
    return { role: 'staff_person', owner: 'person' };
  }

  // Initialism / Acronym matching (e.g. KDCH / kdchktm for Kantipur Dental College Hospital)
  if (businessName) {
    const rawTokens = businessName.toLowerCase().split(/[\s,.-]+/).filter(Boolean);
    const nonStopTokens = rawTokens.filter((t) => !['and', 'the', 'of', 'in', '&'].includes(t));
    const fullAcronym = rawTokens.map((t) => t[0]).join('');
    const shortAcronym = nonStopTokens.map((t) => t[0]).join('');
    const cleanPrefix = prefix.replace(/[^a-z]/g, '');

    if (
      (shortAcronym.length >= 3 && cleanPrefix.startsWith(shortAcronym)) ||
      (fullAcronym.length >= 3 && cleanPrefix.startsWith(fullAcronym)) ||
      (shortAcronym.length >= 3 && cleanPrefix.includes(shortAcronym))
    ) {
      return { role: 'primary_business', owner: 'business' };
    }
  }

  // 6. Personal name pattern in prefix: e.g. "first.last" on business domain
  if (prefix.includes('.') || prefix.includes('_')) {
    return { role: 'staff_person', owner: 'person' };
  }

  // 7. If on first-party domain and no personal markers -> primary_business, business
  if (isFirstPartyDomain) {
    return { role: 'primary_business', owner: 'business' };
  }

  // Conservative fallback: unknown, unknown (never guess staff_person)
  return { role: 'unknown', owner: 'unknown' };
}

export interface ContactSignalSnapshot {
  hasMapsSignal: boolean;
  hasPageCtaSignal: boolean;
  hasGeneralContactSignal: boolean;
  hasOwnerLeadershipSignal: boolean;
  hasStaffSignal: boolean;
  hasBranchSignal: boolean;
  hasPlatformSignal: boolean;
  pageTypesSeen: Set<PageType>;
}

export function evaluateContactRoleMatrix(s: ContactSignalSnapshot): {
  role: ContactRole;
  owner: ContactOwner;
} {
  // Row 1 & 2: Maps phone is the absolute identity authority -> primary_business
  if (s.hasMapsSignal) {
    return { role: 'primary_business', owner: 'business' };
  }

  // Row 8: Branch signal -> branch_contact
  if (s.hasBranchSignal) {
    return { role: 'branch_contact', owner: 'branch' };
  }

  // Platform number -> unknown, platform
  if (s.hasPlatformSignal) {
    return { role: 'unknown', owner: 'platform' };
  }

  const isHomepageOrContact = s.pageTypesSeen.has('homepage') || s.pageTypesSeen.has('contact');
  const isAboutOrTeam = s.pageTypesSeen.has('about') || s.pageTypesSeen.has('team');

  // Row 3: Prominent Business CTA on Homepage / Contact page -> primary_business
  // (Homepage CTA elevates the number to primary_business even if it also appears as staff on team page)
  if (isHomepageOrContact && s.hasPageCtaSignal) {
    return { role: 'primary_business', owner: 'business' };
  }

  // Standalone CTA with no team page association
  if (s.hasPageCtaSignal && !s.hasStaffSignal && !isAboutOrTeam) {
    return { role: 'primary_business', owner: 'business' };
  }

  // Row 5: Homepage or Contact page sighting without staff signals -> primary_business
  if (isHomepageOrContact && !s.hasStaffSignal) {
    return { role: 'primary_business', owner: 'business' };
  }

  // Row 6 & 7: About or team page profiles without Homepage CTA -> staff_person
  if (isAboutOrTeam && (s.hasOwnerLeadershipSignal || s.hasStaffSignal)) {
    return { role: 'staff_person', owner: 'person' };
  }

  // Row 4: Staff title without Homepage CTA -> staff_person
  if (s.hasStaffSignal) {
    return { role: 'staff_person', owner: 'person' };
  }

  // Row 9: No CTA / bare text / blog -> unknown, unknown
  return { role: 'unknown', owner: 'unknown' };
}

export function deduplicateClassifiedContacts(contacts: ClassifiedContact[]): ClassifiedContact[] {
  const map = new Map<
    string,
    {
      contact: ClassifiedContact;
      pages: Set<string>;
      pageTypesSeen: Set<PageType>;
      hasMapsSignal: boolean;
      hasPageCtaSignal: boolean;
      hasGeneralContactSignal: boolean;
      hasOwnerLeadershipSignal: boolean;
      hasStaffSignal: boolean;
      hasBranchSignal: boolean;
      hasPlatformSignal: boolean;
    }
  >();

  for (const c of contacts) {
    const key = c.type === 'phone'
      ? (c.canonicalDigits || c.value.replace(/\D/g, ''))
      : c.value.toLowerCase().trim();

    if (!key) continue;

    const normalizedPageUrl = c.pageUrl ? c.pageUrl.replace(/\/+$/, '') : undefined;
    const pType = classifyPageType(c.pageUrl);

    const ctx = (c.context || '').toLowerCase();
    const ctaSignal =
      /\b(call now|call us|emergency service|fast service|toll free|customer care|hotline|get a quote|need clean|book now|talk to us|phone:)\b/i.test(
        ctx
      ) || /\[(?:call|phone|tel|emergency|hotline|now|quote)[^\]]*\]\(tel:/i.test(c.context || '');
    const generalSignal =
      pType === 'contact' ||
      /\b(head office|main office|central office|contact us|email us)\b/i.test(ctx);
    const branchSignal =
      c.role === 'branch_contact' ||
      c.owner === 'branch' ||
      /\b(branch|branches|outlet|outlets)\b/i.test(ctx);
    const platformSignal = c.owner === 'platform';

    let ownerSignal = Boolean(
      c.associatedJobTitle &&
        OWNER_LEADERSHIP_TITLES.some((t) => c.associatedJobTitle?.toLowerCase().includes(t))
    );
    let staffSignal =
      Boolean(c.owner === 'person' || c.role === 'staff_person') ||
      Boolean(
        c.associatedJobTitle &&
          STAFF_TITLES.some((t) => c.associatedJobTitle?.toLowerCase().includes(t))
      );

    if (!ownerSignal) {
      for (const t of OWNER_LEADERSHIP_TITLES) {
        if (new RegExp(`\\b${t}\\b`, 'i').test(ctx)) {
          ownerSignal = true;
          break;
        }
      }
    }

    if (!staffSignal) {
      for (const t of STAFF_TITLES) {
        if (new RegExp(`\\b${t}\\b`, 'i').test(ctx)) {
          staffSignal = true;
          break;
        }
      }
      if (/\b(dr\.|dr\s|mr\.|mrs\.|ms\.|prof\.)\b/i.test(ctx)) {
        staffSignal = true;
      }
    }

    const existing = map.get(key);
    if (!existing) {
      const pages = new Set<string>();
      if (normalizedPageUrl) pages.add(normalizedPageUrl);
      if (c.pagesSeenOn) {
        for (const p of c.pagesSeenOn) {
          const norm = p.replace(/\/+$/, '');
          if (norm) pages.add(norm);
        }
      }
      const pageTypesSeen = new Set<PageType>([pType]);

      map.set(key, {
        contact: { ...c },
        pages,
        pageTypesSeen,
        hasMapsSignal: c.role === 'primary_business' && c.owner === 'business' && !c.context, // raw Maps seed
        hasPageCtaSignal: ctaSignal,
        hasGeneralContactSignal: generalSignal,
        hasOwnerLeadershipSignal: ownerSignal,
        hasStaffSignal: staffSignal,
        hasBranchSignal: branchSignal,
        hasPlatformSignal: platformSignal,
      });
    } else {
      if (normalizedPageUrl) existing.pages.add(normalizedPageUrl);
      if (c.pagesSeenOn) {
        for (const p of c.pagesSeenOn) {
          const norm = p.replace(/\/+$/, '');
          if (norm) existing.pages.add(norm);
        }
      }
      existing.pageTypesSeen.add(pType);
      existing.hasPageCtaSignal = existing.hasPageCtaSignal || ctaSignal;
      existing.hasGeneralContactSignal = existing.hasGeneralContactSignal || generalSignal;
      existing.hasOwnerLeadershipSignal = existing.hasOwnerLeadershipSignal || ownerSignal;
      existing.hasStaffSignal = existing.hasStaffSignal || staffSignal;
      existing.hasBranchSignal = existing.hasBranchSignal || branchSignal;
      existing.hasPlatformSignal = existing.hasPlatformSignal || platformSignal;

      for (const ch of c.channels || []) {
        if (!existing.contact.channels.includes(ch)) {
          existing.contact.channels.push(ch);
        }
      }

      if (!existing.contact.associatedPerson && c.associatedPerson) {
        existing.contact.associatedPerson = c.associatedPerson;
      }
      if (!existing.contact.associatedJobTitle && c.associatedJobTitle) {
        existing.contact.associatedJobTitle = c.associatedJobTitle;
      }
    }
  }

  return Array.from(map.values()).map(
    ({
      contact,
      pages,
      pageTypesSeen,
      hasMapsSignal,
      hasPageCtaSignal,
      hasGeneralContactSignal,
      hasOwnerLeadershipSignal,
      hasStaffSignal,
      hasBranchSignal,
      hasPlatformSignal,
    }) => {
      // Re-evaluate 9-row decision matrix on the OR-combined signal vector for phones
      if (contact.type === 'phone') {
        const reevaluated = evaluateContactRoleMatrix({
          hasMapsSignal,
          hasPageCtaSignal,
          hasGeneralContactSignal,
          hasOwnerLeadershipSignal,
          hasStaffSignal,
          hasBranchSignal,
          hasPlatformSignal,
          pageTypesSeen,
        });
        contact.role = reevaluated.role;
        contact.owner = reevaluated.owner;
      }

      return {
        ...contact,
        pagesSeenOn:
          pages.size > 0
            ? Array.from(pages)
            : contact.pageUrl
            ? [contact.pageUrl.replace(/\/+$/, '')]
            : undefined,
      };
    }
  );
}
