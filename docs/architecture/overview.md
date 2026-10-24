# my-websearch Architecture Overview

`my-websearch` is a combined MCP server, one-shot CLI and local HTTP daemon over one shared runtime. This document describes the current layout and invariants; historical migration phases are not maintained here.

## Shape

```text
                +----------------------+
                |   Core APIs          |
                | search/fetch/validate|
                +----------+-----------+
                           |
                +----------v-----------+
                | Shared Runtime /     |
                | Service Container    |
                | config/state/cache   |
                | browser lifecycle    |
                +-----+-----------+----+
                      |           |
          +-----------v--+     +--v----------------+
          | MCP Adapter  |     | Local HTTP Adapter|
          | stdio/http   |     | localhost service |
          +-----------+--+     +--+----------------+
                      |           |
                  MCP clients     | localhost HTTP
                                  |
                         +--------v--------+
                         | CLI Control     |
                         | search/fetch/...|
                         | serve/status    |
                         +--------+--------+
                                  |
                    skill prefers CLI/daemon, keeps MCP compatibility
```

## Layering

| Layer | Location | Owns |
| :--- | :--- | :--- |
| Core | `src/core/` | search pipeline, fetch pipeline, validation, logging, errors, cache |
| Engines | `src/engines/` | per-provider HTTP/parse/format implementations |
| Runtime | `src/runtime/` | dependency wiring, config, shared services |
| Adapters | `src/adapters/` | MCP stdio/HTTP transports, request middleware |
| Tools | `src/tools/handlers/` | MCP schemas, argument normalization, result mapping |
| CLI | `src/cli/` | command dispatch and machine-readable output |
| Utilities | `src/utils/` | proxy, Playwright session, timeouts, shared helpers |

## Invariants

- Core owns business behavior; adapters only translate transport.
- MCP and local HTTP share the same runtime/services.
- CLI is a control surface, not a second business implementation.
- `--json` writes machine-readable output to stdout; diagnostics/logs go to stderr.
- Engine implementations stay behind the registry; adding an engine touches definitions/registry/tests/docs, not the pipeline.

## Source-of-truth documents

- [CLI JSON protocol](./cli-json-protocol.md)
- [Local HTTP adapter](./local-http-adapter.md)
- [Core runtime and adapters](./core-runtime-adapters.md)
- [HTTP API](../http-api.md)
- [Troubleshooting](../ops/troubleshooting.md)
