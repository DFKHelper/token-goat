/** OCR text reaches the model with secrets hidden on every output path. Fixture provenance: HAND-DERIVED. */
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = { text: '', fencing: true }

vi.mock('../src/read_commands.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    runImageText: async () => ({
      ocrAvailable: true,
      confidence: 91,
      chars: state.text.length,
      textHeavy: true,
      text: state.text,
    }),
  }
})
vi.mock('../src/untrusted_fence.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, injectionFencingEnabled: () => state.fencing }
})
vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, recordStat: () => undefined }
})

import { cmdImageText } from '../src/cli_cmd_formats.js'
import { formatOcrSummary } from '../src/image_ocr.js'
import { fenceUntrustedOcrText } from '../src/injection_scan.js'

const SECRET = 'hunter2hunter2xyz'
const OCR_TEXT = `Settings screen\npassword = ${SECRET}\nSave`

function captured(): { write: ReturnType<typeof vi.spyOn>; text: () => string } {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  return { write, text: () => write.mock.calls.map((c) => String(c[0])).join('') }
}

afterEach(() => {
  vi.restoreAllMocks()
  state.fencing = true
})

describe('OCR text is redacted where it leaves for the model', () => {
  it('image-text prints the text with the secret hidden', async () => {
    state.text = OCR_TEXT
    const cap = captured()
    await cmdImageText('shot.png')
    expect(cap.text()).toContain('Settings screen')
    expect(cap.text()).not.toContain(SECRET)
  })

  it('image-text --json carries the text with the secret hidden', async () => {
    state.text = OCR_TEXT
    const cap = captured()
    await cmdImageText('shot.png', { json: true })
    expect(JSON.parse(cap.text()).text).toContain('Settings screen')
    expect(cap.text()).not.toContain(SECRET)
  })

  it('image-text hides the secret when injection fencing is switched off', async () => {
    state.text = OCR_TEXT
    state.fencing = false
    const cap = captured()
    await cmdImageText('shot.png')
    expect(cap.text()).toContain('Settings screen')
    expect(cap.text()).not.toContain(SECRET)
  })

  it('image-text --json hides the secret when injection fencing is switched off', async () => {
    state.text = OCR_TEXT
    state.fencing = false
    const cap = captured()
    await cmdImageText('shot.png', { json: true })
    expect(cap.text()).not.toContain(SECRET)
  })

  it('the image-shrink summary hides the secret', () => {
    const out = formatOcrSummary({ text: OCR_TEXT, confidence: 91 }, 'shot.png', 40_000)
    expect(out).toContain('Settings screen')
    expect(out).not.toContain(SECRET)
  })

  it('the fence itself hides the secret', () => {
    const out = fenceUntrustedOcrText(OCR_TEXT)
    expect(out).toContain('Settings screen')
    expect(out).not.toContain(SECRET)
  })
})
