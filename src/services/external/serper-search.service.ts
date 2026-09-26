export interface SerperResult {
  title: string;
  url: string;
  snippet: string;
  position: number;
  sitelinks?: Array<{ title: string; link: string }>;
  attributes?: Record<string, string>;
}

export interface SerperSearchResponse {
  results: SerperResult[];
  knowledgeGraph?: {
    title: string;
    type?: string;
    website?: string;
    imageUrl?: string;
    description?: string;
    attributes?: Record<string, string>;
  };
  answerBox?: {
    snippet?: string;
    title?: string;
    link?: string;
  };
}

export async function searchSerper(
  query: string,
  options: { numResults?: number; country?: string; language?: string; page?: number } = {}
): Promise<SerperSearchResponse> {
  const { numResults = 10, country = 'np', language = 'en', page = 1 } = options;
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    throw new Error('SERPER_API_KEY is missing in .env');
  }

  console.log(`[Serper] Searching Google for: "${query}" (page ${page}, ${numResults} results)`);

  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: query,
      num: numResults,
      page,
      gl: country,
      hl: language,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Serper API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();

  const results: SerperResult[] = (data.organic || []).map(
    (item: { title: string; link: string; snippet: string; position: number; sitelinks?: Array<{ title: string; link: string }>; attributes?: Record<string, string> }) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet || '',
      position: item.position,
      sitelinks: item.sitelinks,
      attributes: item.attributes,
    })
  );

  console.log(`[Serper] Returned ${results.length} Google results`);

  return {
    results,
    knowledgeGraph: data.knowledgeGraph,
    answerBox: data.answerBox,
  };
}
