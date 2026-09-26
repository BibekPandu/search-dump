import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { searchWithFallback, searchResponseSchema } from '../../services/search-fallback.service';
import { saveStageOutput } from '../../services/output-storage.service';

export const broadSearchTool = createTool({
  id: 'broad-search-tool',
  description:
    'Performs a broad web search to discover candidate businesses or places. Uses Serper.dev (Google) as primary, with DuckDuckGo as fallback. Returns deduplicated, ranked results with provider provenance, search metadata, and dense page-offset ranks (e.g. Page 2 ranks 11-20).',
  inputSchema: z.object({
    query: z.string().describe('The topic, business type, or search query'),
    location: z.string().optional().describe('Optional city or location constraint (e.g. "Kathmandu")'),
    page: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .default(1)
      .describe('Search result page number (1 = results 1-10, 2 = results 11-20, 3 = results 21-30)'),
  }),
  outputSchema: searchResponseSchema,
  execute: async ({ query, location, page }) => {
    const pageNum = page ?? 1;
    try {
      console.log(
        `[BroadSearch] Starting search: "${query}" ${location ? `in ${location}` : ''} (page ${pageNum})`
      );

      const response = await searchWithFallback(query, location, 10, pageNum);

      console.log(
        `[BroadSearch] Completed: ${response.resultsCount} results via ${response.searchMetadata.actualProvider}`
      );

      saveStageOutput('broad-search', '1-broad-search.json', response, query);

      return response;
    } catch (error) {
      console.error('[BroadSearch] Error:', error);
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        query,
        location,
        queryUsed: location && !query.toLowerCase().includes(location.toLowerCase()) ? `${query} ${location}` : query,
        page: pageNum,
        resultsCount: 0,
        pagination: {
          currentPage: pageNum,
          hasNextPage: false,
          nextPage: null,
        },
        searchMetadata: {
          requestedProvider: 'serper',
          actualProvider: 'error',
          fallbackUsed: false,
          fallbackReason: errMsg,
          attemptedProviders: [],
          latencyMs: 0,
          providerLatencyMs: {},
          duplicatesRemoved: 0,
          errorClassifications: { tool: 'error' },
          searchedAt: new Date().toISOString(),
        },
        results: [],
      };
    }
  },
});
