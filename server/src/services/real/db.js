import { run, runSafe } from '../../lib/exec.js';

// MariaDB/MySQL administration.
//
// Production: root via unix socket (panel runs as root; unix_socket auth is
// the Ubuntu/Debian default). Dev machines (Laragon/XAMPP): the connection
// switches to TCP 127.0.0.1 with the vendor's client binary, configured via
// configureDb() after localstack detection.

const cfg = {
  bin: 'mysql',
  dumpBin: null, // resolved lazily: mariadb-dump → mysqldump
  baseArgs: ['--protocol=socket', '-uroot']
};

/** Point the driver at a specific client binary / connection mode. */
export function configureDb({ bin, dumpBin, baseArgs } = {}) {
  if (bin) cfg.bin = bin;
  if (dumpBin !== undefined) cfg.dumpBin = dumpBin;
  if (baseArgs) cfg.baseArgs = baseArgs;
}

function mysql(args, opts = {}) {
  return run(cfg.bin, [...cfg.baseArgs, '--batch', '--skip-column-names', ...args], opts);
}

function ident(name) {
  // backtick-escape a database/user identifier
  return '`' + String(name).replace(/`/g, '``') + '`';
}

async function resolveDumpBin() {
  if (cfg.dumpBin) return cfg.dumpBin;
  // prefer mariadb-dump on the server; fall back to mysqldump (MySQL, Laragon)
  const probe = await runSafe(cfg.bin, ['--version']);
  void probe;
  const candidates = ['mariadb-dump', 'mysqldump'];
  for (const c of candidates) {
    const r = await runSafe(c, ['--version']);
    if (!r.failed && /dump/i.test(r.stdout || '')) {
      cfg.dumpBin = c;
      return c;
    }
  }
  cfg.dumpBin = 'mysqldump';
  return cfg.dumpBin;
}

export default {
  async createDatabase(name) {
    // utf8mb4 with the server default collation — valid on MariaDB and MySQL 8
    await mysql(['-e', `CREATE DATABASE IF NOT EXISTS ${ident(name)} CHARACTER SET utf8mb4`]);
  },

  async dropDatabase(name) {
    await mysql(['-e', `DROP DATABASE IF EXISTS ${ident(name)}`]);
  },

  async createDbUser(name, password) {
    const pw = password.replace(/\\/g, '\\\\').replace(/'/g, "''");
    for (const host of ['localhost', '127.0.0.1']) {
      // IF NOT EXISTS alone would silently keep an old password when the user
      // already exists — always enforce the stored password afterwards.
      await mysql(['-e', `CREATE USER IF NOT EXISTS ${ident(name)}@'${host}'`]).catch(() => {});
      await mysql(['-e', `ALTER USER ${ident(name)}@'${host}' IDENTIFIED BY '${pw}'`]);
    }
  },

  async dropDbUser(name) {
    await mysql(['-e', `DROP USER IF EXISTS ${ident(name)}@'localhost'`]);
    await mysql(['-e', `DROP USER IF EXISTS ${ident(name)}@'127.0.0.1'`]).catch(() => {});
  },

  async setDbUserPassword(name, password) {
    const pw = password.replace(/\\/g, '\\\\').replace(/'/g, "''");
    for (const host of ['localhost', '127.0.0.1']) {
      // self-healing: the user may not exist on this MySQL instance (e.g. the
      // panel moved from Laragon's :3306 to its own :3307) — CREATE then ALTER
      await mysql(['-e', `CREATE USER IF NOT EXISTS ${ident(name)}@'${host}'`]).catch(() => {});
      await mysql(['-e', `ALTER USER ${ident(name)}@'${host}' IDENTIFIED BY '${pw}'`]);
    }
  },

  async grant(dbUser, dbName) {
    await mysql(['-e', `GRANT ALL PRIVILEGES ON ${ident(dbName)}.* TO ${ident(dbUser)}@'localhost'`]);
    await mysql(['-e', `GRANT ALL PRIVILEGES ON ${ident(dbName)}.* TO ${ident(dbUser)}@'127.0.0.1'`]).catch(() => {});
    await mysql(['-e', 'FLUSH PRIVILEGES']);
  },

  async revokeAll(dbUser) {
    await mysql(['-e', `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${ident(dbUser)}@'localhost'`]).catch(() => {});
    await mysql(['-e', `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${ident(dbUser)}@'127.0.0.1'`]).catch(() => {});
  },

  async listSizes() {
    const { stdout } = await runSafe(cfg.bin, [
      ...cfg.baseArgs, '--batch', '--skip-column-names', '-e',
      `SELECT table_schema, ROUND(SUM(data_length+index_length)/1024/1024, 1)
       FROM information_schema.tables
       WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
       GROUP BY table_schema`
    ]);
    const out = {};
    for (const line of (stdout || '').trim().split('\n')) {
      if (!line) continue;
      const [name, size] = line.split('\t');
      out[name] = parseFloat(size) || 0;
    }
    return out;
  },

  async dumpDatabase(name, toFile) {
    // Identifier is panel-generated (^[a-z][a-z0-9_]*$, validated on create);
    // JSON.stringify quotes it safely for the redirect.
    const dump = await resolveDumpBin();
    await run('sh', ['-c', `${JSON.stringify(dump)} ${cfg.baseArgs.map((a) => JSON.stringify(a)).join(' ')} --single-transaction --quick ${JSON.stringify(name)} > ${JSON.stringify(toFile)}`], { timeout: 600000 });
  },

  async serverVersion() {
    const { stdout } = await runSafe(cfg.bin, [...cfg.baseArgs, '--skip-column-names', '-e', 'SELECT VERSION()']);
    return (stdout || '').trim() || null;
  }
};
