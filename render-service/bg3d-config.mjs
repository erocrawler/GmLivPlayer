// The checked reading of a 3D room's configuration (<room>.bg.json), shared by the render service and its tests.
// Strict on purpose: an unknown key, a wrong type or a number out of range is an error, so a typo cannot silently do nothing.
// Keys starting with "_" are comments. The room's data (numbers, camera presets) lives in the file; nothing about any
// particular room is written here.
const BG3D_COLOR=/^#[0-9a-fA-F]{6}$/;
// the view a job may ask for, and the ranges the service accepts for it (a job's own numeric `view` is held to the same)
export const VIEW_RANGES={x:[-2,2],y:[-2,2],zoom:[0.2,5],pitch:[-60,60],yaw:[-180,180],gaze:[0,1],lens:[1,4]};
export const VIEW_DEFAULTS={x:0,y:0,zoom:1,pitch:0,yaw:0,gaze:1,lens:1};
export const VIEW_ALIAS=/^[a-z][a-z0-9_-]{0,23}$/, MAX_VIEWS=32;
export const BG3D_SPEC={ // t: n number, s string, c #rrggbb, b boolean, e enum, views: camera presets; nullable: null allowed
  version:{t:'n',lo:1,hi:1}, source:{t:'s',max:300}, credit:{t:'s',max:160,nullable:true},
  unitsPerMeter:{t:'n',lo:1e-3,hi:1e4},
  camera:{name:{t:'s',max:80,nullable:true}, fovMode:{t:'e',v:['auto','vertical','horizontal']}, keepInside:{t:'b'}, insideMarginM:{t:'n',lo:0,hi:10}},
  lights:{intensityScale:{t:'n',lo:0,hi:1e4,orAuto:true}},
  toneMapping:{type:{t:'e',v:['Neutral','ACES','AgX','Linear','Reinhard','Cineon','None']}, exposure:{t:'n',lo:0.01,hi:20}},
  sky:{background:{t:'c'}, envTop:{t:'c'}, envBottom:{t:'c'}, envTransition:{t:'n',lo:0.001,hi:2}, envHorizon:{t:'n',lo:-1,hi:1}, envIntensity:{t:'n',lo:0,hi:20}},
  shadow:{enabled:{t:'b'}, type:{t:'e',v:['PCFSoft','PCF','Basic','VSM']}, mapSize:{t:'n',lo:256,hi:8192,int:true}, bias:{t:'n',lo:-0.1,hi:0.1}, normalBias:{t:'n',lo:0,hi:5}, radius:{t:'n',lo:0,hi:20},
    sunHalfFactor:{t:'n',lo:0.05,hi:4}, sunFarFactor:{t:'n',lo:0.5,hi:8}, spotNear:{t:'n',lo:0.001,hi:1e4}, spotFar:{t:'n',lo:0.01,hi:1e6}},
  excludeMeshLargerThan:{t:'n',lo:0.001,hi:1e6},
  floorY:{t:'n',lo:-1e6,hi:1e6,nullable:true},
  stand:{distanceM:{t:'n',lo:0,hi:1e4,nullable:true}, frameMargin:{t:'n',lo:0,hi:0.45}, fitTo:{t:'e',v:['canvas','file']}, lateralM:{t:'n',lo:-1e3,hi:1e3}, depthM:{t:'n',lo:-1e3,hi:1e3}, characterHeightM:{t:'n',lo:0.05,hi:30,nullable:true}, characterScale:{t:'n',lo:0.05,hi:20}},
  character:{ambient:{t:'n',lo:0,hi:10}, directional:{t:'n',lo:0,hi:10}, castShadow:{t:'b'}, receiveShadow:{t:'b'}, brightness:{t:'n',lo:0,hi:4}, skyFill:{t:'n',lo:0,hi:10}},
  supersample:{t:'n',lo:1,hi:3},
  // named camera presets of THIS room: { "<alias>": {x,y,zoom,pitch,yaw,gaze} } (every field optional, defaults VIEW_DEFAULTS)
  views:{t:'views'},
};
const num=(v,[lo,hi],path)=>{ if(typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi) throw new Error(`bg3d config: "${path}" must be a number in [${lo}, ${hi}]`); return v };
function checkViews(raw,at){
  if(raw===null||typeof raw!=='object'||Array.isArray(raw)) throw new Error(`bg3d config: "${at}" must be an object of camera presets`);
  const out={}; let n=0;
  for(const [alias,v] of Object.entries(raw)){
    if(alias.startsWith('_')) continue;
    if(!VIEW_ALIAS.test(alias)) throw new Error(`bg3d config: view name "${alias}" must be lowercase letters, digits, - or _ (start with a letter, <=24 chars)`);
    if(++n>MAX_VIEWS) throw new Error(`bg3d config: at most ${MAX_VIEWS} views`);
    const path=`${at}.${alias}`;
    if(v===null||typeof v!=='object'||Array.isArray(v)) throw new Error(`bg3d config: "${path}" must be an object {${Object.keys(VIEW_RANGES).join(', ')}}`);
    const o={};
    for(const [k,x] of Object.entries(v)){
      if(k.startsWith('_')) continue;
      if(!VIEW_RANGES[k]) throw new Error(`bg3d config: unknown key "${path}.${k}" (a view has ${Object.keys(VIEW_RANGES).join(', ')})`);
      o[k]=num(x,VIEW_RANGES[k],`${path}.${k}`);
    }
    out[alias]={...VIEW_DEFAULTS,...o};
  }
  return out;
}
export function checkBg3dConfig(raw,spec=BG3D_SPEC,at=''){
  if(raw===null||typeof raw!=='object'||Array.isArray(raw)) throw new Error(`bg3d config ${at||'(root)'} must be a JSON object`);
  const out={};
  for(const [k,v] of Object.entries(raw)){
    if(k.startsWith('_')) continue; // comments
    const path=at+k, sp=spec[k]; if(!sp) throw new Error(`bg3d config: unknown key "${path}"`);
    if(sp.t===undefined){ out[k]=checkBg3dConfig(v,sp,path+'.'); continue }
    if(sp.t==='views'){ out[k]=checkViews(v,path); continue }
    if(v===null){ if(sp.nullable){ out[k]=null; continue } throw new Error(`bg3d config: "${path}" must not be null`) }
    if(sp.t==='n'){ if(sp.orAuto&&v==='auto'){ out[k]='auto'; continue }
      if(typeof v!=='number'||!Number.isFinite(v)||v<sp.lo||v>sp.hi||(sp.int&&!Number.isInteger(v))) throw new Error(`bg3d config: "${path}" must be ${sp.int?'an integer':'a number'} in [${sp.lo}, ${sp.hi}]${sp.orAuto?' or "auto"':''}`) }
    else if(sp.t==='s'){ if(typeof v!=='string'||v.length>sp.max||/[\u0000-\u001f]/.test(v)) throw new Error(`bg3d config: "${path}" must be a string (<=${sp.max} chars, no control chars)`) }
    else if(sp.t==='c'){ if(typeof v!=='string'||!BG3D_COLOR.test(v)) throw new Error(`bg3d config: "${path}" must be #rrggbb`) }
    else if(sp.t==='b'){ if(typeof v!=='boolean') throw new Error(`bg3d config: "${path}" must be true or false`) }
    else if(sp.t==='e'){ if(!sp.v.includes(v)) throw new Error(`bg3d config: "${path}" must be one of ${sp.v.join(', ')}`) }
    out[k]=v;
  }
  return out;
}
// a job's `view` / `viewTimeline[].view` given as a string: the room's own preset of that name, or an error that lists
// the names the room has. `views` is the checked `views` of the room's configuration (undefined: it defines none).
export function roomView(alias,views,room){
  const v=views&&Object.hasOwn(views,alias)?views[alias]:undefined;
  if(!v){ const have=Object.keys(views||{});
    throw new Error(`unknown view "${alias}" for bg3d room ${room}${have.length?` (have: ${have.join(', ')})`:' (this room defines no named views: pass a numeric view object)'}`) }
  return v;
}
