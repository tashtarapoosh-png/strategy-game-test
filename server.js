import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, {recursive:true});
const DB = path.join(DATA_DIR, 'data.json');
const sessions = new Map();
const online = new Map();

const initialState = () => ({
  gold:3000,
  buildings:{castle:{level:1},wall:{level:1},barracks1:{level:1},barracks2:{level:1},goldMine:{level:1}},
  army:{archer:100,cavalry:100,swordsman:100},
  activeUpgrade:null,
  activeTraining:{barracks1:null,barracks2:null},
  activeAttacks:[], defenderSetups:{}, pendingRecoveries:[], attackRestrictions:{}, savedAt:Date.now()
});
function loadDB(){try{return JSON.parse(fs.readFileSync(DB,'utf8'));}catch{return {nextId:1,users:[]};}}
let db=loadDB();
function saveDB(){fs.writeFileSync(DB,JSON.stringify(db,null,2));}
function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')){return {salt,hash:crypto.scryptSync(password,salt,64).toString('hex')};}
function checkPassword(password,user){const h=crypto.scryptSync(password,user.salt,64).toString('hex');return crypto.timingSafeEqual(Buffer.from(h,'hex'),Buffer.from(user.passwordHash,'hex'));}
function token(){return crypto.randomBytes(32).toString('hex');}
function send(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});res.end(body);}
async function body(req){let s='';for await(const c of req)s+=c;return s?JSON.parse(s):{};}
function auth(req){const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return null;const id=sessions.get(h.slice(7));return db.users.find(u=>u.id===id)||null;}
function publicUser(u){return {id:u.id,username:u.username,state:u.state,castleLevel:u.state?.buildings?.castle?.level||1,cell:u.cell};}
function players(){return db.users.map(u=>({id:u.id,username:u.username,castleLevel:u.state?.buildings?.castle?.level||1,cell:u.cell,online:online.has(u.id)}));}

function randomCell(){
  const max=100;
  const used=new Set(db.users.map(u=>Number(u.cell)).filter(Number.isFinite));
  const candidates=[];
  for(let i=0;i<max;i++){
    if([...used].every(c=>Math.abs(c-i)>=5)) candidates.push(i);
  }
  if(candidates.length) return candidates[crypto.randomInt(candidates.length)];
  return crypto.randomInt(max);
}
function goldPerMinute(state){return 100*Math.pow(1.1,Math.max(0,(state.buildings?.goldMine?.level||1)-1));}
function goldCap(state){const lvl=Math.max(1,Math.min(5,state.buildings?.castle?.level||1));const next=Math.min(5,lvl+1);return 1000*Math.pow(2,next-2)*10;}
function advanceState(state){
  const now=Date.now();
  const elapsed=Math.max(0,(now-(Number(state.savedAt)||now))/1000);
  if(elapsed<=0){state.savedAt=now;return false;}
  state.gold=Number(state.gold)||0;
  state.gold+=goldPerMinute(state)/60*elapsed;
  state.activeUpgrade=state.activeUpgrade||null;
  if(state.activeUpgrade){state.activeUpgrade.remaining=Math.max(0,Number(state.activeUpgrade.remaining||0)-elapsed);if(state.activeUpgrade.remaining<=0){const j=state.activeUpgrade; if(state.buildings?.[j.type]) state.buildings[j.type].level=Number(j.targetLevel)||state.buildings[j.type].level;state.activeUpgrade=null;}}
  for(const b of ['barracks1','barracks2']){const j=state.activeTraining?.[b];if(j){j.remaining=Math.max(0,Number(j.remaining||0)-elapsed);if(j.remaining<=0){state.army[j.type]=(Number(state.army[j.type])||0)+(Number(j.count)||0);state.activeTraining[b]=null;}}}
  state.pendingRecoveries=Array.isArray(state.pendingRecoveries)?state.pendingRecoveries:[];
  const keep=[];for(const j of state.pendingRecoveries){if(Number(j.dueAt)<=now) state.army[j.type]=(Number(state.army[j.type])||0)+(Number(j.count)||0);else keep.push(j);}state.pendingRecoveries=keep;
  // مسیر برگشت لشکرها در تست چندروزه حفظ می‌شود؛ نبرد رسیدن به مقصد همچنان توسط منطق فعلی بازی انجام می‌شود.
  if(Array.isArray(state.activeAttacks)){for(const a of state.activeAttacks)a.remaining=Math.max(0,Number(a.remaining||0)-elapsed);}
  state.gold=Math.min(state.gold,goldCap(state));
  state.savedAt=now;
  return true;
}

function serveStatic(req,res){
  let pathname=decodeURIComponent(new URL(req.url,`http://${req.headers.host||'localhost'}`).pathname);
  if(pathname==='/'||pathname==='') pathname='/index.html';
  const safe=path.normalize(pathname).replace(/^\.\.(?:[\/\\]|$)+/,'');
  const file=path.join(__dirname,safe);
  if(!file.startsWith(__dirname)) return send(res,403,{error:'دسترسی غیرمجاز.'});
  try{const data=fs.readFileSync(file);const ext=path.extname(file).toLowerCase();const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.css':'text/css; charset=utf-8'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);}catch{return send(res,404,{error:'فایل پیدا نشد.'});}
}

const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS'});return res.end();}
  try{
    if(req.url==='/api/register'&&req.method==='POST'){
      const {username,password}=await body(req); if(!username||!password||username.length<3||password.length<4)return send(res,400,{error:'نام کاربری یا رمز عبور معتبر نیست.'});
      if(db.users.some(u=>u.username.toLowerCase()===username.toLowerCase()))return send(res,409,{error:'این نام کاربری قبلاً ثبت شده است.'});
      const p=hashPassword(password);const u={id:String(db.nextId++),username,salt:p.salt,passwordHash:p.hash,state:initialState(),cell:randomCell()};db.users.push(u);saveDB();const t=token();sessions.set(t,u.id);online.set(u.id,Date.now());return send(res,201,{token:t,user:publicUser(u)});
    }
    if(req.url==='/api/login'&&req.method==='POST'){
      const {username,password}=await body(req);const u=db.users.find(x=>x.username.toLowerCase()===String(username||'').toLowerCase());
      if(!u||!checkPassword(String(password||''),u))return send(res,401,{error:'نام کاربری یا رمز عبور نادرست است.'});
      advanceState(u.state);saveDB();const t=token();sessions.set(t,u.id);online.set(u.id,Date.now());return send(res,200,{token:t,user:publicUser(u)});
    }
    const u=auth(req); if(!u)return send(res,401,{error:'ابتدا وارد حساب شوید.'}); online.set(u.id,Date.now());
    advanceState(u.state);
    if(req.url==='/api/state'&&req.method==='PUT'){const incoming=await body(req);u.state={...u.state,...incoming,savedAt:Date.now()};saveDB();return send(res,200,{ok:true});}
    if(req.url==='/api/state'&&req.method==='GET'){saveDB();return send(res,200,{state:u.state});}
    if(req.url==='/api/players'&&req.method==='GET'){saveDB();return send(res,200,{selfId:u.id,players:players()});}
    if(req.url.startsWith('/api/'))return send(res,404,{error:'مسیر پیدا نشد.'});
    return serveStatic(req,res);
  }catch(e){console.error(e);send(res,500,{error:'خطای داخلی سرور.'});}
});

setInterval(()=>{const now=Date.now();for(const [id,t] of online)if(now-t>15000)online.delete(id);},5000);
server.listen(PORT,()=>console.log(`Strategy game server running on port ${PORT}`));
