/**
 * Post-synthesis evidence sanitizer service.
 * Enforces evidence-backed contact data and deterministic overwrites.
 */
import { z } from 'zod';
import { businessListingSchema } from '@/types/business-listing';
import type { VerifiedBusinessEvidence } from '@/types/verification';
import type { BranchRecord, ClassifiedContact } from '@/types/contact';
import { extractDomain } from '@/services/discovery/search-fallback.service';
import {
  domainFromUrlOrHost,
  normalizeNameKey,
  normalizePhoneDigits,
  isUsableOfficialWebsite,
  attributeMultiBranchContacts,
  isAllContactsUnattributed,
  namesAlignForEvidence,
} from '@/services/resolution/entity-resolution.service';
import {
  sanitizeEmailString,
  classifyNepalPhone,
  isRealSocialProfile,
  classifySocialProfile,
  classifyEmailRole,
  classifyPhoneRole,
  deduplicateClassifiedContacts,
  cleanBranchAddress,
} from '@/services/business-extractor.service';
import { findRegisteredLocalityCluster } from '@/config/geo-localities.config';
import { incrementTelemetry } from '@/services/telemetry.service';
import { completeSocials } from '@/services/resolution/social-completion.service';

export function matchListingToEvidence(
  listing: z.infer<typeof businessListingSchema>,
  evidenceList: VerifiedBusinessEvidence[]
): VerifiedBusinessEvidence | undefined {
  const listingName = listing.name || '';
  if (!listingName) return undefined;

  // 1. Direct candidate ID / placeId match if available from synthesis
  const targetPlaceId = listing.placeId || (listing as any).sourceCandidateId;
  if (targetPlaceId) {
    const directMatch = evidenceList.find((ev) => {
      const pId = ev.candidate.sources?.googleMaps?.placeId || (ev.candidate as any).placeId;
      return pId && pId === targetPlaceId;
    });
    if (directMatch && namesAlignForEvidence(listingName, directMatch.candidate.name)) {
      return directMatch;
    }
  }

  // 2. Candidate loop with MANDATORY namesAlignForEvidence gate
  // Evidence is only bound when business names align via distinctive brand tokens,
  // preventing blind phone/domain cross-candidate hijacking.
  for (const ev of evidenceList) {
    const candidate = ev.candidate;
    const candidateDigits = candidate.phone ? normalizePhoneDigits(candidate.phone) : '';
    const hasPhoneMatch = Boolean(
      candidateDigits.length >= 7 &&
      [...(listing.phones || []), ...(listing.mobiles || [])].some((p) => {
        const d = normalizePhoneDigits(p);
        if (!d || d.length < 7) return false;
        return d === candidateDigits || d.includes(candidateDigits) || candidateDigits.includes(d);
      })
    );

    const candidateDomain = candidate.website ? domainFromUrlOrHost(candidate.website) : '';
    const hasDomainMatch = Boolean(
      candidateDomain &&
      (listing.websites || []).some((w) => extractDomain(w) === candidateDomain)
    );

    if (namesAlignForEvidence(listingName, candidate.name, { phoneMatches: hasPhoneMatch, domainMatches: hasDomainMatch })) {
      return ev;
    }
  }

  return undefined;
}

export function sanitizeListingWithEvidence(
  listing: z.infer<typeof businessListingSchema>,
  evidence: VerifiedBusinessEvidence
): z.infer<typeof businessListingSchema> {
  const candidate = evidence.candidate;
  const web = evidence.websiteEvidence;

  // ═══════════════════════════════════════════════════════════════════════════
  // ENRICHMENT GATE: Require trusted relationship + candidate name alignment
  // ═══════════════════════════════════════════════════════════════════════════
  const relationship = evidence.websiteRelationship || 'unverified';
  const sourceHealth = evidence.sourceHealth;
  const isConfirmedWrongSource =
    sourceHealth === 'wrong_source' ||
    relationship === 'directory' ||
    relationship === 'marketplace' ||
    relationship === 'service_platform' ||
    relationship === 'unrelated';

  const candidateNameKey = normalizeNameKey(candidate.name || '');
  const listingNameKey = normalizeNameKey(listing.name || '');
  const namesAlign = Boolean(
    candidateNameKey &&
      listingNameKey &&
      (listingNameKey.includes(candidateNameKey) || candidateNameKey.includes(listingNameKey))
  );

  const isFirstParty = (relationship === 'first_party' || evidence.verification?.status === 'verified') && namesAlign;
  const isCorporateParent = relationship === 'corporate_parent' && namesAlign;
  const isContactEnrichable = isFirstParty || isCorporateParent;
  const isTransientOrUnverified =
    !isFirstParty && (
      sourceHealth === 'transient_failure' ||
      sourceHealth === 'unverified' ||
      relationship === 'unverified'
    );

  const candidatePhoneDigits = normalizePhoneDigits(candidate.phone || '');
  const websiteUrl = candidate.website || web?.url || (listing.websites && listing.websites[0]) || '';
  const websiteDomain = websiteUrl ? domainFromUrlOrHost(websiteUrl) : undefined;

  // --- Contact fields: evidence-backed ONLY with Semantic Role & Ownership (Task 3) ---
  const mergedPhones: string[] = [];
  const mergedMobiles: string[] = [];
  const seenDigits = new Set<string>();
  const branchesMap = new Map<string, BranchRecord>();

  // Strict Cascade Rejection: Only inherit web contacts if isFirstParty.
  // Corporate parent and unverified websites do NOT inherit raw web contacts.
  let contactsCascadeRejected = 0;
  const allClassifiedContacts: ClassifiedContact[] = [];
  
  const isTransientFailure = sourceHealth === 'transient_failure' || sourceHealth === 'unverified';
  
  const evidenceDomain = web?.url ? domainFromUrlOrHost(web.url) : '';
  const officialDomain = (candidate as any).website ? domainFromUrlOrHost((candidate as any).website) : (candidate as any).domain || '';
  const domainCorroborated = Boolean(evidenceDomain && officialDomain && evidenceDomain === officialDomain);
  const mapsPhoneDigitsForCorroboration = normalizePhoneDigits(candidate.phone || '');
  const phoneCorroborated = Boolean(
    mapsPhoneDigitsForCorroboration &&
    web?.extractedClassifiedContacts?.some(
      (c) => c.canonicalDigits && normalizePhoneDigits(c.canonicalDigits) === mapsPhoneDigitsForCorroboration
    )
  );
  
  const isTransientButCorroborated = isTransientFailure && !isConfirmedWrongSource && (domainCorroborated || phoneCorroborated);

  if (isFirstParty || isTransientButCorroborated) {
    const contacts = web?.extractedClassifiedContacts || [];
    for (const contact of contacts) {
      allClassifiedContacts.push(
        isTransientButCorroborated && !isFirstParty
          ? { ...contact, context: `${contact.context || ''} [provisional_source]`.trim() }
          : contact
      );
    }
  } else if (web?.extractedClassifiedContacts && web.extractedClassifiedContacts.length > 0) {
    contactsCascadeRejected += web.extractedClassifiedContacts.length;
  }

  const candidateBizName = candidate.name || (candidate as any).title || listing.name;

  // Process candidate.phone into allClassifiedContacts if not already present
  const phoneSourceDomain = (candidate as any).phoneSourceDomain || (listing.otherDetails as any)?.discoveryProvenance?.phoneSourceDomain;
  const isPhoneFromRejectedDiscovery = Boolean(phoneSourceDomain && relationship !== 'first_party');

  if (candidate.phone && !isPhoneFromRejectedDiscovery) {
    const candidateClassified = classifyNepalPhone(candidate.phone);
    if (candidateClassified.type !== 'invalid') {
      const candidateRole = classifyPhoneRole(candidate.phone, candidateBizName, candidateBizName, candidateClassified, undefined, true);
      const isAlreadyClassified = allClassifiedContacts.some((c) => c.canonicalDigits === candidateClassified.digits);
      if (!isAlreadyClassified) {
        allClassifiedContacts.push({
          value: candidate.phone,
          canonicalDigits: candidateClassified.digits,
          type: 'phone',
          phoneType: candidateClassified.type,
          role: candidateRole.role,
          owner: candidateRole.owner,
          channels: candidateRole.channels,
          context: candidateBizName,
        });
      }
    }
  }

  // If no classified phone contacts exist from deep extractor, classify from extractedMobiles/extractedPhones
  if ((!web?.extractedClassifiedContacts || web.extractedClassifiedContacts.length === 0) && (isFirstParty || isTransientButCorroborated)) {
    for (const m of web?.extractedMobiles || []) {
      const classified = classifyNepalPhone(m);
      if (classified.type !== 'invalid' && !allClassifiedContacts.some((c) => c.canonicalDigits === classified.digits)) {
        const role = classifyPhoneRole(m, candidateBizName, candidateBizName, classified, web?.url || '');
        allClassifiedContacts.push({
          value: classified.normalized || m,
          canonicalDigits: classified.digits,
          type: 'phone',
          phoneType: classified.type,
          role: role.role,
          owner: role.owner,
          channels: role.channels,
          pageUrl: web?.url,
        });
      }
    }
    for (const p of web?.extractedPhones || []) {
      const classified = classifyNepalPhone(p);
      if (classified.type !== 'invalid' && !allClassifiedContacts.some((c) => c.canonicalDigits === classified.digits)) {
        const role = classifyPhoneRole(p, candidateBizName, candidateBizName, classified, web?.url || '');
        allClassifiedContacts.push({
          value: classified.normalized || p,
          canonicalDigits: classified.digits,
          type: 'phone',
          phoneType: classified.type,
          role: role.role,
          owner: role.owner,
          channels: role.channels,
          pageUrl: web?.url,
        });
      }
    }
  }

  // Deduplicate and aggregate cross-page signals across all collected contacts
  const deduplicatedContacts = deduplicateClassifiedContacts(allClassifiedContacts);

  // Phase 8k Component 3 — Four-Tier Branch Attribution
  // Replace fragile hardcoded locality regex with evidence-driven geo evaluator logic.
  const candidateCoords = candidate.coordinates;
  const candidateCoordsForBranching =
    candidateCoords &&
    typeof candidateCoords.lat === 'number' &&
    typeof candidateCoords.lng === 'number'
      ? { lat: candidateCoords.lat, lng: candidateCoords.lng }
      : undefined;

  let targetLocStr =
    (typeof listing.location === 'string' && listing.location) ||
    (typeof candidate.location === 'string' && candidate.location) ||
    'Satungal, Kathmandu';
  if (!findRegisteredLocalityCluster(targetLocStr)) {
    targetLocStr = 'Satungal, Kathmandu';
  }

  const branchAttributions = attributeMultiBranchContacts(
    deduplicatedContacts,
    targetLocStr,
    candidate.phone,
    candidateCoordsForBranching,
    null,
    candidateBizName
  );

  // Build branches[] from 'branch_contact' tier attributions
  for (const attr of branchAttributions) {
    if (attr.attribution !== 'branch_contact') continue;
    const c = attr.contact;
    const branchName = attr.branchLabel || 'Branch';
    let cleanAddr = c.context ? cleanBranchAddress(c.context, candidateBizName) : undefined;
    if (!cleanAddr || cleanAddr.length < 3) {
      cleanAddr = branchName.replace(/\s+Branch$/i, '').trim();
    }
    const existing = branchesMap.get(branchName) || {
      name: branchName,
      address: cleanAddr && cleanAddr.length >= 3 ? cleanAddr : undefined,
      phones: [],
      mobiles: [],
      emails: [],
    };
    if (c.type === 'phone') {
      if (c.phoneType === 'mobile') {
        if (!existing.mobiles.includes(c.value)) existing.mobiles.push(c.value);
      } else {
        if (!existing.phones.includes(c.value)) existing.phones.push(c.value);
      }
    } else if (c.type === 'email') {
      if (!existing.emails.includes(c.value)) existing.emails.push(c.value);
    }
    branchesMap.set(branchName, existing);
  }
  const branches = [...branchesMap.values()];

  // Unattributed-Only Policy: if ALL non-Maps contacts are unattributed, note it for
  // confidence penalty and empty phones[] downstream.
  const mapsPhoneCanonical = candidate.phone ? classifyNepalPhone(candidate.phone).digits : undefined;
  const allContactsUnattributed = isAllContactsUnattributed(branchAttributions, mapsPhoneCanonical);
  if (allContactsUnattributed) {
    incrementTelemetry('unattributedOnlyListings');
  }

  const mapsPhoneDigits = [candidate.phone]
    .filter(Boolean)
    .map((p) => classifyNepalPhone(p as string).digits)
    .filter(Boolean);

  const routePhone = (p?: string) => {
    if (!p) return;
    const classified = classifyNepalPhone(p);
    if (classified.type === 'invalid' || classified.type === 'international') return;
    if (seenDigits.has(classified.digits)) return;

    // 1. Maps phones are the absolute identity authority — promote unconditionally (Matrix rows 1, 2)
    if (mapsPhoneDigits.includes(classified.digits)) {
      seenDigits.add(classified.digits);
      const display = classified.normalized || p.trim();
      if (classified.type === 'mobile') {
        mergedMobiles.push(display);
      } else {
        mergedPhones.push(display);
      }
      return;
    }

    // 2. Non-Maps phones: consult branch attributions from Phase 8k Component 3
    const attr = branchAttributions.find(
      (a) => a.contact.canonicalDigits === classified.digits
    );

    if (attr) {
      // Branch contacts belong in branches[], never at top-level
      if (attr.attribution === 'branch_contact') {
        return;
      }
      // Unattributed contacts without Maps corroboration are suppressed
      if (attr.attribution === 'unattributed') {
        return;
      }
    }

    const contactEvidence = deduplicatedContacts.find(
      (c) => c.canonicalDigits === classified.digits
    );

    if (contactEvidence) {
      // Only promote if verified as primary business owned by the business entity
      if (contactEvidence.role !== 'primary_business' || contactEvidence.owner !== 'business') {
        return;
      }
    } else if (allClassifiedContacts.length > 0) {
      // No evidence found among classified contacts — do not promote bare/unverified numbers
      return;
    }

    seenDigits.add(classified.digits);
    const display = classified.normalized || p.trim();
    if (classified.type === 'mobile') {
      mergedMobiles.push(display);
    } else {
      mergedPhones.push(display);
    }
  };

  // 1. Authority 1: Maps/SERP phone (identity authority, E3)
  routePhone(candidate.phone);

  // 2. Authority 2: Website verified evidence
  if (isFirstParty) {
    for (const m of web?.extractedMobiles || []) routePhone(m);
    for (const p of web?.extractedPhones || []) routePhone(p);
  } else if (isCorporateParent && candidatePhoneDigits) {
    // Corporate parent: ACCEPT phone ONLY if exact canonical identity match with Maps phone
    for (const m of web?.extractedMobiles || []) {
      if (normalizePhoneDigits(m) === candidatePhoneDigits) routePhone(m);
    }
    for (const p of web?.extractedPhones || []) {
      if (normalizePhoneDigits(p) === candidatePhoneDigits) routePhone(p);
    }
  }

  // Head Office Mobile Promotion: If top-level mobiles is empty, promote primary business / Head Office mobile
  if (mergedMobiles.length === 0 && isFirstParty) {
    for (const c of allClassifiedContacts) {
      if (c.type === 'phone' && c.phoneType === 'mobile' && c.canonicalDigits && !seenDigits.has(c.canonicalDigits)) {
        if (c.owner === 'business' || c.role === 'primary_business') {
          seenDigits.add(c.canonicalDigits);
          mergedMobiles.push(c.value);
        }
      }
    }
  }

  // 3. Fallback: only if both are empty (no phones found anywhere in evidence) AND website is enrichable
  if (mergedPhones.length === 0 && mergedMobiles.length === 0 && isContactEnrichable) {
    for (const m of listing.mobiles || []) routePhone(m);
    for (const p of listing.phones || []) routePhone(p);
  }

  // Websites: ONLY the candidate's verified official website.
  const websites: string[] = [];
  if (isFirstParty || isCorporateParent || !isConfirmedWrongSource) {
    if (candidate.website && isUsableOfficialWebsite(candidate.website, candidate.name)) {
      websites.push(candidate.website);
    } else if (web?.url && isUsableOfficialWebsite(web.url, candidate.name)) {
      websites.push(web.url);
    } else if (listing.websites && listing.websites.length > 0) {
      for (const w of listing.websites) {
        if (isUsableOfficialWebsite(w, candidate.name) && !websites.includes(w)) {
          websites.push(w);
        }
      }
    }
  }

  // Emails: first_party ONLY + strict primary_business policy
  const rawEmails: string[] = [];
  if (isFirstParty) {
    for (const c of allClassifiedContacts) {
      if (c.type === 'email' && c.owner === 'business' && c.role === 'primary_business') {
        rawEmails.push(c.value);
      }
    }
    // If no classified emails found, classify from extractedEmails
    if (rawEmails.length === 0 && (web?.extractedEmails || []).length > 0) {
      for (const e of web?.extractedEmails || []) {
        const classified = classifyEmailRole(e, '', candidate.name, websiteDomain);
        allClassifiedContacts.push({
          value: e,
          type: 'email',
          role: classified.role,
          owner: classified.owner,
          channels: [],
        });
        if (classified.owner === 'business' && classified.role === 'primary_business') {
          rawEmails.push(e);
        }
      }
    }
    // Sole-Candidate Fallback Promotion (Fix 3b):
    // If top-level rawEmails is still empty AND exactly one email was extracted from the first-party site,
    // promote that sole email candidate.
    if (rawEmails.length === 0 && (web?.extractedEmails || []).length === 1) {
      const soleEmail = web!.extractedEmails[0];
      if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(soleEmail)) {
        rawEmails.push(soleEmail);
      }
    }
  }

  const emails = [...new Set(rawEmails.map(sanitizeEmailString).filter((e) => /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(e)))];

  // ═══════════════════════════════════════════════════════════════════════════
  // SOCIAL LINK INDEPENDENCE & STRICT VALIDATION (W2-07 / M2C)
  // ═══════════════════════════════════════════════════════════════════════════
  const discoveredSocials =
    (candidate as any).discoveredSocials ||
    (candidate.discoveryProvenance as any)?.discoveredSocials;

  const candidateUrlsReviewed: string[] =
    (candidate.discoveryProvenance as any)?.candidateUrlsReviewed || [];

  const rejectedProfiles: Array<{ url: string; platform: string; reason: string }> = [];

  const validateSocialCandidate = (
    url: string,
    plat?: 'facebook' | 'instagram' | 'tiktok' | 'linkedin' | 'youtube' | 'twitter' | 'other',
    origin?: 'website_evidence' | 'serp' | 'maps'
  ): string | null => {
    if (!url || !isRealSocialProfile(url, plat as any)) return null;
    const categoryCtx = [
      (listing as any).category,
      (listing as any).businessType,
      candidate.classification?.type,
      (candidate as any).type,
      (candidate as any).types,
      (candidate as any).category,
      (candidate as any).categories,
    ].flat().filter(Boolean) as string[];
    const classified = classifySocialProfile(
      url,
      plat,
      candidate.name,
      websiteDomain,
      categoryCtx,
      origin
    );
    if (classified.status === 'accepted' && (classified.owner === 'business' || classified.owner === 'person')) {
      return classified.canonicalUrl || url;
    }
    // Phase 8N Amendment 1: Promoted by SERP discovery gate with exact-query & SERP snippet corroboration
    if (
      plat === 'facebook' &&
      classified.status !== 'rejected' &&
      (candidate.discoveryProvenance?.discoveredSocials?.facebook === url ||
        candidate.discoveryProvenance?.discoveredSocials?.facebook === classified.canonicalUrl) &&
      /facebook\.com\/(?:p\/)?(?:profile\.php\?id=)?\d{8,}/i.test(url)
    ) {
      return classified.canonicalUrl || url;
    }
    const rejectionReason = isConfirmedWrongSource && origin === 'website_evidence'
      ? 'CASCADE_REJECTED_WRONG_SOURCE'
      : isTransientOrUnverified && origin === 'website_evidence'
      ? 'PROVISIONAL_SOURCE_UNVERIFIED'
      : classified.rejectionReason || 'BUSINESS_NAME_MISMATCH';
    if (!rejectedProfiles.some((r) => r.url === url)) {
      rejectedProfiles.push({
        url,
        platform: plat || 'other',
        reason: rejectionReason,
      });
    }
    return null;
  };

  // 1. Resolve Facebook
  let finalFb = '';
  if (discoveredSocials?.facebook) {
    const valid = validateSocialCandidate(discoveredSocials.facebook, 'facebook', 'serp');
    if (valid) finalFb = valid;
  }
  if (!finalFb) {
    for (const u of candidateUrlsReviewed) {
      if (/facebook\.com/i.test(u)) {
        const valid = validateSocialCandidate(u, 'facebook', 'serp');
        if (valid) {
          finalFb = valid;
          break;
        }
      }
    }
  }
  if (!finalFb && !isConfirmedWrongSource && web?.extractedSocialLinks?.facebook) {
    const valid = validateSocialCandidate(web.extractedSocialLinks.facebook, 'facebook', 'website_evidence');
    if (valid) finalFb = valid;
  }
  if (!finalFb && listing.socialLinks?.facebook) {
    const valid = validateSocialCandidate(listing.socialLinks.facebook, 'facebook', 'maps');
    if (valid) finalFb = valid;
  }

  // 2. Resolve Instagram
  let finalIg = '';
  if (discoveredSocials?.instagram) {
    const valid = validateSocialCandidate(discoveredSocials.instagram, 'instagram', 'serp');
    if (valid) finalIg = valid;
  }
  if (!finalIg) {
    for (const u of candidateUrlsReviewed) {
      if (/instagram\.com/i.test(u)) {
        const valid = validateSocialCandidate(u, 'instagram', 'serp');
        if (valid) {
          finalIg = valid;
          break;
        }
      }
    }
  }
  if (!finalIg && !isConfirmedWrongSource && web?.extractedSocialLinks?.instagram) {
    const valid = validateSocialCandidate(web.extractedSocialLinks.instagram, 'instagram', 'website_evidence');
    if (valid) finalIg = valid;
  }
  if (!finalIg && listing.socialLinks?.instagram) {
    const valid = validateSocialCandidate(listing.socialLinks.instagram, 'instagram', 'maps');
    if (valid) finalIg = valid;
  }

  // 3. Resolve TikTok
  let finalTt = '';
  if (discoveredSocials?.tiktok) {
    const valid = validateSocialCandidate(discoveredSocials.tiktok, 'tiktok', 'serp');
    if (valid) finalTt = valid;
  }
  if (!finalTt) {
    for (const u of candidateUrlsReviewed) {
      if (/tiktok\.com/i.test(u)) {
        const valid = validateSocialCandidate(u, 'tiktok', 'serp');
        if (valid) {
          finalTt = valid;
          break;
        }
      }
    }
  }
  if (!finalTt && !isConfirmedWrongSource && web?.extractedSocialLinks?.tiktok) {
    const valid = validateSocialCandidate(web.extractedSocialLinks.tiktok, 'tiktok', 'website_evidence');
    if (valid) finalTt = valid;
  }
  if (!finalTt && listing.socialLinks?.tiktok) {
    const valid = validateSocialCandidate(listing.socialLinks.tiktok, 'tiktok', 'maps');
    if (valid) finalTt = valid;
  }

  // 4. Resolve Other Socials
  const candidateOther: Record<string, { url: string; origin: 'website_evidence' | 'serp' | 'maps' }> = {};
  if (discoveredSocials?.other) {
    for (const [k, u] of Object.entries(discoveredSocials.other)) {
      if (typeof u === 'string' && u) candidateOther[k] = { url: u, origin: 'serp' };
    }
  }
  if (discoveredSocials?.linkedin) {
    candidateOther['linkedin'] = { url: discoveredSocials.linkedin, origin: 'serp' };
  }
  if (!isConfirmedWrongSource && web?.extractedSocialLinks?.other) {
    for (const [k, u] of Object.entries(web.extractedSocialLinks.other)) {
      if (typeof u === 'string' && u) candidateOther[k] = { url: u, origin: 'website_evidence' };
    }
  }
  // Check extractedSchemaSameAs as direct website evidence
  if (!isConfirmedWrongSource && web?.extractedSchemaSameAs && web.extractedSchemaSameAs.length > 0) {
    for (const sameAsUrl of web.extractedSchemaSameAs) {
      if (!finalFb && /facebook\.com/i.test(sameAsUrl)) {
        const valid = validateSocialCandidate(sameAsUrl, 'facebook', 'website_evidence');
        if (valid) finalFb = valid;
      }
      if (!finalIg && /instagram\.com/i.test(sameAsUrl)) {
        const valid = validateSocialCandidate(sameAsUrl, 'instagram', 'website_evidence');
        if (valid) finalIg = valid;
      }
      if (!finalTt && /tiktok\.com/i.test(sameAsUrl)) {
        const valid = validateSocialCandidate(sameAsUrl, 'tiktok', 'website_evidence');
        if (valid) finalTt = valid;
      }
      if (/linkedin\.com/i.test(sameAsUrl) && !candidateOther['linkedin']) {
        candidateOther['linkedin'] = { url: sameAsUrl, origin: 'website_evidence' };
      }
      if (/youtube\.com/i.test(sameAsUrl) && !candidateOther['youtube']) {
        candidateOther['youtube'] = { url: sameAsUrl, origin: 'website_evidence' };
      }
    }
  }
  if (listing.socialLinks?.other) {
    for (const [k, u] of Object.entries(listing.socialLinks.other)) {
      if (typeof u === 'string' && u && !candidateOther[k]) {
        candidateOther[k] = { url: u, origin: 'maps' };
      }
    }
  }

  const validatedOther: Record<string, string> = {};
  for (const [k, entry] of Object.entries(candidateOther)) {
    if (entry && typeof entry.url === 'string') {
      const valid = validateSocialCandidate(entry.url, k as any, entry.origin);
      if (valid) validatedOther[k] = valid;
    }
  }

  // Audit pass: Ensure unaccepted social links from websiteEvidence or raw listing are evaluated for rejectedProfiles
  if (web?.extractedSocialLinks) {
    if (web.extractedSocialLinks.facebook && web.extractedSocialLinks.facebook !== finalFb) {
      validateSocialCandidate(web.extractedSocialLinks.facebook, 'facebook', 'website_evidence');
    }
    if (web.extractedSocialLinks.instagram && web.extractedSocialLinks.instagram !== finalIg) {
      validateSocialCandidate(web.extractedSocialLinks.instagram, 'instagram', 'website_evidence');
    }
    if (web.extractedSocialLinks.tiktok && web.extractedSocialLinks.tiktok !== finalTt) {
      validateSocialCandidate(web.extractedSocialLinks.tiktok, 'tiktok', 'website_evidence');
    }
    if (web.extractedSocialLinks.other) {
      for (const [k, u] of Object.entries(web.extractedSocialLinks.other)) {
        if (typeof u === 'string' && u && validatedOther[k] !== u) {
          validateSocialCandidate(u, k as any, 'website_evidence');
        }
      }
    }
  }
  if (listing.socialLinks) {
    if (listing.socialLinks.facebook && listing.socialLinks.facebook !== finalFb) {
      validateSocialCandidate(listing.socialLinks.facebook, 'facebook', 'maps');
    }
    if (listing.socialLinks.instagram && listing.socialLinks.instagram !== finalIg) {
      validateSocialCandidate(listing.socialLinks.instagram, 'instagram', 'maps');
    }
    if (listing.socialLinks.tiktok && listing.socialLinks.tiktok !== finalTt) {
      validateSocialCandidate(listing.socialLinks.tiktok, 'tiktok', 'maps');
    }
    if (listing.socialLinks.other) {
      for (const [k, u] of Object.entries(listing.socialLinks.other)) {
        if (typeof u === 'string' && u && validatedOther[k] !== u) {
          validateSocialCandidate(u, k as any, 'maps');
        }
      }
    }
  }

  const resolvedBookingLinks =
    candidate.bookingLinks ||
    listing.otherDetails?.bookingLinks ||
    undefined;

  const rawSocialLinks = {
    facebook: finalFb,
    tiktok: finalTt,
    instagram: finalIg,
    other: validatedOther,
  };

  const completion = completeSocials({
    name: candidate.name || listing.name,
    websiteDomain: isFirstParty ? websiteDomain : undefined,
    existingSocials: rawSocialLinks,
    bookingLinks: resolvedBookingLinks,
    schemaSameAs: web?.extractedSchemaSameAs,
    discoveredSocials: discoveredSocials,
    websiteRelationship: relationship,
    existingClassifiedProfiles: (web as any)?.extractedSocialProfiles || listing.otherDetails?.classifiedSocialProfiles,
  });

  const socialLinks = completion.socialLinks;
  const socialsCascadeRejected = rejectedProfiles.length;
  const classifiedSocialProfiles = completion.classifiedProfiles;

  const originalRejectedSocials = classifiedSocialProfiles
    ? classifiedSocialProfiles.filter((p: any) => p.status === 'rejected' || p.status === 'unknown')
    : listing.otherDetails?.socialLinksRejected;

  const combinedRejectedSocials = [
    ...(Array.isArray(originalRejectedSocials) ? originalRejectedSocials : []),
    ...rejectedProfiles,
  ];

  let reconciledDiscoveryState = candidate.discoveryState || listing.otherDetails?.discoveryState;
  let reconciliationReason: string | undefined;
  if (relationship === 'unverified' || (!isFirstParty && !isCorporateParent)) {
    if (reconciledDiscoveryState === 'DISCOVERY_FOUND_FIRST_PARTY') {
      reconciledDiscoveryState = 'DISCOVERY_FOUND_ONLY_THIRD_PARTY';
      reconciliationReason = 'Provisional discovery URL rejected by downstream verification (unverified)';
    }
  }

  // Phase 8k D14 Fix: Synchronize classifiedContacts roles with branchAttributions
  for (const c of allClassifiedContacts) {
    const attr = branchAttributions.find(
      (a) =>
        (c.canonicalDigits && a.contact.canonicalDigits === c.canonicalDigits) ||
        (c.value && a.contact.value === c.value)
    );
    if (attr) {
      if (attr.attribution === 'branch_contact') {
        c.role = 'branch_contact';
        c.owner = 'branch';
      } else if (attr.attribution === 'unattributed') {
        if (c.role !== 'staff_person' && c.owner !== 'person') {
          c.role = 'unknown';
          c.owner = 'unknown';
        }
      } else if (attr.attribution === 'target_branch' || attr.attribution === 'general_business') {
        c.role = 'primary_business';
        c.owner = 'business';
      }
    }
  }

  const finalClassifiedContacts = deduplicateClassifiedContacts(allClassifiedContacts);

  // Phase 8f: Rich Maps Metadata Resolution
  const rawCandidateHours = candidate.hours || listing.otherDetails?.hours;
  const resolvedHours =
    web?.extractedHours ||
    (typeof rawCandidateHours === 'string'
      ? rawCandidateHours
      : rawCandidateHours && typeof rawCandidateHours === 'object'
      ? Object.entries(rawCandidateHours).map(([day, time]) => `${day}: ${time}`).join(', ')
      : listing.otherDetails?.hours || '');

  const resolvedPriceRange =
    candidate.priceRange ||
    (candidate as any).priceLevel ||
    listing.otherDetails?.priceRange ||
    '';

  const resolvedCategories: string[] = [
    ...new Set([
      ...(candidate.categories || []),
      ...(listing.otherDetails?.categories || []),
      ...(candidate.category ? [candidate.category] : []),
      ...(listing.businessType ? [listing.businessType] : []),
    ]),
  ].filter(Boolean);

  const resolvedBusinessDesc =
    candidate.description ||
    listing.otherDetails?.businessDescription ||
    undefined;

  const resolvedThumbnail =
    candidate.thumbnailUrl ||
    listing.otherDetails?.thumbnailUrl ||
    undefined;

  const resolvedServices =
    isFirstParty && web?.extractedServices?.length
      ? web.extractedServices
      : ((listing.otherDetails as any)?.services?.length
          ? (listing.otherDetails as any).services
          : (resolvedCategories.length > 0 ? resolvedCategories : []));

  const otherDetails = {
    ...listing.otherDetails,
    mapsPhone: candidate.phone || listing.otherDetails?.mapsPhone || 'N/A',
    websiteRelationship: relationship,
    branches: branches.length > 0 ? branches : listing.otherDetails?.branches,
    classifiedContacts: finalClassifiedContacts.length > 0
      ? finalClassifiedContacts
      : isContactEnrichable
      ? listing.otherDetails?.classifiedContacts
      : undefined,
    classifiedSocialProfiles: classifiedSocialProfiles && classifiedSocialProfiles.length > 0 ? classifiedSocialProfiles : undefined,
    socialLinksRejected: combinedRejectedSocials.length > 0 ? combinedRejectedSocials : undefined,
    socialsCascadeRejected: socialsCascadeRejected > 0 ? socialsCascadeRejected : undefined,
    contactsCascadeRejected: contactsCascadeRejected > 0 ? contactsCascadeRejected : undefined,
    discoveryState: reconciledDiscoveryState,
    reconciliationReason,
    discoveryProvenance: candidate.discoveryProvenance || listing.otherDetails?.discoveryProvenance,
    categories: resolvedCategories.length > 0 ? resolvedCategories : undefined,
    services: resolvedServices,
    hours: resolvedHours || undefined,
    priceRange: resolvedPriceRange || undefined,
    businessDescription: resolvedBusinessDesc,
    thumbnailUrl: resolvedThumbnail,
    bookingLinks: resolvedBookingLinks,
  };

  const finalIcon = (isFirstParty || isCorporateParent) ? (web?.favicon || listing.icon || '') : '';

  return {
    ...listing,
    emails,
    phones: mergedPhones,
    mobiles: mergedMobiles,
    websites,
    icon: finalIcon,
    socialLinks,
    otherDetails,
    metadata: {
      ...listing.metadata,
      // Task 5: metadata.confidence is computed in Phase 4 (grounded score).
      confidence: listing.metadata?.confidence ?? evidence.verification.overallConfidence,
    },
    // Only rewrite `process` when real website evidence backs the claim and enrichable.
    process: web && isContactEnrichable
      ? `Evidence-verified via ${relationship} website (status: ${evidence.verification.status}, confidence: ${evidence.verification.overallConfidence})`
      : listing.process,
  };
}
