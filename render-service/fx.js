// Optional post-processing for arona-render (job `filter`). Loaded by render.html ONLY when the page URL has ?fx=...
// Without ?fx this file is never fetched, so default jobs are unchanged.
// v2 (2026-11-13): own pass chain (one MSAA scene target + three plain half-float targets), character mask,
// soft-knee bloom that is damped on the character, highlight shoulder, procedural night sky + light spots.
// Only three.js + examples/jsm (UnrealBloomPass, OutputPass, FullScreenQuad); no extra dependency, no asset.
import * as THREE from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

// strengths are multiplied by the job's numbers (1 = preset, 0 = off). Pixel sizes are for a 1280 px high picture.
const PRESETS = {
  'blue-night': {
    room: {   // bg3d: HDR linear picture, tone mapped at the end by the room's own tone mapping
      grade: { expo: 0.36, mult: [0.42, 0.88, 1.5], sat: 1.35, contrast: 1.2, bgKnee: 0.22, bgMax: 0.5, tintS: [0.97, 1.0, 1.05], lift: [0.002, 0.01, 0.04], vig: 0.4, sky: 1 },
      bloom: { thr: 0.8, knee: 0.5, amount: 0.35, radius: 0.6, srcSubj: 0.5, subjBloom: 0.2, rim: 0.1, rimPx: 7, cap: 0.94 },
      dof: { k: 46, max: 34, min: 2.5, rangeFrac: 0.12 },
      outline: { px: 2.6, minPx: 1.2, color: [0.01, 0.04, 0.18], inner: 0.03 },
      sparkle: { spots: 1, stars: 1 },
      shoulder: { on: 0, knee: 0.6, max: 0.94 },
    },
    flat: {   // bg / bgColor: alpha canvas over a CSS background, LDR
      grade: { tintS: [0.97, 1.0, 1.04] },
      bloom: { thr: 0.72, knee: 0.25, amount: 0.3, radius: 0.6, srcSubj: 0.5, subjBloom: 0.2, rim: 0.08, rimPx: 7, cap: 0.94 },
      outline: { px: 2.6, minPx: 1.2, color: [0.01, 0.04, 0.18] },
      sparkle: { spots: 1 },
      shoulder: { on: 1, knee: 0.62, max: 0.95 },
      css: { blurPx: 10, sat: 1.5, bright: 0.5, hue: -4, wash: 'rgba(22,74,215,0.6)', vig: 0.65 },
    },
  },
}

const VERT = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`
const COMMON = `#include <packing>
  varying vec2 vUv; uniform sampler2D tDiffuse, tDepth; uniform vec2 res; uniform float near, far, room, time;
  float lum(vec3 c){ return dot(c,vec3(.2126,.7152,.0722)); }
  float linz(float v){ v=abs(v); return v==0. ? far : -perspectiveDepthToViewZ(1.0-v, near, far); }   // the depth target holds 1-fragCoordZ; 0 = nothing drawn (sky); negative = the character is the nearest surface
  float dep(vec2 uv){ return linz(texture2D(tDepth,uv).x); }
  float subj(vec2 uv){ return texture2D(tDepth,uv).x<0. ? 1. : 0.; }
  float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
  float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x), mix(h21(i+vec2(0.,1.)),h21(i+vec2(1.,1.)),f.x), f.y); }
  float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+17.1; a*=.5; } return s; }
  vec3 shoulderF(vec3 x, float k, float m){   // identity below k, eases to m above; mostly on the brightest channel so that hot skin keeps its hue instead of clipping to white
    vec3 pc=min(x,vec3(k))+(m-k)*(1.-exp(-max(x-k,0.)/(m-k)));
    float mx=max(x.r,max(x.g,x.b)), sm=min(mx,k)+(m-k)*(1.-exp(-max(mx-k,0.)/(m-k)));
    return mix(pc, x*(sm/max(mx,1e-4)), 0.7); }
`

// 1) grade. Room: the background gets the night grade, the sky (no geometry) becomes a procedural night sky, the character
//    is left alone (small cool tint off the skin). alpha := soft character mask. Flat: highlight shoulder + tint on the character.
const PRE = COMMON + `
  uniform float grade, expo, sat, contrast, bgKnee, bgMax, skyAmt, stars, shOn, shKnee, shMax; uniform vec3 mult, tintS; uniform mat4 projInv, camWorld;
  vec3 nightSky(vec3 d){
    vec2 p=vec2(atan(d.x,d.z), asin(clamp(d.y,-1.,1.)))*9.;
    float n=fbm(p), n2=fbm(p*2.1+7.3);
    vec3 col=mix(vec3(0.003,0.01,0.045), vec3(0.008,0.03,0.11), smoothstep(-0.3,0.8,d.y));
    col+=vec3(0.02,0.3,0.65)*pow(smoothstep(0.36,0.78,n),1.5)*1.3;
    col+=vec3(0.22,0.05,0.42)*pow(smoothstep(0.45,0.85,n2),2.)*0.45;
    vec2 g=p*11., id=floor(g), f=fract(g)-.5; float r=h21(id);
    if(r>0.86){ vec2 o=(vec2(h21(id+3.1),h21(id+7.7))-.5)*.5; float rad=mix(.08,.24,fract(r*57.)); col+=mix(vec3(0.35,0.7,1.),vec3(0.8,0.9,1.),fract(r*23.))*smoothstep(rad,rad*0.55,length(f-o))*mix(1.3,0.3,fract(r*57.))*stars; }
    return col;
  }
  vec3 tint(vec3 c){ float mx=max(c.r,max(c.g,c.b)); float warm=smoothstep(0.03,0.15,(c.r-c.b)/max(mx,1e-3)); return c*mix(tintS,vec3(1.),warm); }   // skin / pink hair keep their colour
  void main(){
    vec4 c=texture2D(tDiffuse,vUv); vec3 rgb=c.rgb; float a=c.a;
    if(room>0.5){
      vec2 px=1./res;
      float m=subj(vUv)*0.4+0.15*(subj(vUv+vec2(px.x,0.))+subj(vUv-vec2(px.x,0.))+subj(vUv+vec2(0.,px.y))+subj(vUv-vec2(0.,px.y)));
      float l=lum(rgb); vec3 g=mix(vec3(l),rgb,sat); g=0.18*pow(max(g,vec3(0.))/0.18,vec3(contrast)); g*=mult*expo; g=shoulderF(g,bgKnee,bgMax);   // sun-lit walls and floor may not stay white at night
      if(texture2D(tDepth,vUv).x==0. && skyAmt>0.){ vec4 v=projInv*vec4(vUv*2.-1.,1.,1.); vec3 d=normalize((camWorld*vec4(normalize(v.xyz/v.w),0.)).xyz); g=mix(g,nightSky(d),skyAmt); }
      vec3 s=tint(rgb); if(shOn>0.5) s=shoulderF(s,shKnee,shMax);
      gl_FragColor=vec4(mix(rgb,mix(g,s,m),grade), m);
    } else {
      vec3 u=a>1e-4 ? rgb/a : vec3(0.);
      if(shOn>0.5) u=shoulderF(u,shKnee,shMax); else u=min(u,vec3(1.));
      u=mix(u,tint(u),grade);
      gl_FragColor=vec4(u*a, a);
    }
  }`

// 2) depth of field (room). Scatter-as-gather on a golden-angle disc; the character (alpha) is never blurred and never
//    leaks into the background; blurry things in FRONT of a sharper pixel do spread over it (no hard edge on near desks).
const DOFC = `uniform float focus, range, k, maxc, minc;
  float coc(float d){ return min(max(abs(d-focus)-range,0.)/max(d,1e-3)*k+minc, maxc); }`
const DOF = COMMON + DOFC + `
  void main(){
    vec4 base=texture2D(tDiffuse,vUv); float d0=dep(vUv), c0=coc(d0)*(1.-base.a);
    float rot=6.2831853*fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));
    float R=c0;
    for(int i=0;i<12;i++){ float fi=float(i), rr=maxc*(mod(fi,2.)<0.5?0.4:0.85), a=fi*0.5236+rot; vec2 uv=vUv+vec2(cos(a),sin(a))*rr/res;
      float d=dep(uv), cs=coc(d)*(1.-texture2D(tDiffuse,uv).a); if(d<d0*0.97 && cs>=rr*0.8) R=max(R,cs); }
    if(R<0.5){ gl_FragColor=base; return; }
    vec3 acc=base.rgb; float ws=1.;
    for(int i=0;i<44;i++){
      float fi=float(i)+0.5, r=sqrt(fi/44.)*R, a=fi*2.39996323+rot;
      vec2 uv=vUv+vec2(cos(a),sin(a))*r/res; vec4 t=texture2D(tDiffuse,uv);
      float d=dep(uv), cs=coc(d)*(1.-t.a);
      float lim=d<d0*0.97 ? cs : min(cs,c0);     // a tap behind the centre only counts inside the centre's own blur disc
      float w=smoothstep(r-1.,r+1.,lim);
      acc+=min(t.rgb,vec3(8.))*w; ws+=w;
    }
    gl_FragColor=vec4(acc/ws, base.a);
  }`
// 2b) small blur over the blurred areas: turns the per-pixel tap noise / stripes of (2) into a smooth result
const DOF2 = COMMON + DOFC + `
  void main(){
    vec4 base=texture2D(tDiffuse,vUv); float c0=coc(dep(vUv))*(1.-base.a), s=min(c0*0.3,3.5);
    if(s<0.3){ gl_FragColor=base; return; }
    vec3 acc=base.rgb; float ws=1.;
    for(int i=0;i<12;i++){ float fi=float(i), rr=s*(mod(fi,2.)<0.5?1.:0.5), a=fi*0.5236; vec4 t=texture2D(tDiffuse,vUv+vec2(cos(a),sin(a))*rr/res); float w=1.-t.a; acc+=t.rgb*w; ws+=w; }
    gl_FragColor=vec4(acc/ws, base.a);
  }`

// 3) bloom source: soft knee on the brightest channel, damped on the character
const PREFC = `uniform float thr, knee, srcSubj;
  vec3 pref(vec4 c){ float v=max(c.r,max(c.g,c.b)); float w=clamp((v-thr)/knee,0.,1.); return min(c.rgb,vec3(4.))*w*w*mix(1.,srcSubj,c.a); }`
const PREF = COMMON + PREFC + `void main(){ gl_FragColor=vec4(pref(texture2D(tDiffuse,vUv)),1.); }`

// 4) finish: add the bloom (little of it on the character, capped), rim, light spots, shadow lift, vignette, outline; flat: sRGB out
const FIN = COMMON + `
  uniform sampler2D tBloom; uniform float bloomAmt, subjBloom, cap, rim, rimPx, spotsAmt, vig, grade, olPx, olAmt, olInner, charH, dbg; uniform vec3 lift, olCol;
  vec3 spots(vec2 uv){ vec3 acc=vec3(0.); float asp=res.x/res.y;
    for(int L=0;L<2;L++){ float fl=float(L), sc=fl<0.5?4.5:8.;
      vec2 p=vec2(uv.x*asp,uv.y)*sc+vec2(fl*13.7, time*(fl<0.5?0.03:0.05)+fl*5.3), id=floor(p), f=fract(p)-.5; float r=h21(id+fl*31.);
      if(r>0.7){ vec2 o=(vec2(h21(id+1.3),h21(id+5.9))-.5)*.4; float rad=mix(.06,.26,pow(fract(r*91.),2.)), d=length(f-o);
        float disc=smoothstep(rad,rad*0.7,d)*(0.75+0.25*smoothstep(rad*0.4,rad*0.9,d)), tw=0.6+0.4*sin(time*1.7+r*40.);
        acc+=mix(vec3(0.1,0.45,1.),vec3(0.2,0.9,1.),fract(r*17.))*disc*tw*(fl<0.5?0.07:0.11); } }
    return acc; }
  vec3 enc(vec3 c){ c=clamp(c,0.,1.); return mix(c*12.92, 1.055*pow(c,vec3(1./2.4))-0.055, step(0.0031308,c)); }
  void main(){
    vec4 c=texture2D(tDiffuse,vUv); float m=c.a; vec3 rgb=c.rgb;
    vec3 b=texture2D(tBloom,vUv).rgb*bloomAmt;
    float ring=0., ring2=0., e=0.;
    for(int i=0;i<8;i++){ float t=float(i)*0.785398; vec2 dir=vec2(cos(t),sin(t));
      ring=max(ring,texture2D(tDiffuse,vUv+dir*olPx/res).a); ring2=max(ring2,texture2D(tDiffuse,vUv+vec2(cos(t+0.3927),sin(t+0.3927))*olPx*0.55/res).a);
      e+=texture2D(tDiffuse,vUv+dir*rimPx/res).a; }
    rgb+=vec3(0.25,0.6,1.)*rim*m*clamp(1.-e/8.,0.,1.)*2.;                          // cool rim light just inside the silhouette
    vec3 lit=rgb+b, onS=min(rgb+b*subjBloom, max(rgb,vec3(cap)*(room>0.5?1.:m)));  // on the character bloom may not push anything past the cap
    rgb=mix(lit,onS,m);
    rgb+=spots(vUv)*spotsAmt*(1.-m);
    if(room>0.5){ float l=lum(rgb); rgb+=lift*(1.-smoothstep(0.,0.35,l))*(1.-m)*grade; rgb*=1.-vig*grade*smoothstep(.35,.95,length(vUv-.5)*1.4142)*(1.-0.6*m); }
    float outer=smoothstep(0.08,0.6,max(ring,ring2*0.9))*(1.-smoothstep(0.25,0.9,m))*min(olAmt,1.)*0.92, a=m;
    if(room>0.5){
      rgb=mix(rgb,olCol,outer);
      float cv=texture2D(tDepth,vUv).x;
      if(cv<0. && olInner>0. && m>0.5){ float d=linz(cv), ee=0.; vec2 px=1./res;
        for(int i=0;i<4;i++){ vec2 o=i==0?vec2(px.x,0.):i==1?vec2(-px.x,0.):i==2?vec2(0.,px.y):vec2(0.,-px.y); float v=texture2D(tDepth,vUv+o).x; if(v<0.) ee=max(ee,abs(linz(v)-d)); }
        rgb=mix(rgb,olCol,smoothstep(olInner*charH,olInner*charH*2.5,ee)*0.55*min(olAmt,1.)); }
      a=1.;
    } else { rgb=rgb*(1.-outer)+olCol*outer; a=max(a,outer); }
    if(dbg>0.5){ gl_FragColor=dbg>1.5 ? vec4(texture2D(tDepth,vUv).x==0.?1.:0., fract(dep(vUv)*0.05), texture2D(tDepth,vUv).x<0.?1.:0., 1.) : vec4(vec3(m),1.); return; }
    if(room>0.5){ gl_FragColor=vec4(rgb,1.); return; }
    vec3 base=min(rgb,vec3(a)), glow=rgb-base;          // premultiplied picture + additive light: encode each part on its own
    gl_FragColor=vec4((a>1e-4?enc(base/a)*a:vec3(0.))+enc(glow)*(1.-a), a);
  }`

const U = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]))
const mkMat = (frag, uni) => new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, res: { value: new THREE.Vector2() }, near: { value: 0.1 }, far: { value: 1000 }, room: { value: 0 }, time: { value: 0 }, ...U(uni) },
  vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false })

export function installFx(body, W, H, cfgIn, hasRoom) {
  const cfg = typeof cfgIn === 'string' ? { preset: cfgIn } : cfgIn
  const PP = PRESETS[cfg.preset || 'blue-night']; if (!PP) throw new Error('unknown filter preset')
  const P = JSON.parse(JSON.stringify(hasRoom ? PP.room : PP.flat))
  if (cfg._P) for (const [g, o] of Object.entries(cfg._P)) Object.assign(P[g] ??= {}, o)   // dev-only tuning override (the service does not let it through)
  const mult = k => (cfg[k] === undefined ? 1 : +cfg[k])
  const kBloom = mult('bloom'), kDof = mult('dof'), kGrade = mult('grade'), kOutline = mult('outline'), kBlur = mult('bgBlur'), kSparkle = mult('sparkle')
  const info = { v: 2, preset: cfg.preset || 'blue-night', hasRoom, kBloom, kDof, kGrade, kOutline, kBlur, kSparkle }

  if (!hasRoom) {                                     // flat background: "depth of field" = blur the CSS background layer, grade it with CSS
    const st = document.body.style, img = st.backgroundImage, bgc = st.backgroundColor || '#20222b', c = P.css, hs = H / 1280
    const mk = css => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;pointer-events:none;' + css; document.body.prepend(d); return d }
    if (kBlur > 0 || kGrade > 0) {
      st.background = kGrade > 0 ? '#030a1c' : bgc
      mk(`inset:-8%;z-index:-3;background:${img && img !== 'none' ? img + ' center/cover no-repeat' : bgc};filter:blur(${(c.blurPx * kBlur * hs).toFixed(1)}px) saturate(${1 + (c.sat - 1) * kGrade}) brightness(${1 + (c.bright - 1) * Math.min(kGrade, 1.5)}) hue-rotate(${c.hue * kGrade}deg)`)
      if (kGrade > 0) { mk(`inset:0;z-index:-2;background:${c.wash};mix-blend-mode:multiply;opacity:${Math.min(1, kGrade)}`)
        mk(`inset:0;z-index:-1;background:radial-gradient(ellipse at 50% 45%,rgba(0,0,0,0) 45%,rgba(0,8,40,${Math.min(1, c.vig * kGrade)}) 100%)`) }
    }
  }

  let renderer = null, orig = null, R = null, inFx = false
  const quad = new FullScreenQuad()
  const depthMat = new THREE.MeshDepthMaterial(); depthMat.depthPacking = THREE.BasicDepthPacking; depthMat.blending = THREE.NoBlending
  // second pass over the same target, character only: where it is the nearest surface it passes the depth test and flips the sign
  const maskMat = new THREE.MeshDepthMaterial(); maskMat.depthPacking = THREE.BasicDepthPacking; maskMat.blending = THREE.NoBlending
  maskMat.polygonOffset = true; maskMat.polygonOffsetFactor = -1; maskMat.polygonOffsetUnits = -2; maskMat.customProgramCacheKey = () => 'fx-mask'
  maskMat.onBeforeCompile = sh => { const f = sh.fragmentShader.replace('1.0 - fragCoordZ', 'fragCoordZ - 1.0'); if (f === sh.fragmentShader) console.log('fx: ERROR depth shader text changed, character mask is off'); sh.fragmentShader = f }
  const build = () => {
    const sz = renderer.getDrawingBufferSize(new THREE.Vector2()), w = sz.x, h = sz.y, hs = h / 1280
    const hf = (o = {}) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, ...o })
    const fl = () => new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
    R = { w, h, scene: hf({ depthBuffer: true, samples: cfg._samples === undefined ? 2 : cfg._samples }), a: hf(), c: new THREE.WebGLRenderTarget(w >> 1, h >> 1, { type: THREE.HalfFloatType, depthBuffer: false }), depth: hasRoom ? fl() : null, hidden: null }
    const g = P.grade, bl = P.bloom, ol = P.outline, sh = P.shoulder
    const common = m => { m.uniforms.res.value.set(w, h); m.uniforms.room.value = hasRoom ? 1 : 0; if (hasRoom) m.uniforms.tDepth.value = R.depth.texture; return m }
    R.pre = common(mkMat(PRE, { grade: Math.min(kGrade, 1), expo: Math.pow(g.expo ?? 1, Math.max(kGrade, 1)), sat: g.sat ?? 1, contrast: g.contrast ?? 1, bgKnee: g.bgKnee ?? 50, bgMax: g.bgMax ?? 100, skyAmt: (g.sky ?? 0) * Math.min(kGrade, 1), stars: (P.sparkle.stars ?? 0) * kSparkle,
      shOn: sh.on, shKnee: sh.knee, shMax: sh.max, mult: new THREE.Vector3(...(g.mult || [1, 1, 1])), tintS: new THREE.Vector3(...g.tintS), projInv: new THREE.Matrix4(), camWorld: new THREE.Matrix4() }))
    if (hasRoom && kDof > 0) { const d = P.dof, du = { focus: 1, range: 0, k: d.k * kDof * hs, maxc: d.max * hs * Math.min(1.5, 0.5 + 0.5 * kDof), minc: d.min * hs * Math.min(kDof, 1) }
      R.dof = common(mkMat(DOF, du)); R.dof2 = common(mkMat(DOF2, du)) }
    const pu = { thr: bl.thr, knee: bl.knee, srcSubj: bl.srcSubj }
    if (kBloom > 0) { R.pref = common(mkMat(PREF, pu)); R.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 1, bl.radius, 0) }
    R.fin = common(mkMat(FIN, { tBloom: null, bloomAmt: bl.amount * kBloom, subjBloom: bl.subjBloom, cap: bl.cap, rim: bl.rim * Math.min(kBloom, 1.5), rimPx: bl.rimPx * hs, spotsAmt: (P.sparkle.spots ?? 0) * kSparkle,
      vig: g.vig ?? 0, grade: Math.min(kGrade, 1), olPx: Math.max(ol.minPx, ol.px * hs) * Math.max(1, kOutline), olAmt: kOutline, olInner: ol.inner ?? 0, charH: 1, dbg: +cfg._dbg || 0, lift: new THREE.Vector3(...(g.lift || [0, 0, 0])), olCol: new THREE.Vector3(...ol.color) }))
    if (hasRoom) { R.out = new OutputPass(); R.out.renderToScreen = true }
    info.size = [w, h]; info.tm = renderer.toneMapping
  }
  const run = (mat, src, dst) => { mat.uniforms.tDiffuse.value = src.texture; quad.material = mat; renderer.setRenderTarget(dst); quad.render(renderer) }
  const focusPos = new THREE.Vector3(), camPos = new THREE.Vector3(), tmp = new THREE.Vector3(), dir = new THREE.Vector3(), cc = new THREE.Color()
  const depthPasses = (scene, camera, vrm) => {
    const sh = renderer.shadowMap.autoUpdate, ca = renderer.getClearAlpha(), bg = scene.background, ac = renderer.autoClear; renderer.getClearColor(cc)
    renderer.shadowMap.autoUpdate = false; scene.background = null; scene.overrideMaterial = depthMat; renderer.setClearColor(0x000000, 0)
    if (!R.hidden) { R.hidden = []; const inVrm = o => { for (let n = o; n; n = n.parent) if (n === vrm.scene) return true; return false }   // see-through room parts (window glass) must not hide the sky
      scene.traverse(o => { if (o.isMesh && !inVrm(o)) { const ms = Array.isArray(o.material) ? o.material : [o.material]; if (ms.some(m => m && m.transparent)) R.hidden.push(o) } }); info.glass = R.hidden.length }
    const off = []; const hide = o => { if (o.visible) { o.visible = false; off.push(o) } }
    try {
      R.hidden.forEach(hide); renderer.setRenderTarget(R.depth); orig(scene, camera)
      let ok = false
      for (let n = vrm.scene; n && n.parent; n = n.parent) { for (const s of n.parent.children) if (s !== n) hide(s); if (n.parent === scene) { ok = true; break } }   // only the character stays visible
      if (ok) { scene.overrideMaterial = maskMat; renderer.autoClear = false; try { orig(scene, camera) } finally { renderer.autoClear = ac } }
    } finally { off.forEach(o => { o.visible = true }); scene.overrideMaterial = null; scene.background = bg; renderer.setClearColor(cc, ca); renderer.shadowMap.autoUpdate = sh }
  }
  const hooked = (scene, camera) => {
    if (inFx || renderer.getRenderTarget() !== null) return orig(scene, camera)
    if (!R) build()
    inFx = true
    try {
      renderer.setRenderTarget(R.scene); orig(scene, camera)          // the body may swap scene/camera objects (e.g. on load): never cache them
      const vrm = body.getVRM?.(); let f = 1, charH = 1
      if (hasRoom && vrm) {
        depthPasses(scene, camera, vrm)
        const n = vrm.humanoid?.getRawBoneNode?.('chest') || vrm.scene; n.getWorldPosition(focusPos); camera.getWorldPosition(camPos); camera.getWorldDirection(dir)
        f = focusPos.sub(camPos).dot(dir)                              // distance along the view axis (what the depth buffer holds)
        const hd = vrm.humanoid?.getRawBoneNode?.('head'); if (hd) charH = Math.max(0.3, hd.getWorldPosition(tmp).y - vrm.scene.getWorldPosition(focusPos).y)
        info.focus = f; info.charH = charH
      }
      const t = (info.frames || 0) / 24
      for (const k of ['pre', 'dof', 'dof2', 'fin']) if (R[k]) { const u = R[k].uniforms; u.near.value = camera.near; u.far.value = camera.far; u.time.value = t; if (u.focus) { u.focus.value = f; u.range.value = charH * P.dof.rangeFrac } }
      R.pre.uniforms.projInv.value.copy(camera.projectionMatrixInverse); R.pre.uniforms.camWorld.value.copy(camera.matrixWorld); R.fin.uniforms.charH.value = charH
      run(R.pre, R.scene, R.a); let cur = R.a
      if (R.dof) { run(R.dof, R.a, R.scene); run(R.dof2, R.scene, R.a) }   // the scene target is free once the grade pass has read it: it is the second buffer
      if (R.bloom) { run(R.pref, cur, R.c); R.bloom.render(renderer, null, R.c); R.fin.uniforms.tBloom.value = R.bloom.renderTargetsHorizontal[0].texture;   // the pass's own composite = bloom only (its add onto R.c is not used)
        R.fin.uniforms.bloomAmt.value = P.bloom.amount * kBloom } else { R.fin.uniforms.tBloom.value = cur.texture; R.fin.uniforms.bloomAmt.value = 0 }
      if (hasRoom) { run(R.fin, cur, R.scene); R.out.render(renderer, null, R.scene) } else run(R.fin, cur, null)
    } finally { renderer.setRenderTarget(null); inFx = false }
    info.frames = (info.frames || 0) + 1
    if (info.frames === 1) console.log('fx: first composed frame', JSON.stringify(info))
  }
  let cur = null   // VrmBody creates its WebGLRenderer lazily inside its first render(): hook it through a property accessor
  Object.defineProperty(body, 'renderer', { configurable: true, enumerable: true, get: () => cur,
    set: r => { cur = r; if (r) { renderer = r; R = null; orig = r.render.bind(r); r.render = hooked } } })
  return info
}
