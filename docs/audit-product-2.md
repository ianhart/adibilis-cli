# Product Audit: adibilis-cli

Auditor: Product-2
Date: 2026-04-09
Target audience: developers, vibe-coders
Scope: adoption risk, naming, missing capabilities, scalability

---

## 1. Adoption Barriers

### 1a. Not published to npm

The package has never been published. Running `npx adibilis scan https://example.com` (as shown in the README) will fail for any developer who doesn't clone the repo first. This is the single biggest adoption blocker.

### 1b. node-fetch dependency is unnecessary

`package.json` lists `node-fetch@^3.3.0` as a dependency, but the source code (`src/api.js`) uses the global `fetch()` directly -- it never imports `node-fetch`. Node 18+ ships with global fetch. This is dead weight that inflates install size and signals the package wasn't tested end-to-end after removing the import.

### 1c. No `engines` field

Without `"engines": { "node": ">=18" }`, a developer on Node 16 will hit a runtime crash (`fetch is not defined`) with no useful error message. The CLI does not polyfill or check the Node version.

### 1d. `adibilis login` requires a working API

The `login` command validates the key by hitting `/scans/usage`. If the API at `https://adibilis-api-production.up.railway.app` is down or unreachable, the developer cannot authenticate at all. There is no offline/deferred key storage. The error message (`Could not connect to Adibilis API`) does not suggest retrying or checking connectivity.

### 1e. No free-tier scan works without API context

The code splits behavior between authenticated (`/scans`) and unauthenticated (`/scan`) endpoints. The README says "default 1 for free" but never explains:
- What happens with no API key at all (anonymous scan)
- What limits apply to anonymous scans
- Where to get an API key

A developer hitting `npx adibilis scan https://example.com` with no API key has no idea whether it will work, cost money, or silently degrade.

### 1f. Tests pass but don't cover network paths

The test file (`tests/cli.test.js`) tests config parsing, option merging, JSON formatting, HTML generation, and threshold logic -- all unit-level. No tests mock the API submission/polling flow. The threshold tests re-implement `checkThreshold` inline rather than importing the actual function from `src/commands/scan.js`, meaning the real function could diverge.

---

## 2. Competitive Comparison

| Capability | adibilis-cli | axe-cli (Deque) | pa11y | lighthouse |
|---|---|---|---|---|
| Runs axe-core locally | No (API-only) | Yes | Yes | Yes |
| Zero config first scan | Yes* | Yes | Yes | Yes |
| Offline use | No | Yes | Yes | Yes |
| Auto-fix patches | Yes (API) | No | No | No |
| HTML report | Yes (local) | No (JSON) | Yes | Yes |
| CI exit codes | Yes | Yes | Yes | Yes |
| Multi-page crawl | Yes (API) | No | Yes (scripts) | No |
| WCAG 2.2 coverage | Depends on API | axe-core 4.x | axe/htmlcs | Lighthouse |
| Free tier | Unclear | Free | Free | Free |
| npm install size | ~6 deps | Heavy (puppeteer) | Heavy (puppeteer) | Heavy (chrome) |

### Unique value proposition

The only real differentiator is **auto-fix patches**. No major CLI competitor generates code fixes. This is the wedge -- but it is buried. The README mentions `--fix` once in Quick Start and once in the options table. The value prop should be front-and-center: "the only a11y scanner that writes the patches for you."

### Weakness: API dependency

axe-cli, pa11y, and lighthouse all run locally. adibilis-cli is a thin API client. If the API is slow, down, or rate-limited, the entire CLI is unusable. Competitors never have this problem. For CI pipelines in air-gapped environments or behind corporate proxies, this is a hard no.

---

## 3. Naming Audit

### 3a. "adibilis" is hard to type and remember

- Latin word meaning "accessible" -- clever, but not discoverable
- 8 characters, no natural autocomplete help
- Easy to misspell: "adiblis", "adibilus", "adibilis" vs "adibilis"
- Developers searching for "accessibility CLI" or "wcag scanner" will not find it
- Compare: `axe`, `pa11y`, `a11y` -- all short, all linked to accessibility in developer minds

**Recommendation:** If renaming is off the table, the npm package should be `@adibilis/cli` to establish a scope. Currently it's just `adibilis`, which is fine for now but limits future expansion (e.g., `@adibilis/action`, `@adibilis/sdk`).

### 3b. Command names are solid

- `scan`, `login`, `init` -- standard CLI conventions
- `--fix`, `--report`, `--json`, `--threshold` -- all match developer expectations
- `--pages` is slightly ambiguous (could mean "page numbers" rather than "number of pages to crawl"), but acceptable

### 3c. Config file naming is correct

`.adibilis.yml` follows the `.<tool>.yml` convention (`.eslintrc.yml`, `.prettierrc.yml`). Good.

### 3d. API key env var naming is correct

`ADIBILIS_API_KEY` follows standard conventions. Good.

---

## 4. Missing Capabilities for CI/CD

### 4a. No GitHub Action

The README shows a raw `run:` step. Developers expect a published GitHub Action:

```yaml
- uses: adibilis/scan-action@v1
  with:
    url: ${{ env.DEPLOY_URL }}
    threshold: serious
```

This is table stakes for CI adoption. Without it, every team writes their own wrapper.

### 4b. No Vercel/Netlify build hooks

No integration with `vercel.json` post-deploy hooks, Netlify deploy notifications, or any deployment platform webhooks. The README's CI/CD section is just "run npx" -- there's no guidance for:
- Scanning preview deployments automatically
- Commenting results on PRs
- Blocking deploys on threshold failures

### 4c. No pre-commit hook

No `husky` or `lint-staged` integration. Developers who want to scan before every push have no path to do so.

### 4d. `.adibilis.yml` exists but is minimal

The config file supports `url`, `threshold`, `ignore_rules`, and `pages`. Missing:
- `baseline` -- path to a baseline file for diffing (new violations vs. known)
- `reporters` -- configure output format (json, junit, sarif)
- `include`/`exclude` -- URL patterns to include or exclude during multi-page crawl
- `timeout` -- scan timeout override
- `wcag_level` -- target AA vs. AAA
- `rules` -- enable/disable specific axe-core rules (not just ignore)

### 4e. No baseline diffing

There is no concept of a baseline. Every scan reports all violations. For teams adopting this incrementally, the first scan returns hundreds of issues and the CLI exits with code 1. There is no way to say "only fail on NEW violations since the last run." This is critical for adoption in existing projects.

### 4f. No SARIF or JUnit output

`--json` outputs a custom JSON format. GitHub Code Scanning requires SARIF. Jenkins requires JUnit XML. Neither is supported.

### 4g. No `--output` flag

Results always go to stdout. There is no `--output report.json` or `--output report.html` to write to a file. The HTML report opens in the browser via `open`/`xdg-open` which is useless in CI (headless environment). In CI, `--report` will crash or silently fail because `execFile('open', ...)` has no fallback for headless environments.

---

## 5. npm Package Readiness

### 5a. Publishable? No. Here is what's missing:

| Field | Status | Required for npm publish |
|---|---|---|
| `name` | `"adibilis"` -- may be taken on npm | Check availability |
| `version` | `"1.0.0"` -- fine for first publish | OK |
| `description` | Present | OK |
| `bin` | Present and correct | OK |
| `main` | Missing | Needed if anyone imports this as a library |
| `exports` | Missing | Modern Node resolution; not critical for CLI-only |
| `files` | **Missing** | Without it, npm packs everything including `tests/`, `.git/` etc. |
| `repository` | **Missing** | npm registry will show "no repository" |
| `homepage` | Missing | npm registry will show no link |
| `bugs` | Missing | No way to report issues |
| `author` | Missing | npm shows "unknown author" |
| `engines` | **Missing** | Requires Node 18+ for global fetch |
| `keywords` | Present (5 keywords) | OK but add more: `wcag-2.2`, `accessibility-testing`, `a11y-scanner`, `axe` |
| `types` | N/A (no TypeScript) | Not needed |
| `license` | `"MIT"` | OK |

### 5b. `files` array is critical

Without `"files": ["bin", "src", "README.md", "LICENSE"]`, running `npm pack` will include `tests/`, `docs/`, `package-lock.json`, and potentially anything else in the directory. This bloats the published package.

### 5c. No LICENSE file

`package.json` says `"license": "MIT"` but there is no `LICENSE` or `LICENSE.md` file in the repo.

### 5d. Version is 1.0.0 prematurely

The CLI has not been published, has no users, and the API contract is still evolving. Starting at 1.0.0 signals stability. If the JSON output format changes, you've made a breaking change and must go to 2.0.0. Consider starting at 0.1.0.

### 5e. `node-fetch` is a phantom dependency

Listed in `dependencies` but never imported. It will install for every user but serve no purpose. Remove it.

---

## 6. Documentation Gaps

### Questions the README does not answer:

1. **Where do I get an API key?** No link to signup, no mention of adibilis.com/dashboard or any registration flow.

2. **What does a free scan include?** The README says "default 1 for free, up to plan limit" but never explains what "free" means -- is it free forever? Rate-limited? Degraded?

3. **What plans exist?** The `login` command displays the plan name but the README never lists plans or pricing.

4. **What does `--fix` actually output?** No example output. A developer does not know if they'll get git-style diffs, CSS snippets, or vague suggestions.

5. **What happens in CI with `--report`?** The report opens in a browser, which doesn't exist in CI. The README shows `--report` alongside CI examples without noting this incompatibility.

6. **How does multi-page scanning work?** `--pages 5` -- does it crawl from the given URL? Follow links? Use a sitemap? Respect robots.txt?

7. **What WCAG rules are checked?** No list of rules. No link to the axe-core rule set. The developer has no idea what's being tested.

8. **How does the `--ignore` flag map to rule IDs?** Where does the developer find the list of valid rule IDs?

9. **What's the rate limit?** No mention of how many scans/day are allowed per plan.

10. **Error handling guidance.** No troubleshooting section. Common failures (network timeout, invalid API key, scan timeout) have no documented resolution.

11. **No changelog.** No CHANGELOG.md for tracking what changes between versions.

12. **No contribution guide.** No CONTRIBUTING.md for developers who want to help.

---

## Summary of Priority Actions

### P0 -- Ship blockers
1. Publish to npm (or at minimum, ensure `npm pack` produces a clean tarball)
2. Add `files` array to package.json
3. Add `engines` field requiring Node >= 18
4. Remove `node-fetch` from dependencies
5. Add a LICENSE file
6. Document where to get an API key

### P1 -- Adoption enablers
7. Add baseline diffing (`--baseline` flag)
8. Add `--output <path>` flag for file output
9. Fix `--report` to write to file in CI (detect headless environment)
10. Publish a GitHub Action (`adibilis/scan-action`)
11. Add SARIF output for GitHub Code Scanning integration
12. Start at version 0.1.0 instead of 1.0.0

### P2 -- Competitive positioning
13. Lead marketing with auto-fix: "the only a11y CLI that writes the patches"
14. Add example output for `--fix` and `--json` to the README
15. Add a comparison table vs. axe-cli / pa11y / lighthouse
16. Consider `@adibilis/cli` scoped package name for future expansion
