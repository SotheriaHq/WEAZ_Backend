import { formatZoned } from './report-window';
import { MonitoringSeverity, SEVERITY_ICON } from './monitoring-events';

export type MessageField = [label: string, value: string | number | boolean | null | undefined];

export type UserIdentity = {
  userId?: string | null;
  username?: string | null;
  email?: string | null;
  accountType?: string | null;
};

export type TimelineEntry = [label: string, at: Date | string | null | undefined];

export type RenderableMessage = {
  environment: string;
  severity: MonitoringSeverity;
  title: string;
  summary?: string | null;
  fields?: MessageField[];
  /** Extra headed groups rendered after `fields`, e.g. Request / Error. */
  sections?: Array<{ heading: string; fields: MessageField[] }>;
  identity?: UserIdentity | null;
  timeline?: TimelineEntry[];
  links?: Array<[label: string, url: string | null | undefined]>;
};

export type RenderOptions = {
  includeIdentity: boolean;
  timeZone: string;
};

const MAX_VALUE_LENGTH = 300;
const SAFE_LINK_HOSTS = ['sentry.io', 'weaz.me', 'wiez.com', 'weaz.com'];

/** Strip control characters and collapse whitespace; cap the length. */
export function cleanText(value: unknown, max = MAX_VALUE_LENGTH): string {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Only https links on known hosts (and their subdomains, e.g. an org's
 * `<org>.sentry.io`) may appear in a message. Anything else is dropped rather
 * than shown, so a forged payload cannot plant a phishing link in the chat.
 */
export function safeUrl(raw: unknown, allowedHosts: string[] = SAFE_LINK_HOSTS): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
  return allowed ? url.toString() : null;
}

/** First 8 chars of an id: enough to search for, too short to be the whole key. */
export function shortId(value: string | null | undefined): string {
  const text = cleanText(value ?? '', 64);
  return text ? text.slice(0, 8) : 'n/a';
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function renderMessage(message: RenderableMessage, options: RenderOptions): string {
  const lines: string[] = [];
  lines.push(`${SEVERITY_ICON[message.severity]} [${cleanText(message.environment, 16)}] ${cleanText(message.title, 120)}`);
  if (message.summary) {
    lines.push(cleanText(message.summary, 400));
  }

  const present = (list: MessageField[] | undefined) =>
    (list ?? []).filter(([, value]) => value !== null && value !== undefined && value !== '');
  const fields = present(message.fields);
  if (fields.length > 0) {
    lines.push('');
    for (const [label, value] of fields) {
      lines.push(`• ${cleanText(label, 60)}: ${cleanText(value)}`);
    }
  }
  for (const section of message.sections ?? []) {
    const sectionFields = present(section.fields);
    if (sectionFields.length === 0) continue;
    lines.push('');
    lines.push(cleanText(section.heading, 60));
    for (const [label, value] of sectionFields) {
      lines.push(`• ${cleanText(label, 60)}: ${cleanText(value)}`);
    }
  }

  const identity = message.identity;
  if (identity && (identity.userId || identity.username || identity.email)) {
    lines.push('');
    lines.push('👤 User');
    if (options.includeIdentity) {
      if (identity.username) lines.push(`• Username: @${cleanText(identity.username, 80)}`);
      if (identity.email) lines.push(`• Email: ${cleanText(identity.email, 120)}`);
      if (identity.userId) lines.push(`• ID: ${cleanText(identity.userId, 64)}`);
    } else if (identity.userId) {
      lines.push(`• ID: ${shortId(identity.userId)}… (identity hidden by config)`);
    }
    if (identity.accountType) lines.push(`• Account type: ${cleanText(identity.accountType, 40)}`);
  }

  const timeline = (message.timeline ?? [])
    .map(([label, at]) => [label, toDate(at)] as const)
    .filter(([, at]) => at !== null);
  if (timeline.length > 0) {
    lines.push('');
    lines.push('🕒 Timeline');
    for (const [label, at] of timeline) {
      lines.push(`• ${cleanText(label, 60)}: ${formatZoned(at, options.timeZone)}`);
    }
  }

  const links = (message.links ?? [])
    .map(([label, url]) => [label, safeUrl(url)] as const)
    .filter(([, url]) => Boolean(url));
  if (links.length > 0) {
    lines.push('');
    for (const [label, url] of links) {
      lines.push(`🔗 ${cleanText(label, 60)}: ${url}`);
    }
  }

  return lines.join('\n');
}
