import Tesseract from 'tesseract.js'

let workerPromise = null
let progressCb = null

async function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('chi_sim+eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text' && progressCb) {
          progressCb(Math.round((m.progress || 0) * 100))
        }
      },
    })
  }
  return workerPromise
}

function resizeImage(file, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      const scale = Math.min(1, maxSide / Math.max(width, height))
      width = Math.round(width * scale)
      height = Math.round(height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => {
          if (!blob) reject(new Error('图片处理失败'))
          else resolve(blob)
        },
        'image/jpeg',
        0.92,
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取图片'))
    }
    img.src = url
  })
}

/** 去掉汉字与汉字之间的 OCR 空格，保留换行和「by」两侧空格 */
export function compactOcrSpaces(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => {
      let s = line
      // 中日韩统一表意文字之间的空格：蝶 笼 → 蝶笼
      s = s.replace(/([\u4e00-\u9fff\u3400-\u4dbf])[ \t\u00a0\u3000]+(?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '$1')
      // 中文与全角标点之间
      s = s.replace(/([\u4e00-\u9fff\u3400-\u4dbf])[ \t\u00a0\u3000]+(?=[\u3000-\u303f\uff00-\uffef])/g, '$1')
      s = s.replace(/([\u3000-\u303f\uff00-\uffef])[ \t\u00a0\u3000]+(?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '$1')
      // 其余连续空白压成单空格（英文 by、单词仍可读）
      s = s.replace(/[ \t\u00a0\u3000]+/g, ' ').trim()
      return s
    })
    .join('\n')
}

export async function recognizeImage(file, onProgress) {
  const blob = await resizeImage(file)
  progressCb = onProgress || null
  const worker = await getWorker()
  try {
    const {
      data: { text },
    } = await worker.recognize(blob)
    return compactOcrSpaces((text || '').trim())
  } finally {
    progressCb = null
  }
}

export async function recognizeImages(files, onItemProgress) {
  const results = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const text = await recognizeImage(file, (p) => {
      onItemProgress?.({ index: i, total: files.length, progress: p, name: file.name })
    })
    results.push({ name: file.name, text })
  }
  return results
}

export async function terminateOcr() {
  if (workerPromise) {
    const w = await workerPromise
    await w.terminate()
    workerPromise = null
  }
}
