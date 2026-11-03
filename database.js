const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = process.env.DATABASE_PATH || path.join(__dirname,'data','playerok-garant.sqlite');
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY, telegram_id TEXT UNIQUE NOT NULL, username TEXT, first_name TEXT NOT NULL DEFAULT '',
 photo_url TEXT, created_at TEXT DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS balances(
 user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, currency TEXT,
 amount REAL NOT NULL DEFAULT 0 CHECK(amount>=0), PRIMARY KEY(user_id,currency)
);
CREATE TABLE IF NOT EXISTS deals(
 id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, creator_id INTEGER REFERENCES users(id),
 counterparty_telegram TEXT, counterparty_id INTEGER REFERENCES users(id),
 buyer_id INTEGER REFERENCES users(id), seller_id INTEGER REFERENCES users(id),
 role_creator TEXT NOT NULL, title TEXT NOT NULL, item_url TEXT NOT NULL,
 description TEXT DEFAULT '', amount REAL NOT NULL, currency TEXT NOT NULL,
 invite_token TEXT UNIQUE NOT NULL, invite_mode TEXT DEFAULT 'manual',
 status TEXT DEFAULT 'Ожидает продавца', proof_url TEXT,
 created_at TEXT DEFAULT(datetime('now')), updated_at TEXT DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS ledger(
 id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), kind TEXT, currency TEXT,
 amount REAL, status TEXT, note TEXT, created_at TEXT DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS admins(telegram_id TEXT PRIMARY KEY, granted_by TEXT, created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS reviews(
 id INTEGER PRIMARY KEY, deal_id INTEGER REFERENCES deals(id), author_id INTEGER REFERENCES users(id),
 target_id INTEGER REFERENCES users(id), rating INTEGER CHECK(rating BETWEEN 1 AND 5), comment TEXT,
 created_at TEXT DEFAULT(datetime('now')), UNIQUE(deal_id,author_id)
);
CREATE TABLE IF NOT EXISTS giveaways(
 id INTEGER PRIMARY KEY, title TEXT NOT NULL, prize TEXT NOT NULL, ends_at TEXT, status TEXT DEFAULT 'active',
 created_at TEXT DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS giveaway_entries(
 giveaway_id INTEGER REFERENCES giveaways(id), user_id INTEGER REFERENCES users(id),
 created_at TEXT DEFAULT(datetime('now')), PRIMARY KEY(giveaway_id,user_id)
);
CREATE TABLE IF NOT EXISTS daily_claims(
 user_id INTEGER REFERENCES users(id), claim_date TEXT, amount REAL,
 PRIMARY KEY(user_id,claim_date)
);
CREATE TABLE IF NOT EXISTS audit(
 id INTEGER PRIMARY KEY, admin_id TEXT, action TEXT, target TEXT, details TEXT,
 created_at TEXT DEFAULT(datetime('now'))
);
`);
const currencies=['RUB','UAH','BYN','TON','XTR'];
function ensureUser(tg){
 const id=String(tg.id);
 let u=db.prepare('SELECT * FROM users WHERE telegram_id=?').get(id);
 if(!u){
  const info=db.prepare('INSERT INTO users(telegram_id,username,first_name,photo_url) VALUES(?,?,?,?)').run(id,tg.username||null,tg.first_name||'Пользователь',tg.photo_url||null);
  u=db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  const add=db.prepare('INSERT OR IGNORE INTO balances(user_id,currency,amount) VALUES(?,?,0)');
  currencies.forEach(c=>add.run(u.id,c));
 } else {
  db.prepare('UPDATE users SET username=?,first_name=?,photo_url=? WHERE id=?').run(tg.username||null,tg.first_name||'Пользователь',tg.photo_url||null,u.id);
  u=db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
 }
 return u;
}
module.exports={db,ensureUser,currencies};
