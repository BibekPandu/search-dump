import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import fs from 'fs';
import path from 'path';
import { createMemoryStorage, getProjectRootDir } from '../../../services/db.service';
import { getUnoModel, UNO_FREE_MODELS } from '../../../services/unorouter.service';
import { broadSearchTool } from '../../Tools/broad-search';
import { deepExtractTool } from '../../Tools/deep-extract';
import { googleMapsSearchTool } from '../../Tools/google-maps-search';

const instructionsPath = path.join(getProjectRootDir(), 'src/mastra/agents/gemma-supervisor/prompt.md');
const instructions = fs.existsSync(instructionsPath)
  ? fs.readFileSync(instructionsPath, 'utf-8')
  : 'You are an expert data research supervisor powered by UnoRouter.';

const memoryStorage = createMemoryStorage('uno-supervisor-memory');

export const unoSupervisorAgent = new Agent({
  id: 'uno-supervisor-agent',
  name: 'UnoRouter Supervisor Agent',
  instructions,
  model: getUnoModel(UNO_FREE_MODELS.GEMINI_3_5_FLASH),
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

export default unoSupervisorAgent;
