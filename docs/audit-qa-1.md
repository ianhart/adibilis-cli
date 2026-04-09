# QA-1 Audit Report: adibilis-cli

**Date:** 2026-04-09
**Scope:** Test quality, test coverage, critical path validation, smoke testing

---

## 1. Existing Test Analysis

**File:** `tests/cli.test.js` -- 27 tests across 7 describe blocks.

### Test classification

| Describe Block         | Type       | Count | Mocks API? | Notes |
|------------------------|------------|-------|------------|-------|
| `parseSimpleYaml`      | Unit       | 4     | No         | Tests the minimal YAML parser: key-value, lists, comments, empty input. |
| `mergeOptions`         | Unit       | 4     | No         | Tests CLI-over-file precedence, ignore-list splitting, fallback behavior. |
| `getApiKey`            | Unit       | 3     | No         | Tests flag > env > stored-key priority. Does NOT mock `readStoredApiKey` filesystem call. |
| `getBaseUrl`           | Unit       | 2     | No         | Tests default URL and env var override. |
| `formatScanJson`       | Unit       | 5     | No         | Tests JSON output structure, rule filtering, fixes embedding. |
| `generateHtmlReport`   | Unit       | 2     | No         | Tests HTML generation and XSS escaping. |
| `createProgram`        | Structural | 2     | No         | Validates commander program has correct commands and scan options. |
| `threshold logic`      | Unit       | 5     | No         | Re-implements `checkThreshold` inline rather than importing the real function. |

**Summary:** All 27 tests are pure unit tests operating on deterministic, in-memory data. There are zero integration tests and zero tests that exercise the actual scan workflow (submit, poll, display). The API layer (`submitScan`, `pollScan`, `fetchFixes`, `fetchReport`, `fetchWithRetry`) is completely untested. No mocking of `fetch` or network calls is present anywhere.

### Weakness in threshold tests

The threshold test block re-implements `checkThreshold` as a local function rather than importing `checkThreshold` from `src/commands/scan.js`. This means the tests verify a copy of the logic, not the actual production code. If the real `checkThreshold` diverges (e.g., the `violationsByImpact` fallback added in scan.js line 151), tests will still pass while production breaks.

---

## 2. Test Coverage Gaps

### Zero-coverage modules, ranked by risk

| Priority | Module / Function | Risk | Why |
|----------|-------------------|------|-----|
| **P0 - Critical** | `src/commands/scan.js` (`scanCommand`, `runJsonScan`, `runTerminalScan`) | **High** | The entire user-facing scan flow: submit, poll, display, threshold exit codes. This is the product's core value. Zero tests. |
| **P0 - Critical** | `src/api.js` (`submitScan`, `pollScan`, `fetchFixes`, `fetchReport`) | **High** | All network I/O. Error handling, retry logic, auth header injection, endpoint branching (authenticated vs. free). Zero tests. |
| **P0 - Critical** | `src/api.js` (`fetchWithRetry`) | **High** | Retry logic for 429/502/503/504 with exponential backoff and Retry-After header parsing. Zero tests. Complex branching. |
| **P1 - High** | `src/commands/scan.js` (`checkThreshold`) -- the REAL function | **High** | Tested only via a copy. The real function has `violationsByImpact` fallback (line 151) that no test covers. |
| **P1 - High** | `src/commands/scan.js` (`isValidUrl`) | **Medium** | URL validation guard. Zero tests. Edge cases (ftp://, javascript:, empty string) untested. |
| **P1 - High** | `src/commands/login.js` (`loginCommand`) | **Medium** | Interactive auth flow: stdin prompt, API validation call, key persistence. Zero tests. |
| **P2 - Medium** | `src/formatters/terminal.js` (all exports) | **Medium** | All 8 terminal formatting functions: `formatHeader`, `formatScanning`, `formatScanComplete`, `formatViolations`, `formatFixSuggestion`, `formatFixes`, `formatReportHint`, `formatError`. Zero tests. |
| **P2 - Medium** | `src/formatters/report.js` (`openReport`) | **Medium** | Writes temp file and spawns browser. `generateHtmlReport` is tested but `openReport` is not. |
| **P2 - Medium** | `src/config.js` (`loadConfig`, `writeDefaultConfig`) | **Low-Med** | Filesystem operations: read .adibilis.yml, create default config. `parseSimpleYaml` and `mergeOptions` are tested but the I/O wrappers are not. |
| **P3 - Low** | `src/api.js` (`saveApiKey`, `readStoredApiKey`) | **Low** | Filesystem config persistence. Low complexity but involves `chmod` and `mkdirSync`. |
| **P3 - Low** | `src/formatters/report.js` (`escapeHtml`) | **Low** | Tested indirectly via `generateHtmlReport` XSS test. |

### Coverage estimate

- **Lines with any test coverage:** ~25-30% (config parsing, JSON formatter, HTML generator, program structure)
- **Lines with zero coverage:** ~70-75% (all command handlers, all API functions, all terminal formatters, all I/O)
- **Branch coverage:** Significantly lower; many conditional paths (auth vs. free, retry vs. no-retry, JSON vs. terminal mode) are completely untested.

---

## 3. Critical Path Test Scenarios

### Scenario 1: First Run (no API key, no config file)

**Preconditions:** No `~/.adibilis/config.json`, no `ADIBILIS_API_KEY` env var, no `.adibilis.yml` in cwd.

| # | Step | Expected |
|---|------|----------|
| 1 | `adibilis scan https://example.com` | Uses unauthenticated endpoint `/scan` (not `/scans`) |
| 2 | `submitScan` sends POST to `/scan` with `{ url }` only (no auth header) | Response includes `scanId` |
| 3 | `pollScan` polls `/scan/{scanId}` (no auth header) | Eventually returns `status: completed` |
| 4 | Terminal output shows header, violations summary, report hint | No crash, no "undefined" in output |
| 5 | Exit code is 0 | No threshold flag, so always 0 |
| 6 | Verify no API key warning is printed | Warning only shows when `--api-key` flag is used |

### Scenario 2: Scan Success (authenticated, terminal mode)

**Preconditions:** Valid API key in env or stored. Target URL is accessible.

| # | Step | Expected |
|---|------|----------|
| 1 | `adibilis scan https://example.com` | Uses authenticated endpoint `/scans` with Bearer token |
| 2 | Spinner shows "Submitting scan..." then "Scanning page..." | `onProgress` callback updates spinner |
| 3 | Poll completes with `status: completed` | Spinner shows checkmark "Scan complete" |
| 4 | Output includes pass rate, violation counts, top 10 issues | Violations sorted by severity then count |
| 5 | Report hint printed | Shows `adibilis scan <url> --report` |
| 6 | Fix suggestion printed if `fixesAvailable > 0` | Shows count and `--fix` command |
| 7 | Exit code 0 | No threshold flag |

### Scenario 3: Scan Failure (API error, network error, scan status=failed)

| # | Sub-scenario | Expected |
|---|--------------|----------|
| 1 | Network timeout / DNS failure | Spinner fails, `formatError` prints message, exit code 1 |
| 2 | API returns 401 Unauthorized | Error message from `data.error` or "HTTP 401", exit code 1 |
| 3 | API returns 429 Too Many Requests | `fetchWithRetry` retries up to 3 times with backoff; if still 429, throws |
| 4 | API returns 500 | Not in RETRYABLE_STATUSES -- fails immediately with "HTTP 500" |
| 5 | Poll returns `status: failed` | Spinner fails, prints `result.errorMessage`, exit code 1 |
| 6 | Poll timeout (>120s) | Throws "Scan timed out after 2 minutes", exit code 1 |
| 7 | Invalid JSON response | Throws "Invalid JSON response from server (HTTP {status})" |
| 8 | `--json` mode error | Outputs `{"error": "..."}` to stderr, exit code 1 |

### Scenario 4: Auth Expired / Invalid API Key

| # | Step | Expected |
|---|------|----------|
| 1 | Stored key is expired/revoked | `submitScan` gets 401 response |
| 2 | Error propagates through `scanCommand` | In terminal: spinner fails + error message. In JSON: `{"error":"..."}` to stderr. |
| 3 | `adibilis login` with bad key | API validation call to `/scans/usage` returns non-ok; prints "Invalid API key", exit 1 |
| 4 | `adibilis login` with valid key | Saves to `~/.adibilis/config.json` with mode 0o600, prints plan name |
| 5 | Subsequent scan uses new key | `readStoredApiKey` reads from config file |

### Scenario 5: CI Mode (`--json` + exit codes)

| # | Step | Expected |
|---|------|----------|
| 1 | `adibilis scan <url> --json` | Outputs valid JSON to stdout (parseable by `jq`), no ANSI codes, no spinner output |
| 2 | JSON includes `url`, `status`, `passRate`, `violations`, `rules` | All fields present and correctly typed |
| 3 | `--json --threshold serious` with 0 serious/critical | Exit code 0 |
| 4 | `--json --threshold serious` with 2 serious violations | Exit code 1 |
| 5 | `--json --threshold critical` with serious but no critical | Exit code 0 (only checks critical) |
| 6 | `--json --fix` | JSON includes `fixes` object with `totalPatches` and patches array |
| 7 | `--json --ignore color-contrast` | `rules` array excludes `color-contrast` |
| 8 | Error in `--json` mode | stderr gets `{"error":"..."}`, stdout is empty, exit code 1 |

---

## 4. Test Run Results

```
$ npm test

> adibilis@1.0.0 test
> vitest run

 RUN  v2.1.9 /Users/joyhart/Dev/Claude-Code/Adibilis/adibilis-cli

 ✓ tests/cli.test.js (27 tests) 8ms

 Test Files  1 passed (1)
      Tests  27 passed (27)
   Start at  00:44:13
   Duration  253ms (transform 24ms, setup 0ms, collect 50ms, tests 8ms, environment 0ms, prepare 30ms)
```

**Result:** All 27 tests pass. No failures, no warnings, no flaky tests. Run time is 253ms total (8ms for tests themselves).

**Note:** The fast run time (8ms for 27 tests) confirms these are pure unit tests with no I/O, no network mocking, and no async waits.

---

## 5. Manual Smoke Test Results

### `node bin/adibilis.js --help`

**Result:** SUCCESS. Outputs correct usage info with version flag, three commands (scan, login, init), and help command. No crash.

### `node bin/adibilis.js scan --help`

**Result:** SUCCESS. Shows all 8 scan options: `--fix`, `--report`, `--json`, `--threshold`, `--api-key`, `--pages`, `--ignore`, `--config`. No crash.

### `node bin/adibilis.js` (no arguments)

**Result:** SUCCESS. Prints usage info and exits with code 1. Commander's default behavior for missing command. Reasonable UX.

### `node bin/adibilis.js scan not-a-url`

**Result:** SUCCESS. Prints `Error: Invalid URL. Only http:// and https:// URLs are allowed.` to stderr and exits with code 1. The `isValidUrl` guard works correctly.

### `node bin/adibilis.js login --help`

**Result:** SUCCESS. Shows login help.

### `node bin/adibilis.js init --help`

**Result:** SUCCESS. Shows init help.

**Overall smoke test verdict:** The CLI boots, parses arguments, validates input, and displays help correctly. No crashes, no unhandled exceptions, no missing dependencies.

---

## 6. Regression Risks

### High fragility areas

1. **`src/api.js` -- fetchWithRetry loop logic**: The retry loop has subtle edge cases (off-by-one on MAX_RETRIES, Retry-After header parsing, the `for` loop returning inside the loop body). Any change to retry behavior has zero test safety net. This code interacts with real network conditions (rate limits, server errors) that are impossible to regression-test manually.

2. **`src/api.js` -- Dual endpoint branching (auth vs. free)**: `submitScan`, `pollScan`, and `fetchReport` all branch on whether an API key is present, selecting different endpoints (`/scans` vs `/scan`). This is tested nowhere. If either endpoint path changes in the API, the wrong branch might silently break while the other works fine.

3. **`src/commands/scan.js` -- process.exit() calls scattered throughout**: The command uses `process.exit()` in at least 6 places. This makes the code hard to test (process.exit kills the test runner unless mocked) and fragile to refactor. Any change to error handling must account for all exit paths.

4. **`src/commands/scan.js` -- threshold logic's `violationsByImpact` fallback**: Line 151 (`const counts = result.violationsByImpact || result`) means threshold checking works differently depending on whether the API returns `violationsByImpact` as a sub-object or flat fields. This branching is untested and a likely source of bugs if the API response shape changes.

5. **`src/config.js` -- parseSimpleYaml**: This is a hand-rolled YAML parser. While tested for the happy paths, it will break silently on real-world YAML features users might expect (nested objects, quoted strings with colons, multi-line values, anchors). Any `.adibilis.yml` that deviates from flat key-value + simple lists will produce incorrect/empty results with no error.

6. **`src/formatters/terminal.js` -- chalk dependency**: All terminal formatting relies on chalk with hardcoded color methods including `.bgHex()` and `.hex()`. If chalk's API changes (it has had major breaking changes between v4 and v5), every formatter function breaks. None of these functions have tests.

7. **`src/commands/login.js` -- readline + fetch with no abstraction**: The login command mixes I/O (readline) with network calls (fetch) with filesystem writes (saveApiKey) in a single 40-line function. It is untestable without significant mocking and any refactor risks breaking the interactive flow.

### Specific regression traps

- **`fetchWithRetry` returns `undefined` on final retry**: If the final retry (attempt === MAX_RETRIES) still gets a retryable status, the function returns the response. But if somehow the loop exits without returning (logic bug), it returns `undefined`, which will cause `submitScan` to crash on `res.json()`. This edge case needs a test.

- **`pollScan` silently swallows fetch errors**: Lines 117-119 catch fetch errors and just retry after delay, with no limit on how many consecutive fetch errors can occur before the 2-minute timeout. This could mask real connectivity issues from the user.

- **No version pinning between CLI and API**: The CLI hardcodes API endpoint paths (`/scans`, `/scan`, `/scans/{id}/fixes`). There is no API version header or contract. If the API adds versioning, the CLI will break with no clear error.

---

## Summary

The adibilis-cli has a solid foundation: clean ESM architecture, good separation of concerns, and working unit tests for parsing/formatting. However, the test suite covers only the periphery (config parsing, JSON/HTML formatting, program structure) while the entire critical path -- submit scan, poll results, handle errors, output to terminal, exit with correct codes -- has **zero automated test coverage**. The most dangerous gap is the complete absence of tests for `src/api.js` and `src/commands/scan.js`, which together represent the product's core functionality and contain the most complex branching logic.
