# Architect-1 Audit: adibilis-cli

**Date:** 2026-04-09
**Scope:** Code structure, module architecture, state management, configuration flow, dependency graph

---

## 1. Module Dependency Graph

### Import Map

```
bin/adibilis.js
  -> src/cli.js (run)

src/cli.js
  -> commander (Command)
  -> src/commands/scan.js (scanCommand)
  -> src/commands/login.js (loginCommand)
  -> src/commands/init.js (initCommand)

src/commands/scan.js
  -> ora
  -> src/api.js (submitScan, pollScan, fetchFixes)
  -> src/config.js (loadConfig, mergeOptions)
  -> src/formatters/terminal.js (formatHeader, formatScanning, formatScanComplete, formatViolations, formatFixSuggestion, formatFixes, formatReportHint, formatError)
  -> src/formatters/json.js (formatScanJson)
  -> src/formatters/report.js (openReport)

src/commands/login.js
  -> node:readline (createInterface)
  -> chalk
  -> src/api.js (saveApiKey, getBaseUrl)

src/commands/init.js
  -> chalk
  -> src/config.js (writeDefaultConfig)

src/api.js
  -> node:fs, node:path, node:os
  (no internal imports)

src/config.js
  -> node:fs, node:path
  (no internal imports)

src/formatters/terminal.js
  -> chalk
  (no internal imports)

src/formatters/json.js
  (no imports at all)

src/formatters/report.js
  -> node:fs, node:os, node:path, node:child_process (execFile)
  (no internal imports)
```

### Layering Assessment

The intended layering is: `bin -> cli -> commands -> api/config -> formatters`

**Clean layers, no circular dependencies.** The graph is a clean DAG. No file imports from a higher layer. Formatters have zero internal imports and are pure transformation functions, which is good.

### Cross-Cutting Concern: `saveApiKey` / `getBaseUrl` in api.js

`src/commands/login.js` line 3 imports `saveApiKey` and `getBaseUrl` from `../api.js`. These are config/persistence functions that happen to live in the API module. `saveApiKey` and `readStoredApiKey` (api.js lines 22-34) deal with filesystem config storage (`~/.adibilis/config.json`) while `config.js` deals with project-level YAML config (`.adibilis.yml`). This is a coherence issue:

- **api.js** handles both HTTP transport AND user credential storage
- **config.js** handles only project-level YAML config

**Recommendation:** Extract `saveApiKey`, `readStoredApiKey`, `getApiKey`, `getBaseUrl`, and the `CONFIG_DIR`/`CONFIG_FILE` constants into a dedicated `src/auth.js` module. This would give `api.js` a single responsibility (HTTP calls) and `config.js` a parallel one (project config). `login.js` would then import from `auth.js` instead of `api.js`.

---

## 2. Configuration Flow

### API Key Resolution Order (api.js, `getApiKey`, line 16-19)

1. `--api-key` CLI flag (passed as `flagValue` parameter)
2. `ADIBILIS_API_KEY` environment variable
3. `~/.adibilis/config.json` file (via `readStoredApiKey`)

This three-tier priority is correct and documented in the README.

### Credential Storage Security

**Positive:**
- `saveApiKey` (api.js line 31-34) creates `~/.adibilis/` with mode `0o700` and the config file with `0o600`. This is correct UNIX credential protection.
- scan.js lines 38-43 warn users when they pass `--api-key` via CLI flag (shell history exposure).

**Issues:**

1. **Config file permissions are set on write only.** `readStoredApiKey` (api.js line 22-28) does not verify the file permissions before reading. If a user manually edits the file and changes permissions (or another tool creates it with world-readable permissions), the CLI will happily read it. Low severity, but worth noting.

2. **The API key is stored as plaintext JSON.** This is standard for CLI tools at this scale (similar to `~/.npmrc`), but should be mentioned in security documentation.

3. **The `--api-key` warning has a logic bug.** scan.js line 38:
   ```js
   if (opts.apiKey && cmdOptions.apiKey) {
   ```
   Both conditions check the same thing. `opts.apiKey` is set from `cmdOptions.apiKey` in `mergeOptions` (config.js line 78: `apiKey: cliOptions.apiKey || null`). This condition is functionally `if (cmdOptions.apiKey)`, which is correct but the double-check is redundant dead logic.

### What Happens When Config Is Missing

- **No API key at all:** `getApiKey` returns `null`. `submitScan` (api.js line 68) checks `if (apiKey)` and falls back to the unauthenticated `/scan` endpoint. This is correct -- free-tier scan works without auth.
- **No `.adibilis.yml`:** `loadConfig` (config.js line 23-27) checks `fs.existsSync`, returns `{}` if missing. `mergeOptions` gracefully defaults. No crash.
- **Malformed `.adibilis.yml`:** `parseSimpleYaml` will skip lines it does not understand. It will not throw. However, it silently ignores malformed input with no user feedback -- a user who writes `threshold = serious` (equals instead of colon) gets no warning that the setting was ignored.
- **No `~/.adibilis/config.json`:** `readStoredApiKey` (api.js line 22-28) catches all errors and returns `null`. Clean.

### YAML Parser Limitations (config.js, `parseSimpleYaml`, lines 38-69)

The custom YAML parser is minimal by design but has edge cases:

1. **Values with colons fail.** Input `url: https://example.com` -- the regex on line 55 (`/^(\w[\w_]*):\s*(.+)?$/`) will match, capturing `url` as key and `https://example.com` as value. This actually works because the regex is greedy on the value capture. OK.

2. **Quoted strings are not handled.** `name: "my site"` would store `"my site"` (with quotes). Not a current problem since no string config values are user-facing, but fragile for future extension.

3. **Nested YAML is not supported.** Any future config like `output:\n  format: json` will silently break.

4. **Comment stripping is naive.** Line 43: `rawLine.replace(/#.*$/, '')` will break values containing `#`, e.g., `color: #FF0000`. Not relevant to current config keys, but a latent bug.

---

## 3. Command Architecture

### Current Commands

| Command | File | Purpose |
|---------|------|---------|
| `scan <url>` | src/commands/scan.js | Core scan with all options |
| `login` | src/commands/login.js | Interactive API key entry + validation |
| `init` | src/commands/init.js | Write `.adibilis.yml` template |

### Missing Commands

**Should exist:**

1. **`adibilis status` or `adibilis whoami`** -- Show current auth state (which API key is active, what plan, remaining quota). The login command already calls `/scans/usage` to validate; a standalone command to check auth state without re-entering a key is standard CLI UX. Users need this to debug "why are my scans failing" without re-running login.

2. **`adibilis logout`** -- Delete `~/.adibilis/config.json`. Currently there is no way to de-authenticate short of `rm ~/.adibilis/config.json`. This is a security hygiene gap.

3. **`adibilis config show`** -- Display merged config (resolved from CLI flags, env vars, and `.adibilis.yml`). Useful for debugging when a user thinks their threshold is set but it is being overridden.

**Nice to have (lower priority):**

4. **`adibilis history`** -- List past scans for the authenticated user (if the API supports it).

5. **`adibilis verify <url>`** -- Re-scan and compare against a previous scan to verify fixes were applied.

### Scan Command Structure Assessment

The scan command in `src/commands/scan.js` is well structured with a clean split between `runJsonScan` (CI mode, no spinners, JSON output) and `runTerminalScan` (interactive mode with ora spinners and formatted output). The `checkThreshold` function (line 146-153) is properly extracted and exported for testability.

**Issue: `--fix` flag naming is misleading.** The `--fix` option does not fix anything -- it fetches and displays fix suggestions/patches. This is documented correctly in the README but the flag name itself implies automatic application of fixes. Consider `--show-fixes` or `--patches` to reduce user confusion.

---

## 4. Error Handling

### Async Path Coverage

| Function | File:Line | try/catch | Assessment |
|----------|-----------|-----------|------------|
| `scanCommand` | scan.js:28 | Delegates to `runJsonScan`/`runTerminalScan` | OK, both have try/catch |
| `runJsonScan` | scan.js:52 | Yes, lines 69-72 | Catches all errors, writes JSON error to stderr |
| `runTerminalScan` | scan.js:75 | Yes, lines 139-143 | Catches all errors, stops spinner, writes formatted error |
| `loginCommand` | login.js:5 | Yes, lines 21-38 | Catches network errors |
| `initCommand` | init.js:4 | Yes, lines 5-12 | Catches filesystem errors |
| `submitScan` | api.js:60 | Partial -- see below | |
| `pollScan` | api.js:94 | Yes, lines 116-129 | Catches fetch and JSON parse errors per iteration |
| `fetchFixes` | api.js:145 | **No try/catch** | Caller handles via scan.js line 108 spinner |
| `fetchReport` | api.js:160 | **No try/catch on fetch** | Throws on `!res.ok`, but raw fetch errors propagate |
| `fetchWithRetry` | api.js:40 | **No try/catch** | Network errors propagate unhandled to caller |

### Critical Error Handling Issues

**1. `fetchWithRetry` does not catch network errors (api.js line 40-58)**

`fetchWithRetry` retries on HTTP status codes (429, 502, 503, 504) but does NOT catch `TypeError` or `fetch` rejections (DNS failure, connection refused, network down). A `fetch()` that throws (as opposed to returning a non-ok response) will propagate directly to the caller with no retry.

For `submitScan`, this means a transient DNS failure kills the scan immediately with no retry. For `pollScan`, the outer try/catch on line 116-118 catches it and continues polling, which is correct -- but `submitScan` has no such protection.

**2. `fetchFixes` has no error handling (api.js lines 145-158)**

Line 154: `const res = await fetch(...)` -- if `fetch` itself throws (network error), this propagates. The caller in scan.js line 108 is inside a try block (`runTerminalScan`), so it won't crash the process, but it will abort the entire scan output (spinner.fail, error message, exit 1) when only the fix-fetching step failed. The scan results that were already retrieved are lost.

**3. `fetchReport` is not wrapped with `fetchWithRetry` (api.js line 174)**

`fetchReport` uses raw `fetch` instead of `fetchWithRetry`. Report generation may take time on the server; a 502/503 during report fetch is plausible and should be retried.

**4. `loginCommand` uses raw `fetch` (login.js line 22)**

The login validation call does not use `fetchWithRetry`. A transient 503 during login will show "Invalid API key" (line 28) rather than "network error", which is misleading. The `!res.ok` check on line 26 does not distinguish between 401 (truly invalid key) and 500/502/503 (server error).

### Timeout Handling

- `pollScan` has a 2-minute timeout (api.js line 9, `POLL_TIMEOUT_MS = 120000`). Good.
- `submitScan` has **no timeout** on the initial POST request. A hanging server connection will block forever.
- `fetchFixes` and `fetchReport` have **no timeouts**. Same problem.

**Recommendation:** Use `AbortSignal.timeout()` on all fetch calls:
```js
const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
```

---

## 5. Package.json Health

### Present and Correct
- `name`: "adibilis" -- clean, matches npm convention
- `version`: "1.0.0" -- appropriate for initial release
- `description`: present and accurate
- `bin`: correctly points to `./bin/adibilis.js`
- `type`: "module" -- correct for ESM imports used throughout
- `scripts.test`: "vitest run" -- works
- `keywords`: relevant and complete
- `license`: "MIT"

### Missing Fields

| Field | Severity | Notes |
|-------|----------|-------|
| `engines` | **High** | No Node.js version specified. The codebase uses `fetch` (global, Node 18+), `AbortSignal` (Node 15+), `fs.mkdirSync` with `recursive` (Node 10.12+). Should be `"engines": { "node": ">=18.0.0" }` since global `fetch` is the highest-floor API used. |
| `repository` | Medium | Missing. Needed for npm registry listing and `npm bugs` command. |
| `homepage` | Medium | Missing. Should point to `https://adibilis.com/docs/cli` or similar. |
| `bugs` | Medium | Missing. Should point to GitHub issues URL. |
| `files` | **High** | Missing. Without `files`, `npm publish` includes everything (including `tests/`, `.git/`, etc.). Should be `"files": ["bin/", "src/", "README.md", "LICENSE"]` to ship only the needed files. |
| `author` | Low | Missing. |

### Dependency Analysis

| Package | Declared | Purpose | Assessment |
|---------|----------|---------|------------|
| `chalk` | `^5.3.0` | Terminal colors | OK, ESM-only from v5, matches `"type": "module"` |
| `commander` | `^12.0.0` | CLI framework | OK, current |
| `ora` | `^8.0.0` | Spinners | OK, ESM-only from v6 |
| `node-fetch` | `^3.3.0` | HTTP client | **UNNECESSARY.** Node 18+ has global `fetch`. The codebase does not import `node-fetch` anywhere -- all fetch calls use the global. This is a phantom dependency. |
| `vitest` | `^2.1.0` (dev) | Test runner | OK |

**Recommendation:** Remove `node-fetch` from dependencies. It is declared but never imported. It adds ~300KB to `node_modules` for zero benefit.

### Version Pinning

All dependencies use caret ranges (`^`). This is standard for libraries but risky for a CLI tool that end-users install globally. A breaking change in a minor release of `chalk` or `ora` could break the CLI for users who run `npm install -g adibilis` after the bad version ships.

**Recommendation:** Consider pinning exact versions for `chalk`, `commander`, and `ora` in production, or use a lockfile strategy that ensures deterministic installs for global users.

### Missing: `engines` Field Risk

Without `engines`, a user on Node 16 will install successfully, then get a runtime crash on the first `fetch()` call with an unhelpful `fetch is not defined` error. Adding `"engines": { "node": ">=18.0.0" }` plus `"engineStrict": true` (or npm config) prevents this.

---

## 6. Test Coverage

### What Is Tested (tests/cli.test.js, 293 lines)

| Test Suite | Lines | What It Covers |
|------------|-------|----------------|
| `parseSimpleYaml` | 12-33 | Key-value parsing, list parsing, comments, empty input |
| `mergeOptions` | 38-64 | CLI overrides file config, fallback behavior, ignore string splitting |
| `getApiKey` | 69-96 | Flag priority, env var, null fallback |
| `getBaseUrl` | 100-121 | Default URL, env var override |
| `formatScanJson` | 126-191 | JSON structure, violation counts, rule listing, ignore filtering, fix inclusion |
| `generateHtmlReport` | 196-232 | HTML structure, data embedding, XSS escaping |
| `createProgram` | 237-259 | Command names exist, scan options exist |
| `threshold logic` | 264-293 | Exit code 0/1 for all threshold scenarios |

### Test Quality Assessment

**Positive:**
- Pure function tests are thorough: `parseSimpleYaml`, `mergeOptions`, `formatScanJson`, `checkThreshold` all have good edge-case coverage.
- The HTML XSS test (line 218-231) is smart -- it verifies `escapeHtml` works on URLs containing `<script>`.
- Environment variable tests properly save/restore `process.env` in `afterEach`.

**Issues:**

1. **The threshold test re-implements `checkThreshold` instead of importing it (line 266-272).** The actual `checkThreshold` function is exported from `scan.js` (line 146), but the test creates a local copy. This means the test can pass while the real function is broken. The import should be:
   ```js
   import { checkThreshold } from '../src/commands/scan.js';
   ```

2. **Zero integration/behavioral tests for the scan command.** The most critical code path (`scanCommand` -> `submitScan` -> `pollScan` -> format output) has no test coverage. There are no mocked HTTP calls, no tests for error paths, no tests for the spinner lifecycle.

3. **Zero tests for `loginCommand`.** Interactive readline + fetch + file write -- entirely untested.

4. **Zero tests for `initCommand`.** Filesystem write -- untested.

5. **Zero tests for `fetchWithRetry`.** The retry logic (exponential backoff, Retry-After header parsing, max retries) is complex and completely untested.

6. **Zero tests for `formatViolations` (terminal.js).** The most complex formatter -- sorting, severity badges, truncation to 10 items, ignore filtering -- has no tests.

7. **Zero tests for `formatFixes` (terminal.js).** Complex nested data traversal with plan-limit messaging -- untested.

8. **Zero tests for `openReport` (report.js).** The `execFile` call to open a browser is untested (though difficult to unit test).

9. **`loadConfig` is imported but never tested.** config.js `loadConfig` is imported on line 3 but no test suite exercises it. The filesystem path resolution and `existsSync` check are untested.

### Missing Test Categories

| Category | Priority | What To Test |
|----------|----------|-------------|
| API module (`submitScan`, `pollScan`, `fetchFixes`) | **Critical** | Mock `fetch`, test request formation, auth header inclusion, error responses, retry behavior |
| Scan command integration | **Critical** | Mock API module, test full `scanCommand` flow for both JSON and terminal modes, verify exit codes |
| Error paths | **High** | Network failure, invalid JSON response, 401 auth error, scan timeout, scan status=failed |
| `fetchWithRetry` | **High** | Retry on 429/502/503/504, respect Retry-After header, exponential backoff, max retry limit |
| `loginCommand` | Medium | Mock readline + fetch, test valid/invalid key, network error |
| Terminal formatters | Medium | `formatViolations` sorting/filtering/truncation, `formatFixes` with nested data |
| Config file loading | Medium | `loadConfig` with real temp files, malformed YAML handling |

---

## Summary of Key Findings

### Critical

1. **`fetchWithRetry` does not catch network-level errors** (api.js line 40-58) -- DNS failures, connection refused, etc. bypass the retry mechanism entirely.
2. **No request timeouts** on any fetch call -- a hanging server connection blocks forever.
3. **`node-fetch` is a phantom dependency** -- declared in package.json but never imported. Adds dead weight.
4. **Missing `files` field in package.json** -- `npm publish` will ship test files and everything else.
5. **Missing `engines` field** -- users on Node <18 get an unhelpful crash.

### High

6. **Threshold test uses a re-implemented copy** of `checkThreshold` instead of importing the real function (tests/cli.test.js line 266).
7. **No tests for the API module** -- the most failure-prone layer (HTTP, retries, polling) is completely untested.
8. **`loginCommand` conflates 401 with 5xx errors** -- shows "Invalid API key" for server errors (login.js line 28).
9. **`saveApiKey`/`readStoredApiKey` live in api.js** instead of a dedicated auth module, muddying the single-responsibility of both api.js and config.js.

### Medium

10. **Custom YAML parser has latent bugs** with quoted strings and `#` in values (config.js lines 38-69).
11. **`--fix` flag naming is misleading** -- it shows fix suggestions, it does not apply fixes.
12. **No `logout`, `status/whoami`, or `config show` commands** -- standard CLI UX gaps.
13. **Version string "v1.0.0" is hardcoded in terminal.js line 16** -- should read from package.json.
14. **`fetchReport` and `fetchFixes` do not use `fetchWithRetry`** -- server errors during these calls are not retried (api.js lines 145-184).
