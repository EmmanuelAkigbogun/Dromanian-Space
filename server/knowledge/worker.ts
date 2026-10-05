import { rpc, serviceClient } from '../supabase.js';
import { log } from '../log.js';
import { chunkUnits } from './chunk.js';
import { detectKind, extractDocument, extractFile, MAX_EXTRACT_BYTES, type Extraction } from './extract.js';
import { embeddingsConfigured, embedTexts, toPgVector } from './embed.js';
import { PermanentJobError, type JobContext, type JobRow } from '../jobs/types.js';

type BeginInfo =
  | {
      kind: 'file';
      source_id: string;
      workspace_id: string;
      item_id: string;
      bucket: string;
      path: string;
      mime_type: string | null;
      name: string | null;
      size_bytes: number;
    }
  | { kind: 'document'; source_id: string; workspace_id: string; item_id: string; title: string; body: string; revision_no: number };

async function markFailed(sourceId: string, status: string, code: string, message: string) {
  await rpc('knowledge_mark_failed', { p_source_id: sourceId, p_status: status, p_error_code: code, p_message: message });
}

async function download(bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await serviceClient().storage.from(bucket).download(path);
  if (error || !data) {
    const status = (error as { status?: number; statusCode?: string } | null)?.status;
    if (status === 404 || /not.?found/i.test(error?.message ?? '')) {
      throw new PermanentJobError('missing_object');
    }
    throw new Error(`Download failed: ${error?.message ?? 'no data'}`);
  }
  return new Uint8Array(await data.arrayBuffer());
}

async function extract(info: BeginInfo): Promise<Extraction> {
  if (info.kind === 'document') return extractDocument(info.title, info.body);
  const kind = detectKind(info.mime_type, info.name);
  if (!kind) {
    return {
      status: 'unsupported',
      code: 'unsupported_type',
      message: 'This file type is not indexed. Supported: PDF with a text layer, DOCX, TXT, Markdown and CSV.',
    };
  }
  if (info.size_bytes > MAX_EXTRACT_BYTES) {
    return { status: 'too_large', code: 'too_large', message: 'This file is larger than 50 MB and is not indexed.' };
  }
  return extractFile(await download(info.bucket, info.path), kind);
}

/** Job handler: extract text, store chunks, then (optionally) embeddings. */
export async function handleKnowledgeExtract(job: JobRow, ctx: JobContext): Promise<Record<string, unknown>> {
  const sourceId = String(job.payload.source_id ?? '');
  if (!sourceId) throw new PermanentJobError('Job has no source_id');
  const info = await rpc<BeginInfo | null>('knowledge_begin_extraction', { p_source_id: sourceId });
  if (!info) return { skipped: 'superseded_or_deleted' };

  let result: Extraction;
  try {
    result = await extract(info);
  } catch (err) {
    if (err instanceof PermanentJobError && err.message === 'missing_object') {
      await markFailed(sourceId, 'failed', 'missing_object', 'The stored file could not be found.');
      return { status: 'failed', code: 'missing_object' };
    }
    if (ctx.isLastAttempt) {
      await markFailed(sourceId, 'failed', 'extraction_error', 'Text extraction failed after several attempts. Try re-indexing.');
    }
    throw err;
  }

  if (result.status !== 'ok') {
    await markFailed(sourceId, result.status, result.code, result.message);
    return { status: result.status, code: result.code };
  }

  const { chunks, truncated: chunkTruncated } = chunkUnits(result.units);
  const withEmbeddings = embeddingsConfigured() && chunks.length > 0;
  const stored = await rpc<string>('knowledge_store_chunks', {
    p_source_id: sourceId,
    p_chunks: chunks.map((c) => ({ index: c.index, content: c.content, location: c.location, tokens: c.tokens })),
    p_meta: {
      status: 'ready',
      char_count: result.charCount,
      page_count: result.pageCount ?? null,
      row_count: result.rowCount ?? null,
      truncated: result.truncated || chunkTruncated,
      extractor: result.extractor,
      embedding_status: withEmbeddings ? 'pending' : 'not_configured',
    },
  });
  if (stored !== 'stored') return { status: stored };

  let embedded = 0;
  if (withEmbeddings) {
    try {
      const { data: rows, error } = await serviceClient()
        .from('knowledge_chunks')
        .select('id, chunk_index, content')
        .eq('source_id', sourceId)
        .order('chunk_index');
      if (error || !rows) throw new Error(error?.message ?? 'Could not load chunks');
      const vectors = await embedTexts(rows.map((r) => r.content as string), 'document', ctx.signal);
      embedded = await rpc<number>('knowledge_store_embeddings', {
        p_source_id: sourceId,
        p_model: vectors.model,
        p_dimensions: vectors.dimensions,
        p_items: rows.map((r, i) => ({ chunk_id: r.id, embedding: toPgVector(vectors.vectors[i]) })),
      });
    } catch (err) {
      // Keyword retrieval keeps working; the source records the failure.
      log.warn('embedding failed', { source_id: sourceId, error: err instanceof Error ? err : String(err) });
      await rpc('knowledge_mark_embedding_failed', { p_source_id: sourceId });
    }
  }
  return { status: 'ready', chunks: chunks.length, embedded, truncated: result.truncated || chunkTruncated };
}
