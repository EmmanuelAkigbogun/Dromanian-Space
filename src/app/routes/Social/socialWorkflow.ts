export interface CampaignBriefInput {
  company: string;
  goal: string;
  from: string;
  to: string;
  channels: string[];
  frequency: string;
  notes?: string;
}

export interface CreativePackageInput {
  company: string;
  channel?: string | null;
  format?: string | null;
  scheduledAt?: string | null;
  caption: string;
  script?: string | null;
  visualBrief?: string | null;
  cta?: string | null;
  hashtags?: string[];
  assets?: Array<{ item_id: string; label: string; mime_type?: string | null }>;
  link?: string | null;
}

export function buildCampaignBrief(input: CampaignBriefInput): string {
  const lines = [
    `Create a production-ready social media calendar for ${input.company}.`,
    `Goal: ${input.goal.trim()}.`,
    `Date range: ${input.from} through ${input.to}.`,
    `Channels: ${input.channels.join(', ')}.`,
    `Frequency: ${input.frequency}.`,
    'Read this company\'s Drive/Brand kit first. Use exact Drive asset IDs for approved logos or visuals.',
    'For every post include its channel, suggested date/time, caption, CTA, hashtags, visual brief and, for video, a complete script.',
    'Then propose the posts as Social drafts only. Do not schedule or publish them.',
  ];
  if (input.notes?.trim()) lines.splice(5, 0, `Campaign notes: ${input.notes.trim()}.`);
  return lines.join('\n');
}

export function socialAgentHref(agentId: string, companyId: string, brief: string): string {
  const query = new URLSearchParams({ company: companyId, brief: brief.trim().slice(0, 3_500) });
  return `/agents/${encodeURIComponent(agentId)}?${query.toString()}`;
}

export function normalizeHashtagInput(value: string): string[] {
  return [...new Set(value
    .split(/[\s,]+/)
    .map((tag) => tag.trim().replace(/^#+/, ''))
    .filter(Boolean))]
    .slice(0, 30);
}

export function creativePackageMarkdown(input: CreativePackageInput): string {
  const assets = input.assets?.length
    ? input.assets.map((asset) => `- ${asset.label} (Drive item: ${asset.item_id}${asset.mime_type ? `; ${asset.mime_type}` : ''})`).join('\n')
    : '- No Drive assets selected';
  return [
    `# ${input.company} social creative package`, '',
    `- Channel: ${input.channel ?? 'Not set'}`,
    `- Format: ${input.format ?? 'Not set'}`,
    `- Suggested date: ${input.scheduledAt ?? 'Not set'}`, '',
    '## Caption', input.caption, '',
    '## Script', input.script?.trim() || 'No separate script.', '',
    '## Visual brief', input.visualBrief?.trim() || 'No visual brief.', '',
    '## CTA', input.cta?.trim() || 'No CTA.', '',
    '## Hashtags', input.hashtags?.length ? input.hashtags.map((tag) => `#${tag}`).join(' ') : 'No hashtags.', '',
    '## Drive assets', assets, '',
    '## Link', input.link?.trim() || 'No link.', '',
    '> Export package only. Creating or publishing a design remains a separate reviewed action.',
  ].join('\n');
}

export function calendarDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

export function localDayKey(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
