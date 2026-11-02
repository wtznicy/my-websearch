# Workflow

## Adding a new engine

1. Add the implementation under `src/engines/<engine>/` as a concrete module (e.g. `src/engines/foo/foo.ts`). Do **not** add a barrel `index.ts`: the 1.3.11 cleanup deleted all of them, so every consumer imports the concrete file (and tests would import a second, separate module instance).
2. Record the engine facts in `src/engines/definitions.ts` (`ENGINE_DEFINITIONS`): `region`, `category`, and `proxyInChina` / `proxyRequiredInChina` when the API is directly reachable from mainland China or unusable without a proxy.
3. Register the executor in `src/engines/registry.ts` (`ENGINE_REGISTRY`): `name`, `label`, `aliases`, `region`, `cascade` priorities, `supportsNativeSite`, `supportsPlaywright`, `defaultTimeoutMs`, `probeUrl`, `execute` (plus `resetHealth` if the engine keeps module-level breaker/cache state).
4. Add the id to `SUPPORTED_SEARCH_ENGINES` (`src/engines/registry.ts`) and to `validSearchEngines` + the `AppConfig.defaultSearchEngine` union in `src/config.ts`.
5. Add engine coverage in `src/test/vitest/` (alias normalization, parser, and cascade/routing expectations) and run `npm run check:ci`.
6. Update `README.md` and `README-zh.md` (engine table, engine count, env var tables).

`src/tools/setupTools.ts` only wires the five MCP tool handlers; adding an engine never touches it.

## Networking conventions

- Use `buildAxiosRequestOptions()` for Axios requests.
- Do not let individual engines drift into separate proxy behavior.
- Keep request headers intentional and minimal.
- Browser fallback should remain explicit and testable.
- If a change only affects parsing logic, avoid widening it into a shared networking refactor.

## Documentation sync

Update these together when behavior changes:
- `README.md`
- `README-zh.md`
- package scripts if a new test or workflow is added

If a change only affects docs or tests, avoid touching MCP tool contracts or shared networking code.
