import 'dotenv/config';

//  Permanently silence Mastra Studio feedback polling noise across both stderr and console
const origStderrWrite = process.stderr.write.bind(process.stderr);
(process.stderr.write as any) = (chunk: any, ...args: any[]): boolean => {
  const str = typeof chunk === 'string' ? chunk : chunk?.toString?.() || '';
  if (str.includes('does not support listing feedback') || str.includes('/observability/feedback')) {
    return true; // silently drop the noise
  }
  return (origStderrWrite as any)(chunk, ...args);
};

const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  const message = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0] || '');
  if (message.includes('does not support listing feedback') || message.includes('/observability/feedback')) {
    return;
  }
  originalConsoleError(...args);
};

import { Mastra } from '@mastra/core';
import { createMemoryStorage } from '../services/db.service';
import { searchWorkerAgent } from './agents/search-worker/config';
import { gemmaSupervisorAgent } from './agents/gemma-supervisor/config';
import { unoSupervisorAgent } from './agents/uno-supervisor/config';
import { researchWorkflow } from './workflows/research-workflow';

const storage = createMemoryStorage('mastra-storage');

export const mastra = new Mastra({
  storage,
  agents: {
    searchWorkerAgent,
    gemmaSupervisorAgent,
    unoSupervisorAgent,
  },
  workflows: {
    researchWorkflow,
  },
});