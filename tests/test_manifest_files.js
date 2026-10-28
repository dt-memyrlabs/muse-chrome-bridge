/* Manifest file-reference check: every file the manifest, the side panel
 * page, and the service worker point to must actually exist in the
 * extension folder, and each icon PNG must really be the size the
 * manifest claims. Chrome refuses to load an unpacked extension when a
 * referenced file is missing ("Could not load icon ... Could not load
 * manifest"), and the fake-chrome harness cannot catch that — this test
 * exists because a missing icons/ folder shipped in v2.4.0 and only a
 * fresh install on a second PC found it (2026-10-27).
 *
 *   node test_manifest_files.js     exit 0 = all passed
 */
"use strict";
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "extension");
let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("PASS " + name); }
  else { failures++; console.log("FAIL " + name + (detail !== undefined ? "  -- " + JSON.stringify(detail).slice(0, 300) : "")); }
}

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

const refs = new Set();
function addRef(p, where) { if (typeof p === "string" && p) refs.add(p + "\0" + where); }
if (manifest.background) addRef(manifest.background.service_worker, "background.service_worker");
if (manifest.action) {
  addRef(manifest.action.default_popup, "action.default_popup");
  if (typeof manifest.action.default_icon === "string") addRef(manifest.action.default_icon, "action.default_icon");
  if (manifest.action.default_icon && typeof manifest.action.default_icon === "object")
    for (const [k, v] of Object.entries(manifest.action.default_icon)) addRef(v, "action.default_icon." + k);
}
if (manifest.side_panel) addRef(manifest.side_panel.default_path, "side_panel.default_path");
if (manifest.options_page) addRef(manifest.options_page, "options_page");
if (manifest.devtools_page) addRef(manifest.devtools_page, "devtools_page");
for (const [k, v] of Object.entries(manifest.icons || {})) addRef(v, "icons." + k);
for (const cs of manifest.content_scripts || []) {
  for (const f of cs.js || []) addRef(f, "content_scripts.js");
  for (const f of cs.css || []) addRef(f, "content_scripts.css");
}
for (const war of manifest.web_accessible_resources || [])
  for (const f of war.resources || []) if (!f.includes("*")) addRef(f, "web_accessible_resources");

// src=/href= in every HTML file in the folder
for (const f of fs.readdirSync(EXT).filter((x) => x.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(EXT, f), "utf8");
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g))
    if (!/^(https?:|data:|#)/.test(m[1])) addRef(m[1], f);
}
// importScripts(...) in the service worker
const swPath = manifest.background && manifest.background.service_worker;
if (swPath && fs.existsSync(path.join(EXT, swPath))) {
  const sw = fs.readFileSync(path.join(EXT, swPath), "utf8");
  for (const m of sw.matchAll(/importScripts\(([^)]*)\)/g))
    for (const q of m[1].matchAll(/"([^"]+)"/g)) addRef(q[1], "importScripts in " + swPath);
}

check("at least one reference collected", refs.size > 0, refs.size);
for (const entry of [...refs].sort()) {
  const [rel, where] = entry.split("\0");
  const abs = path.join(EXT, rel);
  check(`exists: ${rel} (${where})`, fs.existsSync(abs) && fs.statSync(abs).size > 0);
}

// Icon PNGs must be real PNGs at the size the manifest key claims.
function pngSize(buf) {
  if (buf.length < 24 || buf.toString("latin1", 1, 4) !== "PNG") return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}
for (const [k, v] of Object.entries(manifest.icons || {})) {
  const abs = path.join(EXT, v);
  if (!fs.existsSync(abs)) continue; // already failed above
  const size = pngSize(fs.readFileSync(abs));
  check(`icon ${v} is a ${k}x${k} PNG`, !!size && size[0] === Number(k) && size[1] === Number(k), size);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
