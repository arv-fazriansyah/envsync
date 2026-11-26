import { Adapter, AdapterResult, createCapabilities, transformKeys, filterEntries, validateEntries } from './base.js';
import { SecretEntry, SecretsFile, SecretFormat, AdapterConfig } from '../core/index.js';
import { DopplerAdapterConfigSchema } from '../core/config.js';
import type { DopplerAdapterConfig } from '../core/config.js';

/**
 * Doppler adapter
 * Uses Doppler API to read secrets
 * Requires: DOPPLER_TOKEN or token in config
 */
export class DopplerAdapter implements Adapter {
  readonly type = 'doppler';
  readonly name: string;
  readonly capabilities = createCapabilities({ 
    read: true, 
    write: true, 
    list: true, 
    delete: true,
    requiresAuth: true,
  });
  
  private config: ReturnType<typeof DopplerAdapterConfigSchema.parse>;
  private initialized = false;
  private baseUrl = 'https://api.doppler.com/v3';
  
  constructor(config: DopplerAdapterConfig) {
    this.name = config.name;
    this.config = DopplerAdapterConfigSchema.parse(config);
  }
  
  async initialize(config: DopplerAdapterConfig): Promise<AdapterResult> {
    this.config = DopplerAdapterConfigSchema.parse(config);
    this.initialized = true;
    
    // Verify token exists
    const token = this.config.token || process.env['DOPPLER_TOKEN'];
    if (!token) {
      return { success: false, error: 'Doppler token not provided. Set DOPPLER_TOKEN env var or configure in adapter.' };
    }
    
    return { success: true };
  }
  
  async testConnection(): Promise<AdapterResult> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      const result = await this.request('GET', '/workplace');
      return result.success 
        ? { success: true } 
        : { success: false, error: `Auth failed: ${result.error}` };
    } catch (error) {
      return { success: false, error: `Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async read(): Promise<AdapterResult<SecretsFile>> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      const result = await this.request('GET', `/projects/${this.config.project}/configs/${this.config.config}/secrets/download`, {
        format: 'json',
      });
      
      if (!result.success || !result.data) {
        return { success: false, error: `Failed to fetch secrets: ${result.error}` };
      }
      
      const secrets = result.data as Record<string, string>;
      const entries: SecretEntry[] = Object.entries(secrets).map(([key, value]) => ({
        key,
        value,
        comment: `Doppler: ${this.config.project}/${this.config.config}`,
        isSecret: true,
      }));
      
      // Apply transformations
      const transformed = transformKeys(entries, this.config.transform);
      const filtered = filterEntries(transformed, this.config.include, this.config.exclude);
      
      const secretsFile: SecretsFile = {
        format: SecretFormat.DOTENV,
        path: `doppler:${this.config.project}/${this.config.config}`,
        entries: filtered,
        metadata: {
          source: 'doppler',
          environment: this.config.config,
          lastModified: new Date().toISOString(),
        },
      };
      
      return { success: true, data: secretsFile };
    } catch (error) {
      return { success: false, error: `Failed to read from Doppler: ${error instanceof Error ? error.message : 'Unknown error'}` };
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
      
      // Convert to Doppler format
      const secretMap: Record<string, string> = {};
      for (const entry of secrets.entries) {
        secretMap[entry.key] = entry.value;
      }
      
      // Doppler uses upsert for batch updates
      const result = await this.request('POST', `/projects/${this.config.project}/configs/${this.config.config}/secrets`, {
        secrets: secretMap,
      });
      
      return result.success 
        ? { success: true }
        : { success: false, error: `Failed to write secrets: ${result.error}` };
    } catch (error) {
      return { success: false, error: `Failed to write to Doppler: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async listEnvironments(): Promise<AdapterResult<string[]>> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      const result = await this.request('GET', `/projects/${this.config.project}/configs`);
      if (!result.success || !result.data) {
        return { success: false, error: result.error };
      }
      
      const configs = (result.data as any).configs || [];
      const envs = configs.map((c: any) => c.name);
      return { success: true, data: envs };
    } catch (error) {
      return { success: false, error: `Failed to list environments: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async delete(keys: string[]): Promise<AdapterResult> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      const result = await this.request('DELETE', `/projects/${this.config.project}/configs/${this.config.config}/secrets`, {
        names: keys,
      });
      
      return result.success 
        ? { success: true }
        : { success: false, error: `Failed to delete secrets: ${result.error}` };
    } catch (error) {
      return { success: false, error: `Failed to delete from Doppler: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async getMetadata(): Promise<AdapterResult<Record<string, unknown>>> {
    try {
      const result = await this.request('GET', `/projects/${this.config.project}`);
      return {
        success: true,
        data: {
          project: result.data,
          config: this.config.config,
        },
      };
    } catch {
      return { success: true, data: { project: this.config.project, config: this.config.config } };
    }
  }
  
  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<AdapterResult> {
    const token = this.config.token || process.env['DOPPLER_TOKEN']!;
    
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    
    const options: RequestInit = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    };
    
    try {
      const response = await fetch(`${this.baseUrl}${path}`, options);
      const data: any = await response.json().catch(() => null);
      
      if (!response.ok) {
        return { 
          success: false, 
          error: data?.error?.message || `HTTP ${response.status}: ${response.statusText}` 
        };
      }
      
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Request failed' };
    }
  }
}

/**
 * Factory function for Doppler adapter
 */
export function createDopplerAdapter(config: AdapterConfig): Adapter {
  return new DopplerAdapter(config as DopplerAdapterConfig);
}