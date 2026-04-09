# Security Audit Report: adibilis-cli

**Auditor:** Security-1  
**Date:** 2026-04-09  
**Scope:** adibilis-cli/ -- secret handling, injection vectors, dependency security, data exposure  

---

## 1. API Key Storage

### Where and how

The API key is stored as plaintext JSON in `~/.adibilis/config.json`.

- **`src/api.js` line 6-7:** `CONFIG_DIR = path.join(os.homedir(), '.adibilis')` and `CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')`.
- **`src/api.js` line 31-35 (`saveApiKey`):** Creates the directory with `mode: 0o700` (owner-only) and writes the file with `fs.chmodSync(CONFIG_FILE, 0o600)`.

### Assessment

- **GOOD:** Directory is 0o700, file is 0o600. This prevents other users on the same machine from reading the key.
- **GOOD:** The key is stored in `~/.adibilis/`, not inside the project directory, so it will not be accidentally committed to git.
- **RISK (LOW):** The key is plaintext JSON. Any process running as the same OS user can read it. This is standard for CLI tools (npm, gh, aws-cli all do the same), but worth documenting for enterprise users.
- **RISK (LOW):** There is a TOCTOU race between `writeFileSync` and `chmodSync` on line 33-34. The file is briefly world-readable between creation and chmod. Mitigation: pass `{ mode: 0o600 }` as the options argument to `writeFileSync` so the file is created with restricted permissions from the start.
- **NOTE:** The `mode` parameter on `mkdirSync` with `recursive: true` only applies to newly created directories. If `~/.adibilis/` already exists with different permissions, they are not corrected.

### Recommendation

Pass `{ mode: 0o600 }` directly to `writeFileSync` to eliminate the TOCTOU window. Change line 33 of `src/api.js` from:

```
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey }, null, 2) + '\n', 'utf-8');
```

to:

```
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey }, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
```

---

## 2. URL Injection

### Validation

`src/commands/scan.js` lines 19-26 (`isValidUrl`) restricts to `http:` and `https:` protocols using the `URL` constructor.

### Assessment

- **GOOD:** Protocol is restricted to `http:` and `https:`. This blocks `file://`, `javascript:`, `data:`, and `ftp:` schemes.
- **GOOD:** The URL is not used in any shell command -- it is only passed as a JSON body value to `fetch()` (`src/api.js` line 71: `body = JSON.stringify({ url, pages: options.pages })`). There is no shell interpolation.
- **RISK (NONE for CLI):** The URL is sent to the server as a string in a JSON body. SSRF risk exists only on the server side, not in this CLI tool. The CLI correctly delegates scanning to the remote API.
- **GOOD:** No path traversal risk -- the URL is never used to construct local file paths.

### No action required

URL handling is sound for a CLI client.

---

## 3. Command Injection

### Shell usage

The only use of `child_process` is in `src/formatters/report.js` line 4 and lines 104-108, using `execFile` to open the HTML report in the user's browser.

### Assessment

- **GOOD:** Uses `execFile`, not shell-based execution. `execFile` does not invoke a shell, so argument injection is not possible.
- **GOOD:** The command is one of three hardcoded strings (`open`, `start`, `xdg-open`) determined by `process.platform` (line 97-102). No user input flows into the command name.
- **GOOD:** The argument `tmpFile` is constructed from `os.tmpdir()` and `Date.now()` (line 94). No user-controlled data enters the file path.
- **GOOD:** No use of shell-based process execution, `spawn({ shell: true })`, or template literal shell commands anywhere in the codebase.
- **GOOD:** User inputs (URL, API key, threshold, config path) are never passed to shell commands.

### No action required

No command injection vectors exist.

---

## 4. Dependency Vulnerabilities

### Direct dependencies (from `package.json`)

| Package | Version | Risk |
|---------|---------|------|
| `chalk` | `^5.3.0` | **LOW** -- Pure terminal color library, no network I/O. ESM-only. No known CVEs. |
| `commander` | `^12.0.0` | **LOW** -- Mature CLI argument parser. No known CVEs at this version range. |
| `ora` | `^8.0.0` | **LOW** -- Terminal spinner. ESM-only. No known CVEs. |
| `node-fetch` | `^3.3.0` | **NOTE** -- Listed as a dependency but never imported anywhere in source code. The codebase uses the global `fetch()` (available since Node 18). This is dead weight and should be removed. |

### Transitive dependency concerns

- `chalk@5` has zero dependencies (it dropped `supports-color` etc. in v5). Minimal attack surface.
- `ora@8` pulls in `chalk`, `cli-cursor`, `cli-spinners`, `stdin-discarder`, `string-width`, `strip-ansi`, and `is-interactive`. These are all well-maintained packages with no known CVEs.
- `commander@12` has zero dependencies.
- `node-fetch@3` is unused but pulls in `data-uri-to-buffer`, `fetch-blob`, and `formdata-polyfill`. These are unnecessary transitive dependencies.

### Recommendation

**Remove `node-fetch` from dependencies.** It is not imported anywhere. The code uses the Node.js built-in `fetch()`. This reduces the transitive dependency surface.

```bash
npm uninstall node-fetch
```

---

## 5. Output Sanitization

### Terminal output

`src/formatters/terminal.js` renders API response data (violation IDs, descriptions, help URLs, tags) directly to the terminal via chalk and `process.stdout.write`.

Lines 72-83 show violation data rendered without sanitization:

```
lines.push(`  ${icon} ${sev.badge} ${chalk.bold(v.id)} (${count})`);
lines.push(`     ${v.description || v.help || ''}`);
lines.push(`     ${chalk.dim(v.helpUrl)}`);
```

### Assessment

- **RISK (LOW):** If the API returns malicious ANSI escape sequences in `v.id`, `v.description`, `v.help`, or `v.helpUrl`, they would be rendered in the terminal. This could theoretically be used to: hide output, spoof content, or exploit terminal emulator vulnerabilities.
- **MITIGATING FACTOR:** The data comes from the Adibilis API (a first-party service), not from arbitrary third-party input. An attacker would need to compromise the API server.
- **MITIGATING FACTOR:** Most modern terminal emulators are hardened against escape sequence attacks.

### HTML report

`src/formatters/report.js` properly sanitizes data for HTML output using `escapeHtml()` (lines 112-119). This function handles `&`, `<`, `>`, `"`, and `'`. This is correct and complete for HTML attribute and text content contexts.

### Recommendation (low priority)

Consider stripping ANSI escape sequences from API response strings before terminal rendering. A simple regex applied to violation fields would harden against a compromised API.

---

## 6. Token Transmission

### How the key is sent

`src/api.js` line 69:

```
headers['Authorization'] = `Bearer ${apiKey}`;
```

This pattern is used consistently in `submitScan` (line 69), `pollScan` (line 102), `fetchFixes` (line 153), and `fetchReport` (line 168).

### Assessment

- **GOOD:** The API key is sent as a Bearer token in the `Authorization` header, not as a query parameter. It will not appear in server access logs or be cached by proxies.
- **GOOD:** The default base URL uses HTTPS (`https://adibilis-api-production.up.railway.app` on line 5).
- **RISK (MEDIUM):** The base URL can be overridden via the `ADIBILIS_API_URL` environment variable (line 13: `process.env.ADIBILIS_API_URL`). If a user sets this to an HTTP URL, the API key would be transmitted in plaintext. There is no validation that the base URL uses HTTPS.
- **GOOD:** `src/commands/scan.js` lines 38-43 warn the user when `--api-key` is passed on the command line (shell history exposure).

### Recommendation

Add HTTPS enforcement when overriding the base URL. In `src/api.js` `getBaseUrl()`, emit a warning if the URL does not start with `https://`:

```
export function getBaseUrl() {
  const url = process.env.ADIBILIS_API_URL || DEFAULT_BASE_URL;
  if (url && !url.startsWith('https://')) {
    process.stderr.write('Warning: ADIBILIS_API_URL does not use HTTPS. API key may be transmitted insecurely.\n');
  }
  return url;
}
```

---

## 7. Gitignore Coverage

### Config file location

The API key config file is at `~/.adibilis/config.json` (user home directory). This is **outside** any project directory, so it is inherently safe from accidental git commits.

### Project config file

The `adibilis init` command creates `.adibilis.yml` in the current working directory (`src/config.js` line 87). This file does **not** contain secrets -- it holds scan configuration (URL, threshold, ignore rules, pages). The default template (lines 6-21) contains only commented-out examples.

### .gitignore analysis

- `adibilis-cli/.gitignore`: Contains `node_modules/`, `.env`, `*.log`. Does **not** include `.adibilis/` or `config.json`.
- Root `.gitignore`: Contains `.env`, `.env.*`, `node_modules/`, `dist/`, `.vite/`.

### Assessment

- **GOOD:** Since `~/.adibilis/config.json` is in the home directory, not in the project tree, it cannot be committed via `git add`.
- **GOOD:** `.adibilis.yml` (the project config file) contains no secrets by design.
- **NO RISK:** There is no scenario where a user accidentally commits their API key through normal CLI usage.

### No action required

The credential storage location is inherently safe from git exposure.

---

## Summary of Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | TOCTOU race in file permission setting (`saveApiKey`) | LOW | Recommend fix |
| 2 | `node-fetch` is an unused dependency adding unnecessary attack surface | LOW | Recommend removal |
| 3 | No HTTPS enforcement when `ADIBILIS_API_URL` is overridden | MEDIUM | Recommend warning |
| 4 | Terminal output does not strip ANSI sequences from API data | LOW | Optional hardening |
| 5 | `mkdirSync` with `recursive: true` does not fix existing directory permissions | INFO | Document only |

### Items confirmed secure

- URL validation blocks non-HTTP(S) schemes
- No command injection vectors (uses `execFile` for browser-open only)
- API key sent via Bearer header, not query params
- HTML report properly escapes all user/API data
- Credential file stored outside project directory, unreachable by git
- File permissions (0o700 dir, 0o600 file) are correctly applied
- No hardcoded secrets in source code
- Shell history warning when `--api-key` flag is used
