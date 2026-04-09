import ora from 'ora';
import { submitScan, pollScan, fetchFixes } from '../api.js';
import { loadConfig, mergeOptions } from '../config.js';
import {
  formatHeader,
  formatScanning,
  formatScanComplete,
  formatViolations,
  formatFixSuggestion,
  formatFixes,
  formatReportHint,
  formatError,
} from '../formatters/terminal.js';
import { formatScanJson } from '../formatters/json.js';
import { openReport } from '../formatters/report.js';

const THRESHOLD_LEVELS = ['critical', 'serious', 'moderate', 'minor'];

function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function scanCommand(url, cmdOptions) {
  const fileConfig = loadConfig(cmdOptions.config);
  const opts = mergeOptions({ ...cmdOptions, url }, fileConfig);

  if (!isValidUrl(url)) {
    process.stderr.write('Error: Invalid URL. Only http:// and https:// URLs are allowed.\n');
    process.exit(1);
    return;
  }

  if (opts.apiKey && cmdOptions.apiKey) {
    process.stderr.write(
      'Warning: passing API key via command line exposes it in shell history. ' +
        'Use ADIBILIS_API_KEY env var or \'adibilis login\' instead.\n',
    );
  }

  if (opts.json) {
    return runJsonScan(url, opts);
  }

  return runTerminalScan(url, opts);
}

async function runJsonScan(url, opts) {
  try {
    const submission = await submitScan(url, { apiKey: opts.apiKey, pages: opts.pages });
    const result = await pollScan(submission.scanId, { apiKey: opts.apiKey });

    let fixes = null;
    if (opts.fix) {
      fixes = await fetchFixes(submission.scanId, { apiKey: opts.apiKey });
    }

    const output = formatScanJson(result, { fixes, ignoreRules: opts.ignore });
    process.stdout.write(output + '\n');

    if (opts.threshold) {
      const exitCode = checkThreshold(result, opts.threshold);
      process.exit(exitCode);
    }
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
    process.exit(1);
  }
}

async function runTerminalScan(url, opts) {
  process.stdout.write(formatHeader());
  process.stdout.write(formatScanning(url) + '\n');

  const spinner = ora({ text: 'Submitting scan...', indent: 2 }).start();

  try {
    const submission = await submitScan(url, { apiKey: opts.apiKey, pages: opts.pages });
    spinner.text = 'Scanning page...';

    const result = await pollScan(submission.scanId, {
      apiKey: opts.apiKey,
      onProgress: (data) => {
        if (data.status === 'running') {
          spinner.text = 'axe-core scan in progress...';
        }
      },
    });

    if (result.status === 'failed') {
      spinner.fail('Scan failed');
      process.stdout.write(formatError(result.errorMessage || result.error || 'Unknown error'));
      process.exit(1);
      return;
    }

    spinner.succeed('Scan complete');

    process.stdout.write(formatScanComplete(result));
    process.stdout.write(formatViolations(result.violations, { ignoreRules: opts.ignore }));

    if (opts.fix) {
      const fixSpinner = ora({ text: 'Loading fix patches...', indent: 2 }).start();
      const fixes = await fetchFixes(submission.scanId, { apiKey: opts.apiKey });
      fixSpinner.stop();
      if (fixes?._noAuth) {
        process.stdout.write('\n  Auto-fix requires authentication. Run "adibilis login" to see code patches.\n\n');
      } else {
        process.stdout.write(formatFixes(fixes));
      }
    } else {
      const fixCount = result.fixesAvailable || result.fixes?.patches?.totalPatches || 0;
      if (fixCount > 0) {
        process.stdout.write(formatFixSuggestion(url, fixCount));
      }
    }

    if (opts.report) {
      const reportSpinner = ora({ text: 'Generating report...', indent: 2 }).start();
      try {
        const tmpFile = await openReport(result);
        reportSpinner.succeed(`Report opened: ${tmpFile}`);
      } catch {
        reportSpinner.fail('Could not open report in browser');
      }
    } else {
      process.stdout.write(formatReportHint(url));
    }

    if (opts.threshold) {
      const exitCode = checkThreshold(result, opts.threshold);
      if (exitCode !== 0) {
        process.stdout.write(
          formatError(`Threshold "${opts.threshold}" exceeded — exiting with code 1`),
        );
      }
      process.exit(exitCode);
    }
  } catch (err) {
    spinner.fail('Scan failed');
    process.stdout.write(formatError(err.message));
    process.exit(1);
  }
}

export function checkThreshold(result, threshold) {
  const idx = THRESHOLD_LEVELS.indexOf(threshold);
  if (idx === -1) {
    process.stderr.write(`Error: Invalid threshold "${threshold}". Must be one of: ${THRESHOLD_LEVELS.join(', ')}\n`);
    return 2;
  }

  const levels = THRESHOLD_LEVELS.slice(0, idx + 1);
  const counts = result.violationsByImpact || result;
  const hasViolations = levels.some((level) => (counts[level] || 0) > 0);
  return hasViolations ? 1 : 0;
}
