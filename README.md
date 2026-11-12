# ASCII Burn

A GNOME Shell extension: closing windows burn away from the bottom up in ASCII fire.

A ragged burn line climbs the window cell by cell. Just above it the window turns
into scorched, glowing blocks, and flames made of text glyphs rise from the line,
throwing sparks. Glyphs and colors match the ASCII Fire live wallpaper.

## Requirements

- GNOME Shell 50

## Install

```bash
git clone https://github.com/milovanovaanna26-commits/ascii-burn.git \
    ~/.local/share/gnome-shell/extensions/ascii-burn@local
gnome-extensions enable ascii-burn@local
```

On Wayland, log out and back in first so GNOME Shell picks up the new extension.

Don't use it together with other window-close effect extensions such as Burn My Windows.

## Tuning

The settings are constants at the top of the files:

- `extension.js`: burn duration, font, cell size, height of the scorched strip.
- `burn.js` (`DEFAULTS`): flame height, how ragged the burn line is, embers, sparks.

`burn.js` has no GNOME imports, so you can try the fire in plain `gjs` and print it
as text with `BurnSim.toText()`.

## Notes

- Only normal windows and dialogs burn. In the Activities overview, windows close with
  the stock animation.
- If animations are turned off in the system settings, the effect is off too.
