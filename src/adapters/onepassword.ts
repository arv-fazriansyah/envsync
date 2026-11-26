import { spawn } from 'node:child_process';
import { Adapter, AdapterResult, createCapabilities, transformKeys, filterEntries } from './base.js';
import { SecretEntry, SecretsFile, SecretFormat, AdapterConfig } from '../core/index.js';
import { OnePasswordAdapterConfigSchema } from '../core/config.js';
import type { OnePasswordAdapterConfig } from '../core/config.js';

/**
 * 1Password CLI adapter
 * Uses `op` CLI to read secrets from 1Password vaults
 * Requires: op CLI installed and authenticated
 */
export class OnePasswordAdapter implements Adapter {
  readonly type = '1password';
  readonly name: string;
  readonly capabilities = createCapabilities({ 
    read: true, 
    write: false, // 1Password write via CLI is complex, read-only for now
    list: true, 
    delete: false,
    requiresAuth: true,
  });
  
  private config: ReturnType<typeof OnePasswordAdapterConfigSchema.parse>;
  private initialized = false;
  
  constructor(config: OnePasswordAdapterConfig) {
    this.name = config.name;
    this.config = OnePasswordAdapterConfigSchema.parse(config);
  }
  
  async initialize(config: OnePasswordAdapterConfig): Promise<AdapterResult> {
    this.config = OnePasswordAdapterConfigSchema.parse(config);
    this.initialized = true;
    
    // Verify op CLI is available
    const available = await this.checkCLI();
    if (!available) {
      return { success: false, error: '1Password CLI (op) not found. Install from https://developer.1password.com/docs/cli/get-started/' };
    }
    
    return { success: true };
  }
  
  async testConnection(): Promise<AdapterResult> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      const result = await this.runOp(['account', 'list', '--format=json']);
      if (!result.success) {
        return { success: false, error: `Not authenticated: ${result.error}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: `Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async read(): Promise<AdapterResult<SecretsFile>> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      let itemIdentifier = this.config.item;
      const vaultIdentifier = this.config.vault;
      
      // If no specific item, try to find by name or list
      if (!itemIdentifier) {
        const items = await this.listItems(vaultIdentifier);
        if (!items.success || !items.data || items.data.length === 0) {
          return { success: false, error: 'No items found. Specify an item or vault.' };
        }
        // Use first item that has fields
        const firstItem = items.data[0];
        if (!firstItem) {
          return { success: false, error: 'No items found' };
        }
        itemIdentifier = firstItem.id;
      }
      
      // Get item details
      const itemResult = await this.runOp(['item', 'get', itemIdentifier, '--format=json', ...(vaultIdentifier ? ['--vault', vaultIdentifier] : [])]);
      if (!itemResult.success) {
        return { success: false, error: `Failed to get item: ${itemResult.error}` };
      }
      
      const item = JSON.parse(itemResult.data!);
      const entries: SecretEntry[] = [];
      
      // Process fields
      for (const field of item.fields || []) {
        const key = this.config.fieldMapping?.[field.label] || field.label;
        const value = field.value || '';
        
        if (value) {
          entries.push({
            key,
            value,
            comment: field.label !== key ? `1Password field: ${field.label}` : undefined,
            isSecret: field.type === 'CONCEALED' || field.type === 'PASSWORD',
          });
        }
      }
      
      // Process sections
      for (const section of item.sections || []) {
        for (const field of section.fields || []) {
          const key = this.config.fieldMapping?.[field.label] || field.label;
          const value = field.value || '';
          
          if (value) {
            entries.push({
              key,
              value,
              comment: `1Password section: ${section.label}, field: ${field.label}`,
              isSecret: field.type === 'CONCEALED' || field.type === 'PASSWORD',
            });
          }
        }
      }
      
      // Apply transformations
      const transformed = transformKeys(entries, this.config.transform);
      const filtered = filterEntries(transformed, this.config.include, this.config.exclude);
      
      const secretsFile: SecretsFile = {
        format: SecretFormat.DOTENV,
        path: `1password:${this.config.vault || 'default'}/${item.title}`,
        entries: filtered,
        metadata: {
          source: '1password',
          environment: this.config.environment,
          lastModified: new Date().toISOString(),
        },
      };
      
      return { success: true, data: secretsFile };
    } catch (error) {
      return { success: false, error: `Failed to read from 1Password: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async write(_secrets: SecretsFile): Promise<AdapterResult> {
    // Write not implemented for 1Password via CLI (complex)
    return { 
      success: false, 
      error: 'Write to 1Password not supported via CLI. Use 1Password UI or API.' 
    };
  }
  
  async listEnvironments(): Promise<AdapterResult<string[]>> {
    if (!this.initialized) {
      return { success: false, error: 'Adapter not initialized' };
    }
    
    try {
      const vaults = await this.listVaults();
      if (!vaults.success) return { success: false, error: vaults.error };
      
      const envs = (vaults.data || []).map(v => v.name);
      return { success: true, data: envs };
    } catch (error) {
      return { success: false, error: `Failed to list vaults: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }
  
  async getMetadata(): Promise<AdapterResult<Record<string, unknown>>> {
    try {
      const vaults = await this.listVaults();
      return {
        success: true,
        data: {
          vaults: vaults.data?.length || 0,
          authenticated: true,
        },
      };
    } catch {
      return { success: true, data: { authenticated: false } };
    }
  }
  
  private async checkCLI(): Promise<boolean> {
    try {
      const result = await this.runOp(['--version']);
      return result.success;
    } catch {
      return false;
    }
  }
  
  private async listVaults(): Promise<AdapterResult<Array<{ id: string; name: string }>>> {
    const result = await this.runOp(['vault', 'list', '--format=json']);
    if (!result.success) return { success: false, error: result.error };
    return { success: true, data: JSON.parse(result.data!) };
  }
  
  private async listItems(vault?: string): Promise<AdapterResult<Array<{ id: string; title: string }>>> {
    const args = ['item', 'list', '--format=json'];
    if (vault) args.push('--vault', vault);
    const result = await this.runOp(args);
    if (!result.success) return { success: false, error: result.error };
    return { success: true, data: JSON.parse(result.data!) };
  }
  
  private runOp(args: string[]): Promise<{ success: boolean; data?: string; error?: string }> {
    return new Promise((resolve) => {
      const proc = spawn('op', args, { 
        env: { ...process.env, OP_ACCOUNT: this.config.account },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, data: stdout.trim() });
        } else {
          resolve({ success: false, error: stderr.trim() || `Exit code ${code}` });
        }
      });
      
      proc.on('error', (error) => {
        resolve({ success: false, error: error.message });
      });
    });
  }
}

/**
 * Factory function for 1Password adapter
 */
export function createOnePasswordAdapter(config: AdapterConfig): Adapter {
  return new OnePasswordAdapter(config as OnePasswordAdapterConfig);
}