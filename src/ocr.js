import Tesseract from 'tesseract.js'

let workerPromise = null
let progressCb = null

function report(label, pct) {
  progressCb?.({ label, pct: Math.max(0, Math.min(100, Math.round(pct))) })
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      report('首次使用需下载中文字库（约十几 MB，可缓存）…', 2)
      const worker = await Tesseract.createWorker('chi_sim+eng', 1, {
        logger: (m) => {
          const status = m.status || ''
          const p = typeof m.progress === 'number' ? m.progress : 0
          if (status === 'loading language traineddata') {
            report('下载字库中…', 5 + p * 35)
          } else if (status === 'initializing api' || status === 'initialized api') {
            report('初始化识别引擎…', 45 + p * 10)
          } else if (status === 'loading tesseract core') {
            report('加载识别核心…', 3 + p * 8)
          } else if (status === 'recognizing text') {
            report('识别文字中…', 55 + p * 45)
          }
        },
      })
      // 整块文字（书单截图）比默认更合适，也略快一点
      await worker.setParameters({
        tessedit_pageseg_mode: '6', // SINGLE_BLOCK：书单截图更合适
      })
      report('引擎就绪', 100)
      return worker
    })()
  }
  return workerPromise
}

/** 进入截图页时可提前调用，把首次等待挪到空闲时 */
export function preloadOcr() {
  getWorker().catch(() => {
    workerPromise = null
  })
}

function resizeImage(file, maxSide = 1200) {
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
        0.85,
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
      s = s.replace(/([\u4e00-\u9fff\u3400-\u4dbf])[ \t\u00a0\u3000]+(?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '$1')
      s = s.replace(/([\u4e00-\u9fff\u3400-\u4dbf])[ \t\u00a0\u3000]+(?=[\u3000-\u303f\uff00-\uffef])/g, '$1')
      s = s.replace(/([\u3000-\u303f\uff00-\uffef])[ \t\u00a0\u3000]+(?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '$1')
      s = s.replace(/[ \t\u00a0\u3000]+/g, ' ').trim()
      return s
    })
    .join('\n')
}

export async function recognizeImage(file, onProgress) {
  progressCb = (info) => {
    if (typeof onProgress === 'function') {
      if (typeof info === 'number') onProgress(info)
      else onProgress(info.pct, info.label)
    }
  }
  try {
    report('压缩图片…', 1)
    const blob = await resizeImage(file)
    const worker = await getWorker()
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
    const text = await recognizeImage(file, (pct, label) => {
      onItemProgress?.({
        index: i,
        total: files.length,
        progress: typeof pct === 'number' ? pct : 0,
        label: label || '',
        name: file.name,
      })
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
