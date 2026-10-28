import {
  exportMarkdown,
  fetchAllNovels,
  searchNovels,
  upsertNovel,
  refreshStore,
} from './store.js'
import { parseWishlistMarkdown } from './mdImport.js'

const BEIFEN_NAME = 'beifen.md'
const LOCAL_API = '/api/beifen'

export async function buildBackupMarkdown() {
  const novels = await fetchAllNovels()
  return { md: exportMarkdown(novels), count: novels.length }
}

async function tryWriteLocalBeifen(md) {
  try {
    const res = await fetch(LOCAL_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body: md,
    })
    if (!res.ok) return false
    return true
  } catch {
    return false
  }
}

async function tryReadLocalBeifen() {
  try {
    const res = await fetch(`${LOCAL_API}?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const text = await res.text()
    return text?.trim() ? text : null
  } catch {
    return null
  }
}

function downloadBeifen(md) {
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = BEIFEN_NAME
  a.click()
  URL.revokeObjectURL(a.href)
}

/** 备份当前书架：优先写入本地 beifen.md（开发服），并下载一份 */
export async function backupNovelsToBeifen() {
  const { md, count } = await buildBackupMarkdown()
  if (!md.trim()) throw new Error('书架是空的，没什么可备份')
  const wroteLocal = await tryWriteLocalBeifen(md)
  downloadBeifen(md)
  return {
    count,
    wroteLocal,
    fileName: BEIFEN_NAME,
  }
}

/** 解析备份并对比书架，返回待导入列表（不写库） */
export function planRestoreFromMarkdown(text) {
  const rows = parseWishlistMarkdown(text)
  if (!rows.length) throw new Error('备份里没有解析出书目')
  const existing = new Set(
    searchNovels({ readFilter: 'all' }).map((n) => `${n.title}||${n.author || ''}`),
  )
  const toAdd = rows.filter((r) => !existing.has(`${r.title}||${r.author || ''}`))
  return {
    total: rows.length,
    toAdd,
    skipped: rows.length - toAdd.length,
  }
}

/**
 * @param {Array<{ title: string, author: string, synopsis: string, tags: string[] }>} toAdd
 * @param {{ onProgress?: (label: string) => void }} [opts]
 */
export async function applyRestoreNovels(toAdd, opts = {}) {
  let ok = 0
  const failed = []
  for (const d of toAdd) {
    try {
      opts.onProgress?.(`恢复中 ${ok + 1}/${toAdd.length}…`)
      await upsertNovel({
        title: d.title,
        author: d.author,
        synopsis: d.synopsis,
        tags: d.tags?.length ? d.tags : ['未读'],
      })
      ok += 1
    } catch (err) {
      failed.push(`${d.title}：${err.message || err}`)
    }
  }
  await refreshStore({ page: 1 })
  return { ok, failed }
}

/** 优先读本地 beifen.md；没有则返回 null，由 UI 改走文件选择 */
export async function loadBeifenText() {
  return tryReadLocalBeifen()
}

export function pickBeifenFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,text/markdown,text/plain'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      resolve(await file.text())
    }
    input.click()
  })
}
