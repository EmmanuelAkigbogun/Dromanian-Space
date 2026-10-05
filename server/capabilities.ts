import { serviceClient } from './supabase.js';

let crmCache: { value: boolean; at: number } | null = null;

/** True once the CRM migration has been applied to this database. */
export async function crmInstalled(): Promise<boolean> {
  if (crmCache && Date.now() - crmCache.at < 60_000) return crmCache.value;
  const { error } = await serviceClient().from('crm_companies').select('id', { head: true, count: 'exact' }).limit(1);
  const value = !error;
  crmCache = { value, at: Date.now() };
  return value;
}
