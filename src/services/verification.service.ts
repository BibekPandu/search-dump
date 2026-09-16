import type {
  ResearchCandidate,
} from '../mastra/agents/research-agent/schema';
import type {
  VerificationResult,
  VerifiedBusinessEvidence,
  WebsiteEvidence,
  WebsitePageEvidence,
} from '../mastra/agents/research-agent/verification.schema';
import {
  normalizePhoneDigits,
  normalizeNameKey,
  normalizeAddressKey,
  domainFromUrlOrHost,
  isUsableOfficialWebsite,
} from './entity-resolution.service';
import { extractAllFromPages } from './business-extractor.service';
import {
  classifyWebsiteRelationship,
  determineWebsiteLifecycle,
  validateLifecycleRelationshipInvariant,
} from './website-relationship.service';

// ============================================================================
// Verification Service — Maps/ResearchCandidate identity ↔ Website evidence
// ============================================================================
// Cross-checks the candidate identity (name, phone, address, website domain)
// against deterministically extracted website evidence. Reuses Phase 1 entity
// resolution normalizers — there is deliberately NO second identity algorithm.
//
// IMPORTANT: a non-verified result means "insufficient deterministic evidence",
// NOT proof the website belongs to a different business. This mirrors the
// Phase 1 `method: 'none'` principle.

interface VerificationSignals {
  gate: boolean;
  domainMatch: boolean;
  nameFound: boolean;
  phoneMatch: boolean;
  addressFound: boolean;
  emailFound: boolean;
  socialFound: boolean;
}

const SIGNAL_WEIGHTS: Record<keyof VerificationSignals, number> = {
  gate: 0.15,
  domainMatch: 0.05,
  nameFound: 0.25,
  phoneMatch: 0.25,
  addressFound: 0.15,
  emailFound: 0.1,
  socialFound: 0.05,
};

function significantTokens(key: string): string[] {
  return key
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

/** Fraction of significant target tokens present in the (lowercased) haystack. */
function tokenCoverage(targetKey: string, haystack: string): number {
  const tokens = significantTokens(targetKey);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits++;
  }
  return hits / tokens.length;
}

function phonesOverlap(candidatePhone: string, extractedPhones: string[]): boolean {
  const candidateDigits = normalizePhoneDigits(candidatePhone);
  if (!candidateDigits || candidateDigits.length < 7) return false;
  for (const raw of extractedPhones) {
    const digits = normalizePhoneDigits(raw);
    if (!digits || digits.length < 7) continue;
    // Exact normalized equality is the strongest signal; containment (in either
    // direction) is a weaker but still useful corroboration.
    if (candidateDigits === digits) return true;
    if (candidateDigits.includes(digits) || digits.includes(candidateDigits)) return true;
  }
  return false;
}

function contentOf(websiteEvidence?: WebsiteEvidence): string {
  if (!websiteEvidence) return '';
  return websiteEvidence.pages
    .filter((p) => p.success && p.content)
    .map((p) => p.content.toLowerCase())
    .join('\n');
}

function buildNotes(signals: VerificationSignals, candidate: ResearchCandidate, websiteEvidence?: WebsiteEvidence): string[] {
  const notes: string[] = [];
  if (!websiteEvidence) {
    notes.push('No usable website evidence available.');
    return notes;
  }
  if (!signals.gate) notes.push('Candidate website is not a usable official website (social/directory/aggregator).');
  if (!signals.domainMatch) notes.push('Website domain does not match candidate website domain (structural mismatch).');
  if (!signals.nameFound) notes.push('Business name tokens were NOT found on the website content — insufficient evidence, not proof of mismatch.');
  if (!signals.phoneMatch && candidate.phone) notes.push('Candidate phone was NOT found on the website — insufficient evidence, not proof of mismatch.');
  if (!signals.addressFound && candidate.location) notes.push('Candidate location/address tokens were NOT found on the website content.');
  if (!signals.emailFound) notes.push('No non-placeholder email found on official website pages.');
  if (!signals.socialFound) notes.push('No social links found on official website pages.');
  return notes;
}
/**
 * Verifies a ResearchCandidate against its extracted website evidence, producing
 * a meaningful status + boolean checks (Correction 2 + Correction 4).
 */
export function verifyCandidateWebsite(
  candidate: ResearchCandidate,
  websiteEvidence?: WebsiteEvidence
): VerificationResult {
  const signals: VerificationSignals = {
    gate: Boolean(candidate.website && isUsableOfficialWebsite(candidate.website)),
    domainMatch: false,
    nameFound: false,
    phoneMatch: false,
    addressFound: false,
    emailFound: false,
    socialFound: false,
  };

  const content = contentOf(websiteEvidence);

  if (websiteEvidence && websiteEvidence.domain) {
    signals.domainMatch = websiteEvidence.domain === domainFromUrlOrHost(candidate.website || '');
  }

  if (content) {
    const nameKey = normalizeNameKey(candidate.name);
    signals.nameFound = tokenCoverage(nameKey, content) >= 0.6;
    if (candidate.phone) {
      signals.phoneMatch = phonesOverlap(
        candidate.phone,
        [...(websiteEvidence?.extractedPhones || []), ...(websiteEvidence?.extractedMobiles || [])]
      );
    }
    if (candidate.location) {
      const locKey = normalizeAddressKey(candidate.location);
      signals.addressFound = tokenCoverage(locKey, content) >= 0.5;
    }
    signals.emailFound = (websiteEvidence?.extractedEmails || []).length > 0;
    const socials = websiteEvidence?.extractedSocialLinks;
    signals.socialFound = Boolean(
      socials &&
        (socials.facebook || socials.instagram || socials.tiktok || Object.keys(socials.other).length > 0)
    );
  }

  // ----- Status mapping (meaningful, evidence-grounded) -----
  let status: VerificationResult['status'];
  const hasSuccessfulPages = Boolean(websiteEvidence && websiteEvidence.pages.some((p) => p.success && p.content));

  if (!signals.gate || !hasSuccessfulPages) {
    status = 'failed';
  } else if (signals.nameFound && (signals.phoneMatch || (signals.addressFound && signals.domainMatch))) {
    status = 'verified';
  } else {
    // Count "beyond-the-gate" identity evidence checks.
    const beyondGate = [signals.nameFound, signals.phoneMatch, signals.addressFound, signals.emailFound, signals.socialFound]
      .filter(Boolean).length;
    status = beyondGate >= 2 ? 'partial' : 'weak';
  }

  const weighted = Object.entries(signals).reduce((sum, [key, value]) => {
    if (value) sum += SIGNAL_WEIGHTS[key as keyof VerificationSignals];
    return sum;
  }, 0);
  const overallConfidence = status === 'failed' ? 0 : Math.min(1, Number(weighted.toFixed(2)));

  return {
    status,
    overallConfidence,
    checks: {
      websiteIsUsableOfficial: signals.gate,
      websiteDomainMatchesCandidate: signals.domainMatch,
      businessNameFoundOnWebsite: signals.nameFound,
      phoneMatchesMaps: signals.phoneMatch,
      addressOrLocationFoundOnWebsite: signals.addressFound,
      emailFoundOnWebsite: signals.emailFound,
      socialLinksFoundOnWebsite: signals.socialFound,
    },
    notes: buildNotes(signals, candidate, websiteEvidence),
  };
}
/** Canonical key for mapping candidates ↔ extractions. */
export function keyOfCandidate(candidate: ResearchCandidate): string {
  return candidate.website || candidate.name.toLowerCase().trim();
}

function buildWebsiteEvidence(
  candidate: ResearchCandidate,
  pages: WebsitePageEvidence[]
): WebsiteEvidence {
  const extracted = extractAllFromPages(pages, candidate.name, candidate.website);
  return {
    url: candidate.website || '',
    domain: domainFromUrlOrHost(candidate.website || ''),
    pages,
    ...extracted,
  };
}

/**
 * Produces one VerifiedBusinessEvidence per candidate:
 * - candidates WITH extracted pages → full WebsiteEvidence + verification;
 * - candidates skipped by the deep-verify cap → 'weak' placeholder with a note;
 * - candidates without a usable website → 'failed' placeholder (0 Tavily cost).
 */
export function buildVerifiedEvidence(
  candidates: ResearchCandidate[],
  extractionsByCandidate: Map<string, WebsitePageEvidence[]>,
  options: { skippedCandidate?: (name: string) => void } = {}
): VerifiedBusinessEvidence[] {
  const result: VerifiedBusinessEvidence[] = [];

  for (const candidate of candidates) {
    const pages = extractionsByCandidate.get(keyOfCandidate(candidate)) || [];

    // Case 1: no usable official website → failed placeholder (0 Tavily cost).
    if (!candidate.website || !isUsableOfficialWebsite(candidate.website)) {
      result.push({
        candidate,
        websiteEvidence: undefined,
        verification: {
          status: 'failed',
          overallConfidence: 0,
          checks: {
            websiteIsUsableOfficial: false,
            websiteDomainMatchesCandidate: false,
            businessNameFoundOnWebsite: false,
            phoneMatchesMaps: false,
            addressOrLocationFoundOnWebsite: false,
            emailFoundOnWebsite: false,
            socialLinksFoundOnWebsite: false,
          },
          notes: ['No usable official website — deep verification skipped.'],
        },
        websiteRelationship: 'unverified',
        websiteLifecycle: 'discovered',
      });
      continue;
    }

    const successfulPages = pages.filter((p) => p.success && p.content);
    const combinedContent = successfulPages.map((p) => p.content).join('\n\n');

    // Classify candidate website relationship (with pageContent if extracted)
    const relClassification = classifyWebsiteRelationship(
      candidate.website,
      candidate.name,
      combinedContent || undefined
    );

    // Case 2: pages were extracted for this candidate → full evidence + verify.
    if (successfulPages.length > 0) {
      const evidence = buildWebsiteEvidence(candidate, pages);
      const verification = verifyCandidateWebsite(candidate, evidence);
      const lifecycle = determineWebsiteLifecycle(
        relClassification.relationship,
        verification.status,
        true
      );
      result.push({
        candidate,
        websiteEvidence: evidence,
        verification,
        websiteRelationship: relClassification.relationship,
        websiteLifecycle: validateLifecycleRelationshipInvariant(lifecycle, relClassification.relationship),
      });
      continue;
    }

    // Case 3: candidate has a website but was NOT deep-verified (cap) or all
    // extractions failed → weak/failed placeholder.
    options.skippedCandidate?.(candidate.name);
    const allFailed = pages.length > 0 && pages.every((p) => !p.success);
    const lifecycle = determineWebsiteLifecycle(
      relClassification.relationship,
      allFailed ? 'failed' : 'weak',
      pages.length > 0
    );
    result.push({
      candidate,
      websiteEvidence: undefined,
      verification: {
        status: allFailed ? 'failed' : 'weak',
        overallConfidence: 0,
        checks: {
          websiteIsUsableOfficial: isUsableOfficialWebsite(candidate.website),
          websiteDomainMatchesCandidate: false,
          businessNameFoundOnWebsite: false,
          phoneMatchesMaps: false,
          addressOrLocationFoundOnWebsite: false,
          emailFoundOnWebsite: false,
          socialLinksFoundOnWebsite: false,
        },
        notes: allFailed
          ? ['Website extraction failed — no page evidence available.']
          : ['Candidate not deep-verified (maxDeepVerifyCandidates cap).'],
      },
      websiteRelationship: relClassification.relationship,
      websiteLifecycle: validateLifecycleRelationshipInvariant(lifecycle, relClassification.relationship),
    });
  }

  return result;
}