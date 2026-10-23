'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TRIBUTE_PRODUCT_URL = process.env.TRIBUTE_PRODUCT_URL || 'https://web.tribute.tg/p/HHk';
const TRIBUTE_PRODUCT_ID = String(process.env.TRIBUTE_PRODUCT_ID || '').trim();
const GOOGLE_APPS_SCRIPT_URL = String(process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const WEBHOOK_SECRET = String(process.env.TRIBUTE_WEBHOOK_SECRET || '').trim();
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false }) : null;
const ACTIONS = new Set(['100g','50g','25g','cocktail','beer','glass','bottle']);

// Tribute signature must be checked against the exact raw body.
app.use('/webhook/tribute', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function safeEqualHex(a,b){ if(typeof a!=='string'||typeof b!=='string'||!/^[a-f0-9]+$/i.test(a)||!/^[a-f0-9]+$/i.test(b)) return false; const x=Buffer.from(a,'hex'),y=Buffer.from(b,'hex'); return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y); }
function verifyTribute(raw, signature){ if(!WEBHOOK_SECRET||!signature||!Buffer.isBuffer(raw)) return false; const s=String(signature).replace(/^sha256=/i,'').trim(); return safeEqualHex(s,crypto.createHmac('sha256',WEBHOOK_SECRET).update(raw).digest('hex')); }
function verifyTelegramInitData(initData){
  if(!BOT_TOKEN||typeof initData!=='string'||!initData) return null;
  const params=new URLSearchParams(initData); const hash=params.get('hash'); if(!hash) return null; params.delete('hash');
  const check=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
  const expected=crypto.createHmac('sha256',secret).update(check).digest('hex'); if(!safeEqualHex(hash,expected)) return null;
  const authDate=Number(params.get('auth_date')||0); if(!authDate||Date.now()/1000-authDate>86400) return null;
  try { const user=JSON.parse(params.get('user')||'{}'); return /^\d+$/.test(String(user.id||''))?String(user.id):null; } catch { return null; }
}
function userIdFromRequest(req){ const header=req.get('authorization')||''; const initData=header.startsWith('tma ')?header.slice(4):req.body?.initData||req.query?.initData; return verifyTelegramInitData(initData); }
function levelForPayments(n){ if(n>=125)return 16; if(n>=75)return 15; return Math.min(14,Math.floor(n/5)+1); }
function pointsForElapsedMs(ms){ const m=ms/60000; if(m<=5)return 500000; if(m<=15)return 100000; if(m<=30)return 50000; if(m<=60)return 20000; if(m<=360)return 5000; if(m<=1440)return 2000; return 1000; }
function parseTribute(event){const p=event?.payload||{};return {eventId:event?.id??event?.event_id??p?.purchase_id??p?.id??null,productId:p?.product_id??p?.productId??null,userId:p?.telegram_user_id??p?.telegramUserId??p?.telegram_id??null,amount:p?.amount??null,currency:p?.currency??null};}
async function ensureSchema(){ if(!pool)return; await pool.query(`
CREATE TABLE IF NOT EXISTS in100gram_users(telegram_user_id BIGINT PRIMARY KEY,gender TEXT CHECK(gender IN('male','female')),points BIGINT NOT NULL DEFAULT 0,successful_payments INTEGER NOT NULL DEFAULT 0,level INTEGER NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS in100gram_reminders(id BIGSERIAL PRIMARY KEY,telegram_user_id BIGINT NOT NULL,action_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),fulfilled_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS in100gram_payments(id BIGSERIAL PRIMARY KEY,tribute_event_id TEXT UNIQUE NOT NULL,tribute_product_id TEXT,telegram_user_id BIGINT NOT NULL,amount NUMERIC,currency TEXT,action_id TEXT,reminder_id BIGINT,points_awarded BIGINT NOT NULL DEFAULT 0,level_after INTEGER NOT NULL DEFAULT 1,image_url TEXT,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
`); }
async function loadImages(){
 if(!GOOGLE_APPS_SCRIPT_URL) throw new Error('GOOGLE_APPS_SCRIPT_URL is not configured');
 const r=await fetch(GOOGLE_APPS_SCRIPT_URL,{headers:{accept:'application/json'}}); if(!r.ok) throw new Error(`Apps Script HTTP ${r.status}`);
 const data=await r.json(); if(!Array.isArray(data)) throw new Error('Apps Script must return a JSON array');
 return data.filter(x=>x&&x.image_id&&x.url&&String(x.active).toLowerCase()!=='false').map(x=>({...x,level:x.level===''||x.level==null?null:Number(x.level),url:String(x.url),active:true}));
}
app.get('/health',(_req,res)=>res.json({ok:true,service:'in100gram',databaseConfigured:Boolean(pool),imageRegistryConfigured:Boolean(GOOGLE_APPS_SCRIPT_URL),tributeProductConfigured:Boolean(TRIBUTE_PRODUCT_ID)}));
app.get('/api/config',(_req,res)=>res.json({tributeProductUrl:TRIBUTE_PRODUCT_URL}));
app.get('/api/images',async(_req,res)=>{try{res.set('Cache-Control','public, max-age=60');res.json(await loadImages());}catch(e){console.error('Image registry error:',e.message);res.status(502).json({error:'Image registry unavailable. Check GOOGLE_APPS_SCRIPT_URL and Apps Script deployment.'});}});
app.post('/api/profile',async(req,res)=>{const uid=userIdFromRequest(req);if(!uid)return res.status(401).json({error:'Telegram authorization failed.'});const gender=req.body?.gender;if(!['male','female'].includes(gender))return res.status(400).json({error:'Invalid gender.'});if(!pool)return res.status(503).json({error:'DATABASE_URL is not configured.'});try{await pool.query('INSERT INTO in100gram_users(telegram_user_id,gender) VALUES($1,$2) ON CONFLICT(telegram_user_id) DO UPDATE SET gender=EXCLUDED.gender,updated_at=NOW()',[uid,gender]);res.json({ok:true});}catch(e){console.error(e);res.status(500).json({error:'Could not save profile.'});}});
app.post('/api/reminder',async(req,res)=>{const uid=userIdFromRequest(req);if(!uid)return res.status(401).json({error:'Telegram authorization failed.'});const actionId=String(req.body?.actionId||'');if(!ACTIONS.has(actionId))return res.status(400).json({error:'Invalid action.'});if(!pool)return res.status(503).json({error:'DATABASE_URL is not configured.'});try{await pool.query('INSERT INTO in100gram_users(telegram_user_id) VALUES($1) ON CONFLICT DO NOTHING',[uid]);await pool.query('INSERT INTO in100gram_reminders(telegram_user_id,action_id) VALUES($1,$2)',[uid,actionId]);res.json({ok:true});}catch(e){console.error(e);res.status(500).json({error:'Could not save action.'});}});
app.get('/api/status',async(req,res)=>{const uid=userIdFromRequest(req);if(!uid)return res.status(401).json({error:'Telegram authorization failed.'});if(!pool)return res.status(503).json({error:'DATABASE_URL is not configured.'});try{const u=await pool.query('SELECT * FROM in100gram_users WHERE telegram_user_id=$1',[uid]);if(!u.rowCount)return res.json({registered:false});const p=await pool.query('SELECT id,action_id,points_awarded,level_after,image_url,created_at FROM in100gram_payments WHERE telegram_user_id=$1 ORDER BY created_at DESC LIMIT 1',[uid]);const x=u.rows[0],pay=p.rows[0];res.json({registered:true,gender:x.gender,points:String(x.points),level:x.level,successfulPayments:x.successful_payments,latestPayment:pay?{id:String(pay.id),actionId:pay.action_id,pointsAwarded:String(pay.points_awarded),level:pay.level_after,imageUrl:pay.image_url,createdAt:pay.created_at}:null});}catch(e){console.error(e);res.status(500).json({error:'Could not load status.'});}});
app.post('/webhook/tribute',async(req,res)=>{
 if(!verifyTribute(req.body,req.get('trbt-signature')))return res.status(401).json({error:'Invalid Tribute signature.'});
 let event;try{event=JSON.parse(req.body.toString('utf8'));}catch{return res.status(400).json({error:'Invalid JSON.'});}
 if(event?.name!=='new_digital_product')return res.json({ok:true,ignored:true});
 const buy=parseTribute(event);if(!pool)return res.status(503).json({error:'DATABASE_URL is not configured.'});
 if(!TRIBUTE_PRODUCT_ID)return res.status(503).json({error:'Set TRIBUTE_PRODUCT_ID to the exact product_id from a real signed Tribute webhook.'});
 if(String(buy.productId??'')!==TRIBUTE_PRODUCT_ID)return res.json({ok:true,ignored:true,reason:'Product ID does not match.'});
 if(!buy.userId||!/^\d+$/.test(String(buy.userId)))return res.status(200).json({ok:true,processed:false,reason:'Webhook has no Telegram user ID.'});
 if(buy.eventId==null||String(buy.eventId)==='')return res.status(422).json({error:'Webhook has no stable unique purchase/event ID; refusing to risk duplicate point awards.'});
 const uid=String(buy.userId), client=await pool.connect();
 try{await client.query('BEGIN');const dupe=await client.query('SELECT id FROM in100gram_payments WHERE tribute_event_id=$1',[String(buy.eventId)]);if(dupe.rowCount){await client.query('COMMIT');return res.json({ok:true,duplicate:true});}
 await client.query('INSERT INTO in100gram_users(telegram_user_id) VALUES($1) ON CONFLICT DO NOTHING',[uid]);const ur=await client.query('SELECT * FROM in100gram_users WHERE telegram_user_id=$1 FOR UPDATE',[uid]);const user=ur.rows[0];const rr=await client.query('SELECT id,action_id,created_at FROM in100gram_reminders WHERE telegram_user_id=$1 AND fulfilled_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE',[uid]);const reminder=rr.rows[0]||null;const pts=reminder?pointsForElapsedMs(Date.now()-new Date(reminder.created_at).getTime()):1000;const count=Number(user.successful_payments)+1,level=levelForPayments(count);let imageUrl=null;
 try{const imgs=await loadImages();const choices=imgs.filter(i=>i.category==='action'&&i.action_id===reminder?.action_id&&(i.gender==='both'||i.gender===user.gender));if(choices.length)imageUrl=choices[Math.floor(Math.random()*choices.length)].url;}catch(e){console.error('Could not select action image:',e.message);}
 await client.query('INSERT INTO in100gram_payments(tribute_event_id,tribute_product_id,telegram_user_id,amount,currency,action_id,reminder_id,points_awarded,level_after,image_url,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)',[String(buy.eventId),String(buy.productId),uid,buy.amount,buy.currency,reminder?.action_id||null,reminder?.id||null,pts,level,imageUrl,JSON.stringify(event)]);
 await client.query('UPDATE in100gram_users SET points=points+$2,successful_payments=$3,level=$4,updated_at=NOW() WHERE telegram_user_id=$1',[uid,pts,count,level]);if(reminder)await client.query('UPDATE in100gram_reminders SET fulfilled_at=NOW() WHERE id=$1',[reminder.id]);await client.query('COMMIT');
 if(BOT_TOKEN&&imageUrl){try{await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:uid,photo:imageUrl,caption:`Оплата подтверждена! Начислено ${pts.toLocaleString('ru-RU')} баллов.`})});}catch(e){console.error('Telegram photo delivery failed:',e.message);}}
 return res.json({ok:true,processed:true});
 }catch(e){await client.query('ROLLBACK');console.error('Tribute webhook failed:',e);return res.status(500).json({error:'Webhook processing failed.'});}finally{client.release();}
});
// The GitHub repository currently stores index.html in the project root, not /public.
app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'index.html')));
ensureSchema().then(()=>app.listen(PORT,()=>console.log(`In100gram listening on ${PORT}`))).catch(e=>{console.error('Database schema initialization failed:',e);process.exit(1);});
