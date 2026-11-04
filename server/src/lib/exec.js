import { execFile } from 'node:child_process';

/**
 * Run a command with argument array (never a shell string) as root.
 * Rejects with a readable error including stderr.
 */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: opts.timeout || 30000,
      maxBuffer: opts.maxBuffer || 16 * 1024 * 1024,
      encoding: 'utf8',
      ...opts
    }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`${cmd}${args.length ? ' ' + args.join(' ') : ''} failed: ${(stderr || stdout || err.message || '').trim().slice(0, 800)}`);
        e.code = err.code;
        e.stdout = stdout;
        e.stderr = stderr;
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Run a command tolerating failure (e.g. `systemctl is-active` returns 3). */
export async function runSafe(cmd, args = [], opts = {}) {
  try {
    return await run(cmd, args, opts);
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', failed: true };
  }
}
