# Live2D player (M4)

Static, self-contained player page for the render service's `live2d` job
type. Served from the service's PLAYER dir as `render-live2d.html`.

- `render-live2d.html` + `live2d-assets/` — built from
  `live2d-dsgongpi/m1-demo` (`render.ts` + `hybrid.ts` + the Cubism Web
  Framework, bundled by Vite). Regenerate with:
  `cd live2d-dsgongpi && node pack-service.mjs`
  (build config: `m1-demo/vite.config.service.mts`).
- `Core/purismcore.js` — PurismCore (MIT), the open Cubism Core
  re-implementation. The official `live2dcubismcore.min.js` is proprietary
  and is deliberately NOT here (the page defaults to `?core=purism`).
- `Framework/Shaders/` — Cubism Web Framework shaders (Live2D Open
  Software License), loaded at runtime by the page.

Models are NOT in this repo. They are pre-placed on the render host at
`PLAYER/Resources/<model>/` (model3.json + moc3 + textures + config).
See the render-service README for the `live2d` job format.
