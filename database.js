const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'playerok-garant.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  photo_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS balances (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK(currency IN ('RUB','UAH','BYN','TON','XTR')),
  amount REAL NOT NULL DEFAULT 0 CHECK(amount >= 0),
  PRIMARY KEY(user_id, currency)
);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  counterparty_telegram TEXT,
  counterparty_id INTEGER REFERENCES users(id),
  buyer_id INTEGER REFERENCES users(id),
  seller_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL CHECK(currency IN ('RUB','UAH','BYN','TON','XTR')),
  status TEXT NOT NULL DEFAULT 'Ожидает подтверждения',
  invite_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  deal_id INTEGER REFERENCES deals(id),
  kind TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'учётная запись',
  idempotency_key TEXT NOT NULL UNIQUE,
  external_reference TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_telegram_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  opened_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Открыт',
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deals_creator ON deals(creator_id);
CREATE INDEX IF NOT EXISTS idx_deals_counterparty ON deals(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id);
`);

const currencies = ['RUB','UAH','BYN','TON','XTR'];
const ensureUser = db.transaction((tg) => {
  const telegramId = String(tg.id);
  const existing = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(telegramId);
  if (existing) {
    db.prepare(`UPDATE users SET username=?, first_name=?, photo_url=?, updated_at=datetime('now') WHERE id=?`)
      .run(tg.username || null, tg.first_name || '', tg.photo_url || null, existing.id);
    return db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);
  }
  const info = db.prepare('INSERT INTO users(telegram_id, username, first_name, photo_url) VALUES(?,?,?,?)')
    .run(telegramId, tg.username || null, tg.first_name || '', tg.photo_url || null);
  const insertBalance = db.prepare('INSERT INTO balances(user_id,currency,amount) VALUES(?,?,0)');
  for (const c of currencies) insertBalance.run(info.lastInsertRowid, c);
  return db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
});

module.exports = { db, ensureUser, currencies };
