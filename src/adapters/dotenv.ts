import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Adapter, AdapterResult, createCapabilities, transformKeys, filterEntries, validateEntries } from './base.js';
import { SecretsFile, parseDotenv, serializeDotenv, computeChecksum, AdapterConfig } from '../core/index.js';
import { DotenvAdapterConfigSchema } from '../core/config.js';
import type { DotenvAdapterConfig } from '../core/config.js';

/**
 * .env file adapter
 * Reads/writes standard .env files with encryption support
 */
export class DotenvAdapter implements Adapter {
  readonly type = 'dotenv';
  readonly name: string;
  readonly capabilities = createCapabilities({ read: true, write: true, list: false, delete: false });
  
  private config: ReturnType<typeof DotenvAdapterConfigSchema.parse>;
  private initialized = false;
  
  constructor(config: DotenvAdapterConfig) {
    this.name = config.name;
    this.config = DotenvAdapterConfigSchema.parse(config);
  }
  
  async initialize(config: DotenvAdapterConfig): Promise<AdapterResult> {
    this.config = DotenvAdapterConfigSchema.parse(config);
    this.initialized = true;
    return { success: true };
  }
  
  async testConnection(): Promise<AdapterResult> {
    try {
      const fullPath = resolve(this.config.path);
      await stat(fullPath);
      return { success: true, data: undefined, warnings: [] };
    } catch {
      // File doesn't exist yet - that's ok for write
      return { success: true, warnings: [`File does not exist: ${this.config.path} (will be created on write)`] };
    }
  }
  
  async read(): Promise<AdapterResult<SecretsFile>> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      const fullPath = resolve(this.config.path);
      const content = await readFile(fullPath, 'utf-8');
      const { entries } = parseDotenv(content);
      
      // Filter by include/exclude on source key names first, then apply destination transform
      const filtered = filterEntries(entries, this.config.include, this.config.exclude);
      const transformed = transformKeys(filtered, this.config.transform);
      
      const secretsFile: SecretsFile = {
        format: this.config.format,
        path: this.config.path,
        entries: transformed,
        metadata: {
          source: 'dotenv',
          lastModified: new Date().toISOString(),
          checksum: computeChecksum(transformed),
        },
      };
      
      return { success: true, data: secretsFile };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist - return empty
        return {
          success: true,
          data: {
            format: this.config.format,
            path: this.config.path,
            entries: [],
            metadata: { source: 'dotenv', lastModified: new Date().toISOString(), checksum: '' },
          },
        };
      }
      return { success: false, error: `Failed to read .env file: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async write(secrets: SecretsFile): Promise<AdapterResult> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      // Validate entries
      const validation = validateEntries(secrets.entries);
      if (!validation.valid) {
        return { success: false, error: `Validation failed: ${validation.errors.join(', ')}` };
      }
      
      const fullPath = resolve(this.config.path);
      
      // Backup existing file
      if (this.config.backup) {
        try {
          const existing = await readFile(fullPath, 'utf-8');
          const backupPath = `${fullPath}.backup.${Date.now()}`;
          await writeFile(backupPath, existing, { mode: this.config.mode });
        } catch {
          // No existing file to backup
        }
      }
      
      // Ensure directory exists
      await mkdir(dirname(fullPath), { recursive: true });
      
      // Serialize and write
      const content = serializeDotenv(secrets.entries);
      await writeFile(fullPath, content, { mode: this.config.mode });
      
      return { success: true };
    } catch (error) {
      return { success: false, error: `Failed to write .env file: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async getMetadata(): Promise<AdapterResult<Record<string, unknown>>> {
    try {
      const fullPath = resolve(this.config.path);
      const stats = await stat(fullPath);
      return {
        success: true,
        data: {
          path: fullPath,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          isFile: stats.isFile(),
        },
      };
    } catch {
      return { success: true, data: { path: resolve(this.config.path), exists: false } };
    }
  }
}

/**
 * Factory function for dotenv adapter
 */
export function createDotenvAdapter(config: AdapterConfig): Adapter {
  return new DotenvAdapter(config as DotenvAdapterConfig);
}