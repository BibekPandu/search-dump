import { z } from 'zod';
import { searchSerper, type SerperResult } from './serper-search.service';
import { getCached, setCache } from './cache.service';
import { search } from 'duck-duck-scrape';

// ============================================================================
// Single Source of Truth Zod Schemas & Inferred Types
// ============================================================================

export const unifiedSearchResultSchema = z.object({
  /** 1-based position in the final deduplicated list. Dense & page-offset (e.g. Page 2 = 11-20 for numResults=10). */
  rank: z.number().default(0),
  title: z.string(),
  /** Normalized URL (tracking params stripped, www. stripped, hash stripped, params sorted). Dedupe key + downstream URL. */
  url: z.string(),
  /** Raw URL exactly as returned by upstream provider. Internal evidence/debugging only — never render to LLM prompts. */
  originalUrl: z.string().default(''),
  /** Hostname lowercased with leading "www." stripped (e.g. "himalayanjava.com"). Empty string if unparseable. */
  domain: z.string().default(''),
  description: z.string(),
  extraSnippets: z.array(z.string()),
  /** Upstream provider that produced this result: 'serper' | 'duckduckgo' | 'serper_places'. */
  provider: z.string(),
  /** Optional Google Maps location metadata */
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  phoneNumber: z.string().optional(),
  address: z.string().optional(),
  rating: z.number().optional(),
  ratingCount: z.number().optional(),
  placeId: z.string().optional(),
  source: z.string().optional(),
  businessType: z.string().optional(),
});

export const searchMetadataSchema = z.object({
  /** Head of the fallback chain. Always 'serper' today. */
  requestedProvider: z.string(),
  /** Provider whose results were returned; 'none' if all failed; 'error' on catastrophic exception. */
  actualProvider: z.string(),
  /** True when primary provider did not produce the final results. */
  fallbackUsed: z.boolean(),
  /** Why fallback occurred. null when primary succeeded. */
  fallbackReason: z.string().nullable(),
  /** Every provider attempted in order, including failed or zero-result attempts. */
  attemptedProviders: z.array(z.string()),
  /** Wall-clock ms for the whole searchWithFallback call. */
  latencyMs: z.number(),
  /** Wall-clock ms per provider attempt, failures included. Captured at the provider call site. */
  providerLatencyMs: z.record(z.string(), z.number()),
  /** Raw results dropped by URL deduplication. */
  duplicatesRemoved: z.number(),
  /** provider -> 'config' | 'timeout' | 'http_4xx' | 'http_5xx' | 'network' | 'parse' | 'pagination_unsupported' | 'unknown'. */
  errorClassifications: z.record(z.string(), z.string()),
  /** ISO timestamp when the search was executed. */
  searchedAt: z.string(),
});

export const searchResponseSchema = z.object({
  /** Base query passed by caller. */
  query: z.string(),
  /** Optional location constraint passed by caller. */
  location: z.string().optional(),
  /** The exact query string executed (location appended when missing). */
  queryUsed: z.string(),
  /** Requested page number (1-based). */
  page: z.number(),
  /** Equal to results.length; kept top-level for easy access. */
  resultsCount: z.number(),
  /** Pagination metadata. hasNextPage is provider-confirmed where supported, otherwise a bounded heuristic. */
  pagination: z.object({
    currentPage: z.number(),
    hasNextPage: z.boolean(),
    nextPage: z.number().nullable(),
  }),
  searchMetadata: searchMetadataSchema,
  results: z.array(unifiedSearchResultSchema),
});

export type UnifiedSearchResult = z.infer<typeof unifiedSearchResultSchema>;
export type SearchMetadata = z.infer<typeof searchMetadataSchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;

// Cache provider bumped to v2 — invalidates all legacy array-based cache entries
const CACHE_PROVIDER = 'broad-search-v2';

// Tracking parameter blocklist for URL normalization
const TRACKING_PARAM_NAMES = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'ref', 'ref_src', 'ref_url',
  'mc_cid', 'mc_eid', 'igshid', 'si', 'yclid', 'vero_id', '_ga',
]);

// ============================================================================
// Utility & Normalization Functions
// ============================================================================

export function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed; // Return unparseable string as-is without throwing mid-pipeline
  }

  if (parsed.hostname.startsWith('www.')) {
    parsed.hostname = parsed.hostname.slice(4);
  }

  // Strip trailing slash on subpaths while preserving root /
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  for (const key of [...parsed.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith('utm_') || TRACKING_PARAM_NAMES.has(k)) {
      parsed.searchParams.delete(key);
    }
  }

  // Sort remaining search parameters deterministically
  const sorted = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  parsed.search = '';
  for (const [k, v] of sorted) {
    parsed.searchParams.append(k, v);
  }

  // Strip hash fragments
  parsed.hash = '';

  return parsed.toString();
}

export function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl.trim()).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function deduplicateResults(
  results: UnifiedSearchResult[],
  rankOffset: number = 0
): UnifiedSearchResult[] {
  const seen = new Map<string, UnifiedSearchResult>();
  for (const r of results) {
    const key = normalizeUrl(r.url);
    if (!seen.has(key)) {
      seen.set(key, {
        ...r,
        url: key,
        originalUrl: r.originalUrl || r.url,
        domain: r.domain || extractDomain(key),
      });
    }
  }
  return [...seen.values()].map((r, i) => ({
    ...r,
    rank: rankOffset + i + 1,
  }));
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export function classifyProviderError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes('timed out') || lower.includes('timeout')) return 'timeout';
  if (lower.includes('missing in .env') || lower.includes('api_key') || lower.includes('unauthorized') || lower.includes('401') || lower.includes('403')) return 'config';
  if (lower.includes('4') && lower.includes('error')) return 'http_4xx';
  if (lower.includes('5') && lower.includes('error')) return 'http_5xx';
  if (lower.includes('fetch failed') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network')) return 'network';
  if (lower.includes('json') || lower.includes('syntaxerror')) return 'parse';
  return 'unknown';
}

export function isSearchResponseLike(data: unknown): data is SearchResponse {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    Array.isArray(obj.results) &&
    typeof obj.resultsCount === 'number' &&
    typeof obj.queryUsed === 'string' &&
    typeof obj.pagination === 'object' &&
    typeof obj.searchMetadata === 'object'
  );
}

// ============================================================================
// Main Search Orchestrator with Native Pagination & Fallbacks
// ============================================================================

export async function searchWithFallback(
  query: string,
  location?: string,
  numResults: number = 10,
  page: number = 1,
  country: string = 'np'
): Promise<SearchResponse> {
  const startTime = Date.now();
  const hasLocationInQuery = location && query.toLowerCase().includes(location.toLowerCase());
  const cleanQuery = location && !hasLocationInQuery ? `${query} ${location}` : query;
  const queryUsed = cleanQuery;

  // Collision-safe cache key incorporating all result-affecting parameters
  const cacheKey = `${cleanQuery}::n${numResults}::p${page}::c${country}`;

  const cached = getCached<unknown>(cacheKey, CACHE_PROVIDER);
  if (cached && isSearchResponseLike(cached)) {
    console.log(`[Cache] Hit for "${cacheKey}" — returning ${cached.resultsCount} cached results via ${cached.searchMetadata.actualProvider}`);
    return cached;
  }

  const attemptedProviders: string[] = [];
  const providerLatencyMs: Record<string, number> = {};
  const errorClassifications: Record<string, string> = {};
  let fallbackReason: string | null = null;
  let rawResults: UnifiedSearchResult[] = [];
  let actualProvider = 'none';

  // 1. Try Serper (Google Search with native page parameter)
  attemptedProviders.push('serper');
  const tSerperStart = Date.now();
  try {
    const res = await withTimeout(
      trySerper(cleanQuery, numResults, page, country),
      10000,
      'Serper'
    );
    providerLatencyMs['serper'] = Date.now() - tSerperStart;
    if (res.length > 0) {
      rawResults = res;
      actualProvider = 'serper';
    } else {
      fallbackReason = 'serper: returned 0 results';
    }
  } catch (err) {
    providerLatencyMs['serper'] = Date.now() - tSerperStart;
    const reason = (err as Error).message;
    errorClassifications['serper'] = classifyProviderError(err);
    fallbackReason = `serper: ${reason}`;
    console.warn(`[Fallback] Serper failed: ${reason}`);
  }

  // 2. Try DuckDuckGo (native offset pagination)
  if (rawResults.length === 0) {
    attemptedProviders.push('duckduckgo');
    const tDdgStart = Date.now();
    try {
      const res = await withTimeout(
        tryDuckDuckGo(cleanQuery, numResults, page),
        12000,
        'DuckDuckGo'
      );
      providerLatencyMs['duckduckgo'] = Date.now() - tDdgStart;
      if (res.length > 0) {
        rawResults = res;
        actualProvider = 'duckduckgo';
      } else {
        const ddgMsg = 'duckduckgo: returned 0 results';
        fallbackReason = fallbackReason ? `${fallbackReason} | ${ddgMsg}` : ddgMsg;
      }
    } catch (err) {
      providerLatencyMs['duckduckgo'] = Date.now() - tDdgStart;
      const reason = (err as Error).message;
      errorClassifications['duckduckgo'] = classifyProviderError(err);
      const ddgMsg = `duckduckgo: ${reason}`;
      fallbackReason = fallbackReason ? `${fallbackReason} | ${ddgMsg}` : ddgMsg;
      console.warn(`[Fallback] DuckDuckGo failed: ${reason}`);
    }
  }

  if (actualProvider === 'none') {
    console.error(`[Fallback] All providers failed for "${cleanQuery}" (page ${page})`);
  }

  // Deduplication & dense page-offset ranking: page 1 -> 1..10, page 2 -> 11..20
  const rankOffset = (page - 1) * numResults;
  const dedupedResults = deduplicateResults(rawResults, rankOffset);
  const duplicatesRemoved = rawResults.length - dedupedResults.length;
  const fallbackUsed = actualProvider !== 'serper' && actualProvider !== 'none';
  const totalLatency = Date.now() - startTime;

  // hasNextPage: bounded heuristic based on whether a full page was returned
  const hasNextPage = dedupedResults.length >= numResults;

  const response: SearchResponse = {
    query,
    location,
    queryUsed,
    page,
    resultsCount: dedupedResults.length,
    pagination: {
      currentPage: page,
      hasNextPage,
      nextPage: hasNextPage ? page + 1 : null,
    },
    searchMetadata: {
      requestedProvider: 'serper',
      actualProvider,
      fallbackUsed,
      fallbackReason: fallbackUsed || actualProvider === 'none' ? fallbackReason : null,
      attemptedProviders,
      latencyMs: totalLatency,
      providerLatencyMs,
      duplicatesRemoved,
      errorClassifications,
      searchedAt: new Date().toISOString(),
    },
    results: dedupedResults,
  };

  // Cache only non-empty successful results (never cache failed/empty outages for 7 days)
  if (dedupedResults.length > 0) {
    setCache(cacheKey, CACHE_PROVIDER, response);
  }

  return response;
}

// ============================================================================
// Provider Client Wrappers
// ============================================================================

async function trySerper(
  query: string,
  numResults: number,
  page: number = 1,
  country: string = 'np'
): Promise<UnifiedSearchResult[]> {
  const response = await searchSerper(query, { numResults, page, country });
  return (response.results || []).map((r: SerperResult) => ({
    rank: 0, // Assigned densely during deduplicateResults
    title: r.title,
    url: r.url,
    originalUrl: r.url,
    domain: extractDomain(r.url),
    description: r.snippet,
    extraSnippets: [],
    provider: 'serper',
  }));
}

async function tryDuckDuckGo(
  query: string,
  numResults: number,
  page: number = 1
): Promise<UnifiedSearchResult[]> {
  const offset = Math.max(0, (page - 1) * numResults);
  const ddgResults = await search(query, {
    safeSearch: 0,
    offset,
  });

  return (ddgResults.results || []).slice(0, numResults).map(
    (r: { title: string; url: string; description: string }) => ({
      rank: 0,
      title: r.title,
      url: r.url,
      originalUrl: r.url,
      domain: extractDomain(r.url),
      description: r.description,
      extraSnippets: [],
      provider: 'duckduckgo',
    })
  );
}
