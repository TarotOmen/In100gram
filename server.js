'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TRIBUTE_PRODUCT_URL = process.env.TRIBUTE_PRODUCT_URL || 'https://web.tribute.tg/p/HHk';
const TRIBUTE_API_KEY = String(process.env.TRIBUTE_API_KEY || '').trim();
const TRIBUTE_PRODUCT_ID_OVERRIDE = String(process.env.TRIBUTE_PRODUCT_ID || '').trim();
let tributeProductCache = { expiresAt: 0, id: null, error: null };
const GOOGLE_APPS_SCRIPT_URL = String(process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const WEBHOOK_SECRET = String(process.env.TRIBUTE_WEBHOOK_SECRET || '').trim();
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false }) : null;
const ACTIONS = new Set(['100g','50g','25g','cocktail','beer','glass','bottle']);

// Tribute signature must be checked against the exact raw body.
app.use('/webhook/tribute', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
// Serve assets from public/ when present; the current GitHub repo keeps index.html at the project root.
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname, { index: false, dotfiles: 'deny' }));

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
async function resolveTributeProductId(){
 if(TRIBUTE_PRODUCT_ID_OVERRIDE) return TRIBUTE_PRODUCT_ID_OVERRIDE;
 if(!TRIBUTE_API_KEY) throw new Error('TRIBUTE_API_KEY is not configured');
 if(tributeProductCache.expiresAt>Date.now()){
   if(tributeProductCache.id) return tributeProductCache.id;
   throw new Error(tributeProductCache.error||'Tribute product could not be resolved');
 }
 try{
   const target=new URL(TRIBUTE_PRODUCT_URL);
   const targetPath=target.pathname.replace(/\/+$/,'');
   let found=null;
   for(let page=1;page<=10&&!found;page++){
     const url=new URL('https://tribute.tg/api/v1/products');
     url.searchParams.set('page',String(page));url.searchParams.set('size','100');url.searchParams.set('type','digital');
     const response=await fetch(url,{headers:{'Api-Key':TRIBUTE_API_KEY,accept:'application/json'}});
     if(!response.ok) throw new Error(`Tribute products API HTTP ${response.status}`);
     const body=await response.json();
     const rows=Array.isArray(body)?body:(Array.isArray(body.rows)?body.rows:Array.isArray(body.data)?body.data:[]);
     found=rows.find(product=>{
       const candidates=[product.webLink,product.web_link,product.link,product.url].filter(Boolean);
       return candidates.some(value=>{
         try{const u=new URL(value);return u.hostname===target.hostname&&u.pathname.replace(/\/+$/,'')===targetPath;}catch{return String(value).replace(/\/+$/,'')===TRIBUTE_PRODUCT_URL.replace(/\/+$/,'');}
       });
     })||null;
     if(found||rows.length<100) break;
   }
   if(!found||found.id==null) throw new Error(`No Tribute digital product matched ${TRIBUTE_PRODUCT_URL}. Check that the API key belongs to the product owner and the product is available through the API.`);
   tributeProductCache={expiresAt:Date.now()+5*60*1000,id:String(found.id),error:null};
   return String(found.id);
 }catch(error){tributeProductCache={expiresAt:Date.now()+30*1000,id:null,error:error.message};throw error;}
}
async function ensureSchema(){ if(!pool)return; await pool.query(`
CREATE TABLE IF NOT EXISTS in100gram_users(telegram_user_id BIGINT PRIMARY KEY,gender TEXT CHECK(gender IN('male','female')),points BIGINT NOT NULL DEFAULT 0,successful_payments INTEGER NOT NULL DEFAULT 0,level INTEGER NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS in100gram_reminders(id BIGSERIAL PRIMARY KEY,telegram_user_id BIGINT NOT NULL,action_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),fulfilled_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS in100gram_payments(id BIGSERIAL PRIMARY KEY,tribute_event_id TEXT UNIQUE NOT NULL,tribute_product_id TEXT,telegram_user_id BIGINT NOT NULL,amount NUMERIC,currency TEXT,action_id TEXT,reminder_id BIGINT,points_awarded BIGINT NOT NULL DEFAULT 0,level_after INTEGER NOT NULL DEFAULT 1,image_url TEXT,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
`); }
async function loadImages(){
 if(!GOOGLE_APPS_SCRIPT_URL) throw new Error('GOOGLE_APPS_SCRIPT_URL is not configured');
 const r=await fetch(GOOGLE_APPS_SCRIPT_URL,{headers:{accept:'application/json'}}); if(!r.ok) throw new Error(`Apps Script HTTP ${r.status}`);
 const data=await r.json(); if(!Array.isArray(data)) throw new Error('Apps Script must return a JSON array');
 return data.filter(x=>x&&x.image_id&&(x.url||x.file_id)&&String(x.active).toLowerCase()!=='false').map(x=>({...x,level:x.level===''||x.level==null?null:Number(x.level),file_id:String(x.file_id||extractDriveId(x.url)||''),url:String(x.file_id||extractDriveId(x.url)?('/api/image/'+encodeURIComponent(String(x.file_id||extractDriveId(x.url)))):x.url),active:true}));
}
function extractDriveId(value){
 try{const u=new URL(String(value||''));if(!/(^|\.)drive\.google\.com$/i.test(u.hostname))return '';const direct=u.searchParams.get('id');if(direct)return direct;const m=u.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);return m?m[1]:'';}catch{return '';}
}
const imageCache = new Map();
app.get('/api/image/:fileId',async(req,res)=>{
 const fileId=String(req.params.fileId||'');
 if(!/^[a-zA-Z0-9_-]{10,}$/.test(fileId))return res.status(400).json({error:'Invalid image id.'});
 try{
  const rows=await loadImages();
  if(!rows.some(x=>x.file_id===fileId))return res.status(404).json({error:'Image is not present in the active registry.'});
  const cached=imageCache.get(fileId);
  if(cached&&cached.expiresAt>Date.now()){res.set('Cache-Control','public, max-age=3600');res.type(cached.type);return res.send(cached.buffer);}
  const candidates=[`https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`,`https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`];
  let imageResponse=null,buffer=null,type='';
  for(const url of candidates){
   try{const r=await fetch(url,{redirect:'follow',headers:{'User-Agent':'Mozilla/5.0','Accept':'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'}});const ct=String(r.headers.get('content-type')||'').toLowerCase();if(r.ok&&ct.startsWith('image/')){imageResponse=r;buffer=Buffer.from(await r.arrayBuffer());type=ct;break;}}
   catch(err){console.warn('Drive image source failed:',err.message);}
  }
  if(!imageResponse||!buffer?.length){console.error('Google Drive image unavailable:',fileId);return res.status(502).json({error:'Google Drive did not return an image. Check that this file exists and is shared as anyone with the link.'});}
  imageCache.set(fileId,{buffer,type,expiresAt:Date.now()+3600_000});res.set('Cache-Control','public, max-age=3600');res.type(type);return res.send(buffer);
 }catch(e){console.error('Image proxy failed:',e.message);return res.status(502).json({error:'Could not load image registry or image.'});}
});
app.get('/health',(_req,res)=>res.json({ok:true,service:'in100gram',databaseConfigured:Boolean(pool),imageRegistryConfigured:Boolean(GOOGLE_APPS_SCRIPT_URL),tributeApiKeyConfigured:Boolean(TRIBUTE_API_KEY),tributeProductIdOverrideConfigured:Boolean(TRIBUTE_PRODUCT_ID_OVERRIDE)}));
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
 let expectedProductId;try{expectedProductId=await resolveTributeProductId();}catch(e){console.error('Tribute product lookup failed:',e.message);return res.status(503).json({error:'Could not resolve the configured Tribute product from the Tribute API. Check TRIBUTE_API_KEY and TRIBUTE_PRODUCT_URL.'});}
 if(String(buy.productId??'')!==expectedProductId)return res.json({ok:true,ignored:true,reason:'Product ID does not match.'});
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
// Support either repository layout: index.html in the root or in public/.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) return res.status(404).json({ error: 'Not found.' });
  const fs = require('fs');
  const rootIndex = path.join(__dirname, 'index.html');
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  const indexFile = fs.existsSync(rootIndex) ? rootIndex : publicIndex;
  if (!fs.existsSync(indexFile)) return res.status(500).send('In100gram frontend index.html is missing from the repository root and public/.');
  return res.sendFile(indexFile, err => { if (err) next(err); });
});
ensureSchema().then(()=>app.listen(PORT,()=>console.log(`In100gram listening on ${PORT}`))).catch(e=>{console.error('Database schema initialization failed:',e);process.exit(1);});
