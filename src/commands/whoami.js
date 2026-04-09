import chalk from 'chalk';
import { getApiKey, getBaseUrl } from '../api.js';

export async function whoamiCommand() {
  const apiKey = getApiKey();

  if (!apiKey) {
    console.log(chalk.dim('  Not logged in. Run "adibilis login" to authenticate.'));
    process.exit(1);
    return;
  }

  try {
    const res = await fetch(`${getBaseUrl()}/scans/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      if (res.status === 401) {
        console.log(chalk.red('  \u2718 Stored API key is invalid or expired. Run "adibilis login" to re-authenticate.'));
      } else {
        console.log(chalk.red(`  \u2718 API returned HTTP ${res.status}`));
      }
      process.exit(1);
      return;
    }

    const data = await res.json();
    console.log(chalk.green(`  \u2714 Authenticated`));
    console.log(chalk.dim(`  Plan: ${data.plan || 'free'}`));
    console.log(chalk.dim(`  Scans today: ${data.usedToday ?? '?'} / ${data.entitlements?.dailyScanLimit ?? 'unlimited'}`));
    console.log(chalk.dim(`  Key: ${apiKey.slice(0, 8)}\u2026${apiKey.slice(-4)}`));
  } catch (err) {
    console.log(chalk.red(`  \u2718 Could not reach API: ${err.message}`));
    process.exit(1);
  }
}
