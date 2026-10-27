const NOISE_EXACT = new Set([
  '分享',
  '收藏',
  '阅读',
  '目录',
  '书架',
  '关注',
  '点赞',
  '评论',
  '下载',
  '订阅',
  '推荐',
  '热门',
  '排行',
  '搜索',
  '设置',
  '返回',
  '首页',
  '我的',
  '详情',
  '章节',
  '继续阅读',
  '加入书架',
  '全本',
  '完结',
  '连载',
  '说点什么',
  '已关注',
])

const NOISE_INCLUDE = [
  '继续阅读',
  '加入书架',
  '说点什么',
  '人气',
  '评分',
]

const AUTHOR_PREFIX = /^(作者|著者|著|编剧|原著)[:：\s]*/i

/** 「书名 by 作者」；兼容 OCR 把序号粘在 by 前（如 cos0by） */
const BY_LINE =
  /^[\s]*(?:\d{1,2}[\.．、\)）]?\s*)?(.+?)\s*(\d{0,2})\s*[bB][yY]\s*(.+?)\s*$/

const BY_GLOBAL =
  /(?:^|\n)\s*(?:\d{1,2}[\.．、\)）]?\s*)?([^\n#]{1,40}?)\s*\d{0,2}\s*[bB][yY]\s*([^\n#]{1,30}?)(?=\s*(?:\n|$|\d{1,2}[\.．、\)）]?\s|[bB][yY]|#))/g

function stripLeadingIndex(line) {
  return line
    .replace(/^[\d０-９]{1,2}[\.．、\)）]\s*/, '')
    .replace(/^[(（][\d０-９]+[)）]\s*/, '')
    .replace(/^[\d０-９]{1,2}\s+/, '')
    .trim()
}

function isNoiseLine(line) {
  if (!line || line.length < 2) return true
  if (/^\d+$/.test(line)) return true
  if (/^#/.test(line) || /^＃/.test(line)) return true
  if (/^@/.test(line)) return true
  if (/^\d+\s*本/.test(line)) return true // 「18本先婚后爱」类标题
  if (NOISE_EXACT.has(line)) return true
  if (NOISE_INCLUDE.some((n) => line.includes(n) && line.length <= n.length + 4)) return true
  // 纯话题串
  if (/^(#[\u4e00-\u9fffA-Za-z0-9_]+){1,}$/.test(line.replace(/\s/g, ''))) return true
  return false
}

function cleanAuthor(author) {
  return String(author || '')
    .replace(AUTHOR_PREFIX, '')
    .replace(/[#＃].*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanTitle(title) {
  return String(title || '')
    .replace(/^[\d０-９]{1,2}[\.．、\)）]?\s*/, '')
    .replace(/[#＃].*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseByLine(line) {
  const m = line.match(BY_LINE)
  if (!m) return null
  let title = cleanTitle(m[1])
  const gluedIndex = m[2]
  // OCR 把「2」识别成粘在书名后的数字时丢掉
  if (gluedIndex && /^\d{1,2}$/.test(gluedIndex) && !/\d$/.test(title)) {
    // title 本身不含尾数，gluedIndex 视为序号残留，忽略
  } else if (gluedIndex && /\d$/.test(title + gluedIndex) === false) {
    title = cleanTitle(title + gluedIndex)
  }
  // 「cos0by」整段：title=cos，gluedIndex=0
  if (!title && gluedIndex) title = gluedIndex
  const author = cleanAuthor(m[3])
  if (title.length < 1 || author.length < 1) return null
  if (isNoiseLine(title) || isNoiseLine(author)) return null
  // 作者过长多半是下一条书名被粘进来了
  if (author.length > 20) return null
  return { title, author }
}

function extractByPairsFromText(text) {
  const found = []
  const seen = new Set()
  const push = (title, author) => {
    title = cleanTitle(title)
    author = cleanAuthor(author)
    if (!title || !author || title.length < 1 || author.length < 1) return
    if (isNoiseLine(title)) return
    if (author.length > 20) return
    const key = title.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push({ title, author })
  }

  for (const line of text.split(/\r?\n/)) {
    const hit = parseByLine(line.trim())
    if (hit) push(hit.title, hit.author)
  }

  // 行被 OCR 粘成一段时，再用全局扫描兜底
  if (found.length < 2) {
    BY_GLOBAL.lastIndex = 0
    let m
    const flat = text.replace(/\r/g, '')
    while ((m = BY_GLOBAL.exec(flat)) !== null) {
      push(m[1], m[2])
    }
  }

  return found
}

function parseCoverOrLoose(text) {
  const lines = (text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(stripLeadingIndex)
    .filter((l) => !isNoiseLine(l))

  const titles = []
  let authorHint = ''

  for (const line of lines) {
    const byHit = parseByLine(line)
    if (byHit) {
      titles.push(byHit)
      continue
    }
    if (AUTHOR_PREFIX.test(line)) {
      authorHint = line.replace(AUTHOR_PREFIX, '').trim()
      continue
    }
    const split = line.split(/\s*[\/｜|]\s*|\s{2,}|\s+[-—–]\s+/)
    if (split.length >= 2 && split[0].length >= 2 && split[1].length >= 2) {
      titles.push({
        title: cleanTitle(split[0]),
        author: cleanAuthor(split[1]),
      })
      continue
    }
    if (/作者/.test(line) && line.length < 40) {
      authorHint = line.replace(/.*作者[:：\s]*/, '').trim()
      continue
    }
    titles.push({ title: cleanTitle(line), author: '' })
  }

  const seen = new Set()
  const unique = []
  for (const item of titles) {
    if (!item.title) continue
    const key = item.title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (!item.author && authorHint && unique.length === 0) {
      item.author = authorHint
    }
    unique.push(item)
  }

  // 单本封面：只保留前几条候选，避免把简介整段拆成「书」
  if (unique.length === 1) return unique
  if (unique.length > 8 && unique.filter((u) => u.author).length < 2) {
    return unique.slice(0, 5)
  }
  return unique
}

/** 解析前再压一遍汉字间空格，兼容外部直接喂原文 */
function compactCjkSpaces(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/([\u4e00-\u9fff\u3400-\u4dbf])[ \t\u00a0\u3000]+(?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '$1')
        .replace(/[ \t\u00a0\u3000]+/g, ' ')
        .trim(),
    )
    .join('\n')
}

/**
 * 自动区分：
 * - 书单截图（多条「书名 by 作者」）→ 全部抽出
 * - 单本封面 / 零散文字 → 宽松解析
 */
export function parseOcrText(text) {
  const raw = compactCjkSpaces(text || '')
  const byPairs = extractByPairsFromText(raw)
  if (byPairs.length >= 2) {
    return byPairs
  }
  if (byPairs.length === 1) {
    // 只有一条 by，也可能是单本推荐卡片
    return byPairs
  }
  return parseCoverOrLoose(raw)
}
