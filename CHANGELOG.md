# Changelog

## Next

The featured characters are not in the npm package, so nothing here needs a new version.

- 17 of the 21 featured characters rebuilt, as livliv.ai now shows them, and their covers redrawn.
- `VrmBody.setRoom({ url, config })`: a glTF/GLB room behind a VRM, in one scene, with the file's own camera as the view's origin (see [API.md](API.md)). `Pose` gets an optional `view` (the view's part of `move`), for bodies that move a camera.
- Rooms: camera presets are data. `<room>.bg.json` may carry `views` (`{ "full": { y, zoom, ... } }`, strictly checked); a bg3d job's `view` / `viewTimeline[].view` can then name one, and `/info` lists them. New view field `lens` (1–4, a longer lens: narrows the field of view without moving the camera), for close-ups that `zoom` (a dolly, capped at 5) cannot reach. The checked reading of `bg.json` moved to `render-service/bg3d-config.mjs` (deploy it next to `server.mjs`).
- Rooms: `character.skyFill` now defaults to 1 (the room's whole sky; about 0.35 is neutral).
- Rooms: `stand.depthM` (stand deeper in the room, stops at the room's floor edge / furniture), `character.brightness` (default 0.3) and `character.skyFill` (a toon material takes the room's sun without the N·L cosine and none of its sky: the character came out ~2.5× too bright and cream; both are per-character, the room is untouched).

## 0.3.0

The first version on npm, with the interface settled first: these change what a page written for 0.2 does.

### What to change

| 0.2 | 0.3 |
|---|---|
| `import ... from '@livliv/player'` and its subpaths | `'@livliv-dev/player'`, the package's name on npm. |
| `player.act('away')` | `player.setAway(true)` and `setAway(false)`. `act('away')` now throws: it was a switch among one-off moves. |
| `player.puppet` | No longer in the types. `player.poke()` and `player.canvasToModel()` are what pages used it for. The field still exists and can change in any version. |
| `player.load(a); player.load(b)` played `a`, then `b` | The new load replaces the one running, which rejects with an `AbortError`. If you catch errors, let this one through: `if (e.name === 'AbortError') return`. |
| `dispose()` on a load running rejected with an `Error` | It rejects with an `AbortError`, as `load()` on a disposed player does. |
| Errors told apart by their message | `e.code`, on a `LivLivError`. The messages can change. |

### New

- `load(source, { signal, onProgress, poster })`: call a load off, follow how far it has come, show a picture until the first frame.
- `LivLivError`, with a `code` for each reason, from `@livliv-dev/player` and `@livliv-dev/player/body`.
- `player.contextLost` and `player.onContextLost`: the page hears when the WebGL context is gone. See [API.md](API.md#when-the-context-is-lost).
- `dispose({ release: true })`: gives the WebGL context up, for a canvas leaving the page.
- `player.setAway()`, `player.poke()`, `player.canvasToModel()`.
- `example/react.html`.

### Changed

- A model that breaks while it is built leaves the character before as it was, to the pixel. It used to leave an empty canvas.
- The pose stays in the ranges of `PARAM_RANGES` on `Player` too, as it did on `BodyPlayer`. A value that is not a number counts as the default.
- `maxPixelRatio` can be read and changed on a `Player`.
- `snapshot()` on a `Player` draws first, so it is the pose as it is now, on a paused player too.
- A `BodyPlayer`'s `Frame.time` counts the frames before this one, as a `Player`'s does. Its idle motion runs one frame later.
- The two classes now share their code. Nothing a `Player` draws changed: frame by frame, with the same random numbers, 1300 frames each of 4 characters came out identical.

See the [commits](https://github.com/livliv-dev/player/commits/main) for what came before 0.3.
