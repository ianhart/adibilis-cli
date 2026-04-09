# Architect-2 Audit: adibilis-cli

Audit date: 2026-04-09
Scope: Implementability, backwards compatibility, edge cases, complexity budget.

---

## 1. Edge Cases

### Invalid URLs

**Handled.** `src/commands/scan.js:19-26` validates URLs via `new URL()` and rejects anything not `http:` or `https:`. The error message is clear: `"Error: Invalid URL. Only http:// and https:// URLs are allowed."` Exit code 1.

**Gap:** No validation of unreachable domains (e.g., `https://999.999.999.999`). The user gets whatever network error `fetch` throws. This is acceptable for v1, but the error message will be raw and may confuse users. Consider wrapping network-level fetch errors in `api.js:77` with a friendlier message like `"Could not reach <url>. Check the URL and your internet connection."`.

### No Internet / DNS Failure

**Partially handled.** `src/api.js:40-58` (`fetchWithRetry`) retries on 429/502/503/504, but a DNS failure or `ECONNREFUSED` throws a TypeError from `fetch()` that is NOT caught inside `fetchWithRetry`. It bubbles up to the scan command's top-level catch (`scan.js:139`), which prints the raw error message. For `submitScan`, this works because the catch wraps it in `formatError`. But in `pollScan` (`api.js:116-120`), network errors during polling are silently swallowed and retried -- good.

**Bug:** In `submitScan` (`api.js:77`), if the initial `fetchWithRetry` call throws a network error (not an HTTP status), it is NOT caught by the function. It propagates up correctly, but the message will be a raw Node.js error like `"fetch failed"` or `"getaddrinfo ENOTFOUND..."`. The `login` command (`login.js:36-38`) has its own catch that wraps the message with `"Could not connect to Adibilis API: ..."`, which is better.

**Recommendation:** Add a try/catch in `submitScan` around the fetch call to normalize network errors into user-friendly messages.

### API Key Expired / Unauthorized

**Handled.** `api.js:86-89` checks `!res.ok` and throws with `data.error || HTTP ${res.status}`. A 401 or 403 from the server will surface the server's error message. The `login` command (`login.js:26-28`) explicitly checks `!res.ok` and gives a clear `"Invalid API key"` message.

**Gap:** If the API key is expired (vs. invalid), the server presumably returns a different error message. The CLI passes it through verbatim. This is fine -- the server controls the message. But if the server returns a generic 401 with no body, the user sees `"HTTP 401"` with no guidance. Consider appending `"Check your API key with 'adibilis login'."` to 401 errors.

### API Returning 500

**Handled via retry.** `fetchWithRetry` (`api.js:37`) does NOT include 500 in `RETRYABLE_STATUSES` -- only 429, 502, 503, 504. A 500 is treated as a non-retryable error and immediately surfaces the server's error message.

**Recommendation:** 500 is debatable but usually correct to not retry since it may indicate a bug on the server, not a transient issue. Current behavior is fine.

### Empty Scan Results

**Handled.** `formatViolations` (`terminal.js:48-49`) checks for `!violations || violations.length === 0` and prints `"No violations found!"`. `formatScanJson` (`json.js:2`) defaults to empty array. `generateHtmlReport` (`report.js:83`) has a fallback `<tr>` with `"No violations found"`.

**Gap:** If the API returns `violations: null` instead of `violations: []`, the code handles it (via `|| []`). But if the API returns no `violations` field at all, the code also handles it. Good.

### Very Large Scan Results

**Partially handled.** `formatViolations` (`terminal.js:66`) caps terminal display at 10 violations with a `"... and N more issues"` message. Good for terminal output.

**Gap:** `formatScanJson` (`json.js:15`) dumps ALL violations with no cap. For a site with thousands of violations, the JSON output could be very large. This is probably correct for CI consumption, but consider adding a `--limit` flag in the future.

**Gap:** `generateHtmlReport` (`report.js:14-28`) also dumps all violations into the HTML table. A site with 500+ violations will produce a very large HTML file. Low priority for v1.

### Non-Existent Site (404 from Target)

**Handled by the server.** The CLI sends the URL to the API, which runs axe-core. If the target site returns 404, axe-core will still scan the 404 page and report its violations. The CLI does not distinguish between a real page and a 404 page. This is correct behavior -- the API is responsible for this distinction.

### Scan Times Out

**Handled.** `pollScan` (`api.js:111`) has a 120-second timeout (`POLL_TIMEOUT_MS`) and throws `"Scan timed out after 2 minutes"`. Good.

---

## 2. Node.js Compatibility

### Missing `engines` Field

**Bug.** `package.json` has no `engines` field. This CLI uses:
- `"type": "module"` (ESM) -- requires Node >= 12
- Top-level `import` statements -- requires Node >= 13.2 (with `"type": "module"`)
- Global `fetch` (used in `api.js:42`, `login.js:22`, `api.js:154`) -- requires Node >= 18.0 (experimental) or >= 21.0 (stable)
- `node:` protocol imports (`node:fs`, `node:os`, `node:path`, `node:readline`, `node:child_process`) -- requires Node >= 16.0

The effective minimum is **Node >= 18** due to global `fetch`. On Node 16 or 17, the CLI will crash with `"ReferenceError: fetch is not defined"`.

**Recommendation:** Add to `package.json`:
```json
"engines": { "node": ">=18" }
```

### `node-fetch` Dependency is Unused

**Bug.** `package.json` lists `"node-fetch": "^3.3.0"` as a dependency, but NO source file imports it. All fetch calls use the global `fetch`. This is dead weight -- 40+ files in `node_modules/node-fetch/`. Remove it.

### ESM/CJS Compatibility

**Clean.** The entire project is pure ESM with `"type": "module"`. All imports use `.js` extensions. No `require()` calls anywhere. No dual-package hazard.

**Risk:** chalk 5.x and ora 8.x are ESM-only. If anyone tries to `require()` this package from a CJS project, it will fail. This is fine for a CLI tool (not a library).

---

## 3. Cross-Platform (Windows)

### `open` Command for Reports

**Partially handled.** `report.js:97-102` uses platform detection:
- macOS: `open`
- Windows: `start`
- Linux: `xdg-open`

**Bug:** On Windows, `execFile('start', [tmpFile])` will fail. `start` is a `cmd.exe` built-in, not a standalone executable. `execFile` requires an actual executable file path. The fix is to use `execFile` with `cmd.exe` as the executable: `execFile('cmd', ['/c', 'start', '', tmpFile])`. Alternatively, use the `open` npm package which handles all platforms correctly.

### Path Separators

**Clean.** All path construction uses `path.join()` or `path.resolve()` (`config.js:6-7`, `config.js:24`, `config.js:87`, `report.js:94`). No hardcoded `/` separators for filesystem paths.

### Config File Permissions

**Windows issue.** `api.js` line 32-34:
```js
fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(CONFIG_FILE, ..., 'utf-8');
fs.chmodSync(CONFIG_FILE, 0o600);
```
The `mode` parameter and `chmodSync` are no-ops on Windows (NTFS doesn't use Unix permissions). The code won't crash, but the config file containing the API key will have default Windows ACLs, which is less secure. Acceptable for v1 -- document that Windows users should protect `~/.adibilis/config.json` manually.

### Chalk Color Support

**Handled by chalk.** chalk 5.x auto-detects color support via `supports-color`. On Windows Terminal, PowerShell, and modern cmd.exe, colors work. On older cmd.exe without ANSI support, chalk falls back to no color. The `--json` mode bypasses chalk entirely.

### Line Endings

**No issue.** All output uses `\n` via `process.stdout.write` and `console.log`. Terminals on all platforms handle `\n` correctly. The YAML parser (`config.js:42`) splits on `\n`, which will leave `\r` at the end of lines on Windows if the file has CRLF endings. The `trimEnd()` on line 43 handles this.

---

## 4. `npx` Behavior

### Bin Field

**Correct.** `package.json:5-7`:
```json
"bin": { "adibilis": "./bin/adibilis.js" }
```
This maps the command name `adibilis` to the entry point. `npx adibilis scan URL` will work once published to npm.

### Shebang

**Present.** `bin/adibilis.js:1` has `#!/usr/bin/env node`. This is required for Unix/macOS and is present.

**Windows note:** The shebang is ignored on Windows. npm/npx creates a `.cmd` wrapper automatically when installing, so this is fine.

### Executable Permission

**Present.** `bin/adibilis.js` has `-rwxr-xr-x` permissions. Good.

### Package Name

**Risk.** The package is named `"adibilis"` in `package.json`. Before publishing, verify this name is available on npm. If someone has squatted the name, you'll need a scoped package like `@adibilis/cli`.

### First-Run Experience

**Gap.** Running `npx adibilis` with no arguments shows the help text (commander default). Running `npx adibilis scan` with no URL shows commander's default error for missing required argument. Both are acceptable but could be friendlier.

---

## 5. Backwards Compatibility (API Response Changes)

### Defensive Property Access

**Mostly good.** The codebase uses optional chaining and fallbacks extensively:
- `scan.passRate ?? 0` (`terminal.js:26`, `report.js:7`)
- `scan.violations || []` (`terminal.js:48`, `json.js:2`, `report.js:8`)
- `v.nodes?.length || 0` (`terminal.js:61`, `json.js:19`, `report.js:25`)
- `scan.url || scan.site?.url || 'Unknown'` (`report.js:12`) -- handles both old and new API shapes
- `result.fixesAvailable || result.fixes?.patches?.totalPatches || 0` (`scan.js:112`) -- two fallback paths

### Crash Risks from API Changes

**Risk 1: `submission.scanId` undefined.** In `scan.js:55` and `scan.js:85`, the code does `await pollScan(submission.scanId, ...)`. If the API changes the response shape and omits `scanId` (or renames it to `id`), `pollScan` will be called with `undefined`, producing a URL like `/scans/undefined`. The server would return 404, which `pollScan` would surface as `"HTTP 404"`. Not a crash, but a confusing error.

**Recommendation:** After `submitScan`, validate that `submission.scanId` exists:
```js
if (!submission.scanId) {
  throw new Error('API did not return a scan ID');
}
```

**Risk 2: `data.status` check.** `pollScan` (`api.js:137`) checks for `data.status === 'completed' || data.status === 'failed'`. If the API adds a new terminal status (e.g., `'cancelled'`), the poll loop will never exit and will hit the 2-minute timeout. This is safe but slow to fail.

**Risk 3: `res.json()` parse failure.** `api.js:80-84` catches JSON parse failures and throws a clear error. Good. `api.js:124-129` also catches JSON parse failures during polling and retries. Good.

### JSON Output Stability

**Risk.** The JSON output shape (`json.js:4-21`) is implicitly the CLI's public API for CI integrations. Any change to the API's response fields (`passRate`, `critical`, `serious`, etc.) will silently change the JSON output. Consider documenting the JSON schema or adding a `--schema-version` field to the output.

---

## 6. Rate Limiting

### Retry-After Handling

**Handled.** `fetchWithRetry` (`api.js:49-51`) checks for 429 status and reads the `Retry-After` header. If present, it waits that many seconds. If absent, it waits 5 seconds. It retries up to 3 times (`MAX_RETRIES`).

### User-Facing Rate Limit Message

**Gap.** If all 3 retries are exhausted on a 429, `fetchWithRetry` returns the 429 response. Then `submitScan` (`api.js:86-89`) throws `data.error || "HTTP 429"`. If the server includes a message like `"Rate limit exceeded. Upgrade your plan."`, the user sees it. If the server returns a bare 429 with no body, the user sees `"HTTP 429"` -- unhelpful.

**Recommendation:** In `submitScan`, check for 429 specifically and provide a clear message:
```js
if (res.status === 429) {
  throw new Error(
    data.error || 'Rate limit exceeded. Wait a moment or check your plan limits.'
  );
}
```

### Scan Quota Exceeded

**Depends on server.** There is no client-side quota tracking. If the server returns a 402 or 403 with a message like `"Daily scan limit reached"`, the CLI will surface it. If the server returns a generic 403, the user sees `"HTTP 403"`. The CLI has no awareness of plan limits.

**Recommendation:** If the server includes quota information in scan responses (e.g., `scansRemaining: 3`), the CLI could display it. Not critical for v1 but would improve UX.

---

## Summary of Findings by Priority

### Must Fix (Before Publish)

| # | Issue | File:Line | Effort |
|---|-------|-----------|--------|
| 1 | Add `"engines": { "node": ">=18" }` to package.json | `package.json` | 1 min |
| 2 | Remove unused `node-fetch` dependency | `package.json:16` | 1 min |
| 3 | Windows `start` command fails with `execFile` | `report.js:97-102` | 5 min |

### Should Fix (Before v1.1)

| # | Issue | File:Line | Effort |
|---|-------|-----------|--------|
| 4 | Validate `submission.scanId` exists after submit | `scan.js:55,85` | 2 min |
| 5 | Friendlier error for 429 rate limit | `api.js:86` | 5 min |
| 6 | Friendlier error for network failures in `submitScan` | `api.js:77` | 5 min |
| 7 | Append `"try 'adibilis login'"` hint to 401 errors | `api.js:87` | 3 min |

### Nice to Have (v2)

| # | Issue | File:Line | Effort |
|---|-------|-----------|--------|
| 8 | Handle new terminal scan statuses beyond completed/failed | `api.js:137` | 5 min |
| 9 | Document JSON output schema for CI consumers | `json.js` | 30 min |
| 10 | Display remaining quota from API response | `scan.js` | 15 min |
| 11 | Verify `adibilis` npm package name availability | `package.json:2` | 2 min |
