require('dotenv').config();
const crypto=require('crypto'),path=require('path'),fs=require('fs');
const express=require('express'),helmet=require('helmet'),rateLimit=require('express-rate-limit');
const {Telegraf,Markup}=require('telegraf');
const {db,ensureUser,currencies}=require('./database');
const app=express(),PORT=Number(process.env.PORT||3000);
const BOT_TOKEN=process.env.BOT_TOKEN||'',APP_URL=(process.env.APP_URL||'https://playerok424-zwwb.onrender.com').replace(/\/$/,'');
const ROOT_ADMINS=new Set((process.env.ADMIN_IDS||'').split(',').map(x=>x.trim()).filter(Boolean));
const dataDir=process.env.DATA_DIR||path.join(__dirname,'data');
const uploads=path.join(dataDir,'uploads');fs.mkdirSync(uploads,{recursive:true});
const legacyUploads=path.join(__dirname,'uploads');if(path.resolve(legacyUploads)!==path.resolve(uploads)&&fs.existsSync(legacyUploads)){try{for(const name of fs.readdirSync(legacyUploads)){const from=path.join(legacyUploads,name),to=path.join(uploads,name);if(fs.statSync(from).isFile()&&!fs.existsSync(to))fs.copyFileSync(from,to)}}catch(e){console.error('Upload migration failed:',e.message)}}
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'",'https://telegram.org'],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'","data:",'https:'],connectSrc:["'self'"],frameAncestors:['https://web.telegram.org','https://*.telegram.org']}},crossOriginEmbedderPolicy:false}));
app.use(express.json({limit:'3mb'}));app.use('/uploads',express.static(uploads));
app.use('/api',rateLimit({windowMs:60000,limit:100,standardHeaders:'draft-7',legacyHeaders:false}));
app.use(express.static(path.join(__dirname,'public')));
function verify(initData){
 if(process.env.DEV_AUTH_BYPASS==='true'&&process.env.NODE_ENV!=='production')return{id:999999999,first_name:'Тест',username:'test_user'};
 if(!BOT_TOKEN||!initData)throw Error('Откройте Mini App через Telegram-бота');
 const p=new URLSearchParams(initData),hash=p.get('hash'),date=Number(p.get('auth_date'));
 if(!hash||!date||Math.abs(Date.now()/1000-date)>86400)throw Error('Сессия Telegram устарела');
 p.delete('hash');const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const secret=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
 const calc=crypto.createHmac('sha256',secret).update(check).digest('hex');
 const a=Buffer.from(calc,'hex'),b=Buffer.from(hash,'hex');
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw Error('Недействительная подпись Telegram');
 const user=JSON.parse(p.get('user')||'{}');if(!user.id)throw Error('Пользователь Telegram не найден');return user;
}
function auth(req,res,next){try{const h=req.headers.authorization||'';req.tg=verify(h.startsWith('tma ')?h.slice(4):'');req.user=ensureUser(req.tg);req.isAdmin=ROOT_ADMINS.has(String(req.tg.id))||!!db.prepare('SELECT 1 FROM admins WHERE telegram_id=?').get(String(req.tg.id));next()}catch(e){res.status(401).json({error:e.message})}}
function admin(req,res,next){if(!req.isAdmin)return res.status(403).json({error:'Нет прав администратора'});next()}
function rootAdmin(req,res,next){if(!ROOT_ADMINS.has(String(req.tg.id)))return res.status(403).json({error:'Только главный администратор может управлять правами администраторов'});next()}
const clean=(v,n=500)=>String(v??'').trim().slice(0,n);
const code=()=>`PG-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
function notify(id,text,extra){if(!bot||!id)return;bot.telegram.sendMessage(id,text,extra).catch(e=>console.error('notify:',e.message))}
function publicUser(u){return{telegram_id:u.telegram_id,username:u.username,first_name:u.first_name,photo_url:u.photo_url}}
app.get('/health',(q,s)=>s.json({service:'Playerok Garant',status:'running'}));
app.get('/api/me',auth,(q,s)=>{
 const balances=db.prepare('SELECT currency,amount FROM balances WHERE user_id=?').all(q.user.id);
 const operations=db.prepare('SELECT * FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 25').all(q.user.id);
 const stats=db.prepare(`SELECT COUNT(*) count,AVG(r.rating) rating FROM deals d LEFT JOIN reviews r ON r.target_id=? WHERE d.status='Сделка завершена' AND (d.buyer_id=? OR d.seller_id=?)`).get(q.user.id,q.user.id,q.user.id);
 const reviews=db.prepare(`SELECT r.*,u.username,u.first_name FROM reviews r JOIN users u ON u.id=r.author_id WHERE r.target_id=? ORDER BY r.id DESC LIMIT 20`).all(q.user.id);
 s.json({user:publicUser(q.user),balances,operations,isAdmin:q.isAdmin,isRootAdmin:ROOT_ADMINS.has(String(q.tg.id)),stats,reviews});
});
app.get('/api/deals',auth,(q,s)=>{
 const rows=db.prepare('SELECT * FROM deals WHERE creator_id=? OR counterparty_id=? ORDER BY id DESC').all(q.user.id,q.user.id);
 s.json(rows.map(d=>({...d,role:d.buyer_id===q.user.id?'Покупатель':d.seller_id===q.user.id?'Продавец':d.role_creator==='buyer'?'Покупатель':'Продавец',isBuyer:d.buyer_id===q.user.id})));
});
app.post('/api/deals',auth,(q,s)=>{
 const role=q.body.role,title=clean(q.body.title,100),item=clean(q.body.item_url,500),target=clean(q.body.counterparty,100).replace(/^@/, ''),
 amount=Number(q.body.amount),currency=String(q.body.currency||'RUB'),description=clean(q.body.description,1000),mode=q.body.invite_mode==='auto'?'auto':'manual';
 // При самостоятельном приглашении получатель не обязателен: пользователь отправит ссылку сам.
 if(!['buyer','seller'].includes(role)||title.length<2||!/^https:\/\/\S+$/i.test(item)||(mode==='auto'&&!target)||!Number.isFinite(amount)||amount<=0||!currencies.includes(currency))return s.status(400).json({error:'Проверьте роль, название, HTTPS-ссылку, сумму и валюту. Для автоматического приглашения укажите username или Telegram ID.'});
 const byId=/^\d+$/.test(target),found=target?(byId?db.prepare('SELECT * FROM users WHERE telegram_id=?').get(target):db.prepare('SELECT * FROM users WHERE lower(trim(username))=lower(?)').get(target)):null;
 if(mode==='auto'&&!bot)return s.status(503).json({error:'Telegram-бот сейчас не запущен. Проверьте BOT_TOKEN в Render.'});
 if(mode==='auto'&&!byId&&!found)return s.status(400).json({error:'Не нашёл этот username среди пользователей, которые запускали именно этого бота. Попросите получателя открыть именно вашего бота из этого Mini App и нажать Start, затем укажите его числовой Telegram ID (команда /id в боте). По одному @username Telegram не разрешает боту начать личный чат.'});
 if(found&&found.id===q.user.id)return s.status(400).json({error:'Нельзя пригласить самого себя'});
 const token=crypto.randomBytes(20).toString('hex'),c=code();
 const ins=db.prepare('INSERT INTO deals(code,creator_id,counterparty_telegram,counterparty_id,role_creator,title,item_url,description,amount,currency,invite_token,invite_mode,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(c,q.user.id,target||null,found?.id||null,role,title,item,description,amount,currency,token,mode,mode==='auto'?'Приглашение отправляется':'Ожидает приглашения');
 const id=Number(ins.lastInsertRowid),link=APP_URL+'/?join='+token;
 // Respond immediately: Telegram delivery is performed in the background.
 s.status(201).json({id,code:c,invite_url:link,notice:mode==='auto'?'Сделка создана. Отправляем приглашение в Telegram.':'Сделка создана. Отправьте ссылку второму участнику.'});
 if(mode!=='auto')return;
 const dest=found?.telegram_id||(/^\d+$/.test(target)?target:null);
 if(!bot||!dest){
  db.prepare("UPDATE deals SET status='Ожидает ручного приглашения',updated_at=datetime('now') WHERE id=?").run(id);
  return;
 }
 bot.telegram.sendMessage(dest,'🤝 Вас приглашают в сделку Playerok Garant\nОт: @'+(q.tg.username||q.tg.id)+'\nТовар: '+title+'\nСсылка: '+item+'\nСумма: '+amount+' '+currency+'\n\nПримите или отклоните приглашение.',Markup.inlineKeyboard([[Markup.button.callback('✅ Принять','deal_accept:'+token),Markup.button.callback('❌ Отклонить','deal_reject:'+token)]]))
  .then(()=>db.prepare("UPDATE deals SET status='Приглашение отправлено',updated_at=datetime('now') WHERE id=? AND status='Приглашение отправляется'").run(id))
  .catch(e=>{
   const desc=String(e.description||e.message||'').toLowerCase();
   const reason='Ожидает ручного приглашения';
   console.error('invite send failed:',e.message);
   db.prepare("UPDATE deals SET status=?,updated_at=datetime('now') WHERE id=?").run(reason,id);
   const creator=db.prepare('SELECT telegram_id FROM users WHERE id=?').get(q.user.id);
   notify(creator?.telegram_id,'⚠️ Не удалось отправить автоматическое приглашение. Получатель должен открыть бота и нажать Start. Отправьте ему ссылку на сделку вручную. Причина: '+(desc.includes('blocked')?'получатель заблокировал бота':desc.includes('chat not found')?'получатель ещё не запускал бота':'Telegram отклонил сообщение'));
  });
});
app.post('/api/deals/join',auth,(q,s)=>{
 const token=clean(q.body.token,100),role=q.body.role,d=db.prepare('SELECT * FROM deals WHERE invite_token=?').get(token);
 if(!d)return s.status(404).json({error:'Приглашение не найдено'});
 if(d.creator_id===q.user.id)return s.status(400).json({error:'Вы создатель сделки'});
 if(d.counterparty_telegram&&d.counterparty_telegram!==String(q.tg.id)&&d.counterparty_telegram.toLowerCase()!==String(q.tg.username||'').toLowerCase())return s.status(403).json({error:'Приглашение адресовано другому пользователю'});
 if(d.counterparty_id&&d.counterparty_id!==q.user.id)return s.status(409).json({error:'Второй участник уже подключился'});
 if(!['buyer','seller'].includes(role)||role===d.role_creator)return s.status(400).json({error:'Выберите противоположную роль создателя сделки'});
 const buyer=role==='buyer'?q.user.id:d.creator_id,seller=role==='seller'?q.user.id:d.creator_id;
 db.prepare(`UPDATE deals SET counterparty_id=?,buyer_id=?,seller_id=?,status='Ожидает оплаты',updated_at=datetime('now') WHERE id=?`).run(q.user.id,buyer,seller,d.id);
 notify(d.creator_id===q.user.id?d.counterparty_telegram:db.prepare('SELECT telegram_id FROM users WHERE id=?').get(d.creator_id)?.telegram_id,`Участник подключился к сделке ${d.code}`);
 s.json({ok:true});
});
app.post('/api/deals/:id/pay',auth,(q,s)=>{
 const d=db.prepare('SELECT * FROM deals WHERE id=?').get(Number(q.params.id));
 if(!d||d.buyer_id!==q.user.id)return s.status(403).json({error:'Оплатить может только покупатель этой сделки'});
 if(!d.counterparty_id||d.status!=='Ожидает оплаты')return s.status(409).json({error:'Сделка ещё не готова к оплате'});
 const balance=db.prepare('SELECT amount FROM balances WHERE user_id=? AND currency=?').get(q.user.id,d.currency);
 if(!balance||balance.amount<d.amount)return s.status(409).json({error:'Недостаточно средств на внутреннем балансе'});
 try{db.transaction(()=>{
  const debit=db.prepare('UPDATE balances SET amount=amount-? WHERE user_id=? AND currency=? AND amount>=?').run(d.amount,q.user.id,d.currency,d.amount);
  if(!debit.changes)throw Error('Недостаточно средств на внутреннем балансе');
  db.prepare('INSERT INTO ledger(user_id,kind,currency,amount,status,note) VALUES(?,?,?,?,?,?)').run(q.user.id,'Оплата сделки',d.currency,-d.amount,'списано',d.code);
  const changed=db.prepare("UPDATE deals SET status='Оплачено — передать менеджеру',updated_at=datetime('now') WHERE id=? AND status='Ожидает оплаты'").run(d.id);
  if(!changed.changes)throw Error('Сделка уже обработана');
 })()}catch(e){return s.status(409).json({error:e.message||'Не удалось провести оплату'})}
 const seller=db.prepare('SELECT telegram_id FROM users WHERE id=?').get(d.seller_id);
 notify(seller?.telegram_id,`Покупатель оплатил сделку ${d.code}. Передайте товар согласно инструкции и добавьте фото подтверждения в Mini App.`);
 s.json({ok:true,status:'Оплачено — передать менеджеру',manager_url:'https://t.me/playerok012'});
});
app.post('/api/deals/:id/proof',auth,(q,s)=>{
 const d=db.prepare('SELECT * FROM deals WHERE id=?').get(Number(q.params.id));
 if(!d||![d.creator_id,d.counterparty_id].includes(q.user.id))return s.status(404).json({error:'Сделка не найдена'});
 const data=String(q.body.image||'');if(!/^data:image\/(png|jpeg|webp);base64,/.test(data)||data.length>2_500_000)return s.status(400).json({error:'Загрузите изображение до 1.8 МБ'});
 const m=data.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/),ext=m[1]==='jpeg'?'jpg':m[1],name=`proof-${d.id}-${Date.now()}.${ext}`;
 fs.writeFileSync(path.join(uploads,name),Buffer.from(m[2],'base64'));
 db.prepare("UPDATE deals SET proof_url=?,status='Передача подтверждена продавцом',updated_at=datetime('now') WHERE id=?").run(`/uploads/${name}`,d.id);
 const buyer=db.prepare('SELECT telegram_id FROM users WHERE id=?').get(d.buyer_id);notify(buyer?.telegram_id,`Продавец добавил подтверждение передачи по сделке ${d.code}. Проверьте его в Mini App.`);
 s.json({ok:true,proof_url:`/uploads/${name}`});
});
app.post('/api/deals/:id/received',auth,(q,s)=>{
 const d=db.prepare('SELECT * FROM deals WHERE id=?').get(Number(q.params.id));
 if(!d||d.buyer_id!==q.user.id)return s.status(403).json({error:'Подтвердить получение может только покупатель'});
 if(!d.proof_url)return s.status(409).json({error:'Сначала продавец должен приложить подтверждение передачи'});
 db.prepare("UPDATE deals SET status='Покупатель подтвердил получение — проверка админа',updated_at=datetime('now') WHERE id=?").run(d.id);
 s.json({ok:true});
});
app.post('/api/deals/:id/review',auth,(q,s)=>{
 const d=db.prepare('SELECT * FROM deals WHERE id=?').get(Number(q.params.id));
 if(!d||d.status!=='Сделка завершена'||![d.buyer_id,d.seller_id].includes(q.user.id))return s.status(409).json({error:'Отзыв доступен участникам завершённой сделки'});
 const target=d.buyer_id===q.user.id?d.seller_id:d.buyer_id,rating=Number(q.body.rating),comment=clean(q.body.comment,500);
 if(!Number.isInteger(rating)||rating<1||rating>5)return s.status(400).json({error:'Оценка от 1 до 5'});
 try{db.prepare('INSERT INTO reviews(deal_id,author_id,target_id,rating,comment) VALUES(?,?,?,?,?)').run(d.id,q.user.id,target,rating,comment)}catch{return s.status(409).json({error:'Вы уже оставили отзыв по этой сделке'})}
 s.json({ok:true});
});
app.post('/api/daily',auth,(q,s)=>{
 const day=new Date().toISOString().slice(0,10),amount=23.1;
 try{db.transaction(()=>{db.prepare('INSERT INTO daily_claims(user_id,claim_date,amount) VALUES(?,?,?)').run(q.user.id,day,amount);db.prepare("UPDATE balances SET amount=amount+? WHERE user_id=? AND currency='RUB'").run(amount,q.user.id);db.prepare("INSERT INTO ledger(user_id,kind,currency,amount,status,note) VALUES(?,?,?,?,?,?)").run(q.user.id,'Ежедневная награда','RUB',amount,'начислено','Ежедневный бонус');})();s.json({ok:true,amount})}
 catch{s.status(409).json({error:'Сегодняшняя награда уже получена'})}
});
app.get('/api/giveaways',auth,(q,s)=>s.json(db.prepare("SELECT g.*, (SELECT COUNT(*) FROM giveaway_entries e WHERE e.giveaway_id=g.id) participants,(SELECT COUNT(*) FROM giveaway_entries e WHERE e.giveaway_id=g.id AND e.user_id=?) joined FROM giveaways g WHERE status='active' ORDER BY id DESC").all(q.user.id)));
app.post('/api/giveaways/:id/join',auth,(q,s)=>{try{db.prepare('INSERT INTO giveaway_entries(giveaway_id,user_id) VALUES(?,?)').run(Number(q.params.id),q.user.id);s.json({ok:true})}catch{s.status(409).json({error:'Вы уже участвуете или розыгрыш завершён'})}});
app.get('/api/admin/overview',auth,admin,(q,s)=>{
 const users=db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 500').all();
 const deals=db.prepare('SELECT d.*,u.telegram_id creator_telegram FROM deals d JOIN users u ON u.id=d.creator_id ORDER BY d.id DESC LIMIT 500').all();
 const ledger=db.prepare('SELECT l.*,u.telegram_id,u.username FROM ledger l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 500').all();
 const admins=db.prepare('SELECT * FROM admins ORDER BY created_at DESC').all();
 const giveaways=db.prepare('SELECT * FROM giveaways ORDER BY id DESC').all();
 s.json({users,deals,ledger,admins,giveaways,rootAdmins:[...ROOT_ADMINS]});
});
app.post('/api/admin/credit',auth,admin,(q,s)=>{
 const tid=clean(q.body.telegram_id,30),currency=String(q.body.currency||'RUB'),amount=Number(q.body.amount),note=clean(q.body.note,250);
 const u=db.prepare('SELECT * FROM users WHERE telegram_id=?').get(tid);
 if(!u||!currencies.includes(currency)||!Number.isFinite(amount)||amount<=0||amount>1e9||note.length<3)return s.status(400).json({error:'Проверьте ID, валюту, сумму и комментарий'});
 db.transaction(()=>{db.prepare('UPDATE balances SET amount=amount+? WHERE user_id=? AND currency=?').run(amount,u.id,currency);db.prepare('INSERT INTO ledger(user_id,kind,currency,amount,status,note) VALUES(?,?,?,?,?,?)').run(u.id,'Внутренняя корректировка',''+currency,amount,'учётная запись',note);db.prepare('INSERT INTO audit(admin_id,action,target,details) VALUES(?,?,?,?)').run(q.tg.id,'Выдан внутренний баланс',tid,JSON.stringify({currency,amount,note}))})();
 s.json({ok:true,warning:'Это внутренняя запись, не подтверждение платежа.'});
});
app.post('/api/admin/admins',auth,admin,rootAdmin,(q,s)=>{
 const tid=clean(q.body.telegram_id,30);if(!/^\d+$/.test(tid))return s.status(400).json({error:'Нужен числовой Telegram ID'});
 if(ROOT_ADMINS.has(tid))return s.status(400).json({error:'Главного администратора нельзя менять здесь'});
 db.prepare('INSERT OR IGNORE INTO admins(telegram_id,granted_by) VALUES(?,?)').run(tid,String(q.tg.id));
 db.prepare('INSERT INTO audit(admin_id,action,target) VALUES(?,?,?)').run(q.tg.id,'Выданы права администратора',tid);s.json({ok:true});
});
app.delete('/api/admin/admins/:id',auth,admin,rootAdmin,(q,s)=>{
 const tid=clean(q.params.id,30);if(ROOT_ADMINS.has(tid))return s.status(400).json({error:'Главного администратора нельзя удалить'});
 db.prepare('DELETE FROM admins WHERE telegram_id=?').run(tid);db.prepare('INSERT INTO audit(admin_id,action,target) VALUES(?,?,?)').run(q.tg.id,'Отозваны права администратора',tid);s.json({ok:true});
});
app.post('/api/admin/deals/:id/finish',auth,admin,(q,s)=>{
 const d=db.prepare('SELECT * FROM deals WHERE id=?').get(Number(q.params.id));
 if(!d||!['Покупатель подтвердил получение — проверка админа','Передача подтверждена продавцом'].includes(d.status))return s.status(409).json({error:'Сделка ещё не готова к проверке'});
 db.prepare("UPDATE deals SET status='Сделка завершена',updated_at=datetime('now') WHERE id=?").run(d.id);s.json({ok:true});
});
app.post('/api/admin/giveaways',auth,admin,(q,s)=>{
 const title=clean(q.body.title,100),prize=clean(q.body.prize,150),ends=clean(q.body.ends_at,40);
 if(!title||!prize)return s.status(400).json({error:'Заполните название и приз'});
 const r=db.prepare('INSERT INTO giveaways(title,prize,ends_at) VALUES(?,?,?)').run(title,prize,ends||null);s.json({ok:true,id:r.lastInsertRowid});
});
app.post('/api/admin/deals/:id/status',auth,admin,(q,s)=>{
 const d=db.prepare('SELECT * FROM deals WHERE id=?').get(Number(q.params.id)),status=clean(q.body.status,100);
 if(!d)return s.status(404).json({error:'Сделка не найдена'});
 if(status==='Сделка завершена'&&d.status!=='Покупатель подтвердил получение — проверка админа')return s.status(409).json({error:'Сначала покупатель должен подтвердить получение'});
 db.prepare("UPDATE deals SET status=?,updated_at=datetime('now') WHERE id=?").run(status,d.id);s.json({ok:true});
});
let bot=null;
if(BOT_TOKEN){
 bot=new Telegraf(BOT_TOKEN);
 // Сохраняем Telegram-пользователя при любом взаимодействии с ботом, не только при /start.
 bot.use(async(ctx,next)=>{if(ctx.from){try{ensureUser(ctx.from)}catch(e){console.error('User sync failed:',e.message)}}return next()});
 bot.command('id',ctx=>ctx.reply('Ваш Telegram ID: '+ctx.from.id+'\\nЕго можно указать в Mini App для автоматического приглашения.'));
 bot.action(/^deal_accept:([a-f0-9]+)$/i,async ctx=>{
  const token=ctx.match[1],d=db.prepare('SELECT * FROM deals WHERE invite_token=?').get(token);
  if(!d||!['Приглашение отправляется','Приглашение отправлено'].includes(d.status))return ctx.answerCbQuery('Приглашение уже недействительно',{show_alert:true});
  const target=String(ctx.from.id),username=String(ctx.from.username||'');
  if(d.counterparty_telegram!==target&&d.counterparty_telegram.toLowerCase()!==username.toLowerCase())return ctx.answerCbQuery('Это приглашение адресовано другому пользователю',{show_alert:true});
  const u=ensureUser(ctx.from);if(d.creator_id===u.id)return ctx.answerCbQuery('Нельзя принять собственное приглашение',{show_alert:true});
  const role=d.role_creator==='buyer'?'seller':'buyer',buyer=role==='buyer'?u.id:d.creator_id,seller=role==='seller'?u.id:d.creator_id;
  const changed=db.prepare("UPDATE deals SET counterparty_id=?,buyer_id=?,seller_id=?,status='Ожидает оплаты',updated_at=datetime('now') WHERE id=? AND status IN ('Приглашение отправляется','Приглашение отправлено') AND (counterparty_id IS NULL OR counterparty_id=?)").run(u.id,buyer,seller,d.id,u.id);
  if(!changed.changes)return ctx.answerCbQuery('Не удалось подключиться: сделка уже занята',{show_alert:true});
  await ctx.answerCbQuery('Вы подключились к сделке');await ctx.editMessageReplyMarkup({inline_keyboard:[]}).catch(()=>{});
  await ctx.reply('✅ Вы приняли приглашение. Откройте сделку в Playerok Garant.',Markup.inlineKeyboard([[Markup.button.webApp('Открыть сделку',APP_URL+'/?deal='+d.id)]]));
  const creator=db.prepare('SELECT telegram_id FROM users WHERE id=?').get(d.creator_id);notify(creator?.telegram_id,`✅ Участник принял приглашение по сделке ${d.code}. Статус: ожидает оплаты.`);
 });
 bot.action(/^deal_reject:([a-f0-9]+)$/i,async ctx=>{
  const token=ctx.match[1],d=db.prepare('SELECT * FROM deals WHERE invite_token=?').get(token);
  if(!d||!['Приглашение отправляется','Приглашение отправлено'].includes(d.status))return ctx.answerCbQuery('Приглашение уже недействительно',{show_alert:true});
  const target=String(ctx.from.id),username=String(ctx.from.username||'');
  if(d.counterparty_telegram!==target&&d.counterparty_telegram.toLowerCase()!==username.toLowerCase())return ctx.answerCbQuery('Это приглашение адресовано другому пользователю',{show_alert:true});
  db.prepare("UPDATE deals SET status='Приглашение отклонено',updated_at=datetime('now') WHERE id=? AND status IN ('Приглашение отправляется','Приглашение отправлено')").run(d.id);
  await ctx.answerCbQuery('Приглашение отклонено');await ctx.editMessageReplyMarkup({inline_keyboard:[]}).catch(()=>{});
  const creator=db.prepare('SELECT telegram_id FROM users WHERE id=?').get(d.creator_id);notify(creator?.telegram_id,`❌ Пользователь отклонил приглашение по сделке ${d.code}.`);
 });
 bot.start(async ctx=>{
  try{ensureUser(ctx.from)}catch(e){console.error('Failed to register bot user:',e.message)}
  if(!APP_URL||!/^https:\/\//.test(APP_URL))return ctx.reply('Сервис Mini App ещё не настроен. Администратор должен указать APP_URL в Render → Environment.');
  const caption='🔵 <b>PLAYEROK GARANT</b>\n\nПокупай и продавай игровые товары с сопровождением сделки.\n\n💸 <b>Комиссия — 0,3%</b>\n🛡️ <b>Гарант-сопровождение</b>\n🕒 <b>Поддержка 24/7</b>\n⚡ <b>Создание сделки за пару минут</b>\n\nНажми кнопку ниже, чтобы начать.';
  const keyboard=Markup.inlineKeyboard([[Markup.button.webApp('🚀 Открыть Playerok Garant',APP_URL)]]);
  try{return await ctx.replyWithPhoto('https://placehold.co/1200x630/071a3d/ffffff.png?text=PLAYEROK+GARANT',{caption,parse_mode:'HTML',...keyboard});}
  catch(e){console.error('Welcome photo failed:',e.message);return ctx.reply(caption,{parse_mode:'HTML',...keyboard});}
 });
 bot.catch(e=>console.error('Bot error',e));
 bot.launch().then(()=>console.log('Telegram bot started')).catch(e=>console.error('Bot launch failed',e.message));
}else console.warn('BOT_TOKEN пуст: бот отключён');
const server=app.listen(PORT,()=>console.log(`Playerok Garant listening on ${PORT}; APP_URL=${APP_URL||'(not set)'}`));
async function stop(){server.close();if(bot)await bot.stop('SIGTERM');db.close();process.exit(0)}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
