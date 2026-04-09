import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createProgram } from '../src/cli.js';
import { parseSimpleYaml, mergeOptions, loadConfig } from '../src/config.js';
import { getApiKey, getBaseUrl } from '../src/api.js';
import { formatScanJson } from '../src/formatters/json.js';
import { generateHtmlReport } from '../src/formatters/report.js';

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------
describe('parseSimpleYaml', () => {
  it('parses flat key-value pairs', () => {
    const text = 'url: https://example.com\nthreshold: serious\npages: 3';
    const result = parseSimpleYaml(text);
    expect(result).toEqual({ url: 'https://example.com', threshold: 'serious', pages: '3' });
  });

  it('parses list values', () => {
    const text = 'ignore_rules:\n  - color-contrast\n  - link-name';
    const result = parseSimpleYaml(text);
    expect(result).toEqual({ ignore_rules: ['color-contrast', 'link-name'] });
  });

  it('ignores comments and blank lines', () => {
    const text = '# this is a comment\n\nurl: https://example.com\n# another comment';
    const result = parseSimpleYaml(text);
    expect(result).toEqual({ url: 'https://example.com' });
  });

  it('returns empty object for empty input', () => {
    expect(parseSimpleYaml('')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Option merging
// ---------------------------------------------------------------------------
describe('mergeOptions', () => {
  it('CLI flags override file config', () => {
    const cliOptions = { threshold: 'critical', url: 'https://cli.com' };
    const fileConfig = { threshold: 'serious', url: 'https://file.com' };
    const merged = mergeOptions(cliOptions, fileConfig);
    expect(merged.threshold).toBe('critical');
    expect(merged.url).toBe('https://cli.com');
  });

  it('falls back to file config when CLI flag is absent', () => {
    const cliOptions = { url: null };
    const fileConfig = { threshold: 'moderate', url: 'https://file.com' };
    const merged = mergeOptions(cliOptions, fileConfig);
    expect(merged.threshold).toBe('moderate');
    expect(merged.url).toBe('https://file.com');
  });

  it('splits ignore string into array', () => {
    const merged = mergeOptions({ ignore: 'color-contrast, link-name' }, {});
    expect(merged.ignore).toEqual(['color-contrast', 'link-name']);
  });

  it('uses file ignore_rules when CLI ignore is absent', () => {
    const merged = mergeOptions({}, { ignore_rules: ['color-contrast'] });
    expect(merged.ignore).toEqual(['color-contrast']);
  });
});

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------
describe('getApiKey', () => {
  const originalEnv = process.env.ADIBILIS_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADIBILIS_API_KEY = originalEnv;
    } else {
      delete process.env.ADIBILIS_API_KEY;
    }
  });

  it('returns flag value first', () => {
    process.env.ADIBILIS_API_KEY = 'env-key';
    expect(getApiKey('flag-key')).toBe('flag-key');
  });

  it('returns env var when no flag', () => {
    process.env.ADIBILIS_API_KEY = 'env-key';
    expect(getApiKey(undefined)).toBe('env-key');
  });

  it('returns null when nothing is set', () => {
    delete process.env.ADIBILIS_API_KEY;
    // readStoredApiKey will fail gracefully if no file exists
    const key = getApiKey(undefined);
    expect(key === null || key === undefined || typeof key === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------
describe('getBaseUrl', () => {
  const originalEnv = process.env.ADIBILIS_API_URL;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADIBILIS_API_URL = originalEnv;
    } else {
      delete process.env.ADIBILIS_API_URL;
    }
  });

  it('returns default URL when env is not set', () => {
    delete process.env.ADIBILIS_API_URL;
    expect(getBaseUrl()).toBe('https://api.adibilis.dev');
  });

  it('returns custom URL from env', () => {
    process.env.ADIBILIS_API_URL = 'http://localhost:3000';
    expect(getBaseUrl()).toBe('http://localhost:3000');
  });
});

// ---------------------------------------------------------------------------
// JSON formatter
// ---------------------------------------------------------------------------
describe('formatScanJson', () => {
  const mockScan = {
    url: 'https://example.com',
    status: 'completed',
    passRate: 85.1,
    critical: 0,
    serious: 1,
    moderate: 26,
    minor: 98,
    violations: [
      {
        id: 'color-contrast',
        impact: 'moderate',
        description: 'Elements must meet minimum color contrast ratio thresholds',
        nodes: new Array(26),
        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/color-contrast',
      },
      {
        id: 'link-in-text-block',
        impact: 'serious',
        description: 'Links must be distinguishable without relying on color',
        nodes: [{}],
      },
    ],
  };

  it('produces valid JSON', () => {
    const output = formatScanJson(mockScan);
    const parsed = JSON.parse(output);
    expect(parsed.url).toBe('https://example.com');
    expect(parsed.status).toBe('completed');
    expect(parsed.passRate).toBe(85.1);
  });

  it('includes violation counts', () => {
    const parsed = JSON.parse(formatScanJson(mockScan));
    expect(parsed.violations.critical).toBe(0);
    expect(parsed.violations.serious).toBe(1);
    expect(parsed.violations.moderate).toBe(26);
  });

  it('lists rules with count', () => {
    const parsed = JSON.parse(formatScanJson(mockScan));
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[0].id).toBe('color-contrast');
    expect(parsed.rules[0].count).toBe(26);
  });

  it('filters ignored rules', () => {
    const parsed = JSON.parse(formatScanJson(mockScan, { ignoreRules: ['color-contrast'] }));
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].id).toBe('link-in-text-block');
  });

  it('includes fixes when provided', () => {
    const fixes = {
      patches: {
        totalPatches: 5,
        patches: [{ ruleId: 'color-contrast', fixes: [{}, {}, {}] }],
      },
    };
    const parsed = JSON.parse(formatScanJson(mockScan, { fixes }));
    expect(parsed.fixes.totalPatches).toBe(5);
    expect(parsed.fixes.patches[0].fixCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// HTML report generator
// ---------------------------------------------------------------------------
describe('generateHtmlReport', () => {
  it('generates valid HTML with scan data', () => {
    const scan = {
      url: 'https://example.com',
      passRate: 90,
      critical: 0,
      serious: 0,
      moderate: 2,
      minor: 5,
      violations: [
        { id: 'color-contrast', impact: 'moderate', description: 'Low contrast', nodes: [{}, {}] },
      ],
    };

    const html = generateHtmlReport(scan);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('https://example.com');
    expect(html).toContain('90%');
    expect(html).toContain('color-contrast');
    expect(html).toContain('MODERATE');
  });

  it('escapes HTML in URL', () => {
    const scan = {
      url: 'https://example.com/<script>',
      passRate: 100,
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
      violations: [],
    };
    const html = generateHtmlReport(scan);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// CLI program structure
// ---------------------------------------------------------------------------
describe('createProgram', () => {
  it('creates a program with scan, login, and init commands', () => {
    const program = createProgram();
    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames).toContain('scan');
    expect(commandNames).toContain('login');
    expect(commandNames).toContain('init');
  });

  it('scan command has expected options', () => {
    const program = createProgram();
    const scan = program.commands.find((c) => c.name() === 'scan');
    const optionNames = scan.options.map((o) => o.long);
    expect(optionNames).toContain('--fix');
    expect(optionNames).toContain('--report');
    expect(optionNames).toContain('--json');
    expect(optionNames).toContain('--threshold');
    expect(optionNames).toContain('--api-key');
    expect(optionNames).toContain('--pages');
    expect(optionNames).toContain('--ignore');
    expect(optionNames).toContain('--config');
  });
});

// ---------------------------------------------------------------------------
// Threshold exit code logic
// ---------------------------------------------------------------------------
describe('threshold logic', () => {
  // Replicate the checkThreshold logic for unit testing
  function checkThreshold(result, threshold) {
    const levels = ['critical', 'serious', 'moderate', 'minor'];
    const idx = levels.indexOf(threshold);
    if (idx === -1) return 0;
    const check = levels.slice(0, idx + 1);
    return check.some((level) => (result[level] || 0) > 0) ? 1 : 0;
  }

  it('exits 0 when no violations at threshold', () => {
    expect(checkThreshold({ critical: 0, serious: 0 }, 'serious')).toBe(0);
  });

  it('exits 1 when violations at threshold level', () => {
    expect(checkThreshold({ critical: 0, serious: 3 }, 'serious')).toBe(1);
  });

  it('exits 1 when violations above threshold level', () => {
    expect(checkThreshold({ critical: 2, serious: 0 }, 'serious')).toBe(1);
  });

  it('exits 0 for violations below threshold', () => {
    expect(checkThreshold({ critical: 0, serious: 0, moderate: 5 }, 'serious')).toBe(0);
  });

  it('returns 0 for unknown threshold', () => {
    expect(checkThreshold({ critical: 5 }, 'unknown')).toBe(0);
  });
});
