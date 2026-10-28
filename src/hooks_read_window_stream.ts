/** Streams bounded source-line windows without buffering a large file as a string. */
import fs from 'node:fs'
import { decodeSource, detectSourceEncoding } from './encoding.js'

export const STREAMING_READ_MIN_BYTES = 256 * 1024
const STREAMING_READ_CHUNK_BYTES = 64 * 1024

type SourceEncoding = ReturnType<typeof detectSourceEncoding>

function codeUnitBytes(encoding: SourceEncoding): number {
  if (encoding === 'utf32le' || encoding === 'utf32be') return 4
  if (encoding === 'utf16le' || encoding === 'utf16be') return 2
  return 1
}

function bomBytes(encoding: SourceEncoding): number {
  if (encoding === 'utf8-bom') return 3
  if (encoding === 'utf16le' || encoding === 'utf16be') return 2
  if (encoding === 'utf32le' || encoding === 'utf32be') return 4
  return 0
}

function codeUnitAt(buffer: Buffer, offset: number, encoding: SourceEncoding): number {
  switch (encoding) {
    case 'utf16le':
      return buffer.readUInt16LE(offset)
    case 'utf16be':
      return buffer.readUInt16BE(offset)
    case 'utf32le':
      return buffer.readUInt32LE(offset)
    case 'utf32be':
      return buffer.readUInt32BE(offset)
    default:
      return buffer[offset] ?? 0
  }
}

function decodeWindow(chunks: Buffer[], start: number, bom: Buffer): string {
  const bytes = Buffer.concat(chunks)
  return decodeSource(start > 0 && bom.length > 0 ? Buffer.concat([bom, bytes]) : bytes)
}

/** Reads only a bounded line window from a large source file. */
export function readWindowFromDiskStreaming(filePath: string, start: number, limit: number): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const readBuffer = Buffer.alloc(STREAMING_READ_CHUNK_BYTES)
    const chunks: Buffer[] = []
    let encoding = detectSourceEncoding(Buffer.alloc(0))
    let unitBytes = 1
    let prefix = Buffer.alloc(0)
    let carry = Buffer.alloc(0)
    let bytesReadTotal = 0
    let lineNumber = 1
    const lastLine = start + limit - 1
    let windowStart: number | undefined = start === 1 ? 0 : undefined
    let capturedUntil = windowStart ?? 0
    let pendingCr: number | undefined
    let windowEnd: number | undefined

    const setWindowStart = (offset: number): void => {
      if (windowStart !== undefined) return
      windowStart = offset
      capturedUntil = offset
    }

    const finishLine = (delimiterStart: number, nextLineStart: number): boolean => {
      if (lineNumber === lastLine) {
        windowEnd = delimiterStart
        return true
      }
      lineNumber++
      if (lineNumber === start) setWindowStart(nextLineStart)
      return false
    }

    const appendThrough = (buffer: Buffer, bufferStart: number, end: number): void => {
      if (windowStart === undefined) return
      const from = Math.max(windowStart, capturedUntil, bufferStart)
      const to = Math.min(end, bufferStart + buffer.length)
      if (to <= from) return
      chunks.push(Buffer.from(buffer.subarray(from - bufferStart, to - bufferStart)))
      capturedUntil = to
    }

    for (;;) {
      let bytesRead = fs.readSync(fd, readBuffer, 0, readBuffer.length, null)
      if (bytesRead === 0) break

      const chunkStart = bytesReadTotal
      if (chunkStart === 0) {
        while (bytesRead < 4) {
          const additionalBytes = fs.readSync(fd, readBuffer, bytesRead, readBuffer.length - bytesRead, null)
          if (additionalBytes === 0) break
          bytesRead += additionalBytes
        }
        encoding = detectSourceEncoding(readBuffer.subarray(0, bytesRead))
        unitBytes = codeUnitBytes(encoding)
        prefix = Buffer.from(readBuffer.subarray(0, bomBytes(encoding)))
      }
      bytesReadTotal += bytesRead

      const data = carry.length === 0 ? readBuffer.subarray(0, bytesRead) : Buffer.concat([carry, readBuffer.subarray(0, bytesRead)])
      const dataStart = chunkStart - carry.length
      const completeLength = data.length - (data.length % unitBytes)

      for (let offset = 0; offset < completeLength; offset += unitBytes) {
        const absoluteOffset = dataStart + offset
        const code = codeUnitAt(data, offset, encoding)

        if (pendingCr !== undefined) {
          const crOffset = pendingCr
          pendingCr = undefined
          if (code === 0x0a) {
            if (finishLine(crOffset, absoluteOffset + unitBytes)) break
            continue
          }
          if (finishLine(crOffset, absoluteOffset)) break
        }

        if (code === 0x0d) {
          if (lineNumber === lastLine) {
            windowEnd = absoluteOffset
            break
          }
          pendingCr = absoluteOffset
        } else if (code === 0x0a && finishLine(absoluteOffset, absoluteOffset + unitBytes)) {
          break
        }
      }

      const completeEnd = dataStart + completeLength
      appendThrough(data, dataStart, windowEnd ?? completeEnd)
      carry = Buffer.from(data.subarray(completeLength))
      if (windowEnd !== undefined) return decodeWindow(chunks, windowStart ?? 0, prefix)
    }

    if (pendingCr !== undefined) {
      lineNumber++
      if (lineNumber === start) setWindowStart(pendingCr + unitBytes)
    }
    if (windowStart === undefined) return ''
    return decodeWindow(chunks, windowStart, prefix)
  } finally {
    fs.closeSync(fd)
  }
}
