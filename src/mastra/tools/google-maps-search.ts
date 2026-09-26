import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { searchSerperPlaces } from '../../services/serper-places.service';

export const googleMapsPlaceSchema = z.object({
  position: z.number(),
  title: z.string(),
  address: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  rating: z.number().optional(),
  ratingCount: z.number().optional(),
  category: z.string().optional(),
  type: z.string().optional(),
  phoneNumber: z.string().optional(),
  website: z.string().optional(),
  cid: z.string().optional(),
  placeId: z.string().optional(),
});

export const googleMapsSearchTool = createTool({
  id: 'google-maps-search-tool',
  description:
    'Search Google Maps Places via Serper.dev to find verified local businesses with address, direct phone numbers, ratings, GPS coordinates, and website URLs if available.',
  inputSchema: z.object({
    query: z.string().describe('The business type or name to find (e.g. "plumbers", "hotels")'),
    location: z.string().optional().describe('Optional city or region constraint (e.g. "Kathmandu")'),
  }),
  outputSchema: z.object({
    query: z.string(),
    location: z.string().optional(),
    placesCount: z.number(),
    places: z.array(googleMapsPlaceSchema),
  }),
  execute: async ({ query, location }) => {
    try {
      console.log(`[GoogleMapsTool] Searching places: "${query}" ${location ? `in ${location}` : ''}`);
      const places = await searchSerperPlaces(query, { location });
      return {
        query,
        location,
        placesCount: places.length,
        places,
      };
    } catch (error) {
      console.error('[GoogleMapsTool] Error:', error);
      return {
        query,
        location,
        placesCount: 0,
        places: [],
      };
    }
  },
});
