// render-service: GPU frame-stepped VRM renderer behind a small HTTP API (one job at a time).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process'; import { chromium } from 'playwright-core';
const ROOT=process.env.RENDER_ROOT||'/workspace/plana-render', PLAYER=ROOT+'/player', ASSETS=ROOT+'/assets', JOBS=ROOT+'/jobs';
const PORT=+(process.env.PORT||18189), INTERNAL=+(process.env.INTERNAL_PORT||18190);
const KEY=fs.readFileSync(ROOT+'/.key','utf8').trim();
const SHM=process.env.SHM_DIR||'/dev/shm/arona-render', MIN_SHM_MB=1000;
const NO_CHARACTERS=new Set(['p03']); // Pen: LivLiv holds no rights, never rendered
const CC_BY_NC_SA=new Set(['p01','p02']); // Kujira / Kujira Q: CC BY-NC-SA 4.0, attribution required
const creditFor=id=>CC_BY_NC_SA.has(id)?'Kujira: 上善无形、ZipZipPipe (CC BY-NC-SA 4.0); model: LivLiv':'角色: LivLiv (livliv.ai)';
const VRM_CREDIT={'BlueFatFish.vrm':'模型: 蓝色小肥鱼Deepseek by 木子恶魔 (非商用; 禁止再分发/修改)'};
// Live2D (M4): models are PRE-PLACED under PLAYER/Resources/<name>/ (never
// uploaded via the API — the service must not become a model distribution
// point). Credit is fixed server-side per model and cannot be overridden or
// disabled by the request (plan §1 acceptance 4). M0 final wording still
// pending; this is the plan's draft credit.
const LIVE2D_CREDIT={DSGongpi:'模型: 大肥鱼 DeepSeek-chan by 神宫凉子 / 霓虹猫_NeonNeko（免费公皮，禁止再分发）'};
const creditForLive2d=id=>LIVE2D_CREDIT[id]||`模型: ${id} (Live2D)`;
const live2dDir=name=>`${PLAYER}/Resources/${name}`;
const live2dModelFile=name=>`${live2dDir(name)}/${name}.model3.json`;
const live2dConfig=name=>{ try{ return JSON.parse(fs.readFileSync(`${live2dDir(name)}/${name}.config.json`,'utf8')) }catch{ return null } };
const live2dModels=()=>{ try{ return fs.readdirSync(`${PLAYER}/Resources`).filter(d=>{ try{ return fs.statSync(live2dModelFile(d)).isFile() }catch{ return false } }) }catch{ return [] } };
const FONT=(()=>{ try{ return execFileSync('fc-match',['-f','%{file}','WenQuanYi Zen Hei Mono'],{encoding:'utf8'}).trim() }catch{ return '' } })();
const MIN_VRAM_MIB=1200, MIN_DISK_MB=1500, MAX_PIXELS=2.2e6, MAX_FRAMES=1800, KEEP_JOBS=10;
for(const d of ['vrm','audio','bg']) fs.mkdirSync(`${ASSETS}/${d}`,{recursive:true}); fs.mkdirSync(JOBS,{recursive:true});
fs.rmSync(SHM,{recursive:true,force:true}); fs.mkdirSync(SHM,{recursive:true});
const log=(...a)=>console.log(new Date().toISOString(),...a);
const MIME={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.wav':'audio/wav','.vrm':'application/octet-stream','.glb':'application/octet-stream','.mp4':'video/mp4','.css':'text/css','.map':'application/json'};
const EXT={vrm:['.vrm','.glb'],audio:['.wav'],bg:['.png','.jpg','.jpeg','.webp']};
// ---- internal static server (only for our own Chromium, bound to 127.0.0.1) ----
http.createServer((req,res)=>{
  try{
    const u=new URL(req.url,'http://x'); let p=decodeURIComponent(u.pathname);
    const base=p.startsWith('/assets/')?ASSETS:PLAYER; if(base===ASSETS) p=p.slice(7);
    const f=path.normalize(path.join(base,p)); if(!f.startsWith(base+path.sep)||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404);return res.end()}
    res.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(res);
  }catch(e){res.writeHead(500);res.end()}
}).listen(INTERNAL,'127.0.0.1');
// ---- helpers ----
const freeVramMiB=()=>{ try{ return +execFileSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim().split('\n')[0] }catch{ return -1 } };
const freeDiskMB=()=>{ const s=fs.statfsSync(ROOT); return Math.floor(s.bavail*s.bsize/1048576) };
const freeShmMB=()=>{ try{ const s=fs.statfsSync(SHM); return Math.floor(s.bavail*s.bsize/1048576) }catch{ return 0 } };
const json=(res,code,obj)=>{ res.writeHead(code,{'content-type':'application/json'}); res.end(JSON.stringify(obj)) };
const okKey=h=>{ const a=Buffer.from(String(h||'')), b=Buffer.from(KEY); return a.length===b.length&&crypto.timingSafeEqual(a,b) };
const safeName=n=>/^[A-Za-z0-9_.-]{1,80}$/.test(n)&&!n.startsWith('.');
function readWav(file){ // 16-bit PCM; first channel
  const buf=fs.readFileSync(file); let o=12, rate=0, ch=1, bits=0, fmt=0, dataAt=0;
  if(buf.toString('ascii',0,4)!=='RIFF'||buf.toString('ascii',8,12)!=='WAVE') throw new Error('audio is not a WAV');
  while(o+8<=buf.length){ const id=buf.toString('ascii',o,o+4), sz=buf.readUInt32LE(o+4);
    if(id==='fmt '){ fmt=buf.readUInt16LE(o+8); ch=buf.readUInt16LE(o+10); rate=buf.readUInt32LE(o+12); bits=buf.readUInt16LE(o+22) }
    if(id==='data'){ dataAt=o+8; break } o+=8+sz+(sz&1) }
  if(fmt!==1||bits!==16||!dataAt) throw new Error('WAV must be 16-bit PCM');
  const step=2*ch, n=Math.floor((buf.length-dataAt)/step), x=new Float32Array(n);
  for(let i=0;i<n;i++) x[i]=buf.readInt16LE(dataAt+step*i)/32768; return {x,rate,dur:n/rate};
}
function envelope({x,rate}){ // the player's own mouth envelope (src/runtime/speech.ts), 100 Hz, LEAD 3 frames
  const n=x.length, hop=Math.max(1,Math.round(rate/100)), m=Math.ceil(n/hop);
  const lp=1-Math.exp(-2*Math.PI*1500/rate), hp=1-Math.exp(-2*Math.PI*150/rate), sum=new Float32Array(m); let a=0,b=0;
  for(let i=0;i<n;i++){ a+=(x[i]-a)*lp; b+=(a-b)*hp; const v=a-b; sum[Math.floor(i/hop)]+=v*v }
  const e=new Float32Array(m); let max=0; for(let i=0;i<m;i++){ e[i]=Math.sqrt((sum[i]+(sum[i+1]??0))/(2*hop)); max=Math.max(max,e[i]) }
  const voiced=Array.from(e).filter(v=>v>max*0.05).sort((p,q)=>p-q), ref=voiced[Math.floor(voiced.length*0.9)]||max, gate=ref*0.1;
  const lv=Array.from(e,v=>Math.pow(Math.min(1,Math.max(0,(v-gate)/Math.max(ref-gate,1e-6))),0.75));
  const K=10, env=new Float32Array(m); let s=0;
  for(let i=0;i<m;i++){ let avg=0; for(let j=i-K;j<=i+K;j++) avg+=lv[Math.min(m-1,Math.max(0,j))]; avg/=2*K+1;
    const t=Math.min(1,Math.max(0,lv[i]*0.6+(lv[i]-avg)*1.2)); s+=(t-s)*(t>s?0.6:0.45); env[i]=s }
  const e2=Float32Array.from({length:m},(_,i)=>env[i+3]??0);
  return t=>{ const f=t*100; if(f<0) return 0; const i=Math.floor(f), k=f-i; return (e2[i]??0)*(1-k)+(e2[i+1]??0)*k };
}
// ---- jobs ----
const jobs=new Map(), queue=[]; let running=false;
function validate(b){
  const num=(v,d,lo,hi,name)=>{ const x=v===undefined?d:+v; if(!Number.isFinite(x)||x<lo||x>hi) throw new Error(`${name} must be in [${lo}, ${hi}]`); return x };
  const j={ vrm:b.vrm?String(b.vrm):null, character:b.character?String(b.character):null, live2d:b.live2d?String(b.live2d):null, motion:b.motion?String(b.motion):null, credit:b.credit===undefined?undefined:b.credit, audio:b.audio?String(b.audio):null, bg:b.bg?String(b.bg):null, bgColor:b.bgColor?String(b.bgColor):null,
    width:Math.round(num(b.width,720,64,2048,'width')), height:Math.round(num(b.height,1280,64,2048,'height')), fps:num(b.fps,24,1,30,'fps'),
    amb:num(b.amb,0,0,3,'amb'), dir:b.dir===undefined?null:num(b.dir,Math.PI,0,10,'dir'), gain:num(b.gain,0.65,0,1,'gain'),
    pre:num(b.pre,0.6,0,10,'pre'), post:num(b.post,1,0,10,'post'), duration:num(b.duration,0,0,60,'duration'), idle:b.idle!==false,
    view:{x:num(b.view?.x,0,-2,2,'view.x'),y:num(b.view?.y,0,-2,2,'view.y'),zoom:num(b.view?.zoom,1,0.2,5,'view.zoom')},
    timeline:Array.isArray(b.timeline)?b.timeline.slice(0,500).map(k=>({t:num(k.t,0,-10,120,'timeline.t'),e:Object.fromEntries(Object.entries(k.e||{}).slice(0,20).map(([id,w])=>{ if(!/^[A-Za-z0-9_]{1,40}$/.test(id)) throw new Error('bad expression id'); return [id,num(w,1,0,1,'weight')] }))})).sort((a,c)=>a.t-c.t):[],
    actions:Array.isArray(b.actions)?b.actions.slice(0,200).map(a=>{ if(b.live2d){ if(typeof a.name!=='string'||!/^[A-Za-z0-9_]{1,40}$/.test(a.name)) throw new Error('bad live2d action (must be a motion alias)'); } else if(!['nod','shake','tilt','hop','shy'].includes(a.name)) throw new Error('bad action'); return {t:num(a.t,0,-10,120,'actions.t'),name:a.name} }).sort((a,c)=>a.t-c.t):[] };
  if(j.width*j.height>MAX_PIXELS) throw new Error(`too many pixels (max ${MAX_PIXELS})`);
  if((!!j.vrm)+(!!j.character)+(!!j.live2d)!==1) throw new Error('give exactly one of vrm, character or live2d');
  if(j.vrm&&(!safeName(j.vrm)||!fs.existsSync(`${ASSETS}/vrm/${j.vrm}`))) throw new Error('unknown vrm asset');
  if(j.character){
    if(!/^[A-Za-z0-9_]{1,20}$/.test(j.character)||!fs.existsSync(`${PLAYER}/characters/${j.character}/model.json`)) throw new Error('unknown character');
    if(NO_CHARACTERS.has(j.character)) throw new Error(`character ${j.character} is not available (no rights granted)`);
    if(j.credit===undefined) j.credit=creditFor(j.character);
  }
  if(j.live2d){
    if(!/^[A-Za-z0-9_-]{1,40}$/.test(j.live2d)||!fs.existsSync(live2dModelFile(j.live2d))) throw new Error('unknown live2d model');
    const cfg=live2dConfig(j.live2d), motions=cfg?.motions?Object.keys(cfg.motions):[], exprs=cfg?.expressions?Object.keys(cfg.expressions):[];
    if(j.motion&&!motions.includes(j.motion)) throw new Error(`unknown live2d motion "${j.motion}" (have: ${motions.join(', ')})`);
    for(const k of j.timeline) for(const id of Object.keys(k.e)) if(exprs.length&&!exprs.includes(id)) throw new Error(`unknown live2d expression "${id}" (have: ${exprs.join(', ')})`);
    for(const a of j.actions) if(!motions.includes(a.name)) throw new Error(`unknown live2d motion "${a.name}" (have: ${motions.join(', ')})`);
    // Live2D is always portrait 9:16 (the render page frames the model that
    // way); derive height from width. Re-check pixels after the override.
    j.height=Math.round(j.width*1280/720);
    if(j.width*j.height>MAX_PIXELS) throw new Error(`too many pixels (max ${MAX_PIXELS})`);
    // Credit is fixed server-side for Live2D: the client cannot override or
    // disable it. bg/view/amb/dir/idle are VRM/LivLiv-only and ignored here.
    j.credit=creditForLive2d(j.live2d);
  }
  if(j.vrm&&j.credit===undefined&&VRM_CREDIT[j.vrm]) j.credit=VRM_CREDIT[j.vrm];
  if(j.credit!==undefined&&j.credit!==false&&j.credit!==null&&(typeof j.credit!=='string'||j.credit.length>160||/[\u0000-\u001f]/.test(j.credit))) throw new Error('credit must be a string (<=160 chars, no control chars), or false');
  if(j.audio&&(!safeName(j.audio)||!fs.existsSync(`${ASSETS}/audio/${j.audio}`))) throw new Error('unknown audio asset');
  if(j.bg&&(!safeName(j.bg)||!fs.existsSync(`${ASSETS}/bg/${j.bg}`))) throw new Error('unknown bg asset');
  if(j.bgColor&&!/^#[0-9a-fA-F]{6}$/.test(j.bgColor)) throw new Error('bgColor must be #rrggbb');
  if(!j.audio&&!j.duration) throw new Error('give audio or duration');
  return j;
}
async function runJob(job){
  const p=job.params, dir=`${JOBS}/${job.id}`, fr=`${SHM}/${job.id}`; fs.mkdirSync(dir,{recursive:true}); fs.mkdirSync(fr,{recursive:true});
  const vram=freeVramMiB(); if(vram>=0&&vram<MIN_VRAM_MIB) throw new Error(`insufficient free VRAM: ${vram} MiB (need ${MIN_VRAM_MIB})`);
  const disk=freeDiskMB(); if(disk<MIN_DISK_MB) throw new Error(`insufficient free disk: ${disk} MB (need ${MIN_DISK_MB})`);
  const shm=freeShmMB(); if(shm<MIN_SHM_MB) throw new Error(`insufficient free /dev/shm: ${shm} MB (need ${MIN_SHM_MB})`);
  let mouthAt=()=>0, dur=p.duration, wavPath=null;
  if(p.audio){ wavPath=`${ASSETS}/audio/${p.audio}`; const w=readWav(wavPath); mouthAt=envelope(w); dur=w.dur }
  const total=p.pre+dur+p.post, frames=Math.ceil(total*p.fps); if(frames>MAX_FRAMES) throw new Error(`too many frames (${frames} > ${MAX_FRAMES})`);
  job.frames=frames; job.videoSec=+total.toFixed(2);
  const isL2d=!!p.live2d;
  const q=new URLSearchParams({w:p.width,h:p.height,amb:String(p.amb),vx:p.view.x,vy:p.view.y,zoom:p.view.zoom,idle:p.idle?'1':'0'});
  if(p.vrm) q.set('vrm',`/assets/vrm/${p.vrm}`); else if(!isL2d) q.set('model',`/characters/${p.character}/`);
  if(p.dir!==null) q.set('dir',String(p.dir)); if(p.bg) q.set('bg',`/assets/bg/${p.bg}`); else if(p.bgColor) q.set('bgc',p.bgColor);
  const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=gl-egl','--enable-gpu','--ignore-gpu-blocklist','--no-sandbox','--disable-gpu-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:p.width,height:p.height}}); const cdp=await page.context().newCDPSession(page);
    await page.goto(isL2d?`http://127.0.0.1:${INTERNAL}/render-live2d.html?model=${encodeURIComponent(p.live2d)}&res=${p.width}&core=purism`:`http://127.0.0.1:${INTERNAL}/${p.character?'render-livliv.html':'render.html'}?${q}`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.ready||window.err,null,{timeout:180000});
    const err=await page.evaluate(()=>window.err); if(err) throw new Error('page: '+err);
    job.renderer=await page.evaluate(()=>window.renderer()); const ids=await page.evaluate(()=>window.exprIds());
    for(const k of p.timeline) for(const id of Object.keys(k.e)) if(!ids.includes(id)) throw new Error(`unknown expression "${id}" (have: ${ids.join(', ')})`);
    if(isL2d){
      // Actions are one-shot motions on the Live2D page (window.act is the
      // VRM/LivLiv API); validate them against the page's motion list, and
      // start the requested base loop (the page starts its base loop at load;
      // starting it again at frame 0 is a no-op in effect).
      const mids=await page.evaluate(()=>window.motionIds());
      for(const a of p.actions) if(!mids.includes(a.name)) throw new Error(`unknown live2d motion "${a.name}" (have: ${mids.join(', ')})`);
      if(p.motion){ const ok=await page.evaluate(n=>window.startMotion(n,1),p.motion); if(!ok) throw new Error(`cannot start live2d motion "${p.motion}"`) }
    }
    const t0=Date.now(); let ki=-1, ai=0;
    for(let i=0;i<frames;i++){
      const t=i/p.fps-p.pre;
      let nk=-1; for(let k=0;k<p.timeline.length;k++) if(p.timeline[k].t<=t) nk=k;
      if(nk!==ki){ ki=nk; await page.evaluate(m=>window.setExprs(m),nk<0?{}:p.timeline[nk].e) }
      while(ai<p.actions.length&&p.actions[ai].t<=t){ const n=p.actions[ai++].name; if(isL2d) await page.evaluate(n=>window.startMotion(n,2),n); else await page.evaluate(n=>window.act(n),n) }
      await page.evaluate(([mo,dt])=>window.step(mo,dt),[mouthAt(t)*p.gain,1/p.fps]);
      const r=await cdp.send('Page.captureScreenshot',{format:'jpeg',quality:90});
      fs.writeFileSync(`${fr}/${String(i).padStart(5,'0')}.jpg`,Buffer.from(r.data,'base64')); job.progress=+((i+1)/frames).toFixed(3);
    }
    job.renderSec=+((Date.now()-t0)/1000).toFixed(1);
  } finally { await browser.close().catch(()=>{}) }
  const out=`${dir}/video.mp4`, ff=['-v','error','-y','-framerate',String(p.fps),'-i',`${fr}/%05d.jpg`];
  let vf=null; if(p.credit&&FONT){ const tf=`${dir}/credit.txt`; fs.writeFileSync(tf,p.credit); const base=Math.max(10,Math.round(Math.min(p.width,p.height)/36)); const units=[...p.credit].reduce((n,ch)=>n+(ch.codePointAt(0)>0x2e80?1:0.55),0); const fs_=Math.max(9,Math.min(base,Math.floor((p.width*0.94)/Math.max(units,1)))); // shrink to fit width; keep the right corner (LivLiv mark) free
    vf=`drawtext=fontfile=${FONT}:textfile=${tf}:fontcolor=white@0.92:fontsize=${fs_}:x=${Math.round(fs_*0.8)}:y=h-th-${Math.round(fs_*0.8)}:box=1:boxcolor=black@0.5:boxborderw=${Math.round(fs_*0.4)}` }
  if(wavPath){ const d=Math.round(p.pre*1000); ff.push('-i',wavPath,'-filter_complex',`${vf?`[0:v]${vf}[v];`:''}[1:a]adelay=${d}|${d},apad[a]`,'-map',vf?'[v]':'0:v','-map','[a]','-c:a','aac','-b:a','128k') }
  else if(vf) ff.push('-vf',vf);
  ff.push('-t',total.toFixed(3),'-c:v','libx264','-pix_fmt','yuv420p','-crf','20','-movflags','+faststart',out);
  const r=spawnSync('ffmpeg',ff,{encoding:'utf8'}); if(r.status!==0) throw new Error('ffmpeg: '+String(r.stderr).slice(-300));
  fs.rmSync(fr,{recursive:true,force:true}); job.bytes=fs.statSync(out).size;
}
async function pump(){
  if(running) return; running=true;
  while(queue.length){ const job=queue.shift(); job.state='running'; job.started=Date.now();
    try{ await runJob(job); job.state='done' }catch(e){ job.state='error'; job.error=String(e.message||e); log('job',job.id,'failed:',job.error) }
    job.finished=Date.now(); log('job',job.id,job.state,job.renderSec??'',job.error??'');
    fs.rmSync(`${SHM}/${job.id}`,{recursive:true,force:true});
    const done=[...jobs.values()].filter(j=>j.finished).sort((a,b)=>b.finished-a.finished);
    for(const old of done.slice(KEEP_JOBS)){ jobs.delete(old.id); fs.rmSync(`${JOBS}/${old.id}`,{recursive:true,force:true}) } }
  running=false;
}
// ---- public API ----
const pub=j=>({id:j.id,state:j.state,character:j.params?.character,live2d:j.params?.live2d,credit:j.params?.credit||undefined,progress:j.progress??0,frames:j.frames,videoSec:j.videoSec,renderSec:j.renderSec,renderer:j.renderer,bytes:j.bytes,error:j.error});
http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://x'), parts=u.pathname.split('/').filter(Boolean);
    if(req.method==='GET'&&u.pathname==='/health') return json(res,200,{ok:true});
    if(!okKey(req.headers['x-render-key'])) return json(res,401,{error:'unauthorized'});
    if(req.method==='GET'&&u.pathname==='/info') return json(res,200,{freeVramMiB:freeVramMiB(),freeDiskMB:freeDiskMB(),freeShmMB:freeShmMB(),queued:queue.length,running,assets:Object.fromEntries(['vrm','audio','bg'].map(k=>[k,fs.readdirSync(`${ASSETS}/${k}`)])),live2d:live2dModels()});
    if(req.method==='PUT'&&parts[0]==='assets'&&parts.length===3){
      const [,kind,name]=parts; if(!EXT[kind]||!safeName(name)||!EXT[kind].includes(path.extname(name).toLowerCase())) return json(res,400,{error:'bad kind/name/extension'});
      if(freeDiskMB()<MIN_DISK_MB) return json(res,507,{error:'disk low'});
      const tmp=`${ASSETS}/${kind}/.${name}.${process.pid}.tmp`, out=fs.createWriteStream(tmp); let n=0, bad=false; const MAX=kind==='vrm'?200e6:60e6;
      req.on('data',c=>{ n+=c.length; if(n>MAX&&!bad){ bad=true; req.destroy(); out.destroy(); fs.rmSync(tmp,{force:true}); } }); req.pipe(out);
      out.on('finish',()=>{ if(bad) return; fs.renameSync(tmp,`${ASSETS}/${kind}/${name}`); json(res,200,{ok:true,bytes:n}) }); return;
    }
    if(req.method==='POST'&&u.pathname==='/jobs'){
      let body=''; for await(const c of req){ body+=c; if(body.length>1e6) return json(res,413,{error:'body too large'}) }
      let params; try{ params=validate(JSON.parse(body||'{}')) }catch(e){ return json(res,400,{error:String(e.message||e)}) }
      if(queue.length>=5) return json(res,429,{error:'queue full'});
      const job={id:crypto.randomBytes(6).toString('hex'),state:'queued',params,created:Date.now()}; jobs.set(job.id,job); queue.push(job); pump(); return json(res,202,pub(job));
    }
    if(parts[0]==='jobs'&&parts.length>=2){
      const job=jobs.get(parts[1]); if(!job) return json(res,404,{error:'no such job'});
      if(req.method==='GET'&&parts.length===2) return json(res,200,pub(job));
      if(req.method==='GET'&&parts[2]==='video.mp4'){ const f=`${JOBS}/${job.id}/video.mp4`; if(job.state!=='done'||!fs.existsSync(f)) return json(res,409,{error:'not ready'});
        res.writeHead(200,{'content-type':'video/mp4','content-length':fs.statSync(f).size}); return fs.createReadStream(f).pipe(res) }
    }
    json(res,404,{error:'not found'});
  }catch(e){ log('request error',e); try{json(res,500,{error:'internal'})}catch{} }
}).listen(PORT,'127.0.0.1',()=>log(`arona-render listening on 127.0.0.1:${PORT} (static ${INTERNAL})`));
