# envsync — Universal Environment Secrets Sync CLI

[![npm version](https://img.shields.io/npm/v/@arv.fazriansyah/envsync.svg)](https://www.npmjs.com/package/@arv.fazriansyah/envsync)
[![npm downloads](https://img.shields.io/npm/dm/@arv.fazriansyah/envsync.svg)](https://www.npmjs.com/package/@arv.fazriansyah/envsync)
[![License](https://img.shields.io/badge/license-commercial-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/arv-fazriansyah/envsync/actions/workflows/ci.yml/badge.svg)](https://github.com/arv-fazriansyah/envsync/actions/workflows/ci.yml)

**envsync** is a Node.js command-line tool to **sync, encrypt, and manage environment variables and secrets** across local `.env` files and cloud platforms — 1Password, Doppler, GitHub Actions, Vercel, and more. Built on [age encryption](https://age-encryption.org/) for secure, git-friendly team sharing.

> Stop copy-pasting `.env` values between services. Define your sync once in JSON/YAML, preview with dry-run, and apply with one command.

**Keywords:** secrets management, environment variables, dotenv sync, .env encryption, age encryption, CLI, devops, config management, secret rotation, 1password, doppler, vercel, github actions.

## Table of Contents

- [Why envsync](#why-envsync)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Supported Adapters](#supported-adapters)
- [Configuration](#configuration)
- [Encryption](#encryption)
- [Commands](#commands)
- [CI/CD Integration](#cicd-integration)
- [Licensing](#licensing)
- [Links](#links)

## Why envsync

- **Scattered secrets** — your `.env` lives locally while Doppler, Vercel, and GitHub Actions each hold their own copy.
- **Manual drift** — updating one place means remembering to update the others.
- **Unsafe sharing** — sending `.env` over chat or email leaks credentials.
- **No audit trail** — who changed what, and when?

envsync solves this with a declarative, encrypted, version-controlled workflow: one source of truth, many destinations, dry-run by default.

## Features

- 🔐 **Age encryption** — modern, simple, secure public-key encryption for team sharing.
- 🔄 **Multi-platform sync** — local `.env` ↔ 1Password, Doppler, GitHub Actions, Vercel, and more.
- 📁 **Git-friendly** — encrypted vaults are safe to commit; raw `.env` files stay out of git.
- ⚙️ **Declarative config** — define adapters and sync operations in `.envsync.json` / `.envsync.yaml`.
- 🔍 **Dry-run by default** — preview every change before it is applied.
- 🎯 **Conflict resolution** — source-wins, dest-wins, merge, prompt, or skip.
- 🔧 **Key transformation** — prefix, suffix, and case conversion per adapter.
- 📦 **Node CLI** — `npm install -g envsync`, works on macOS, Linux, and Windows.
- 🛡️ **Offline licensing** — Ed25519-signed licenses, no runtime dependency on a license server.

## Installation

```bash
# npm (recommended)
npm install -g @arv.fazriansyah/envsync

# or run without installing
npx @arv.fazriansyah/envsync --help

# or the standalone installer
curl -fsSL https://envsync.dev/install.sh | sh
```

Requires Node.js >= 20.0.0.

## Quick Start

```bash
# 1. Initialize a config
envsync init

# 2. Generate an age key pair for team sharing
envsync keygen

# 3. Register adapters
envsync add-adapter --type dotenv --name local
envsync add-adapter --type doppler --name doppler-dev --project my-project --config dev
envsync add-adapter --type github-actions --name github --repo owner/repo

# 4. Preview a sync (dry run)
envsync sync full-sync

# 5. Apply for real
envsync sync full-sync --no-dry-run
```

## Supported Adapters

| Adapter | Type | Read | Write | Auth |
|---------|------|------|-------|------|
| Local `.env` | `dotenv` | ✅ | ✅ | none (free) |
| 1Password | `1password` | ✅ | ❌ | `op` CLI |
| Doppler | `doppler` | ✅ | ✅ | token |
| GitHub Actions | `github-actions` | ✅ | ✅ | `GITHUB_TOKEN` |
| Vercel | `vercel` | ✅ | ✅ | token |

Planned: Netlify, AWS Parameter Store, Kubernetes, Infisical, Cloudflare, Railway, Render, Fly.io, Azure Key Vault, GCP Secret Manager.

> The `dotenv` adapter and encryption helpers are free. Cloud adapters (Doppler, GitHub Actions, Vercel, 1Password) require an active license — see [Licensing](#licensing).

## Configuration

Create `.envsync.json` (or `.envsync.yaml`):

```json
{
  "version": 1,
  "project": { "name": "my-saas" },
  "adapters": {
    "local": {
      "type": "dotenv",
      "name": "local",
      "path": ".env"
    },
    "doppler": {
      "type": "doppler",
      "name": "doppler",
      "project": "my-project",
      "config": "dev"
    },
    "github": {
      "type": "github-actions",
      "name": "github",
      "repo": "owner/repo",
      "level": "repository"
    }
  },
  "sync": {
    "deploy": {
      "source": "local",
      "destinations": ["doppler", "github"],
      "conflict": "source-wins",
      "dryRun": true
    }
  }
}
```

## Encryption

envsync uses [age](https://age-encryption.org/) — a modern, simple encryption tool:

- **Public keys** (`age1...`) — safe to share, used for encryption.
- **Private keys** (`AGE-SECRET-KEY-...`) — keep secure, used for decryption.
- **Team vault** — an encrypted file committed to git, decryptable by any team member holding a private key.

```bash
# Generate keys
envsync keygen

# Encrypt .env for recipients
envsync encrypt -i .env -r age1xxx -r age1yyy -o .env.age

# Decrypt with your private key
envsync decrypt -i .env.age -k private.key -o .env
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | Create an initial config |
| `keygen` | Generate an age key pair |
| `encrypt` | Encrypt a `.env` for recipients |
| `decrypt` | Decrypt an age file |
| `sync` | Execute a sync operation |
| `add-adapter` | Add an adapter to the config |
| `list-adapters` | List available adapters |
| `validate` | Validate the config |
| `doctor` | Check system requirements |
| `license` | Activate, check, and deactivate your license |

## CI/CD Integration

### GitHub Actions

```yaml
- uses: actions/setup-node@v4
- run: npm install -g @arv.fazriansyah/envsync
- run: envsync sync deploy --no-dry-run
  env:
    DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

### Pre-commit Hook

```yaml
# .pre-commit-config.yaml
- repo: local
  hooks:
    - id: envsync-validate
      name: Validate envsync config
      entry: envsync validate
      language: system
```

## Licensing

envsync is commercial software. The `dotenv` adapter and the encryption helpers are free to use; cloud adapters (Doppler, GitHub Actions, Vercel, 1Password) require an active license.

- **Personal** — one-time payment, lifetime license.
- Activate with `envsync license activate <key>`.
- Check status with `envsync license status`.
- Offline Ed25519-signed licenses — no runtime dependency on a license server.

See [LICENSE](./LICENSE) and [docs/INSTALL.md](./docs/INSTALL.md).

## Pro Version

Team vault, priority support, and managed hosting available at [envsync.dev](https://envsync.dev).

## Links

- 📦 npm: https://www.npmjs.com/package/@arv.fazriansyah/envsync
- 🐙 GitHub: https://github.com/arv-fazriansyah/envsync
- 🐛 Issues: https://github.com/arv-fazriansyah/envsync/issues
- 📖 Docs: https://github.com/arv-fazriansyah/envsync#readme
- 💳 Checkout (sandbox): https://polar-webhook.vercel.app/api/create-checkout

---

Made with ❤️ by [Arvib Fazriansyah](https://github.com/arv-fazriansyah). If envsync saves you time, please ⭐ star the repo.