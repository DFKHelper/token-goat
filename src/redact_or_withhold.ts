import { loadConfig } from './config.js'
import { redactCutSecrets } from './secret_redact.js'

/** What a read prints when redaction threw: the text is withheld whole, never returned raw. */
export const WITHHELD_PLACEHOLDER = '[REDACTED:withheld]'

/** {@link redactCutSecrets} for printed read text; on failure it returns {@link WITHHELD_PLACEHOLDER}. */
export function redactOrWithhold(text: string, keepLineCount: boolean): string {
  try {
    const redacted = redactCutSecrets(text, loadConfig(), { keepLineCount }).text
    return typeof redacted === 'string' ? redacted : WITHHELD_PLACEHOLDER
  } catch {
    return WITHHELD_PLACEHOLDER
  }
}
