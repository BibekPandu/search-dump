/**
 * Raw HTML fetching and extraction service.
 */
export const DEFAULT_CRAWL_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function fetchRawPageHtml(
  url: string,
  timeoutMs = 8000,
  maxRetries = 1
): Promise<string | undefined> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': DEFAULT_CRAWL_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      });
      if (!res.ok) {
        clearTimeout(timer);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
        }
        return undefined;
      }
      const html = await res.text();
      clearTimeout(timer);
      console.log(`[RawHtmlService] Raw HTML fetched for ${url}: ${html.length} bytes`);
      return html;
    } catch {
      clearTimeout(timer);
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      console.warn(`[RawHtmlService] Raw HTML fetch failed for ${url} (0 bytes)`);
      return undefined;
    }
  }
  return undefined;
}
