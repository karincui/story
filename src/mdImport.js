/**
 * 解析「导出 MD」格式（## 书名 / 作者： / 标签： / 简介段落）
 * @param {string} md
 * @returns {Array<{ title: string, author: string, synopsis: string, tags: string[] }>}
 */
export function parseWishlistMarkdown(md) {
  const text = String(md || '').replace(/^\uFEFF/, '').trim()
  if (!text) return []

  const chunks = text.split(/\n\s*---\s*\n/)
  const out = []

  for (const chunk of chunks) {
    const lines = chunk
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l, i, arr) => !(i === 0 && !l) && !(i === arr.length - 1 && !l))

    let title = ''
    let author = ''
    let tags = []
    const synopsisLines = []
    let seenMeta = false

    for (const raw of lines) {
      const line = raw.trim()
      if (!line) {
        if (seenMeta || title) synopsisLines.push('')
        continue
      }
      const titleMatch = line.match(/^##\s+(.+)$/)
      if (titleMatch && !title) {
        title = titleMatch[1].trim()
        seenMeta = true
        continue
      }
      const authorMatch = line.match(/^作者[：:]\s*(.+)$/)
      if (authorMatch) {
        author = authorMatch[1].trim()
        seenMeta = true
        continue
      }
      const tagMatch = line.match(/^标签[：:]\s*(.+)$/)
      if (tagMatch) {
        tags = tagMatch[1]
          .split(/[,，、]/)
          .map((t) => t.trim())
          .filter(Boolean)
        seenMeta = true
        continue
      }
      if (title) synopsisLines.push(line)
    }

    if (!title) continue
    const synopsis = synopsisLines.join('\n').trim()
    if (!tags.length) tags = ['未读']
    out.push({ title, author, synopsis, tags })
  }

  return out
}
