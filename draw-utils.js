import {
  PACKET_RADIUS, PACKET_HALO_RADIUS,
  PACKET_COLOR, PACKET_CTRL_COLOR,
  PACKET_HALO_COLOR, PACKET_CTRL_HALO_COLOR, PACKET_LF_HALO_COLOR,
} from "./constants.js";

// "color" is a fabric routing tag (an integer), not a visual color.
// It is rendered as a small numeric label inside the dot.
// "ctrl" = control wavelet (pink), "lf" = last-in-flight (blue halo).
export function drawPacketDot(ctx, x, y, color, ctrl, lf) {
  ctx.beginPath();
  ctx.arc(x, y, PACKET_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = ctrl ? PACKET_CTRL_COLOR : PACKET_COLOR;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, PACKET_HALO_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = lf ? PACKET_LF_HALO_COLOR : (ctrl ? PACKET_CTRL_HALO_COLOR : PACKET_HALO_COLOR);
  ctx.lineWidth = 2;
  ctx.stroke();

  if (color != null) {
    const label = String(color);
    const fontSize = Math.min(4, 8 / label.length);
    ctx.font = `${fontSize}px monospace`;
    ctx.fillStyle = ctrl ? "rgba(120, 50, 80, 0.9)" : "rgba(140, 110, 20, 0.9)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + fontSize * 0.09);
  }
}
