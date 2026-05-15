/**
 * Minimal ANSI truecolor utilities.
 * Requires a terminal with COLORTERM=truecolor (Windows Terminal, iTerm2,
 * Alacritty, kitty, WezTerm, and most modern terminal emulators).
 * Respects the NO_COLOR env var — callers can check `useColor` before rendering.
 */

const E = '\x1b'

export const useColor =
  !process.env['NO_COLOR'] &&
  process.stdout.isTTY !== false

export const RESET = `${E}[0m`

/** Set 24-bit foreground colour. */
export const fg = (r: number, g: number, b: number): string =>
  `${E}[38;2;${r};${g};${b}m`

/** Set 24-bit background colour. */
export const bg = (r: number, g: number, b: number): string =>
  `${E}[48;2;${r};${g};${b}m`

/** Visible length of a string, stripping all ANSI escape sequences. */
export const vlen = (s: string): number =>
  s.replace(/\x1b\[[0-9;]*m/g, '').length

/** Right-pad a (possibly ANSI-coded) string to `w` visible characters. */
export const padR = (s: string, w: number): string =>
  s + ' '.repeat(Math.max(0, w - vlen(s)))

/** Left-pad a (possibly ANSI-coded) string to `w` visible characters. */
export const padL = (s: string, w: number): string =>
  ' '.repeat(Math.max(0, w - vlen(s))) + s

/** Linearly interpolate two RGB values. */
export const lerpRGB = (
  a: RGB, b: RGB, t: number,
): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
]

export type RGB = readonly [number, number, number]

/** Shared colour palette (GitHub dark-inspired green accent scheme). */
export const C = {
  textPrimary : [201, 209, 217] as RGB,   // #c9d1d9
  textBright  : [240, 246, 252] as RGB,   // #f0f6fc
  textMuted   : [125, 133, 144] as RGB,   // #7d8590
  textDim     : [ 72,  79,  88] as RGB,   // #484f58
  bgTile      : [ 22,  27,  34] as RGB,   // #161b22 — empty heatmap cell
  track       : [ 28,  35,  41] as RGB,   // #1c2329 — unfilled bar track
  // Green gradient, dim → bright
  green1      : [ 31,  77,  44] as RGB,   // #1f4d2c
  green2      : [ 46, 160,  67] as RGB,   // #2ea043
  green3      : [ 63, 185,  80] as RGB,   // #3fb950
  green4      : [ 86, 211, 100] as RGB,   // #56d364
  green5      : [126, 231, 135] as RGB,   // #7ee787
  // Accents
  blue        : [ 88, 166, 255] as RGB,   // tokens
  purple      : [188, 140, 255] as RGB,   // project bullet 1
  teal        : [138, 212, 255] as RGB,   // project bullet 2
  red         : [200,  60,  60] as RGB,   // negative delta
} as const
