export interface RunSummaryData {
  query: string;
  location?: string;
  timestamp?: string;
  totalBusinesses: number;
  requestedTarget?: number;
  discovered?: number;
  accepted?: number;
  finalized?: number;
  persisted?: number;
  shortfall?: number;
  reasonCounts?: Record<string, number>;
  conflictsDetected?: number;
  executionTimeMs?: number;
  sources?: {
    googleMaps?: number;
    webSearch?: number;
    officialWebsitesCrawled?: number;
  };
  contactsFound?: {
    withPhone?: number;
    withEmail?: number;
    withWebsite?: number;
    withSocialLinks?: number;
  };
  status?: 'success' | 'partial' | 'failed' | 'empty';
  synthesisMethod?: string;
  /**
   * M1 cache diagnostic — deliberately never conflated:
   *   'hit'                → snapshot served from `runs`, zero API calls
   *   'miss'               → lookup ran, nothing fresh was stored
   *   'skipped_mongo_down' → lookup could not run (no URI / unreachable server)
   */
  cacheLookupStatus?: 'hit' | 'miss' | 'skipped_mongo_down';
  telemetry?: Record<string, unknown>;
  notes?: string[];
}
