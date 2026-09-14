/**
 * Supported language codes and resolver for Tesseract OCR.
 *
 * English ('eng') is always enabled by default; additional languages are opt-in.
 * Hashes and model download specs live in `ocr_hashes.ts` to keep the eager hook bundle minimal.
 */

export const DEFAULT_OCR_LANG = 'eng' as const

export const SUPPORTED_OCR_LANG_CODES = [
  'eng',
  'fra',
  'spa',
  'deu',
  'ita',
  'por',
  'nld',
  'pol',
  'rus',
  'tur',
  'swe',
  'ara',
  'chi_sim',
  'chi_tra',
  'jpn',
  'kor',
] as const

export type SupportedOcrLang = (typeof SUPPORTED_OCR_LANG_CODES)[number]

const SUPPORTED_SET = new Set<string>(SUPPORTED_OCR_LANG_CODES)

export function isSupportedOcrLang(lang: string): lang is SupportedOcrLang {
  return SUPPORTED_SET.has(lang)
}

/**
 * Resolves requested languages into a normalized list of supported OCR languages.
 * English ('eng') is always included; additional valid languages are added to it.
 */
export function resolveOcrLangs(input?: string | null): SupportedOcrLang[] {
  const result: SupportedOcrLang[] = [DEFAULT_OCR_LANG]
  if (!input) return result

  const tokens = input.split(/[+,;\s]+/).map((s) => s.trim().toLowerCase())
  for (const token of tokens) {
    if (token && isSupportedOcrLang(token) && !result.includes(token)) {
      result.push(token)
    }
  }
  return result
}
