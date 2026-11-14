import { db } from '../dist/db.js';
import { scryptHash } from '../dist/util.js';

const pw = process.argv[2];
if (!pw || pw.length < 8) {
  console.error('Usage: set-password.bat <new password of at least 8 characters>');
  process.exit(1);
}
const row = db.prepare(`SELECT id FROM users WHERE is_operator=1`).get();
if (!row) {
  console.error('No operator account yet. Start the server once first.');
  process.exit(1);
}
db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(scryptHash(pw), row.id);
console.log('Operator password updated.');
