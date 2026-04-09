# Adibilis CLI Audit -- Engineer-1

**Scope**: Command quality, missing commands, output quality, developer experience.
**Date**: 2026-04-09
**Files reviewed**: All 12 source files in `adibilis-cli/`.

---

## 1. Command Quality -- End-to-End Scan Flow

### Flow trace

```
CLI args (commander)
  -> scanCommand()        [src/commands/scan.js]
    -> loadConfig()       [src/config.js]         reads .adibilis.yml
    -> mergeOptions()     [src/config.js]         merges CLI flags + file config
    -> submitScan()       [src/api.js]            POST /scans or /scan
    -> pollScan()         [src/api.js]            GET  /scans/:id  (2 s loop, 2 min timeout)
    -> (optional) fetchFixes()  [src/api.js]      GET  /scans/:id/fixes
    -> formatViolations() [src/formatters/terminal.js]   or formatScanJson()
    -> (optional) openReport()  [src/formatters/report.js]
```

The flow is structurally sound: args in, API call, poll, format, exit. No dead code paths. Both `--json` and terminal branches are handled.

### Bugs found

**BUG-1: `--json` mode never exits 0 on success (missing explicit exit)**
Location: `src/commands/scan.js` lines 52-73, function `runJsonScan`.

When `--threshold` is NOT set, the function returns without calling `process.exit()`. Commander's default behavior will let Node exit with code 0 naturally, BUT any dangling timers/handles (e.g. from `ora`, `fetch` keep-alive sockets) could keep the process alive indefinitely. In practice, since `--json` mode does not create an `ora` spinner, this is low risk but still wrong for a CI tool -- you should always exit explicitly.

In contrast, the `--threshold` path at line 66-68 does call `process.exit(exitCode)`, and the error path at line 70 calls `process.exit(1)`. The happy-path-without-threshold is the gap.

**BUG-2: JSON violation counts are stale after filtering**
Location: `src/formatters/json.js` lines 1-35.

The `violations.total` field is set from the filtered array length (line 9), but `violations.critical`, `violations.serious`, `violations.moderate`, `violations.minor` come directly from the raw scan counts (lines 11-14), NOT from the filtered violations. So if you `--ignore color-contrast` and that accounts for all 26 moderate violations, the JSON output will still say `"moderate": 26` while `"total"` might say 1. These numbers contradict each other.

```js
// json.js line 2-14 -- the mismatch:
const violations = (scan.violations || []).filter((v) => !ignoreRules.includes(v.id));
// ... 
violations: {
  total: violations.length,       // filtered
  critical: scan.critical || 0,   // NOT filtered
  serious: scan.serious || 0,     // NOT filtered
  moderate: scan.moderate || 0,   // NOT filtered
  minor: scan.minor || 0,         // NOT filtered
},
```

**BUG-3: API key security warning has a redundant tautological check**
Location: `src/commands/scan.js` lines 38-42.

```js
if (opts.apiKey && cmdOptions.apiKey) {
```

`opts.apiKey` is always set from `cmdOptions.apiKey` via `mergeOptions` (config.js line 78: `apiKey: cliOptions.apiKey || null`). The config file cannot set `apiKey`. So this check is always either both-truthy or both-falsy. It works, but only by accident -- it should just be `if (cmdOptions.apiKey)`.

**BUG-4: `checkThreshold` reads `violationsByImpact` but API may not return it**
Location: `src/commands/scan.js` lines 146-154.

```js
const counts = result.violationsByImpact || result;
```

If the API response puts counts directly on the root object (`result.critical`, `result.serious`, etc.), then `result.violationsByImpact` is undefined and we fall back to `result` -- which works. But if the API ever returns `violationsByImpact: {}` (empty object, not undefined), every count reads as 0 and threshold checks silently pass. This is brittle.

**BUG-5: `fetchWithRetry` can theoretically return `undefined`**
Location: `src/api.js` lines 40-58.

The `for` loop runs `attempt = 0` to `MAX_RETRIES` (3), so 4 iterations. If on the last iteration (`attempt === MAX_RETRIES`), the status is retryable, the function returns the response (correct). But there is no `return` after the loop body -- if the loop somehow exits without returning (which currently cannot happen due to the loop structure), it would return `undefined`. Structurally safe but fragile to future edits.

**BUG-6: `init` command silently overwrites existing config**
Location: `src/commands/init.js` line 6 and `src/config.js` line 88.

`writeDefaultConfig()` calls `fs.writeFileSync` with no existence check. Running `adibilis init` twice nukes any customizations the user made. Should check first and warn or prompt.

**BUG-7: `node-fetch` is listed as a dependency but never imported**
Location: `package.json` line 16.

The codebase uses the global `fetch()` (available in Node 18+). The `node-fetch` dependency is dead weight. The `api.js` file has no `import fetch` statement anywhere -- it relies on the global. This works on Node 18+, but if someone runs Node 16 they get a `fetch is not defined` error with no useful message, and the `node-fetch` package sitting in node_modules does nothing.

---

## 2. Missing Commands

### Implemented

| Command | Status |
|---------|--------|
| `scan`  | Implemented, functional |
| `login` | Implemented, functional |
| `init`  | Implemented, functional |

### Missing -- Referenced or Expected

| Command | Evidence | Priority |
|---------|----------|----------|
| `logout` | `login` stores key to `~/.adibilis/config.json` but there is no way to remove it. A user who wants to de-auth must manually delete the file. | HIGH -- table stakes |
| `whoami` | No way to check which API key is active or what plan you are on without running a scan. `login` validates the key and shows plan info, but only at auth time. | HIGH -- dev convenience |
| `config` | `init` creates `.adibilis.yml`, but there is no `config get`, `config set`, or `config show` to inspect or modify it programmatically. | MEDIUM |
| `status` | No way to check API health, rate limits, or usage without scanning. The `/scans/usage` endpoint exists (used in `login.js` line 22) but is not exposed as a command. | MEDIUM |
| `verify` | No post-fix verification. After applying fixes, users would want to re-scan and compare -- a `verify` or `diff` command would be useful. | LOW -- can use `scan` twice |
| `fix` | Listed as a `--fix` flag on scan, not a standalone command. Consider `adibilis fix <url>` as a shorthand for `adibilis scan <url> --fix`. | LOW -- ergonomic alias |

### No references to `fix`, `verify`, `status`, `config`, `logout`, `whoami` exist anywhere in the source code. These are purely absent, not stubbed-out or partially implemented.

---

## 3. Output Quality

### Terminal output

**Good:**
- Color-coded severity badges (critical=red, serious=yellow, moderate=orange, minor=gray).
- Pass rate color shifts (green >= 90, yellow >= 70, red < 70).
- Top 10 violations shown with overflow indicator ("... and N more issues").
- Spinner feedback during scan with stage transitions ("Submitting scan..." -> "Scanning page..." -> "axe-core scan in progress...").
- Clean separator lines.

**Issues:**
- WCAG tag formatting is fragile. Line 82 of `terminal.js` does `wcagTag.replace('wcag', '').replace(/(\d)(\d)(\d)/, '$1.$2.$3')`. This only works for 3-digit WCAG references like `wcag111` -> `1.1.1`. Tags like `wcag21aa` or `wcag2aa` (common in axe-core) will not match the regex and will render as raw strings like `21aa`.
- No color-blind safe mode. The tool relies heavily on red/yellow/orange/gray, which are hard to distinguish for protanopia/deuteranopia users. Ironic for an accessibility scanner.
- No `--verbose` or `--quiet` flags. You get exactly one output level.

### JSON output (`--json`)

**Good:**
- Valid parseable JSON (confirmed by test).
- Structured with separate `violations` counts and `rules` array.
- Includes `fixes` section when `--fix` is passed.

**Issues:**
- Missing `scanId` in output. CI pipelines may need this to fetch reports or fixes later.
- Missing `scannedAt` / `timestamp` field.
- Missing `duration` / scan time.
- The `violations.total` vs per-severity count mismatch after filtering (BUG-2 above).
- No schema documentation. Users must guess the shape from examples.

### HTML report (`--report`)

**Good:**
- Self-contained single-file HTML with inline CSS. No external dependencies.
- Responsive grid layout for summary stats.
- Proper HTML escaping via `escapeHtml()`.
- Color-coded severity badges matching terminal output.
- Professional appearance (dark header, card layout, clean table).

**Issues:**
- No print stylesheet. `@media print` rules are absent -- printing the report from a browser will include background colors on some browsers and miss them on others.
- No accessibility in the report itself. The HTML report for an accessibility scanner lacks: `aria-label` on the stat cards, `scope` on table headers, sufficient color contrast ratios for the badge text (white-on-orange for moderate is borderline at 3.0:1, below AA 4.5:1), and `role="table"`.
- Report does not include WCAG criteria references, help URLs, or affected selectors/nodes from the violations. It only shows rule ID, description, severity, and count. The terminal output shows more detail per violation than the report.
- No export to file option. `--report` always writes to `/tmp` and opens the browser. For CI, you might want `--report-out ./report.html`.

---

## 4. Help Text

### What works

Running `adibilis --help` (via Commander) will auto-generate:
```
Usage: adibilis [options] [command]

Scan websites for WCAG 2.2 AA accessibility violations

Options:
  -V, --version   output the version number
  -h, --help      display help for this command

Commands:
  scan <url>      Scan a URL for accessibility violations
  login           Authenticate with your Adibilis API key
  init            Create .adibilis.yml in the current directory
```

`adibilis scan --help` will list all 8 options with descriptions.

### What is missing

- **No examples in `--help` output.** Commander supports `.addHelpText('after', ...)` to add usage examples. The README has good examples but `--help` does not.
- **No `--threshold` valid values listed in help.** The description says "Exit code 1 if violations exceed level" but does not list `critical/serious/moderate/minor` as valid choices. A user would have to read the README to know.
- **No global `--verbose` / `--quiet` / `--no-color` options.** Many CLIs support these. `chalk` respects `NO_COLOR` and `FORCE_COLOR` env vars, but this is not documented in `--help`.
- **No epilogue or "Getting started" hint** for when someone just types `adibilis` with no arguments.
- **Version is hardcoded to `1.0.0` in two places**: `cli.js` line 12 and `terminal.js` line 16. Neither reads from `package.json`. These will drift.

---

## 5. Exit Codes

### Current behavior

| Scenario | Exit code | Correct for CI? |
|----------|-----------|-----------------|
| Scan succeeds, no threshold | 0 (implicit) | Yes, but implicit -- see BUG-1 |
| Scan succeeds, threshold NOT exceeded | 0 (explicit) | Yes |
| Scan succeeds, threshold exceeded | 1 (explicit) | Yes |
| Scan fails (API error, timeout, etc.) | 1 (explicit) | Yes |
| Invalid URL | 1 (explicit) | Yes |
| Invalid API key (login) | 1 (explicit) | Yes |
| Unknown command | 0 (Commander default) | **NO -- should be 1** |
| `--threshold` with invalid value (e.g. "high") | 0 | **NO -- should be 2 (user error)** |

### Issues

- **No exit code 2.** The README's CI integration examples imply the CLI distinguishes between "violations found" (exit 1) and "CLI error" (also exit 1). Standard convention is: 0 = pass, 1 = violations found, 2 = tool error. Currently both `threshold exceeded` and `API error` return 1, making them indistinguishable in CI scripts.
- **Invalid threshold values silently pass.** If a user types `--threshold high` (not a valid level), `checkThreshold` returns 0 at line 148 (`idx === -1`). No warning is printed. The scan runs, reports violations, and exits 0 -- giving a false sense of compliance. This is a **silent correctness bug** in CI pipelines.
- **Commander's `exitOverride()` is not used.** If Commander itself hits an error (e.g., missing required `<url>` arg), it calls `process.exit(1)` but the exit code is not guaranteed to be 2 for usage errors.

---

## 6. Brainstorm -- 3 Features That Make This 10x Better for Vibe-Coders

### Feature 1: `adibilis scan . --watch` (local dev server auto-scan)

**The problem**: A vibe-coder using Claude Code or Cursor is running `npm run dev` on localhost:3000. They make changes, save, and want instant accessibility feedback without switching context.

**The feature**: `adibilis scan http://localhost:3000 --watch` watches for file changes (or polls the URL) and re-scans automatically, streaming a compact diff of new/fixed violations to the terminal. Think `tsc --watch` but for accessibility.

**Why 10x**: Turns accessibility from a "check at the end" ceremony into a live feedback loop. Pair this with Claude Code's terminal integration and the AI assistant can see violations appear in real-time and fix them inline.

### Feature 2: `adibilis scan <url> --fix --apply` (auto-apply patches via clipboard/stdout)

**The problem**: `--fix` currently shows fix suggestions as text, but the user must manually find the right file, locate the selector, and apply the change. This breaks flow.

**The feature**: `--fix --apply` outputs machine-readable patches (unified diff format or JSON with file paths and line ranges) that Claude Code or Cursor can consume directly. Even better: `--fix --copy` puts the top fix on the clipboard. The JSON output from `--fix --json` should include `selector`, `currentHtml`, and `suggestedHtml` so an AI coding assistant can `Edit` the file directly.

**Why 10x**: Closes the loop between "find violation" and "fix violation" without the developer ever leaving their editor. An AI assistant can call `adibilis scan ... --fix --json`, parse the output, and apply fixes autonomously.

### Feature 3: `adibilis ci --github-comment` (PR comment with scan diff)

**The problem**: CI integration today is `--threshold serious --json` with a binary pass/fail. There is no visibility into WHAT failed or how the current PR compares to the base branch.

**The feature**: `adibilis ci --github-comment` runs a scan, compares results against a baseline (previous scan or main branch), and posts a formatted GitHub PR comment showing: new violations introduced, violations fixed, and a pass/fail badge. Stores baselines in `.adibilis/baseline.json`.

**Why 10x**: Makes accessibility visible in the code review workflow where vibe-coders already live. A PR that introduces 3 new critical violations gets flagged with specifics, not just a red X. Works with `gh` CLI for auth.

---

## Summary of Issues by Severity

| Severity | Count | Items |
|----------|-------|-------|
| **High** | 3 | BUG-2 (JSON count mismatch), BUG-6 (init overwrites), invalid threshold silently passes |
| **Medium** | 4 | BUG-1 (no explicit exit in JSON mode), missing `logout`/`whoami`, version hardcoded in 2 places, no exit code 2 |
| **Low** | 5 | BUG-3 (tautological check), BUG-5 (fragile fetchWithRetry), BUG-7 (dead node-fetch dep), WCAG tag regex fragile, no examples in --help |
| **DX** | 4 | No --verbose/--quiet, no print CSS on report, no scanId/timestamp in JSON, report less detailed than terminal |
