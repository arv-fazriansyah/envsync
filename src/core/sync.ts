import { adapterRegistry } from '../adapters/index.js';
import { Config, SyncConfig, SecretEntry, SecretsFile, SecretDiff, diffSecrets, computeChecksum, BaseAdapterConfig } from './index.js';

/**
 * Sync operation result
 */
export interface SyncResult {
  success: boolean;
  source: string;
  destination: string;
  synced: number;
  skipped: number;
  errors: string[];
  warnings: string[];
  diff?: SecretDiff;
  dryRun: boolean;
}

/**
 * Full sync report
 */
export interface SyncReport {
  timestamp: string;
  operation: string;
  results: SyncResult[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    totalSynced: number;
    totalSkipped: number;
  };
}

/**
 * Sync engine - orchestrates reading from source and writing to destinations
 */
export class SyncEngine {
  private config: Config;
  private dryRun: boolean;
  private verbose: boolean;
  
  constructor(config: Config, options: { dryRun?: boolean; verbose?: boolean } = {}) {
    this.config = config;
    this.dryRun = options.dryRun ?? true;
    this.verbose = options.verbose ?? false;
  }
  
  /**
   * Execute a named sync operation from config
   */
  async executeSync(syncName: string): Promise<SyncReport> {
    const syncConfig = this.config.sync[syncName];
    if (!syncConfig) {
      throw new Error(`Sync operation not found: ${syncName}`);
    }
    
    // Find the adapter config by name to get its type
    const sourceAdapterConfig = this.config.adapters[syncConfig.source];
    if (!sourceAdapterConfig) {
      throw new Error(`Source adapter config not found: ${syncConfig.source}`);
    }
    
    // Create or get source adapter
    const sourceAdapter = adapterRegistry.create(sourceAdapterConfig.type, sourceAdapterConfig);
    
    await sourceAdapter.initialize(sourceAdapterConfig);
    
    // Test connection
    const sourceTest = await sourceAdapter.testConnection();
    if (!sourceTest.success) {
      throw new Error(`Source connection failed: ${sourceTest.error}`);
    }
    
    this.log(`Reading from source: ${syncConfig.source}`);
    const sourceResult = await sourceAdapter.read();
    
    if (!sourceResult.success || !sourceResult.data) {
      throw new Error(`Failed to read from source: ${sourceResult.error}`);
    }
    
    const sourceSecrets = sourceResult.data;
    this.log(`Read ${sourceSecrets.entries.length} secrets from source`);
    
    // Process each destination
    const results: SyncResult[] = [];
    
    for (const destName of syncConfig.destinations) {
      const destAdapterConfig = this.config.adapters[destName];
      if (!destAdapterConfig) {
        results.push({
          success: false,
          source: syncConfig.source,
          destination: destName,
          synced: 0,
          skipped: 0,
          errors: [`Destination adapter config not found: ${destName}`],
          warnings: [],
          dryRun: this.dryRun,
        });
        continue;
      }
      
      const destAdapter = adapterRegistry.create(destAdapterConfig.type, destAdapterConfig);
      
      const result = await this.syncToDestination(
        sourceSecrets,
        destAdapter,
        destName,
        syncConfig
      );
      results.push(result);
    }
    
    // Generate report
    const report: SyncReport = {
      timestamp: new Date().toISOString(),
      operation: syncName,
      results,
      summary: {
        total: results.length,
        succeeded: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        totalSynced: results.reduce((sum, r) => sum + r.synced, 0),
        totalSkipped: results.reduce((sum, r) => sum + r.skipped, 0),
      },
    };
    
    return report;
  }
  
  /**
   * Sync to a single destination
   */
  private async syncToDestination(
    sourceSecrets: SecretsFile,
    destAdapter: any,
    destName: string,
    syncConfig: SyncConfig
  ): Promise<SyncResult> {
    this.log(`Syncing to destination: ${destName}`);
    
    try {
      // Initialize destination adapter
      const destConfig = this.config.adapters[destName];
      if (!destConfig) {
        return this.createErrorResult(syncConfig.source, destName, `Destination config not found: ${destName}`);
      }
      
      await destAdapter.initialize(destConfig);
      
      // Test connection
      const destTest = await destAdapter.testConnection();
      if (!destTest.success) {
        return this.createErrorResult(syncConfig.source, destName, `Destination connection failed: ${destTest.error}`);
      }
      
      // Read current destination secrets for diff
      let destSecrets: SecretsFile | null = null;
      if (destAdapter.capabilities.read) {
        const destResult = await destAdapter.read();
        if (destResult.success && destResult.data) {
          destSecrets = destResult.data;
        }
      }
      
      // Compute diff
      let diff: SecretDiff | undefined;
      if (destSecrets) {
        diff = diffSecrets(destSecrets.entries, sourceSecrets.entries);
        this.log(`Diff: ${diff.added.length} added, ${diff.modified.length} modified, ${diff.removed.length} removed`);
      }
      
      // Handle conflicts
      let entriesToWrite = sourceSecrets.entries;
      if (destSecrets && diff) {
        entriesToWrite = this.resolveConflicts(diff, syncConfig.conflict);
      }
      
      // Apply destination-specific transforms
      const destAdapterConfig = this.config.adapters[destName] as BaseAdapterConfig;
      if (!destAdapterConfig) {
        return this.createErrorResult(syncConfig.source, destName, `Destination adapter config not found: ${destName}`);
      }
      
       // Filter by include/exclude on source key names first
       const filtered = entriesToWrite.filter(entry =>
         this.matchesPatterns(entry.key, destAdapterConfig.include, destAdapterConfig.exclude)
       );

       // Apply destination-specific transforms
       const transformed = destAdapterConfig.transform
         ? filtered.map(entry => ({
             ...entry,
             key: this.transformKey(entry.key, destAdapterConfig.transform),
           }))
         : filtered;
      
      if (filtered.length !== entriesToWrite.length) {
        this.log(`Filtered: ${entriesToWrite.length} -> ${filtered.length} entries`);
      }
      
      // Create secrets file for destination
      const destSecretsFile: SecretsFile = {
        ...sourceSecrets,
        entries: transformed,
        metadata: {
          ...sourceSecrets.metadata,
          checksum: computeChecksum(transformed),
        },
      };
      
      // Write if not dry run
      if (!this.dryRun && destAdapter.capabilities.write) {
        this.log(`Writing ${transformed.length} secrets to ${destName}`);
        const writeResult = await destAdapter.write(destSecretsFile);
        
        if (!writeResult.success) {
          return this.createErrorResult(syncConfig.source, destName, writeResult.error || 'Write failed');
        }
        
        return {
          success: true,
          source: syncConfig.source,
          destination: destName,
          synced: transformed.length,
          skipped: entriesToWrite.length - filtered.length,
          errors: [],
          warnings: writeResult.warnings || [],
          diff,
          dryRun: false,
        };
      } else {
        this.log(`DRY RUN: Would write ${transformed.length} secrets to ${destName}`);
        return {
          success: true,
          source: syncConfig.source,
          destination: destName,
          synced: 0,
          skipped: 0,
          errors: [],
          warnings: ['Dry run - no changes made'],
          diff,
          dryRun: true,
        };
      }
    } catch (error) {
      return this.createErrorResult(syncConfig.source, destName, error instanceof Error ? error.message : 'Unknown error');
    }
  }
  
  /**
   * Resolve conflicts based on strategy
   */
  private resolveConflicts(diff: SecretDiff, strategy: SyncConfig['conflict']): SecretEntry[] {
    switch (strategy) {
      case 'source-wins':
        return [...diff.added, ...diff.modified.map(m => m.new), ...diff.unchanged];
      
      case 'dest-wins':
        return [...diff.added, ...diff.modified.map(m => m.old), ...diff.unchanged];
      
      case 'merge':
        // For merge, prefer source for modified values, but keep destination-only entries
        return [...diff.added, ...diff.modified.map(m => m.new), ...diff.unchanged, ...diff.removed];
      
      case 'skip':
        // Skip conflicting entries
        return [...diff.added, ...diff.unchanged];
      
      case 'prompt':
      default:
        // In CLI, this would prompt user. For now, default to source-wins
        return [...diff.added, ...diff.modified.map(m => m.new), ...diff.unchanged];
    }
  }
  
  private transformKey(key: string, transform: BaseAdapterConfig['transform']): string {
    let result = key;
    if (transform.prefix) result = transform.prefix + result;
    if (transform.suffix) result = result + transform.suffix;
    if (transform.uppercase) result = result.toUpperCase();
    if (transform.lowercase) result = result.toLowerCase();
    return result;
  }
  
  private matchesPatterns(key: string, include: string[], exclude: string[]): boolean {
    if (include.length > 0 && !include.includes('*')) {
      const matched = include.some(pattern => this.matchPattern(key, pattern));
      if (!matched) return false;
    }
    if (exclude.length > 0) {
      const matched = exclude.some(pattern => this.matchPattern(key, pattern));
      if (matched) return false;
    }
    return true;
  }
  
  private matchPattern(key: string, pattern: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return regex.test(key);
  }
  
  private createErrorResult(source: string, destination: string, error: string): SyncResult {
    return {
      success: false,
      source,
      destination,
      synced: 0,
      skipped: 0,
      errors: [error],
      warnings: [],
      dryRun: this.dryRun,
    };
  }
  
  private log(message: string): void {
    if (this.verbose) {
      console.log(`[sync] ${message}`);
    }
  }
}

/**
 * Create sync engine from config
 */
export function createSyncEngine(config: Config, options?: { dryRun?: boolean; verbose?: boolean }): SyncEngine {
  return new SyncEngine(config, options);
}

/**
 * Execute all sync operations
 */
export async function executeAllSyncs(config: Config, options?: { dryRun?: boolean; verbose?: boolean }): Promise<SyncReport[]> {
  const engine = createSyncEngine(config, options);
  const reports: SyncReport[] = [];
  
  for (const syncName of Object.keys(config.sync)) {
    const report = await engine.executeSync(syncName);
    reports.push(report);
  }
  
  return reports;
}