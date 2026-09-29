/**
 * Step 4 — supervisor synthesis: conflict resolution, sanitization,
 * final artifact + summary writes.
 */

import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { extractDomain } from '@/services/discovery/search-fallback.service';
import {
  saveStageOutput,
  saveSummaryReport,
  endRunSession,
  getActiveRunSession,
  getRunSessionId,
} from '@/services/storage/output-storage.service';
import { getLlmMultiBusinessCallCount } from '@/services/business-extractor.service';
import { getTelemetry } from '@/services/telemetry.service';
import {
  getCurrentRunId,
  logRunStep,
  startTimer,
  getApiCallCounters
} from '@/services/observability/run-log.service';
import { mergeDuplicateEntities } from '@/services/resolution/entity-resolution.service';
import { completeSocials } from '@/services/resolution/social-completion.service';
import {
  researchReportSchema,
  researchCandidateSchema
} from '@/mastra/agents/research-agent/schema';
import {
  normalizePhoneDigits,
  normalizeNameKey,
  domainFromUrlOrHost,
  detectCrossListingConflicts
} from '@/services/resolution/entity-resolution.service';
import { classifyNepalPhone } from '@/services/business-extractor.service';
import {
  buildCacheKeys,
  canonicalKeyFor,
  getMongoHealth,
  saveRunRecord,
  upsertBusinesses
} from '@/services/storage/mongo.service';
import { verifiedBusinessEvidenceSchema } from '@/mastra/agents/research-agent/verification.schema';
import {
  computeConfidenceBreakdown,
  validateConfidenceIntegrity,
  type ConfidenceInputs,
} from '@/services/resolution/confidence.service';

import {
  businessListingSchema,
  type LedgerStatus
} from '@/types/index.js';
import { finalizeCacheHit } from '@/mastra/workflows/steps/finalize-cache-hit';
import { buildSupervisorPrompt } from '@/mastra/workflows/research-prompts';
import {
  buildCandidateLedgerId,
  candidateMatchesListing,
} from '@/services/storage/candidate-ledger.service';
import { buildFallbackListing } from '@/services/resolution/fallback-listing.service';
import {
  applyTargetCandidatesCap,
  normalizeListingPhones,
} from '@/services/resolution/cascade-policy.service';
import {
  matchListingToEvidence,
  sanitizeListingWithEvidence,
} from '@/services/resolution/listing-sanitizer.service';
import {
  candidateSchema,
  extractionSchema,
  cachePassthroughSchema
} from '@/mastra/workflows/workflow-contracts';

export const supervisorSynthesisStep = createStep({
  id: 'supervisor-synthesis',
  inputSchema: z.object({
    candidates: z.array(candidateSchema),
    researchCandidates: z.array(researchCandidateSchema).optional(),
    extractions: z.array(extractionSchema),
    verifiedEvidence: z.array(verifiedBusinessEvidenceSchema).optional(),
    query: z.string(),
    location: z.string().optional(),
    autoApprove: z.boolean().default(true),
    agentId: z.string().optional(),
    researchReport: researchReportSchema.optional(),
    ...cachePassthroughSchema,
  }),
  outputSchema: z.object({
    listings: z.array(businessListingSchema),
    researchReport: researchReportSchema.optional(),
    verifiedEvidence: z.array(verifiedBusinessEvidenceSchema).optional(),
  }),
  execute: async ({ inputData, mastra }) => {
    // NOTE: the pre-existing `runId` in this step is the run SESSION id used for
    // output/history paths. `logRunId` is the observability run id and must not
    // shadow it.
    const logRunId = getCurrentRunId();
    const elapsed = startTimer();
    const { candidates, extractions, verifiedEvidence, query, location, agentId, researchReport } = inputData;
    const runStartedAt = new Date().toISOString();

    // ------------------------------------------------------------------
    // M1 cache-hit branch: serve the frozen snapshot and finalize.
    // Placed BEFORE any synthesis work so the LLM is never called, and returns
    // through `finalizeCacheHit` (which owns the artifact + run-record writes for
    // this path). `businesses` is never touched here: nothing was re-verified.
    // ------------------------------------------------------------------
    if (inputData.fromCache) {
      const finalized = await finalizeCacheHit({
        listings: inputData.cachedListings ?? [],
        query,
        location,
        runId: getRunSessionId(query, location),
        sourceRunId: inputData.cacheSourceRunId,
        cachePolicyDays: inputData.cachePolicyDays,
        runConfig: inputData.runConfig,
        researchReport,
        verifiedEvidence,
      });
      logRunStep(logRunId, 4, 'skipped', elapsed(), {
        reason: 'cache_hit',
        listings: finalized.listings?.length ?? 0,
        sourceRunId: inputData.cacheSourceRunId,
      });
      return finalized;
    }

    console.log(
      `[Workflow:Step3] Supervisor synthesizing ${candidates.length} candidates + ${extractions.length} extractions` +
        (verifiedEvidence ? ` + ${verifiedEvidence.length} verified evidence records` : '')
    );

    const prompt = buildSupervisorPrompt(query, location, candidates, extractions, verifiedEvidence);
    let rawListings: any[] = [];

    const parseListingsFromJson = (text: string): any[] => {
      let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
      cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');

      try {
        const parsedJson = JSON.parse(cleaned);
        if (Array.isArray(parsedJson)) return parsedJson;
        if (parsedJson && Array.isArray(parsedJson.listings)) return parsedJson.listings;
        if (parsedJson && typeof parsedJson === 'object') return [parsedJson];
      } catch {
        // Fallback for LLM responses with conversational text around JSON
        const jsonMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch) {
          try {
            let innerClean = jsonMatch[0].replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
            innerClean = innerClean.replace(/,\s*([\]}])/g, '$1');
            const innerParsed = JSON.parse(innerClean);
            if (Array.isArray(innerParsed)) return innerParsed;
          } catch {
            // pass
          }
        }
      }
      return [];
    };

    // --- SYNTHESIS ARCHITECTURE ---
    // Note: Layer 1 (UnoRouter Tribunal with free-tier models) has been removed to eliminate
    // rate-limit timeout cascades and latency overhead. Paid consensus evaluation (e.g. NVIDIA Nemotron)
    // is formally deferred to Phase 8i.
    // Synthesis executes Layer 2 (Supervisor Agent) directly, falling back to Layer 3 (Deterministic Fallback).

    // --- LAYER 2: OpenRouter Supervisor Agent ---
    if (rawListings.length === 0) {
      const preferredAgentId = agentId || 'gemma-supervisor-agent';
      let agent: any = null;
      try {
        agent = mastra?.getAgentById?.(preferredAgentId);
      } catch {
        agent = null;
      }

      if (agent) {
        try {
          console.log(`[Workflow:Step3] Invoking Layer 2: ${preferredAgentId}...`);
          const agentPromise = agent.generate(prompt);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Agent ${preferredAgentId} timed out after 20s`)), 20000)
          );
          const response = (await Promise.race([agentPromise, timeoutPromise])) as any;
          const parsed = parseListingsFromJson(response.text);
          if (parsed.length > 0) {
            console.log(`[Workflow:Step3] Synthesis succeeded via ${preferredAgentId} (${parsed.length} listings)`);
            rawListings = parsed;
          } else {
            console.warn(`[Workflow:Step3] ${preferredAgentId} produced unparseable listings. Cascading to Layer 3...`);
          }
        } catch (err) {
          console.warn(`[Workflow:Step3] Agent generation failed: ${(err as Error).message}. Cascading to Layer 3...`);
        }
      }
    }

    // --- LAYER 3: Zero-Token Deterministic Fallback ---
    if (rawListings.length === 0) {
      console.log('[Workflow:Step3] Invoking Layer 3: Zero-token Deterministic Fallback Extraction...');
      rawListings = candidates.map((c) => buildFallbackListing(c, extractions, verifiedEvidence, location, runStartedAt));
    }

    let listings = (Array.isArray(rawListings) ? rawListings : [])
      .map((item) => {
        const parsed = businessListingSchema.safeParse(item);
        if (parsed.success) return parsed.data;
        console.warn('[Workflow:Step3] Listing failed schema validation, applying defaults');
        return businessListingSchema.parse({
          name: item?.name || 'Unknown Name',
          metadata: {
            source: 'web',
            extractedAt: new Date().toISOString(),
            runStartedAt,
            confidence: 0,
          },
        });
      })
      .filter((item) => item.name !== 'Unknown Name');

    const excludedInGeoRevalidation = new Map<string, string>();
    const autoMergedCandidates = new Map<string, string>();
    const zeroActionableFiltered = new Set<string>();
    const cappedOutListings = new Set<string>();

    // Filter out any listings whose candidate evidence was excluded during Step 2 address revalidation
    if (verifiedEvidence && verifiedEvidence.length > 0) {
      listings = listings.filter((l) => {
        const ev = matchListingToEvidence(l, verifiedEvidence);
        if (ev && ((ev.candidate as any).isGeographicallyExcluded || (ev as any).isGeographicallyExcluded)) {
          const reason =
            (ev.candidate as any).geographicExclusionReason ||
            (ev as any).geographicExclusionReason ||
            'Excluded during Step 2 address revalidation';
          console.log(
            `[Workflow:Step3] Dropping geographically excluded listing: "${l.name}" (${reason})`
          );
          if (ev.candidate.website) excludedInGeoRevalidation.set(ev.candidate.website, reason);
          if (ev.candidate.phone) excludedInGeoRevalidation.set(normalizePhoneDigits(ev.candidate.phone), reason);
          excludedInGeoRevalidation.set(normalizeNameKey(l.name), reason);
          return false;
        }
        return true;
      });
    }

    // ========================================================================
    // Post-Synthesis: Deterministic GPS & Phone Re-injection + Tradesmen Preservation
    // ========================================================================
    const preservableCandidates = candidates;
    const matchedCandidateUrls = new Set<string>();

    for (const listing of listings) {
      const match = preservableCandidates.find((m) => {
        if (matchedCandidateUrls.has(m.url)) return false;

        // 1. Domain match
        if (listing.websites && listing.websites.length > 0 && m.domain && !m.domain.includes('google.com')) {
          if (listing.websites.some((w) => extractDomain(w) === m.domain)) return true;
        }

        // 2. Phone match
        if (m.phoneNumber) {
          const cleanMapPhone = m.phoneNumber.replace(/\D/g, '');
          if (cleanMapPhone.length >= 7) {
            const hasPhone = [...listing.phones, ...listing.mobiles].some((p) =>
              p.replace(/\D/g, '').includes(cleanMapPhone) || cleanMapPhone.includes(p.replace(/\D/g, ''))
            );
            if (hasPhone) return true;
          }
        }

        // 3. Name similarity match
        const listName = listing.name.toLowerCase().trim();
        const mapName = m.title.toLowerCase().trim();
        if (listName && mapName && (listName.includes(mapName) || mapName.includes(listName))) {
          return true;
        }

        return false;
      });

      if (match) {
        matchedCandidateUrls.add(match.url);

        // Deterministically re-inject exact GPS coordinates
        if (match.latitude !== undefined && match.longitude !== undefined) {
          listing.gpsCoordinates = {
            latitude: match.latitude,
            longitude: match.longitude,
          };
        }

        // Deterministically re-inject rating, count, placeId, type, and address
        if (match.rating !== undefined) listing.rating = match.rating;
        if (match.ratingCount !== undefined) listing.ratingCount = match.ratingCount;
        if (match.placeId) listing.placeId = match.placeId;
        if (match.businessType && !listing.businessType) listing.businessType = match.businessType;
        if (match.address && (!listing.location || listing.location.length < 5)) {
          listing.location = match.address;
        }

        // Prepend verified Maps phone if not present
        if (match.phoneNumber) {
          const classified = classifyNepalPhone(match.phoneNumber);
          if (classified.type !== 'invalid') {
            const allCurrent = [...listing.phones, ...listing.mobiles];
            const alreadyHas = allCurrent.some(
              (p) => normalizePhoneDigits(p) === classified.digits
            );
            if (!alreadyHas) {
              const display = classified.normalized || match.phoneNumber.trim();
              if (classified.type === 'mobile') {
                listing.mobiles.unshift(display);
              } else {
                listing.phones.unshift(display);
              }
            }
          }
        }
      }
    }

    // Adjustment 3: Preserve any accepted candidate that the supervisor omitted.
    for (const m of preservableCandidates) {
      if (!matchedCandidateUrls.has(m.url)) {
        if (m.source !== 'google_maps') {
          console.log(`[Workflow:Step3] Preserving unlisted web candidate: "${m.title}"`);
          listings.push(buildFallbackListing(m, extractions, verifiedEvidence, location, runStartedAt));
          continue;
        }

        console.log(`[Workflow:Step3] Preserving unlisted Google Maps business: "${m.title}"`);
        const hasSite = m.domain && !m.domain.includes('google.com');
        const fallbackPlaceLocation = m.address || location || 'Kathmandu, Nepal';

        // ── GAP 2 FIX: Classify tradesman Maps phone into correct array ──
        const rawTradesmanPhone = m.phoneNumber?.trim();
        const classifiedTradesmanPhone = rawTradesmanPhone
          ? classifyNepalPhone(rawTradesmanPhone)
          : null;

        let tradesmanPhones: string[] = [];
        let tradesmanMobiles: string[] = [];
        if (classifiedTradesmanPhone && classifiedTradesmanPhone.type !== 'invalid') {
          const display = classifiedTradesmanPhone.normalized || rawTradesmanPhone || '';
          if (classifiedTradesmanPhone.type === 'mobile') {
            tradesmanMobiles = [display];
          } else {
            tradesmanPhones = [display];
          }
        }

        const preservedListing: z.infer<typeof businessListingSchema> = {
          name: m.title,
          location: fallbackPlaceLocation,
          emails: [],
          phones: tradesmanPhones,
          mobiles: tradesmanMobiles,
          websites: hasSite ? [m.url] : [],
          icon: '',
          socialLinks: { facebook: '', tiktok: '', instagram: '', other: {} },
          otherDetails: {
            address: fallbackPlaceLocation,
            rating: m.rating,
            ratingCount: m.ratingCount,
            businessType: m.businessType,
            source: 'google_maps',
            discoveryState: m.discoveryState,
            discoveryProvenance: m.discoveryProvenance,
          },
          gpsCoordinates:
            m.latitude !== undefined && m.longitude !== undefined
              ? { latitude: m.latitude, longitude: m.longitude }
              : undefined,
          rating: m.rating,
          ratingCount: m.ratingCount,
          businessType: m.businessType,
          placeId: m.placeId,
          metadata: {
            source: 'google_maps',
            extractedAt: new Date().toISOString(),
            runStartedAt,
            confidence: 0,
          },
          process: 'Verified via Google Maps Places (Direct)',
          links: m.url ? [m.url] : [],
        };
        listings.push(preservedListing);
      }
    }

    console.log(`[Workflow:Step3] Supervisor produced ${listings.length} structured listings`);

    // ====================================================================
    // Phase 2: Post-synthesis evidence sanitizer (Correction 3).
    // Contact fields in matched listings are overwritten with deterministic
    // evidence-backed values. Maps identity fields were already re-injected
    // above and are left untouched by the sanitizer.
    // ====================================================================
    if (verifiedEvidence && verifiedEvidence.length > 0) {
      let sanitizedCount = 0;
      for (const listing of listings) {
        const ev = matchListingToEvidence(listing, verifiedEvidence);
        if (!ev) continue;
        const sanitized = sanitizeListingWithEvidence(listing, ev);
        Object.assign(listing, sanitized);

        const completed = completeSocials({
          name: listing.name,
          websiteDomain: listing.websites?.[0] ? domainFromUrlOrHost(listing.websites[0]) : undefined,
          existingSocials: listing.socialLinks,
          bookingLinks: (listing.otherDetails as any)?.bookingLinks || (ev.candidate as any)?.bookingLinks,
          schemaSameAs: ev.websiteEvidence?.extractedSchemaSameAs,
          websiteRelationship: ev.websiteRelationship,
          existingClassifiedProfiles: (listing.otherDetails as any)?.classifiedSocialProfiles,
        });
        listing.socialLinks = completed.socialLinks;
        if ((listing.otherDetails as any)) {
          (listing.otherDetails as any).classifiedSocialProfiles = completed.classifiedProfiles;
        }

        sanitizedCount++;
        console.log(
          `[Workflow:Step3] Evidence-sanitized "${listing.name}" (status: ${ev.verification.status}, confidence: ${ev.verification.overallConfidence})`
        );
      }
      console.log(`[Workflow:Step3] Sanitized ${sanitizedCount}/${verifiedEvidence.length} evidence records onto listings`);
    }

    // Auto-merge duplicate entities (shared domain, phone, or social + entity alignment)
    const { mergedListings, autoMergedCount } = mergeDuplicateEntities(listings);
    if (autoMergedCount > 0) {
      console.log(
        `[Workflow:Step3] Auto-merged ${autoMergedCount} duplicate listings using 4-tier deterministic resolution`
      );
      for (const m of mergedListings) {
        const aliases = (m.otherDetails as any)?.mergedAliases || [];
        for (const alias of aliases) {
          const aliasName = typeof alias === 'string' ? alias : alias?.name || '';
          if (aliasName) {
            autoMergedCandidates.set(normalizeNameKey(aliasName), m.name);
          }
        }
      }
      listings = mergedListings;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 2.5: Phone Taxonomy Enforcement (Task 4 — GAP 3 Safety Net)
    //
    // Even when the sanitizer skips a listing (no evidence match), enforce
    // the strict phone taxonomy. Every number is re-classified and routed.
    // This guarantees phones ∩ mobiles = ∅ before downstream processing.
    // ═══════════════════════════════════════════════════════════════════════
    for (const listing of listings) {
      normalizeListingPhones(listing);
    }

    // Programmatic verification of phone taxonomy invariant across all final listings
    for (const listing of listings) {
      const canonicalPhones = (listing.phones || []).map((p) => normalizePhoneDigits(p));
      const canonicalMobiles = (listing.mobiles || []).map((p) => normalizePhoneDigits(p));
      const allCanonical = [...canonicalPhones, ...canonicalMobiles];
      const uniqueCanonical = new Set(allCanonical);
      if (allCanonical.length !== uniqueCanonical.size) {
        throw new Error(
          `[Workflow:Step3] Fatal Phone Invariant Violation on listing "${listing.name}": duplicate canonical phones found across phones and mobiles.`
        );
      }
    }

    // ====================================================================
    // Post-Sanitization Cross-Listing Conflict & Cluster Detection (Task 3 / Task 9)
    // ====================================================================
    const conflictReport = detectCrossListingConflicts(listings);

    // Log conflict summary
    if (conflictReport.conflicts.length > 0) {
      console.log(
        `[Workflow:Step3] Cross-listing conflict detector identified ${conflictReport.conflicts.length} conflict(s) across ${conflictReport.clusters.length} cluster(s)`
      );
    } else {
      console.log('[Workflow:Step3] Cross-listing conflict detector: No conflicts found across listings');
    }

    // Task 9: ALWAYS write conflict artifact envelope (even when conflicts = 0)
    const session = getActiveRunSession();
    const currentRunId = session?.runId || getRunSessionId(query, location);
    const conflictArtifact = {
      runId: currentRunId,
      generatedAt: new Date().toISOString(),
      conflicts: conflictReport.conflicts,
      clusters: conflictReport.clusters,
      conflictCount: conflictReport.conflicts.length,
    };
    saveStageOutput('conflicts', 'entity-conflicts.json', conflictArtifact, query);

    // Reapply conflict annotations back to listings (Task 5 fix).
    // Per the detectCrossListingConflicts() contract, annotatedListings
    // preserves order: annotatedListings[i] corresponds to listings[i].
    // Safety: only apply if lengths match (no pre-filtering).
    if (conflictReport.annotatedListings.length === listings.length) {
      for (let i = 0; i < listings.length; i++) {
        const ann = conflictReport.annotatedListings[i] as {
          otherDetails?: Record<string, unknown>;
        };
        const conflict = ann.otherDetails?.entityConflict as {
          hasConflict?: boolean;
          conflictType?: string;
        } | undefined;
        if (conflict?.hasConflict && !listings[i].otherDetails?.entityConflict) {
          if (!listings[i].otherDetails) listings[i].otherDetails = {};
          listings[i].otherDetails.entityConflict = ann.otherDetails?.entityConflict;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Phase 4: Multi-Dimensional Confidence Computation (Task 5)
    // ═══════════════════════════════════════════════════════════════════
    for (const listing of listings) {
      const ev = verifiedEvidence ? matchListingToEvidence(listing, verifiedEvidence) : undefined;
      const conflict = listing.otherDetails?.entityConflict as {
        conflictType?: string;
      } | undefined;

      const inputs: ConfidenceInputs = {
        // Maps signals
        isMapsCandidate: listing.metadata?.source === 'google_maps' || Boolean(listing.placeId) || Boolean(listing.ratingCount),
        mapsPhone: (listing.otherDetails as any)?.mapsPhone || (listing as any).mapsPhone || ev?.candidate?.phone || (ev?.candidate?.sources?.googleMaps as any)?.phone,
        rating: listing.rating ?? (listing.metadata as any)?.rating,
        ratingCount: listing.ratingCount ?? (listing.metadata as any)?.ratingCount,
        placeId: listing.placeId ?? (listing.metadata as any)?.placeId,
        gpsCoordinates: listing.gpsCoordinates ?? (listing.metadata as any)?.gpsCoordinates,
        address: listing.location,

        // Website evidence (explicit — avoids fragile inference)
        hasWebsiteEvidence: Boolean(
          (listing.websites && listing.websites.length > 0) ||
          (ev && ev.websiteEvidence)
        ),

        // Verification signals
        verificationConfidence: ev?.verification?.overallConfidence,
        verificationChecks: ev?.verification?.checks
          ? {
              phoneMatchesMaps: ev.verification.checks.phoneMatchesMaps ?? false,
              emailFoundOnWebsite: ev.verification.checks.emailFoundOnWebsite ?? false,
              addressOrLocationFoundOnWebsite: ev.verification.checks.addressOrLocationFoundOnWebsite ?? false,
            }
          : undefined,

        // Relationship
        websiteRelationship: listing.otherDetails?.websiteRelationship,

        // Final listing contents — authoritative projection of accepted evidence
        finalEmails: listing.emails,
        finalWebsites: listing.websites,
        finalPhones: listing.phones,
        finalMobiles: listing.mobiles,

        // Contact (Task 4 guarantees unique identity across phones + mobiles)
        phonesCount: listing.phones?.length ?? 0,
        mobilesCount: listing.mobiles?.length ?? 0,

        // Conflict
        conflictType: conflict?.conflictType,
      };

      const breakdown = computeConfidenceBreakdown(inputs);

      // Assign confidence BEFORE validation (so the invariant can be checked)
      if (!listing.metadata) {
        listing.metadata = {
          source: 'web',
          extractedAt: new Date().toISOString(),
          runStartedAt,
          confidence: breakdown.overallConfidence,
        };
      } else {
        listing.metadata.confidence = breakdown.overallConfidence;
      }
      (listing.metadata as any).confidenceBreakdown = breakdown;

      // Validate integrity — both dimensions in [0,1] and equality
      const validation = validateConfidenceIntegrity(
        breakdown,
        listing.metadata.confidence
      );
      if (!validation.valid) {
        console.warn(
          `[Workflow:Step3] Confidence integrity FAILED for "${listing.name}":`,
          validation.errors
        );
      }
    }

    console.log(
      `[Workflow:Step3] Phase 4 computed confidence for ${listings.length} listings`
    );

    // Phase 8h (W2-05): Zero-actionable candidate filter
    // Drops any listing where all contact channels (phones, mobiles, emails, websites) are completely empty
    const actionableListings = listings.filter((l) => {
      const hasPhone = (l.phones && l.phones.length > 0) || (l.mobiles && l.mobiles.length > 0);
      const hasEmail = l.emails && l.emails.length > 0;
      const hasWebsite = l.websites && l.websites.length > 0;
      const isActionable = hasPhone || hasEmail || hasWebsite;
      if (!isActionable) {
        console.log(
          `[Workflow:Step3] W2-05 Filter: Dropping zero-actionable listing "${l.name}" (0 phones, 0 mobiles, 0 emails, 0 websites)`
        );
        zeroActionableFiltered.add(normalizeNameKey(l.name));
      }
      return isActionable;
    });
    listings = actionableListings;

    // Phase 8h (W2-08): Quality-sorted final output cap
    const explicitTarget = researchReport?.targetCandidates;
    if (explicitTarget !== undefined && listings.length > explicitTarget) {
      console.log(
        `[Workflow:Step3] Enforcing W2-08 output cap: sorting ${listings.length} listings by quality and capping to target ${explicitTarget}`
      );
      const beforeCap = listings;
      listings = applyTargetCandidatesCap(listings, explicitTarget);
      for (const item of beforeCap) {
        if (!listings.includes(item)) {
          cappedOutListings.add(normalizeNameKey(item.name));
        }
      }
    }

    const totalCascadeSocials = listings.reduce(
      (acc, l) => acc + (Number((l.otherDetails as any)?.socialsCascadeRejected) || 0),
      0
    );
    const totalCascadeContacts = listings.reduce(
      (acc, l) => acc + (Number((l.otherDetails as any)?.contactsCascadeRejected) || 0),
      0
    );
    if (totalCascadeSocials > 0 || totalCascadeContacts > 0) {
      console.log(
        `[Workflow:Step3] Cascade rejection summary: dropped ${totalCascadeSocials} unverified social profile(s) and ${totalCascadeContacts} contact(s) from non-first-party domains`
      );
    }

    // Save final artifacts AFTER post-synthesis sanitization and location backfill
    saveStageOutput('final-listings', '3-final-listings.json', listings, query);
    saveStageOutput('results', 'results.json', listings, query);

    // ------------------------------------------------------------------
    // M1: identity merge + run history (NORMAL path only).
    // A cache hit returned above and never reaches this block, so
    // lastVerifiedAt can only move when work was actually performed.
    // ------------------------------------------------------------------
    const runId = getRunSessionId(query, location);
    const completedAt = new Date();
    const upsertResult = await upsertBusinesses(listings, {
      query,
      location,
      runId,
      completedAt,
      markVerified: true,
    });
    const runRecordSaved = await saveRunRecord({
      runId,
      query,
      location,
      status: listings.length > 0 ? 'success' : 'empty',
      listings,
      servedFromCache: false,
      refreshRequested: Boolean(inputData.refreshRequested),
      inputConfig: { ...(inputData.runConfig ?? {}), maxCacheAgeDays: inputData.cachePolicyDays },
      completedAt,
      startedAt: new Date(runStartedAt),
    });

    const candidateLedger = candidates.map((candidate) => {
      const candidateId = buildCandidateLedgerId(candidate);
      const finalListing = listings.find((listing) => candidateMatchesListing(candidate, listing));
      const normName = normalizeNameKey(candidate.title || '');
      const normPhone = normalizePhoneDigits(candidate.phoneNumber || '');
      const normDomain = candidate.domain ? domainFromUrlOrHost(candidate.domain) : '';

      let status: LedgerStatus;
      let reason: string | undefined;

      if (finalListing) {
        const locationKey = buildCacheKeys(query, location).locationKey;
        const candidateKey = canonicalKeyFor(finalListing, locationKey);
        const perStatus = candidateKey ? upsertResult.perCandidateStatus?.get(candidateKey) : undefined;
        
        if (perStatus === 'persisted' || (!perStatus && upsertResult.skipped === 0 && runRecordSaved)) {
          status = 'persisted';
          reason = undefined;
        } else if (perStatus === 'upsert_failed') {
          status = 'upsert_failed' as LedgerStatus;
          reason = `MongoDB write error for candidate "${candidate.title}"`;
        } else {
          status = 'verification_failed';
          reason = upsertResult.reason || 'Mongo persistence did not confirm this listing';
        }
      } else if (
        excludedInGeoRevalidation.has(candidate.url) ||
        (normDomain && excludedInGeoRevalidation.has(normDomain)) ||
        (normPhone && excludedInGeoRevalidation.has(normPhone)) ||
        (normName && excludedInGeoRevalidation.has(normName))
      ) {
        status = 'geography_rejected';
        reason =
          excludedInGeoRevalidation.get(candidate.url) ||
          excludedInGeoRevalidation.get(normDomain) ||
          excludedInGeoRevalidation.get(normPhone) ||
          excludedInGeoRevalidation.get(normName) ||
          'Excluded during Step 2 address revalidation';
      } else if (zeroActionableFiltered.has(normName)) {
        status = 'zero_actionable_fields';
        reason = 'Filtered out: 0 phones, 0 mobiles, 0 emails, 0 websites';
      } else if (cappedOutListings.has(normName)) {
        status = 'synthesis_omission';
        reason = `Omitted due to targetCandidates cap (${explicitTarget})`;
      } else if (autoMergedCandidates.has(normName)) {
        status = 'deduplicated';
        reason = `Merged into listing "${autoMergedCandidates.get(normName)}" during entity resolution`;
      } else {
        status = 'synthesis_omission';
        reason = 'Omitted during supervisor synthesis or final deduplication';
      }

      return {
        candidateId,
        name: candidate.title,
        source: candidate.source,
        status,
        finalListingName: finalListing?.name,
        reason,
      };
    });

    const reasonCounts: Record<LedgerStatus, number> = {
      persisted: 0,
      synthesis_omission: 0,
      verification_failed: 0,
      zero_actionable_fields: 0,
      geography_rejected: 0,
      provider_exhausted: 0,
      deduplicated: 0,
      category_rejected: 0,
      budget_skipped: 0,
      upsert_failed: 0,
    };
    for (const c of candidateLedger) {
      reasonCounts[c.status]++;
    }

    const discoveredCount = researchReport?.uniqueBusinessesFound || candidates.length;
    const acceptedCount = candidates.length;
    const persistedCount = reasonCounts.persisted;
    const requestedTarget = researchReport?.targetCandidates;
    const shortfall = requestedTarget ? Math.max(0, requestedTarget - persistedCount) : 0;

    // Save high-level summary report for latest consumer and history archive
    saveSummaryReport({
      query,
      location,
      totalBusinesses: listings.length,
      requestedTarget,
      discovered: discoveredCount,
      accepted: acceptedCount,
      finalized: listings.length,
      persisted: persistedCount,
      shortfall,
      reasonCounts,
      conflictsDetected: conflictReport.conflicts.length,
      sources: {
        googleMaps: (researchReport?.researchCandidates || []).filter((c) => c.sources?.googleMaps?.found).length,
        webSearch: (researchReport?.researchCandidates || []).filter((c) => c.sources?.webSearch && c.sources.webSearch.length > 0).length,
        officialWebsitesCrawled: verifiedEvidence ? verifiedEvidence.filter((e) => e.websiteEvidence).length : 0,
      },
      contactsFound: {
        withPhone: listings.filter(
          (l) => (l.phones && l.phones.length > 0) || (l.mobiles && l.mobiles.length > 0)
        ).length,
        withEmail: listings.filter((l) => l.emails && l.emails.length > 0).length,
        withWebsite: listings.filter((l) => l.websites && l.websites.length > 0).length,
        withSocialLinks: listings.filter((l) => {
          const s = l.socialLinks;
          return Boolean(s && (s.facebook || s.tiktok || s.instagram || (s.other && Object.keys(s.other).length > 0)));
        }).length,
      },
      telemetry: {
        llmMultiBusinessCallsUsed: getLlmMultiBusinessCallCount(),
        socialsCascadeRejected: totalCascadeSocials,
        contactsCascadeRejected: totalCascadeContacts,
        streetNameCollisionsCaught: getTelemetry().streetNameCollisionsCaught,
        conflictingLocalityExclusions: getTelemetry().conflictingLocalityExclusions,
        tieredCorroborationRejections: getTelemetry().tieredCorroborationRejections,
        directorySubdomainPenalties: getTelemetry().directorySubdomainPenalties,
        templateFingerprintMatches: getTelemetry().templateFingerprintMatches,
        socialUrlsCanonicalized: getTelemetry().socialUrlsCanonicalized,
        /** Outbound dependency spend: calls made vs. served from cache. */
        apiCallCounters: getApiCallCounters(),
        /** WHY storage was skipped when it was — never conflated with cacheLookupStatus. */
        mongoHealth: getMongoHealth(),
      },
      status: listings.length > 0 ? 'success' : 'empty',
      synthesisMethod: 'OpenRouter Supervisor Agent / Deterministic Fallback',
      cacheLookupStatus: inputData.cacheLookupStatus ?? 'miss',
    });

    saveStageOutput(
      'candidate-ledger',
      'candidate-ledger.json',
      {
        query,
        location,
        requestedTarget,
        discovered: discoveredCount,
        accepted: acceptedCount,
        finalized: listings.length,
        persisted: persistedCount,
        shortfall,
        reasonCounts,
        upsertResult,
        runRecordSaved,
        candidates: candidateLedger,
      },
      query
    );

    endRunSession();

    logRunStep(logRunId, 4, 'ok', elapsed(), {
      listings: listings.length,
      requested: inputData.runConfig?.targetCandidates,
      evidence: verifiedEvidence?.length ?? 0,
    });

    console.log('\n================ FINAL VERIFIED LISTINGS ================');
    console.log(JSON.stringify(listings, null, 2));
    console.log('=========================================================\n');

    return { listings, researchReport, verifiedEvidence };
  },
});
