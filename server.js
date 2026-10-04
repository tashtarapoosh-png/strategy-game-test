import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=process.env.PORT||3000;
const SUPABASE_URL=(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
const SUPABASE_SECRET_KEY=process.env.SUPABASE_SECRET_KEY||'';
if(!SUPABASE_URL||!SUPABASE_SECRET_KEY) throw new Error('SUPABASE_URL و SUPABASE_SECRET_KEY باید در Environment تنظیم شوند.');

const UNIT_TYPES=['archer','swordsman','cavalry'];
const BUILDING_TYPES=['castle','wall','barracks1','barracks2','goldMine'];
const START_GOLD=3000;
const sessions=new Map();
const online=new Map();
const db={users:[]};

function now(){return Date.now()}
function int(v,d=0){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.floor(n)):d}
function safeType(v){return UNIT_TYPES.includes(v)?v:'archer'}
function emptyArmy(){return {archer:100,swordsman:100,cavalry:100}}
function defaultState(){return {gold:START_GOLD,army:emptyArmy(),buildings:{castle:{level:1},wall:{level:1},barracks1:{level:1},barracks2:{level:1},goldMine:{level:1}},activeUpgrade:null,activeTraining:{barracks1:null,barracks2:null},activeAttacks:[],pendingRecoveries:[],attackRestrictions:{},defenderSetups:{self:{slots:Array.from({length:6},()=>({type:'archer',count:0}))}},savedAt:now()}}
function normalizeState(s={}){const d=defaultState();const out={...d,...s};out.gold=Math.max(0,Number(s.gold??d.gold));out.army={...d.army,...(s.army||{})};for(const t of UNIT_TYPES)out.army[t]=int(out.army[t]);out.buildings={...d.buildings,...(s.buildings||{})};for(const b of BUILDING_TYPES)out.buildings[b]={level:Math.max(1,int(out.buildings[b]?.level,1))};out.activeTraining={...d.activeTraining,...(s.activeTraining||{})};out.activeAttacks=Array.isArray(s.activeAttacks)?s.activeAttacks:[];out.pendingRecoveries=Array.isArray(s.pendingRecoveries)?s.pendingRecoveries:[];out.attackRestrictions=s.attackRestrictions||{};out.defenderSetups=s.defenderSetups||d.defenderSetups;out.savedAt=Number(s.savedAt)||now();return out}

async function sb(table,{method='GET',query='',body=null,prefer=''}={}){
 const headers={apikey:SUPABASE_SECRET_KEY,Authorization:`Bearer ${SUPABASE_SECRET_KEY}`,'Content-Type':'application/json'};if(prefer)headers.Prefer=prefer;
 const c=new AbortController();const timer=setTimeout(()=>c.abort(),12000);
 try{const r=await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`,{method,headers,body:body==null?undefined:JSON.stringify(body),signal:c.signal,cache:'no-store'});const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}if(!r.ok)throw new Error(`Supabase ${table} ${r.status}`);return data}catch(e){if(e?.name==='AbortError')throw new Error(`ارتباط با پایگاه داده برای ${table} بیش از ۱۲ ثانیه طول کشید.`);throw e}finally{clearTimeout(timer)}}

function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')){return {salt,hash:crypto.scryptSync(password,salt,64).toString('hex')}}
function checkPassword(password,u){try{const a=Buffer.from(crypto.scryptSync(password,u.salt,64).toString('hex'),'hex');const b=Buffer.from(u.passwordHash,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}catch{return false}}
function token(){return crypto.randomBytes(32).toString('hex')}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(data))}
async function readBody(req){let s='';for await(const c of req)s+=c;return s?JSON.parse(s):{}}
function auth(req){const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return null;const id=sessions.get(h.slice(7));return db.users.find(u=>u.id===id)||null}
function touch(u){online.set(u.id,now())}

// Spiral addresses: castle 1 is the center. Every later player adds exactly five new cells.
function spiralCells(n){
 const out=[];let x=0,y=0;out.push({x,y});let step=1;
 while(out.length<n){for(let i=0;i<step&&out.length<n;i++){x++;out.push({x,y})}for(let i=0;i<step&&out.length<n;i++){y++;out.push({x,y})}step++;for(let i=0;i<step&&out.length<n;i++){x--;out.push({x,y})}for(let i=0;i<step&&out.length<n;i++){y--;out.push({x,y})}step++}
 return out;
}
function assignCell(){
 const count=db.users.length;
 const coords=spiralCells(Math.max(1,1+count*5));
 const start=count===0?0:1+(count-1)*5;
 const candidates=coords.slice(start,start+5);
 const used=new Set(db.users.map(u=>Number(u.cellIndex)).filter(Number.isInteger));
 const free=candidates.map((_,i)=>start+i).filter(i=>!used.has(i));
 const index=free.length?free[crypto.randomInt(free.length)]:0;
 const cellIndex=(count===0)?0:(start+index);
 const c=coords[cellIndex]||coords[0];
 return {index:cellIndex,key:String(cellIndex),x:c.x,y:c.y};
}
function publicUser(u){return {id:u.id,username:u.username,castleId:u.castleId,castleAddress:u.cellKey,cellIndex:u.cellIndex,x:u.x,y:u.y,state:u.state}}
function publicPlayers(){return db.users.map(u=>({id:u.id,username:u.username,castleId:u.castleId,cellKey:u.cellKey,cellIndex:u.cellIndex,x:u.x,y:u.y,online:online.has(u.id),castleLevel:u.state.buildings.castle.level}))}
function productionPerMinute(u){return 100*Math.pow(1.1,Math.max(0,u.state.buildings.goldMine.level-1))}
function applyOffline(u){const t=Math.max(0,now()-u.state.savedAt);u.state.gold+=productionPerMinute(u)*(t/60000);u.state.savedAt=now();return u}
async function saveUser(u){u.state=normalizeState(u.state);u.state.savedAt=now();await sb('players',{method:'POST',query:'?on_conflict=id',prefer:'resolution=merge-duplicates',body:{id:u.id,username:u.username,password_hash:u.passwordHash,password_salt:u.salt,castle_cell:u.cellIndex}});await sb('player_states',{method:'POST',query:'?on_conflict=player_id',prefer:'resolution=merge-duplicates',body:{player_id:u.id,gold:u.state.gold,buildings:u.state.buildings,army:u.state.army,active_upgrade:u.state.activeUpgrade,active_training:u.state.activeTraining,active_attacks:u.state.activeAttacks,pending_recoveries:u.state.pendingRecoveries,attack_restrictions:u.state.attackRestrictions,saved_at:new Date(u.state.savedAt).toISOString(),updated_at:new Date().toISOString()}});await sb('defender_setups',{method:'POST',query:'?on_conflict=player_id',prefer:'resolution=merge-duplicates',body:{player_id:u.id,setup:u.state.defenderSetups,updated_at:new Date().toISOString()}})}
async function loadDB(){
 const [players,states,setups]=await Promise.all([sb('players',{query:'?select=id,username,password_hash,password_salt,castle_cell&order=id.asc'}),sb('player_states',{query:'?select=player_id,gold,buildings,army,active_upgrade,active_training,active_attacks,pending_recoveries,attack_restrictions,saved_at'}),sb('defender_setups',{query:'?select=player_id,setup'})]);
 const sm=new Map(states.map(x=>[String(x.player_id),x]));const dm=new Map(setups.map(x=>[String(x.player_id),x.setup||{}]));
 db.users=(players||[]).map((p,i)=>{const s=sm.get(String(p.id));const setup=dm.get(String(p.id));const idx=Number(p.castle_cell);const cellIndex=Number.isInteger(idx)?idx:0;const coords=spiralCells(Math.max(1,1+(players.length)*5))[cellIndex]||{x:0,y:0};return{id:String(p.id),username:p.username,salt:p.password_salt,passwordHash:p.password_hash,castleId:i+1,cellIndex,cellKey:String(cellIndex),x:coords.x,y:coords.y,state:normalizeState({...s,defenderSetups:setup||{self:{slots:[]}}})}});
 // Existing DB rows keep their castle ids in load order. New registrations continue from max.
 db.users.forEach((u,i)=>u.castleId=i+1);
}
function nextCastleId(){return db.users.reduce((m,u)=>Math.max(m,Number(u.castleId)||0),0)+1}
function distance(a,b){return Math.max(1,Math.abs(a.x-b.x)+Math.abs(a.y-b.y))}
function normalizeSlots(slots,army){const rem={...army};return Array.from({length:6},(_,i)=>{const s=slots?.[i]||{};const type=safeType(s.type);const count=Math.min(int(s.count),rem[type]);rem[type]-=count;return {type,count}})}
function battleArmyFromAttack(a,side){return {castleId:a.attackerCastleId||a.targetCastleId,side,units:a.slots.map(s=>({type:s.type,count:s.count}))}}
function positionUnits(armies){
 const defenderBlocks=[[['A5','A6','A7','A8'],['C5','C6','C7','C8']],[['D4','D5','D6'],['E4','E5','E6']],[['D7','D8','D9'],['E7','E8','E9']],[['D1','D2','D3'],['E1','E2','E3']],[['D10','D11','D12'],['E10','E11','E12']]];
 const attackerBlocks=[[['Q4','Q5','Q6'],['P4','P5','P6']],[['Q7','Q8','Q9'],['P7','P8','P9']],[['Q1','Q2','Q3'],['P1','P2','P3']],[['Q10','Q11','Q12'],['P10','P11','P12']]];
 const seen={};let uid=1;
 for(const side of ['مدافع','مهاجم']){const blocks=side==='مدافع'?defenderBlocks:attackerBlocks;const owners=[];for(const army of armies.filter(x=>x.side===side)){if(!owners.includes(String(army.castleId)))owners.push(String(army.castleId));}
  owners.slice(0,4).forEach((owner,bi)=>{const cells=blocks[bi].flat();const army=armies.find(x=>String(x.castleId)===owner&&x.side===side);if(!army)return;let p=0;for(const u of army.units){if(!u.count)continue;u.unitId=uid++;u.x=Number((cells[p]||'A1').slice(1));u.y=(cells[p]||'A1').charCodeAt(0)-64;p++;if(p>=cells.length)p=cells.length-1;}})
 }
}

function getStoredBattleForUser(u,targetId){
 const arr=Array.isArray(u?.state?.activeAttacks)?u.state.activeAttacks:[];
 for(const a of arr){
  const b=a.battleState;
  if(b && String(b.targetId)===String(targetId) && !b.ended) return b;
 }
 return null;
}
async function batmanServer(attackerUser,attack){
 const target=String(attack.targetId);
 const defender=db.users.find(u=>String(u.id)===target);
 if(!defender)throw new Error('قلعه هدف پیدا نشد.');
 let battle=getStoredBattleForUser(defender,target);
 const defenders=normalizeSlots(defender.state.defenderSetups?.self?.slots,defender.state.army);
 const newAttacker={castleId:attack.attackerCastleId,side:'مهاجم',units:attack.slots.map(s=>({type:s.type,count:s.count}))};
 if(!battle){
  battle={id:crypto.randomUUID(),targetId:defender.id,targetCastleId:defender.castleId,defenderSlots:defenders,armies:[{castleId:defender.castleId,side:'مدافع',units:defenders.map(s=>({type:s.type,count:s.count}))},newAttacker],createdAt:now(),ended:false,winnerSide:null};
 }else{
  battle.armies=Array.isArray(battle.armies)?battle.armies:[];
  const existing=battle.armies.find(a=>String(a.castleId)===String(newAttacker.castleId)&&a.side==='مهاجم');
  if(existing)throw new Error('این قلعه قبلاً در این نبرد نیرو دارد.');
  if(battle.armies.filter(a=>a.side==='مهاجم').length>=4)throw new Error('ظرفیت مهاجمان این نبرد تکمیل است.');
  battle.armies.push(newAttacker);
 }
 positionUnits(battle.armies);
 // همان battleState در رکورد حمله مهاجم و رکورد ورودی مدافع ذخیره می‌شود.
 attack.battleState=battle;attack.battleTriggered=true;attack.status='arrived';attack.remaining=0;attack.battleId=battle.id;
 const incoming=defender.state.activeAttacks.find(a=>String(a.id)===String(attack.id)&&a.role==='defender');
 if(incoming){incoming.battleState=battle;incoming.battleTriggered=true;incoming.status='arrived';incoming.remaining=0;incoming.battleId=battle.id}
 await saveUser(attackerUser);await saveUser(defender);
 return battle;
}
function findBattleForUser(u,targetId){
 const direct=getStoredBattleForUser(u,targetId);if(direct)return direct;
 const arr=u.state.activeAttacks||[];const ownTarget=targetId?String(targetId):String(u.castleId);
 for(const a of arr)if(a.battleState&&(!targetId||String(a.battleState.targetId)===ownTarget))return a.battleState;
 return null;
}

const server=http.createServer(async(req,res)=>{
 if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,OPTIONS'});return res.end()}
 try{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);const p=url.pathname;
  if(req.method==='GET'&&(p==='/'||p==='/index.html'||p.startsWith('/images/'))){const rel=p==='/'?'index.html':p.slice(1);const fp=path.resolve(__dirname,rel);const root=path.resolve(__dirname,'images');if(rel==='index.html'||fp.startsWith(root+path.sep)){if(fs.existsSync(fp)){const ext=path.extname(fp).toLowerCase();const types={'.html':'text/html; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-cache'});return fs.createReadStream(fp).pipe(res)}}return send(res,404,{error:'فایل پیدا نشد.'})}
  if(p==='/api/register'&&req.method==='POST'){const {username,password}=await readBody(req);const name=String(username||'').trim();if(name.length<3||String(password||'').length<4)return send(res,400,{error:'نام کاربری حداقل ۳ و رمز حداقل ۴ کاراکتر باشد.'});if(db.users.some(u=>u.username.toLowerCase()===name.toLowerCase()))return send(res,409,{error:'این نام کاربری قبلاً ثبت شده است.'});const hp=hashPassword(String(password));const id=crypto.randomUUID();const castleId=nextCastleId();const address=assignCell();const u={id,username:name,salt:hp.salt,passwordHash:hp.hash,castleId,cellIndex:address.index,cellKey:address.key,x:address.x,y:address.y,state:defaultState()};db.users.push(u);await saveUser(u);const t=token();sessions.set(t,u.id);touch(u);return send(res,201,{token:t,user:publicUser(u)})}
  if(p==='/api/login'&&req.method==='POST'){const {username,password}=await readBody(req);const u=db.users.find(x=>x.username.toLowerCase()===String(username||'').trim().toLowerCase());if(!u||!checkPassword(String(password||''),u))return send(res,401,{error:'نام کاربری یا رمز عبور نادرست است.'});applyOffline(u);const t=token();sessions.set(t,u.id);touch(u);saveUser(u).catch(console.error);return send(res,200,{token:t,user:publicUser(u)})}
  const u=auth(req);if(!u)return send(res,401,{error:'ابتدا وارد حساب شوید.'});touch(u);
  if(p==='/api/me'&&req.method==='GET'){applyOffline(u);return send(res,200,{user:publicUser(u)})}
  if(p==='/api/state'&&req.method==='PUT'){const incoming=await readBody(req);u.state=normalizeState(incoming);await saveUser(u);return send(res,200,{state:u.state})}
  if(p==='/api/players'&&req.method==='GET'){return send(res,200,{selfId:u.id,players:publicPlayers(),spiral:spiralCells(Math.max(1,db.users.length*5+1))})}
  if(p==='/api/defense'&&req.method==='PUT'){const input=await readBody(req);u.state.defenderSetups={self:{slots:normalizeSlots(input.slots,u.state.army)}};await saveUser(u);return send(res,200,{setup:u.state.defenderSetups})}
  if(p==='/api/attack'&&req.method==='POST'){
   const input=await readBody(req);const target=db.users.find(x=>String(x.id)===String(input.targetId));if(!target)return send(res,404,{error:'قلعه هدف پیدا نشد.'});if(target.id===u.id)return send(res,400,{error:'نمی‌توانید به قلعه خودتان حمله کنید.'});
   const slots=normalizeSlots(input.slots,u.state.army);const total=slots.reduce((n,s)=>n+s.count,0);if(total<1)return send(res,400,{error:'حداقل یک نیرو انتخاب کنید.'});
   const distanceCells=distance(u,target);const travelSeconds=Math.max(20,distanceCells*20);for(const t of UNIT_TYPES){const used=slots.filter(s=>s.type===t).reduce((n,s)=>n+s.count,0);if(used>u.state.army[t])return send(res,400,{error:'تعداد نیرو بیشتر از موجودی است.'});u.state.army[t]-=used}
   const attack={id:crypto.randomUUID(),attackerId:u.id,targetId:target.id,attackerCastleId:u.castleId,targetCastleId:target.castleId,slots,createdAt:now(),arrivalAt:now()+travelSeconds*1000,remaining:travelSeconds,status:'traveling'};
   u.state.activeAttacks.push(attack);await saveUser(u);return send(res,201,{attack,state:u.state})
  }
  if(p==='/api/attacks'&&req.method==='GET'){const list=u.state.activeAttacks.filter(a=>!a.battleTriggered);return send(res,200,{attacks:list})}
  if(p==='/api/batman'&&req.method==='POST'){
   const input=await readBody(req);const attack=u.state.activeAttacks.find(a=>String(a.id)===String(input.attackId));if(!attack)return send(res,404,{error:'حمله پیدا نشد.'});if(attack.battleTriggered)return send(res,200,{battle:findBattleForUser(u,attack.targetId),already:true});if(now()<Number(attack.arrivalAt))return send(res,400,{error:'تایمر هنوز به صفر نرسیده است.'});
   try{const battle=await batmanServer(u,attack);return send(res,200,{battle})}catch(e){attack.status='returned';attack.battleTriggered=true;await saveUser(u);return send(res,400,{error:e.message||'نیرو به نبرد اضافه نشد.'})}
  }
  if(p==='/api/battle/current'&&req.method==='GET'){const targetId=url.searchParams.get('targetId');const b=findBattleForUser(u,targetId);return send(res,200,{battle:b})}
  if(p==='/api/battles'&&req.method==='GET'){const b=findBattleForUser(u,String(u.castleId));return send(res,200,{battle:b})}
  return send(res,404,{error:'مسیر پیدا نشد.'})
 }catch(e){console.error(e);return send(res,500,{error:e.message||'خطای داخلی سرور.'})}
});

setInterval(()=>{const t=now();for(const [id,last] of online)if(t-last>20000)online.delete(id)},5000);
await loadDB();
server.listen(PORT,()=>console.log(`New strategy game server running on ${PORT}; players=${db.users.length}`));
