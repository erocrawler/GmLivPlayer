# render-service

Offline, frame-stepped video renderer built on this player: a small Node HTTP service that drives headless Chromium
(Playwright) page by page, captures JPEG frames and muxes them with ffmpeg (libx264 + aac). One job at a time.

- `server.mjs` – HTTP API (`x-render-key` header; `/health` is open) plus an internal static server on 127.0.0.1.
- `render.html` – 3D VRM page (`BodyPlayer` + `VrmBody`, multi-expression via `setExpressions`, see `src/body.ts`).
- `render-livliv.html` – 2.5D LivLiv `Player` page (one expression at a time; blink driven so closed eyes are snapped).
- `render-client.py` – stdlib client. `job-example.json` – portrait job (timeline, nod action).
- `supervisor.conf.example` – supervisor program.

## Layout expected on the render host (`RENDER_ROOT`, default `/workspace/plana-render`)

    RENDER_ROOT/.key            shared secret, chmod 600 (never commit)
    RENDER_ROOT/player/         render.html, render-livliv.html, dist-multi/ (npm run build output, see below), characters/*.livliv
    RENDER_ROOT/assets/{vrm,audio,bg}/   uploaded via PUT /assets/<kind>/<name>
    RENDER_ROOT/jobs/           outputs

`dist-multi` is the library build: `npx vite build --outDir dist-multi`. Node dependencies of the service: `playwright-core`.
Run with `--use-gl=angle --use-angle=gl-egl --enable-gpu --ignore-gpu-blocklist` (set in server.mjs) for GPU rendering; the
mouth envelope is the player's own `envelope()` ported to node, so lipsync matches the browser player.

## API (short)

`POST /jobs` with `vrm` XOR `character`, `audio`, `bg`/`bgColor`, `width,height,fps`, `amb,dir,gain,pre,post,duration,idle`,
`view {x,y,zoom}`, `timeline [{t,e:{expr:weight}}]`, `actions [{t,name}]`, `credit`; `GET /jobs/:id`, `/jobs/:id/video.mp4`, `/info`.
Guards: min free VRAM / disk / shm, MAX_PIXELS, MAX_FRAMES.

## Licensing notes (read before rendering other people's models)

The service burns a credit line into the video (`credit`, default from `creditFor`). Models are NOT part of this repo and are
git-ignored; check each model's terms (non-commercial / credit / no redistribution) before publishing renders. `NO_CHARACTERS`
lists characters that must never be rendered.
