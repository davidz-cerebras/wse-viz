# Cerebras Wafer-Scale Engine Visualizer

An interactive web application for visualizing the Cerebras Wafer-Scale Engine (WSE), a large 2D grid of processing elements (PEs).

## Features

- **2D Grid Visualization**: Displays PEs as squares in a configurable grid
- **Computation Highlighting**: PEs light up when performing local computation
- **Data Transfer Animation**: Glowing dots show data movement between adjacent PEs
- **Interactive Controls**: Start, stop, and reset the simulation
- **Real-time Statistics**: Track active PEs and data transfers

## Architecture

The application is built with vanilla JavaScript using ES6 modules:

- `pe.js` - Processing Element class representing individual PEs
- `packet.js` - Data packet class for animating data transfers
- `grid.js` - Grid management and PE coordination
- `animation.js` - Animation loop for smooth rendering
- `app.js` - Main application logic and event handling

## Running the Application

Simply open `index.html` in a modern web browser. No build process or dependencies required.

For local development with live reload:

```bash
# Using Python 3
python -m http.server 8000

# Using Node.js http-server
npx http-server
```

Then navigate to `http://localhost:8000`

## Customization

You can adjust the grid size and appearance in `app.js`:

```javascript
const GRID_ROWS = 20; // Number of rows
const GRID_COLS = 30; // Number of columns
const CELL_SIZE = 20; // Size of each PE in pixels
const GAP = 4; // Gap between PEs
```

## Future Enhancements

- Configurable communication patterns
- Custom computation sequences
- Performance metrics and timing visualization
- Interactive PE selection and inspection
- Zoom and pan controls for larger grids
