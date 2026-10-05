import { rpc, serviceClient } from '../supabase.js';
import { PermanentJobError, type JobRow } from '../jobs/types.js';

/** Permanent deletion requested by an item's owner (rows first, objects via GC jobs). */
export async function handleDrivePurge(job: JobRow): Promise<Record<string, unknown>> {
  const itemId = String(job.payload.item_id ?? '');
  if (!itemId) throw new PermanentJobError('Job has no item_id');
  return rpc<Record<string, unknown>>('drive_purge_execute', { p_item_id: itemId });
}

/** Removes a storage object once nothing references it. */
export async function handleGcObject(job: JobRow): Promise<Record<string, unknown>> {
  const bucket = String(job.payload.bucket ?? '');
  const path = String(job.payload.path ?? '');
  if (!bucket || !path) throw new PermanentJobError('Job has no bucket/path');
  const unreferenced = await rpc<boolean>('drive_object_unreferenced', { p_bucket: bucket, p_path: path });
  if (!unreferenced) return { deleted: false, reason: 'still_referenced' };
  const { error } = await serviceClient().storage.from(bucket).remove([path]);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
  return { deleted: true };
}
