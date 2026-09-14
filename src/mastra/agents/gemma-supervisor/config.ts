import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import fs from 'fs';
import path from 'path';
import { createMemoryStorage, getProjectRootDir } from '../../../services/db.service';
import { getGemmaModel, FREE_MODELS } from '../../../services/openrouter.service';
import { broadSearchTool } from '../../Tools/broad-search';
import { deepExtractTool } from '../../Tools/deep-extract';
import { googleMapsSearchTool } from '../../Tools/google-maps-search';

const instructionsPath = path.join(getProjectRootDir(), 'src/mastra/agents/gemma-supervisor/prompt.md');
const instructions = fs.existsSync(instructionsPath)
  ? fs.readFileSync(instructionsPath, 'utf-8')
  : 'You are an expert data research supervisor powered by Google Gemma.';

// Persistent LibSQL memory store for supervisor
const memoryStorage = createMemoryStorage('gemma-supervisor-memory');

export const gemmaSupervisorAgent = new Agent({
  id: 'gemma-supervisor-agent',
  name: 'Gemma Supervisor Agent',
  instructions,
  model: getGemmaModel(FREE_MODELS.GEMMA_26B_A4B_FREE),
  tools: {
    broadSearchTool,
    deepExtractTool,
    googleMapsSearchTool,
  },
  memory: new Memory({
    storage: memoryStorage,
    options: {
      lastMessages: 10,
    },
  }),
});

export default gemmaSupervisorAgent;
