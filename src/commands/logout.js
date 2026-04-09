import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';

const CONFIG_FILE = path.join(os.homedir(), '.adibilis', 'config.json');

export async function logoutCommand() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
      console.log(chalk.green('  \u2714 Logged out. API key removed from ~/.adibilis/config.json'));
    } else {
      console.log(chalk.dim('  No stored credentials found.'));
    }
  } catch (err) {
    console.log(chalk.red(`  \u2718 Could not remove credentials: ${err.message}`));
    process.exit(1);
  }
}
