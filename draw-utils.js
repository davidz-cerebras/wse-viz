import {
  PACKET_RADIUS_DISC, PACKET_RADIUS_HALO,
  PACKET_COLOR_DISC_DATA, PACKET_COLOR_DISC_CTRL,
  PACKET_COLOR_HALO_DATA, PACKET_COLOR_HALO_CTRL, PACKET_COLOR_HALO_LF,
  PACKET_COLOR_LABEL_DATA, PACKET_COLOR_LABEL_CTRL,
} from "./constants.js";

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
    const label = String(color);
    const fontSize = Math.min(4, 8 / label.length);
    ctx.font = `${fontSize}px monospace`;
    ctx.fillStyle = ctrl ? PACKET_COLOR_LABEL_CTRL : PACKET_COLOR_LABEL_DATA;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + fontSize * 0.09);
  }
}
