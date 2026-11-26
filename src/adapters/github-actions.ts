import { Adapter, AdapterResult, createCapabilities, transformKeys, filterEntries, validateEntries } from './base.js';
import { SecretEntry, SecretsFile, SecretFormat, AdapterConfig, sealSecret } from '../core/index.js';
import { GitHubActionsAdapterConfigSchema } from '../core/config.js';
import type { GitHubActionsAdapterConfig } from '../core/config.js';

/**
 * GitHub Actions Secrets adapter
 * Uses GitHub API to manage repository/organization/environment secrets
 * Requires: GITHUB_TOKEN or token in config with appropriate scopes
 */
export class GitHubActionsAdapter implements Adapter {
  readonly type = 'github-actions';
  readonly name: string;
  readonly capabilities = createCapabilities({ 
    read: true, 
    write: true, 
    list: true, 
    delete: true,
    requiresAuth: true,
  });
  
  private config: ReturnType<typeof GitHubActionsAdapterConfigSchema.parse>;
  private initialized = false;
  private baseUrl = 'https://api.github.com';
  
  constructor(config: GitHubActionsAdapterConfig) {
    this.name = config.name;
    this.config = GitHubActionsAdapterConfigSchema.parse(config);
  }
  
  async initialize(config: GitHubActionsAdapterConfig): Promise<AdapterResult> {
    this.config = GitHubActionsAdapterConfigSchema.parse(config);
    this.initialized = true;
    
    const token = this.config.token || process.env['GITHUB_TOKEN'];
    if (!token) {
      return { success: false, error: 'GitHub token not provided. Set GITHUB_TOKEN env var or configure in adapter.' };
    }
    
    return { success: true };
  }
  
  async testConnection(): Promise<AdapterResult> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      const result = await this.request('GET', '/user');
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
      let secrets: Record<string, string> = {};
      
      if (this.config.level === 'repository') {
        const result = await this.getRepoSecrets();
        if (!result.success) return { success: false, error: result.error };
        secrets = result.data!;
      } else if (this.config.level === 'environment') {
        if (!this.config.environment) {
          return { success: false, error: 'Environment name required for environment-level secrets' };
        }
        const result = await this.getEnvironmentSecrets();
        if (!result.success) return { success: false, error: result.error };
        secrets = result.data!;
      } else if (this.config.level === 'organization') {
        if (!this.config.organization) {
          return { success: false, error: 'Organization name required for organization-level secrets' };
        }
        const result = await this.getOrgSecrets();
        if (!result.success) return { success: false, error: result.error };
        secrets = result.data!;
      }
      
      const entries: SecretEntry[] = Object.entries(secrets).map(([key, value]) => ({
        key,
        value,
        comment: `GitHub ${this.config.level}: ${this.config.repo}${this.config.environment ? `/${this.config.environment}` : ''}${this.config.organization ? `/${this.config.organization}` : ''}`,
        isSecret: true,
      }));
      
      // Apply transformations
      const transformed = transformKeys(entries, this.config.transform);
      const filtered = filterEntries(transformed, this.config.include, this.config.exclude);
      
      const secretsFile: SecretsFile = {
        format: SecretFormat.DOTENV,
        path: `github:${this.config.level}:${this.config.repo}${this.config.environment ? `/${this.config.environment}` : ''}`,
        entries: filtered,
        metadata: {
          source: 'github-actions',
          environment: this.config.environment,
          lastModified: new Date().toISOString(),
        },
      };
      
      return { success: true, data: secretsFile };
    } catch (error) {
      return { success: false, error: `Failed to read from GitHub: ${error instanceof Error ? error.message : 'Unknown error'}` };
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
      
      const secretMap: Record<string, string> = {};
      for (const entry of secrets.entries) {
        secretMap[entry.key] = entry.value;
      }
      
      // Write each secret
      for (const [key, value] of Object.entries(secretMap)) {
        let result: AdapterResult;
        
        if (this.config.level === 'repository') {
          result = await this.setRepoSecret(key, value);
        } else if (this.config.level === 'environment') {
          if (!this.config.environment) {
            return { success: false, error: 'Environment name required' };
          }
          result = await this.setEnvironmentSecret(key, value);
        } else if (this.config.level === 'organization') {
          if (!this.config.organization) {
            return { success: false, error: 'Organization name required' };
          }
          result = await this.setOrgSecret(key, value);
        } else {
          return { success: false, error: `Unknown level: ${this.config.level}` };
        }
        
        if (!result.success) {
          return { success: false, error: `Failed to set ${key}: ${result.error}` };
        }
      }
      
      return { success: true };
    } catch (error) {
      return { success: false, error: `Failed to write to GitHub: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async listEnvironments(): Promise<AdapterResult<string[]>> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      if (this.config.level === 'repository') {
        const result = await this.request('GET', `/repos/${this.config.repo}/environments`);
        if (!result.success) return { success: false, error: result.error };
        const envs = (result.data as any).environments?.map((e: any) => e.name) || [];
        return { success: true, data: envs };
      } else if (this.config.level === 'organization') {
        const result = await this.request('GET', `/orgs/${this.config.organization}/actions/secrets`);
        if (!result.success) return { success: false, error: result.error };
        return { success: true, data: ['organization'] };
      }
      
      return { success: true, data: ['repository'] };
    } catch (error) {
      return { success: false, error: `Failed to list environments: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async delete(keys: string[]): Promise<AdapterResult> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      for (const key of keys) {
        let result: AdapterResult;
        
        if (this.config.level === 'repository') {
          result = await this.request('DELETE', `/repos/${this.config.repo}/actions/secrets/${encodeURIComponent(key)}`);
        } else if (this.config.level === 'environment') {
          if (!this.config.environment) {
            return { success: false, error: 'Environment name required' };
          }
          result = await this.request('DELETE', `/repositories/${await this.getRepoId()}/environments/${this.config.environment}/secrets/${encodeURIComponent(key)}`);
        } else if (this.config.level === 'organization') {
          if (!this.config.organization) {
            return { success: false, error: 'Organization name required' };
          }
          result = await this.request('DELETE', `/orgs/${this.config.organization}/actions/secrets/${encodeURIComponent(key)}`);
        } else {
          return { success: false, error: `Unknown level: ${this.config.level}` };
        }
        
        if (!result.success) {
          return { success: false, error: `Failed to delete ${key}: ${result.error}` };
        }
      }
      
      return { success: true };
    } catch (error) {
      return { success: false, error: `Failed to delete from GitHub: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async getMetadata(): Promise<AdapterResult<Record<string, unknown>>> {
    try {
      const user = await this.request('GET', '/user');
      return {
        success: true,
        data: {
          user: user.data,
          repo: this.config.repo,
          level: this.config.level,
          environment: this.config.environment,
          organization: this.config.organization,
        },
      };
    } catch {
      return { success: true, data: { repo: this.config.repo, level: this.config.level } };
    }
  }
  
  private async getRepoSecrets(): Promise<AdapterResult<Record<string, string>>> {
    const result = await this.request('GET', `/repos/${this.config.repo}/actions/secrets`);
    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }
    
    const secretMap: Record<string, string> = {};
    
    // GitHub API doesn't return secret values in list, need to get each
    // This is a limitation - we can only get names, not values
    // For reading values, we'd need to use a different approach
    return { success: true, data: secretMap };
  }
  
  private async getEnvironmentSecrets(): Promise<AdapterResult<Record<string, string>>> {
    const repoId = await this.getRepoId();
    if (!repoId) {
      return { success: false, error: 'Could not get repository ID' };
    }
    
    const result = await this.request('GET', `/repositories/${repoId}/environments/${this.config.environment}/secrets`);
    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }
    
    return { success: true, data: {} };
  }
  
  private async getOrgSecrets(): Promise<AdapterResult<Record<string, string>>> {
    const result = await this.request('GET', `/orgs/${this.config.organization}/actions/secrets`);
    if (!result.success || !result.data) {
      return { success: false, error: result.error };
    }
    
    return { success: true, data: {} };
  }
  
  private async setRepoSecret(key: string, value: string): Promise<AdapterResult<any>> {
    // Need to encrypt with repo public key first
    const publicKey = await this.getRepoPublicKey();
    if (!publicKey.success || !publicKey.data) {
      return { success: false, error: 'Failed to get repository public key' };
    }
    
    const encrypted = await this.encryptSecret(value, publicKey.data.key);
    if (!encrypted.success) return encrypted;
    
    return this.request('PUT', `/repos/${this.config.repo}/actions/secrets/${encodeURIComponent(key)}`, {
      encrypted_value: encrypted.data,
      key_id: publicKey.data.key_id,
    });
  }
  
  private async setEnvironmentSecret(key: string, value: string): Promise<AdapterResult<any>> {
    const repoId = await this.getRepoId();
    if (!repoId) {
      return { success: false, error: 'Could not get repository ID' };
    }
    
    const publicKey = await this.getEnvironmentPublicKey(repoId);
    if (!publicKey.success || !publicKey.data) {
      return { success: false, error: 'Failed to get environment public key' };
    }
    
    const encrypted = await this.encryptSecret(value, publicKey.data.key);
    if (!encrypted.success) return encrypted;
    
    return this.request('PUT', `/repositories/${repoId}/environments/${this.config.environment}/secrets/${encodeURIComponent(key)}`, {
      encrypted_value: encrypted.data,
      key_id: publicKey.data.key_id,
    });
  }
  
  private async setOrgSecret(key: string, value: string): Promise<AdapterResult<any>> {
    const publicKey = await this.getOrgPublicKey();
    if (!publicKey.success || !publicKey.data) {
      return { success: false, error: 'Failed to get organization public key' };
    }
    
    const encrypted = await this.encryptSecret(value, publicKey.data.key);
    if (!encrypted.success) return encrypted;
    
    return this.request('PUT', `/orgs/${this.config.organization}/actions/secrets/${encodeURIComponent(key)}`, {
      encrypted_value: encrypted.data,
      key_id: publicKey.data.key_id,
    });
  }
  
  private async getRepoId(): Promise<number | null> {
    const result = await this.request('GET', `/repos/${this.config.repo}`);
    if (!result.success || !result.data) return null;
    return (result.data as any).id;
  }
  
  private async getRepoPublicKey(): Promise<AdapterResult<any>> {
    return this.request('GET', `/repos/${this.config.repo}/actions/secrets/public-key`);
  }
  
  private async getEnvironmentPublicKey(repoId: number): Promise<AdapterResult<any>> {
    return this.request('GET', `/repositories/${repoId}/environments/${this.config.environment}/secrets/public-key`);
  }
  
  private async getOrgPublicKey(): Promise<AdapterResult<any>> {
    return this.request('GET', `/orgs/${this.config.organization}/actions/secrets/public-key`);
  }
  
  private async encryptSecret(value: string, publicKeyBase64: string): Promise<AdapterResult<string>> {
    try {
      // GitHub requires a libsodium sealed box encrypted with the repo/environment/org public key
      const sealed = await sealSecret(value, publicKeyBase64);
      return { success: true, data: sealed };
    } catch (error) {
      return { success: false, error: `Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<AdapterResult<any>> {
    const token = this.config.token || process.env['GITHUB_TOKEN']!;
    
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
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
          error: data?.message || `HTTP ${response.status}: ${response.statusText}` 
        };
      }
      
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Request failed' };
    }
  }
}

/**
 * Factory function for GitHub Actions adapter
 */
export function createGitHubActionsAdapter(config: AdapterConfig): Adapter {
  return new GitHubActionsAdapter(config as GitHubActionsAdapterConfig);
}