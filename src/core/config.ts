import { z } from 'zod';
import { SecretFormat } from './secrets.js';

/**
 * Supported secret sources/destinations
 */
export enum AdapterType {
  DOTENV = 'dotenv',
  ONEPW = '1password',
  DOPPLER = 'doppler',
  INFISICAL = 'infisical',
  GITHUB_ACTIONS = 'github-actions',
  GITHUB_CODESPACES = 'github-codespaces',
  VERCEL = 'vercel',
  NETLIFY = 'netlify',
  RAILWAY = 'railway',
  RENDER = 'render',
  FLY_IO = 'fly.io',
  CLOUDFLARE_PAGES = 'cloudflare-pages',
  CLOUDFLARE_WORKERS = 'cloudflare-workers',
  AWS_PARAMETER_STORE = 'aws-parameter-store',
  AWS_SECRETS_MANAGER = 'aws-secrets-manager',
  AZURE_KEY_VAULT = 'azure-key-vault',
  GCP_SECRET_MANAGER = 'gcp-secret-manager',
  KUBERNETES = 'kubernetes',
  DOCKER = 'docker',
}

/**
 * Base adapter configuration (without type - added by extended schemas)
 */
export const BaseAdapterConfigSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  environment: z.string().optional(),
  // Filter which secrets to sync (glob patterns)
  include: z.array(z.string()).default(['*']),
  exclude: z.array(z.string()).default([]),
  // Transform keys (prefix, suffix, case)
  transform: z.object({
    prefix: z.string().default(''),
    suffix: z.string().default(''),
    uppercase: z.boolean().default(false),
    lowercase: z.boolean().default(false),
  }).default({}),
});

export type BaseAdapterConfig = z.infer<typeof BaseAdapterConfigSchema>;

/**
 * 1Password CLI adapter config
 */
export const OnePasswordAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  type: z.literal(AdapterType.ONEPW),
  vault: z.string().optional(),
  item: z.string().optional(),
  account: z.string().optional(),
  // Field mapping: 1Password field name -> env var name
  fieldMapping: z.record(z.string()).optional(),
});
export type OnePasswordAdapterConfig = z.infer<typeof OnePasswordAdapterConfigSchema>;

/**
 * Doppler adapter config
 */
export const DopplerAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  type: z.literal(AdapterType.DOPPLER),
  token: z.string().optional(), // Can also use DOPPLER_TOKEN env
  project: z.string(),
  config: z.string().default('dev'),
});
export type DopplerAdapterConfig = z.infer<typeof DopplerAdapterConfigSchema>;

/**
 * Infisical adapter config
 */
export const InfisicalAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  type: z.literal(AdapterType.INFISICAL),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  projectId: z.string(),
  environment: z.string().default('dev'),
  siteUrl: z.string().default('https://app.infisical.com'),
});
export type InfisicalAdapterConfig = z.infer<typeof InfisicalAdapterConfigSchema>;

/**
 * GitHub Actions adapter config
 */
export const GitHubActionsAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  type: z.literal(AdapterType.GITHUB_ACTIONS),
  token: z.string().optional(), // GITHUB_TOKEN
  repo: z.string(), // owner/repo
  environment: z.string().optional(),
  // 'repository' | 'environment' | 'organization'
  level: z.enum(['repository', 'environment', 'organization']).default('repository'),
  organization: z.string().optional(),
});
export type GitHubActionsAdapterConfig = z.infer<typeof GitHubActionsAdapterConfigSchema>;

/**
 * Vercel adapter config
 */
export const VercelAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  type: z.literal(AdapterType.VERCEL),
  token: z.string().optional(),
  projectId: z.string(),
  teamId: z.string().optional(),
  // 'production' | 'preview' | 'development'
  target: z.enum(['production', 'preview', 'development']).default('production'),
});
export type VercelAdapterConfig = z.infer<typeof VercelAdapterConfigSchema>;

/**
 * Netlify adapter config
 */
export const NetlifyAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  type: z.literal(AdapterType.NETLIFY),
  token: z.string().optional(),
  siteId: z.string(),
  // 'production' | 'branch' | 'deploy-preview'
  context: z.enum(['production', 'branch', 'deploy-preview']).default('production'),
  branch: z.string().optional(),
});
export type NetlifyAdapterConfig = z.infer<typeof NetlifyAdapterConfigSchema>;

/**
 * .env file adapter config
 */
export const DotenvAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  type: z.literal(AdapterType.DOTENV),
  path: z.string().default('.env'),
  format: z.nativeEnum(SecretFormat).default(SecretFormat.DOTENV),
  // Create backup before write
  backup: z.boolean().default(true),
  // File permissions
  mode: z.number().default(0o600),
});
export type DotenvAdapterConfig = z.infer<typeof DotenvAdapterConfigSchema>;

/**
 * Docker adapter config
 */
export const DockerAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  type: z.literal(AdapterType.DOCKER),
  composeFile: z.string().default('docker-compose.yml'),
  service: z.string().optional(),
  // Write to .env file for docker-compose --env-file
  envFile: z.string().default('.env.docker'),
});
export type DockerAdapterConfig = z.infer<typeof DockerAdapterConfigSchema>;

/**
 * Kubernetes adapter config
 */
export const KubernetesAdapterConfigSchema = BaseAdapterConfigSchema.extend({
  type: z.literal(AdapterType.KUBERNETES),
  namespace: z.string().default('default'),
  secretName: z.string(),
  // 'secret' | 'configmap'
  kind: z.enum(['secret', 'configmap']).default('secret'),
  kubeconfig: z.string().optional(),
  context: z.string().optional(),
});
export type KubernetesAdapterConfig = z.infer<typeof KubernetesAdapterConfigSchema>;

/**
 * Union of all adapter configs
 */
export const AdapterConfigSchema = z.discriminatedUnion('type', [
  DotenvAdapterConfigSchema,
  OnePasswordAdapterConfigSchema,
  DopplerAdapterConfigSchema,
  InfisicalAdapterConfigSchema,
  GitHubActionsAdapterConfigSchema,
  VercelAdapterConfigSchema,
  NetlifyAdapterConfigSchema,
  DockerAdapterConfigSchema,
  KubernetesAdapterConfigSchema,
  // Add more as implemented
]);

export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;

/**
 * Sync operation configuration
 */
export const SyncConfigSchema = z.object({
  // Source adapter (read from)
  source: z.string(),
  // Destination adapters (write to)
  destinations: z.array(z.string()).min(1),
  // Conflict resolution strategy
  conflict: z.enum(['source-wins', 'dest-wins', 'merge', 'prompt', 'skip']).default('prompt'),
  // Dry run by default
  dryRun: z.boolean().default(true),
  // Create backup before write
  backup: z.boolean().default(true),
  // Validate secrets before sync
  validate: z.boolean().default(true),
});

export type SyncConfig = z.infer<typeof SyncConfigSchema>;

/**
 * Team vault configuration
 */
export const TeamVaultConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Path to team vault file (encrypted)
  path: z.string().default('.envsync.vault'),
  // Team members' public keys
  members: z.array(z.object({
    name: z.string(),
    email: z.string().email(),
    publicKey: z.string(),
    role: z.enum(['admin', 'member', 'viewer']).default('member'),
  })).default([]),
  // Rotation policy
  rotation: z.object({
    enabled: z.boolean().default(false),
    intervalDays: z.number().default(90),
    notifyBeforeDays: z.number().default(7),
  }).default({}),
});

export type TeamVaultConfig = z.infer<typeof TeamVaultConfigSchema>;

/**
 * Main configuration file schema
 */
export const ConfigSchema = z.object({
  version: z.number().default(1),
  // Project metadata
  project: z.object({
    name: z.string(),
    description: z.string().optional(),
  }).optional(),
  // Adapters configuration
  adapters: z.record(AdapterConfigSchema).default({}),
  // Sync operations
  sync: z.record(SyncConfigSchema).default({}),
  // Team vault
  team: TeamVaultConfigSchema.default({}),
  // Global settings
  settings: z.object({
    // Default conflict resolution
    defaultConflict: z.enum(['source-wins', 'dest-wins', 'merge', 'prompt', 'skip']).default('prompt'),
    // Auto-save on sync
    autoSave: z.boolean().default(false),
    // Verbose output
    verbose: z.boolean().default(false),
    // Color output
    color: z.boolean().default(true),
    // Check for updates
    checkUpdates: z.boolean().default(true),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Default configuration
 */
export const defaultConfig: Config = {
  version: 1,
  project: { name: 'envsync' },
  adapters: {},
  sync: {},
  team: { enabled: false, path: '.envsync.vault', members: [], rotation: { enabled: false, intervalDays: 90, notifyBeforeDays: 7 } },
  settings: { defaultConflict: 'prompt', autoSave: false, verbose: false, color: true, checkUpdates: true },
};

/**
 * Config file paths (in order of precedence)
 */
export const CONFIG_PATHS = [
  '.envsync.json',
  '.envsync.yaml',
  '.envsync.yml',
  'envsync.config.json',
  'envsync.config.yaml',
  'envsync.config.yml',
  '.config/envsync.json',
  '.config/envsync.yaml',
];

/**
 * Validate and parse config
 */
export function parseConfig(config: unknown): Config {
  return ConfigSchema.parse(config);
}

/**
 * Merge configs (later overrides earlier)
 */
export function mergeConfigs(...configs: Partial<Config>[]): Config {
  let merged = { ...defaultConfig };
  for (const config of configs) {
    merged = deepMerge(merged, config);
  }
  return merged;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}