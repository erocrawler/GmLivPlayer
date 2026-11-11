// The 3D room's configuration: the player's defaults (resolveRoomConfig) and the render service's strict reading of a
// <room>.bg.json, camera presets ("views") included. No GPU and no room file: the room's data is built here.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveRoomConfig } from '../src/room'
// @ts-expect-error plain JS module of the render service
import { checkBg3dConfig, roomView, VIEW_RANGES } from '../render-service/bg3d-config.mjs'

describe('room defaults', () => {
  it('the character takes the whole sky and a third of the toon light', () => {
    const c = resolveRoomConfig({})
    assert.equal(c.character.skyFill, 1)
    assert.equal(c.character.brightness, 0.3)
    assert.equal(c.stand.depthM, 1.5)
  })
  it('the file wins over the defaults, and the page ignores views (the service resolves them)', () => {
    const c = resolveRoomConfig({ character: { skyFill: 0.35 }, views: { full: { zoom: 1 } } })
    assert.equal(c.character.skyFill, 0.35)
    assert.equal((c as unknown as Record<string, unknown>).views, undefined)
  })
})

describe('bg.json: views', () => {
  const ok = { views: { full: { zoom: 1 }, face: { y: -0.3, zoom: 4.5, pitch: 5, gaze: 0.5 }, tele: { zoom: 3, lens: 3 }, _note: 'comment' } }
  it('fills the defaults of a view and keeps its numbers', () => {
    const v = checkBg3dConfig(ok).views
    assert.deepEqual(Object.keys(v), ['full', 'face', 'tele'])
    assert.equal(v.tele.lens, 3)
    assert.deepEqual(v.full, { x: 0, y: 0, zoom: 1, pitch: 0, yaw: 0, gaze: 1, lens: 1 })
    assert.deepEqual(v.face, { x: 0, y: -0.3, zoom: 4.5, pitch: 5, yaw: 0, gaze: 0.5, lens: 1 })
  })
  it('is strict: unknown keys, bad names and out-of-range numbers are errors', () => {
    const bad = (views: unknown, re: RegExp) => assert.throws(() => checkBg3dConfig({ views }), re)
    bad({ full: { zoomm: 1 } }, /unknown key "views.full.zoomm"/)
    bad({ full: { zoom: 5.01 } }, /views.full.zoom.*\[0.2, 5\]/)
    bad({ full: { zoom: 0.1 } }, /views.full.zoom/)
    bad({ full: { pitch: 61 } }, /views.full.pitch/)
    bad({ full: { yaw: -181 } }, /views.full.yaw/)
    bad({ full: { gaze: 2 } }, /views.full.gaze/)
    bad({ full: { lens: 0.5 } }, /views.full.lens/)
    bad({ full: { lens: 4.1 } }, /views.full.lens/)
    bad({ full: { x: 'a' } }, /views.full.x/)
    bad({ full: { x: NaN } }, /views.full.x/)
    bad({ full: null }, /views.full/)
    bad({ full: [] }, /views.full/)
    bad({ Full: {} }, /view name "Full"/)
    bad({ '1x': {} }, /view name "1x"/)
    bad({ ["a".repeat(25)]: {} }, /view name/)
    bad([], /camera presets/)
    bad(null, /camera presets/)
    bad(Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['v' + i, {}])), /at most 32/)
    for (const k of Object.keys(VIEW_RANGES)) assert.doesNotThrow(() => checkBg3dConfig({ views: { a: { [k]: VIEW_RANGES[k][0] }, b: { [k]: VIEW_RANGES[k][1] } } }))
  })
  it('still checks the rest of the file', () => {
    assert.throws(() => checkBg3dConfig({ character: { skyFill: 11 } }), /character.skyFill/)
    assert.throws(() => checkBg3dConfig({ nonsense: 1 }), /unknown key "nonsense"/)
    assert.equal(checkBg3dConfig({ character: { skyFill: 1 } }).character.skyFill, 1)
  })
  it('a job names a view of its own room, or is told which the room has', () => {
    const views = checkBg3dConfig(ok).views
    assert.equal(roomView('face', views, 'r.glb').zoom, 4.5)
    assert.throws(() => roomView('nope', views, 'r.glb'), /unknown view "nope" for bg3d room r.glb \(have: full, face, tele\)/)
    assert.throws(() => roomView('full', undefined, 'r.glb'), /defines no named views/)
    assert.throws(() => roomView('constructor', views, 'r.glb'), /unknown view/)
    assert.throws(() => roomView('__proto__', views, 'r.glb'), /unknown view/)
  })
})
