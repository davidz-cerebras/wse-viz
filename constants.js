// Grid dimensions
export const GRID_ROWS = 32;
export const GRID_COLS = 32;
export const CELL_SIZE = 20;
export const GAP = 6;

// Ramp layout
export const RAMP_DEPTH = 7;         // packet dot position: distance from PE center
export const RAMP_ARROW_DEPTH = 10;  // arrow indicator: distance from PE center
export const RAMP_LATERAL = 4;       // packet dot: perpendicular offset separating on/off ramps
export const RAMP_ARROW_LATERAL = 4; // arrow indicator: perpendicular offset
export const RAMP_ARROW_SIZE = 2.5;  // triangle size for ramp direction indicators

// Packet animation timing
export const HOP_DELAY = 100;
export const STEP_DELAY = 150; // delay between animation phases in demo algorithms

// Packet appearance
export const PACKET_RADIUS = 3;
export const PACKET_HALO_RADIUS = 5; // glow ring around packet dot
export const PACKET_COLOR = "rgb(255, 193, 7)";         // data wavelet: amber/gold
export const PACKET_CTRL_COLOR = "rgb(255, 130, 180)";  // control wavelet: pink
export const PACKET_HALO_COLOR = "rgba(255, 200, 35, 0.3)";       // data wavelet halo
export const PACKET_CTRL_HALO_COLOR = "rgba(255, 150, 190, 0.3)"; // control wavelet halo: pinkish
export const PACKET_LF_HALO_COLOR = "rgba(100, 181, 246, 0.5)";   // last-in-flight halo: blue

// PE timing
export const PE_ON_DURATION = 200;
export const PE_BRIGHTEN_DURATION = 25;
export const PE_DIM_DURATION = 500;
export const PE_BRIGHTNESS_THRESHOLD = 0.5;

// Replay tuning
export const MAX_LOG_ENTRIES = 500;
export const PE_TRACE_WINDOW = 500; // max DOM entries rendered at once
