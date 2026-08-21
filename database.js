const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const db = new Database(path.join(__dirname, 'keys.db'));

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    key TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL,
    username TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked INTEGER DEFAULT 0,
    revoked_at INTEGER,
    hwid TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_discord_id ON keys(discord_id);
  CREATE INDEX IF NOT EXISTS idx_revoked ON keys(revoked);
`);

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segments = [];
  for (let s = 0; s < 4; s++) {
    let seg = '';
    for (let i = 0; i < 4; i++) {
      seg += chars[crypto.randomInt(chars.length)];
    }
    segments.push(seg);
  }
  return 'SKY-' + segments.join('-');
}

function createKey(discordId, username, expiresInDays = 30) {
  const existing = db.prepare(`
    SELECT key FROM keys WHERE discord_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)
  `).get(discordId, Date.now());
  if (existing) return existing.key;

  const key = generateKey();
  const now = Date.now();
  const expiresAt = expiresInDays ? now + expiresInDays * 86400000 : null;

  db.prepare(`
    INSERT INTO keys (key, discord_id, username, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(key, discordId, username, now, expiresAt);

  return key;
}

function validateKey(key, hwid) {
  const row = db.prepare(`
    SELECT * FROM keys WHERE key = ? AND revoked = 0
  `).get(key);

  if (!row) return { valid: false, message: 'Invalid key' };
  if (row.expires_at && row.expires_at < Date.now()) {
    return { valid: false, message: 'Key has expired' };
  }

  if (hwid && hwid !== 'unknown') {
    if (row.hwid && row.hwid !== hwid) {
      return { valid: false, message: 'Key is bound to another device' };
    }
    if (!row.hwid) {
      db.prepare('UPDATE keys SET hwid = ? WHERE key = ?').run(hwid, key);
    }
  }

  return {
    valid: true,
    message: 'Key valid',
    discord_id: row.discord_id,
    username: row.username,
  };
}

function revokeKey(key) {
  return db.prepare(`
    UPDATE keys SET revoked = 1, revoked_at = ? WHERE key = ?
  `).run(Date.now(), key);
}

function revokeAllForUser(discordId) {
  return db.prepare(`
    UPDATE keys SET revoked = 1, revoked_at = ? WHERE discord_id = ? AND revoked = 0
  `).run(Date.now(), discordId);
}

function getActiveKeys() {
  return db.prepare(`
    SELECT * FROM keys WHERE revoked = 0
  `).all();
}

function getKeysByDiscordId(discordId) {
  return db.prepare(`
    SELECT * FROM keys WHERE discord_id = ? ORDER BY created_at DESC
  `).all(discordId);
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM keys').get().c;
  const active = db.prepare('SELECT COUNT(*) as c FROM keys WHERE revoked = 0').get().c;
  const revoked = total - active;
  const hwidBound = db.prepare('SELECT COUNT(*) as c FROM keys WHERE hwid IS NOT NULL AND revoked = 0').get().c;
  return { total, active, revoked, hwidBound };
}

function getAllKeys() {
  return db.prepare('SELECT * FROM keys ORDER BY created_at DESC').all();
}

function searchKeys(query) {
  const q = '%' + query + '%';
  return db.prepare(`
    SELECT * FROM keys WHERE key LIKE ? OR discord_id LIKE ? OR username LIKE ? OR hwid LIKE ?
    ORDER BY created_at DESC
  `).all(q, q, q, q);
}

function resetHwid(key) {
  return db.prepare('UPDATE keys SET hwid = NULL WHERE key = ?').run(key);
}

module.exports = {
  createKey,
  validateKey,
  revokeKey,
  revokeAllForUser,
  getActiveKeys,
  getKeysByDiscordId,
  getStats,
  getAllKeys,
  searchKeys,
  resetHwid,
  generateKey,
};
