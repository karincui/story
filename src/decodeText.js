import iconv from 'iconv-lite'
import { Buffer } from 'buffer'

/** 统计乱码与汉字比例，分数越高越像正常中文文本 */
function scoreDecoded(text) {
  if (!text) return -1e9
  const sample = text.slice(0, 12000)
  let bad = 0
  let cjk = 0
  let ascii = 0
  let nulls = 0
  for (const ch of sample) {
    const cp = ch.codePointAt(0)
    if (ch === '\uFFFD') bad += 4
    else if (cp === 0) nulls += 3
    else if (cp >= 0x4e00 && cp <= 0x9fff) cjk += 2
    else if (cp >= 0x3400 && cp <= 0x4dbf) cjk += 2
    else if ((cp >= 0x20 && cp < 0x7f) || cp === 0x0a || cp === 0x0d || cp === 0x09) ascii += 0.15
    else if (cp < 32) bad += 1
  }
  return cjk + ascii - bad - nulls
}

function tryNative(label, bytes) {
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return null
  }
}

function tryIconv(label, bytes) {
  try {
    return iconv.decode(Buffer.from(bytes), label)
  } catch {
    return null
  }
}

/**
 * 智能解码文本附件：UTF-8 / UTF-16 / GBK / GB18030
 * 网文 txt 在 iPhone Safari 上常需 iconv 的 GBK（原生不支持）
 */
export function decodeTextBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  if (!bytes.length) return ''

  // BOM 优先
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }

  // 大量 0x00 夹在字节间 → 更像 UTF-16LE
  let zeroEven = 0
  let zeroOdd = 0
  const n = Math.min(bytes.length, 4000)
  for (let i = 0; i < n; i++) {
    if (bytes[i] !== 0) continue
    if (i % 2 === 0) zeroEven++
    else zeroOdd++
  }
  const utf16Hint = zeroOdd > n * 0.2 || zeroEven > n * 0.2

  const candidates = []
  const push = (label, text) => {
    if (text == null) return
    candidates.push({ label, text, score: scoreDecoded(text) })
  }

  push('utf-8', tryNative('utf-8', bytes))
  if (utf16Hint) {
    push('utf-16le', tryNative('utf-16le', bytes))
    push('utf-16be', tryNative('utf-16be', bytes))
  }
  push('gb18030-native', tryNative('gb18030', bytes))
  push('gbk-native', tryNative('gbk', bytes))
  push('gb18030', tryIconv('gb18030', bytes))
  push('gbk', tryIconv('gbk', bytes))

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.text ?? new TextDecoder('utf-8').decode(bytes)
}
