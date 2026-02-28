import { PACKET_RADIUS, PACKET_COLOR, PACKET_HALO_COLOR } from "./constants.js";

export function drawPacketDot(ctx, x, y) {
  ctx.beginPath();
  ctx.arc(x, y, PACKET_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = PACKET_COLOR;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, PACKET_RADIUS + 2, 0, Math.PI * 2);
  ctx.strokeStyle = PACKET_HALO_COLOR;
  ctx.lineWidth = 2;
  ctx.stroke();
}
