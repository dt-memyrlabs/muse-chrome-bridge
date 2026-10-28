/* Muse Chrome Bridge — offscreen GIF encoder (v2.8, FULL-GAP §7).
 *
 * Lives in an offscreen document because the service worker has no
 * DOM/canvas. The worker sends GENERATE_GIF with the recorded frames
 * (base64 JPEGs + the action that produced each); this document pads
 * every frame to the largest frame's size (white, right/bottom),
 * draws the overlays — a ring on the click point, the drag path, the
 * action label chip, a progress bar, and a Muse badge — and encodes
 * with gif.js at the settings Claude's exporter uses (2 workers,
 * quality 10, loop forever), 800 ms per frame and a 2 s hold on the
 * last frame. It answers with the GIF as a data URL.
 */
"use strict";

const BLUE = "#2563eb";

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("a frame did not decode"));
    img.src = src;
  });
}

function drawLabel(ctx, text, x, y) {
  if (!text) return;
  ctx.save();
  ctx.font = "600 13px system-ui, sans-serif";
  const w = Math.min(ctx.measureText(text).width + 16, 420);
  ctx.fillStyle = "rgba(17,24,39,0.88)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, 24, 6);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + 8, y + 16, w - 12);
  ctx.restore();
}

function drawOverlays(ctx, frame, i, total, W, H) {
  const a = frame.action || {};
  ctx.save();
  // Drag path: line + arrowhead between start and end points.
  if (a.start_coordinate && a.coordinate) {
    const [sx, sy] = a.start_coordinate, [ex, ey] = a.coordinate;
    ctx.strokeStyle = BLUE; ctx.fillStyle = BLUE; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    const ang = Math.atan2(ey - sy, ex - sx);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - 10 * Math.cos(ang - 0.45), ey - 10 * Math.sin(ang - 0.45));
    ctx.lineTo(ex - 10 * Math.cos(ang + 0.45), ey - 10 * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 7); ctx.fill();
  }
  // Click ring at the action point.
  if (a.coordinate && a.type !== "type" && a.type !== "key" && a.type !== "wait") {
    const [x, y] = a.coordinate;
    ctx.strokeStyle = BLUE; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fillStyle = BLUE; ctx.fill();
  }
  // Action label chip.
  const label = a.description || a.type || "";
  if (label) {
    if (a.coordinate && a.type !== "type" && a.type !== "key" && a.type !== "wait") {
      drawLabel(ctx, label, Math.min(a.coordinate[0] + 20, Math.max(8, W - 430)), Math.max(8, a.coordinate[1] - 34));
    } else drawLabel(ctx, label, 12, 12);
  }
  // Progress bar along the bottom.
  ctx.fillStyle = "rgba(17,24,39,0.25)";
  ctx.fillRect(0, H - 5, W, 5);
  ctx.fillStyle = BLUE;
  ctx.fillRect(0, H - 5, Math.round(W * (i + 1) / total), 5);
  // Watermark badge, bottom right.
  ctx.font = "700 12px system-ui, sans-serif";
  const tw = ctx.measureText("Muse").width + 14;
  ctx.fillStyle = "rgba(17,24,39,0.82)";
  ctx.beginPath(); ctx.roundRect(W - tw - 10, H - 32, tw, 20, 6); ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText("Muse", W - tw - 3, H - 18);
  ctx.restore();
}

async function generateGif(msg) {
  const frames = msg.frames || [];
  if (!frames.length) throw new Error("no frames");
  const images = [];
  let W = 0, H = 0;
  for (const f of frames) {
    const img = await loadImage("data:image/" + (f.format || "jpeg") + ";base64," + f.base64);
    images.push(img);
    W = Math.max(W, img.naturalWidth || img.width);
    H = Math.max(H, img.naturalHeight || img.height);
  }
  if (!W || !H) throw new Error("frames have no size");
  const gif = new GIF({ workers: 2, quality: 10, repeat: 0, width: W, height: H, workerScript: "gif.worker.js" });
  const delay = msg.delay || 800;
  for (let i = 0; i < frames.length; i++) {
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(images[i], 0, 0);
    drawOverlays(ctx, frames[i], i, frames.length, W, H);
    gif.addFrame(ctx, { copy: true, delay: i === frames.length - 1 ? delay + 2000 : delay });
  }
  const blob = await new Promise((resolve) => { gif.on("finished", resolve); gif.render(); });
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("could not read the encoded GIF"));
    r.readAsDataURL(blob);
  });
  return { ok: true, gif: dataUrl, frames: frames.length, width: W, height: H };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.kind !== "GENERATE_GIF") return false;
  generateGif(msg).then(respond, (e) => respond({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
