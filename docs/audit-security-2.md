# Security Audit — adibilis-cli

**Auditor:** Security-2  
**Date:** 2026-04-09  
**Scope:** All source files in `adibilis-cli/` — authentication, network, error handling, supply chain, secure defaults  
**Verdict:** Ship with two required fixes (S-01, S-02). Remaining items are low-risk hardening.

---

## 1. Authentication Flow

### How it works

The CLI uses **API-key-only** authentication. There is no username/password flow, no JWT, no OAuth, no token refresh.

1. `adibilis login` prompts for a raw API key via readline (`src/commands/login.js:8-12`).
2. The key is validated by calling `GET /scans/usage` with `Authorization: Bearer <key>` (`login.js:22-23`).
3. On success, the key is persisted to `~/.adibilis/config.json` via `saveApiKey()` (`src/api.js:31-35`).
4. On every subsequent command, the key is resolved by `getApiKey()` in order: CLI flag > `ADIBILIS_API_KEY` env var > stored file (`api.js:16-19`).

### Token refresh / expiry

There is none. The API key is a long-lived secret. If the server revokes or rotates the key, every CLI command will fail with a generic "Invalid API key" or HTTP error — the CLI does not detect expiry, prompt for re-authentication, or attempt refresh.

### Assessment

- **Good:** The `~/.adibilis/` directory is created with mode `0o700` and the config file with `0o600` (`api.js:32-34`). This limits read access to the owning user.
- **Good:** `scan.js:38-43` warns when `--api-key` is passed on the command line, advising env var or `login` instead.
- **Acceptable for v1:** API-key auth is standard for developer CLIs (Stripe, Vercel, Netlify). No immediate blocker.

---

## 2. HTTPS Enforcement

### Default

The hardcoded base URL is HTTPS:

```js
const DEFAULT_BASE_URL = 'https://adibilis-api-production.up.railway.app';
// src/api.js:5
```

### Override risk (Finding S-01 — SHIP BLOCKER)

The base URL can be overridden via environment variable with **no protocol validation**:

```js
export function getBaseUrl() {
  return process.env.ADIBILIS_API_URL || DEFAULT_BASE_URL;
}
// src/api.js:12-14
```

Setting `ADIBILIS_API_URL=http://evil.example.com` would send the API key in cleartext over the network. There is no check that the override uses `https://`.

**Recommendation:** Add a guard in `getBaseUrl()`:

```js
export function getBaseUrl() {
  const url = process.env.ADIBILIS_API_URL || DEFAULT_BASE_URL;
  if (!url.startsWith('https://')) {
    throw new Error(
      'ADIBILIS_API_URL must use https://. ' +
      'Set ADIBILIS_ALLOW_HTTP=1 to override (NOT recommended).'
    );
  }
  return url;
}
```

This still permits an escape hatch for local development while defaulting to safe behavior.

### Certificate validation

Node.js validates TLS certificates by default. The codebase does not set `NODE_TLS_REJECT_UNAUTHORIZED=0` or pass `rejectUnauthorized: false` anywhere. This is correct.

---

## 3. Error Information Leakage

### What errors expose

Errors from the API are surfaced to the user in two patterns:

**Pattern A — server `error` field forwarded directly:**
```js
const message = data.error || `HTTP ${res.status}`;
throw new Error(message);
// src/api.js:87-88, also api.js:132
```

Whatever the server puts in `data.error` is printed to the terminal. If the backend returns debug info, stack traces, or internal paths in its error responses, the CLI will display them verbatim.

**Pattern B — network errors forwarded:**
```js
console.log(chalk.red(`  ✘ Could not connect to Adibilis API: ${err.message}`));
// src/commands/login.js:37
```

Node.js network errors can include hostnames and IP addresses (e.g., `ECONNREFUSED 127.0.0.1:3000`), but this is acceptable for a developer CLI — the user needs to know what failed.

### Assessment

- The CLI itself does not add sensitive context to errors (no stack traces, no API key echo).
- The JSON error output is clean: `JSON.stringify({ error: err.message })` (`scan.js:70`).
- The HTML report uses `escapeHtml()` for all interpolated values (`report.js:112-118`), preventing XSS in generated reports.
- **Low risk.** The main concern is the server side leaking too much in `data.error`, which is outside CLI scope.

---

## 4. Supply Chain Risk

### Dependency inventory

Production dependencies from `package.json`:

| Package | Purpose | Weekly npm downloads | Risk |
|---------|---------|---------------------|------|
| `chalk@^5` | Terminal color output | ~250M | Very low — widely used, ESM-only |
| `commander@^12` | CLI argument parsing | ~130M | Very low — maintained by TJ/community |
| `ora@^8` | Terminal spinner | ~30M | Low — maintained by Sindre Sorhus |
| `node-fetch@^3` | HTTP client | ~60M | Low — well-known polyfill |

**Total production deps: 4.** This is an excellent minimal surface.

### Potential interception vectors

- `node-fetch` handles all HTTP traffic. A supply chain compromise of `node-fetch` could intercept the `Authorization` header containing the API key. Mitigated by the package's maturity, but `package-lock.json` should be committed and integrity hashes verified.
- `chalk` and `ora` are output-only and do not touch network or credentials. Zero interception surface.
- `commander` parses `argv` including `--api-key`. A compromise could exfiltrate it, but this is an extremely unlikely vector for a package at this adoption level.

### Recommendation

- Ensure `package-lock.json` is committed and that CI uses `npm ci` (not `npm install`) to enforce exact versions.
- Consider replacing `node-fetch` with Node.js built-in `fetch` (available since Node 18 LTS). The codebase already uses `fetch()` directly in `login.js:22` and `api.js:154`, suggesting the global `fetch` is being used for some calls while `node-fetch` is declared as a dependency. **Verify whether `node-fetch` is actually imported anywhere or is a dead dependency.**

---

## 5. Ship Blockers

### S-01: ADIBILIS_API_URL override allows HTTP downgrade (HIGH)

**File:** `src/api.js:12-14`  
**Risk:** API key sent in cleartext if a user or CI pipeline sets `ADIBILIS_API_URL` to an `http://` URL.  
**Fix:** Validate protocol in `getBaseUrl()`. Require `https://` unless an explicit escape-hatch env var is set.

### S-02: API key passed via --api-key flag is visible in process list (MEDIUM)

**File:** `src/cli.js:21` — `.option('--api-key <key>', ...)`  
**Symptom:** Running `adibilis scan https://example.com --api-key sk_live_abc123` exposes the key in `ps aux`, shell history, and any process monitoring.  
**Current mitigation:** A warning is printed (`scan.js:39-42`), but only after the key has already been passed.  
**Fix:** The warning is helpful but not sufficient for a ship blocker. Consider either:  
  (a) Accepting `--api-key-file <path>` as a safer alternative (reads from file at runtime), or  
  (b) Documenting prominently that `--api-key` is for CI only and that `ADIBILIS_API_KEY` or `adibilis login` are the recommended paths.  
  The current warning text is adequate for v1 as long as README/docs make this clear. **Downgraded to advisory if docs address it.**

---

## 6. Secure Defaults

| Behavior | Default | Secure? | Notes |
|----------|---------|---------|-------|
| API URL | `https://...railway.app` | Yes | HTTPS hardcoded |
| Config file perms | `0o600` / dir `0o700` | Yes | Correct for secrets |
| Auth method | API key stored locally | Yes | Standard pattern |
| URL validation | `http:` and `https:` accepted for *scan targets* | Acceptable | Scanning `http://` sites is a valid use case |
| API URL override | No protocol check | **No** | See S-01 |
| Error output | `err.message` only | Yes | No stack traces or keys leaked |
| JSON mode | Clean structured output | Yes | No internal details |
| Report HTML | All values escaped | Yes | No XSS |
| TLS cert validation | Node.js default (strict) | Yes | Not overridden |
| Retry on 429/5xx | Exponential backoff with `Retry-After` | Yes | Respects server signals |
| Poll timeout | 2 minutes | Yes | Prevents infinite loops |

### Summary

The CLI defaults to secure behavior in almost every case. The single exception is the unvalidated `ADIBILIS_API_URL` override (S-01). Everything else — file permissions, HTTPS, error sanitization, HTML escaping, retry behavior — follows best practices.

---

## Additional Observations

1. **`node-fetch` may be unused.** The codebase calls `fetch()` (global) everywhere — `api.js:42`, `login.js:22`, `api.js:154`, `api.js:174`. If the target Node.js version is 18+, `node-fetch` can be removed from dependencies entirely, eliminating one supply chain surface.

2. **Config file not encrypted.** The API key is stored as plaintext JSON in `~/.adibilis/config.json`. This is standard for CLIs (AWS, Vercel, Stripe all do the same), but worth noting. The `0o600` permission is the correct mitigation.

3. **No input length limits.** The URL passed to `submitScan()` is validated for protocol but not for length. An extremely long URL could be used to abuse the API, but this is a server-side concern.

4. **`writeDefaultConfig` does not sanitize `dir` parameter.** `config.js:87` joins `dir || process.cwd()` without path traversal checks. Since `dir` is not user-controllable from CLI flags (the `init` command calls `writeDefaultConfig()` with no arguments), this is not exploitable in practice.

5. **Report temp file path is predictable.** `report.js:94` uses `Date.now()` for the temp file name. On a shared system this could theoretically allow a symlink attack, but the file contains no secrets (only scan results), making this negligible risk.
