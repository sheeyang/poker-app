# Poker Trainer

## Development setup

Install Node.js 24 or newer and pnpm 11.25.0, then run from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm dev:trainer
```

Open [the Trainer](http://127.0.0.1:5174). The development command starts the API,
Trainer, and managed local PostgreSQL database. No `.env` file or manual database
initialization is required.

Keep the terminal running. Ctrl+C stops the development processes; database data
persists in the ignored `.local/postgres` directory.

## Checks

```powershell
pnpm check
```

See [local development](docs/local-development.md) for additional commands,
configuration, platform support, browser fixtures, and troubleshooting.
