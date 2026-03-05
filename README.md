# Cerebras Wafer-Scale Engine Visualizer

![wse-viz video usage demonstration](https://github.com/user-attachments/assets/d944d55f-e2fa-4514-90a5-ff2b5a176d89)

🏆 _Winner of the [Cerebras Code CLI](https://github.com/kevint-cerebras/cerebras-code-cli) internal hackathon!_

**wse-viz** is an interactive visualizer for algorithms running on the [Cerebras Wafer-Scale Engine (WSE)](https://www.cerebras.ai/chip), the largest and fastest computer processor in the world.

**wse-viz** includes pre-baked visualizations of mathematical algorithms (AllReduce/SpMV/Conjugate Gradient) and can also visualize execution traces produced by the [Cerebras SDK](https://sdk.cerebras.net).

## Usage

**wse-viz** is written entirely in plain JavaScript with no external dependencies. No build process is required. Simply clone this repository and open a web server:

```bash
git clone https://github.com/davidz-cerebras/wse-viz.git
cd wse-viz
python3 -m http.server 8000
```

Then, open a browser and navigate to `http://localhost:8000`.

### Controls

 - Press `space` to start or stop playback, and use the `[` and `]` keys to adjust playback speed.
 - Click on a tile in the grid to examine its execution pipeline. Click again (or click on empty space) to deselect.
