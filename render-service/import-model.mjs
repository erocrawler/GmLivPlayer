// Import tool: generate a per-model config for the Live2D render pipeline.
// Scans a model directory (or a .zip containing one) for *.motion3.json and
// *.exp3.json, derives aliases, and writes <Model>.config.json.
// The render page (m1-demo/src/render.ts) reads the config instead of the
// hardcoded MOTIONS / EXPR_ALIASES maps, so a new model needs an import run,
// not a code change.
//
// Why a config (not runtime directory listing):
//   - A browser cannot list a directory over HTTP (no directory-listing API).
//   - This model's model3.json declares NO Motions/Expressions
//     (FileReferences.Motions/Expressions are null), so the standard
//     discovery path yields nothing. The filenames must come from a manifest.
//   - Motion/expression folders vary by model (Animation/ vs animations/,
//     Exp3/ vs expressions/), so the config records the RELATIVE PATH of each
//     file, not just the filename.
//
// Loop policy (encoded here, not copied from the files):
//   - A motion loops ONLY if its alias matches /^idle(_.*)?$/i
//     (idle, idle_01, idle_2, ...). Every other motion is a one-shot.
//   - The files' own Meta.Loop is NOT copied: it is true for ALL motions in
//     every model tested so far (DSGongpi, hijiki, akari, wanko), including
//     one-shot transitions — blindly following it made the arm re-raise
//     forever (motion fix 2026-11-07).
//
// Outfit tagging (encoded here, derived from the exp3 files, not from alias
// names): an expression is an "outfit" (clothing / body-type / accessory
// variant) when it drives a clothing/body-type parameter.
//   Tier 1 (parameter ID, structural): the driven parameter's Id matches
//     /clothes/i (Clothes1-5), /movement/i (Movement1/3 hand-pose toggles)
//     or /lean/i (LeanInput body lean). These are Live2D-conventional
//     parameter families for clothing/body/pose, not face.
//   Tier 2 (display name, semantic heuristic): some models drive accessories
//     through opaque toggle keys (e.g. key10, key11, key12) whose Id says
//     nothing. The model's .cdi3.json (when present) gives each such key a
//     human display name ('大钢盆', '黑框眼镜', '单片眼镜'); if that name
//     matches an accessory keyword, the expression is an outfit.
//     Tier 2 is a heuristic: a model whose display names don't use these
//     keywords leaves its accessory toggles untagged (they stay plain
//     expressions). The keyword list is documented below, not model-specific.
//   The result is a top-level "outfits" array of expression aliases in the
//   config. Face expressions (eyes, tears, blush, sweat, fangs, ...) drive
//   none of these parameters and are never tagged.
//
// Usage:
//   node import-model.mjs <model-dir-or-zip> [--out <config-path>]
//       [--copy-to-resources] [--aliases <overrides.json>]
//       [--model-name <name>] [--max-tex <px>]
//   --out: where to write the config (default: <modelDir>/<Model>.config.json)
//   --copy-to-resources: copy the model into m1-demo/public/Resources/<Model>/
//       (skips files already identical; renames the .model3.json to
//       <Model>.model3.json if needed so the render page can find it)
//   --aliases: JSON mapping filename (or relative path) -> alias, or
//       {"motions": {...}, "expressions": {...}}. Values may be a string
//       (alias) or {"alias": ..., "loop": true|false}.
//   --model-name: override the derived model name (dir name + .model3.json stem)
//   --max-tex: downscale PNG textures larger than <px> (longest side) via PIL
//       when copying (default: keep original size).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = path.join(BASE, 'm1-demo', 'public', 'Resources');

function usage() {
  console.log(`Usage: node import-model.mjs <model-dir-or-zip> [--out <config-path>] [--copy-to-resources] [--aliases <overrides.json>] [--model-name <name>] [--max-tex <px>]`);
  process.exit(2);
}

// ---------- helpers ----------
function toPosix(p) { return p.split(path.sep).join('/'); }

function sanitizeName(s) {
  // Keep [A-Za-z0-9_-] and CJK; replace everything else with '_', collapse.
  return s.replace(/[^\w\u4e00-\u9fff]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function isCleanAscii(s) { return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s); }

// Decode #UXXXX escapes in a path component (e.g. the DSGongpi zip uses
// '#U5927' for a CJK character). No-op when there are none.
function decodeEscapes(name) {
  return name.replace(/#U([0-9A-Fa-f]{4})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walkFiles(p, out);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

// Derive a readable alias from a filename stem.
//   '00_idle' -> 'idle' (leading number + rest -> rest)
//   '01'      -> '01'   (bare number -> the number itself)
//   'Idle_2'  -> 'idle_2'
//   'Love'    -> 'love'
//   '脸红'    -> '脸红' (CJK kept as-is)
function deriveAlias(stem) {
  let base = stem;
  const m = stem.match(/^(\d+)[_\-\s]+(.+)$/);
  if (m) base = m[2].trim() ? m[2] : m[1];
  let s = sanitizeName(base.toLowerCase());
  if (!s) s = sanitizeName(stem.toLowerCase()) || 'item';
  return s;
}

function isIdleAlias(alias) { return /^idle(_.*)?$/i.test(alias); }

// ---------- args ----------
const args = process.argv.slice(2);
if (!args.length || args[0].startsWith('--')) usage();
const input = path.resolve(args[0]);
const opts = { out: null, copyToResources: false, aliases: null, modelName: null, maxTex: 0 };
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') opts.out = path.resolve(args[++i]);
  else if (a === '--copy-to-resources') opts.copyToResources = true;
  else if (a === '--aliases') opts.aliases = path.resolve(args[++i]);
  else if (a === '--model-name') opts.modelName = args[++i];
  else if (a === '--max-tex') opts.maxTex = parseInt(args[++i], 10);
  else { console.error('unknown option: ' + a); usage(); }
}

// ---------- resolve input (dir or zip) ----------
let modelDir = null;
let tmpDir = null;
const cleanup = () => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); };
process.on('exit', cleanup);
if (!fs.existsSync(input)) { console.error('not found: ' + input); process.exit(1); }
if (fs.statSync(input).isDirectory()) {
  modelDir = input;
} else if (/\.zip$/i.test(input)) {
  tmpDir = fs.mkdtempSync(path.join('/tmp', 'live2d-import-'));
  const r = spawnSync('unzip', ['-q', '-o', input, '-d', tmpDir], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('unzip failed'); process.exit(1); }
  // Decode #UXXXX escapes bottom-up (files first, then dirs).
  const all = walkFiles(tmpDir);
  for (const f of all) {
    const rel = path.relative(tmpDir, f);
    const dec = rel.split(path.sep).map(decodeEscapes).join(path.sep);
    if (dec !== rel) fs.renameSync(f, path.join(tmpDir, dec));
  }
  for (const d of walkFiles(tmpDir).map(f => path.dirname(f)).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => b.length - a.length)) {
    const rel = path.relative(tmpDir, d);
    const dec = rel.split(path.sep).map(decodeEscapes).join(path.sep);
    if (dec !== rel && dec) fs.renameSync(d, path.join(tmpDir, dec));
  }
  modelDir = tmpDir;
  // If the zip has a single top-level folder, the model is inside it.
  const top = fs.readdirSync(tmpDir, { withFileTypes: true }).filter(e => e.isDirectory());
  if (top.length === 1) {
    const cand = path.join(tmpDir, top[0].name);
    if (walkFiles(cand).some(f => /\.model3\.json$/i.test(f))) modelDir = cand;
  }
} else { console.error('input must be a directory or a .zip'); process.exit(1); }

// ---------- find .model3.json ----------
const allFiles = walkFiles(modelDir);
const model3s = allFiles.filter(f => /\.model3\.json$/i.test(f));
if (!model3s.length) { console.error('no .model3.json found under ' + modelDir); process.exit(1); }
let model3Path = null;
if (model3s.length === 1) model3Path = model3s[0];
else {
  const dirBase = path.basename(modelDir);
  model3Path = model3s.find(f => path.basename(f, '.model3.json') === dirBase)
    || (opts.modelName ? model3s.find(f => path.basename(f, '.model3.json') === opts.modelName) : null)
    || model3s.sort()[0];
  if (model3s.length > 1) console.error(`warning: ${model3s.length} .model3.json files; using ${path.relative(modelDir, model3Path)}`);
}
// The model dir is the dir containing the .model3.json.
modelDir = path.dirname(model3Path);
const model3Stem = path.basename(model3Path, '.model3.json');

// ---------- model name ----------
// Render page contract: Resources dir name == .model3.json stem.
// Prefer the stem when it is a clean ASCII identifier; else the source dir
// name; else --model-name (required).
let modelName = opts.modelName || null;
if (!modelName) {
  if (isCleanAscii(model3Stem)) modelName = model3Stem;
  else {
    const dirName = sanitizeName(path.basename(modelDir));
    modelName = isCleanAscii(dirName) && dirName ? dirName : null;
  }
}
if (!modelName) { console.error('cannot derive a clean model name (model3 stem and dir name are not ASCII-safe); pass --model-name <name>'); process.exit(1); }

// ---------- read model3.json (also a fallback source for motions/expressions) ----------
let model3 = {};
try { model3 = JSON.parse(fs.readFileSync(model3Path, 'utf-8')); } catch (e) { console.error('warning: cannot parse ' + model3Path + ': ' + e.message); }
const refs = model3.FileReferences || {};

// ---------- scan motions / expressions (recursive; any folder name) ----------
const relOf = (f) => toPosix(path.relative(modelDir, f));
const motionsFound = allFiles.filter(f => /\.motion3\.json$/i.test(f)).map(f => relOf(f)).sort();
const exprsFound = allFiles.filter(f => /\.exp3\.json$/i.test(f)).map(f => relOf(f)).sort();
// Merge model3.json FileReferences if present (extra source; dedupe).
for (const key of ['Motions']) {
  const arr = refs[key];
  if (Array.isArray(arr)) for (const e of arr) {
    const file = typeof e === 'string' ? e : e.File;
    if (file && /\.motion3\.json$/i.test(file) && !motionsFound.includes(toPosix(file))) motionsFound.push(toPosix(file));
  }
}
for (const key of ['Expressions']) {
  const arr = refs[key];
  if (Array.isArray(arr)) for (const e of arr) {
    const file = typeof e === 'string' ? e : e.File;
    if (file && /\.exp3\.json$/i.test(file) && !exprsFound.includes(toPosix(file))) exprsFound.push(toPosix(file));
  }
}
motionsFound.sort(); exprsFound.sort();

// ---------- overrides ----------
let overrides = {};
if (opts.aliases) {
  overrides = JSON.parse(fs.readFileSync(opts.aliases, 'utf-8'));
}
const overrideFor = (section, rel) => {
  const base = path.posix.basename(rel);
  const sec = overrides[section] || {};
  if (sec[rel] !== undefined) return sec[rel];
  if (sec[base] !== undefined) return sec[base];
  if (overrides[rel] !== undefined) return overrides[rel];
  if (overrides[base] !== undefined) return overrides[base];
  return undefined;
};

// ---------- build config ----------
const warnings = [];
function buildEntries(files, section) {
  const entries = {};
  const used = new Map(); // alias -> file
  for (const rel of files) {
    const base = path.posix.basename(rel);
    const stem = base.replace(/\.(motion3|exp3)\.json$/i, '');
    let alias, loop;
    const ov = overrideFor(section, rel);
    if (ov === null) continue; // overrides value null = skip this file
    if (ov !== undefined) {
      if (typeof ov === 'string') { alias = ov; }
      else { alias = ov.alias; if (typeof ov.loop === 'boolean') loop = ov.loop; }
    } else {
      alias = deriveAlias(stem);
    }
    if (loop === undefined) loop = isIdleAlias(alias);
    // Dedupe aliases.
    let a = alias, n = 2;
    while (used.has(a)) { a = alias + '_' + n++; }
    if (a !== alias) warnings.push(`duplicate alias '${alias}' for ${rel}; renamed to '${a}'`);
    used.set(a, rel);
    entries[a] = section === 'motions' ? { file: rel, loop } : { file: rel };
  }
  return entries;
}
const motions = buildEntries(motionsFound, 'motions');
const expressions = buildEntries(exprsFound, 'expressions');

// ---------- outfit tagging (see header comment for the rule) ----------
// Accessory keywords for Tier 2 (display names from the model's .cdi3.json).
// CJK keywords match as substrings; ASCII keywords match as whole words
// (so 'bow' does not match 'elbow', 'hat' does not match 'that').
const OUTFIT_PARAM_RE = /clothes|movement|lean/i;
const OUTFIT_NAME_RE = /眼镜|钢盆|帽子|耳环|项链|假发|围巾|眼罩|面具|耳机|发夹|蝴蝶结|耳饰|头饰|\bglasses\b|\bmonocle\b|\bbasin\b|\bhat\b|\bearring\b|\bnecklace\b|\bwig\b|\bscarf\b|\beyepatch\b|\bmask\b|\bheadphone\b|\bhairpin\b|\bbow\b/i;
// Display names from the model's .cdi3.json (Id -> Name), if present.
let cdiNames = {};
const cdi3Path = allFiles.find(f => /\.cdi3\.json$/i.test(f));
if (cdi3Path) {
  try {
    const cdi = JSON.parse(fs.readFileSync(cdi3Path, 'utf-8'));
    for (const p of cdi.Parameters || []) if (p.Id && p.Name) cdiNames[p.Id] = p.Name;
  } catch (e) { warnings.push('cannot parse ' + path.relative(modelDir, cdi3Path) + ' (outfit display-name rule skipped): ' + e.message); }
}
function isOutfitExpression(rel) {
  let params = [];
  try {
    const d = JSON.parse(fs.readFileSync(path.join(modelDir, rel), 'utf-8'));
    params = (d.Parameters || []).map(p => p.Id).filter(Boolean);
  } catch (e) { warnings.push('cannot parse ' + rel + ' (outfit check skipped): ' + e.message); return false; }
  return params.some(id => OUTFIT_PARAM_RE.test(id) || OUTFIT_NAME_RE.test(cdiNames[id] || ''));
}
const outfits = Object.entries(expressions).filter(([, v]) => isOutfitExpression(v.file)).map(([a]) => a).sort();
if (!motionsFound.length) warnings.push('no *.motion3.json found (model has no motions)');
if (!exprsFound.length) warnings.push('no *.exp3.json found (model has no expressions)');
if (!refs.Physics) warnings.push('model3.json declares no Physics (physics will be skipped at render)');
if (!refs.Motions) warnings.push('model3.json declares no Motions (found by scanning instead)');
if (!refs.Expressions) warnings.push('model3.json declares no Expressions (found by scanning instead)');

const config = { model: modelName, motions, expressions, outfits };

// ---------- write config ----------
const configPath = opts.out || path.join(modelDir, `${modelName}.config.json`);
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

// ---------- --copy-to-resources ----------
let copiedTo = null;
if (opts.copyToResources) {
  const targetDir = path.join(RESOURCES, modelName);
  const srcDir = path.dirname(model3Path);
  if (path.resolve(srcDir) === path.resolve(targetDir)) {
    copiedTo = targetDir + ' (already there; config written in place)';
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
    const files = walkFiles(srcDir).filter(f => !/\.config\.json$/i.test(f) && !/\.zip$/i.test(f));
    let copied = 0, skipped = 0;
    for (const f of files) {
      let rel = path.relative(srcDir, f);
      // Rename the .model3.json to <modelName>.model3.json so the render
      // page (which fetches <Model>.model3.json) can find it.
      if (/\.model3\.json$/i.test(f)) rel = `${modelName}.model3.json`;
      const dest = path.join(targetDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) {
        const a = fs.statSync(f), b = fs.statSync(dest);
        if (a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000) { skipped++; continue; }
      }
      fs.copyFileSync(f, dest);
      copied++;
      // Optional texture downscale (PIL) for oversized textures.
      if (opts.maxTex > 0 && /\.png$/i.test(dest)) {
        const r = spawnSync('python3', ['-c',
          `import sys; from PIL import Image
im = Image.open(sys.argv[1]); w, h = im.size; m = ${opts.maxTex}
if max(w, h) > m:
    s = m / max(w, h); im = im.resize((max(1, round(w*s)), max(1, round(h*s))), Image.LANCZOS)
    im.save(sys.argv[1]); print(f"downscaled {w}x{h} -> {im.size[0]}x{im.size[1]}")
`, dest], { encoding: 'utf-8' });
        if (r.stdout) console.log('  [tex] ' + dest + ': ' + r.stdout.trim());
        if (r.status !== 0 && r.stderr) console.error('  [tex] downscale failed for ' + dest + ': ' + (r.stderr || '').trim().split('\n').pop());
      }
    }
    // Write the config into the target dir too (the render page reads it there).
    fs.writeFileSync(path.join(targetDir, `${modelName}.config.json`), JSON.stringify(config, null, 2) + '\n');
    copiedTo = `${targetDir} (copied ${copied}, skipped ${skipped} identical)`;
  }
}

// ---------- summary ----------
console.log(`model: ${modelName}`);
console.log(`model3: ${path.relative(process.cwd(), model3Path)}`);
console.log(`motions (${Object.keys(motions).length}):`);
for (const [a, v] of Object.entries(motions)) console.log(`  ${a} -> ${v.file}  loop=${v.loop}`);
console.log(`expressions (${Object.keys(expressions).length}):`);
for (const [a, v] of Object.entries(expressions)) console.log(`  ${a} -> ${v.file}`);
console.log(`outfits (${outfits.length}): ${outfits.join(', ') || '(none)'}`);
console.log(`config: ${configPath}`);
if (copiedTo) console.log(`resources: ${copiedTo}`);
if (warnings.length) { console.log('warnings:'); for (const w of warnings) console.log('  - ' + w); }
console.log('note: loop=true only for idle* aliases; file Meta.Loop is NOT copied (it is true for one-shots too).');
