/**
 * 按自然像素裁剪图片，返回新的 File
 * @param {HTMLImageElement|string} source 已加载的 img，或 object URL / data URL
 * @param {{ x: number, y: number, w: number, h: number }} rect 自然像素坐标
 * @param {string} [fileName]
 * @param {string} [mime]
 */
export async function cropImageToFile(source, rect, fileName = 'cropped.jpg', mime = 'image/jpeg') {
  const img = await loadImage(source)
  const x = Math.max(0, Math.round(rect.x))
  const y = Math.max(0, Math.round(rect.y))
  const w = Math.max(1, Math.min(Math.round(rect.w), img.naturalWidth - x))
  const h = Math.max(1, Math.min(Math.round(rect.h), img.naturalHeight - y))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法裁剪图片')
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h)

  const type = mime.startsWith('image/') ? mime : 'image/jpeg'
  const quality = type === 'image/jpeg' || type === 'image/webp' ? 0.92 : undefined
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('裁剪失败'))), type, quality)
  })
  const base = String(fileName || 'cropped').replace(/\.[^.]+$/, '') || 'cropped'
  const ext = type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg'
  return new File([blob], `${base}${ext}`, { type, lastModified: Date.now() })
}

function loadImage(source) {
  if (source instanceof HTMLImageElement) {
    if (source.complete && source.naturalWidth) return Promise.resolve(source)
    return new Promise((resolve, reject) => {
      source.onload = () => resolve(source)
      source.onerror = () => reject(new Error('图片加载失败'))
    })
  }
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = String(source)
  })
}
