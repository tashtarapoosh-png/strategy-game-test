import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// On Render, set DATA_DIR to the mount path of a Persistent Disk.
// Locally it falls back to this project directory.
const DATA_DIR = process.env.DATA_DIR || process.env.RENDER_DISK_PATH || __dirname;
fs.mkdirSync(DATA_DIR, {recursive:true});
const DB = process.env.DB_PATH || path.join(DATA_DIR, 'data.json');

const BASE_WORLD_CELLS = 100; // 10 x 10
const CELLS_PER_PLAYER = 10;
const DEVELOPMENT_MAX_LEVEL = 5;
const BASE_GOLD_PER_MINUTE = 100;
const STARTING_GOLD = 3000;
const BASE_TRAINING_CAPACITY = 10;
const BASE_TRAINING_TIME_SECONDS = 60;
const UNIT_TYPES = ['archer','cavalry','swordsman'];
const BUILDING_TYPES = ['castle','wall','barracks1','barracks2','goldMine'];

const sessions = new Map();
const online = new Map();

const initialState = () => ({
  gold: STARTING_GOLD,
  buildings:{castle:{level:1},wall:{level:1},barracks1:{level:1},barracks2:{level:1},goldMine:{level:1}},
  army:{archer:100,cavalry:100,swordsman:100},
  activeUpgrade:null,
  activeTraining:{barracks1:null,barracks2:null},
  activeAttacks:[],
  defenderSetups:{},
  pendingRecoveries:[],
  attackRestrictions:{},
  savedAt:Date.now()
});

function loadDB(){
  try {
    const parsed = JSON.parse(fs.readFileSync(DB,'utf8'));
    if (!parsed || !Array.isArray(parsed.users)) throw new Error('bad db');
    if (!Number.isInteger(parsed.nextId) || parsed.nextId < 1) parsed.nextId = 1;
    return parsed;
  } catch {
    return {nextId:1,users:[]};
  }
}

let db=loadDB();

function saveDB(){
  const tmp = `${DB}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(db,null,2),'utf8');
  fs.renameSync(tmp,DB);
}

function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')){
  return {salt,hash:crypto.scryptSync(password,salt,64).toString('hex')};
}

function checkPassword(password,user){
  try {
    const h=crypto.scryptSync(password,user.salt,64).toString('hex');
    const a=Buffer.from(h,'hex');
    const b=Buffer.from(user.passwordHash,'hex');
    return a.length===b.length && crypto.timingSafeEqual(a,b);
  } catch { return false; }
}

function token(){return crypto.randomBytes(32).toString('hex');}

function send(res,status,data){
  const body=JSON.stringify(data);
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Access-Control-Allow-Origin':'*'
  });
  res.end(body);
}

async function body(req){
  let s='';
  for await(const c of req)s+=c;
  return s?JSON.parse(s):{};
}

function auth(req){
  const h=req.headers.authorization||'';
  if(!h.startsWith('Bearer '))return null;
  const id=sessions.get(h.slice(7));
  return db.users.find(u=>u.id===id)||null;
}

function publicUser(u){
  return {
    id:u.id,
    username:u.username,
    state:u.state,
    castleLevel:u.state?.buildings?.castle?.level||1,
    cell:u.cell
  };
}

function players(){
  return db.users.map(u=>({
    id:u.id,
    username:u.username,
    castleLevel:u.state?.buildings?.castle?.level||1,
    cell:u.cell,
    online:online.has(u.id)
  }));
}

function getWorldSize(userCount=db.users.length){
  return BASE_WORLD_CELLS + Math.max(0, userCount - 1) * CELLS_PER_PLAYER;
}

// The first 100 cells are a 10x10 square. Every additional player expands
// the map by 10 cells along successive sides of an outward square spiral.
function worldCoord(index){
  index=Math.max(0,Math.floor(Number(index)||0));
  if(index<BASE_WORLD_CELLS) return {x:index%10,y:Math.floor(index/10)};
  let k=index-BASE_WORLD_CELLS;
  const side=Math.floor(k/10);
  const n=k%10;
  const ring=Math.floor(side/4)+1;
  const segment=side%4;
  if(segment===0) return {x:9+(ring-1)*11-n,y:-ring};
  if(segment===1) return {x:9+ring,y:n};
  if(segment===2) return {x:9+(ring-1)*11-n,y:9+ring};
  return {x:-ring,y:9+ring-n};
}

function assignCell(){
  const used=new Set(db.users.map(u=>Number(u.cell)).filter(Number.isInteger));
  const limit=getWorldSize();
  const free=[];
  for(let i=0;i<limit;i++) if(!used.has(i)) free.push(i);
  if(free.length) return free[crypto.randomInt(free.length)];
  return Math.max(0,limit-1);
}

function num(value,fallback=0){
  const n=Number(value);
  return Number.isFinite(n)?n:fallback;
}

function int(value,fallback=0){
  return Math.max(0,Math.floor(num(value,fallback)));
}

function goldProductionPerMinute(state){
  const level=Math.max(1,Math.min(DEVELOPMENT_MAX_LEVEL,int(state.buildings?.goldMine?.level,1)));
  return BASE_GOLD_PER_MINUTE*Math.pow(1.1,level-1);
}

function castleUpgradeCost(targetLevel){
  const level=Math.max(2,int(targetLevel,2));
  return BASE_GOLD_PER_MINUTE*10*Math.pow(2,level-2);
}

function offlineGoldCap(state){
  const castleLevel=Math.max(1,Math.min(DEVELOPMENT_MAX_LEVEL,int(state.buildings?.castle?.level,1)));
  return castleUpgradeCost(Math.min(DEVELOPMENT_MAX_LEVEL,castleLevel+1))*10;
}

function trainingTime(level){
  return BASE_TRAINING_TIME_SECONDS*Math.pow(0.9,Math.max(0,int(level,1)-1));
}

function normalizeState(raw){
  const d=initialState();
  const s=(raw&&typeof raw==='object')?raw:{};
  d.gold=Math.max(0,num(s.gold,STARTING_GOLD));

  for(const key of BUILDING_TYPES){
    const level=Math.max(1,Math.min(DEVELOPMENT_MAX_LEVEL,int(s.buildings?.[key]?.level,1)));
    d.buildings[key]={level};
  }

  for(const type of UNIT_TYPES) d.army[type]=int(s.army?.[type],d.army[type]);

  if(s.activeUpgrade && BUILDING_TYPES.includes(s.activeUpgrade.type)){
    const target=Math.max(2,Math.min(DEVELOPMENT_MAX_LEVEL,int(s.activeUpgrade.targetLevel,2)));
    const remaining=Math.max(0,num(s.activeUpgrade.remaining,0));
    d.activeUpgrade={type:s.activeUpgrade.type,targetLevel:target,remaining};
  }

  for(const barracks of ['barracks1','barracks2']){
    const job=s.activeTraining?.[barracks];
    if(job && UNIT_TYPES.includes(job.type)){
      d.activeTraining[barracks]={type:job.type,count:int(job.count),remaining:Math.max(0,num(job.remaining,0))};
    }
  }

  d.activeAttacks=Array.isArray(s.activeAttacks)?s.activeAttacks.map(a=>({...a,remaining:Math.max(0,num(a.remaining,0))})).slice(0,100):[];
  d.defenderSetups=(s.defenderSetups&&typeof s.defenderSetups==='object')?s.defenderSetups:{};
  d.pendingRecoveries=Array.isArray(s.pendingRecoveries)?s.pendingRecoveries.map(j=>({
    type:UNIT_TYPES.includes(j.type)?j.type:'archer',
    count:int(j.count),
    dueAt:num(j.dueAt,0)
  })).filter(j=>j.count>0&&j.dueAt>0).slice(0,500):[];
  d.attackRestrictions=(s.attackRestrictions&&typeof s.attackRestrictions==='object')?s.attackRestrictions:{};
  d.savedAt=Date.now();
  return d;
}

// This mirrors the offline progression that was already implemented in index.html.
// It deliberately does not invent battle outcomes: an attack that reaches a target is
// left at remaining=0 so the existing battle engine can resolve it after the client loads.
function applyOfflineProgress(user, now=Date.now()){
  if(!user.state) user.state=initialState();
  user.state=normalizeState(user.state);

  const last=num(user.lastStateAt || user.state.savedAt, now);
  const elapsed=Math.max(0,(now-last)/1000);
  if(elapsed<=0){
    user.state.savedAt=now;
    user.lastStateAt=now;
    return 0;
  }

  const state=user.state;

  // Pending recoveries use their existing absolute dueAt timestamps.
  const remainingRecoveries=[];
  for(const job of state.pendingRecoveries){
    if(num(job.dueAt,0)<=now){
      state.army[job.type]=int(state.army[job.type])+int(job.count);
    }else remainingRecoveries.push(job);
  }
  state.pendingRecoveries=remainingRecoveries;

  // Same gold-production order as the original client logic.
  state.gold += goldProductionPerMinute(state)/60*elapsed;

  // Upgrade timer.
  if(state.activeUpgrade){
    state.activeUpgrade.remaining=Math.max(0,num(state.activeUpgrade.remaining)-elapsed);
    if(state.activeUpgrade.remaining<=0){
      const job=state.activeUpgrade;
      state.buildings[job.type].level=Math.max(1,Math.min(DEVELOPMENT_MAX_LEVEL,int(job.targetLevel,1)));
      state.activeUpgrade=null;
    }
  }

  // Training timers: same single-batch-per-barracks behavior as the original client.
  for(const barracks of ['barracks1','barracks2']){
    const job=state.activeTraining[barracks];
    if(!job) continue;
    job.remaining=num(job.remaining)-elapsed;
    if(job.remaining<=0){
      state.army[job.type]=int(state.army[job.type])+int(job.count);
      state.activeTraining[barracks]=null;
    }
  }

  // Returning armies come back automatically while offline. Non-returning attacks are
  // marked as arrived and are resolved by the existing battle engine on the client.
  for(const attack of state.activeAttacks){
    attack.remaining=Math.max(0,num(attack.remaining)-elapsed);
    if(attack.remaining<=0 && attack.returning){
      for(const type of UNIT_TYPES) state.army[type]=int(state.army[type])+int(attack.composition?.[type]);
      attack._completedOfflineReturn=true;
    }
  }
  state.activeAttacks=state.activeAttacks.filter(a=>!a._completedOfflineReturn);

  state.gold=Math.min(state.gold,offlineGoldCap(state));
  state.savedAt=now;
  user.lastStateAt=now;
  return elapsed;
}

function touch(user){online.set(user.id,Date.now());}

const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){
    res.writeHead(204,{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':'Content-Type, Authorization',
      'Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS'
    });
    return res.end();
  }

  try{
    if(req.url==='/api/register'&&req.method==='POST'){
      const {username,password}=await body(req);
      if(!username||!password||username.length<3||password.length<4)
        return send(res,400,{error:'نام کاربری یا رمز عبور معتبر نیست.'});
      if(db.users.some(u=>u.username.toLowerCase()===username.toLowerCase()))
        return send(res,409,{error:'این نام کاربری قبلاً ثبت شده است.'});

      const p=hashPassword(password);
      const now=Date.now();
      const u={
        id:String(db.nextId++),
        username,
        salt:p.salt,
        passwordHash:p.hash,
        state:initialState(),
        cell:assignCell(),
        lastStateAt:now
      };
      u.state.savedAt=now;
      db.users.push(u);
      saveDB();

      const t=token();
      sessions.set(t,u.id);
      touch(u);
      return send(res,201,{token:t,user:publicUser(u)});
    }

    if(req.url==='/api/login'&&req.method==='POST'){
      const {username,password}=await body(req);
      const u=db.users.find(x=>x.username.toLowerCase()===String(username||'').toLowerCase());
      if(!u||!checkPassword(String(password||''),u))
        return send(res,401,{error:'نام کاربری یا رمز عبور نادرست است.'});

      applyOfflineProgress(u);
      if(!Number.isInteger(u.cell)||u.cell<0||u.cell>=getWorldSize()) u.cell=assignCell();
      saveDB();

      const t=token();
      sessions.set(t,u.id);
      touch(u);
      return send(res,200,{token:t,user:publicUser(u),worldSize:getWorldSize()});
    }

    // Public static files must be served before authentication.
    if(req.method==='GET'){
      const requestPath=new URL(req.url,`http://${req.headers.host||'localhost'}`).pathname;
      let fileName=null;

      if(requestPath==='/' || requestPath==='/index.html' || requestPath==='/ghalee1.png'){
        fileName=requestPath==='/'?'index.html':requestPath.slice(1);
      }else if(requestPath.startsWith('/images/')){
        fileName=requestPath.slice(1);
      }

      if(fileName){
        const filePath=path.resolve(__dirname,fileName);
        const imagesRoot=path.resolve(__dirname,'images');
        const isAllowedRoot=fileName==='index.html' || fileName==='ghalee1.png';
        const isAllowedImage=filePath.startsWith(imagesRoot+path.sep);

        if(isAllowedRoot || isAllowedImage){
          if(fs.existsSync(filePath) && fs.statSync(filePath).isFile()){
            const ext=path.extname(filePath).toLowerCase();
            const types={
              '.html':'text/html; charset=utf-8',
              '.png':'image/png',
              '.jpg':'image/jpeg',
              '.jpeg':'image/jpeg',
              '.webp':'image/webp',
              '.gif':'image/gif',
              '.svg':'image/svg+xml'
            };
            const type=types[ext]||'application/octet-stream';
            res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-cache'});
            return fs.createReadStream(filePath).pipe(res);
          }
          return send(res,404,{error:'فایل پیدا نشد.'});
        }
      }
    }

    const u=auth(req);
    if(!u)return send(res,401,{error:'ابتدا وارد حساب شوید.'});
    touch(u);

    if(req.url==='/api/state'&&req.method==='PUT'){
      const incoming=await body(req);
      // Server time is authoritative. The client cannot choose savedAt or use a browser clock
      // to manufacture offline gold.
      u.state=normalizeState(incoming);
      u.state.savedAt=Date.now();
      u.lastStateAt=u.state.savedAt;
      saveDB();
      return send(res,200,{ok:true,state:u.state});
    }

    if(req.url==='/api/state'&&req.method==='GET'){
      applyOfflineProgress(u);
      saveDB();
      return send(res,200,{state:u.state});
    }

    if(req.url==='/api/players'&&req.method==='GET'){
      // Do not alter other players' states here; this endpoint is only the persistent world view.
      return send(res,200,{selfId:u.id,worldSize:getWorldSize(),players:players(),cellLayout:db.users.map(x=>({id:x.id,cell:x.cell,...worldCoord(x.cell)}))});
    }

    return send(res,404,{error:'مسیر پیدا نشد.'});
  }catch(e){
    console.error(e);
    return send(res,500,{error:'خطای داخلی سرور.'});
  }
});

setInterval(()=>{
  const now=Date.now();
  for(const [id,t] of online) if(now-t>15000) online.delete(id);
},5000);

server.listen(PORT,()=>console.log(`Strategy game server running on port ${PORT}`));