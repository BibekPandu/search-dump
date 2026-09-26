import { getCached, setCache } from './cache.service';

export interface TavilyExtraction {
  url: string;
  content: string;
  favicon: string;
  success: boolean;
  error?: string;
}

export interface TavilyExtractResponse {
  extractions: TavilyExtraction[];
  creditsUsed: number;
}

export interface TavilyExtractOptions {
  extractDepth?: 'basic' | 'advanced';
  retryWithAdvancedOnFailure?: boolean;
}

const CACHE_PROVIDER = 'tavily-extract';

export async function tavilyExtract(
  urls: string[],
  options: TavilyExtractOptions = {}
): Promise<TavilyExtractResponse> {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is missing in .env');
  }

  const validUrls = urls.filter((u) => u && typeof u === 'string' && /^https?:\/\//i.test(u.trim()));
  if (validUrls.length === 0) {
    return { extractions: [], creditsUsed: 0 };
  }

  const { extractDepth = 'basic', retryWithAdvancedOnFailure = true } = options;
  const sliced = validUrls.slice(0, 5);

  const cachedExtractions: TavilyExtraction[] = [];
  const uncachedUrls: string[] = [];

  for (const url of sliced) {
    const cached = getCached<TavilyExtraction>(url, CACHE_PROVIDER);
    if (cached && cached.success && cached.content && cached.content.trim().length > 100) {
      console.log(`[Tavily Extract] Cache hit for ${url}`);
      cachedExtractions.push(cached);
    } else {
      uncachedUrls.push(url);
    }
  }

  if (cachedExtractions.length === sliced.length) {
    console.log(`[Tavily Extract] All ${sliced.length} URLs served from cache (0 credits)`);
    return { extractions: cachedExtractions, creditsUsed: 0 };
  }

  console.log(
    `[Tavily Extract] Extracting ${uncachedUrls.length} uncached URLs (${cachedExtractions.length} from cache) with depth '${extractDepth}'`
  );

    let response: Response;
    try {
      response = await fetch('https://api.tavily.com/extract', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
          api_key: apiKey,
          urls: uncachedUrls,
          include_images: false,
          extract_depth: extractDepth,
        }),
      });
    } catch (fetchErr) {
      console.warn(`[Tavily Extract] Fetch network/timeout error: ${(fetchErr as Error).message}`);
      return {
        extractions: [
          ...cachedExtractions,
          ...uncachedUrls.map((u) => ({
            url: u,
            content: '',
            favicon: '',
            success: false,
            error: (fetchErr as Error).message,
          })),
        ],
        creditsUsed: 0,
      };
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[Tavily Extract] API error response: ${response.status} ${response.statusText} - ${errorText}`);
      return {
        extractions: [
          ...cachedExtractions,
          ...uncachedUrls.map((u) => ({
            url: u,
            content: '',
            favicon: '',
            success: false,
            error: `${response.status} ${response.statusText}`,
          })),
        ],
        creditsUsed: 0,
      };
    }

    const data = (await response.json()) as {
      results?: Array<{ url: string; raw_content: string; images?: string[]; favicon?: string }>;
      failed_results?: Array<{ url: string; error: string }>;
      usage?: { credits: number };
    };

    let totalCreditsUsed = data.usage?.credits || 0;
    const freshMap = new Map<string, TavilyExtraction>();

    for (const result of data.results || []) {
      const extraction: TavilyExtraction = {
        url: result.url,
        content: result.raw_content || '',
        favicon: result.favicon || '',
        success: true,
      };
      freshMap.set(result.url, extraction);
      if (extraction.content.trim().length > 100) {
        setCache(result.url, CACHE_PROVIDER, extraction);
      }
    }

    for (const failed of data.failed_results || []) {
      freshMap.set(failed.url, {
        url: failed.url,
        content: '',
        favicon: '',
        success: false,
        error: failed.error,
      });
    }

    // Automatic retry pass with 'advanced' depth if basic failed or returned sparse SPA shell
    if (retryWithAdvancedOnFailure && extractDepth !== 'advanced') {
      const failedOrSparseUrls = uncachedUrls.filter((u) => {
        const ext = freshMap.get(u);
        return !ext || !ext.success || !ext.content || ext.content.trim().length < 150;
      });

      if (failedOrSparseUrls.length > 0) {
        console.log(
          `[Tavily Extract] Retrying ${failedOrSparseUrls.length} failed/sparse URLs with 'advanced' depth...`
        );
        try {
          const retryResponse = await fetch('https://api.tavily.com/extract', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(30000),
            body: JSON.stringify({
              api_key: apiKey,
              urls: failedOrSparseUrls,
              include_images: false,
              extract_depth: 'advanced',
            }),
          });

          if (retryResponse.ok) {
            const retryData = (await retryResponse.json()) as {
              results?: Array<{ url: string; raw_content: string; images?: string[]; favicon?: string }>;
              failed_results?: Array<{ url: string; error: string }>;
              usage?: { credits: number };
            };

            totalCreditsUsed += retryData.usage?.credits || 0;

          for (const result of retryData.results || []) {
            const extraction: TavilyExtraction = {
              url: result.url,
              content: result.raw_content || '',
              favicon: result.favicon || '',
              success: true,
            };
            freshMap.set(result.url, extraction);
            if (extraction.content.trim().length > 100) {
              setCache(result.url, CACHE_PROVIDER, extraction);
            }
            console.log(
              `[Tavily Extract] Advanced retry succeeded for ${result.url} (${extraction.content.length} chars)`
            );
          }

          for (const failed of retryData.failed_results || []) {
            freshMap.set(failed.url, {
              url: failed.url,
              content: '',
              favicon: '',
              success: false,
              error: failed.error,
            });
          }
        }
      } catch (retryErr) {
        console.warn(`[Tavily Extract] Advanced retry error:`, (retryErr as Error).message);
      }
    }
  }

  const freshExtractions = uncachedUrls.map(
    (u) =>
      freshMap.get(u) || {
        url: u,
        content: '',
        favicon: '',
        success: false,
        error: 'Unknown extraction error',
      }
  );

  const allExtractions = [...cachedExtractions, ...freshExtractions];

  console.log(
    `[Tavily Extract] Extracted ${allExtractions.filter((e) => e.success && e.content.trim().length > 0).length}/${sliced.length} URLs (${totalCreditsUsed} credits, ${cachedExtractions.length} cached)`
  );

  return { extractions: allExtractions, creditsUsed: totalCreditsUsed };
}
