import { parseCsv } from './csv';
import {
  normalizeTaskRow,
  toOptionalString,
  type ParsedTaskRow,
  type RawTaskRow,
} from './tasks';
import {
  isAutomationsExportDocument,
  isAutomationItem,
  type AutomationExportItem,
} from './automations';

export interface ParsedProject {
  source_id?: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  due_date?: string;
  tasks: ParsedTaskRow[];
}

export interface ParsedImport {
  automations: AutomationExportItem[];
  projects: ParsedProject[];
  tasks: ParsedTaskRow[];
  warnings: string[];
}

export async function parseImportContent(text: string): Promise<ParsedImport> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('The file is empty.');

  const warnings: string[] = [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new Error('Invalid JSON. Check the file and try again.');
    }
    return parseJsonImport(data, warnings);
  }

  const rows = parseCsv(trimmed);
  if (rows.length === 0) throw new Error('The CSV file has no data rows.');
  return { automations: [], projects: [], tasks: parseTaskRows(rows, warnings), warnings };
}

function parseTaskRows(
  rows: RawTaskRow[],
  warnings: string[],
  sourceIdToName?: Map<string, string>,
): ParsedTaskRow[] {
  const tasks: ParsedTaskRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { task, warning } = normalizeTaskRow(row);
    if (warning) {
      warnings.push(warning);
      if (!task.title) continue;
    }
    if (!task.project_name && sourceIdToName && typeof row.project_id === 'string') {
      const name = sourceIdToName.get(row.project_id);
      if (name) task.project_name = name;
    }
    tasks.push(task);
  }
  return tasks;
}

function parseProjects(raw: unknown, warnings: string[]): ParsedProject[] {
  if (!Array.isArray(raw)) return [];
  const projects: ParsedProject[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const obj = p as Record<string, unknown>;
    const name = toOptionalString(obj.name ?? obj.title);
    if (!name) {
      warnings.push('Skipped a project without a name.');
      continue;
    }
    const nested = Array.isArray(obj.tasks) ? parseTaskRows(obj.tasks as RawTaskRow[], warnings) : [];
    projects.push({
      source_id: toOptionalString(obj.id),
      name,
      description: toOptionalString(obj.description),
      color: toOptionalString(obj.color),
      icon: toOptionalString(obj.icon),
      due_date: toOptionalString(obj.due_date),
      tasks: nested,
    });
  }
  return projects;
}

function parseJsonImport(data: unknown, warnings: string[]): ParsedImport {
  if (isAutomationsExportDocument(data)) {
    return { automations: data.automations, projects: [], tasks: [], warnings };
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return { automations: [], projects: [], tasks: [], warnings };
    if (isAutomationItem(data[0])) {
      return { automations: data as AutomationExportItem[], projects: [], tasks: [], warnings };
    }
    return { automations: [], projects: [], tasks: parseTaskRows(data as RawTaskRow[], warnings), warnings };
  }

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const projects = parseProjects(obj.projects, warnings);
    const sourceIdToName = new Map(
      projects.filter((p) => p.source_id).map((p) => [p.source_id as string, p.name]),
    );
    const tasks = Array.isArray(obj.tasks)
      ? parseTaskRows(obj.tasks as RawTaskRow[], warnings, sourceIdToName)
      : [];
    const automations = Array.isArray(obj.automations)
      ? (obj.automations as AutomationExportItem[])
      : [];
    return { automations, projects, tasks, warnings };
  }

  throw new Error(
    'Unrecognized JSON. Expected a tasks, projects, or automations export, or an array of rows.',
  );
}
