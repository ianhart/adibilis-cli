# Product Audit: adibilis-cli (Product-1)

**Date:** 2026-04-09
**Scope:** Developer UX, workflow completeness, onboarding, AI-tool integration
**Target users:** Vibe-coders using Claude Code, Codex, Cursor, Windsurf, etc.

---

## 1. First-Run Experience

### What happens: `npx adibilis scan https://example.com` (no setup)

The CLI **does work without any setup**. In `src/api.js`, `submitScan` checks for an API key and, when none is found, routes to the unauthenticated `/scan` endpoint instead of the authenticated `/scans` endpoint (lines 66-75). This is good -- zero-config first use is critical for vibe-coders.

### Problems

**P1-CRIT: No "what just happened?" context on first scan.** The terminal output shows violations but never tells the user what plan they're on, what limits they hit, or what they're missing. A first-run user has no idea that:
- They're on the free tier
- They're limited to 1 page
- Fix patches require authentication
- Multi-page scans require a paid plan

**Recommended fix:** After scan completes for unauthenticated users, print a one-line hint:
```
Free scan (1 page, no fixes). Run `adibilis login` to unlock multi-page scans and auto-fix patches.
```

**P1-HIGH: Error messages on auth failure are generic.** In `src/api.js` line 87, errors surface as `data.error || HTTP ${res.status}`. If the API returns `401` or `403`, the user sees "HTTP 401" with no guidance. Should say:
```
Authentication failed. Run `adibilis login` or set ADIBILIS_API_KEY.
```

**P1-MED: `adibilis` with no arguments shows the Commander help, but it doesn't mention `npx adibilis scan <url>` as the quick-start.** The default help output is the standard Commander format. A custom help footer would guide new users:
```
Quick start:
  npx adibilis scan https://your-site.com
  npx adibilis login
```

**P1-MED: `adibilis init` creates `.adibilis.yml` but scan never tells you about it.** After a first scan, the CLI should suggest `adibilis init` if no config file exists in the working directory.

---

## 2. Vibe-Coder Workflow (Claude Code / CLAUDE.md Integration)

### Can a Claude Code user add `npx adibilis scan` as a hook?

**Yes, but there are gaps.** The `--json` flag produces structured output to stdout, which is parseable. However:

**P2-CRIT: `--json` mode still writes spinner output to stdout via `ora`.** Looking at `src/commands/scan.js` lines 52-72, the `runJsonScan` function does NOT create spinners (good), but errors go to stderr as JSON (line 70, also good). This path is clean. **Confirmed: JSON mode is clean.** Terminal mode correctly separates spinner output.

**P2-HIGH: No `--quiet` or `--silent` flag.** Vibe-coders running scans in CI or as a CLAUDE.md hook want minimal noise. The terminal mode always prints the header, separator art, and report hint. A `--quiet` flag that suppresses everything except violations would make the output much more useful when pasted into an AI context window.

**P2-HIGH: JSON output omits critical AI-actionable fields.** The JSON formatter (`src/formatters/json.js`) maps violations but drops:
- `nodes[].html` -- the actual HTML causing the violation (essential for AI to generate a fix)
- `nodes[].target` -- the CSS selector path (essential for AI to locate the element)
- `nodes[].failureSummary` -- axe-core's human-readable fix suggestion
- `tags` -- WCAG success criterion references (e.g., `wcag211`, `best-practice`)

Without these fields, an AI cannot fix the issues without a follow-up scan. The JSON output is diagnostic but not actionable.

**Recommended JSON structure addition:**
```json
{
  "rules": [{
    "id": "color-contrast",
    "impact": "serious",
    "description": "...",
    "helpUrl": "...",
    "wcagCriteria": ["1.4.3"],
    "nodes": [
      {
        "html": "<a style=\"color:#777\">...",
        "target": ["#nav > a.link"],
        "failureSummary": "Fix any of: Element has insufficient color contrast..."
      }
    ]
  }]
}
```

**P2-MED: No CLAUDE.md snippet in README.** The README should include a ready-to-paste CLAUDE.md hook example:
```markdown
## CLAUDE.md Hook Example

Add to your project's CLAUDE.md:

\`\`\`
After deploying or changing HTML/CSS, run:
  npx adibilis scan $DEPLOY_URL --json --threshold serious

If violations are found, fix them before committing.
\`\`\`
```

**P2-MED: Exit code behavior needs documentation.** The `--threshold` flag controls exit codes (0 = pass, 1 = fail), which is exactly what CI and AI hooks need. But the README doesn't explain that `--threshold` is what makes the CLI return a non-zero exit code. Without `--threshold`, the CLI always exits 0 even with critical violations.

---

## 3. README Quality

### Can someone get started in 2 minutes? **Almost, but not quite.**

**Strengths:**
- Quick Start section is at the top with copy-paste commands
- Options table is complete and accurate
- CI/CD examples for GitHub Actions and GitLab are present
- Environment variables are documented
- API key priority is documented

### Problems

**P3-HIGH: README implies `npm install -g adibilis` works but the package is not on npm yet (or if it is, `npx adibilis` is the preferred path for vibe-coders).** The Quick Start uses `npx adibilis` but the Install section says `npm install -g adibilis`. For the target audience, the global install should be secondary. Lead with `npx`.

**P3-HIGH: No "What is this?" section.** The README jumps straight to Quick Start. A developer scanning the README in 5 seconds needs:
```
Adibilis scans your deployed site for WCAG 2.2 AA accessibility violations
and generates fix patches. Works with any URL -- no browser extension or
build tool needed. Free tier: 1 page, no API key required.
```

**P3-MED: No output example.** A developer wants to see what they'll get before they run the command. Show a sample terminal output and a sample `--json` output.

**P3-MED: `.adibilis.yml` example is incomplete.** The config section shows the YAML but doesn't show `url:` being used -- the field is commented in `init` output but shown uncommented in the README. Inconsistency.

**P3-LOW: No mention of Node.js version requirement.** The CLI uses ESM (`"type": "module"`), `fetch` (Node 18+), and top-level `import`. Minimum Node 18 should be stated.

**P3-LOW: Missing `--help` example.** Show `adibilis scan --help` output for discoverability.

---

## 4. Workflow Gaps

### Missing: Scan -> Fix -> Verify loop

The biggest gap. The CLI can scan and show fixes (`--fix`), but there is no workflow to:
1. Apply fixes automatically (e.g., `adibilis fix <file>` or patch output)
2. Re-scan to verify fixes resolved the violations
3. Track which violations are new vs. previously seen

**Recommended:** Add a `--fix-output <dir>` flag that writes patch files to disk. Or output fix patches as unified diff format that AI agents can apply directly.

### Missing: Watch mode

Vibe-coders iterating on a local dev server would benefit from:
```bash
adibilis scan http://localhost:3000 --watch
```
This re-scans on interval and shows a diff of violations added/removed.

### Missing: Baseline / diff support

No way to compare scan results across runs. For CI, users need:
```bash
adibilis scan $URL --json > .adibilis-baseline.json
adibilis scan $URL --json --baseline .adibilis-baseline.json
```
This would show only NEW violations, preventing alert fatigue.

### Missing: `.adibilis.yml` auto-detection feedback

`loadConfig` in `src/config.js` silently returns `{}` if no config file exists (line 26-28). The scan command should print `Using .adibilis.yml` when it finds one, so users know their config is active.

### Missing: `adibilis whoami`

No way to check current auth status, plan, or usage without attempting a scan. A `whoami` or `status` command would help:
```
$ adibilis whoami
Authenticated as: user@example.com
Plan: Pro (500 scans/day)
Usage today: 12/500
```

### Missing: Multi-URL support

No way to scan multiple URLs in one invocation. Common need:
```bash
adibilis scan https://site.com https://site.com/about https://site.com/contact
```
Or: `adibilis scan --sitemap https://site.com/sitemap.xml`

---

## 5. Output for AI Consumption

### Terminal output quality for paste-into-AI

**P5-HIGH: Terminal output uses Unicode art and ANSI colors.** When a developer copies terminal output and pastes it into Claude or ChatGPT, the ANSI escape codes are stripped but the Unicode characters (box-drawing, colored squares) may render oddly. The structural format is decent:

```
  CRITICAL  image-alt (12)
     Images must have alternate text
     https://dequeuniversity.com/rules/axe/4.4/image-alt
     WCAG 1.1.1
```

This is parseable by AI. The hierarchy of severity badge -> rule ID -> description -> help URL -> WCAG criterion is good. However, the `helpUrl` is not labeled, making it ambiguous.

**P5-HIGH: JSON output is too summarized for AI action.** As noted in section 2, the JSON format provides rule-level data but not node-level data. An AI assistant receiving this output can tell you "you have 26 color-contrast violations" but cannot tell you which elements or what the current/required contrast ratios are.

**P5-MED: No markdown output format.** For pasting into AI, a `--format markdown` option would produce the cleanest results:

```markdown
## Accessibility Scan: https://example.com
Pass Rate: 72% | Violations: 34

### Critical (2)
- **image-alt** (12 instances) -- Images must have alternate text [WCAG 1.1.1]
- **button-name** (3 instances) -- Buttons must have discernible text [WCAG 4.1.2]
```

**P5-LOW: No scan URL in JSON output when extracted from nested `scan.site.url`.** The JSON formatter uses `scan.url || scan.site?.url || null` (line 5), which means the URL field might be null if the API response nests it. Not a blocker but would confuse AI parsing.

---

## 6. Naming and Copy

### Command names: **Good**

- `scan` -- intuitive, matches mental model
- `login` -- standard
- `init` -- standard (matches npm init, git init)

### Flag names: **Good, with one issue**

- `--fix` -- intuitive, but misleading. It doesn't fix anything -- it SHOWS fix suggestions. Should be `--show-fixes` or the description should say "Show fix suggestions" not "Show generated fix patches". A user expecting `--fix` to auto-fix will be disappointed.
- `--threshold` -- correct term for CI gating
- `--json` -- standard
- `--report` -- clear
- `--ignore` -- clear
- `--pages` -- clear

### Error messages: **Need work**

| Scenario | Current message | Better message |
|----------|----------------|----------------|
| Invalid URL | `Error: Invalid URL. Only http:// and https:// URLs are allowed.` | Good as-is. |
| API unreachable | `Scan failed` + raw error | `Could not reach Adibilis API. Check your internet connection or try again.` |
| 401 from API | `HTTP 401` | `Invalid or expired API key. Run 'adibilis login' to re-authenticate.` |
| 429 rate limit | Silent retry, then raw error | After retries exhausted: `Rate limit exceeded. You've used all scans for your plan. Upgrade at https://adibilis.com/pricing` |
| Scan timeout | `Scan timed out after 2 minutes` | Good, but add: `The site may be slow or unreachable. Try again or check the URL.` |
| No API key for --fix | Silently returns null from `fetchFixes` | `Fix patches require authentication. Run 'adibilis login' first.` |

**P6-HIGH: `fetchFixes` silently returns null when no API key is present** (`src/api.js` line 149). The terminal formatter then shows "No auto-fix patches available" -- which is a lie. Patches may be available but the user isn't authenticated. This is the single worst UX issue in the CLI: the user thinks there are no fixes when they just need to log in.

### Jargon check

- "axe-core scan in progress" (spinner text, `src/commands/scan.js` line 89) -- "axe-core" means nothing to a vibe-coder. Replace with "Scanning for accessibility issues..."
- "WCAG 2.2 AA" -- used correctly in context, not jargon for the target audience
- "pass rate" -- clear
- "violations" -- clear

---

## Summary: Priority Fixes

### Must-fix before launch

1. **`fetchFixes` silent null on no auth** -- user thinks no fixes exist (P6-HIGH)
2. **JSON output missing node-level data** -- AI cannot act on results (P2-HIGH)
3. **No free-tier messaging in terminal output** -- user doesn't know they can unlock more (P1-CRIT)
4. **Generic HTTP error codes** -- 401/403/429 need human-readable messages (P1-HIGH)

### Should-fix for vibe-coder adoption

5. Add `--quiet` flag for hook/CI use
6. Add CLAUDE.md integration example to README
7. Add "What is this?" blurb to README top
8. Add sample output (terminal + JSON) to README
9. Add `adibilis whoami` / `adibilis status` command
10. Document exit code behavior with `--threshold`

### Nice-to-have for v1.1

11. `--format markdown` output mode
12. Baseline/diff support for CI
13. Watch mode for local development
14. `--fix-output` to write patches to disk
15. Node.js version requirement in README
16. Config auto-detection feedback message

---

## Code Quality Notes (non-UX)

- **Security: good.** API key stored with `0o600` perms, config dir with `0o700`. Warning when passing `--api-key` on command line. HTML report escapes user input.
- **Retry logic: good.** `fetchWithRetry` handles 429/502/503/504 with exponential backoff and Retry-After header support.
- **Test coverage: reasonable.** Config parsing, option merging, API key resolution, JSON formatting, HTML report, CLI structure, and threshold logic are all tested. Missing: integration tests for scan flow, error path tests.
- **Custom YAML parser risk.** `parseSimpleYaml` in `src/config.js` is a hand-rolled parser. It works for flat key-value + simple lists, but will break on nested objects, multi-line strings, or quoted values. Fine for now, but document the limitations or switch to `yaml` package before config complexity grows.
- **Version hardcoded in three places.** `package.json`, `src/cli.js` line 12, and `src/formatters/report.js` line 86 all say `v1.0.0`. Should read from `package.json` to stay in sync.
