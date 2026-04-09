# Engineer-2 Audit: adibilis-cli API Integration & Performance

Audited: 2026-04-09
Scope: `adibilis-cli/` -- Node.js CLI calling `api.adibilis.dev`

---

## 1. API Client Audit

### HTTP client

The CLI uses the **native `globalThis.fetch`** (available since Node 18). No import of
`node-fetch` exists anywhere in the source tree -- the dependency in `package.json` (line 16)
is dead weight (see Section 5).

All outgoing requests flow through the helper `fetchWithRetry()` in `src/api.js:40-58`.

### Timeout handling

**No per-request timeout is set.** `fetch()` is called with no `signal` / `AbortController`.
If the server accepts the TCP connection but never responds, every individual fetch call
will hang indefinitely. The poll loop has a *macro* timeout (120 s, line 10-11), but
`fetchWithRetry` itself does not -- a single hung request inside the retry loop will block
for far longer than 120 s before the outer timeout fires.

**Recommendation:** Add an `AbortController` with a 30 s timeout to every `fetch` call:

```js
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30_000);
const response = await fetch(url, { ...options, signal: controller.signal });
clearTimeout(timer);
```

### Retry logic

`fetchWithRetry` (`src/api.js:40-58`) retries on status 429, 502, 503, 504 up to 3 times.

Good:
- Respects `Retry-After` header on 429 (line 50-51).
- Uses exponential backoff for server errors: 1 s, 2 s, 4 s (line 53).

Issues:
- **Network-level errors are not caught.** If `fetch()` itself throws (DNS failure,
  ECONNREFUSED, TLS error), the exception propagates unretried. Only HTTP status codes
  trigger retry. `pollScan` catches network errors in its own loop (line 116-120), but
  `submitScan`, `fetchFixes`, and `fetchReport` do not -- a transient DNS blip during
  submit will crash the CLI.
- **The function can return `undefined`.** If all retries exhaust and the last iteration
  falls through (which cannot actually happen due to the `attempt === MAX_RETRIES` guard,
  but the lack of a final `return response` after the loop makes static analysis tools
  flag it).

### Auth header injection

API key is attached as `Authorization: Bearer <key>` when present (`src/api.js:69, 102, 153`).
The three authenticated functions (`submitScan`, `pollScan`, `fetchFixes`) each build headers
independently with inline logic. This is duplicated across four locations.

**Recommendation:** Extract a shared `authHeaders(apiKey)` helper to centralize auth and
make it trivial to add other headers (e.g., `User-Agent`, `X-Client-Version`) later.

`fetchReport` (`src/api.js:160-184`) and `fetchFixes` (`src/api.js:145-158`) call bare
`fetch()` directly, **bypassing `fetchWithRetry`**. They have zero retry protection.

---

## 2. Scan Polling

### Flow

1. `submitScan` POSTs to `/scans` (authed) or `/scan` (anon) and returns `{ scanId }`.
2. `pollScan` (`src/api.js:94-143`) GETs the scan status in a `while (true)` loop.
3. Exits when `data.status === 'completed'` or `data.status === 'failed'` (line 137).

### Timeout

A hard 120 s timeout exists (constant `POLL_TIMEOUT_MS`, line 10). If exceeded, throws
`'Scan timed out after 2 minutes'`.

### Backoff

**There is no backoff.** The poll interval is a fixed 2 s (`POLL_INTERVAL_MS`, line 9).
For multi-page scans that could take 60+ seconds, this means 30+ redundant GETs against
the API.

**Recommendation:** Use exponential backoff capped at ~10 s:

```js
const delay = Math.min(POLL_INTERVAL_MS * Math.pow(1.5, attempt), 10_000);
```

### Infinite-loop risk

If the API returns a status that is neither `completed`, `failed`, nor an HTTP error
(e.g., `"queued"`, `"unknown"`, or a new status the CLI doesn't know about), the loop
runs until the 120 s timeout. This is acceptable but worth noting -- a `"cancelled"` status
would silently spin.

### Error swallowing during poll

Lines 116-120 and 123-128: if `fetchWithRetry` throws or `res.json()` throws, the error
is silently swallowed and the loop retries after 2 s. This is good for transient network
errors but **bad for persistent parse failures** -- JSON parse errors will repeat every 2 s
for 120 s with no user feedback. The `onProgress` callback (and the spinner in
`scan.js:87-91`) will simply stall.

---

## 3. Response Parsing & Validation

### submitScan (api.js:60-92)

- Wraps `res.json()` in try/catch (line 80-84) -- good.
- Falls back to `data.error || HTTP ${res.status}` for error messages (line 87).
- **Does not validate** that the response contains `scanId`. If the API returns `{}`,
  `submission.scanId` will be `undefined` and `pollScan` will GET `/scans/undefined`.

### pollScan (api.js:94-143)

- Does not validate response shape at all.
- Accesses `data.status` without checking it exists (line 137).
- If `data` is `null` or missing `.status`, the loop continues indefinitely until timeout.

### Formatters

The formatters are defensively coded with fallback chains:

- `scan.url || scan.site?.url || null` (json.js:5, report.js:12)
- `scan.passRate ?? null` / `scan.passRate ?? 0` (json.js:7, report.js:7)
- `v.nodes?.length || 0` (json.js:19, terminal.js:61, report.js:26)
- `v.description || v.help || ''` (json.js:18, terminal.js:73)

This is solid. The main gap is **no schema validation at the API boundary** -- if the
server sends `{ violations: "not-an-array" }`, the `.filter()` call in `json.js:2` and
`terminal.js:52` will throw an unhandled TypeError.

### checkThreshold (scan.js:146-154)

Uses `result.violationsByImpact || result` (line 151), which means it falls back to
reading `result.critical`, `result.serious`, etc. directly from the scan object. This
works because the API embeds those counts at the top level, but it's fragile -- if the
API ever nests them under a key, this breaks silently (returns 0 incorrectly).

---

## 4. Performance

### Blocking operations

- `fs.readFileSync` in `readStoredApiKey` (api.js:24) and `loadConfig` (config.js:30) --
  these are called once at startup, on small files. Acceptable.
- `fs.writeFileSync` in `saveApiKey` (api.js:33) and `writeDefaultConfig` (config.js:88) --
  single calls during login/init. Acceptable.
- `fs.existsSync` in `loadConfig` (config.js:26) -- single call. Acceptable.
- `fs.writeFileSync` in `openReport` (report.js:95) -- writing a temp HTML file
  synchronously. Acceptable for a one-shot CLI.

No unnecessary blocking observed.

### Parallelization opportunities

In `scan.js:106-110`, when `--fix` is requested, `fetchFixes` runs sequentially *after*
the scan completes. Since `fetchFixes` only needs the `scanId` (which is known from
`submitScan`), it could be fired in parallel with the final poll response processing.
However, `fetchFixes` likely requires the scan to be completed server-side, so this is
not a real win.

In `runJsonScan` (scan.js:52-73), the `--fix` fetch is also sequential. Same constraint
applies.

**No meaningful parallelization opportunities exist** given the sequential
submit-then-poll-then-fetch workflow.

---

## 5. Dependency Audit

### Package versions (installed)

| Package | Declared | Installed | ESM-only? | Compatible? |
|---------|----------|-----------|-----------|-------------|
| chalk | ^5.3.0 | 5.6.2 | Yes (v5+) | Yes -- `"type": "module"` is set |
| commander | ^12.0.0 | 12.1.0 | Dual (CJS+ESM) | Yes |
| ora | ^8.0.0 | 8.2.0 | Yes (v8+) | Yes |
| node-fetch | ^3.3.0 | 3.3.2 | Yes (v3+) | Yes, but **unused** |

### node-fetch is dead code

`node-fetch` is **never imported** anywhere in the source tree. The CLI uses the native
`globalThis.fetch` (available since Node 18; project runs on Node 25.6.1). This dependency
should be removed from `package.json` to avoid confusion and reduce install size.

```bash
npm uninstall node-fetch
```

### Version conflicts

No conflicts. All deps are ESM-compatible and the project is `"type": "module"`.

### Missing engine constraint

`package.json` has no `"engines"` field. Since the code relies on native `fetch` (Node 18+)
and top-level ESM, it should declare:

```json
"engines": { "node": ">=18.0.0" }
```

### Dev dependencies

`vitest ^2.1.0` (installed 2.1.x) is appropriate for the test setup.

---

## 6. Config Persistence & API Key Storage

### Storage location

API key is saved to `~/.adibilis/config.json` as:

```json
{ "apiKey": "the-actual-key" }
```

### File permissions

**Good:** The code proactively sets secure permissions:

- Directory: `mode: 0o700` (owner-only rwx) -- `api.js:32`
- File: `chmod 0o600` (owner-only rw) -- `api.js:34`

This is correct and matches the pattern used by SSH, AWS CLI, etc.

### Plaintext storage

The key is stored in **plaintext JSON**. This is standard practice for CLI tools (cf.
`~/.npmrc`, `~/.docker/config.json`, `~/.aws/credentials`). Using the OS keychain
(Keychain on macOS, libsecret on Linux) would be more secure but is not expected at this
stage.

### Key precedence

1. `--api-key` flag (scan.js:21)
2. `ADIBILIS_API_KEY` environment variable (api.js:18)
3. Stored key from `~/.adibilis/config.json` (api.js:19)

This is a sensible hierarchy.

### Security warning

The CLI warns when `--api-key` is passed as a flag (`scan.js:38-42`) since it would
appear in shell history. Good.

### login validation

`login.js:22` validates the key by calling `GET /scans/usage`. This call uses bare
`fetch()` -- no retry, no timeout. A network blip during login will crash with an
unhandled error (caught by the outer try/catch on line 36, but with a generic message).

---

## Summary of Findings

### Critical

| # | Issue | Location |
|---|-------|----------|
| C1 | No per-request timeout -- a hung TCP connection blocks indefinitely | `api.js:42` (`fetchWithRetry`), `api.js:154, 174` (bare fetch calls) |
| C2 | `fetchFixes` and `fetchReport` bypass retry logic entirely | `api.js:154, 174` |

### High

| # | Issue | Location |
|---|-------|----------|
| H1 | `fetchWithRetry` does not retry on network-level errors (DNS, ECONNREFUSED) | `api.js:40-58` |
| H2 | No validation that `submitScan` response contains `scanId` | `api.js:91` |
| H3 | `node-fetch` is a dead dependency -- never imported | `package.json:16` |

### Medium

| # | Issue | Location |
|---|-------|----------|
| M1 | Fixed 2 s poll interval with no backoff wastes API calls | `api.js:9, 141` |
| M2 | JSON parse errors during polling silently loop for 120 s | `api.js:123-128` |
| M3 | No `"engines"` field in package.json despite requiring Node 18+ | `package.json` |
| M4 | Auth header construction duplicated across 4 functions | `api.js:69, 102, 153, 169` |

### Low

| # | Issue | Location |
|---|-------|----------|
| L1 | `checkThreshold` fallback `result.violationsByImpact \|\| result` is fragile | `scan.js:151` |
| L2 | Formatters assume `violations` is an array without type check | `json.js:2`, `terminal.js:52` |
| L3 | Unrecognized scan statuses (e.g., "cancelled") silently poll until timeout | `api.js:137` |
