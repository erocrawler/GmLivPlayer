// A 3D room behind a VRM (render-service `bg3d`): a glTF/GLB scene drawn in the same three.js scene as the character.
// The room is never changed on disk or in its geometry, materials, textures or node transforms; everything here happens
// in memory on the loaded copy (light intensities, shadow switches, the sky and the environment light), and the
// character is the one that is scaled and placed.
//
// Camera: the one in the file (first camera, or `camera.name`) is the origin of every view parameter. With the view
// at its defaults the picture is that camera's own: same position, same orientation, same vertical field of view (the
// horizontal one on a canvas narrower than the file's, see `fovMode`). The view then moves relative to it:
//   yaw / pitch  orbit the camera around the character's stand point (yaw positive: toward the camera's right, i.e. the
//                character's left, as the plain VRM orbit; pitch positive: down, looking up at the character)
//   zoom         a dolly along the line to the character: 1 is the file camera's own distance, 2 half of it
//   x / y        a lens shift: the whole picture slides by that share of the visible frame (y up), the camera stays
//   lens         a longer lens, not a move: 2 narrows the field of view to half (tangent), the camera stays. Dolly (zoom) is capped
//                where a video's view is checked, so a close-up that needs more than that takes both
// Only the character moves in the world (its idle sway and a "hop"); the view never does.
import type * as T from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { LivLivError } from './errors'

const D = Math.PI / 180

export type FovMode = 'auto' | 'vertical' | 'horizontal'

/** what a `<room>.bg.json` may say; every field is optional (see ROOM_DEFAULTS) */
export interface RoomConfig {
  /** where the file says it comes from: for people only */
  source?: string
  /** units of the file per metre: the character is scaled by it (the room never is) */
  unitsPerMeter: number
  camera: {
    /** the camera's node name; null: the first camera in the file */
    name: string | null
    /** vertical: the file's yfov always. horizontal: the file's horizontal fov always. auto: vertical on a canvas as wide as
     *  the file's aspect or wider, horizontal on a narrower one (a portrait video would otherwise see a thin slit) */
    fovMode: FovMode
    /** keep the orbiting camera between the room's floor and ceiling: pitch (and a dolly out) that would put it under the floor or
     *  above the ceiling is cut short there, still aimed at the character. The room is a box seen from one open side; from
     *  under the floor or over the ceiling it is a grey slab. false: the orbit is rigid whatever it passes through */
    keepInside: boolean
    /** how far from the floor and the ceiling it stays (m) */
    insideMarginM: number
  }
  lights: {
    /** multiplies every light's intensity. 'auto': 1/683 when the file says Blender and a light is brighter than 100
     *  (the glTF exporter multiplied watts by 683 for lux/candela; three.js takes that as is and everything burns out) */
    intensityScale: number | 'auto'
  }
  toneMapping: { type: 'Neutral' | 'ACES' | 'AgX' | 'Linear' | 'Reinhard' | 'Cineon' | 'None'; exposure: number }
  sky: {
    /** the picture's background (what shows where the room has no wall) */
    background: string
    /** the environment light is a vertical gradient: bottom below the horizon, top above it, over `envTransition` (in
     *  sin of the elevation either side of `envHorizon`) */
    envTop: string
    envBottom: string
    envTransition: number
    envHorizon: number
    envIntensity: number
  }
  shadow: {
    enabled: boolean
    /** PCFSoft is the same as PCF here: three.js r18x dropped its own soft map and says so when asked for it */
    type: 'PCFSoft' | 'PCF' | 'Basic' | 'VSM'
    mapSize: number
    bias: number
    normalBias: number
    radius: number
    /** the sun is put one diagonal of the room's bounds from its centre, aimed at it; its shadow box is this many
     *  diagonals wide / the factor below deep */
    sunHalfFactor: number
    sunFarFactor: number
    /** the spot lights' shadow camera range, in the file's units */
    spotNear: number
    spotFar: number
  }
  /** meshes with a side longer than this (file units) are left out of the room's bounds and the floor search: a ground slab */
  excludeMeshLargerThan: number
  /** the floor's height (file units); null: found by a ray down from the camera's height at the stand point */
  floorY: number | null
  stand: {
    /** metres from the camera along its horizontal heading. null: the nearest spot at which the whole character is in the
     *  file camera's picture (feet included) with `frameMargin` of the frame's height to spare below the feet */
    distanceM: number | null
    frameMargin: number
    /** which picture the default spot is fitted to: 'canvas': the shape of the canvas at the first frame (a portrait
     *  canvas, whose field of view is taller, gets the character nearer, so it is as big in the frame as in a wide one);
     *  'file': the file camera's own aspect, whatever the canvas */
    fitTo: 'canvas' | 'file'
    /** metres to the camera's right */
    lateralM: number
    /** metres farther from the camera along its heading, on top of the spot above (the fitted one or `distanceM`): the
     *  character stands that much deeper in the room, nearer the desks at the back. The size on screen follows by
     *  perspective; negative: nearer the camera. It stops at the last spot with the same floor under it and nothing
     *  (wall, desk) within reach of its body */
    depthM: number
    /** how tall the character stands in the room (m, feet to the top of the head), whatever size its own file is in: VRM
     *  files come in any unit (a 0.19 tall Arona is common). null: the file's own units are metres */
    characterHeightM: number | null
    /** on top of that: 1.1 is 10% bigger */
    characterScale: number
  }
  /** the character's own two lights (the room's are the ones that matter): intensities, 0 for none; and how bright its
   *  materials take the room's light:
   *  `brightness` multiplies a toon (MToon) material's lit, shade, matcap and rim colours. MToon does not weigh a light by the
   *  cosine of its angle the way the room's PBR materials do (its toon step replaces it): a surface that faces away from the sun at
   *  60° gets the full 1/π x intensity, a PBR one gets half. Under the room's sun (10 W/m² after the exporter's 683 is taken out)
   *  a white skirt therefore comes out ~2x brighter in linear light than a white thing in the room, and ~2.7x on the floor
   *  (sun elevation ~22°). `brightness` takes that back (1: as the model's file says; the default 0.3 puts a white skirt at the
   *  luma of the room's own white lockers, ~205/255 after tone mapping, for the Arona room's sun: set it per room).
   *  `skyFill`: how much of the room's sky light (`sky.envTop` above, `sky.envBottom` below, x `sky.envIntensity`) the character's
   *  toon materials get, as 1 = what a PBR material in the room gets from the environment. MToon ignores the scene's
   *  environment map (three.js only gives it to its own standard materials), so without this the character has the warm sun
   *  and nothing else, and goes cream; the room's whites get the blue sky on top of the sun and stay white. 1 is the room's whole
   *  sky (a white skirt turns blue-white, which is the default); about 0.35 leaves it neutral, 0 is none */
  character: { ambient: number; directional: number; castShadow: boolean; receiveShadow: boolean; brightness: number; skyFill: number }
  /** the drawing buffer is this many times the canvas (the browser scales it down). 1: as the canvas */
  supersample: number
  /** credit line written by the service into the video (the server reads this; the page ignores it) */
  credit?: string | null
}

export const ROOM_DEFAULTS: RoomConfig = {
  unitsPerMeter: 1,
  camera: { name: null, fovMode: 'auto', keepInside: true, insideMarginM: 0.25 },
  lights: { intensityScale: 'auto' },
  toneMapping: { type: 'Neutral', exposure: 1 },
  sky: { background: '#5aaede', envTop: '#5aaede', envBottom: '#7a8288', envTransition: 0.25, envHorizon: 0, envIntensity: 1 },
  shadow: { enabled: true, type: 'PCF', mapSize: 4096, bias: -0.0003, normalBias: 0.05, radius: 2, sunHalfFactor: 0.5, sunFarFactor: 2, spotNear: 1, spotFar: 400 },
  excludeMeshLargerThan: 100,
  floorY: null,
  stand: { distanceM: null, frameMargin: 0.06, fitTo: 'canvas', lateralM: 0, depthM: 1.5, characterHeightM: 1.35, characterScale: 1 },
  character: { ambient: 0, directional: 0, castShadow: true, receiveShadow: true, brightness: 0.3, skyFill: 1 },
  supersample: 1,
  credit: null,
}

/** the defaults with `raw` laid over them, section by section; a value of the wrong kind falls back to the default (the
 *  service checks the file strictly before it gets here) */
export function resolveRoomConfig(raw: unknown): RoomConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const sec = (k: string) => (r[k] && typeof r[k] === 'object' ? (r[k] as Record<string, unknown>) : {})
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const s = (v: unknown, d: string) => (typeof v === 'string' ? v : d)
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const pick = <K extends string>(v: unknown, d: K, all: readonly K[]): K => (all.includes(v as K) ? (v as K) : d)
  const F = ROOM_DEFAULTS, cam = sec('camera'), li = sec('lights'), tm = sec('toneMapping'), sky = sec('sky'), sh = sec('shadow'), st = sec('stand'), ch = sec('character')
  return {
    source: typeof r.source === 'string' ? r.source : undefined,
    unitsPerMeter: Math.max(1e-6, n(r.unitsPerMeter, F.unitsPerMeter)),
    camera: { name: typeof cam.name === 'string' ? cam.name : null, fovMode: pick(cam.fovMode, F.camera.fovMode, ['auto', 'vertical', 'horizontal'] as const),
      keepInside: b(cam.keepInside, F.camera.keepInside), insideMarginM: Math.max(0, n(cam.insideMarginM, F.camera.insideMarginM)) },
    lights: { intensityScale: li.intensityScale === 'auto' || li.intensityScale === undefined ? 'auto' : n(li.intensityScale, 1) },
    toneMapping: { type: pick(tm.type, F.toneMapping.type, ['Neutral', 'ACES', 'AgX', 'Linear', 'Reinhard', 'Cineon', 'None'] as const), exposure: n(tm.exposure, F.toneMapping.exposure) },
    sky: { background: s(sky.background, F.sky.background), envTop: s(sky.envTop, F.sky.envTop), envBottom: s(sky.envBottom, F.sky.envBottom),
      envTransition: Math.max(1e-3, n(sky.envTransition, F.sky.envTransition)), envHorizon: n(sky.envHorizon, F.sky.envHorizon), envIntensity: n(sky.envIntensity, F.sky.envIntensity) },
    shadow: { enabled: b(sh.enabled, F.shadow.enabled), type: pick(sh.type, F.shadow.type, ['PCFSoft', 'PCF', 'Basic', 'VSM'] as const),
      mapSize: Math.max(64, Math.min(8192, Math.round(n(sh.mapSize, F.shadow.mapSize)))), bias: n(sh.bias, F.shadow.bias), normalBias: n(sh.normalBias, F.shadow.normalBias),
      radius: n(sh.radius, F.shadow.radius), sunHalfFactor: n(sh.sunHalfFactor, F.shadow.sunHalfFactor), sunFarFactor: n(sh.sunFarFactor, F.shadow.sunFarFactor),
      spotNear: n(sh.spotNear, F.shadow.spotNear), spotFar: n(sh.spotFar, F.shadow.spotFar) },
    excludeMeshLargerThan: n(r.excludeMeshLargerThan, F.excludeMeshLargerThan),
    floorY: typeof r.floorY === 'number' && Number.isFinite(r.floorY) ? r.floorY : null,
    stand: { frameMargin: Math.max(0, Math.min(0.45, n(st.frameMargin, F.stand.frameMargin))), fitTo: pick(st.fitTo, F.stand.fitTo, ['canvas', 'file'] as const), distanceM: typeof st.distanceM === 'number' && Number.isFinite(st.distanceM) ? st.distanceM : null,
      lateralM: n(st.lateralM, F.stand.lateralM), depthM: n(st.depthM, F.stand.depthM), characterHeightM: st.characterHeightM === null ? null : Math.max(0.05, n(st.characterHeightM, F.stand.characterHeightM as number)), characterScale: Math.max(1e-3, n(st.characterScale, F.stand.characterScale)) },
    character: { ambient: Math.max(0, n(ch.ambient, F.character.ambient)), directional: Math.max(0, n(ch.directional, F.character.directional)),
      castShadow: b(ch.castShadow, F.character.castShadow), receiveShadow: b(ch.receiveShadow, F.character.receiveShadow),
      brightness: Math.max(0, n(ch.brightness, F.character.brightness)), skyFill: Math.max(0, n(ch.skyFill, F.character.skyFill)) },
    supersample: Math.max(1, Math.min(3, n(r.supersample, F.supersample))),
    credit: typeof r.credit === 'string' ? r.credit : null,
  }
}

/** what a loaded room says about itself, and where it put things (file units unless named m) */
export interface RoomInfo {
  camera: { name: string; position: number[]; yfovDeg: number; hfovDeg: number; aspect: number; near: number; far: number }
  unitsPerMeter: number
  lightScale: number
  lights: { name: string; type: string; intensity: number }[]
  floorY: number
  floorFrom: 'config' | 'ray' | 'bounds'
  ceilingY: number
  stand: number[]
  facingY: number
  bounds: { min: number[]; max: number[]; diagonal: number }
  meshes: number
}

/** the character's framing, in its own units (m), measured at load: the framing centre's height, the feet's, and the
 *  scene's own rotation (a VRM 0.x is turned round) */
export interface CharacterGauge { frameY: number; feetY: number; height: number; baseRotY: number }

/** the view as the pose gives it, plus the camera's orbit */
export interface RoomView { x: number; y: number; zoom: number; pitch: number; yaw: number; lens?: number }

export class Room {
  readonly cfg: RoomConfig
  readonly info: RoomInfo
  private THREE: typeof T
  private root: T.Object3D
  private base: { pos: T.Vector3; quat: T.Quaternion; yfov: number; aspect: number; near: number; far: number }
  private lights: T.Light[]
  private right: T.Vector3
  private stand: T.Vector3
  private pivot: T.Vector3
  private scale = 1
  private facing = 0
  private env: T.WebGLRenderTarget | null = null
  private gauge: CharacterGauge = { frameY: 1, feetY: 0, height: 1, baseRotY: 0 }
  private tmp: { v: T.Vector3; q: T.Quaternion; q2: T.Quaternion; up: T.Vector3 }
  private bounds: T.Box3
  private solid: T.Mesh[] | null = null
  /** the file camera's horizontal heading, the character's size in file units and whether the stand is still to be fitted to the canvas */
  private fh: T.Vector3
  private bodyH = 1
  private pendingFit = false
  /** the camera's lowest and highest allowed height (file units) when keepInside */
  private ySpan: [number, number] = [-Infinity, Infinity]

  constructor(THREE: typeof T, gltf: GLTF, cfg: RoomConfig, name: string) {
    this.THREE = THREE
    this.cfg = cfg
    this.right = new THREE.Vector3(1, 0, 0)
    this.stand = new THREE.Vector3()
    this.pivot = new THREE.Vector3()
    this.bounds = new THREE.Box3()
    this.fh = new THREE.Vector3(0, 0, -1)
    this.tmp = { v: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0) }
    this.root = gltf.scene
    // the file's camera in world coordinates (its nodes hang off the glTF scene, a plain group: give it a parent chain)
    const holder = new THREE.Scene()
    holder.add(this.root)
    holder.updateMatrixWorld(true)
    const cams = gltf.cameras as T.PerspectiveCamera[]
    const camera = cfg.camera.name ? cams.find((c) => c.name === cfg.camera.name) : cams[0]
    if (!camera || !camera.isPerspectiveCamera) {
      throw new LivLivError('invalid', `LivLiv: room ${name} has no ${cfg.camera.name ? `perspective camera named "${cfg.camera.name}"` : 'perspective camera'}: every view is relative to the file's camera`)
    }
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), sc = new THREE.Vector3()
    camera.matrixWorld.decompose(pos, quat, sc)
    const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0.05 ? camera.aspect : 16 / 9
    this.base = { pos, quat, yfov: camera.fov * D, aspect, near: camera.near, far: camera.far }
    holder.remove(this.root)

    // the bounds of the room proper: no ground slab
    let meshes = 0
    const box = new THREE.Box3(), size = new THREE.Vector3()
    this.root.traverse((o) => {
      const m = o as T.Mesh
      if (!m.isMesh) return
      meshes++
      box.setFromObject(m).getSize(size)
      if (Math.max(size.x, size.y, size.z) <= cfg.excludeMeshLargerThan) this.bounds.union(box)
    })
    if (this.bounds.isEmpty()) this.bounds.setFromObject(this.root)
    const diag = this.bounds.getSize(new THREE.Vector3()).length()
    // lights: the exporter's watt-to-lux factor out
    const lights: T.Light[] = []
    this.root.traverse((o) => { if ((o as T.Light).isLight) lights.push(o as T.Light) })
    const maxI = lights.reduce((m, l) => Math.max(m, l.intensity), 0)
    const generator = String(gltf.asset?.generator ?? '')
    const lightScale = cfg.lights.intensityScale === 'auto' ? (/blender/i.test(generator) && maxI > 100 ? 1 / 683 : 1) : cfg.lights.intensityScale
    for (const l of lights) l.intensity *= lightScale
    this.lights = lights
    this.info = {
      camera: { name: camera.name || '(unnamed)', position: pos.toArray(), yfovDeg: camera.fov, hfovDeg: 2 * Math.atan(Math.tan(this.base.yfov / 2) * aspect) / D, aspect, near: camera.near, far: camera.far },
      unitsPerMeter: cfg.unitsPerMeter, lightScale,
      lights: lights.map((l) => ({ name: l.name, type: l.type, intensity: l.intensity })),
      floorY: 0, floorFrom: 'bounds', ceilingY: 0, stand: [0, 0, 0], facingY: 0,
      bounds: { min: this.bounds.min.toArray(), max: this.bounds.max.toArray(), diagonal: diag }, meshes,
    }
  }

  /** the room goes into `scene` (the character's), with its shadows and sky; the character is put on the floor in front
   *  of the file's camera, facing it */
  mount(scene: T.Scene, character: T.Object3D, gauge: CharacterGauge) {
    const THREE = this.THREE, cfg = this.cfg, sh = cfg.shadow
    this.gauge = gauge
    this.root.removeFromParent()
    scene.add(this.root)
    scene.updateMatrixWorld(true)
    scene.background = new THREE.Color(cfg.sky.background)
    scene.environmentIntensity = cfg.sky.envIntensity
    // shadows: every mesh casts and receives; spots keep their own cone, the sun is re-centred on the room
    this.root.traverse((o) => {
      const m = o as T.Mesh
      if (m.isMesh) { m.castShadow = sh.enabled; m.receiveShadow = sh.enabled }
    })
    const ctr = this.bounds.getCenter(new THREE.Vector3()), R = this.bounds.getSize(new THREE.Vector3()).length()
    for (const l of this.lights) {
      const spot = l as T.SpotLight, sun = l as T.DirectionalLight
      if (!sh.enabled) { l.castShadow = false; continue }
      if (spot.isSpotLight) {
        spot.castShadow = true
        this.shadowOf(spot)
        spot.shadow.camera.near = sh.spotNear; spot.shadow.camera.far = sh.spotFar
        spot.shadow.camera.updateProjectionMatrix()
      } else if (sun.isDirectionalLight) {
        // the file's sun sits wherever the author put it: aim it at the room's centre from one diagonal away, and
        // let its shadow box cover the room (scene.attach keeps the world transform, so the direction is the file's)
        const lp = new THREE.Vector3(), tp = new THREE.Vector3()
        sun.getWorldPosition(lp); sun.target.getWorldPosition(tp)
        const dir = tp.sub(lp).normalize()
        scene.attach(sun)
        sun.target.removeFromParent(); scene.add(sun.target)
        sun.target.position.copy(ctr)
        sun.position.copy(ctr).addScaledVector(dir, -R)
        sun.castShadow = true
        this.shadowOf(sun)
        const h = R * sh.sunHalfFactor, c = sun.shadow.camera
        c.left = -h; c.right = h; c.top = h; c.bottom = -h; c.near = 0.5; c.far = R * sh.sunFarFactor
        c.updateProjectionMatrix()
      }
    }
    // the character: as big as metres are in this file, on the floor in front of the camera, facing it
    const base = this.base
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(base.quat)
    this.fh.set(f.x, 0, f.z)
    if (this.fh.lengthSq() < 1e-8) this.fh.set(0, 0, -1)  // a camera looking straight up or down: take -z for its heading
    this.fh.normalize()
    this.right.set(-this.fh.z, 0, this.fh.x)
    // metres in file units, by the character's own height when the config says how tall it stands
    this.scale = cfg.unitsPerMeter * cfg.stand.characterScale * (cfg.stand.characterHeightM !== null ? cfg.stand.characterHeightM / Math.max(1e-6, gauge.height) : 1)
    this.bodyH = gauge.height * this.scale
    this.facing = Math.atan2(-this.fh.x, -this.fh.z)  // the character's +z toward the camera
    this.solveStand(this.tanV(base.aspect))
    // with the default spot, the first frame refits it to the canvas (the aspect is not known before)
    this.pendingFit = cfg.stand.distanceM === null && cfg.stand.fitTo === 'canvas'
    this.place(character, 0, 0, 1)
  }

  /** tan of half the vertical field of view on a canvas of this aspect: the file's, or its horizontal one kept */
  private tanV(aspect: number): number {
    const base = this.base, mode = this.cfg.camera.fovMode, t = Math.tan(base.yfov / 2)
    return mode === 'horizontal' || (mode === 'auto' && aspect < base.aspect) ? t * base.aspect / aspect : t
  }

  /** where the character stands (spot, floor, pivot, the orbit's height span), for a camera whose half vertical field of
   *  view has tangent `tanV` */
  private solveStand(tanV: number) {
    const THREE = this.THREE, cfg = this.cfg, base = this.base, fh = this.fh, upm = cfg.unitsPerMeter, bodyH = this.bodyH
    const at = (t: number) => new THREE.Vector3().copy(base.pos).addScaledVector(fh, t).addScaledVector(this.right, cfg.stand.lateralM * upm)
    // a first floor to fit against: under the asked spot, else under the nearest spot along the heading that has one
    let floor = this.findFloor(at(cfg.stand.distanceM !== null ? cfg.stand.distanceM * upm : 0))
    if (floor.from === 'bounds' && cfg.stand.distanceM === null) {
      for (let t = 2 * upm; t <= 100 * upm && floor.from === 'bounds'; t += 2 * upm) floor = this.findFloor(at(t))
    }
    let heading = cfg.stand.distanceM !== null ? cfg.stand.distanceM * upm : this.fitDistance(at, floor.y, bodyH, cfg.stand.frameMargin, tanV)
    if (cfg.stand.distanceM === null && cfg.floorY === null) {
      // the floor under the spot found may differ from the one under the guess (a step, a platform): once more
      const again = this.findFloor(at(heading))
      if (Math.abs(again.y - floor.y) > 1e-3) { floor = again; heading = this.fitDistance(at, floor.y, bodyH, cfg.stand.frameMargin, tanV) }
    }
    // deeper in the room by `depthM`: step away from the camera, a tenth of a metre at a time, while there is still the same floor
    // under the character (a ray down finds one within 15 cm of the first spot's: the room's open edge, a sill and a slope end
    // it) and nothing stands within reach of its body (rays out sideways at four heights: a wall, a desk). It stops at the last
    // good step. Nearer the camera (negative) is taken as asked
    const depth = cfg.stand.depthM * upm
    if (depth !== 0) {
      let h = Math.max(1e-3, heading + depth)
      if (depth > 0) {
        const y0 = floor.y, step = 0.1 * upm
        const good = (t: number) => {
          const f = cfg.floorY === null ? this.findFloor(at(t)) : { y: cfg.floorY, from: 'config' as const }
          return f.from !== 'bounds' && Math.abs(f.y - y0) <= 0.15 * upm && !this.blocked(at(t), f.y, bodyH, upm)
        }
        h = heading
        for (let t = heading + step; t < heading + depth + step / 2; t += step) { if (!good(Math.min(t, heading + depth))) break; h = Math.min(t, heading + depth) }
      }
      heading = h; floor = cfg.floorY === null ? this.findFloor(at(h)) : floor
    }
    const s = at(heading)
    s.y = floor.y
    this.stand.copy(s)
    this.pivot.set(s.x, s.y + (this.gauge.frameY - this.gauge.feetY) * this.scale, s.z)
    // the ceiling over the character: the nearest downward-facing surface above its head
    const ceil = this.findCeiling(s.x, s.y + bodyH, s.z)
    const margin = cfg.camera.insideMarginM * upm
    this.ySpan = cfg.camera.keepInside ? [floor.y + margin, ceil - margin] : [-Infinity, Infinity]
    this.info.floorY = floor.y; this.info.floorFrom = floor.from; this.info.ceilingY = ceil
    this.info.stand = s.toArray(); this.info.facingY = this.facing
  }

  private shadowOf(l: T.SpotLight | T.DirectionalLight) {
    const sh = this.cfg.shadow
    l.shadow.mapSize.set(sh.mapSize, sh.mapSize)
    l.shadow.bias = sh.bias; l.shadow.normalBias = sh.normalBias; l.shadow.radius = sh.radius
  }

  /** the smallest distance (file units, along the camera's horizontal heading) at which a character `bodyH` tall standing on
   *  `floorY` has its feet inside the file camera's picture with `margin` of the frame's height below them: the head is
   *  never the limit, since the camera is at about head height. Bisection: the feet rise in the frame as it walks away */
  private fitDistance(at: (t: number) => T.Vector3, floorY: number, bodyH: number, margin: number, tanH: number): number {
    const THREE = this.THREE, base = this.base
    const inv = base.quat.clone().invert(), p = new THREE.Vector3()
    const ndcY = (t: number, y: number) => {
      p.copy(at(t)); p.y = y
      p.sub(base.pos).applyQuaternion(inv)
      return p.z < 0 ? p.y / -p.z / tanH : -Infinity
    }
    const ok = (t: number) => ndcY(t, floorY) >= -(1 - 2 * margin) && ndcY(t, floorY + bodyH) <= 1 - 2 * margin
    let lo = 1e-3, hi = 1e4
    if (!ok(hi)) return hi
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid }
    return hi
  }

  /** something of the room within reach of a body standing at `p` (its feet on `floorY`, `bodyH` tall): rays out sideways, 0.3 m
   *  long, at four heights up the body, hit a mesh (floors and ceilings are not met: the rays are level) */
  private blocked(p: T.Vector3, floorY: number, bodyH: number, upm: number): boolean {
    const THREE = this.THREE
    if (!this.solid) {
      this.solid = []
      const box = new THREE.Box3(), size = new THREE.Vector3()
      this.root.traverse((o) => {
        const m = o as T.Mesh
        if (!m.isMesh) return
        box.setFromObject(m).getSize(size)
        if (Math.max(size.x, size.y, size.z) <= this.cfg.excludeMeshLargerThan) this.solid!.push(m)
      })
    }
    const rc = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(), 0, 0.3 * upm)
    for (const k of [0.15, 0.4, 0.65, 0.9]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2
        rc.ray.origin.set(p.x, floorY + bodyH * k, p.z); rc.ray.direction.set(Math.cos(a), 0, Math.sin(a))
        if (rc.intersectObjects(this.solid, false).length) return true
      }
    }
    return false
  }

  /** the floor under `at` (file units): from the config, else the widest upward-facing surface a ray down from the
   *  camera's height meets there (the floor is the biggest horizontal thing under a classroom's desks), else the
   *  room's lowest point */
  private findFloor(at: T.Vector3): { y: number; from: 'config' | 'ray' | 'bounds' } {
    const THREE = this.THREE
    if (this.cfg.floorY !== null) return { y: this.cfg.floorY, from: 'config' }
    const meshes: T.Mesh[] = []
    const box = new THREE.Box3(), size = new THREE.Vector3()
    this.root.traverse((o) => {
      const m = o as T.Mesh
      if (!m.isMesh) return
      box.setFromObject(m).getSize(size)
      if (Math.max(size.x, size.y, size.z) <= this.cfg.excludeMeshLargerThan) meshes.push(m)
    })
    const rc = new THREE.Raycaster(new THREE.Vector3(at.x, this.base.pos.y, at.z), new THREE.Vector3(0, -1, 0), 0, 1e6)
    let best: { y: number; area: number } | null = null
    const nm = new THREE.Matrix3(), n = new THREE.Vector3()
    for (const h of rc.intersectObjects(meshes, false)) {
      if (!h.face) continue
      n.copy(h.face.normal).applyMatrix3(nm.getNormalMatrix(h.object.matrixWorld)).normalize()
      if (n.y < 0.5) continue
      box.setFromObject(h.object).getSize(size)
      const area = size.x * size.z
      if (!best || area > best.area) best = { y: h.point.y, area }
    }
    return best ? { y: best.y, from: 'ray' } : { y: this.bounds.min.y, from: 'bounds' }
  }

  /** the height of the ceiling above (x, y, z): a ray up meets the nearest surface facing down; else the room's top */
  private findCeiling(x: number, y: number, z: number): number {
    const THREE = this.THREE
    const meshes: T.Mesh[] = []
    const box = new THREE.Box3(), size = new THREE.Vector3()
    this.root.traverse((o) => {
      const m = o as T.Mesh
      if (!m.isMesh) return
      box.setFromObject(m).getSize(size)
      if (Math.max(size.x, size.y, size.z) <= this.cfg.excludeMeshLargerThan) meshes.push(m)
    })
    const rc = new THREE.Raycaster(new THREE.Vector3(x, y, z), new THREE.Vector3(0, 1, 0), 0, 1e6)
    const nm = new THREE.Matrix3(), n = new THREE.Vector3()
    for (const h of rc.intersectObjects(meshes, false)) {
      if (!h.face) continue
      n.copy(h.face.normal).applyMatrix3(nm.getNormalMatrix(h.object.matrixWorld)).normalize()
      if (n.y < -0.5) return h.point.y
    }
    return this.bounds.max.y
  }

  /** the character's shadow switches (a character comes and goes; the room stays) */
  characterShadows(character: T.Object3D) {
    const c = this.cfg.character, on = this.cfg.shadow.enabled
    character.traverse((o) => {
      const m = o as T.Mesh
      if (m.isMesh) { m.castShadow = on && c.castShadow; m.receiveShadow = on && c.receiveShadow }
    })
  }

  /** how the character's materials take the room's light (`character.brightness`, `character.skyFill`): a toon material's lit,
   *  shade, matcap and rim colours, or a plain material's colour, are multiplied from their own values (the file's, kept on
   *  the material so a second call, or another room, starts from them again); a toon material also gets the room's sky as
   *  an ambient term. The outline pass's colour is left alone */
  characterLook(character: T.Object3D) {
    const THREE = this.THREE, c = this.cfg.character, sky = this.cfg.sky, k = c.brightness
    // the sky as irradiance for the toon shader: HemisphereLight's maths (the colour by 0.5 + 0.5 n.y), in the units of an
    // ambient term (pi x radiance), over the brightness so that it is the file's albedo that meets it, not the dimmed one
    const f = (Math.PI * sky.envIntensity * c.skyFill) / Math.max(k, 0.05)
    const top = new THREE.Color(sky.envTop).multiplyScalar(f), bot = new THREE.Color(sky.envBottom).multiplyScalar(f)
    character.traverse((o) => {
      const m = o as T.Mesh
      if (!m.isMesh) return
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const x = mat as unknown as Record<string, unknown> & { userData: Record<string, unknown> }
        if (x.isOutline) continue
        const names = ['color', 'shadeColorFactor', 'matcapFactor', 'parametricRimColorFactor'].filter((n) => (x[n] as T.Color | undefined)?.isColor)
        const keep = (x.userData.__roomBase ??= Object.fromEntries(names.map((n) => [n, (x[n] as T.Color).clone()]))) as Record<string, T.Color>
        for (const n of names) if (keep[n]) (x[n] as T.Color).copy(keep[n]).multiplyScalar(k)
        // sky fill: only a toon material has the term to add it to (the shader's ambient irradiance line)
        const u = (x as unknown as { uniforms?: Record<string, { value: unknown }> }).uniforms
        if (!u || !u.litFactor) continue
        if (c.skyFill > 0 && !x.userData.__roomFill) {
          x.userData.__roomFill = true
          u.roomFillTop = { value: top.clone() }; u.roomFillBot = { value: bot.clone() }
          const before = x.onBeforeCompile as (s: { fragmentShader: string }, r: unknown) => void
          const key = x.customProgramCacheKey as () => string
          x.onBeforeCompile = (shader: { fragmentShader: string }, r: unknown) => {
            before.call(x, shader, r)
            shader.fragmentShader = 'uniform vec3 roomFillTop;\nuniform vec3 roomFillBot;\n' + shader.fragmentShader.replace(
              'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );',
              'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor ) + mix( roomFillBot, roomFillTop, 0.5 + 0.5 * dot( normal, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) ) );')
          }
          x.customProgramCacheKey = () => key.call(x) + ',roomFill'
          ;(x as unknown as { needsUpdate: boolean }).needsUpdate = true
        } else if (u.roomFillTop) {
          (u.roomFillTop.value as T.Color).copy(top); (u.roomFillBot.value as T.Color).copy(bot)
        }
      }
    })
  }

  /** the character in the world: on its stand point, facing the camera, scaled by metres. `idle` is the pose's own
   *  motion: shares of the visible frame at the character's plane (what the file camera sees there), and a scale
   *  about its framing centre */
  private place(character: T.Object3D, idleX: number, idleY: number, idleS: number) {
    const g = this.gauge, sc = this.scale * idleS
    const dist = this.tmp.v.copy(this.base.pos).sub(this.pivot).length()
    const visH = 2 * dist * Math.tan(this.base.yfov / 2), visW = visH * this.base.aspect
    character.position.set(
      this.stand.x + this.right.x * idleX * visW,
      this.pivot.y - g.frameY * sc + idleY * visH,
      this.stand.z + this.right.z * idleX * visW)
    character.scale.setScalar(sc)
    character.rotation.y = g.baseRotY + this.facing
  }

  /** the renderer's settings for this room, and the sky as light (it needs the renderer: a new one gets a new map) */
  prepare(renderer: T.WebGLRenderer, scene: T.Scene) {
    const THREE = this.THREE, cfg = this.cfg, sky = cfg.sky
    const TM = { Neutral: THREE.NeutralToneMapping, ACES: THREE.ACESFilmicToneMapping, AgX: THREE.AgXToneMapping, Linear: THREE.LinearToneMapping,
      Reinhard: THREE.ReinhardToneMapping, Cineon: THREE.CineonToneMapping, None: THREE.NoToneMapping }
    renderer.toneMapping = TM[cfg.toneMapping.type]
    renderer.toneMappingExposure = cfg.toneMapping.exposure
    renderer.shadowMap.enabled = cfg.shadow.enabled
    renderer.shadowMap.type = { PCFSoft: THREE.PCFShadowMap, PCF: THREE.PCFShadowMap, Basic: THREE.BasicShadowMap, VSM: THREE.VSMShadowMap }[cfg.shadow.type]
    this.env?.dispose()
    const es = new THREE.Scene()
    const mat = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, toneMapped: false,
      uniforms: { top: { value: new THREE.Color(sky.envTop) }, bot: { value: new THREE.Color(sky.envBottom) }, h: { value: sky.envHorizon }, w: { value: sky.envTransition } },
      vertexShader: 'varying vec3 vd;void main(){vd=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'uniform vec3 top;uniform vec3 bot;uniform float h;uniform float w;varying vec3 vd;void main(){float t=smoothstep(h-w,h+w,vd.y);gl_FragColor=vec4(mix(bot,top,t),1.0);}' })
    const geo = new THREE.SphereGeometry(50, 32, 16)
    es.add(new THREE.Mesh(geo, mat))
    const pm = new THREE.PMREMGenerator(renderer)
    this.env = pm.fromScene(es, 0, 0.1, 100)
    scene.environment = this.env.texture
    pm.dispose(); geo.dispose(); mat.dispose()
  }

  /** the camera for this frame, and the character where its pose wants it */
  frame(cam: T.PerspectiveCamera, character: T.Object3D, aspect: number, v: RoomView, idle: { x: number; y: number; s: number }) {
    const base = this.base
    // field of view: the file's vertical one, or its horizontal one kept on a narrower canvas
    const tanV = this.tanV(aspect)
    if (this.pendingFit) { this.pendingFit = false; this.solveStand(tanV) }
    this.place(character, idle.x, idle.y, idle.s)
    cam.fov = 2 * Math.atan(tanV / Math.max(v.lens ?? 1, 1e-3)) / D
    cam.aspect = aspect
    cam.near = base.near; cam.far = base.far
    cam.updateProjectionMatrix()
    // the lens shift: x and y shares of the frame (a whole frame is 2 in clip space), y up
    const e = cam.projectionMatrix.elements
    e[8] = -2 * v.x; e[9] = -2 * v.y
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert()
    // the orbit about the character: pitch about the file camera's horizontal right axis, then yaw about the world's up
    const { q, q2, v: o, up } = this.tmp
    q.setFromAxisAngle(up, v.yaw * D)
    const to = (pitch: number) => {
      q2.setFromAxisAngle(this.right, pitch * D)
      q.setFromAxisAngle(up, v.yaw * D).multiply(q2)
      return o.copy(base.pos).sub(this.pivot).multiplyScalar(1 / Math.max(v.zoom, 1e-3)).applyQuaternion(q)
    }
    let pitch = v.pitch
    const [lo, hi] = this.ySpan
    const high = (p: number) => { const y = this.pivot.y + to(p).y; return y < lo || y > hi }
    if (high(pitch)) {
      // the camera is out of the room at this pitch (whatever the dolly): the nearest pitch toward 0 that is in. If even 0 is
      // out (a dolly out beyond the ceiling, say) the pitch is 0 and the camera is where the dolly puts it
      let a = 0, b = pitch
      if (high(a)) b = a
      else for (let i = 0; i < 24; i++) { const m = (a + b) / 2; if (high(m)) b = m; else a = m }
      pitch = a
    }
    to(pitch)
    cam.position.copy(this.pivot).add(o)
    cam.quaternion.copy(q).multiply(base.quat)
    cam.updateMatrixWorld(true)
  }

  dispose() {
    this.env?.dispose(); this.env = null
    this.root.removeFromParent()
    const seen = new Set<unknown>()
    this.root.traverse((o) => {
      const m = o as T.Mesh
      if (!m.isMesh) return
      m.geometry.dispose()
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (seen.has(mat)) continue
        seen.add(mat)
        for (const val of Object.values(mat)) if (val && (val as T.Texture).isTexture) (val as T.Texture).dispose()
        mat.dispose()
      }
    })
  }
}
