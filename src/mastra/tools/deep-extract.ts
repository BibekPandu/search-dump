import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { tavilyExtract } from '../../services/tavily-extract.service';
import { saveStageOutput } from '../../services/output-storage.service';

export const deepExtractTool = createTool({
  id: 'deep-extract-tool',
  description:
    'Deeply extracts full page content from candidate URLs using Tavily Extract. Returns raw markdown text including contact info, amenities, pricing, and social links. Process up to 5 URLs at once.',
  inputSchema: z.object({
    urls: z
      .array(z.string().url())
      .max(5)
      .describe('Up to 5 candidate URLs to extract full content from'),
  }),
  outputSchema: z.object({
    extractions: z.array(
      z.object({
        url: z.string(),
        content: z.string(),
        favicon: z.string(),
        success: z.boolean(),
        error: z.string().optional(),
      })
    ),
    creditsUsed: z.number(),
  }),
  execute: async ({ urls }) => {
    try {
      console.log(`[DeepExtract] Extracting ${urls.length} URLs`);

      const response = await tavilyExtract(urls);

      console.log(
        `[DeepExtract] Completed: ${response.extractions.filter((e) => e.success).length}/${urls.length} successful`
      );

      saveStageOutput('deep-extract', '2-deep-extractions.json', response.extractions);

      return response;
    } catch (error) {
      console.error('[DeepExtract] Error:', error);
      return {
        extractions: urls.map((url) => ({
          url,
          content: '',
          favicon: '',
          success: false,
          error: (error as Error).message,
        })),
        creditsUsed: 0,
      };
    }
  },
});
