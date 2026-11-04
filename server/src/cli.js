// G-Panel maintenance CLI (used by the installer and for recovery):
//   node cli.js set-setting <key> <value>
//   node cli.js get-setting <key>
//   node cli.js reset-admin-password [newPassword]
//   node cli.js list-users

import { migrate, db, setSetting, getSetting } from './db/index.js';
import { hashPassword } from './lib/passwords.js';

migrate();

const [, , cmd, ...args] = process.argv;

switch (cmd) {
  case 'set-setting': {
    if (args.length < 2) { console.error('usage: set-setting <key> <value>'); process.exit(1); }
    setSetting(args[0], args[1]);
    console.log(`ok: ${args[0]} = ${args[1]}`);
    break;
  }
  case 'get-setting': {
    console.log(getSetting(args[0]) ?? '');
    break;
  }
  case 'reset-admin-password': {
    const pw = args[0] || generate();
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    if (!admin) { console.error('no admin user found'); process.exit(1); }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), admin.id);
    console.log(`admin password reset to: ${pw}`);
    break;
  }
  case 'list-users': {
    for (const u of db.prepare('SELECT id, username, email, role FROM users ORDER BY id').all()) {
      console.log(`${u.id}\t${u.username}\t${u.email}\t${u.role}`);
    }
    break;
  }
  default:
    console.log('G-Panel CLI — commands: set-setting, get-setting, reset-admin-password, list-users');
}

function generate() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
