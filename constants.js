export const CELL_SIZE = 20;
export const GAP_SIZE = 6;

// Ramp layout
export const RAMP_DEPTH = 7;   // packet position: distance from PE center
export const RAMP_LATERAL = 4; // perpendicular offset separating on/off ramps
export const ARROW_DEPTH = 10; // arrow indicator: distance from PE center
export const ARROW_SIZE = 2.5; // triangle size for ramp direction indicators

// Packet appearance
export const PACKET_RADIUS_DISC = 3;
export const PACKET_RADIUS_HALO = 5;
export const PACKET_COLOR_DISC_DATA = "rgb(255, 193, 7)";   // amber/gold
export const PACKET_COLOR_DISC_CTRL = "rgb(255, 130, 180)"; // pink
export const PACKET_COLOR_HALO_DATA = "rgba(255, 200, 35, 0.3)";
export const PACKET_COLOR_HALO_CTRL = "rgba(255, 150, 190, 0.3)";
export const PACKET_COLOR_HALO_LF = "rgba(100, 181, 246, 0.5)"; // last-in-flight: blue
export const PACKET_COLOR_LABEL_DATA = "rgba(140, 110, 20, 0.9)";
export const PACKET_COLOR_LABEL_CTRL = "rgba(120, 50, 80, 0.9)";

// PE tile colors
export const PE_COLOR_IDLE = "rgba(45, 58, 90, 0.3)";          // dark blue
export const PE_COLOR_EXEC = "rgb(100, 181, 246)";             // bright blue
export const PE_COLOR_FP_ARITH = "rgb(50, 185, 75)";           // deep green
export const PE_COLOR_INT_ARITH = "rgb(150, 220, 50)";         // yellow-green
export const PE_COLOR_CTRL = "rgb(240, 240, 170)";             // cool light yellow
export const PE_COLOR_TASK = "rgb(180, 180, 190)";             // light grey
export const PE_COLOR_MEM_READ = "rgb(230, 140, 190)";          // pink-lavender
export const PE_COLOR_MEM_WRITE = "rgb(245, 170, 115)";         // reddish-orange
export const PE_COLOR_STALL_WAVELET = "rgba(74, 25, 98, 0.5)"; // purple tint
export const PE_COLOR_STALL_PIPE = "rgba(95, 38, 25, 0.5)";    // reddish-brown tint
export const PE_SELECT_COLOR = "#ff9800";                      // selection border

// PE text colors
export const PE_TEXT_DEFAULT = "white";
export const PE_TEXT_DEFAULT_SUB = "rgba(255, 255, 255, 0.85)";
export const PE_TEXT_CTRL = "rgb(190, 120, 20)"; // orange-amber
export const PE_TEXT_CTRL_SUB = "rgba(190, 120, 20, 0.7)";
export const PE_TEXT_TASK = "rgb(70, 70, 80)"; // dark grey
export const PE_TEXT_TASK_SUB = "rgba(70, 70, 80, 0.7)";
export const PE_STALL_TEXT_WAVELET = "rgba(200, 180, 220, 0.7)"; // lavender label
export const PE_STALL_TEXT_PIPE = "rgba(230, 200, 150, 0.7)"; // light orange label

// Grid overlay colors
export const ZOOM_PREVIEW_COLOR = "rgba(255, 152, 0, 0.3)";
export const CORNER_LABEL_COLOR = "rgba(180, 190, 210, 0.6)";
export const RAMP_ON_ACTIVE = "rgba(100, 181, 246, 0.9)";
export const RAMP_ON_INACTIVE = "rgba(100, 181, 246, 0.15)";
export const RAMP_OFF_ACTIVE = "rgba(255, 152, 0, 0.9)";
export const RAMP_OFF_INACTIVE = "rgba(255, 152, 0, 0.15)";

// Demo timing (used by pe.js, packet.js, and demo.js)
export const DEMO_HOP_DELAY = 100;
export const DEMO_STEP_DELAY = 150;
export const DEMO_PE_ON_DURATION = 200;
export const DEMO_PE_BRIGHTEN_DURATION = 25;
export const DEMO_PE_DIM_DURATION = 500;

// Replay tuning
export const PE_TRACE_WINDOW = 500; // max DOM entries rendered at once
export const STEP_ANIMATION_MS = 1000 / 16; // duration of single-step wavelet animation

// Server mode tuning
export const SERVER_PREFETCH_AHEAD = 5000;  // cycles to prefetch ahead of playback cursor
export const SERVER_CACHE_MAX = 20000;     // max cached cycles before eviction (~1-2GB)
export const SERVER_MAX_PREFETCH_INFLIGHT = 8; // max concurrent prefetch requests
