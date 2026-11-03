require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Telegraf, Markup } = require('telegraf');
const { db, ensureUser, currencies } = require('./database');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const DEV_AUTH_BYPASS = process.env.DEV_AUTH_BYPASS === 'true' && process.env.NODE_ENV !== 'production';
const statuses = ['Ожидает подтверждения','Ожидает оплаты','Оплата подтверждена администратором','Товар передан','Покупатель подтвердил получение','Сделка завершена','Открыт спор','Сделка заморожена','Сделка отменена'];

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://telegram.org'], styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], frameAncestors: ['https://web.telegram.org', 'https://*.telegram.org']
}}, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

function verifyInitData(initData) {
  if (DEV_AUTH_BYPASS) return { id: 999999999, first_name: 'Dev', username: 'developer' };
  if (!BOT_TOKEN || !initData || typeof initData !== 'string' || initData.length > 8192) throw new Error('Не удалось проверить Telegram-сессию');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !Number.isFinite(authDate) || Math.abs(Date.now()/1000 - authDate) > 86400) throw new Error('Сессия Telegram устарела');
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(calculated, 'hex'); const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) throw new Error('Недействительная подпись Telegram');
  const userRaw = params.get('user');
  if (!userRaw) throw new Error('В Telegram не найден пользователь');
  const user = JSON.parse(userRaw);
  if (!user.id) throw new Error('Некорректный Telegram ID');
  return user;
}
function auth(req,res,next) {
  try {
    const raw = req.headers.authorization || '';
    const initData = raw.startsWith('tma ') ? raw.slice(4) : '';
    const tg = verifyInitData(initData);
    req.tg = tg;
    req.user = ensureUser(tg);
    req.isAdmin = ADMIN_IDS.has(String(tg.id));
    next();
  } catch (e) { res.status(401).json({ error: e.message || 'Требуется авторизация через Telegram' }); }
}
function admin(req,res,next) { if (!req.isAdmin) return res.status(403).json({error:'Доступ запрещён'}); next(); }
function cleanText(v,max=500) { return String(v ?? '').trim().slice(0,max); }
function makeCode() { return 'PG-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function audit(adminId, action, type, id, details={}) {
  db.prepare('INSERT INTO admin_audit(admin_telegram_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)')
    .run(String(adminId), action, type, String(id), JSON.stringify(details));
}
function userPublic(u) { return { telegram_id:u.telegram_id, username:u.username, first_name:u.first_name, photo_url:u.photo_url }; }
function dealForUser(deal, uid) {
  return { ...deal, role: deal.buyer_id === uid ? 'Покупатель' : deal.seller_id === uid ? 'Продавец' : (deal.creator_id === uid ? 'Создатель' : 'Участник') };
}

app.get('/api/me', auth, (req,res) => {
  const balances = db.prepare('SELECT currency,amount FROM balances WHERE user_id=?').all(req.user.id);
  const operations = db.prepare('SELECT id,kind,currency,amount,status,note,created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.user.id);
  res.json({ user:userPublic(req.user), balances, operations, isAdmin:req.isAdmin });
});
app.get('/api/deals', auth, (req,res) => {
  const rows = db.prepare(`SELECT * FROM deals WHERE creator_id=? OR counterparty_id=? ORDER BY id DESC`).all(req.user.id,req.user.id);
  res.json(rows.map(d=>dealForUser(d,req.user.id)));
});
app.post('/api/deals', auth, (req,res) => {
  const title=cleanText(req.body.title,100), description=cleanText(req.body.description,1000), amount=Number(req.body.amount), currency=String(req.body.currency||'');
  const target=cleanText(req.body.counterparty,100).replace(/^@/,'');
  if(title.length<3 || !Number.isFinite(amount) || amount<=0 || amount>1e12 || !currencies.includes(currency)) return res.status(400).json({error:'Проверьте название, сумму и валюту'});
  if(!target) return res.status(400).json({error:'Укажите Telegram ID или username второго участника'});
  const code=makeCode(), token=crypto.randomBytes(18).toString('hex');
  const telegramTarget=target;
  const matched=byId ? db.prepare('SELECT id FROM users WHERE telegram_id=?').get(target) : db.prepare('SELECT id FROM users WHERE lower(username)=lower(?)').get(target);
  const info=db.prepare(`INSERT INTO deals(code,creator_id,counterparty_telegram,counterparty_id,title,description,amount,currency,status,invite_token)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(code,req.user.id,telegramTarget,matched?.id||null,title,description,amount,currency,'Ожидает подтверждения',token);
  res.status(201).json({id:info.lastInsertRowid,code,invite_token:token,invite_url:APP_URL?`${APP_URL}/?join=${token}`:`/?join=${token}`});
});
app.post('/api/deals/join', auth, (req,res) => {
  const token=cleanText(req.body.token,100), role=req.body.role;
  if(!['buyer','seller'].includes(role)) return res.status(400).json({error:'Выберите роль покупателя или продавца'});
  const d=db.prepare('SELECT * FROM deals WHERE invite_token=?').get(token);
  if(!d) return res.status(404).json({error:'Приглашение не найдено'});
  if(d.creator_id===req.user.id) return res.status(400).json({error:'Создатель сделки не может присоединиться сам к себе'});
  if(d.counterparty_telegram && d.counterparty_telegram!==String(req.tg.id) && d.counterparty_telegram!==req.tg.username) return res.status(403).json({error:'Приглашение предназначено другому участнику'});
  if(d.counterparty_id && d.counterparty_id!==req.user.id) return res.status(409).json({error:'В сделке уже есть второй участник'});
  const creatorRole = role==='buyer'?'seller':'buyer';
  const buyer=role==='buyer'?req.user.id:d.creator_id, seller=role==='seller'?req.user.id:d.creator_id;
  db.prepare(`UPDATE deals SET counterparty_id=?,buyer_id=?,seller_id=?,status='Ожидает оплаты',updated_at=datetime('now') WHERE id=?`)
    .run(req.user.id,buyer,seller,d.id);
  res.json({ok:true,deal:db.prepare('SELECT * FROM deals WHERE id=?').get(d.id)});
});
app.post('/api/deals/:id/received', auth, (req,res) => {
  const d=db.prepare('SELECT * FROM deals WHERE id=?').get(Number(req.params.id));
  if(!d || (d.creator_id!==req.user.id && d.counterparty_id!==req.user.id)) return res.status(404).json({error:'Сделка не найдена'});
  if(d.buyer_id!==req.user.id) return res.status(403).json({error:'Подтвердить получение может только покупатель'});
  if(d.status!=='Товар передан' && d.status!=='Оплата подтверждена администратором') return res.status(409).json({error:'Сейчас нельзя подтвердить получение'});
  db.prepare(`UPDATE deals SET status='Покупатель подтвердил получение',updated_at=datetime('now') WHERE id=?`).run(d.id);
  res.json({ok:true});
});
app.post('/api/deals/:id/dispute', auth, (req,res) => {
  const d=db.prepare('SELECT * FROM deals WHERE id=?').get(Number(req.params.id));
  if(!d || (d.creator_id!==req.user.id && d.counterparty_id!==req.user.id)) return res.status(404).json({error:'Сделка не найдена'});
  if(['Сделка завершена','Сделка отменена'].includes(d.status)) return res.status(409).json({error:'По завершённой или отменённой сделке спор не открывается'});
  const reason=cleanText(req.body.reason,1000); if(reason.length<5) return res.status(400).json({error:'Опишите причину спора'});
  const tx=db.transaction(()=>{db.prepare('INSERT INTO disputes(deal_id,opened_by,reason) VALUES(?,?,?)').run(d.id,req.user.id,reason);db.prepare(`UPDATE deals SET status='Открыт спор',updated_at=datetime('now') WHERE id=?`).run(d.id);}); tx();
  res.json({ok:true});
});
app.get('/api/admin/overview', auth, admin, (req,res) => {
  const users=db.prepare('SELECT id,telegram_id,username,first_name,created_at FROM users ORDER BY id DESC LIMIT 500').all();
  const deals=db.prepare(`SELECT d.*,u.telegram_id AS creator_telegram FROM deals d JOIN users u ON u.id=d.creator_id ORDER BY d.id DESC LIMIT 500`).all();
  const ledger=db.prepare(`SELECT l.*,u.telegram_id,u.username FROM ledger l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 500`).all();
  const disputes=db.prepare(`SELECT s.*,d.code FROM disputes s JOIN deals d ON d.id=s.deal_id ORDER BY s.id DESC LIMIT 200`).all();
  const auditRows=db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 200').all();
  res.json({users,deals,ledger,disputes,audit:auditRows,statuses});
});
app.post('/api/admin/deals/:id/status', auth, admin, (req,res) => {
  const id=Number(req.params.id), status=cleanText(req.body.status,80), d=db.prepare('SELECT * FROM deals WHERE id=?').get(id);
  if(!d) return res.status(404).json({error:'Сделка не найдена'});
  if(!statuses.includes(status)) return res.status(400).json({error:'Недопустимый статус'});
  if(status==='Оплата подтверждена администратором') return res.status(409).json({error:'Подтверждение оплаты отключено до подключения платёжного провайдера и проверки подписанного webhook. Ручной ввод ID транзакции не подтверждает платёж.'});
  if(status==='Товар передан' && d.status!=='Оплата подтверждена администратором') return res.status(409).json({error:'Нельзя отметить передачу товара до подтверждённой оплаты.'});
  if(status==='Сделка завершена' && d.status!=='Покупатель подтвердил получение') return res.status(409).json({error:'Сделка завершается только после подтверждения получения покупателем.'});
  if(status==='Ожидает оплаты' && !d.counterparty_id) return res.status(409).json({error:'Сначала должен присоединиться второй участник.'});
  db.prepare('UPDATE deals SET status=?,updated_at=datetime(\'now\') WHERE id=?').run(status,id);
  audit(req.tg.id,'Изменён статус сделки','deal',id,{from:d.status,to:status});
  res.json({ok:true});
});
app.post('/api/admin/disputes/:id/resolve', auth, admin, (req,res) => {
  const id=Number(req.params.id), resolution=cleanText(req.body.resolution,1000);
  const dispute=db.prepare('SELECT * FROM disputes WHERE id=?').get(id); if(!dispute) return res.status(404).json({error:'Спор не найден'});
  if(resolution.length<5) return res.status(400).json({error:'Укажите решение'});
  db.transaction(()=>{
    db.prepare(`UPDATE disputes SET status='Решён',resolution=?,updated_at=datetime('now') WHERE id=?`).run(resolution,id);
    db.prepare(`UPDATE deals SET status='Сделка заморожена',updated_at=datetime('now') WHERE id=?`).run(dispute.deal_id);
    audit(req.tg.id,'Разрешён спор','dispute',id,{resolution});
  })(); res.json({ok:true});
});
app.post('/api/admin/ledger/credit', auth, admin, (req,res) => {
  // This is an explicitly internal, non-cash accounting adjustment; never use it to claim a real deposit.
  const telegramId=cleanText(req.body.telegram_id,30), currency=String(req.body.currency||''), amount=Number(req.body.amount), note=cleanText(req.body.note,300);
  if(!currencies.includes(currency)||!Number.isFinite(amount)||amount<=0||amount>1e9||note.length<5) return res.status(400).json({error:'Некорректные параметры учётной корректировки'});
  const user=db.prepare('SELECT * FROM users WHERE telegram_id=?').get(telegramId); if(!user) return res.status(404).json({error:'Пользователь не найден'});
  const key='admin-credit:'+crypto.randomUUID();
  db.transaction(()=>{
    db.prepare('UPDATE balances SET amount=amount+? WHERE user_id=? AND currency=?').run(amount,user.id,currency);
    db.prepare(`INSERT INTO ledger(user_id,kind,currency,amount,status,idempotency_key,note) VALUES(?,?,?,?,?,?,?)`).run(user.id,'Корректировка учёта',currency,amount,'внутренняя запись',key,note);
    audit(req.tg.id,'Внутренняя корректировка учёта','user',telegramId,{currency,amount,note});
  })(); res.json({ok:true,warning:'Это внутренняя учётная запись, не подтверждение реального платежа.'});
});
app.get('/health', (req,res)=>res.json({service:'Playerok Garant',status:'running'}));
app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

let bot;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  const miniAppButton = Markup.button.webApp('Открыть Playerok Garant', APP_URL || 'https://example.com');
  bot.start(async (ctx) => {
    const text='Добро пожаловать в Playerok Garant!\n\nСоздавайте сделки, приглашайте вторую сторону и отслеживайте этапы сделки в Mini App. Внутренний баланс является учётным и сам по себе не означает получение денежных средств.';
    const keyboard=Markup.inlineKeyboard([[miniAppButton],[Markup.button.callback('Мои сделки','my_deals'),Markup.button.callback('Мой баланс','my_balance')],[Markup.button.url('Поддержка','https://t.me/telegram')]]);
    const photo=process.env.WELCOME_PHOTO_URL;
    if(photo && /^https:\/\//.test(photo)) await ctx.replyWithPhoto(photo,{caption:text,reply_markup:keyboard.reply_markup});
    else await ctx.reply(text,keyboard);
  });
  bot.action('my_deals',ctx=>ctx.answerCbQuery('Откройте Mini App → Мои сделки'));
  bot.action('my_balance',ctx=>ctx.answerCbQuery('Откройте Mini App → Профиль'));
  bot.catch(err=>console.error('Telegram bot error:',err));
  bot.launch().then(()=>console.log('Telegram bot started')).catch(err=>console.error('Bot launch failed:',err));
} else console.warn('BOT_TOKEN is empty: HTTP server will run, Telegram bot is disabled.');

const server=app.listen(PORT,()=>console.log(`Playerok Garant listening on ${PORT}`));
async function shutdown(){server.close();if(bot) await bot.stop('SIGTERM');db.close();process.exit(0);}
process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
