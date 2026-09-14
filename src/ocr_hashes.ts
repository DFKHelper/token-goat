import { DEFAULT_OCR_LANG, isSupportedOcrLang, type SupportedOcrLang } from './ocr_languages.js'

export interface OcrLangSpec {
  readonly langPath: string
  readonly sha256: string
}

export function ocrLangPath(lang: string): string {
  return `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@1.0.0/4.0.0_best_int`
}

export const OCR_LANG_HASHES: Record<SupportedOcrLang, string> = {
  eng: '5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747',
  fra: 'bf83833fa957ff0076f6aa93f69e3bdf7b014dea829ea0c0d6be6b48a3ceef6d',
  spa: '0062377729b81cc268b1822f09eb1c08c09f3f7f1c6b422540b51555a7eeea70',
  deu: 'a1b72cc25753eac167edfef5af4448a8dc34973503a2265c34c84520f896eb03',
  ita: '36ec897f5f1f489b257801881286167a79b99a16040c6fbc7e3e30f03821b10b',
  por: '42fab1f017aedab69b92bdecc01bbb11166cd3b177575612ee860f8e2825ece0',
  nld: '363c360db9838838ff7ed3d8b885b33acc0d61d37165708303cf8a81e50164f3',
  pol: '02b89cad819f1374631b4a3c92bdac79c214150f97a3686df78de6c8c30782db',
  rus: 'eb9be824435f6bb0f993925acb85fd842c8418d6db7613c818e749e619a1ad6d',
  tur: 'f0127d0f3745f9c65e2ae7ec6b23198fbe5aa186a61b35661426f5e1ef9dedd7',
  swe: 'a4c33cbd23d988c84b5f9d5d5b2417fc16da061e3dc7b16acb904a4566088b14',
  ara: 'e7d6494e2ef249ee97ad151eb01e0e6ae3aaf429256442ad6af534862a2a8c0f',
  chi_sim: '9784f7c917c546424b690fcde708ce1f604a4393d08bb51ddab146d7d7c794e6',
  chi_tra: '6abfb87cce5db0d09624f16eedd8a0b24173718856121f721b6d1214193d4dab',
  jpn: '1a0175291ea145d4a66be681d1084496f10af938aacab247c5d40b31359a604e',
  kor: 'ec1749377d49ac38fb3d3cd05dd5e2a53359d329f359762bc638a81132109992',
}

export const SUPPORTED_OCR_LANGS: Readonly<Record<SupportedOcrLang, OcrLangSpec>> = Object.fromEntries(
  Object.entries(OCR_LANG_HASHES).map(([lang, sha256]) => [lang, { langPath: ocrLangPath(lang), sha256 }]),
) as Record<SupportedOcrLang, OcrLangSpec>

export function getOcrLangSpec(lang: string): OcrLangSpec {
  const tokens = lang.split('+')
  const primary = tokens.find((t) => t !== DEFAULT_OCR_LANG && isSupportedOcrLang(t)) ?? tokens[0] ?? DEFAULT_OCR_LANG
  const active: SupportedOcrLang = isSupportedOcrLang(primary) ? primary : DEFAULT_OCR_LANG
  const sha256 = OCR_LANG_HASHES[active]
  return {
    langPath: ocrLangPath(active),
    sha256,
  }
}
