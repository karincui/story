import * as XLSX from 'xlsx'

const TITLE_KEYS = ['书名', '小说名', '名称', '作品名', 'title', 'name', '书名/小说名']
const AUTHOR_KEYS = ['作者', '作者名', 'author', '作家']
const SYNOPSIS_KEYS = ['简介', '介绍', '描述', '内容简介', 'synopsis', 'desc', 'description']
const TAGS_KEYS = ['标签', '分类', 'tags', 'tag', '类型']

function norm(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

function pickKey(headers, candidates) {
  const map = new Map(headers.map((h) => [norm(h), h]))
  for (const c of candidates) {
    const hit = map.get(norm(c))
    if (hit != null) return hit
  }
  // fuzzy: header contains candidate
  for (const h of headers) {
    const nh = norm(h)
    for (const c of candidates) {
      if (nh.includes(norm(c)) || norm(c).includes(nh)) return h
    }
  }
  return null
}

function splitTags(raw) {
  return String(raw ?? '')
    .split(/[,，、;；|/]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/**
 * Parse Excel/CSV File into novel drafts.
 * @returns {{ rows: Array<{title,author,synopsis,tags}>, headers: string[], sheetName: string }}
 */
export async function parseExcelFile(file) {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('表格里没有工作表')
  const sheet = wb.Sheets[sheetName]
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
  if (!json.length) throw new Error('表格没有数据行')

  const headers = Object.keys(json[0])
  const titleKey = pickKey(headers, TITLE_KEYS)
  if (!titleKey) {
    throw new Error(`找不到「书名」列。当前表头：${headers.join('、')}`)
  }
  const authorKey = pickKey(headers, AUTHOR_KEYS)
  const synopsisKey = pickKey(headers, SYNOPSIS_KEYS)
  const tagsKey = pickKey(headers, TAGS_KEYS)

  const rows = []
  for (const row of json) {
    const title = String(row[titleKey] ?? '').trim()
    if (!title) continue
    let tags = tagsKey ? splitTags(row[tagsKey]) : []
    if (!tags.length) tags = ['未读']
    rows.push({
      title,
      author: authorKey ? String(row[authorKey] ?? '').trim() : '',
      synopsis: synopsisKey ? String(row[synopsisKey] ?? '').trim() : '',
      tags,
    })
  }

  if (!rows.length) throw new Error('没有有效的书名行')
  return { rows, headers, sheetName, mapping: { titleKey, authorKey, synopsisKey, tagsKey } }
}

/** Download a blank .xlsx template. */
export function downloadExcelTemplate() {
  const data = [
    { 书名: '三体', 作者: '刘慈欣', 简介: '地球文明危机…', 标签: '科幻,未读' },
    { 书名: '活着', 作者: '余华', 简介: '', 标签: '现实,经典' },
  ]
  const ws = XLSX.utils.json_to_sheet(data)
  ws['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 36 }, { wch: 18 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '想看小说')
  XLSX.writeFile(wb, '小说导入模板.xlsx')
}
