import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { runSafe } from './exec.js';

/**
 * Laravel support helpers (cross-platform).
 *  - composer bootstrap (official composer.phar into the panel stack)
 *  - one-shot setup: composer install, key:generate, permissions
 *  - run any artisan command against the site's project root
 *
 * The site docroot for Laravel is <site>/public; the project root is its
 * parent directory.
 */

const composerPath = () => path.join(config.stackDir || config.dataDir, 'composer.phar');

/** Ensure composer.phar exists in the panel stack. */
export async function ensureComposer() {
  const dest = composerPath();
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) return dest;
  const res = await fetch('https://getcomposer.org/download/latest-stable/composer.phar');
  if (!res.ok) throw new Error(`composer download failed (${res.status})`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function phpBin() {
  const { findPhpCandidates } = await import('./localstack.js');
  const list = await findPhpCandidates();
  if (!list.length) throw new Error('No PHP found on this machine');
  return list[0];
}

function run(cmd, args, cwd, timeout = 600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output: out }));
    setTimeout(() => { try { child.kill(); } catch {} reject(new Error('command timed out')); }, timeout);
  });
}

/**
 * Full Laravel bring-up for an uploaded project:
 *   composer install → .env check → key:generate → storage/cache perms →
 *   (optional) migrate --force when requested.
 */
export async function runLaravelSetup(siteDocroot, { migrate = false } = {}) {
  const projectRoot = path.resolve(siteDocroot, '..'); // docroot = <project>/public
  const php = await phpBin();
  const composer = await ensureComposer();
  const steps = [];
  const artisan = path.join(projectRoot, 'artisan');

  if (!fs.existsSync(artisan)) {
    throw new Error(`No artisan found in ${projectRoot} — is this a Laravel project uploaded with public/ inside?`);
  }

  if (fs.existsSync(path.join(projectRoot, 'composer.json'))) {
    const r = await run('php', [composer, 'install', '--no-interaction'], projectRoot);
    steps.push({ step: 'composer install', code: r.code, output: r.output.slice(-800) });
  }

  if (!fs.existsSync(path.join(projectRoot, '.env')) && fs.existsSync(path.join(projectRoot, '.env.example'))) {
    fs.copyFileSync(path.join(projectRoot, '.env.example'), path.join(projectRoot, '.env'));
    steps.push({ step: '.env created from .env.example' });
  }

  if (fs.existsSync(artisan)) {
    const key = await run(php, ['artisan', 'key:generate', '--force'], projectRoot);
    steps.push({ step: 'key:generate', code: key.code, output: key.output.slice(-300) });
  }

  // storage + bootstrap/cache permissions and structure
  for (const rel of ['storage/framework/cache', 'storage/framework/sessions', 'storage/framework/views', 'storage/app/public', 'storage/logs', 'bootstrap/cache']) {
    fs.mkdirSync(path.join(projectRoot, rel), { recursive: true });
  }
  if (process.platform === 'win32') {
    for (const rel of ['storage', 'bootstrap/cache']) {
      await runSafe('icacls', [path.join(projectRoot, rel), '/grant', 'Everyone:(OI)(CI)F', '/T'], { timeout: 60000 });
    }
  } else {
    for (const rel of ['storage', 'bootstrap/cache']) {
      await runSafe('chmod', ['-R', '775', path.join(projectRoot, rel)]);
    }
  }
  steps.push({ step: 'permissions' });

  if (migrate && fs.existsSync(artisan)) {
    const mig = await run(php, ['artisan', 'migrate', '--force'], projectRoot);
    steps.push({ step: 'migrate', code: mig.code, output: mig.output.slice(-800) });
  }

  return { steps };
}

/** Run an artisan command in the project root (docroot/..). */
export async function runArtisan(siteDocroot, command) {
  const projectRoot = path.resolve(siteDocroot, '..');
  const php = await phpBin();
  if (!fs.existsSync(path.join(projectRoot, 'artisan'))) {
    throw new Error(`No artisan found in ${projectRoot}`);
  }
  const args = ['artisan', ...command.split(/\s+/)];
  const r = await run(php, args, projectRoot);
  return { output: r.output, code: r.code };
}

