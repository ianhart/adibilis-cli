import { Command } from 'commander';
import { scanCommand } from './commands/scan.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { whoamiCommand } from './commands/whoami.js';
import { initCommand } from './commands/init.js';

export function createProgram() {
  const program = new Command();

  program
    .name('adibilis')
    .description('Scan websites for WCAG 2.2 AA accessibility violations')
    .version('0.1.0');

  program
    .command('scan <url>')
    .description('Scan a URL for accessibility violations')
    .option('--fix', 'Show generated fix patches')
    .option('--report', 'Generate HTML report and open in browser')
    .option('--json', 'Output results as JSON (for CI integration)')
    .option('--threshold <level>', 'Exit code 1 if violations exceed level (critical/serious/moderate/minor)')
    .option('--api-key <key>', 'Adibilis API key (or ADIBILIS_API_KEY env var)')
    .option('--pages <n>', 'Max pages to scan (default 1)', parseInt)
    .option('--ignore <rules>', 'Comma-separated rule IDs to ignore')
    .option('--config <path>', 'Path to .adibilis.yml config file')
    .action(scanCommand);

  program
    .command('login')
    .description('Authenticate with your Adibilis API key')
    .action(loginCommand);

  program
    .command('logout')
    .description('Remove stored API key')
    .action(logoutCommand);

  program
    .command('whoami')
    .description('Show current authentication status and plan')
    .action(whoamiCommand);

  program
    .command('init')
    .description('Create .adibilis.yml in the current directory')
    .action(initCommand);

  return program;
}

export function run(argv) {
  const program = createProgram();
  program.parse(argv);
}
