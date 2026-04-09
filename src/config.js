import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG_NAME = '.adibilis.yml';

const DEFAULT_CONFIG_CONTENT = `# Adibilis accessibility scanner configuration
# See: https://adibilis.com/docs/cli

# Default URL to scan (optional — overridden by CLI argument)
# url: https://your-site.com

# Fail threshold: critical | serious | moderate | minor
# threshold: serious

# Rule IDs to ignore (comma-separated or list)
# ignore_rules:
#   - color-contrast

# Max pages to scan (default 1 for free, up to plan limit)
# pages: 1
`;

export function loadConfig(configPath) {
  const filePath = configPath || path.resolve(process.cwd(), DEFAULT_CONFIG_NAME);

  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseSimpleYaml(raw);
}

/**
 * Minimal YAML parser — handles flat key:value pairs and simple lists.
 * Avoids requiring a YAML dependency for straightforward config.
 */
export function parseSimpleYaml(text) {
  const config = {};
  let currentKey = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/(?<=\s)#.*$|^#.*$/, '').trimEnd();
    if (!line.trim()) continue;

    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(config[currentKey])) {
        config[currentKey] = [];
      }
      config[currentKey].push(listMatch[1].trim());
      continue;
    }

    const kvMatch = line.match(/^(\w[\w_]*):\s*(.+)?$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = (kvMatch[2] || '').trim();
      currentKey = key;

      if (value) {
        config[key] = value;
      }
      continue;
    }
  }

  return config;
}

export function mergeOptions(cliOptions, fileConfig) {
  return {
    url: cliOptions.url || fileConfig.url || null,
    fix: cliOptions.fix || false,
    report: cliOptions.report || false,
    json: cliOptions.json || false,
    threshold: cliOptions.threshold || fileConfig.threshold || null,
    apiKey: cliOptions.apiKey || null,
    pages: cliOptions.pages || (fileConfig.pages ? parseInt(fileConfig.pages, 10) : undefined),
    ignore: cliOptions.ignore
      ? cliOptions.ignore.split(',').map((s) => s.trim())
      : fileConfig.ignore_rules || [],
  };
}

export function writeDefaultConfig(dir) {
  const filePath = path.join(dir || process.cwd(), DEFAULT_CONFIG_NAME);
  fs.writeFileSync(filePath, DEFAULT_CONFIG_CONTENT, 'utf-8');
  return filePath;
}
