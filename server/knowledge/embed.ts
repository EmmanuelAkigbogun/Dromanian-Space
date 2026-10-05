// Optional embeddings (Voyage AI). Without VOYAGE_API_KEY, retrieval uses
// Postgres full-text search only and sources record embedding_status
// 'not_configured'; nothing pretends vectors exist.

import { env } from '../env.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const BATCH = 64;

export function embeddingsConfigured(): boolean {
  return Boolean(env().voyageApiKey);
}

export interface EmbeddingResult {
  model: string;
  dimensions: number;
  vectors: number[][];
}

export async function embedTexts(texts: string[], inputType: 'document' | 'query', signal?: AbortSignal): Promise<EmbeddingResult> {
  const { voyageApiKey, embeddingModel } = env();
  if (!voyageApiKey) throw new Error('Embeddings are not configured');
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, 8000));
    const response = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${voyageApiKey}` },
      body: JSON.stringify({ input: batch, model: embeddingModel, input_type: inputType }),
      signal: signal ?? AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed with status ${response.status}`);
    }
    const body = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> };
    const ordered = [...body.data].sort((a, b) => a.index - b.index);
    for (const d of ordered) vectors.push(d.embedding);
  }
  const dimensions = vectors[0]?.length ?? 0;
  return { model: embeddingModel, dimensions, vectors };
}

export function toPgVector(v: number[]): string {
  return `[${v.join(',')}]`;
}
