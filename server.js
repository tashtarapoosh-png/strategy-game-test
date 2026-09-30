import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// On Render, set DATA_DIR to the mount path of a Persistent Disk.
// Locally it falls back to this project directory.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('SUPABASE_URL و SUPABASE_SECRET_KEY باید در Environment تنظیم شوند.');
const BASE_WORLD_CELLS = 100; const CELLS_PER_PLAYER = 10; const DEVELOPMENT_MAX_LEVEL = 5; const BASE_GOLD_PER_MINUTE = 100; const STARTING_GOLD = 3000; const BASE_TRAINING_CAPACITY = 10; const BASE_TRAINING_TIME_SECONDS = 60; const UNIT_TYPES = ['archer','cavalry','swordsman']; const BUILDING_TYPES = ['castle','wall','barracks1','barracks2','goldMine'];
const sessions = new Map(); const online = new Map();
const initialState = () => ({gold:STARTING_GOLD,buildings:{castle:{level:1},wall:{level:1},barracks1:{level:1},barracks2:{level:1},goldMine:{level:1}},army:{archer:100,cavalry:100,swordsman:100},activeUpgrade:null,activeTraining:{barracks1:null,barracks2:null},activeAttacks:[],defenderSetups:{},pendingRecoveries:[],attackRestrictions:{},savedAt:Date.now()});
let db={nextId:1,users:[]};
async function supabaseRequest(table,{method='GET',query='',body=null,prefer=''}={}){const headers={apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`,'Content-Type':'application/json'};if(prefer)headers.Prefer=prefer;const response=await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`,{method,headers,body:body===null?undefined:JSON.stringify(body)});const text=await response.text();let data=null;try{data=text?JSON.parse(text):null}catch{data=text;}if(!response.ok)throw new Error(`Supabase ${method} ${table} failed (${response.status}): ${typeof data==='string'?data:JSON.stringify(data)}`);return data;}
async function loadDB(){const rows=await supabaseRequest('players',{query:'?select=id,username,password_hash,password_salt,castle_cell'});const states=await supabaseRequest('player_states',{query:'?select=player_id,gold,buildings,army,active_upgrade,active_training,active_attacks,pending_recoveries,attack_restrictions,saved_at'});const setups=await supabaseRequest('defender_setups',{query:'?select=player_id,setup'});const stateMap=new Map(states.map(r=>[String(r.player_id),r]));const setupMap=new Map(setups.map(r=>[String(r.player_id),r.setup||{}]));db.users=rows.map(row=>{const s=stateMap.get(String(row.id));const state=normalizeState({gold:s?.gold,buildings:s?.buildings,army:s?.army,activeUpgrade:s?.active_upgrade,activeTraining:s?.active_training,activeAttacks:s?.active_attacks,pendingRecoveries:s?.pending_recoveries,attackRestrictions:s?.attack_restrictions,defenderSetups:setupMap.get(String(row.id))||{},savedAt:s?.saved_at?new Date(s.saved_at).getTime():Date.now()});return{id:String(row.id),username:row.username,salt:row.password_salt,passwordHash:row.password_hash,state,cell:Number.isInteger(Number(row.castle_cell))?Number(row.castle_cell):null,lastStateAt:s?.saved_at?new Date(s.saved_at).getTime():Date.now()};});return db;}
async function saveUser(user){const now=Date.now();user.state=normalizeState(user.state);user.state.savedAt=now;user.lastStateAt=now;await supabaseRequest('players',{method:'POST',query:'?on_conflict=id',prefer:'resolution=merge-duplicates',body:{id:user.id,username:user.username,password_hash:user.passwordHash,password_salt:user.salt,castle_cell:user.cell}});await supabaseRequest('player_states',{method:'POST',query:'?on_conflict=player_id',prefer:'resolution=merge-duplicates',body:{player_id:user.id,gold:user.state.gold,buildings:user.state.buildings,army:user.state.army,active_upgrade:user.state.activeUpgrade,active_training:user.state.activeTraining,active_attacks:user.state.activeAttacks,pending_recoveries:user.state.pendingRecoveries,attack_restrictions:user.state.attackRestrictions,saved_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString()}});await supabaseRequest('defender_setups',{method:'POST',query:'?on_conflict=player_id',prefer:'resolution=merge-duplicates',body:{player_id:user.id,setup:user.state.defenderSetups||{},updated_at:new Date(now).toISOString()}});}
async function findUserByUsername(username){const rows=await supabaseRequest('players',{query:`?username=ilike.${encodeURIComponent(username)}&select=id,username,password_hash,password_salt,castle_cell`});if(!rows?.length)return null;const row=rows[0];const states=await supabaseRequest('player_states',{query:`?player_id=eq.${encodeURIComponent(row.id)}&select=gold,buildings,army,active_upgrade,active_training,active_attacks,pending_recoveries,attack_restrictions,saved_at`});const setups=await supabaseRequest('defender_setups',{query:`?player_id=eq.${encodeURIComponent(row.id)}&select=setup`});const s=states?.[0];return{id:String(row.id),username:row.username,salt:row.password_salt,passwordHash:row.password_hash,state:normalizeState({gold:s?.gold,buildings:s?.buildings,army:s?.army,activeUpgrade:s?.active_upgrade,activeTraining:s?.active_training,activeAttacks:s?.active_attacks,pendingRecoveries:s?.pending_recoveries,attackRestrictions:s?.attack_restrictions,defenderSetups:setups?.[0]?.setup||{},savedAt:s?.saved_at?new Date(s.saved_at).getTime():Date.now()}),cell:Number.isInteger(Number(row.castle_cell))?Number(row.castle_cell):null,lastStateAt:s?.saved_at?new Date(s.saved_at).getTime():Date.now()};}

function sanitizeDefenseSlots(slots, army){
  const valid=new Set(UNIT_TYPES);
  const rem={archer:int(army?.archer),cavalry:int(army?.cavalry),swordsman:int(army?.swordsman)};
  return Array.from({length:6},(_,i)=>{
    const x=Array.isArray(slots)?(slots[i]||{}):{};
    const type=valid.has(x.type)?x.type:'archer';
    const requested=int(x.count);
    const count=Math.min(requested,rem[type]);
    rem[type]-=count;
    return {type,count};
  });
}
function attackForClient(a, attacker, defender){
  return {...a, attackerName:attacker?.username||'مهاجم', defenderName:defender?.username||'مدافع', arrivalAt:Number(a.arrivalAt)||0};
}
async function persistAttackToUsers(attacker, defender){
  await saveUser(attacker);
  await saveUser(defender);
}

function findAttackPair(id){
  const key=String(id);
  let attacker=null, defender=null, attack=null;
  for(const user of db.users){
    for(const a of (Array.isArray(user.state?.activeAttacks)?user.state.activeAttacks:[])){
      if(String(a.id)!==key) continue;
      if(a.role==='attacker'){ attacker=user; attack=a; }
      if(a.role==='defender'){ defender=user; }
    }
  }
  return {attacker,defender,attack};
}

function mergeServerAttacks(currentState, incomingState){
  const incoming=normalizeState(incomingState);
  const current=Array.isArray(currentState?.activeAttacks)?currentState.activeAttacks:[];
  const currentById=new Map(current.map(a=>[String(a.id),a]));
  const merged=[];
  for(const a of incoming.activeAttacks){
    const old=currentById.get(String(a.id));
    if(old?.battleEndedAt) merged.push(old);
    else merged.push(a);
    currentById.delete(String(a.id));
  }
  // A client PUT must never erase a server-created march/attack that is still active.
  for(const a of currentById.values()){
    if(!a.battleEndedAt) merged.push(a);
  }
  incoming.activeAttacks=merged.slice(0,100);
  return incoming;
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
        id:crypto.randomUUID(),
        username,
        salt:p.salt,
        passwordHash:p.hash,
        state:initialState(),
        cell:assignCell(),
        lastStateAt:now
      };
      u.state.savedAt=now;
      db.users.push(u);
      await saveUser(u);

      const t=token();
      sessions.set(t,u.id);
      touch(u);
      return send(res,201,{token:t,user:publicUser(u)});
    }

    if(req.url==='/api/login'&&req.method==='POST'){
      const {username,password}=await body(req);
      const u=await findUserByUsername(String(username||'').trim());
      if(!u||!checkPassword(String(password||''),u))
        return send(res,401,{error:'نام کاربری یا رمز عبور نادرست است.'});

      applyOfflineProgress(u);
      if(!Number.isInteger(u.cell)||u.cell<0||u.cell>=getWorldSize()) u.cell=assignCell();
      await saveUser(u);

      const t=token();
      sessions.set(t,u.id);
      touch(u);
      return send(res,200,{token:t,user:publicUser(u),worldSize:getWorldSize()});
    }

    // Public static files must be served before authentication.
    if(req.method==='GET') {
      const requestPath=new URL(req.url,`http://${req.headers.host||'localhost'}`).pathname;
      let fileName=null;
      if(requestPath==='/'||requestPath==='/index.html'||requestPath==='/ghalee1.png') fileName=requestPath==='/'?'index.html':requestPath.slice(1);
      else if(requestPath.startsWith('/images/')) fileName=requestPath.slice(1);
      if(fileName){
        const filePath=path.resolve(__dirname,fileName);
        const imagesRoot=path.resolve(__dirname,'images');
        const allowedRoot=fileName==='index.html'||fileName==='ghalee1.png';
        const allowedImage=filePath.startsWith(imagesRoot+path.sep);
        if(allowedRoot||allowedImage){
          if(fs.existsSync(filePath)&&fs.statSync(filePath).isFile()){
            const ext=path.extname(filePath).toLowerCase();
            const types={'.html':'text/html; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'};
            res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-cache'});
            return fs.createReadStream(filePath).pipe(res);
          }
          return send(res,404,{error:'فایل پیدا نشد.'});
        }
      }
    }
    if(req.method==='GET' && (req.url==='/' || req.url==='/index.html' || req.url==='/ghalee1.png')){
      const fileName=req.url==='/'?'index.html':req.url.slice(1);
      const filePath=path.join(__dirname,fileName);
      if(fs.existsSync(filePath)){
        const ext=path.extname(filePath).toLowerCase();
        const type=ext==='.html'?'text/html; charset=utf-8':ext==='.png'?'image/png':'application/octet-stream';
        res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-cache'});
        return fs.createReadStream(filePath).pipe(res);
      }
      return send(res,404,{error:'فایل پیدا نشد.'});
    }

    const u=auth(req);
    if(!u)return send(res,401,{error:'ابتدا وارد حساب شوید.'});
    touch(u);

    if(req.url==='/api/attack'&&req.method==='POST'){
      const input=await body(req);
      const defender=db.users.find(x=>String(x.id)===String(input.targetId));
      if(!defender) return send(res,404,{error:'بازیکن هدف پیدا نشد.'});
      if(String(defender.id)===String(u.id)) return send(res,400,{error:'نمی‌توانید به خودتان حمله کنید.'});
      const slots=Array.isArray(input.slots)?input.slots.slice(0,6):[];
      const composition={archer:0,cavalry:0,swordsman:0};
      for(const slot of slots){ if(UNIT_TYPES.includes(slot?.type)) composition[slot.type]+=int(slot.count); }
      const total=composition.archer+composition.cavalry+composition.swordsman;
      const cost=Math.max(0,int(input.attackCost,total));
      if(total<1) return send(res,400,{error:'حداقل یک نیرو برای حمله لازم است.'});
      for(const type of UNIT_TYPES){ if(composition[type]>int(u.state.army[type])) return send(res,400,{error:`تعداد ${type} بیشتر از نیروهای موجود است.`}); }
      if(Number(u.state.gold)<cost) return send(res,400,{error:'طلای کافی برای حمله وجود ندارد.'});
      const distance=Math.max(1,num(input.distance,1));
      const travelSeconds=Math.max(60,int(input.travelSeconds,Math.round(distance*60)));
      const now=Date.now();
      const attackId=crypto.randomUUID();
      const defenderSetup={slots:sanitizeDefenseSlots(defender.state.defenderSetups?.self?.slots,defender.state.army)};
      u.state.gold-=cost;
      for(const type of UNIT_TYPES) u.state.army[type]-=composition[type];
      const attack={id:attackId,attackerId:u.id,targetId:defender.id,attackerName:u.username,targetName:defender.username,distance,remaining:travelSeconds,totalTravel:travelSeconds,arrivalAt:now+travelSeconds*1000,status:'traveling',role:'attacker',slots,composition,defenderSetup,attackCost:cost,createdAt:now};
      const incoming={...attack,role:'defender',remaining:travelSeconds};
      u.state.activeAttacks=Array.isArray(u.state.activeAttacks)?u.state.activeAttacks:[];
      defender.state.activeAttacks=Array.isArray(defender.state.activeAttacks)?defender.state.activeAttacks:[];
      u.state.activeAttacks.push(attack);
      defender.state.activeAttacks.push(incoming);
      await persistAttackToUsers(u,defender);
      return send(res,201,{ok:true,attack,state:u.state});
    }

    if(req.url==='/api/attacks/outgoing'&&req.method==='GET'){
      const now=Date.now();
      const outgoing=Array.isArray(u.state.activeAttacks)?u.state.activeAttacks.filter(a=>a.role==='attacker'&&!a.battleEndedAt):[];
      let changed=false;
      for(const a of outgoing){
        if(a.status==='traveling' && Number(a.arrivalAt)<=now){ a.status='arrived'; a.remaining=0; changed=true; }
        if(a.status==='arrived' && !a.battleStartedAt){
          const defender=db.users.find(x=>String(x.id)===String(a.targetId));
          if(defender){ a.defenderSetup={slots:sanitizeDefenseSlots(defender.state.defenderSetups?.self?.slots,defender.state.army)}; changed=true; }
        }
      }
      if(changed) await saveUser(u);
      const result=outgoing.map(a=>attackForClient(a, u, db.users.find(x=>String(x.id)===String(a.targetId))));
      return send(res,200,{attacks:result});
    }

    if(req.url==='/api/attacks/incoming'&&req.method==='GET'){
      const now=Date.now();
      const incoming=Array.isArray(u.state.activeAttacks)?u.state.activeAttacks.filter(a=>a.role==='defender'&&!a.battleEndedAt):[];
      let changed=false;
      for(const a of incoming){
        if(a.status==='traveling' && Number(a.arrivalAt)<=now){ a.status='arrived'; a.remaining=0; a.defenderSetup={slots:sanitizeDefenseSlots(u.state.defenderSetups?.self?.slots,u.state.army)}; changed=true; }
        else if(a.status==='arrived' && !a.battleStartedAt){
          a.defenderSetup={slots:sanitizeDefenseSlots(u.state.defenderSetups?.self?.slots,u.state.army)};
          changed=true;
        }
      }
      if(changed) await saveUser(u);
      const result=[];
      for(const a of incoming){
        const attacker=db.users.find(x=>String(x.id)===String(a.attackerId));
        result.push(attackForClient(a,attacker,u));
      }
      return send(res,200,{attacks:result});
    }

    if(req.url.match(/^\/api\/attacks\/[^/]+\/start$/)&&req.method==='POST'){
      const id=req.url.split('/')[3];
      const pair=findAttackPair(id);
      if(!pair.attacker || !pair.defender || !pair.attack) return send(res,404,{error:'حمله پیدا نشد.'});
      if(String(pair.attacker.id)!==String(u.id) && String(pair.defender.id)!==String(u.id)) return send(res,403,{error:'شما عضو این نبرد نیستید.'});
      if(Number(pair.attack.arrivalAt)>Date.now()) return send(res,400,{error:'هنوز زمان رسیدن نیروها نرسیده است.'});
      pair.attack.status='arrived';
      pair.attack.remaining=0;
      const attackerCopy=pair.attacker.state.activeAttacks.find(a=>String(a.id)===String(id)&&a.role==='attacker');
      const defenderCopy=pair.defender.state.activeAttacks.find(a=>String(a.id)===String(id)&&a.role==='defender');
      const setup=sanitizeDefenseSlots(pair.defender.state.defenderSetups?.self?.slots,pair.defender.state.army);
      const startedAt=pair.attack.battleStartedAt || Date.now();
      for(const copy of [pair.attack,attackerCopy,defenderCopy]) if(copy){ copy.status='battle'; copy.battleStartedAt=startedAt; copy.defenderSetup={slots:setup.map(x=>({...x}))}; }
      await persistAttackToUsers(pair.attacker,pair.defender);
      return send(res,200,{attack:attackForClient(pair.attack,pair.attacker,pair.defender)});
    }

    if(req.url.match(/^\/api\/attacks\/[^/]+\/finish$/)&&req.method==='POST'){
      const id=req.url.split('/')[3];
      const input=await body(req);
      const pair=findAttackPair(id);
      if(!pair.attacker || !pair.defender) return send(res,404,{error:'حمله پیدا نشد.'});
      if(String(pair.attacker.id)!==String(u.id) && String(pair.defender.id)!==String(u.id)) return send(res,403,{error:'شما عضو این نبرد نیستید.'});
      const finishedAt=Date.now();
      const result={winner:Number(input.winner)===2?2:1,loser:Number(input.loser)===2?2:1,endReason:String(input.endReason||'پایان نبرد'),losses:input.losses||null};
      for(const user of [pair.attacker,pair.defender]){
        const copy=user.state.activeAttacks.find(a=>String(a.id)===String(id));
        if(copy){ Object.assign(copy,result,{status:'finished',battleEndedAt:finishedAt,resultReadyAt:finishedAt}); }
      }
      await persistAttackToUsers(pair.attacker,pair.defender);
      return send(res,200,{ok:true,attack:attackForClient(pair.attack,pair.attacker,pair.defender)});
    }

    if(req.url.startsWith('/api/attacks/')&&req.method==='POST'){
      const id=req.url.split('/')[3];
      const incoming=Array.isArray(u.state.activeAttacks)?u.state.activeAttacks.find(a=>String(a.id)===String(id)&&a.role==='defender'):null;
      if(!incoming) return send(res,404,{error:'حمله پیدا نشد.'});
      if(Number(incoming.arrivalAt)>Date.now()) return send(res,400,{error:'هنوز زمان رسیدن نیروها نرسیده است.'});
      incoming.status='arrived'; incoming.remaining=0;
      incoming.defenderSetup={slots:sanitizeDefenseSlots(u.state.defenderSetups?.self?.slots,u.state.army)};
      await saveUser(u);
      return send(res,200,{attack:incoming});
    }

    if(req.url==='/api/state'&&req.method==='PUT'){
      const incoming=await body(req);
      // Server time is authoritative. The client cannot choose savedAt or use a browser clock
      // to manufacture offline gold. Preserve server-side attack lifecycle so a stale client
      // cannot resurrect an already-finished warning or erase an active march.
      u.state=mergeServerAttacks(u.state,incoming);
      u.state.savedAt=Date.now();
      u.lastStateAt=u.state.savedAt;
      await saveUser(u);
      return send(res,200,{ok:true,state:u.state});
    }

    if(req.url==='/api/state'&&req.method==='GET'){
      applyOfflineProgress(u);
      await saveUser(u);
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

await loadDB();
console.log(`Loaded ${db.users.length} player(s) from Supabase.`);
server.listen(PORT,()=>console.log(`Strategy game server running on port ${PORT}`));