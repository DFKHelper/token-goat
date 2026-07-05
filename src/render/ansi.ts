/**
 * ANSI 24-bit colour primitives and text-alignment helpers for terminal rendering.
 *
 * Exports:
 * - ``fg`` / ``bg``: Set 24-bit foreground/background colour escape sequences.
 * - ``vlen``: Visible (non-ANSI) length of a string.
 * - ``pad_r`` / ``pad_l``: Pad ANSI-coded strings to a fixed visible width.
 * - ``lerp_rgb``: Linear interpolation between two RGB colours.
 * - ``C``: Shared colour palette (GitHub dark-inspired, green accent).
 * - ``USE_COLOR``: ``True`` when the terminal supports 24-bit colour and
 *   ``NO_COLOR`` is not set. Callers should check this before building
 *   ANSI sequences.
 */

/**
 * Return True when *stream* is a TTY and the ``NO_COLOR`` env-var is unset.
 * Follows the no-color.org convention.
 */
function _colorStream(isatty: boolean): boolean {
  if (process.env['NO_COLOR']) return false
  return isatty
}

/**
 * Return True when stdout supports ANSI colour.
 * Checks both process.stdout.isTTY and the ``NO_COLOR`` env-var per the
 * no-color.org convention. Use for output written to stdout (stats panels, etc.).
 */
export function colorStdout(): boolean {
  return _colorStream(process.stdout.isTTY === true)
}

/**
 * Return True when stderr supports ANSI colour.
 * Same logic as colorStdout but tests process.stderr.isTTY.
 * Use for progress indicators, spinners, and diagnostic output written to stderr.
 */
export function colorStderr(): boolean {
  return _colorStream(process.stderr.isTTY === true)
}

export const USE_COLOR = colorStdout()

export type RGB = [number, number, number]

const _E = '\x1b'
export const RESET = `${_E}[0m`

/**
 * Full VT/ANSI escape sequence pattern — covers CSI (colour, cursor, erase),
 * OSC (title/hyperlink sequences used by pip/docker/cargo progress UIs),
 * DCS/SOS/PM/APC strings, and bare 2-byte ESC sequences.
 *
 * The OSC alternative also accepts end-of-string as a terminator (alongside
 * BEL/ST): a truncated hyperlink/title sequence with no closing BEL/ST —
 * output cut off mid-write, a stream chopped mid-hyperlink — would otherwise
 * never match, leaking the raw, unprintable ESC byte (and the rest of the
 * dangling sequence) straight into the stripped text. DCS/SOS/PM/APC strings
 * intentionally do NOT get the same end-of-string fallback: unlike OSC they
 * can legitimately appear mid-stream with real text still to follow, and
 * treating "no terminator found yet" as "consume to end of string" there
 * would risk swallowing real trailing content; the bare 2-byte fallback
 * below still guarantees no raw ESC byte leaks even when they're truncated,
 * it just leaves any dangling payload text behind as plain text rather than
 * removing it. That bare fallback covers the full Fe escape range (`@`-`_`,
 * 0x40-0x5F) rather than a hand-picked subset that dropped `[`, `]`, and
 * `^`, so any single-character escape not claimed by CSI/OSC/DCS above still
 * gets removed instead of leaking.
 */
// eslint-disable-next-line no-control-regex
const _ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\].*?(?:\x07|\x1B\\|$)|\x1B[PX^_].*?\x1B\\|\x1B[@-_]/gs

/**
 * Unicode Private Use Area regex: strips U+E000–U+F8FF (BMP) and U+F0000–U+FFFDD (supplementary).
 */
const _PUA_RE = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFDD}]/gu

/**
 * Remove all ANSI/VT escape sequences from *s*.
 * Optimized with a fast path for plain text (no ESC byte), and handles:
 * - CSI colour/cursor sequences
 * - OSC hyperlinks and title sequences
 * - DCS/SOS/PM/APC strings
 * - Unicode Private Use Area characters (U+E000–U+F8FF, U+F0000–U+FFFDD)
 */
export function stripAnsi(s: string): string {
  if (!s.includes('\x1b')) {
    return s
  }

  const text = s.replace(_ANSI_ESCAPE_RE, '')
  return text.replace(_PUA_RE, '')
}

/**
 * Format a byte count as a plain-text human-readable string (B/KB/MB/GB/TB/PB).
 * No ANSI codes — safe for use in Rich table cells and fallback renderers.
 */
export function fmtBytes(n: number): string {
  let value = n
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  for (const unit of units) {
    if (Math.abs(value) < 1024) {
      return unit === 'B' ? `${Math.trunc(value)}${unit}` : `${value.toFixed(1)}${unit}`
    }
    value = value / 1024
  }
  return `${value.toFixed(1)}PB`
}

/**
 * Set 24-bit foreground colour.
 */
export function fg(r: number, g: number, b: number): string {
  return `${_E}[38;2;${r};${g};${b}m`
}

/**
 * Set 24-bit background colour.
 */
export function bg(r: number, g: number, b: number): string {
  return `${_E}[48;2;${r};${g};${b}m`
}

/**
 * Visible length of a string, stripping all ANSI escape sequences.
 */
export function vlen(s: string): number {
  return stripAnsi(s).length
}

/**
 * Right-pad a (possibly ANSI-coded) string to `w` visible characters.
 */
export function padR(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - vlen(s)))
}

/**
 * Left-pad a (possibly ANSI-coded) string to `w` visible characters.
 */
export function padL(s: string, w: number): string {
  return ' '.repeat(Math.max(0, w - vlen(s))) + s
}

/**
 * Linearly interpolate two RGB colours.
 */
export function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

/**
 * Shared colour palette (GitHub dark-inspired green accent scheme).
 */
export const C = {
  TEXT_PRIMARY: [201, 209, 217] as RGB,
  TEXT_BRIGHT: [240, 246, 252] as RGB,
  TEXT_MUTED: [125, 133, 144] as RGB,
  TEXT_DIM: [72, 79, 88] as RGB,
  BG_TILE: [22, 27, 34] as RGB,
  TRACK: [28, 35, 41] as RGB,
  GREEN1: [31, 77, 44] as RGB,
  GREEN2: [46, 160, 67] as RGB,
  GREEN3: [63, 185, 80] as RGB,
  GREEN4: [86, 211, 100] as RGB,
  GREEN5: [126, 231, 135] as RGB,
  BLUE: [88, 166, 255] as RGB,
  PURPLE: [188, 140, 255] as RGB,
  TEAL: [138, 212, 255] as RGB,
  ORANGE: [235, 165, 80] as RGB,
  YELLOW: [240, 215, 80] as RGB,
  RED: [200, 60, 60] as RGB,
} as const
