// Chooses the provider adapter for a model. Agents store a model id per
// version; the provider follows from the id, so each specialist in a team run
// can use a different provider.

import { env, type ProviderName } from '../env.js';
import { anthropicProvider } from './anthropic.js';
import { openaiProvider } from './openai.js';
import { geminiProvider } from './gemini.js';
import { cerebrasProvider } from './cerebras.js';
import type { ModelProvider } from './provider.js';

const PROVIDERS: Record<ProviderName, ModelProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  cerebras: cerebrasProvider,
};

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  cerebras: 'Cerebras Cloud',
};

/** Server variable that enables each provider (for setup messages). */
export const PROVIDER_KEYS: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
};

export function providerNameFor(model: string): ProviderName | null {
  if (model === 'gpt-oss-120b' || /^cerebras\//.test(model)) return 'cerebras';
  if (/^claude-/.test(model)) return 'anthropic';
  if (/^(gpt-|o\d|chatgpt-)/.test(model)) return 'openai';
  if (/^gemini-/.test(model)) return 'gemini';
  return null;
}

export function providerFor(model: string): ModelProvider | null {
  const name = providerNameFor(model);
  return name ? PROVIDERS[name] : null;
}

export function providerStates(): Array<{ name: ProviderName; label: string; configured: boolean; default_model: string }> {
  const e = env();
  return (Object.keys(PROVIDERS) as ProviderName[]).map((name) => ({
    name,
    label: PROVIDER_LABELS[name],
    configured: PROVIDERS[name].configured(),
    default_model: e.defaultModels[name],
  }));
}

export function anyProviderConfigured(): boolean {
  return Object.values(PROVIDERS).some((p) => p.configured());
}

/**
 * The model new workspaces start with: the configured default provider's
 * model, or the other provider's when only that one has a key.
 */
export function platformDefaultModel(): string {
  const e = env();
  const preferred = e.defaultProvider;
  if (PROVIDERS[preferred].configured()) return e.defaultModels[preferred];
  const other = (Object.keys(PROVIDERS) as ProviderName[]).find((n) => PROVIDERS[n].configured());
  return other ? e.defaultModels[other] : e.defaultModels[preferred];
}
