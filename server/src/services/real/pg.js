import { run, runSafe } from '../../lib/exec.js';

// PostgreSQL administration via the postgres superuser account.

function psql(sql, opts = {}) {
  return run('sudo', ['-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-c', sql], opts);
}

function ident(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function literal(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

export default {
  async createDatabase(name) {
    await psql(`CREATE DATABASE ${ident(name)}`);
  },

  async dropDatabase(name) {
    // terminate connections first
    await psql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${literal(name)} AND pid <> pg_backend_pid()`
    ).catch(() => {});
    await psql(`DROP DATABASE IF EXISTS ${ident(name)}`);
  },

  async createDbUser(name, password) {
    await psql(`CREATE ROLE ${ident(name)} LOGIN PASSWORD ${literal(password)}`);
  },

  async dropDbUser(name) {
    await psql(`DROP ROLE IF EXISTS ${ident(name)}`).catch(() => {});
  },

  async setDbUserPassword(name, password) {
    await psql(`ALTER ROLE ${ident(name)} WITH LOGIN PASSWORD ${literal(password)}`);
  },

  async grant(dbUser, dbName) {
    await psql(`GRANT ALL PRIVILEGES ON DATABASE ${ident(dbName)} TO ${ident(dbUser)}`);
  },

  async revokeAll(dbUser, dbName) {
    await psql(`REVOKE ALL PRIVILEGES ON DATABASE ${ident(dbName)} FROM ${ident(dbUser)}`).catch(() => {});
  },

  async listSizes() {
    const { stdout } = await runSafe('sudo', [
      '-u', 'postgres', 'psql', '-t', '-A', '-c',
      "SELECT datname, pg_database_size(datname) FROM pg_database WHERE datistemplate = false"
    ]);
    const out = {};
    for (const line of (stdout || '').trim().split('\n')) {
      if (!line) continue;
      const [name, size] = line.split('|');
      if (name) out[name] = Math.round((parseInt(size, 10) || 0) / 1024 / 1024 * 10) / 10;
    }
    return out;
  },

  async dumpDatabase(name, toFile) {
    // Identifier is panel-generated (^[a-z][a-z0-9_]*$); JSON.stringify quotes it for the shell.
    await run('sh', ['-c', `sudo -u postgres pg_dump ${JSON.stringify(name)} > ${JSON.stringify(toFile)}`], { timeout: 600000 });
  },

  async serverVersion() {
    const { stdout } = await runSafe('sudo', ['-u', 'postgres', 'psql', '-t', '-A', '-c', 'SHOW server_version']);
    return stdout ? `PostgreSQL ${stdout.trim()}` : null;
  }
};
