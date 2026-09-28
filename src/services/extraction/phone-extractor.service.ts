/**
 * Nepal phone classification, mobile/landline extraction and formatting.
 *
 * Phase 4 split of `src/services/business-extractor.service.ts`. Every declaration
 * below is copied byte-exact from the monolith; only the import block is new.
 */

import { NTA_MOBILE_PREFIXES, NTA_LANDLINE_AREA_CODES } from '@/config/nepal-telecom.config';
import type { ContactRole, ContactOwner, ContactChannel } from '@/types/contact.js';
import { OWNER_LEADERSHIP_TITLES, STAFF_TITLES } from '@/config/token-vocabulary.config';
import { LANDLINE_OR_MOBILE_REGEX, MOBILE_REGEX, NEPAL_LANDLINE_REGEX, INTERNATIONAL_REGEX, SCHEDULE_GARBAGE_PATTERNS } from '@/services/extraction/extraction-regex';
import { classifyPageType } from '@/services/extraction/page-type.service';
import { stripHtmlTags, stripNoiseContexts } from '@/services/extraction/content-normalization.service';
import { evaluateContactRoleMatrix } from '@/services/extraction/contact-extractor.service';

export function sanitizePhoneString(raw: string): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^[^+\d]+/, '')
    .replace(/[^\d]+$/, '');
}

export interface ClassifiedPhone {
  type: 'mobile' | 'landline' | 'international' | 'invalid';
  digits: string;
  normalized: string;
  /** Why the number was rejected — set only when type === 'invalid'. */
  reason?: string;
}

export interface PhoneEvidence {
  /** The verbatim string extracted from the source (before any normalization). */
  raw: string;
  /** Digits-only canonical identity — used for dedup and matching. */
  canonicalDigits: string;
  /** User-facing display string. Nepal numbers are deterministically formatted.
   *  International numbers preserve the original source grouping. */
  display: string;
  type: 'mobile' | 'landline' | 'international' | 'invalid';
  /** How the candidate was found: Tavily markdown, raw HTML, or tel/href attribute. */
  source: 'markdown' | 'rawHtml' | 'href';
  /** The page URL where this candidate was found. */
  pageUrl: string;
  /** Populated only when type === 'invalid'. Describes why the candidate was rejected. */
  reason?: string;
}

export function formatPhoneDisplay(
  canonicalDigits: string,
  type: ClassifiedPhone['type'],
  raw?: string
): string {
  if (type === 'mobile' && canonicalDigits.length === 10) {
    // +977-9XX-XXXXXXX  (split at position 3 within the 10-digit mobile number)
    return `+977-${canonicalDigits.slice(0, 3)}-${canonicalDigits.slice(3)}`;
  }
  if (type === 'landline' && canonicalDigits.length === 8 && canonicalDigits.startsWith('1')) {
    // +977-01-XXXXXXX  (strip leading 1, replace with 01)
    return `+977-01-${canonicalDigits.slice(1)}`;
  }
  if (type === 'international') {
    // Preserve source grouping when available (avoids invented format)
    if (raw) {
      const sanitized = sanitizePhoneString(raw);
      return sanitized.startsWith('+') ? sanitized : `+${sanitized.replace(/^\D+/, '')}`;
    }
    return `+${canonicalDigits}`;
  }
  // invalid or unknown: return raw or canonical
  return raw ?? canonicalDigits;
}

export function classifyNepalPhone(raw: string): ClassifiedPhone {
  const cleaned = sanitizePhoneString(raw);
  if (!cleaned) return { type: 'invalid', digits: '', normalized: '', reason: 'EMPTY' };

  let digits = cleaned.replace(/\D/g, '');
  if (!digits) return { type: 'invalid', digits: '', normalized: cleaned, reason: 'NO_DIGITS' };

  // Phase 8g: Reject floating-point GPS coordinate strings misparsed as numbers (e.g. 27.382262 or 85.309623)
  if (/\b\d{1,3}\.\d{4,8}\b/.test(raw.trim())) {
    return { type: 'invalid', digits: '', normalized: cleaned, reason: 'COORDINATE_FLOAT' };
  }

  // Task 4: Duplicate country code (+977 977 9851234567 -> +977 9851234567)
  if (digits.startsWith('977977')) {
    digits = digits.slice(3);
  }

  // Hard limits: below 7 digits or above 15 digits cannot be any valid phone.
  if (digits.length > 15) return { type: 'invalid', digits, normalized: cleaned, reason: 'TOO_LONG' };

  const hasPlus = cleaned.startsWith('+');
  const startsWith977 = digits.startsWith('977');

  // ── PATH A: Nepal country code prefix (977…) ────────────────────────────────
  if (startsWith977) {
    const afterCC = digits.slice(3); // digits after the 977 country code

    // Mobile: 977 + exactly 10 digits starting with verified NTA mobile prefix
    const isNtaMobilePrefix = NTA_MOBILE_PREFIXES.some((p) => afterCC.startsWith(p));
    if (isNtaMobilePrefix) {
      if (afterCC.length === 10) {
        return { type: 'mobile', digits: afterCC, normalized: formatPhoneDisplay(afterCC, 'mobile', cleaned) };
      }
      return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_MOBILE' };
    }

    // Landline: 977 + 01 + 7 digits (total afterCC length = 9) -> strip trunk 0 -> 1XXXXXXX (8 digits)
    if (afterCC.startsWith('01')) {
      if (afterCC.length === 9) {
        const landlineDigits = afterCC.slice(1);
        return { type: 'landline', digits: landlineDigits, normalized: formatPhoneDisplay(landlineDigits, 'landline', cleaned) };
      }
      return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
    }

    // Landline: 977 + 1 + 7 digits (total afterCC length = 8)
    if (afterCC.startsWith('1')) {
      if (afterCC.length === 8) {
        return { type: 'landline', digits: afterCC, normalized: formatPhoneDisplay(afterCC, 'landline', cleaned) };
      }
      return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
    }

    // Regional Landlines in Path A: 977 + 2-digit area code + 6 digits (e.g. +977-61-520123)
    for (const [code, info] of Object.entries(NTA_LANDLINE_AREA_CODES)) {
      if (code !== '01' && afterCC.startsWith(info.areaCodeDigits)) {
        const expectedLen = info.areaCodeDigits.length + info.subscriberLength;
        if (afterCC.length === expectedLen) {
          return { type: 'landline', digits: afterCC, normalized: formatPhoneDisplay(afterCC, 'landline', cleaned) };
        }
      }
    }

    // Has 977 prefix but no recognised afterCC structure -> international?
    if (hasPlus && digits.length >= 8 && digits.length <= 15) {
      const opens = (cleaned.match(/\(/g) || []).length;
      const closes = (cleaned.match(/\)/g) || []).length;
      if (opens === closes) return { type: 'international', digits, normalized: formatPhoneDisplay(digits, 'international', cleaned) };
    }

    return { type: 'invalid', digits, normalized: cleaned, reason: 'INVALID_STRUCTURE' };
  }

  // ── PATH B: No 977 prefix — domestic or explicit international ───────────────

  // Nepal mobile: exactly 10 digits starting with verified NTA mobile prefix
  const isNtaMobilePrefix = NTA_MOBILE_PREFIXES.some((p) => digits.startsWith(p));
  if (isNtaMobilePrefix) {
    if (digits.length === 10) {
      return { type: 'mobile', digits, normalized: formatPhoneDisplay(digits, 'mobile', cleaned) };
    }
    return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_MOBILE' };
  }

  // Kathmandu domestic landline (with or without '+'): 01 + 7 digits (9 digits total) -> strip trunk 0
  if (digits.length === 9 && digits.startsWith('01')) {
    const landlineDigits = digits.slice(1);
    return { type: 'landline', digits: landlineDigits, normalized: formatPhoneDisplay(landlineDigits, 'landline', cleaned) };
  }

  // Regional domestic landlines (e.g. 061-520123): check NTA_LANDLINE_AREA_CODES
  for (const [code, info] of Object.entries(NTA_LANDLINE_AREA_CODES)) {
    if (code !== '01' && digits.startsWith(code)) {
      const expectedLen = code.length + info.subscriberLength; // e.g. 3 + 6 = 9 digits
      if (digits.length === expectedLen) {
        const canonical = digits.slice(1); // strip trunk 0 -> 8 digits
        return { type: 'landline', digits: canonical, normalized: formatPhoneDisplay(canonical, 'landline', cleaned) };
      }
    }
  }

  // Kathmandu landline bare form: 1 + 7 digits (8 digits total)
  if (digits.length === 8 && digits.startsWith('1')) {
    return { type: 'landline', digits, normalized: formatPhoneDisplay(digits, 'landline', cleaned) };
  }

  // Regional bare landlines (2-digit area code + 6 digits = 8 digits total)
  for (const [code, info] of Object.entries(NTA_LANDLINE_AREA_CODES)) {
    if (code !== '01' && digits.startsWith(info.areaCodeDigits)) {
      const expectedLen = info.areaCodeDigits.length + info.subscriberLength;
      if (digits.length === expectedLen) {
        return { type: 'landline', digits, normalized: formatPhoneDisplay(digits, 'landline', cleaned) };
      }
    }
  }

  // INTERNATIONAL: check for explicit '+' and 8–15 digits with balanced parens
  // Checked AFTER domestic landline so +01-XXXXXXX is recognized as landline, not intl!
  if (hasPlus && digits.length >= 8 && digits.length <= 15) {
    const opens = (cleaned.match(/\(/g) || []).length;
    const closes = (cleaned.match(/\)/g) || []).length;
    if (opens === closes) return { type: 'international', digits, normalized: formatPhoneDisplay(digits, 'international', cleaned) };
  }

  if (digits.startsWith('01') && digits.length !== 9) {
    return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
  }

  if (digits.startsWith('1') && digits.length !== 8) {
    return { type: 'invalid', digits, normalized: cleaned, reason: 'INCOMPLETE_LANDLINE' };
  }

  return { type: 'invalid', digits, normalized: cleaned, reason: 'INVALID_STRUCTURE' };
}

export interface PhoneRoleClassificationResult {
  role: ContactRole;
  owner: ContactOwner;
  channels: ContactChannel[];
  associatedPerson?: string;
  associatedJobTitle?: string;
  hasMapsSignal?: boolean;
  hasPageCtaSignal?: boolean;
  hasGeneralContactSignal?: boolean;
  hasOwnerLeadershipSignal?: boolean;
  hasStaffSignal?: boolean;
  hasBranchSignal?: boolean;
  hasPlatformSignal?: boolean;
}

export function classifyPhoneRole(
  phone: string,
  context: string = '',
  businessName?: string,
  classifiedPhone?: ClassifiedPhone,
  pageUrl?: string,
  isMapsPhone?: boolean
): PhoneRoleClassificationResult {
  const lowerContext = context.toLowerCase();
  const channels: ContactChannel[] = ['call'];

  // Channels detection
  if (lowerContext.includes('whatsapp') || lowerContext.includes('wa.me') || lowerContext.includes('wa/')) {
    channels.push('whatsapp');
  }
  if (lowerContext.includes('viber')) {
    channels.push('viber');
  }

  const pageType = classifyPageType(pageUrl);

  // 1. Channel / CTA Signals
  const hasPageCtaSignal =
    /\b(call now|call us|emergency service|emergency|direct contact|fast service|toll free|customer care|hotline|get a quote|need clean|book now|talk to us|phone:|chat with us|whatsapp|viber|call|order|orders|delivery)\b/i.test(
      lowerContext
    ) || /\[(?:call|phone|tel|emergency|hotline|now|quote)[^\]]*\]\(tel:/i.test(context);

  const hasGeneralContactSignal =
    pageType === 'contact' ||
    /\b(head office|main office|central office|contact us|email us)\b/i.test(lowerContext);

  // 2. Branch Signals
  const lowerBizName = (businessName || '').toLowerCase().trim();
  const lowerCtxTrim = lowerContext.trim();
  let hasBranchKeyword = /\b(branch|branches|outlet|outlets|our branches)\b/i.test(lowerContext);

  // Phase 8O (D40): If branch keyword is part of businessName itself (e.g. "Shrestha Brothers Furniture Satungal Outlet"),
  // self-context must NOT trigger a branch signal.
  if (hasBranchKeyword && lowerBizName) {
    const branchWordInBiz = ['outlet', 'outlets', 'branch', 'branches', 'center', 'centre', 'showroom'].some((w) => lowerBizName.includes(w));
    if (branchWordInBiz && (lowerCtxTrim === lowerBizName || lowerBizName.includes(lowerCtxTrim) || lowerCtxTrim.includes(lowerBizName))) {
      hasBranchKeyword = false;
    }
  }

  const hasLocationCues = /\b(clinic|center|centre|office|outlet)\b/i.test(lowerContext);
  const hasLocalities = /\b(chabahil|naikap|bardibas|banasthali|chapagaun|jawalakhel|koteshwor|kumaripati|pokhara|biratnagar|birgunj|dharan|hetauda|nepalgunj|butwal)\b/i.test(lowerContext);
  const hasAddressCues = /\b(chowk|marga|street|road|ward|tole)\b/i.test(lowerContext);
  const hasBranchSignal = hasBranchKeyword || (hasLocationCues && hasLocalities) || (hasLocalities && hasAddressCues);

  // 3. Person / Title Signals
  let hasOwnerLeadershipSignal = false;
  let hasStaffSignal = false;
  let associatedPerson: string | undefined;
  let associatedJobTitle: string | undefined;

  for (const title of OWNER_LEADERSHIP_TITLES) {
    if (new RegExp(`\\b${title}\\b`, 'i').test(lowerContext)) {
      hasOwnerLeadershipSignal = true;
      associatedJobTitle = title;
      break;
    }
  }

  for (const title of STAFF_TITLES) {
    if (new RegExp(`\\b${title}\\b`, 'i').test(lowerContext)) {
      hasStaffSignal = true;
      if (!associatedJobTitle) associatedJobTitle = title;
      break;
    }
  }

  if (/\b(dr\.|dr\s|mr\.|mrs\.|ms\.|prof\.)\b/i.test(lowerContext)) {
    hasStaffSignal = true;
  }

  // Extract person name if present in markdown team cues or direct contact cues
  const NON_PERSON_WORDS = new Set([
    'and', 'or', 'the', 'of', 'in', 'at', 'on', 'for', 'to', 'with', 'from', 'by',
    'hours', 'hour', 'here', 'start', 'gap', 'direction', 'directions', 'ions',
    'open', 'close', 'closed', 'opening', 'closing', 'time', 'timing', 'timings',
    'appointment', 'appointments', 'day', 'days', 'week', 'month', 'year',
    'location', 'locations', 'details', 'detail', 'info', 'information', 'about',
    'service', 'services', 'clinic', 'hospital', 'center', 'centre', 'branch',
    'home', 'page', 'site', 'website', 'call', 'contact', 'email', 'phone', 'mobile'
  ]);

  const personMatch =
    context.match(/(?:###|\*\*|##)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:Chairman|Managing Director|Director|Supervisor|Marketing|Front Desk|Design|Executive|Head|Manager|Cleaner|Maid|Technician|Owner|Founder|Advocate|Lawyer|Attorney|Doctor|Principal|Partner)\b/i) ||
    context.match(/\b(?:call|contact|emergency|direct|attorney|lawyer|advocate|dr|mr|mrs|ms|shree)\b\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i) ||
    context.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[-:]\s*(?:\+?[\d\s-]{7,})/);
  if (personMatch) {
    const candidate = personMatch[1].trim();
    const candidateTokens = candidate.toLowerCase().split(/\s+/).filter(Boolean);
    const hasNonPersonWord = candidateTokens.some((t) => NON_PERSON_WORDS.has(t));
    const isGarbage =
      hasNonPersonWord ||
      candidateTokens.length < 2 ||
      SCHEDULE_GARBAGE_PATTERNS.some((pat) => pat.test(candidate));
    if (!isGarbage) {
      associatedPerson = candidate;
    }
  }

  const hasMapsSignal = Boolean(isMapsPhone);
  const hasPlatformSignal = false;

  const decision = evaluateContactRoleMatrix({
    hasMapsSignal,
    hasPageCtaSignal,
    hasGeneralContactSignal,
    hasOwnerLeadershipSignal,
    hasStaffSignal,
    hasBranchSignal,
    hasPlatformSignal,
    pageTypesSeen: new Set([pageType]),
  });

  return {
    role: decision.role,
    owner: decision.owner,
    channels,
    associatedPerson,
    associatedJobTitle,
    hasMapsSignal,
    hasPageCtaSignal,
    hasGeneralContactSignal,
    hasOwnerLeadershipSignal,
    hasStaffSignal,
    hasBranchSignal,
    hasPlatformSignal,
  };
}

export function expandSlashExtensions(rawText: string): string[] {
  if (!rawText || !rawText.includes('/')) return [];

  const pattern = /(?:(?:\+?977[-\s]?)?(?:0?1[-\s]?)?[2-6]\d{6}(?:\s*\/\s*\d{2,7})+)/g;
  const results: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rawText)) !== null) {
    const fullMatch = match[0];
    const parts = fullMatch.split('/').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;

    const baseRaw = parts[0];
    const baseCleanDigits = baseRaw.replace(/\D/g, '');
    if (baseCleanDigits.length < 7) continue;

    const baseSubscriber = baseCleanDigits.slice(-7);
    const prefix = baseRaw.slice(0, baseRaw.length - 7);

    const baseClassified = classifyNepalPhone(baseRaw);
    if (baseClassified.type === 'landline') {
      results.push(baseRaw);
    }

    for (let i = 1; i < parts.length; i++) {
      const ext = parts[i];
      if (!/^\d+$/.test(ext)) continue;

      let candidateSubscriber = '';
      if (ext.length === 7) {
        candidateSubscriber = ext;
      } else if (ext.length >= 2 && ext.length <= 4) {
        candidateSubscriber = baseSubscriber.slice(0, 7 - ext.length) + ext;
      } else {
        continue;
      }

      const candidate = `${prefix}${candidateSubscriber}`;
      const classified = classifyNepalPhone(candidate);
      if (classified.type === 'landline') {
        results.push(candidate);
      }
    }
  }

  return results;
}

export function extractPhones(content: string): string[] {
  if (!content) return [];

  const cleaned = stripNoiseContexts(content);
  const text = stripHtmlTags(cleaned);
  const internationalRaw = text.match(INTERNATIONAL_REGEX) || [];
  const foundRaw = text.match(LANDLINE_OR_MOBILE_REGEX) || [];
  const slashExpanded = expandSlashExtensions(cleaned);
  const international = internationalRaw.map((raw) => sanitizePhoneString(raw)).filter(Boolean);
  const found = [...foundRaw, ...slashExpanded].map((raw) => sanitizePhoneString(raw)).filter(Boolean);

  // International provenance analysis (v1.3 fragment guard):
  //   intlRuns      — accepted international digit runs.
  //   nepalOwned    — runs that THEMSELVES classify as Nepal landline/mobile
  //                   (country-coded, e.g. "+977-1-4240520"): their inner
  //                   Nepal-form matches are legit duplicates of the SAME
  //                   number and must be kept (deduped by digits).
  //   foreignRuns   — runs classified 'international' (e.g. "+1 301 322 1427"):
  //                   inner Nepal-form matches are spurious fragments
  //                   ("013221427" inside the US tel: number) and discarded.
  const intlRuns = international
    .filter((p) => classifyNepalPhone(p).type !== 'invalid')
    .map((p) => ({ run: p.replace(/\D/g, ''), cls: classifyNepalPhone(p) }));
  const foreignRuns = intlRuns.filter(({ cls }) => cls.type === 'international').map(({ run }) => run);
  const nepalOwnedDigits = new Set(
    intlRuns
      .filter(({ cls }) => cls.type === 'landline' || cls.type === 'mobile')
      .map(({ cls }) => cls.digits)
  );

  const byDigits = new Map<string, string>();
  // International candidates first — full provenance, never fragment-guarded.
  for (const candidate of international) {
    const classified = classifyNepalPhone(candidate);
    if (classified.type === 'invalid') continue;
    if (!byDigits.has(classified.digits)) byDigits.set(classified.digits, candidate);
  }
  // Nepal-form candidates — fragment-guarded against FOREIGN intl runs.
  for (const candidate of found) {
    const classified = classifyNepalPhone(candidate);
    if (classified.type === 'invalid') continue;
    if (byDigits.has(classified.digits)) continue; // covered by a trusted form
    if (classified.type === 'landline' || classified.type === 'mobile') {
      const isFragmentOfForeignNumber =
        !nepalOwnedDigits.has(classified.digits) &&
        foreignRuns.some((run) => run.includes(classified.digits));
      if (isFragmentOfForeignNumber) continue;
    }
    byDigits.set(classified.digits, candidate);
  }
  return [...byDigits.values()];
}

export function extractMobiles(content: string): string[] {
  if (!content) return [];
  const cleaned = stripNoiseContexts(content);
  const text = stripHtmlTags(cleaned);
  const found = text.match(MOBILE_REGEX) || [];
  const byDigits = new Map<string, string>();
  for (const raw of found) {
    const candidate = sanitizePhoneString(raw);
    const classified = classifyNepalPhone(candidate);
    if (classified.type !== 'mobile') continue;
    if (!byDigits.has(classified.digits)) {
      byDigits.set(classified.digits, candidate);
    }
  }
  return [...byDigits.values()];
}

export function extractLandlines(content: string): string[] {
  if (!content) return [];
  const cleaned = stripNoiseContexts(content);
  const text = stripHtmlTags(cleaned);
  const found = text.match(NEPAL_LANDLINE_REGEX) || [];
  const slashExpanded = expandSlashExtensions(cleaned);
  const allCandidates = [...found, ...slashExpanded];

  // Fragment provenance guard (v1.3): a Nepal landline shape found INSIDE a
  // FOREIGN international run (e.g. "013221427" inside a US "+1 301 322 1427"
  // tel: href) is a spurious inner match, never a Kathmandu number. Runs that
  // THEMSELVES classify as Nepal numbers (e.g. "+977-1-4522833") OWN their
  // inner landline forms — those are legit and always kept.
  const intlRuns = (text.match(INTERNATIONAL_REGEX) || [])
    .map((raw) => sanitizePhoneString(raw))
    .filter((p) => classifyNepalPhone(p).type !== 'invalid')
    .map((p) => ({ run: p.replace(/\D/g, ''), cls: classifyNepalPhone(p) }));
  const foreignRuns = intlRuns.filter(({ cls }) => cls.type === 'international').map(({ run }) => run);
  const nepalOwnedDigits = new Set(
    intlRuns
      .filter(({ cls }) => cls.type === 'landline' || cls.type === 'mobile')
      .map(({ cls }) => cls.digits)
  );

  const byDigits = new Map<string, string>();
  for (const raw of allCandidates) {
    const candidate = sanitizePhoneString(raw);
    const classified = classifyNepalPhone(candidate);
    if (classified.type !== 'landline') continue;
    const isFragmentOfForeignNumber =
      !nepalOwnedDigits.has(classified.digits) &&
      foreignRuns.some((run) => run.includes(classified.digits));
    if (isFragmentOfForeignNumber) continue;
    if (!byDigits.has(classified.digits)) {
      byDigits.set(classified.digits, candidate);
    }
  }
  return [...byDigits.values()];
}

export function extractLandlinesAndIntl(content: string): string[] {
  if (!content) return [];
  const landlines = extractLandlines(content);

  const cleaned = stripNoiseContexts(content);
  const text = stripHtmlTags(cleaned);
  const internationalRaw = text.match(INTERNATIONAL_REGEX) || [];
  const international = internationalRaw.map((raw) => sanitizePhoneString(raw)).filter(Boolean);

  const byDigits = new Map<string, string>();
  for (const l of landlines) {
    const classified = classifyNepalPhone(l);
    if (classified.type === 'landline' && !byDigits.has(classified.digits)) {
      byDigits.set(classified.digits, l);
    }
  }

  for (const intl of international) {
    const classified = classifyNepalPhone(intl);
    // Only verified non-mobile international numbers:
    if (classified.type === 'international' && !byDigits.has(classified.digits)) {
      byDigits.set(classified.digits, intl);
    }
  }

  return [...byDigits.values()];
}
