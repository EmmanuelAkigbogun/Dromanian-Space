// Structured logs without credentials or document content.

type Fields = Record<string, unknown>;

const SECRET_KEY = /(token|secret|key|authorization|password|cookie)/i;

function clean(fields: Fields | undefined): Fields | undefined {
  if (!fields) return undefined;
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k)) continue;
    if (v instanceof Error) out[k] = { name: v.name, message: v.message.slice(0, 500) };
    else if (typeof v === 'string') out[k] = v.slice(0, 500);
    else out[k] = v;
  }
  return out;
}

function write(level: 'info' | 'warn' | 'error', message: string, fields?: Fields) {
  const line = JSON.stringify({ level, message, time: new Date().toISOString(), ...clean(fields) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields?: Fields) => write('info', message, fields),
  warn: (message: string, fields?: Fields) => write('warn', message, fields),
  error: (message: string, fields?: Fields) => write('error', message, fields),
};
