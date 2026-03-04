// Grid dimensions
export const GRID_ROWS = 32;
export const GRID_COLS = 32;
export const CELL_SIZE = 20;
export const GAP = 8;

// Ramp layout
export const RAMP_DEPTH = 10;       // packet position: distance from PE center
export const RAMP_ARROW_DEPTH = 11; // arrow indicator position: further out than packets
export const RAMP_LATERAL = 4;      // perpendicular offset separating on/off ramps
export const RAMP_ARROW_SIZE = 2.5; // triangle size for ramp direction indicators

// Packet animation timing
export const HOP_DELAY = 100;
export const STEP_DELAY = 150; // delay between animation phases in demo algorithms

// Packet appearance
export const PACKET_RADIUS = 4;
export const PACKET_COLOR = "rgb(255, 193, 7)";
export const PACKET_HALO_COLOR = "rgba(255, 193, 7, 0.5)";

// PE timing
export const PE_ON_DURATION = 200;
export const PE_BRIGHTEN_DURATION = 25;
export const PE_DIM_DURATION = 500;
export const PE_BRIGHTNESS_THRESHOLD = 0.5;

// Replay tuning
export const PREFETCH_SIZE = 100;
export const MAX_PREFETCH_BYTES = 2 * 1024 * 1024; // 2MB cap per prefetch
export const MAX_LOG_ENTRIES = 500;
export const PE_TRACE_WINDOW = 500; // max DOM entries rendered at once
