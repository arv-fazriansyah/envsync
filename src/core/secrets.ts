import { z } from 'zod';

/**
 * Supported secret formats
 */
export enum SecretFormat {
  DOTENV = 'dotenv',
  YAML = 'yaml',
  JSON = 'json',
  SHELL = 'shell',
}

/**
 * Single secret entry
 */
export const SecretEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  comment: z.string().optional(),
  isSecret: z.boolean().default(true),
  metadata: z.record(z.unknown()).optional(),
});

export type SecretEntry = z.infer<typeof SecretEntrySchema>;

/**
 * Collection of secrets with metadata
 */
export const SecretsFileSchema = z.object({
  format: z.nativeEnum(SecretFormat),
  path: z.string(),
  entries: z.array(SecretEntrySchema),
  metadata: z.object({
    source: z.string().optional(),
    environment: z.string().optional(),
    lastModified: z.string().optional(),
    checksum: z.string().optional(),
  }).optional(),
});

export type SecretsFile = z.infer<typeof SecretsFileSchema>;

/**
 * Parsed .env file content
 */
export interface DotenvParseResult {
  entries: SecretEntry[];
  raw: string;
}

/**
 * Parse .env file content
 * Supports: KEY=value, KEY="value", KEY='value', export KEY=value, comments
 */
export function parseDotenv(content: string): DotenvParseResult {
  const entries: SecretEntry[] = [];
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    
    // Handle export KEY=value
    const exportMatch = trimmed.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    const standardMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    
    const match = exportMatch || standardMatch;
    if (!match) continue;
    
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) continue;
    let parsedValue = rawValue.trim();
    let comment: string | undefined;

    // Handle quotes first, so a "#" inside a quoted value is not a comment
    const quote = parsedValue[0];
    if ((quote === '"' || quote === "'") && parsedValue.length >= 2) {
      const closing = parsedValue.lastIndexOf(quote);
      if (closing > 0) {
        const trailing = parsedValue.slice(closing + 1).trim();
        if (trailing.startsWith('#')) {
          comment = trailing.slice(1).trim() || undefined;
        }
        parsedValue = parsedValue.slice(1, closing);
      }
    } else {
      // Handle inline comments on unquoted values
      const commentIndex = parsedValue.indexOf(' #');
      if (commentIndex !== -1) {
        comment = parsedValue.slice(commentIndex + 2).trim() || undefined;
        parsedValue = parsedValue.slice(0, commentIndex).trim();
      }
    }
    
    // Handle escaped characters
    parsedValue = parsedValue
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
    
    entries.push({
      key,
      value: parsedValue,
      comment,
      isSecret: true,
    });
  }
  
  return { entries, raw: content };
}

/**
 * Serialize entries to .env format
 */
export function serializeDotenv(entries: SecretEntry[]): string {
  const lines: string[] = [];
  
  for (const entry of entries) {
    if (entry.comment) {
      lines.push(`# ${entry.comment}`);
    }
    
    // Escape value for .env
    let value = entry.value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/"/g, '\\"');
    
    // Quote if contains spaces, special chars, or empty
    const needsQuotes = /[\s#$&*()\x5b\x5d{}|;<>?`~!@%]/.test(value) || value === '';
    if (needsQuotes) {
      value = `"${value}"`;
    }
    
    lines.push(`${entry.key}=${value}`);
  }
  
  return lines.join('\n') + '\n';
}

/**
 * Parse YAML content
 */
export function parseYaml(_content: string): SecretEntry[] {
  // Dynamic import to avoid requiring yaml as dependency if not used
  // For now, simple implementation - will use js-yaml in adapters
  throw new Error('YAML parsing not implemented in core - use adapters/yaml.ts');
}

/**
 * Parse JSON content
 */
export function parseJson(content: string): SecretEntry[] {
  try {
    const obj = JSON.parse(content);
    return Object.entries(obj).map(([key, value]) => ({
      key,
      value: String(value),
      isSecret: true,
    }));
  } catch {
    throw new Error('Invalid JSON format');
  }
}

/**
 * Serialize to JSON
 */
export function serializeJson(entries: SecretEntry[]): string {
  const obj: Record<string, string> = {};
  for (const entry of entries) {
    obj[entry.key] = entry.value;
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Detect format from file path
 */
export function detectFormat(path: string): SecretFormat {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'env':
    case 'dotenv':
      return SecretFormat.DOTENV;
    case 'yaml':
    case 'yml':
      return SecretFormat.YAML;
    case 'json':
      return SecretFormat.JSON;
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
      return SecretFormat.SHELL;
    default:
      return SecretFormat.DOTENV;
  }
}

/**
 * Compute checksum of entries for change detection
 */
export function computeChecksum(entries: SecretEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const str = sorted.map(e => `${e.key}=${e.value}`).join('\n');
  
  // Simple hash - in production use crypto.subtle.digest
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Diff two secret sets
 */
export interface SecretDiff {
  added: SecretEntry[];
  removed: SecretEntry[];
  modified: { old: SecretEntry; new: SecretEntry }[];
  unchanged: SecretEntry[];
}

export function diffSecrets(oldEntries: SecretEntry[], newEntries: SecretEntry[]): SecretDiff {
  const oldMap = new Map(oldEntries.map(e => [e.key, e]));
  const newMap = new Map(newEntries.map(e => [e.key, e]));
  
  const added: SecretEntry[] = [];
  const removed: SecretEntry[] = [];
  const modified: { old: SecretEntry; new: SecretEntry }[] = [];
  const unchanged: SecretEntry[] = [];
  
  for (const [key, newEntry] of newMap) {
    const oldEntry = oldMap.get(key);
    if (!oldEntry) {
      added.push(newEntry);
    } else if (oldEntry.value !== newEntry.value) {
      modified.push({ old: oldEntry, new: newEntry });
    } else {
      unchanged.push(newEntry);
    }
  }
  
  for (const [key, oldEntry] of oldMap) {
    if (!newMap.has(key)) {
      removed.push(oldEntry);
    }
  }
  
  return { added, removed, modified, unchanged };
}

/**
 * Filter secrets by pattern (glob-style)
 */
export function filterSecrets(entries: SecretEntry[], patterns: string[]): SecretEntry[] {
  if (patterns.length === 0) return entries;
  
  return entries.filter(entry => 
    patterns.some(pattern => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      return regex.test(entry.key);
    })
  );
}