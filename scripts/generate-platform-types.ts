// Generate the additive platform contract from the isolated migrated database.
// No credentials or row data are read. Run: node --import tsx scripts/generate-platform-types.ts
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { DATABASE_URL } from '../tools/local-supabase/lib.ts';

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
try {
  const { rows: columns } = await db.query<{ table_name: string; column_name: string; udt_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT table_name,column_name,udt_name,is_nullable,column_default FROM information_schema.columns
     WHERE table_schema='public' ORDER BY table_name,ordinal_position`);
  const tables = [...new Set(columns.map(c => c.table_name))];
  const type = (t: string): string => {
    if (t.startsWith('_')) return `(${type(t.slice(1))})[]`;
    if (tables.includes(t)) return `PlatformDatabase['public']['Tables']['${t}']['Row']`;
    if (['int2','int4','int8','numeric','float4','float8','oid'].includes(t)) return 'number';
    if (t === 'bool') return 'boolean';
    if (['json','jsonb'].includes(t)) return 'Json';
    if (t === 'void') return 'undefined';
    if (t === 'record') return 'Json';
    return 'string';
  };
  let out = '// Generated from PostgreSQL by scripts/generate-platform-types.ts. Do not edit.\n';
  out += 'export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];\n';
  out += 'export interface PlatformDatabase { public: { Tables: {\n';
  for (const table of tables) {
    const cols = columns.filter(c => c.table_name === table);
    const fields = (insert: boolean) => cols.map(c => `${JSON.stringify(c.column_name)}${insert && (c.is_nullable === 'YES' || c.column_default !== null) ? '?' : ''}: ${type(c.udt_name)}${c.is_nullable === 'YES' ? ' | null' : ''}`).join('; ');
    out += `${JSON.stringify(table)}: { Row: { ${fields(false)} }; Insert: { ${fields(true)} }; Update: Partial<PlatformDatabase['public']['Tables'][${JSON.stringify(table)}]['Insert']>; Relationships: [] };\n`;
  }
  out += '}; Views: Record<never, never>; Functions: {\n';
  const { rows: functions } = await db.query<{ name: string; names: string[] | null; types: string[]; modes: string[] | null; defaults: number; result: string; setof: boolean }>(
    `SELECT p.proname AS name, p.proargnames AS names, p.proargmodes::text[] AS modes, p.pronargdefaults AS defaults,
       ARRAY(SELECT t.typname::text FROM unnest(coalesce(p.proallargtypes,p.proargtypes::oid[])) WITH ORDINALITY a(id,n)
         JOIN pg_type t ON t.oid=a.id ORDER BY a.n) AS types, t.typname AS result, p.proretset AS setof
     FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace JOIN pg_type t ON t.oid=p.prorettype
     WHERE ns.nspname='public' AND p.prokind='f' AND p.proname !~ '^(gin_|gtrgm|similarity|word_similarity|strict_word|show_|set_limit)' ORDER BY p.proname,p.oid`);
  for (const name of [...new Set(functions.map(f => f.name))]) {
    const contracts = functions.filter(f => f.name === name).filter(f => !f.types.length || f.names).map(f => {
      const args = f.types.map((t,i) => ({ type: t, name: f.names?.[i], mode: f.modes?.[i] ?? 'i' }));
      const input = args.filter(a => ['i','b','v'].includes(a.mode));
      const output = args.filter(a => ['o','b','t'].includes(a.mode));
      const ret = output.length ? `{ ${output.map(a => `${JSON.stringify(a.name)}: ${type(a.type)}`).join('; ')} }` : type(f.result);
      return `{ Args: ${input.length ? `{ ${input.map((a,i) => `${JSON.stringify(a.name)}${i >= input.length-f.defaults ? '?' : ''}: ${type(a.type)} | null`).join('; ')} }` : 'Record<never, never>'}; Returns: ${ret}${f.setof ? '[]' : ''} }`;
    });
    if (contracts.length) out += `${JSON.stringify(name)}: ${contracts.join(' | ')};\n`;
  }
  out += '}; Enums: Record<never, never>; CompositeTypes: Record<never, never> } }\n';
  writeFileSync('src/types/platform-database.ts',out);
  console.log(`Generated ${tables.length} table contracts and ${functions.length} function contracts.`);
} finally { await db.end(); }
