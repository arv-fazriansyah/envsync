#!/usr/bin/env node

import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { createSyncEngine, executeAllSyncs } from '../core/sync.js';
import { Config, parseConfig, defaultConfig, CONFIG_PATHS, AdapterConfigSchema } from '../core/config.js';
import { adapterRegistry } from '../adapters/index.js';
import { generateAgeKeyPair, encryptForRecipients, decryptWithPrivateKey, EncryptedData } from '../core/crypto.js';
import { parseDotenv, serializeDotenv } from '../core/secrets.js';
import {
  activateLicense,
  clearLicenseCache,
  clearOfflineLicense,
  deactivateLicense,
  getLicenseState,
  maskLicenseKey,
  readLicenseCache,
  resolveLicenseCachePath,
  resolveOfflineLicensePath,
  writeOfflineLicense,
} from '../core/license.js';
import { requiresLicense, adaptersUsedBySyncs } from '../core/license-gate.js';
import {
  buildPayload,
  generateKeyPair,
  issueLicense,
  parseLicense as parseOfflineLicenseFile,
  resolvePublicKey,
  serializeLicense as serializeOfflineLicenseFile,
  verifyLicense as verifyOfflineLicense,
} from '../core/offline-license.js';
import {
  describeWebhookEvent,
  parsePolarWebhookEvent,
  parseWebhookEvent,
  verifyPolarWebhookSignature,
  verifyWebhookSignature,
} from '../core/webhook.js';

const program = new Command();

program
  .name('envsync')
  .description('Universal environment secrets sync - encrypted, git-friendly, multi-platform')
  .version('0.1.0')
  .option('-c, --config <path>', 'Path to config file')
  .option('-v, --verbose', 'Verbose output')
  .option('--no-color', 'Disable colored output')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts() as { verbose?: boolean };
    if (opts.verbose) {
      process.env['ENVSYNC_VERBOSE'] = 'true';
    }
  });

/**
 * Load configuration from file
 */
async function loadConfig(configPath?: string): Promise<Config> {
  const paths = configPath ? [configPath] : CONFIG_PATHS;
  
  for (const path of paths) {
    try {
      const fullPath = resolve(path);
      const content = await readFile(fullPath, 'utf-8');
      const ext = path.split('.').pop()?.toLowerCase();
      
      let parsed: unknown;
      if (ext === 'json') {
        parsed = JSON.parse(content);
      } else if (ext === 'yaml' || ext === 'yml') {
        // Dynamic import for yaml
        const { load } = await import('js-yaml');
        parsed = load(content);
      } else {
        continue;
      }
      
      return parseConfig(parsed);
    } catch {
      // Try next path
    }
  }
  
  // Return default config if none found
  return defaultConfig;
}

/**
 * Save configuration to file
 */
async function saveConfig(config: Config, path: string): Promise<void> {
  const fullPath = resolve(path);
  const ext = path.split('.').pop()?.toLowerCase();
  
  let content: string;
  if (ext === 'json') {
    content = JSON.stringify(config, null, 2);
  } else if (ext === 'yaml' || ext === 'yml') {
    const { dump } = await import('js-yaml');
    content = dump(config);
  } else {
    content = JSON.stringify(config, null, 2);
  }
  
  await writeFile(fullPath, content, 'utf-8');
}

function error(message: string): void {
  console.error(`❌ ${message}`);
}

function success(message: string): void {
  console.log(`✅ ${message}`);
}

function warn(message: string): void {
  console.warn(`⚠️  ${message}`);
}

// ============================================
// COMMANDS
// ============================================

// init - Create initial config
program
  .command('init')
  .description('Create initial configuration file')
  .option('-f, --force', 'Overwrite existing config')
  .option('-o, --output <path>', 'Output path', '.envsync.json')
  .action(async (options) => {
    const outputPath = resolve(options.output);
    
    try {
      await readFile(outputPath, 'utf-8');
      if (!options.force) {
        error(`Config already exists at ${outputPath}. Use --force to overwrite.`);
        process.exit(1);
      }
    } catch {
      // File doesn't exist, continue
    }
    
    const config = {
      ...defaultConfig,
      project: {
        name: 'my-project',
        description: 'Environment secrets sync configuration',
      },
    };
    
    await saveConfig(config, outputPath);
    success(`Created config at ${outputPath}`);
    console.log('\nEdit the config to add your adapters and sync operations.');
    console.log('See https://github.com/envsync/envsync for documentation.');
  });

// keygen - Generate age key pair
program
  .command('keygen')
  .description('Generate age encryption key pair')
  .option('-o, --output <path>', 'Output file for private key')
  .option('--public <path>', 'Output file for public key')
  .action(async (options) => {
    const { publicKey, privateKey } = await generateAgeKeyPair();
    
    console.log('\n🔐 Generated age key pair:\n');
    console.log(`Public key:  ${publicKey}`);
    console.log(`Private key: ${privateKey}\n`);
    
    if (options.output) {
      await writeFile(resolve(options.output), privateKey, 'utf-8');
      success(`Private key saved to ${options.output}`);
    }
    
    if (options.public) {
      await writeFile(resolve(options.public), publicKey, 'utf-8');
      success(`Public key saved to ${options.public}`);
    }
    
    console.log('\n⚠️  Keep your private key secure! Share only the public key.');
  });

// encrypt - Encrypt a .env file
program
  .command('encrypt')
  .description('Encrypt .env file for recipients')
  .requiredOption('-i, --input <path>', 'Input .env file')
  .requiredOption('-r, --recipient <key>', 'Recipient public key (can specify multiple)')
  .option('-o, --output <path>', 'Output file (default: <input>.age)')
  .action(async (options) => {
    const inputPath = resolve(options.input);
    const recipients = Array.isArray(options.recipient) ? options.recipient : [options.recipient];
    const outputPath = options.output ? resolve(options.output) : `${inputPath}.age`;
    
    try {
      const content = await readFile(inputPath, 'utf-8');
      const { entries } = parseDotenv(content);
      const plaintext = serializeDotenv(entries);
      
      const encrypted = await encryptForRecipients(plaintext, recipients);
      
      // Save as JSON with metadata
      await writeFile(outputPath, JSON.stringify(encrypted, null, 2), 'utf-8');
      
      success(`Encrypted ${entries.length} secrets to ${outputPath}`);
      console.log(`Recipients: ${encrypted.recipients.join(', ')}`);
    } catch (err) {
      error(`Encryption failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// decrypt - Decrypt an encrypted file
program
  .command('decrypt')
  .description('Decrypt age-encrypted file')
  .requiredOption('-i, --input <path>', 'Input encrypted file')
  .requiredOption('-k, --key <path>', 'Private key file')
  .option('-o, --output <path>', 'Output .env file')
  .action(async (options) => {
    const inputPath = resolve(options.input);
    const keyPath = resolve(options.key);
    const outputPath = options.output ? resolve(options.output) : inputPath.replace('.age', '.decrypted.env');
    
    try {
      const keyContent = await readFile(keyPath, 'utf-8');
      const encryptedContent = await readFile(inputPath, 'utf-8');
      const encrypted: EncryptedData = JSON.parse(encryptedContent);
      
      const decrypted = await decryptWithPrivateKey(encrypted, keyContent.trim());
      await writeFile(outputPath, decrypted, 'utf-8');
      
      const { entries } = parseDotenv(decrypted);
      success(`Decrypted ${entries.length} secrets to ${outputPath}`);
    } catch (err) {
      error(`Decryption failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// sync - Execute sync operation
program
  .command('sync')
  .description('Execute sync operation(s)')
  .argument('[name]', 'Sync operation name (from config)')
  .option('-a, --all', 'Run all sync operations')
  .option('-d, --dry-run', 'Dry run (default: true)', true)
  .option('--no-dry-run', 'Actually perform the sync')
  .action(async (name, options) => {
    const config = await loadConfig(options.config);
    const dryRun = options.dryRun !== false;

    // Cloud adapters require an active license when changes are applied.
    // Dry runs stay free so people can evaluate before buying.
    if (!dryRun) {
      const syncNames = name && !options.all ? [name] : undefined;
      const usedAdapters = adaptersUsedBySyncs(config, syncNames);
      const requirement = requiresLicense(config, { adapters: usedAdapters });
      if (requirement.required) {
        const state = await getLicenseState();
        if (!state.licensed) {
          error(state.reason || 'A license is required to sync with cloud adapters.');
          console.log(`\n   Adapters that need a license: ${requirement.adapters.join(', ')}`);
          console.log('   Activate with: envsync license activate <key>');
          console.log('   Check status with: envsync license status');
          process.exit(1);
        }
      }
    }
    
    if (dryRun) {
      warn('Running in DRY RUN mode. Use --no-dry-run to apply changes.');
    }
    
    const engine = createSyncEngine(config, { dryRun, verbose: options.verbose });
    
    if (options.all || !name) {
      // Run all syncs
      const reports = await executeAllSyncs(config, { dryRun, verbose: options.verbose });
      
      let totalSynced = 0;
      let totalFailed = 0;
      
      for (const report of reports) {
        console.log(`\n📦 Sync: ${report.operation}`);
        console.log(`   ${report.summary.succeeded}/${report.summary.total} destinations succeeded`);
        console.log(`   ${report.summary.totalSynced} secrets synced`);
        
        totalSynced += report.summary.totalSynced;
        totalFailed += report.summary.failed;
        
        for (const result of report.results) {
          const status = result.success ? '✅' : '❌';
          const mode = result.dryRun ? ' (dry run)' : '';
          console.log(`   ${status} ${result.destination}: ${result.synced} synced${mode}`);
          if (result.errors.length > 0) {
            result.errors.forEach(e => console.log(`      Error: ${e}`));
          }
        }
      }
      
      console.log(`\n📊 Total: ${totalSynced} secrets synced, ${totalFailed} failed`);
      
      if (totalFailed > 0) {
        process.exit(1);
      }
    } else {
      // Run single sync
      try {
        const report = await engine.executeSync(name);
        
        console.log(`\n📦 Sync: ${report.operation}`);
        console.log(`   ${report.summary.succeeded}/${report.summary.total} destinations succeeded`);
        console.log(`   ${report.summary.totalSynced} secrets synced`);
        
        for (const result of report.results) {
          const status = result.success ? '✅' : '❌';
          const mode = result.dryRun ? ' (dry run)' : '';
          console.log(`   ${status} ${result.destination}: ${result.synced} synced${mode}`);
          if (result.errors.length > 0) {
            result.errors.forEach(e => console.log(`      Error: ${e}`));
          }
          if (result.warnings.length > 0) {
            result.warnings.forEach(w => console.log(`      Warning: ${w}`));
          }
        }
        
        if (report.summary.failed > 0) {
          process.exit(1);
        }
      } catch (err) {
        error(`Sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        process.exit(1);
      }
    }
  });

// add-adapter - Add adapter to config
program
  .command('add-adapter')
  .description('Add adapter to configuration')
  .requiredOption('-t, --type <type>', 'Adapter type (dotenv, 1password, doppler, github-actions, vercel)')
  .requiredOption('-n, --name <name>', 'Adapter name')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options) => {
    const configPath = options.config || '.envsync.json';
    const config = await loadConfig(configPath);
    
    // Validate adapter type
    const registeredTypes = adapterRegistry.getRegisteredTypes();
    if (!registeredTypes.includes(options.type)) {
      error(`Unknown adapter type: ${options.type}`);
      console.log(`Available types: ${registeredTypes.join(', ')}`);
      process.exit(1);
    }
    
    // Create minimal config for type
    let adapterConfig: any = { type: options.type, name: options.name };
    
    // Add type-specific defaults
    switch (options.type) {
      case 'dotenv':
        adapterConfig = { ...adapterConfig, path: '.env', backup: true };
        break;
      case '1password':
        adapterConfig = { ...adapterConfig, vault: 'Private' };
        break;
      case 'doppler':
        adapterConfig = { ...adapterConfig, project: 'my-project', config: 'dev' };
        break;
      case 'github-actions':
        adapterConfig = { ...adapterConfig, repo: 'owner/repo', level: 'repository' };
        break;
      case 'vercel':
        adapterConfig = { ...adapterConfig, projectId: 'prj_xxx', target: 'production' };
        break;
    }
    
    // Validate
    const validated = AdapterConfigSchema.parse(adapterConfig);
    config.adapters[options.name] = validated;
    
    await saveConfig(config, configPath);
    success(`Added ${options.type} adapter "${options.name}" to ${configPath}`);
  });

// list-adapters - List available adapters
program
  .command('list-adapters')
  .description('List available adapter types')
  .action(() => {
    const types = adapterRegistry.getRegisteredTypes();
    console.log('\n📦 Available adapters:\n');
    for (const type of types) {
      console.log(`  ${type}`);
    }
    console.log();
  });

// validate - Validate config
program
  .command('validate')
  .description('Validate configuration file')
  .option('-c, --config <path>', 'Config file path')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);
      success('Configuration is valid!');
      console.log(`\nProject: ${config.project?.name || 'unnamed'}`);
      console.log(`Adapters: ${Object.keys(config.adapters).length}`);
      console.log(`Sync operations: ${Object.keys(config.sync).length}`);
    } catch (err) {
      error(`Invalid configuration: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// doctor - Check system requirements
program
  .command('doctor')
  .description('Check system requirements and adapter connectivity')
  .action(async () => {
    console.log('\n🏥 envsync doctor\n');
    
    // Check Node version
    const nodeVersion = process.version;
    console.log(`Node.js: ${nodeVersion} ${nodeVersion >= 'v20.0.0' ? '✅' : '❌ (requires >=20)'}`);
    
    // Check op CLI
    try {
      const { spawn } = await import('node:child_process');
      const opVersion = await new Promise<string>((resolve) => {
        const proc = spawn('op', ['--version']);
        let out = '';
        proc.stdout?.on('data', d => out += d.toString());
        proc.on('close', () => resolve(out.trim()));
        proc.on('error', () => resolve('not found'));
      });
      console.log(`1Password CLI: ${opVersion !== 'not found' ? opVersion + ' ✅' : 'not found ❌'}`);
    } catch {
      console.log('1Password CLI: not found ❌');
    }
    
    // Check config
    try {
      await loadConfig();
      console.log(`Config: found ✅`);
    } catch {
      console.log(`Config: not found ❌`);
    }
    
    console.log('\nRun `envsync validate` to check config validity.');
  });

// license - Manage the paid license
const licenseCommand = program
  .command('license')
  .description('Manage your envsync license');

licenseCommand
  .command('activate <key>')
  .description('Activate a license key on this machine')
  .option('-n, --name <name>', 'Instance name shown in LemonSqueezy', hostname())
  .action(async (key, options) => {
    try {
      const cache = await activateLicense(key, options.name);
      success(`License activated (${maskLicenseKey(cache.key)})`);
      if (cache.customerEmail) console.log(`   Customer: ${cache.customerEmail}`);
      if (cache.variantName) console.log(`   Plan: ${cache.variantName}`);
      console.log(`   Cache: ${resolveLicenseCachePath()}`);
    } catch (err) {
      error(`Activation failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

licenseCommand
  .command('status')
  .description('Show the current license status')
  .action(async () => {
    const state = await getLicenseState();
    const cache = state.cache ?? (await readLicenseCache());

    if (!state.licensed) {
      error(state.reason || 'Not licensed.');
      if (cache) {
        console.log(`   Key: ${maskLicenseKey(cache.key)}`);
        console.log(`   Last validated: ${cache.lastValidatedAt}`);
      }
      console.log('\n   Free tier: dotenv adapters only.');
      console.log('   Activate with: envsync license activate <key>');
      process.exitCode = 1;
      return;
    }

    success(`Licensed${state.source ? ` (${state.source})` : ''}`);
    if (cache) {
      console.log(`   Key: ${maskLicenseKey(cache.key)}`);
      if (cache.variantName) console.log(`   Plan: ${cache.variantName}`);
      console.log(`   Instance: ${cache.instanceName ?? cache.instanceId ?? 'unknown'}`);
      console.log(`   Last validated: ${cache.lastValidatedAt}`);
      if (cache.expiresAt) console.log(`   Expires: ${cache.expiresAt}`);
    }
  });

licenseCommand
  .command('deactivate')
  .description('Deactivate this machine and remove the local license cache')
  .action(async () => {
    const cache = await readLicenseCache();
    if (!cache) {
      warn('No license cache found on this machine.');
      return;
    }

    if (!cache.instanceId) {
      await clearLicenseCache();
      success('Local license cache removed.');
      return;
    }

    try {
      await deactivateLicense(cache.key, cache.instanceId);
      await clearOfflineLicense();
      success('License deactivated on this machine.');
    } catch (err) {
      error(`Deactivation failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

licenseCommand
  .command('webhook')
  .description('Run a local LemonSqueezy webhook receiver (for testing)')
  .option('-p, --port <port>', 'Port to listen on', '8787')
  .option('--provider <provider>', 'Webhook provider (lemonsqueezy or polar)', 'lemonsqueezy')
  .option('-s, --secret <secret>', 'Signing secret (or LEMONSQUEEZY_WEBHOOK_SECRET / POLAR_WEBHOOK_SECRET)')
  .action(async (options) => {
    const provider = String(options.provider || 'lemonsqueezy').toLowerCase();
    const secret =
      options.secret ||
      (provider === 'polar'
        ? process.env['POLAR_WEBHOOK_SECRET']
        : process.env['LEMONSQUEEZY_WEBHOOK_SECRET']);
    if (!secret) {
      error('Webhook signing secret required. Pass --secret or set LEMONSQUEEZY_WEBHOOK_SECRET.');
      process.exit(1);
    }

    const port = Number(options.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      error(`Invalid port: ${options.port}`);
      process.exit(1);
    }

    const { createServer } = await import('node:http');

    const server = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');

        let valid = false;
        if (provider === 'polar') {
          valid = verifyPolarWebhookSignature(
            rawBody,
            {
              'webhook-id': String(req.headers['webhook-id'] ?? ''),
              'webhook-timestamp': String(req.headers['webhook-timestamp'] ?? ''),
              'webhook-signature': String(req.headers['webhook-signature'] ?? ''),
            },
            secret
          );
        } else {
          valid = verifyWebhookSignature(rawBody, String(req.headers['x-signature'] ?? ''), secret);
        }

        if (!valid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid signature' }));
          return;
        }

        try {
          if (provider === 'polar') {
            const event = parsePolarWebhookEvent(rawBody);
            console.log(`[webhook] ${event.type}: ${JSON.stringify(event.data).slice(0, 200)}`);
          } else {
            const event = parseWebhookEvent(rawBody);
            console.log(`[webhook] ${describeWebhookEvent(event)}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'invalid payload' }));
        }
      });
    });

    server.listen(port, () => {
      success(`Webhook receiver listening on http://localhost:${port}`);
      console.log('   Point the LemonSqueezy webhook URL at this address (use a tunnel for local testing).');
    });
  });

// license keygen - generate an Ed25519 key pair for offline licenses
licenseCommand
  .command('keygen')
  .description('Generate an Ed25519 key pair for issuing offline licenses')
  .option('-o, --out <dir>', 'Directory to write the keys into', '.')
  .action(async (options) => {
    try {
      const { publicKey, privateKey } = generateKeyPair();
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');

      await mkdir(options.out, { recursive: true });
      const publicPath = resolve(options.out, 'license.public.pem');
      const privatePath = resolve(options.out, 'license.private.pem');

      await writeFile(publicPath, publicKey, 'utf-8');
      await writeFile(privatePath, privateKey, { encoding: 'utf-8', mode: 0o600 });

      success('Generated license key pair');
      console.log(`   Public key:  ${publicPath}`);
      console.log(`   Private key: ${privatePath}`);
      console.log('');
      console.log('⚠️  Keep license.private.pem secret. Commit license.public.pem (or set ENVSYNC_LICENSE_PUBLIC_KEY).');
      console.log('   Buyers verify against the public key, so it must ship with the CLI you publish.');
    } catch (err) {
      error(`Key generation failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// license issue - sign a license for a buyer (run by the seller after payment)
licenseCommand
  .command('issue')
  .description('Issue a signed offline license for a buyer (seller only)')
  .requiredOption('-k, --key <path>', 'Path to license.private.pem')
  .requiredOption('-e, --email <email>', 'Buyer email')
  .option('-p, --plan <plan>', 'Plan name', 'personal')
  .option('--expires <date>', 'Expiry date (ISO 8601). Omit for lifetime.')
  .option('-o, --out <path>', 'Output license file', 'license.json')
  .action(async (options) => {
    try {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');

      const privateKey = await readFile(resolve(options.key), 'utf-8');
      const payload = buildPayload({
        email: options.email,
        plan: options.plan,
        expiresAt: options.expires ?? null,
      });
      const license = issueLicense(privateKey, payload);

      const outPath = resolve(options.out);
      await writeFile(outPath, serializeOfflineLicenseFile(license), 'utf-8');

      success(`Issued license ${license.payload.id}`);
      console.log(`   Buyer:  ${license.payload.email}`);
      console.log(`   Plan:   ${license.payload.plan}`);
      console.log(`   File:   ${outPath}`);
      console.log('');
      console.log('Send this file to the buyer. They run: envsync license import <file>');
    } catch (err) {
      error(`License issuance failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// license import - install a signed license (run by the buyer)
licenseCommand
  .command('import <file>')
  .description('Import and verify a signed license file')
  .action(async (file) => {
    try {
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');

      const raw = await readFile(resolve(file), 'utf-8');
      const license = parseOfflineLicenseFile(raw);
      const result = verifyOfflineLicense(resolvePublicKey(), license);

      if (!result.valid) {
        error(`License is invalid: ${result.reason}`);
        process.exit(1);
      }

      await writeOfflineLicense(license);
      success('License imported and verified');
      console.log(`   Key:   ${license.payload.id}`);
      console.log(`   Plan:  ${license.payload.plan}`);
      console.log(`   Email: ${license.payload.email}`);
      if (license.payload.expiresAt) console.log(`   Expires: ${license.payload.expiresAt}`);
      console.log(`   Cache: ${resolveOfflineLicensePath()}`);
    } catch (err) {
      error(`Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// license verify - verify a license file without installing
licenseCommand
  .command('verify <file>')
  .description('Verify a signed license file without installing it')
  .action(async (file) => {
    try {
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');

      const raw = await readFile(resolve(file), 'utf-8');
      const license = parseOfflineLicenseFile(raw);
      const result = verifyOfflineLicense(resolvePublicKey(), license);

      if (result.valid) {
        success('License is valid');
        console.log(`   Key:   ${license.payload.id}`);
        console.log(`   Plan:  ${license.payload.plan}`);
        console.log(`   Email: ${license.payload.email}`);
        if (license.payload.expiresAt) console.log(`   Expires: ${license.payload.expiresAt}`);
      } else {
        error(`License is invalid: ${result.reason}`);
        process.exitCode = 1;
      }
    } catch (err) {
      error(`Verification failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}