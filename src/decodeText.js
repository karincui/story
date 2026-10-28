import iconv from 'iconv-lite'
import { Buffer } from 'buffer'

/**
 * 评分：偏爱「常用汉字 + 中文标点」，惩罚 � 与空字节。
 */
function scoreDecoded(text) {
  if (!text) return -1e9
  const sample = text.slice(0, 24000)
  const fffd = (sample.match(/\uFFFD/g) || []).length
  const nulls = (sample.match(/\u0000/g) || []).length
  const common = (sample.match(/[的了是我不在人有他这中大来上个们到说对时着她也会过来你能着上下]/g) || []).length
  const punct = (sample.match(/[。！？、，：；《》…—\n\r""''「」']/g) || []).length
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length
  const latinJunk = (sample.match(/[A-Za-z]{3,}/g) || []).length
  const commonRatio = cjk > 0 ? common / cjk : 0
  return (
    common * 10 +
    punct * 6 +
    cjk * 0.2 +
    commonRatio * 400 -
    fffd * 25 -
    nulls * 20 -
    latinJunk * 2
  )
}

function tryNative(label, bytes) {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
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

function stripBom(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', bytes: bytes.subarray(3) }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', bytes: bytes.subarray(2) }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', bytes: bytes.subarray(2) }
  }
  return { encoding: null, bytes }
}

/**
 * @param {ArrayBuffer} arrayBuffer
 * @param {'auto'|'utf-8'|'gbk'|'utf-16le'|'utf-16be'} encoding
 */
export function decodeTextBuffer(arrayBuffer, encoding = 'auto') {
  const raw = new Uint8Array(arrayBuffer)
  if (!raw.length) return { text: '', encoding: encoding === 'auto' ? 'utf-8' : encoding }

  if (encoding === 'utf-8') {
    const { bytes } = stripBom(raw)
    return { text: tryNative('utf-8', bytes) || '', encoding: 'utf-8' }
  }
  if (encoding === 'gbk') {
    const text =
      tryIconv('gb18030', raw) ||
      tryIconv('gbk', raw) ||
      tryNative('gb18030', raw) ||
      tryNative('gbk', raw) ||
      ''
    return { text, encoding: 'gbk' }
  }
  if (encoding === 'utf-16le') {
    const { bytes } = stripBom(raw)
    return { text: tryNative('utf-16le', bytes) || '', encoding: 'utf-16le' }
  }
  if (encoding === 'utf-16be') {
    const { bytes } = stripBom(raw)
    return { text: tryNative('utf-16be', bytes) || '', encoding: 'utf-16be' }
  }

  const bom = stripBom(raw)
  if (bom.encoding) {
    const text = tryNative(bom.encoding, bom.bytes) || ''
    return { text, encoding: bom.encoding }
  }

  const candidates = []
  const push = (label, text) => {
    if (text == null) return
    candidates.push({ label, text, score: scoreDecoded(text) })
  }

  push('utf-8', tryNative('utf-8', raw))
  push('utf-16le', tryNative('utf-16le', raw))
  push('utf-16be', tryNative('utf-16be', raw))
  push('gb18030', tryIconv('gb18030', raw) || tryNative('gb18030', raw))
  push('gbk', tryIconv('gbk', raw) || tryNative('gbk', raw))

  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  return {
    text: best?.text ?? tryNative('utf-8', raw) ?? '',
    encoding: best?.label || 'utf-8',
  }
}

/** 兼容旧调用；解码已随主包加载，无需再动态 import */
export async function decodeTextBufferAsync(arrayBuffer, encoding = 'auto') {
  return decodeTextBuffer(arrayBuffer, encoding)
}
