// ASCII fire that eats a window from the bottom up. No GNOME imports: runs in Node and GJS.
//
// The window is a grid of cells. A ragged burn line climbs from its bottom edge; the
// shader cuts away everything below the line, and this sim draws the flames rising
// from it. Glyphs and colors match the ASCII Fire wallpaper (ascii-fire@local).

export const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';

// Fire: dark red -> white with a yellow tint.
export const PALETTE = [
    [0x5a, 0x0d, 0x08],
    [0x9a, 0x1a, 0x0c],
    [0xd0, 0x36, 0x10],
    [0xf2, 0x6a, 0x16],
    [0xff, 0x9c, 0x2e],
    [0xff, 0xd2, 0x6a],
    [0xff, 0xf6, 0xd8],
];

const SPARK_CHARS = ['.', '\'', '*', '+'];

export const DEFAULTS = {
    flameRows: 12,            // typical tongue height, rows
    headroomRows: 14,         // rows above the window the flames may reach
    jagRows: 5,               // how ragged the burn line is, rows
    minHeat: 0.05,            // below this a cell is empty
    cool: 0.90,               // per-step cooling of every cell
    burnedCool: 0.7,          // extra per-step cooling below the burn line
    emberRate: 0.005,         // chance per step that a burned cell flares up again
    sparkRate: 14,            // sparks per second along the burn line
    sparkLife: 1.0,           // s
};

// Burn line shape per column, 0..1. Must stay identical to noiseCol() in the shader.
export function noiseCol(c, seed) {
    return 0.5 +
        0.25 * Math.sin(c * 0.31 + seed[0]) +
        0.15 * Math.sin(c * 0.77 + seed[1]) +
        0.10 * Math.sin(c * 1.93 + seed[2]);
}

// Animation time 0..1 -> burn line progress: catches gently, then races up.
export function easeBurn(t) {
    t = Math.min(1, Math.max(0, t));
    return t * (0.55 + 0.45 * t);
}

export class BurnSim {
    // cols: window width in cells; frameRows: window height in cells.
    constructor(cols, frameRows, opts = {}, rng = Math.random) {
        this.opts = {...DEFAULTS, ...opts};
        this.rng = rng;
        this.cols = Math.max(1, cols | 0);
        this.frameRows = Math.max(1, frameRows | 0);
        this.jag = Math.min(this.opts.jagRows, Math.max(1, Math.floor(this.frameRows / 3)));
        this.rows = this.frameRows + this.opts.headroomRows;
        this.heat = new Float32Array(this.cols * this.rows);
        this.seed = [rng() * 6.283, rng() * 6.283, rng() * 6.283];
        this.progress = 0;
        this.sparks = [];
        this._sparkAcc = 0;
    }

    // Burned cells in column c, counted from the window's bottom edge.
    edge(c) {
        return Math.floor(this.progress * (this.frameRows + this.jag) - this.jag * (noiseCol(c, this.seed) - 0.5));
    }

    get done() {
        return this.progress >= 1;
    }

    step(dt, progress) {
        this.progress = progress;
        const {cols, rows, heat, rng, opts} = this;
        const meanDecay = 1 / opts.flameRows;

        // Sources: the line where the window is burning, plus embers flaring up below it.
        for (let x = 0; x < cols; x++) {
            const e = this.edge(x);
            if (e <= 0)
                continue;
            const burning = e <= this.frameRows;
            if (burning) {
                const r = rows - e;            // the cell that just burned
                heat[r * cols + x] = 0.85 + 0.15 * rng();
                if (r + 1 < rows)
                    heat[(r + 1) * cols + x] = Math.max(heat[(r + 1) * cols + x], 0.6 + 0.2 * rng());
            }
            // Burned-out cells below the line go dark fast; a few embers flare up there.
            const lowest = rows - Math.min(e, this.frameRows);
            for (let r = lowest + 2; r < rows; r++) {
                heat[r * cols + x] *= opts.burnedCool;
                if (!this.done && rng() < opts.emberRate)
                    heat[r * cols + x] = Math.max(heat[r * cols + x], 0.25 + 0.2 * rng());
            }
        }

        // Propagate up: each cell copies from below, cooled and shifted sideways.
        for (let y = 1; y < rows; y++) {
            const row = y * cols;
            const up = row - cols;
            for (let x = 0; x < cols; x++) {
                const v = heat[row + x];
                if (v <= 0)
                    continue;
                const shift = (rng() * 3) | 0;
                let dx = x - shift + 1;
                if (dx < 0 || dx >= cols)
                    dx = x;
                const decay = rng() < 0.4 ? 0 : rng() * 2.6 * meanDecay;
                heat[up + dx] = Math.max(heat[up + dx] * 0.5, v - decay);
            }
        }
        for (let i = 0; i < heat.length; i++)
            heat[i] *= opts.cool;

        this._stepSparks(dt);
    }

    _stepSparks(dt) {
        const {opts, rng, cols, rows} = this;
        if (!this.done) {
            this._sparkAcc += dt * opts.sparkRate * Math.max(1, cols / 60);
            while (this._sparkAcc >= 1) {
                this._sparkAcc -= 1;
                const x = Math.floor(rng() * cols);
                const e = this.edge(x);
                if (e <= 0 || e > this.frameRows)
                    continue;
                this.sparks.push({
                    x, y: rows - e - 1,
                    vx: (rng() - 0.5) * 3,
                    vy: -(5 + rng() * 9),
                    life: opts.sparkLife * (0.5 + rng() * 0.5),
                    age: 0,
                });
            }
        }
        for (const s of this.sparks) {
            s.age += dt;
            s.x += s.vx * dt + (rng() - 0.5) * 0.3;
            s.y += s.vy * dt;
        }
        this.sparks = this.sparks.filter(s => s.age < s.life && s.y >= 0 && s.y < rows && s.x >= 0 && s.x < cols);
    }

    // True once nothing is left to draw.
    get dead() {
        if (!this.done || this.sparks.length)
            return false;
        const min = this.opts.minHeat;
        return !this.heat.some(v => v > min);
    }

    /**
     * Visible cells grouped by color index, so the renderer sets each color once.
     * Returns PALETTE.length arrays of runs [col, row, text] with contiguous chars.
     */
    collect() {
        const {cols, rows, heat, rng, opts} = this;
        const buckets = PALETTE.map(() => []);
        const nC = PALETTE.length;
        const nR = RAMP.length;
        for (let y = 0; y < rows; y++) {
            const row = y * cols;
            let runColor = -1, runStart = 0, runText = '';
            for (let x = 0; x <= cols; x++) {
                let c = -1, ch = '';
                if (x < cols) {
                    const v = heat[row + x];
                    if (v > opts.minHeat) {
                        // Jitter both lookups so the glyphs flicker every frame.
                        const j = v + (rng() - 0.5) * 0.08;
                        const ri = Math.min(nR - 1, Math.max(1, Math.floor(Math.pow(j, 0.65) * nR)));
                        ch = RAMP[ri];
                        c = Math.min(nC - 1, Math.max(0, Math.floor(Math.pow(j, 0.6) * nC * 1.08)));
                    }
                }
                if (c !== runColor) {
                    if (runColor >= 0)
                        buckets[runColor].push([runStart, y, runText]);
                    runColor = c;
                    runStart = x;
                    runText = '';
                }
                runText += ch;
            }
        }
        for (const s of this.sparks) {
            const k = 1 - s.age / s.life;
            const ch = SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.floor(k * SPARK_CHARS.length))];
            const c = Math.min(nC - 1, Math.floor(k * 5) + 1);
            buckets[c].push([Math.round(s.x), Math.round(s.y), ch]);
        }
        return buckets;
    }

    // Plain-text frame for debugging; '#' marks cells of the window still standing.
    toText() {
        const lines = Array.from({length: this.rows}, () => new Array(this.cols).fill(' '));
        for (let x = 0; x < this.cols; x++) {
            const e = Math.max(0, this.edge(x));
            for (let k = e; k < this.frameRows; k++)
                lines[this.rows - 1 - k][x] = '#';
        }
        for (const bucket of this.collect()) {
            for (const [x, y, text] of bucket) {
                for (let i = 0; i < text.length; i++) {
                    if (lines[y] && x + i < this.cols)
                        lines[y][x + i] = text[i];
                }
            }
        }
        return lines.map(l => l.join('')).join('\n');
    }
}
