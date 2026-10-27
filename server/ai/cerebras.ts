import { env } from '../env.js';
import { ProviderError, type ModelProvider } from './provider.js';

/**
 * Cerebras model execution is hosted by the isolated Agno service through
 * Agno's native Cerebras adapter. The Node registry still owns availability and
 * model routing so readiness, budgets and setup errors remain provider-aware.
 */
export const cerebrasProvider: ModelProvider = {
  name: 'cerebras',
  configured: () => Boolean(env().cerebrasApiKey),
  startSession: () => {
    throw new ProviderError('unavailable', 'Cerebras sessions run through the Agno runtime.');
  },
};
