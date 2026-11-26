# Install envsync

## Requirements

- Node.js **20 or newer**
- macOS, Linux, or Windows

## Install from npm

```bash
npm install -g @arv.fazriansyah/envsync
envsync --version
```

Or run it without installing:

```bash
npx @arv.fazriansyah/envsync --help
```

## Activate a license

A license key is issued with your purchase and shown on your LemonSqueezy receipt.

```bash
envsync license activate ABCD-1234-EFGH-5678
envsync license status
```

Activation is per machine. Use `--name` to label the machine:

```bash
envsync license activate ABCD-1234-EFGH-5678 --name "work-laptop"
```

To free the seat again:

```bash
envsync license deactivate
```

## Free tier vs paid

| Feature | Free | Paid |
| --- | --- | --- |
| `dotenv` adapter (local `.env` files) | Yes | Yes |
| `encrypt`, `decrypt`, `keygen`, `validate`, `doctor` | Yes | Yes |
| Dry-run sync | Yes | Yes |
| Apply sync to cloud adapters (Doppler, GitHub Actions, Vercel, 1Password) | No | Yes |
| Team vault (planned) | No | Yes |

Dry runs never require a license, so you can evaluate the tool before buying.

## Using a license in CI

Set the key and the instance id from the machine where you activated it:

```bash
export ENVSYNC_LICENSE_KEY="ABCD-1234-EFGH-5678"
export ENVSYNC_LICENSE_INSTANCE_ID="<instance id from envsync license status>"
```

The CLI validates the key once and then trusts the local cache for **7 days**, so
short network outages do not break a pipeline. Set `ENVSYNC_LICENSE_KEY` in your
CI secret store, never in the repository.

## Where the license is cached

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\envsync\license.json` |
| Linux | `$XDG_CONFIG_HOME/envsync/license.json` (default `~/.config/envsync/license.json`) |
| macOS | `~/.config/envsync/license.json` |

The file is written with `0600` permissions where the platform supports it.

## Verify the installation

```bash
envsync doctor
envsync validate
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No license found` | Run `envsync license activate <key>` |
| `License is offline and the 7-day grace period is over` | Connect to the network and run `envsync license status` |
| `activation limit reached` | Deactivate an unused machine or upgrade the seat count |
| `Unknown adapter type` | The adapter is not implemented yet; see `envsync list-adapters` |
