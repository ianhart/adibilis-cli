# QA Audit 2 -- Edge Cases, Interaction Bugs, and Real-World Testing

**Scope:** adibilis-cli v1.0.0  
**Date:** 2026-04-09  
**Auditor:** QA-2  
**Files reviewed:** `bin/adibilis.js`, `src/cli.js`, `src/commands/scan.js`, `src/commands/login.js`, `src/commands/init.js`, `src/api.js`, `src/config.js`, `src/formatters/terminal.js`, `src/formatters/json.js`, `src/formatters/report.js`, `tests/cli.test.js`, `package.json`

---

## 1. Input Edge Cases (URL Handling)

### 1.1 No URL Argument

Commander's `<url>` syntax makes the argument required. Tested result:

```
$ node bin/adibilis.js scan
error: missing required argument 'url'
EXIT CODE: 1
```

**Verdict:** PASS. Commander handles this gracefully before scanCommand is entered.

### 1.2 URL Without https://

```
$ node bin/adibilis.js scan not-a-url
Error: Invalid URL. Only http:// and https:// URLs are allowed.
EXIT CODE: 1
```

**Verdict:** PASS. The `isValidUrl()` function on line 19 of scan.js correctly rejects non-URL strings. Also tested `ftp://example.com` -- correctly rejected.

### 1.3 URL With Special Characters (Query Strings, Fragments, Encoded Spaces)

```
$ node bin/adibilis.js scan 'https://example.com/page?q=hello%20world&lang=en#section'
```

Scan accepted and completed successfully. URL passed to API as-is.

**Verdict:** PASS. No client-side mangling.

### 1.4 URL That Is an IP Address

```
$ node bin/adibilis.js scan 'https://192.168.1.1'
Scan failed
  Scanning private/internal IP addresses is not allowed
EXIT CODE: 1
```

**Verdict:** PASS. The API server rejects private IPs. However, note that the CLI itself does no client-side validation of private/reserved IPs. The protection is entirely server-side. If the server were slow to respond, the CLI would wait up to 2 minutes before timing out.

### 1.5 Localhost URL

```
$ node bin/adibilis.js scan 'http://localhost:3000'
Scan failed
  Scanning internal/localhost addresses is not allowed
EXIT CODE: 1
```

**Verdict:** PASS (server-side). Same caveat as IP addresses -- no client-side check.

**BUG-QA2-001 (Low):** The CLI passes `isValidUrl()` for localhost and private IPs because http:// and https:// checks pass. Adding client-side rejection of localhost/private-range IPs would give faster feedback and reduce unnecessary API calls.

### 1.6 Extremely Long URL (2000+ characters)

```
$ node bin/adibilis.js scan 'https://example.com/aaa...aaa' (2000 a's)
```

Scan accepted and completed. The terminal output for `formatReportHint` prints the full 2000+ character URL in the "Full report" hint, making it visually unwieldy.

**BUG-QA2-002 (Low):** No client-side URL length limit. A 2000+ character URL is printed in full in the report hint. Consider truncating displayed URLs beyond ~120 characters, or at least the hint command.

### 1.7 URL With Auth Credentials (user:pass@host)

```
$ node bin/adibilis.js scan 'https://user:pass@example.com/path'
  Scanning https://user:pass@example.com/path...
```

The credentials are displayed in the terminal output and sent to the API in the JSON body.

**BUG-QA2-003 (Medium -- Security):** URLs containing embedded credentials (`user:pass@host`) are:
1. Echoed in plain text to the terminal
2. Sent to the Adibilis API server in the POST body
3. Printed in the report hint at the end

The CLI should strip or warn about userinfo in URLs. At minimum, do not echo credentials.

### 1.8 XSS Payload in URL

```
$ node bin/adibilis.js scan 'https://example.com/<script>alert(1)</script>'
```

Terminal output: The raw `<script>` tag appears in terminal output (harmless in terminal context). The HTML report generator correctly escapes via `escapeHtml()`.

**Verdict:** PARTIAL PASS. Terminal output is not a vector. HTML report escaping is correct. However, the `formatReportHint` prints the raw URL unescaped, which would be a concern if terminal output is piped to an HTML-rendering context.

---

## 2. Output Edge Cases

### 2.1 Zero Violations

Tested with `https://example.com` (which returned 0 violations from API):

```
  Pass Rate: 87.5%    Violations: 0
  ...
  No violations found!
```

**Verdict:** PASS. Clean output. `formatViolations` on line 48 of terminal.js handles null/empty arrays.

### 2.2 Large Number of Violations (10,000+)

Code analysis of `formatViolations` (terminal.js line 67): Only the top 10 violations are displayed. Remaining are summarized as `... and N more issues`. The JSON formatter outputs all violations.

**BUG-QA2-004 (Low):** In JSON mode (`formatScanJson`), all violations are mapped without pagination. If the API returns 10,000 violations, the JSON output could be several MB. No streaming or chunking is used -- `JSON.stringify` builds the entire string in memory. For typical scans this is fine, but extreme cases could cause high memory use.

### 2.3 Violations With Very Long Strings

The terminal formatter prints descriptions verbatim with no truncation or wrapping logic. `chalk` does not handle line wrapping. Very long descriptions would overflow terminal width.

**BUG-QA2-005 (Low):** No text truncation or word-wrap for violation descriptions in terminal mode. Long descriptions will produce ugly single-line output.

### 2.4 Unicode in Violation Text

Code analysis: `escapeHtml()` in report.js only escapes the 5 HTML entities (`& < > " '`). It does not perform any Unicode normalization. The terminal formatter passes strings directly to `chalk`, which handles Unicode correctly.

**Verdict:** PASS for terminal. PASS for HTML report (browsers render Unicode natively).

### 2.5 Null Fields in Scan Results

Code analysis of formatters:
- `scan.passRate ?? 0` -- handles null/undefined (uses nullish coalescing)
- `scan.violations || []` -- handles null
- `v.description || v.help || ''` -- handles null
- `v.nodes?.length || 0` -- handles null
- `scan.url || scan.site?.url || 'Unknown'` -- handles null

**Verdict:** PASS. Null handling is thorough across all formatters.

---

## 3. Config Edge Cases

### 3.1 Corrupted JSON in ~/.adibilis/config.json

The `readStoredApiKey()` function in api.js (line 22-28):

```js
try {
  const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  return data.apiKey || null;
} catch {
  return null;
}
```

**Verdict:** PASS. The try/catch swallows `SyntaxError` from `JSON.parse` and returns null. User proceeds as unauthenticated. No error message shown.

**BUG-QA2-006 (Low):** Silent failure on corrupted config. If a user's config.json is corrupted, they get no warning. They would see unauthenticated behavior without understanding why. Consider logging a dim warning like "Warning: could not read ~/.adibilis/config.json".

### 3.2 Missing Config File

Same code path as above -- `fs.readFileSync` throws `ENOENT`, caught and returns null.

For `.adibilis.yml` project config, `loadConfig()` in config.js (line 23-31) checks `fs.existsSync(filePath)` first and returns `{}` if missing.

**Verdict:** PASS.

### 3.3 Read-Only Filesystem / No Home Directory

`saveApiKey()` in api.js (line 31-35):

```js
fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(CONFIG_FILE, ...);
```

If the filesystem is read-only or `os.homedir()` returns a path that cannot be created, `mkdirSync` or `writeFileSync` will throw. In `loginCommand`, this is inside a try/catch (line 21-38 of login.js), so the error would be caught.

For `initCommand`, `writeDefaultConfig()` is also wrapped in try/catch.

**Verdict:** PASS. Errors are caught and reported.

### 3.4 Custom YAML Config (parseSimpleYaml)

The hand-rolled YAML parser in config.js has limitations:

**BUG-QA2-007 (Medium):** The custom YAML parser (`parseSimpleYaml`) strips comments with a simple regex `/#.*$/`. This breaks values containing `#` characters:

```yaml
url: https://example.com/page#section
```

This would be parsed as `url: https://example.com/page` -- the fragment is silently lost. The regex `rawLine.replace(/#.*$/, '')` on line 43 does not distinguish between comments and `#` within values.

**BUG-QA2-008 (Low):** The YAML parser does not handle quoted strings. A value like `url: "https://example.com"` would include the quotes in the parsed value.

---

## 4. Network Edge Cases

### 4.1 API Unreachable / DNS Failure / TLS Error

The `fetchWithRetry` function in api.js (line 40-58) retries on status codes 429, 502, 503, 504 with up to 3 retries. However, `fetch()` itself throws on network-level failures (DNS, TLS, connection refused). These thrown errors are NOT caught by `fetchWithRetry` -- they propagate up.

In `submitScan`, this thrown error is caught by the caller's try/catch in `runTerminalScan` (line 139-143):

```
spinner.fail('Scan failed');
process.stdout.write(formatError(err.message));
```

In `pollScan`, network-level fetch errors are caught (line 116-120):

```js
try {
  res = await fetchWithRetry(endpoint, { headers });
} catch (err) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  continue;
}
```

**BUG-QA2-009 (Medium):** During polling, network errors are silently swallowed and retried indefinitely until the 2-minute timeout. If DNS fails permanently during polling, the user sees a hanging spinner for up to 2 minutes with no feedback about what's happening. The spinner text stays on "Scanning page..." with no indication of network trouble.

### 4.2 Truncated / Non-JSON Response

In `submitScan`, non-JSON responses are handled (api.js line 80-84):

```js
try {
  data = await res.json();
} catch {
  throw new Error(`Invalid JSON response from server (HTTP ${res.status})`);
}
```

In `pollScan`, non-JSON responses during polling (line 122-127) are silently retried (same pattern as network errors above).

**Verdict:** PARTIAL PASS for submit (good error message), SAME BUG as QA2-009 for poll (silent retry to timeout).

### 4.3 HTTP 429 Rate Limiting

`fetchWithRetry` handles 429 properly:
- Reads `Retry-After` header
- Falls back to 5-second delay if no header
- Retries up to 3 times

**BUG-QA2-010 (Low):** After 3 retries of a 429, `fetchWithRetry` returns the 429 response. In `submitScan`, this leads to `data.error || "HTTP 429"`. The error message does not tell the user they hit a rate limit or to wait. A user-friendly "Rate limit exceeded. Please wait and try again." would be more helpful.

### 4.4 fetchFixes Silent Failure

In `fetchFixes` (api.js line 145-158), if the API returns a non-ok response, it silently returns `null`. The caller in scan.js then calls `formatFixes(null)`, which shows "No auto-fix patches available." This is misleading -- fixes may exist but failed to load.

**BUG-QA2-011 (Low):** `fetchFixes` returns null on error, indistinguishable from "no fixes available". User gets no indication that fix retrieval failed.

---

## 5. Concurrency

### 5.1 Simultaneous Scan Commands

Two concurrent `adibilis scan` commands can run simultaneously without conflict because:
- Each scan creates its own API request and poll loop
- No shared file state is written during scanning
- The only shared file is `~/.adibilis/config.json`, read at startup

**Verdict:** PASS for scanning. No file locking issues.

### 5.2 Simultaneous Login + Scan

If `adibilis login` writes config.json while `adibilis scan` reads it, there is a theoretical TOCTOU race. However, `readStoredApiKey()` reads synchronously in one shot, and `saveApiKey()` writes atomically from Node's perspective (single `writeFileSync` call).

**Verdict:** PASS. Acceptable for a CLI tool.

### 5.3 Simultaneous Init Commands

Two `adibilis init` commands in the same directory would both write `.adibilis.yml`. Last write wins. No corruption risk since it's a full overwrite.

**Verdict:** PASS.

---

## 6. Real Execution Tests

All commands run from `/Users/joyhart/Dev/Claude-Code/Adibilis/adibilis-cli/`.

### 6.1 `node bin/adibilis.js --version`

```
1.0.0
```

**Result:** PASS. Clean version output, exit code 0.

### 6.2 `node bin/adibilis.js scan` (no URL)

```
error: missing required argument 'url'
```

**Result:** PASS. Commander rejects missing required arg, exit code 1. Message is clear.

### 6.3 `node bin/adibilis.js scan not-a-url`

```
Error: Invalid URL. Only http:// and https:// URLs are allowed.
```

**Result:** PASS. Custom URL validation catches it, exit code 1. Error message is clear and helpful.

### 6.4 `node bin/adibilis.js scan https://example.com` (no API key)

```
  Adibilis Accessibility Scanner v1.0.0
  Scanning https://example.com...
  Scan complete

  Pass Rate: 87.5%    Violations: 0
  Critical: 0   Serious: 0
  Moderate: 0   Minor: 0

  No violations found!

  Full report:
    adibilis scan https://example.com --report
```

**Result:** PASS. Free-tier scan works. Uses `/scan` endpoint (not `/scans`). Completed in ~5-10 seconds.

### 6.5 `node bin/adibilis.js login` (no args, stdin closed)

With stdin piped from /dev/null:
```
  Enter your Adibilis API key:
```
(Exits with code 0 because readline closes immediately when stdin ends)

With empty string piped:
```
  Enter your Adibilis API key:   No API key provided.
```
Exit code 1.

**BUG-QA2-012 (Medium):** When stdin is /dev/null (e.g., in a CI pipeline or backgrounded process), `readline` resolves immediately with an empty string, but `answer.trim()` returns `""`, which is falsy, so it correctly rejects. However, the exit code is 0 in the /dev/null case because the readline close event fires before the empty-check code path runs. The process exits cleanly without the "No API key provided" message. This is a race condition in the readline behavior when stdin is immediately closed.

### 6.6 `node bin/adibilis.js init`

```
  Created /Users/joyhart/Dev/Claude-Code/Adibilis/adibilis-cli/.adibilis.yml
  Edit this file to customize your accessibility scanning.
```

**Result:** PASS. File created in current directory. Exit code 0.

**Note:** Running `init` a second time silently overwrites the existing file without warning.

**BUG-QA2-013 (Low):** `writeDefaultConfig()` does not check if `.adibilis.yml` already exists. Running `init` twice silently overwrites any customizations the user made.

### 6.7 Additional: `node bin/adibilis.js unknown-command`

```
error: unknown command 'unknown-command'
```

**Result:** PASS. Commander handles unknown commands, exit code 1.

### 6.8 Additional: `node bin/adibilis.js scan https://example.com --threshold invalid`

The scan completed and exited with code 0. The `checkThreshold` function (scan.js line 146-154) returns 0 for unknown threshold values because `THRESHOLD_LEVELS.indexOf('invalid')` returns -1, and the early return on line 148 returns 0.

**BUG-QA2-014 (Medium):** Invalid `--threshold` values are silently accepted. The user thinks they've set a threshold gate, but the check always passes. Should validate that threshold is one of: critical, serious, moderate, minor.

---

## 7. Test Coverage Gaps

The existing test suite (`tests/cli.test.js`) covers:
- YAML parsing (4 tests)
- Option merging (4 tests)
- API key resolution (3 tests)
- Base URL (2 tests)
- JSON formatter (5 tests)
- HTML report generation (2 tests)
- CLI program structure (2 tests)
- Threshold logic (5 tests)

**Missing test coverage:**
1. No integration tests for `scanCommand`, `loginCommand`, `initCommand`
2. No tests for `isValidUrl()` function
3. No tests for `fetchWithRetry` retry logic
4. No tests for `pollScan` timeout behavior
5. No tests for error paths in `submitScan` (non-JSON response, HTTP errors)
6. No tests for terminal formatter edge cases (empty violations, null fields)
7. No tests for `openReport` browser-opening logic
8. No tests for `escapeHtml`

---

## 8. Bug Summary

| ID | Severity | Summary |
|----|----------|---------|
| BUG-QA2-001 | Low | No client-side rejection of localhost/private IPs -- relies entirely on server |
| BUG-QA2-002 | Low | No URL length limit; extremely long URLs produce unwieldy terminal output |
| BUG-QA2-003 | **Medium** | URLs with embedded credentials (`user:pass@host`) are echoed and sent to API |
| BUG-QA2-004 | Low | JSON output has no pagination; 10,000+ violations built fully in memory |
| BUG-QA2-005 | Low | No text truncation for long violation descriptions in terminal mode |
| BUG-QA2-006 | Low | Corrupted `~/.adibilis/config.json` fails silently with no warning |
| BUG-QA2-007 | **Medium** | YAML parser strips `#` fragments from URLs (e.g., `https://site.com/page#section`) |
| BUG-QA2-008 | Low | YAML parser does not handle quoted string values |
| BUG-QA2-009 | **Medium** | Poll-phase network errors silently retry for 2 minutes with no user feedback |
| BUG-QA2-010 | Low | 429 rate limit error message is not user-friendly |
| BUG-QA2-011 | Low | `fetchFixes` failure is indistinguishable from "no fixes available" |
| BUG-QA2-012 | **Medium** | Login with closed stdin (CI/background) exits 0 without error message |
| BUG-QA2-013 | Low | `init` silently overwrites existing `.adibilis.yml` without warning |
| BUG-QA2-014 | **Medium** | Invalid `--threshold` values silently accepted; check always passes |

**Total: 14 issues (4 Medium, 10 Low)**

---

## 9. Recommended Priority Fixes

1. **BUG-QA2-014** -- Validate `--threshold` values. This is a CI/CD correctness issue -- users relying on threshold gates in pipelines would have false confidence.
2. **BUG-QA2-003** -- Strip or warn about userinfo in URLs. Security issue with credential exposure.
3. **BUG-QA2-007** -- Fix YAML parser `#` handling. YAML values with `#` are commonly needed for URL fragments.
4. **BUG-QA2-009** -- Add poll-phase error feedback. Users currently see a frozen spinner for 2 minutes on network failure.
5. **BUG-QA2-012** -- Handle closed-stdin edge case in login for CI environments.
