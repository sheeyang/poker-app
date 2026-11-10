# Poker Trainer

[Try the live demo](https://pokertrainer.duckdns.org/).

## Development setup

Install Node.js 24 or newer and pnpm 11.25.0, then run from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm dev:trainer
```

The development command starts the API, the Trainer, and a managed local
PostgreSQL database, and prints the Trainer's address. Every run gets its own
throwaway database and its own free ports, so any number of runs can go at once
without conflict. No `.env` file or manual database initialization is required.

Keep the terminal running. Ctrl+C stops the development processes and removes
the run's database, so each run starts empty. From another terminal,
`pnpm dev:status` lists the runs and `pnpm dev:stop` stops this checkout's runs.


## Checks

```powershell
pnpm check
```

See [local development](docs/local-development.md) for additional commands,
configuration, platform support, browser fixtures, and troubleshooting.
