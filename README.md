# envsync

**Universal environment secrets sync** — Encrypted, git-friendly, multi-platform.

Sync your environment variables and secrets between local `.env` files, 1Password, Doppler, GitHub Actions, Vercel, Netlify, and more. Built with age encryption for secure team sharing.

## Features

- 🔐 **Age encryption** — Modern, simple, secure encryption for team sharing
- 🔄 **Multi-platform sync** — Local → 1Password → Doppler → GitHub → Vercel → Netlify
- 📁 **Git-friendly** — Encrypted vaults safe to commit, `.env` files stay out of git
- ⚙️ **Declarative config** — Define adapters and sync operations in JSON/YAML
- 🔍 **Dry-run by default** — Preview changes before applying
- 🎯 **Conflict resolution** — Source-wins, dest-wins, merge, prompt, skip
- 🔧 **Key transformation** — Prefix, suffix, case conversion per adapter
- 📦 **Node CLI** — `npm install -g envsync`, works on macOS, Linux, Windows

## Quick Start

```bash
# Install
npm install -g envsync
# or: curl -fsSL https://envsync.dev/install.sh | sh

# Initialize config
envsync init

# Generate encryption keys for team sharing
envsync keygen

# Add adapters
envsync add-adapter --type dotenv --name local
envsync add-adapter --type doppler --name doppler-dev --project my-project --config dev
envsync add-adapter --type github-actions --name github --repo owner/repo

# Sync (dry run first)
envsync sync full-sync

# Actually apply
envsync sync full-sync --no-dry-run
```

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

## Supported Adapters

| Adapter | Type | Read | Write | Auth |
|---------|------|------|-------|------|
| Local `.env` | `dotenv` | ✅ | ✅ | No |
| 1Password | `1password` | ✅ | ❌ | `op` CLI |
| Doppler | `doppler` | ✅ | ✅ | Token |
| GitHub Actions | `github-actions` | ✅ | ✅ | `GITHUB_TOKEN` |
| Vercel | `vercel` | ✅ | ✅ | Token |

*Planned: Netlify, AWS Parameter Store, Kubernetes, Infisical, Cloudflare, Railway, Render, Fly.io, Azure Key Vault, GCP Secret Manager*

## Encryption

Uses [age](https://age-encryption.org/) — a modern, simple encryption tool:

- **Public keys** (age1...) — Safe to share, used for encryption
- **Private keys** (AGE-SECRET-KEY-...) — Keep secure, used for decryption
- **Team vault** — Encrypted file committed to git, decryptable by team members

```bash
# Generate keys
envsync keygen

# Encrypt .env for team
envsync encrypt -i .env -r age1xxx -r age1yyy -o .env.age

# Decrypt (with your private key)
envsync decrypt -i .env.age -k private.key -o .env
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | Create initial config |
| `keygen` | Generate age key pair |
| `encrypt` | Encrypt .env for recipients |
| `decrypt` | Decrypt age file |
| `sync` | Execute sync operation |
| `add-adapter` | Add adapter to config |
| `list-adapters` | List available adapters |
| `validate` | Validate config |
| `doctor` | Check system requirements |
| `license` | Activate, check, and deactivate your license |

## CI/CD Integration

### GitHub Actions

```yaml
- uses: actions/setup-node@v4
- run: npm install -g envsync
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

## License

envsync is commercial software. The `dotenv` adapter and the encryption helpers are\nfree to use; cloud adapters (Doppler, GitHub Actions, Vercel, 1Password) require\nan active license. See [LICENSE](./LICENSE) and [docs/INSTALL.md](./docs/INSTALL.md).\n\n## Pro Version\n\nTeam vault, priority support, and managed hosting available at\n[envsync.dev](https://envsync.dev).