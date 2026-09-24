import { supabase } from '@/lib/supabase';
import { TASK_STATUS_OPTIONS } from '@/types/task';

const db = supabase as any;

export async function resolveTaskStatusLabel(
  status: string | null | undefined,
): Promise<string> {
  if (!status) return '';
  const known = TASK_STATUS_OPTIONS.find((o) => o.value === status);
  if (known) return known.label;

  const [customRes, columnRes] = await Promise.all([
    db.from('task_custom_statuses').select('name').eq('id', status).maybeSingle(),
    db.from('project_columns').select('name').eq('id', status).maybeSingle(),
  ]);

  return (customRes?.data?.name ?? columnRes?.data?.name ?? status) as string;
}
