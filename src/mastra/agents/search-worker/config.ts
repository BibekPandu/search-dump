import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import fs from 'fs';
import path from 'path';
import { createMemoryStorage, getProjectRootDir } from '../../../services/db.service';

// Import tools
import { broadSearchTool } from '../../Tools/broad-search';
import { googleMapsSearchTool } from '../../Tools/google-maps-search';

const instructionsPath = path.join(getProjectRootDir(), 'src/mastra/agents/search-worker/prompt.md');
const instructions = fs.existsSync(instructionsPath)
  ? fs.readFileSync(instructionsPath, 'utf-8')
  : 'You are an expert candidate selection and research classification agent.';

// Persistent LibSQL memory store
const memoryStorage = createMemoryStorage('search-worker-memory');

export const searchWorkerAgent = new Agent({
  id: 'search-worker-agent',
  name: 'Search Worker Agent',
  instructions,
  model: 'google/gemini-3.5-flash-lite',
  tools: {
    broadSearchTool,
    googleMapsSearchTool,
  },
  memory: new Memory({
    storage: memoryStorage,
    options: {
      lastMessages: 10,
      workingMemory: {
        enabled: true,
        scope: 'resource',
        template: `
Research Context:
- Target Topic: {query}
- Target Location: {location}
- Research Goals: {goals}
- Candidate Notes: {notes}
        `.trim(),
      },
    },
  }),
});

export default searchWorkerAgent;
