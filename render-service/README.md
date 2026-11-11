# render-service

Offline, frame-stepped video renderer built on this player: a small Node HTTP service that drives headless Chromium
(Playwright) page by page, captures JPEG frames and muxes them with ffmpeg (libx264 + aac). One job at a time.

- `server.mjs` – HTTP API (`x-render-key` header; `/health` is open) plus an internal static server on 127.0.0.1.
- `render.html` – 3D VRM page (`BodyPlayer` + `VrmBody`, multi-expression via `setExpressions`, see `src/body.ts`).
- `render-livliv.html` – 2.5D LivLiv `Player` page (one expression at a time; blink driven so closed eyes are snapped).
- `render-live2d.html` + `live2d/` – Live2D page (built from `live2d-dsgongpi/m1-demo`, see `live2d/README.md`): hybrid WebGL renderer (PurismCore + Cubism Web Framework), config-driven motions/expressions. Models are pre-placed on the host, never in this repo.
- `render-client.py` – stdlib client. `job-example.json` – portrait job (timeline, nod action). `job-example-live2d.json` – Live2D job.
- `supervisor.conf.example` – supervisor program.

## Layout expected on the render host (`RENDER_ROOT`, default `/workspace/plana-render`)

    RENDER_ROOT/.key            shared secret, chmod 600 (never commit)
    RENDER_ROOT/player/         render.html, render-livliv.html, render-live2d.html, dist-multi/ (npm run build output, see below), characters/*.livliv
    RENDER_ROOT/player/live2d-assets/   Live2D player JS bundle (from live2d-dsgongpi, see live2d/README.md)
    RENDER_ROOT/player/Core/            purismcore.js (Live2D Core, MIT)
    RENDER_ROOT/player/Framework/       Cubism Web Framework shaders
    RENDER_ROOT/player/Resources/<model>/   Live2D models, PRE-PLACED on the host (model3.json + moc3 + textures + <model>.config.json) — never in git, never uploaded via the API
    RENDER_ROOT/assets/{vrm,audio,bg,anim,bg3d}/   uploaded via PUT /assets/<kind>/<name>
    RENDER_ROOT/jobs/           outputs

`dist-multi` is the library build: `npx vite build --outDir dist-multi`. Node dependencies of the service: `playwright-core`.
Run with `--use-gl=angle --use-angle=gl-egl --enable-gpu --ignore-gpu-blocklist` (set in server.mjs) for GPU rendering; the
mouth envelope is the player's own `envelope()` ported to node, so lipsync matches the browser player.

## API (short)

`POST /jobs` with `vrm` XOR `character`, `audio`, `bg`/`bgColor` (or `bg3d`, VRM only, see below), `width,height,fps`, `amb,dir,gain,pre,post,duration,idle`,
`view {x,y,zoom,pitch,yaw,gaze}` (`lens` too, bg3d only), `timeline [{t,e:{expr:weight}}]`, `actions [{t,name}]`, `animations [{t,file}]` (VRM only, see below),
`credit`; `GET /jobs/:id`, `/jobs/:id/video.mp4`, `/info`.
`view`: x/y are shares of the visible frame (y up), where 1 is the full frame — so 0.1 is a 10% nudge and 1 puts the
character's center at the edge; zoom scales about the character's center (1 is the default head-to-hips framing,
smaller shows more of the body, e.g. 0.4 for a full body); pitch tilts the camera in degrees, positive looking up
from below (a low angle, e.g. 25 to look up at the neck) and negative looking down from above; yaw orbits the camera
around the character in degrees, positive to the character's left (e.g. 45 for a side view) — VRM only, ignored for
LivLiv. From a side view the character looks at the lens: the head turns 70% of the yaw and the eyes the rest (clamped
to their ±25° range). `gaze` (0..1, default 1) scales that turn — 1 looks at the lens, 0 keeps facing forward (a
profile shot), 0.5 turns halfway. The same units apply to VRM and LivLiv. Instead of guessing numbers, pass `view` as one of the named presets (also listed in `/info`
under `views`): `full` (whole body), `half` (waist up), `bust` (chest up, the default framing), `face` (face
close-up), `neck` (low angle, neck + face from below), `low` (low angle, full upper body), `side` (45° side view, head + eyes to the lens). A `view` object
`{x,y,zoom,pitch,yaw,gaze}` still works for a custom framing. The base names are tuned for portrait 9:16 (the service
default); each also has an explicit `-portrait` twin (same values) and a `-landscape` twin whose zoom is scaled
down — in landscape the camera fits to the height, so the same zoom frames tighter (e.g. `full` is 0.4 in
portrait but 0.3 in landscape, or the feet get cut). Use the twin that matches the job's orientation. To switch cameras mid-shot, pass `viewTimeline [{t, view}]`
— `t` is seconds from audio start (same base as the expression timeline), `view` is a preset alias or a
`{x,y,zoom,pitch,yaw,gaze}` object; the latest entry whose `t` has passed wins (an immediate cut, no interpolation), and
before the first entry the base `view` applies.
`/info` also lists model capabilities under `live2dModels`, `vrmModels` and `livlivModels` (see below), so a client can discover
motion/expression/outfit aliases instead of guessing them. Guards: min free VRAM / disk / shm, MAX_PIXELS, MAX_FRAMES.

## 3D room background (`bg3d`)

A VRM job can stand in a 3D room: `bg3d: "<name>.glb"` draws that GLB and the VRM in one three.js scene (the room's
lights light and shadow the character). Only `vrm` jobs: `character` / `live2d` with `bg3d` are a 400. `bg3d` cannot be
combined with `bg` / `bgColor` (400): the room supplies the whole picture. In a room `view` is a numeric object or the
name of one of THAT room's views (below); the plain presets (`full`, `half`, ...) are tuned for the plain head-to-hips
framing and are not used there (in a room `zoom` is a dolly).

- Upload: `PUT /assets/bg3d/<name>.glb` (60 MB max; checked: a GLB with a perspective camera) and, beside it,
  `PUT /assets/bg3d/<name>.bg.json` (the room's configuration, checked strictly — unknown keys, wrong types and
  out-of-range numbers are a 400, keys starting with `_` are comments). `/info` lists every room under `bg3d`: the
  configuration as read, `views` (the names of its camera views, read-only), and what the GLB itself declares (generator,
  camera yfov/aspect, lights).
- The GLB is never modified: no geometry, material, texture or node change. The page adjusts its in-memory copy (light
  intensities, shadow switches, sky) and scales the *character*, never the room.
- **Camera**: the camera in the file (the first one, or `camera.name`) is the origin of every view parameter. All zero:
  the picture is that camera's own. `yaw` / `pitch` (degrees) orbit the camera around the character's stand point (yaw
  positive: toward the camera's right = the character's left, same as the plain VRM orbit; pitch positive: down,
  looking up at the character); `zoom` dollies along the line to the character (1 the file camera's own distance, 2 half
  of it, 0.5 twice); `x` / `y` are a lens shift: the whole picture slides by that share of the visible frame (y up) and
  the camera does not move. The character's own idle sway and `hop` move the character in the world. The field of
  view is the file's vertical one, but on a canvas narrower than the file's aspect the file's *horizontal* one is kept
  (`camera.fovMode`: `auto` | `vertical` | `horizontal`), or a portrait video would see a thin slit of the room. With
  `camera.keepInside` (default on) the orbit stops at the room's floor and ceiling (a pitch that would put the camera
  under the floor is cut short; still aimed at the character).
- **Views (camera presets)**: a room names its own framings in `<name>.bg.json`, as data (the service has none built in):

  ```json
  "views": {
    "wide": { "zoom": 1 },
    "full": { "y": 0.2, "zoom": 2.5 },
    "face": { "y": 0.03, "zoom": 3.2, "lens": 3 }
  }
  ```

  Each entry is a view, every field optional (defaults `x 0, y 0, zoom 1, pitch 0, yaw 0, gaze 1, lens 1`), in the ranges a
  job's own `view` has: `x`, `y` ∈ [-2, 2], `zoom` ∈ [0.2, 5], `pitch` ∈ [-60, 60], `yaw` ∈ [-180, 180], `gaze` ∈ [0, 1],
  `lens` ∈ [1, 4]. A name is lowercase letters, digits, `-` or `_` (start with a letter, up to 24 characters; at most 32
  views); an unknown key in an entry or a number out of range is a 400 at upload. A job then says `"view": "full"`, and
  `viewTimeline` entries may say `"view": "face"` as well; the numeric object stays valid. A name the room does not have is a
  400 that lists the ones it has. The framing depends on the room and on how the character stands (size, `stand.*`), so the
  numbers are measured per room; `/info` → `bg3d.<room>.views` lists the names and `config.views` the numbers.
  `lens` is a longer lens: it narrows the field of view (2 = half, by tangent) without moving the camera. `zoom` is
  capped at 5, and in a portrait frame the character fills it long before that (on the default stand a waist-up shot
  needs about 5× the default picture's magnification, a face about 10×), so close-ups combine the two; `lens` is for bg3d jobs only (a plain job with
  `lens` ≠ 1 is a 400).
- **Character**: stands on the floor in front of the camera facing it, `stand.characterHeightM` tall (default 1.35 m,
  whatever size its VRM file is in; null = the file's own units are metres) and scaled by `unitsPerMeter` (the room's
  size in metres). By default it is put at the nearest spot along the camera's heading at which the whole body is in
  the file camera's picture (`stand.frameMargin` of the frame height below the feet); `stand.distanceM` and
  `stand.lateralM` (metres, + = camera right) move it; `stand.depthM` (default 1.5) puts it that many metres *deeper* than
  that spot (nearer the desks at the back; negative: nearer the camera), stepping away from the camera a tenth of a metre
  at a time and stopping at the last spot that still has the same floor under it (within 15 cm of the first spot's: the
  room's open edge, a sill, a slope end it) and nothing (wall, desk) within 0.3 m of the body. The floor is found with a ray down from the camera's height
  (the widest upward-facing surface; meshes larger than `excludeMeshLargerThan` are ignored), or `floorY`.
- **How bright the character is** (`character.brightness`, default 0.3; `character.skyFill`, default 1): the toon (MToon)
  shader does not weigh a light by the cosine of its angle (its toon step replaces it), so under the room's sun a white
  costume gets the full `I/π` where the room's PBR surfaces get `I·cosθ/π` (sun elevation ≈ 22°: the floor gets 0.37 of it): ~2.5×
  brighter than a white thing in the room, blown out by the tone mapping and cream from the sun's warm colour. `brightness`
  multiplies the toon materials' lit / shade / matcap / rim colours (1 = as the model's file says; 0.3 puts a white skirt at the
  luma of the room's white lockers, ≈ 205/255). MToon also ignores `scene.environment` (three.js only hands it to its own
  standard materials), so the character has no sky light, which is what keeps the room's whites white; `skyFill` adds the
  sky (`sky.envTop` above / `sky.envBottom` below × `sky.envIntensity`, hemisphere-light maths) as an ambient term in the
  character's shader only, × this (1 = the room's full sky, a blue-white costume; about 0.35 is neutral; 0 = none). Neither touches the room, and
  `sky.envIntensity`, `toneMapping.exposure` and `character.ambient` were measured not to be the cause. Tuned for the Arona
  room's sun: set both per room.
- **Light**: `lights.intensityScale` `"auto"` divides by 683 when the file says Blender and a light is brighter than
  100 (the glTF exporter multiplied watts by 683); the character's own two lights (`character.ambient` /
  `character.directional`, default 0) are used only on top of the room's; a job's `amb` / `dir` set them when given
  (and never touch the room's lights). Tone mapping, sky colour + gradient environment light, shadow maps (`mapSize`,
  `bias`, `normalBias`, `radius`; three.js r186 has no soft PCF, `PCFSoft` is PCF) and `supersample` (drawing buffer =
  canvas × n; default 1) are all in `<name>.bg.json`; see `src/room.ts` (`RoomConfig`) for every field and its meaning.
- **Credit**: `credit` in `<name>.bg.json` is fixed server-side and appended to the video's credit line (after the
  model's own credit, `|`-separated); the request cannot override or disable it.

## Live2D jobs (third format, alongside VRM and LivLiv)

`POST /jobs` with `live2d` (model name, e.g. `DSGongpi`) instead of `vrm`/`character`. Same envelope as the other
formats: `audio` (16-bit PCM WAV, already in `assets/audio/`), `width` (height is derived: always portrait 9:16,
`height = round(width*1280/720)`, so effective max width is ~1112 under MAX_PIXELS), `fps`, `gain` (mouth),
`pre`/`post`, `timeline [{t,e:{alias:weight}}]` (expression aliases from the model's config, e.g. `heart`, `blush`,
`cry`), `actions [{t,name}]` (one-shot motion aliases, e.g. `raise_hand` — played once, end pose held), `motion`
(optional base loop alias, default = the model's base loop, e.g. `idle`). Timeline/action `t` is seconds from audio
start (same convention as VRM/LivLiv). `bg`/`bgColor`/`view`/`amb`/`dir`/`idle` are VRM/LivLiv-only and ignored for
Live2D. See `job-example-live2d.json`.

- Models are pre-placed only: `player/Resources/<model>/` must contain `<model>.model3.json` + the moc/textures and a
  `<model>.config.json` (generated by `import-model.mjs`, see "Importing a Live2D model" below). There is no upload endpoint for models. `/info` lists available
  models under `live2d` and their capabilities under `live2dModels` — per model: `motions` (alias + `loop` flag),
  `expressions` (aliases) and `outfits` (aliases, a subset of `expressions` for clothing/body-type/accessory variants).
  The data comes from each model's `<Model>.config.json` at request time; nothing is hardcoded in `server.mjs`.
  Example (DSGongpi): `"live2dModels": {"DSGongpi": {"motions": [{"alias": "idle", "loop": true}, ...], "expressions": ["blush", "heart", ...], "outfits": ["chibi", "body1", "normal", "chest", "shoes", "skirt", "tail", "monocle", "glasses", "steelbasin", "lean", "finger_open", "finger_close"]}}`.
  Outfits are ordinary expression aliases and work in a job's `timeline` like any other expression.
- Credit is fixed server-side per model (see `LIVE2D_CREDIT` in `server.mjs`) and cannot be overridden or disabled by
  the request. The DSGongpi wording is the plan's draft; M0 (authorization + final wording) is still pending.

## VRM / LivLiv capabilities in `/info`

`/info` lists per-model expressions for the other two formats too, so an agent can discover them the same way as
Live2D: `vrmModels` (keyed by asset filename) and `livlivModels` (keyed by character id). Each entry has
`expressions` (the ids a job's `timeline` accepts) and `actions` (always `["nod","shake","tilt","hop","shy"]` —
the same fixed list `validate()` enforces; shared as the `ACTIONS` constant in `server.mjs`).

- VRM: expressions are read from the file itself — only the GLB JSON chunk is parsed (no three-vrm on the server).
  VRM 1.0 preset keys and custom keys are used as-is; VRM 0.x blendShapeGroups map through three-vrm's
  `v0v1PresetNameMap` (e.g. `joy`→`happy`, `fun`→`relaxed`; unmapped groups keep their own name, e.g. VRoid's
  `Surprised`). The reported list replicates what the player shows (`src/vrm.ts`): the FEELINGS present
  (`happy` first, then `angry`/`sad`/`relaxed`/`surprised`) plus customs (a custom whose lowercase matches a
  feeling takes that id). `BodyPlayer` always prepends a synthetic `smile` (a param, not a file expression), so
  every VRM entry starts with `"smile"`. Entries also carry `spec` (`"0"`/`"1"`) and `name` (from the file's meta).
  Verified against the repo's own test generator (`test/tiny-vrm.mjs`): tiny1 (1.0) →
  `["smile","happy","sad","surprised","Wink"]`, tiny0 (0.x) → `["smile","happy","sad"]`, both matching
  `window.exprIds()` from the player page exactly. No real-world `.vrm` was available locally — the parser is
  verified against these generated files and the three-vrm 3.5.5 source it mirrors.
- LivLiv: expressions come from the character's own `model.json` (`characters/<id>/model.json`, the file the player
  loads), so `/info` reports exactly what the player shows. `p03` (Pen) is excluded — the service refuses it (no
  rights). All 21 sample characters currently list the same 4: `["smile","shy","angry","sad"]`. A package with no
  `expressions` array falls back to a synthetic `smile` when a layer is `expr_smile`, else none (same rule as
  `src/index.ts`).
- The page is the hybrid renderer (PurismCore + Framework state, custom WebGL draw); blink repeats every 2.5s so
  long jobs keep blinking; one-shot motions hold their end pose and the base loop resumes underneath.

## VRM animations (.vrma) on a timeline

A VRM job can play `.vrma` animation clips on a timeline, so an agent can script what the character does when —
e.g. a greeting at 0s while speaking, idle in between, another gesture at 10s. See `job-example-vrm-animation.json`.

- Upload: `PUT /assets/anim/<name>.vrma` (same upload endpoint as the other kinds). The file is validated on
  upload and rejected (400) unless it is a genuine VRM animation (a `VRMC_vrm_animation` extension with a keyframed
  animation). `.vrma` applies directly to any VRM — no retargeting, because VRM humanoid bones are standardized
  (BVH cannot be used this way; it needs bone retargeting and is not supported).
- Discovery: `/info` lists every uploaded clip under `animations`, keyed by filename, with its `duration` in seconds
  (`{"hello.vrma": {"duration": 15.767}}`), and under `assets.anim`. The duration is read from the file's own
  keyframe times in the binary chunk — not from the JSON `min`/`max`, which some exporters omit (a file whose JSON
  says 0s can really be 15.8s). Read `/info` to learn the lengths instead of guessing them.
- Job param: `animations: [{file, t}]` (VRM only; rejected for Live2D/LivLiv jobs). `t` is seconds from audio start,
  the same base as `timeline` and `actions`. Each clip plays once for its own length. Switches blend instead of
  cutting: a new clip crossfades in over 0.3s (the outgoing clip fades out over the same 0.3s), and a clip ending
  eases back to idle over its last 0.3s. When no clip is playing, the idle resumes. If a clip's `t` is past the
  job's end it simply never plays.
- Stacking: expressions (`timeline`) and lip-sync (audio) stack with clips — they drive the face, clips drive the
  body, and `.vrma` files carry no expression tracks. The fixed one-shot `actions` (nod/shake/tilt/hop/shy) are
  skipped while a clip owns the bones. The idle keeps running underneath a clip for the bones the clip does not
  animate (breath, blink, eye look), so the face stays alive during a gesture.
- Determinism: clips are frame-stepped (each action's `time` is set from the frame time and `mixer.update(0)`
  applies it, never a running clock), so the same job renders identically — verified by rendering twice and
  comparing frames (see the M4 determinism check for Live2D).
- Player hook: the page (`render.html`) loads clips with `@pixiv/three-vrm-animation` (`VRMAnimationLoaderPlugin`
  + `createVRMAnimationClip`) and applies the active one in `VrmBody.onBeforeRender` (a hook in `src/vrm.ts`,
  called after the pose is written to the bones and before the model updates), so a clip overrides the pose's bones
  for the tracks it has. `VrmBody.getVRM()` exposes the loaded VRM for building the clips. Both are additive;
  VRM/LivLiv jobs without `animations` render exactly as before.

## Importing a Live2D model

`import-model.mjs` (Node, no dependencies) lives in this directory — it is the service's model-import tool, not
an R&D script. A model cannot be rendered until it has been imported: the player and `/info` both read the
`<Model>.config.json` the tool generates, and there is no model upload endpoint.

    node import-model.mjs <model-dir-or-zip> [--out <config-path>] [--copy-to-resources] [--aliases <overrides.json>] [--model-name <name>] [--max-tex <px>]

It recursively scans `*.motion3.json` / `*.exp3.json` in any folder name (case-insensitive), merges
`model3.json` FileReferences when present, derives aliases from filenames (leading-number rule: `00_idle`→`idle`,
`Idle_2`→`idle_2`, CJK stems kept verbatim), and writes `<Model>.config.json` next to the model with
`motions` (alias → `{file, loop}`), `expressions` (alias → `{file}`) and `outfits` (aliases). Loop rule is
hardcoded in the tool, NOT copied from the files' `Meta.Loop` (which is `true` even for one-shots): only
`idle*` aliases loop. Outfits are tagged generically from the exp3 contents — Tier 1: the expression drives a
`Clothes`/`Movement`/`Lean` parameter; Tier 2: accessory toggles whose `.cdi3.json` display name matches an
accessory keyword (眼镜/钢盆/帽子…). `--aliases` takes an overrides file you write yourself (filename → alias,
`null` skips a file) if you want custom names instead of the derived ones. `--copy-to-resources` copies the model
into `player/Resources/<Model>/` (the service's model dir); otherwise copy the files there yourself and place
the config alongside them. After import, `/info` lists the model under `live2d` / `live2dModels` — no restart
needed (configs are read at request time).

## Licensing notes (read before rendering other people's models)

The service burns a credit line into the video (`credit`, default from `creditFor`). Models are NOT part of this repo and are
git-ignored; check each model's terms (non-commercial / credit / no redistribution) before publishing renders. `NO_CHARACTERS`
lists characters that must never be rendered.
