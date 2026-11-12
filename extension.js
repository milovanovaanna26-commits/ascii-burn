import Cairo from 'cairo';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {BurnSim, PALETTE, easeBurn} from './burn.js';

// ---- Settings -------------------------------------------------------------
const FPS = 30;
const BURN_MS_MIN = 1100;         // the burn line's climb, scaled with window height
const BURN_MS_MAX = 1900;
const BURN_MS_PER_ROW = 22;
const TAIL_MS = 1200;             // max time the flames may linger after the window is gone
const CELL_W = 11;                // px; replaced by the font's real advance when measurable
const CELL_H = 20;                // px
const FONT_FAMILY = 'Monospace';  // same font as the ASCII Fire wallpaper
const FONT_SIZE = 18;             // px
const SOOT_ROWS = 3.0;            // rows above the burn line that turn blocky and dark
const SIM_OPTIONS = {};           // overrides for burn.js DEFAULTS (flameRows, jagRows, ...)

const BURN_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];
// ---------------------------------------------------------------------------

// Cuts the window away below the burn line and chars the strip just above it.
// noiseCol() must match burn.js.
const DECLARATIONS = `
uniform sampler2D uTexture;
uniform vec2 uSize;
uniform vec4 uFrame;
uniform vec2 uCell;
uniform vec3 uSeed;
uniform float uProgress;
uniform float uRows;
uniform float uJag;
uniform float uSoot;

float noiseCol(float c) {
    return 0.5 +
        0.25 * sin(c * 0.31 + uSeed.x) +
        0.15 * sin(c * 0.77 + uSeed.y) +
        0.10 * sin(c * 1.93 + uSeed.z);
}

vec4 straight(vec4 c) {
    if (c.a > 0.0)
        c.rgb /= c.a;
    return c;
}
`;

const MAIN = `
vec2 uv = cogl_tex_coord_in[0].st;
vec2 px = uv * uSize;
float bottom = uFrame.y + uFrame.w;
float c = floor(clamp(px.x - uFrame.x, 0.0, uFrame.z - 0.5) / uCell.x);
float k = (bottom - px.y) / uCell.y;
float e = floor(uProgress * (uRows + uJag) - uJag * (noiseCol(c) - 0.5));
float d = k - e;
vec4 col;
if (e > 0.0 && d < 0.0) {
    col = vec4(0.0);
} else if (e > 0.0 && d < uSoot) {
    // Blocky and scorched: one color per cell, darker and hotter near the line.
    vec2 center = vec2(uFrame.x + (c + 0.5) * uCell.x, bottom - (floor(k) + 0.5) * uCell.y);
    col = straight(texture2D(uTexture, clamp(center / uSize, 0.0, 1.0)));
    float soot = 1.0 - smoothstep(0.0, uSoot, d);
    float glow = 1.0 - smoothstep(0.0, 1.0, d);
    col.rgb *= 1.0 - 0.8 * soot;
    col.rgb = mix(col.rgb, vec3(1.0, 0.42, 0.09), glow * 0.8);
} else {
    col = straight(texture2D(uTexture, uv));
}
cogl_color_out = col;
`;

const BurnEffect = Shell.GLSLEffect ? GObject.registerClass(
class AsciiBurnEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this.progress = 0;
        this._loc = {};
        for (const name of ['uSize', 'uFrame', 'uCell', 'uSeed', 'uProgress', 'uRows', 'uJag', 'uSoot'])
            this._loc[name] = this.get_uniform_location(name);
    }

    vfunc_build_pipeline() {
        const hook = Cogl.SnippetHook ? Cogl.SnippetHook.FRAGMENT : Shell.SnippetHook.FRAGMENT;
        this.add_glsl_snippet(hook, DECLARATIONS, MAIN, true);
    }

    setup(actor, frame, cell, sim) {
        const set = (name, values) => this.set_uniform_float(this._loc[name], values.length, values);
        set('uSize', [actor.width, actor.height]);
        set('uFrame', frame);
        set('uCell', cell);
        set('uSeed', sim.seed);
        set('uRows', [sim.frameRows]);
        set('uJag', [sim.jag]);
        set('uSoot', [SOOT_ROWS]);
    }

    vfunc_paint_target(...params) {
        // Since GNOME 44.2 the alpha channel is not written by default.
        this.get_pipeline().set_blend('RGBA = ADD (SRC_COLOR * (SRC_COLOR[A]), DST_COLOR * (1-SRC_COLOR[A]))');
        this.set_uniform_float(this._loc.uProgress, 1, [this.progress]);
        super.vfunc_paint_target(...params);
    }
}) : null;

export default class AsciiBurnExtension extends Extension {
    enable() {
        this._burns = new Set();
        this._cellW = this._measureCell();

        const ext = this;
        this._origShouldAnimateActor = Main.wm._shouldAnimateActor;
        // _destroyWindow() asks _shouldAnimateActor() right before it eases the actor
        // out. When it does, we take over that one ease() call with our own animation.
        // The original check still decides, so disabled animations stay disabled.
        Main.wm._shouldAnimateActor = function (actor, types) {
            const animate = ext._origShouldAnimateActor.call(this, actor, types);
            if (animate && ext._wantsBurn(actor) && new Error().stack.includes('_destroyWindow@')) {
                const orig = actor.ease;
                actor.ease = function (...params) {
                    actor.ease = orig;
                    if (new Error().stack.includes('_destroyWindow@'))
                        ext._startBurn(actor);
                    else
                        orig.apply(this, params);
                };
            }
            return animate;
        };

        this._killId = global.window_manager.connect('kill-window-effects', (wm, actor) => {
            for (const b of this._burns) {
                if (b.actor === actor)
                    this._finishWindow(b);
            }
        });
    }

    disable() {
        Main.wm._shouldAnimateActor = this._origShouldAnimateActor;
        this._origShouldAnimateActor = null;
        if (this._killId) {
            global.window_manager.disconnect(this._killId);
            this._killId = 0;
        }
        for (const b of [...this._burns])
            this._endBurn(b);
        this._burns = null;
    }

    _wantsBurn(actor) {
        const w = actor.meta_window;
        return w && BURN_TYPES.includes(w.get_window_type()) && actor.width > 40 && actor.height > 40;
    }

    _startBurn(actor) {
        const b = {actor, windowDone: false};
        this._burns.add(b);
        b.destroyId = actor.connect('destroy', () => {
            b.destroyId = 0;
            b.actorGone = true;
            this._finishWindow(b);
        });
        try {
            const rect = actor.meta_window.get_frame_rect();
            const cw = this._cellW;
            const cols = Math.ceil(rect.width / cw);
            const frameRows = Math.ceil(rect.height / CELL_H);
            b.sim = new BurnSim(cols, frameRows, SIM_OPTIONS);
            b.burnMs = Math.min(BURN_MS_MAX, Math.max(BURN_MS_MIN, frameRows * BURN_MS_PER_ROW));

            // Flames over the window and the headroom above it, bottoms aligned.
            const h = b.sim.rows * CELL_H;
            b.area = new St.DrawingArea({reactive: false});
            b.area.set_position(rect.x, rect.y + rect.height - h);
            b.area.set_size(cols * cw, h);
            b.area.connect('repaint', a => this._repaint(a, b));
            global.window_group.insert_child_above(b.area, actor);

            const frame = [rect.x - actor.x, rect.y - actor.y, rect.width, rect.height];
            if (BurnEffect) {
                b.effect = new BurnEffect();
                b.effect.setup(actor, frame, [cw, CELL_H], b.sim);
                actor.add_effect_with_name('ascii-burn', b.effect);
            }
            b.frame = frame;
            global.compositor?.disable_unredirect?.();
            b.unredirect = true;
        } catch (e) {
            console.error(`[ascii-burn] could not start: ${e}`);
            this._endBurn(b);
            return;
        }

        b.startUs = b.lastUs = GLib.get_monotonic_time();
        b.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(1000 / FPS), () => this._tick(b));
    }

    _tick(b) {
        try {
            const now = GLib.get_monotonic_time();
            const dt = Math.min(0.1, (now - b.lastUs) / 1e6);
            b.lastUs = now;
            const t = (now - b.startUs) / 1000;
            const progress = easeBurn(t / b.burnMs);
            b.sim.step(dt, progress);

            if (!b.windowDone) {
                if (b.effect) {
                    b.effect.progress = progress;
                    b.effect.queue_repaint();
                } else {
                    this._clipFallback(b, progress);
                }
                if (b.sim.done)
                    this._finishWindow(b);
            }
            b.area.queue_repaint();

            if (b.sim.dead || t > b.burnMs + TAIL_MS) {
                b.timer = 0;
                this._endBurn(b);
                return GLib.SOURCE_REMOVE;
            }
        } catch (e) {
            console.error(`[ascii-burn] tick failed: ${e}`);
            b.timer = 0;
            this._endBurn(b);
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    // Without Shell.GLSLEffect: a straight cut from the bottom.
    _clipFallback(b, progress) {
        const [fx, fy, fw, fh] = b.frame;
        const top = fy + fh * (1 - progress);
        b.actor.set_clip(0, 0, b.actor.width, Math.max(0, top));
    }

    // The window itself is gone; its flames may keep burning out on their own.
    _finishWindow(b) {
        if (b.windowDone)
            return;
        b.windowDone = true;
        const actor = b.actor;
        b.actor = null;
        if (b.destroyId) {
            actor.disconnect(b.destroyId);
            b.destroyId = 0;
        }
        if (!b.actorGone) {
            try {
                if (b.effect)
                    actor.remove_effect(b.effect);
                actor.remove_clip();
            } catch (e) {
                console.warn(`[ascii-burn] cleanup failed: ${e}`);
            }
        }
        b.effect = null;
        if (b.unredirect) {
            b.unredirect = false;
            global.compositor?.enable_unredirect?.();
        }
        if (!b.actorGone)
            Main.wm._destroyWindowDone(global.window_manager, actor);
    }

    _endBurn(b) {
        if (b.timer) {
            GLib.source_remove(b.timer);
            b.timer = 0;
        }
        if (b.actor)
            this._finishWindow(b);
        b.area?.destroy();
        b.area = null;
        this._burns?.delete(b);
    }

    _repaint(area, b) {
        const cr = area.get_context();
        try {
            if (!b.sim)
                return;
            cr.selectFontFace(FONT_FAMILY, Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(FONT_SIZE);
            const cw = this._cellW;
            const baseline = CELL_H * 0.8;
            const buckets = b.sim.collect();
            for (let c = 0; c < buckets.length; c++) {
                const runs = buckets[c];
                if (!runs.length)
                    continue;
                const [r, g, bl] = PALETTE[c];
                cr.setSourceRGB(r / 255, g / 255, bl / 255);
                for (const [x, y, text] of runs) {
                    cr.moveTo(x * cw, y * CELL_H + baseline);
                    cr.showText(text);
                }
            }
        } catch (e) {
            console.error(`[ascii-burn] repaint failed: ${e}`);
        } finally {
            cr.$dispose();
        }
    }

    // Runs are drawn as whole strings, so the cell width must equal the glyph advance.
    _measureCell() {
        try {
            const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
            const cr = new Cairo.Context(surface);
            cr.selectFontFace(FONT_FAMILY, Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(FONT_SIZE);
            const adv = cr.textExtents('M').xAdvance;
            cr.$dispose();
            surface.finish();
            if (adv > 2)
                return adv;
        } catch (e) {
            console.warn(`[ascii-burn] font measure failed, using CELL_W: ${e}`);
        }
        return CELL_W;
    }
}
