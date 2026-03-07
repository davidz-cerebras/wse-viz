import {
  PACKET_RADIUS_DISC, PACKET_RADIUS_HALO,
  PACKET_COLOR_DISC_DATA, PACKET_COLOR_DISC_CTRL,
  PACKET_COLOR_HALO_DATA, PACKET_COLOR_HALO_CTRL, PACKET_COLOR_HALO_LF,
  PACKET_COLOR_LABEL_DATA, PACKET_COLOR_LABEL_CTRL,
} from "./constants.js";

// Pre-rendered color label bitmaps for colors 0-31 × ctrl flag.
// Rendered at device resolution; cache cleared when scale changes.
let _labelCache = new Map();
let _labelScale = 0;

/** Called from app.js after resizeCanvas to update the rendering scale. */
export function setLabelBitmapScale(scale) {
  if (scale === _labelScale) return;
  _labelScale = scale;
  _labelCache.clear();
}

function _getLabelBitmap(color, ctrl) {
  const key = (ctrl ? 32 : 0) + color;
  let entry = _labelCache.get(key);
  if (entry) return entry;

  const label = String(color);
  const fontSize = 4; // colors 0-31 are always 1-2 digits; font always 4
  const s = _labelScale || 1;
  const logW = fontSize * label.length * 0.8 + 2;
  const logH = fontSize + 2;
  const w = Math.max(1, Math.ceil(logW * s));
  const h = Math.max(1, Math.ceil(logH * s));

  const c = new OffscreenCanvas(w, h);
  const cx = c.getContext("2d");
  cx.scale(s, s);
  cx.font = `${fontSize}px monospace`;
  cx.fillStyle = ctrl ? PACKET_COLOR_LABEL_CTRL : PACKET_COLOR_LABEL_DATA;
  cx.textAlign = "center";
  cx.textBaseline = "middle";
  cx.fillText(label, logW / 2, logH / 2 + fontSize * 0.09);

  entry = { bitmap: c, w: logW, h: logH };
  _labelCache.set(key, entry);
  return entry;
}

// "color" is a fabric routing tag (an integer), not a visual color.
// It is rendered as a small numeric label inside the dot.
// "ctrl" = control wavelet (pink), "lf" = last-in-flight (blue halo).
export function drawPacketDot(ctx, x, y, color, ctrl, lf) {
  ctx.beginPath();
  ctx.arc(x, y, PACKET_RADIUS_DISC, 0, Math.PI * 2);
  ctx.fillStyle = ctrl ? PACKET_COLOR_DISC_CTRL : PACKET_COLOR_DISC_DATA;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, PACKET_RADIUS_HALO, 0, Math.PI * 2);
  ctx.strokeStyle = lf ? PACKET_COLOR_HALO_LF : (ctrl ? PACKET_COLOR_HALO_CTRL : PACKET_COLOR_HALO_DATA);
  ctx.lineWidth = 2;
  ctx.stroke();

  if (color != null) {
    const lb = _getLabelBitmap(color, ctrl);
    ctx.drawImage(lb.bitmap, x - lb.w / 2, y - lb.h / 2, lb.w, lb.h);
  }
}
