import { Adapter, AdapterResult, createCapabilities, transformKeys, filterEntries, validateEntries } from './base.js';
import { SecretEntry, SecretsFile, SecretFormat, AdapterConfig } from '../core/index.js';
import { VercelAdapterConfigSchema } from '../core/config.js';
import type { VercelAdapterConfig } from '../core/config.js';

/**
 * Vercel Environment Variables adapter
 * Uses Vercel API to manage project environment variables
 * Requires: Vercel token with appropriate scopes
 */
export class VercelAdapter implements Adapter {
  readonly type = 'vercel';
  readonly name: string;
  readonly capabilities = createCapabilities({ 
    read: true, 
    write: true, 
    list: true, 
    delete: true,
    requiresAuth: true,
  });
  
  private config: ReturnType<typeof VercelAdapterConfigSchema.parse>;
  private initialized = false;
  private baseUrl = 'https://api.vercel.com';
  
  constructor(config: VercelAdapterConfig) {
    this.name = config.name;
    this.config = VercelAdapterConfigSchema.parse(config);
  }
  
  async initialize(config: VercelAdapterConfig): Promise<AdapterResult> {
    this.config = VercelAdapterConfigSchema.parse(config);
    this.initialized = true;
    
    const token = this.config.token || process.env['VERCEL_TOKEN'];
    if (!token) {
      return { success: false, error: 'Vercel token not provided. Set VERCEL_TOKEN env var or configure in adapter.' };
    }
    
    return { success: true };
  }
  
  async testConnection(): Promise<AdapterResult> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      const result = await this.request('GET', '/v2/user');
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
      const target = this.config.target || 'production';
      const result = await this.request('GET', `/v1/projects/${this.config.projectId}/env?target=${target}`);
      
      if (!result.success || !result.data) {
        return { success: false, error: `Failed to fetch env vars: ${result.error}` };
      }
      
      const envs = (result.data as any).envs || [];
      const entries: SecretEntry[] = envs.map((env: any) => ({
        key: env.key,
        value: env.value || '',
        comment: `Vercel ${target}: ${env.type || 'plain'} ${env.target?.join(', ') || ''}`,
        isSecret: env.type === 'secret',
        metadata: {
          vercelId: env.id,
          type: env.type,
          target: env.target,
          gitBranch: env.gitBranch,
        },
      }));
      
      // Apply transformations
      const transformed = transformKeys(entries, this.config.transform);
      const filtered = filterEntries(transformed, this.config.include, this.config.exclude);
      
      const secretsFile: SecretsFile = {
        format: SecretFormat.DOTENV,
        path: `vercel:${this.config.projectId}/${target}`,
        entries: filtered,
        metadata: {
          source: 'vercel',
          environment: target,
          lastModified: new Date().toISOString(),
        },
      };
      
      return { success: true, data: secretsFile };
    } catch (error) {
      return { success: false, error: `Failed to read from Vercel: ${error instanceof Error ? error.message : 'Unknown error'}` };
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
      
      const target = this.config.target || 'production';
      
      // Get existing env vars to check for conflicts
      const existingResult = await this.request('GET', `/v1/projects/${this.config.projectId}/env?target=${target}`);
      const existingEnvs = (existingResult.data as any)?.envs || [];
      const existingMap = new Map<string, { id: string; key: string; value: string; type: string }>(
        existingEnvs.map((e: any) => [e.key, e])
      );
      
      // Upsert each secret
      for (const entry of secrets.entries) {
        const existing = existingMap.get(entry.key);
        
        if (existing) {
          // Update existing
          const result = await this.request('PATCH', `/v1/projects/${this.config.projectId}/env/${existing.id}`, {
            value: entry.value,
            type: entry.isSecret ? 'secret' : 'plain',
            target: [target],
          });
          
          if (!result.success) {
            return { success: false, error: `Failed to update ${entry.key}: ${result.error}` };
          }
        } else {
          // Create new
          const result = await this.request('POST', `/v1/projects/${this.config.projectId}/env`, {
            key: entry.key,
            value: entry.value,
            type: entry.isSecret ? 'secret' : 'plain',
            target: [target],
            ...(this.config.teamId && { teamId: this.config.teamId }),
          });
          
          if (!result.success) {
            return { success: false, error: `Failed to create ${entry.key}: ${result.error}` };
          }
        }
      }
      
      return { success: true };
    } catch (error) {
      return { success: false, error: `Failed to write to Vercel: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async listEnvironments(): Promise<AdapterResult<string[]>> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      const result = await this.request('GET', `/v1/projects/${this.config.projectId}/env`);
      if (!result.success || !result.data) {
        return { success: false, error: result.error };
      }
      
      const envs = (result.data as any).envs || [];
      const targets = new Set<string>();
      for (const env of envs) {
        if (env.target) {
          env.target.forEach((t: string) => targets.add(t));
        }
      }
      
      return { success: true, data: Array.from(targets) };
    } catch (error) {
      return { success: false, error: `Failed to list environments: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async delete(keys: string[]): Promise<AdapterResult> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      const target = this.config.target || 'production';
      const result = await this.request('GET', `/v1/projects/${this.config.projectId}/env?target=${target}`);
      if (!result.success || !result.data) {
        return { success: false, error: result.error };
      }
      
      const envs = (result.data as any).envs || [];
      const envMap = new Map(envs.map((e: any) => [e.key, e.id]));
      
      for (const key of keys) {
        const id = envMap.get(key);
        if (id) {
          const result = await this.request('DELETE', `/v1/projects/${this.config.projectId}/env/${id}`);
          if (!result.success) {
            return { success: false, error: `Failed to delete ${key}: ${result.error}` };
          }
        }
      }
      
      return { success: true };
    } catch (error) {
      return { success: false, error: `Failed to delete from Vercel: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async getMetadata(): Promise<AdapterResult<Record<string, unknown>>> {
    try {
      const project = await this.request('GET', `/v1/projects/${this.config.projectId}`);
      return {
        success: true,
        data: {
          project: project.data,
          target: this.config.target,
          teamId: this.config.teamId,
        },
      };
    } catch {
      return { success: true, data: { projectId: this.config.projectId, target: this.config.target } };
    }
  }
  
  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<AdapterResult> {
    const token = this.config.token || process.env['VERCEL_TOKEN']!;
    
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
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
          error: data?.error?.message || data?.message || `HTTP ${response.status}: ${response.statusText}` 
        };
      }
      
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Request failed' };
    }
  }
}

/**
 * Factory function for Vercel adapter
 */
export function createVercelAdapter(config: AdapterConfig): Adapter {
  return new VercelAdapter(config as VercelAdapterConfig);
}