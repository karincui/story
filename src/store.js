import { supabase } from './supabase.js'

export const PRESET_TAGS = [
  '未读',
  '仙侠',
  '玄幻',
  '甜宠',
  '言情',
  '悬疑',
  '推理',
  '科幻',
  '现实',
  '历史',
  '轻小说',
  '追更中',
]

const ATTACH_BUCKET = 'novel-attachments'
export const ATTACH_MAX_BYTES = 20 * 1024 * 1024

/** @type {Array<{id:string,title:string,author:string,synopsis:string,tags:string[],sortOrder:number,attachmentPath?:string|null,attachmentName?:string|null,attachmentMime?:string|null,attachmentSize?:number|null,createdAt:number,updatedAt:number}>} */
let novelsCache = []
/** @type {{ customTags: string[], hiddenPresets: string[] }} */
let prefsCache = { customTags: [], hiddenPresets: [] }

function rowToNovel(row) {
  return {
    id: row.id,
    title: row.title || '',
    author: row.author || '',
    synopsis: row.synopsis || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    sortOrder: row.sort_order ?? 0,
    attachmentPath: row.attachment_path || null,
    attachmentName: row.attachment_name || null,
    attachmentMime: row.attachment_mime || null,
    attachmentSize: row.attachment_size ?? null,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  }
}

/** Storage 对象 key 只能用安全 ASCII；展示仍用原始中文名 attachment_name */
function safeFileName(name) {
  const raw = String(name || 'file')
  const extMatch = raw.match(/(\.[A-Za-z0-9]{1,10})$/)
  const ext = extMatch ? extMatch[1].toLowerCase() : ''
  const stem = raw
    .slice(0, Math.max(0, raw.length - ext.length))
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, 40)
  return `${stem || 'file'}${ext || '.bin'}`
}

function friendlyStorageError(err) {
  const msg = err?.message || String(err)
  if (/bucket not found/i.test(msg)) {
    return '存储桶未创建：请到 Supabase → SQL Editor 执行 supabase/migration_attachment.sql，或在 Storage 新建私有桶 novel-attachments'
  }
  if (/invalid key/i.test(msg)) {
    return '附件文件名不合法，请换一个更简单的英文文件名后再试'
  }
  return msg
}

async function removeStoragePath(path) {
  if (!path) return
  const { error } = await supabase.storage.from(ATTACH_BUCKET).remove([path])
  if (error) console.warn('删除附件失败', error.message || error)
}

async function uploadAttachmentFile(userId, novelId, file) {
  if (!file) return null
  if (file.size > ATTACH_MAX_BYTES) {
    throw new Error('附件不能超过 20MB')
  }
  const path = `${userId}/${novelId}/${Date.now()}_${safeFileName(file.name)}`
  const { error } = await supabase.storage.from(ATTACH_BUCKET).upload(path, file, {
    upsert: false,
    contentType: file.type || 'text/plain',
  })
  if (error) throw new Error(friendlyStorageError(error))
  return {
    attachment_path: path,
    attachment_name: file.name || '附件',
    attachment_mime: file.type || '',
    attachment_size: file.size || 0,
  }
}

/** 获取附件临时下载链接（约 1 小时） */
export async function getAttachmentSignedUrl(path) {
  if (!path) throw new Error('没有附件')
  const { data, error } = await supabase.storage.from(ATTACH_BUCKET).createSignedUrl(path, 3600)
  if (error) throw error
  return data.signedUrl
}

export function isTextAttachment(name = '', mime = '', path = '') {
  const n = String(name || '').toLowerCase()
  const m = String(mime || '').toLowerCase()
  const p = String(path || '').toLowerCase()
  return (
    m.startsWith('text/') ||
    m === 'application/txt' ||
    n.endsWith('.txt') ||
    n.endsWith('.text') ||
    n.endsWith('.md') ||
    p.endsWith('.txt') ||
    p.endsWith('.text') ||
    p.endsWith('.md')
  )
}

export async function downloadAttachmentBlob(path) {
  if (!path) throw new Error('没有附件')
  const { data, error } = await supabase.storage.from(ATTACH_BUCKET).download(path)
  if (error) throw error
  return data
}

/** 读取 txt 等文本附件（自动识别 UTF-8 / UTF-16 / GBK，兼容网文与 Safari） */
export async function fetchAttachmentText(path) {
  const { decodeTextBuffer } = await import('./decodeText.js')
  const blob = await downloadAttachmentBlob(path)
  const buf = await blob.arrayBuffer()
  return decodeTextBuffer(buf)
}

async function requireUserId() {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  if (!data.user) throw new Error('请先登录')
  return data.user.id
}

async function ensurePrefs(userId) {
  const { data, error } = await supabase
    .from('user_prefs')
    .select('custom_tags, hidden_presets')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (data) {
    prefsCache = {
      customTags: data.custom_tags || [],
      hiddenPresets: data.hidden_presets || [],
    }
    return
  }
  const { error: insertErr } = await supabase.from('user_prefs').insert({
    user_id: userId,
    custom_tags: [],
    hidden_presets: [],
  })
  if (insertErr) throw insertErr
  prefsCache = { customTags: [], hiddenPresets: [] }
}

async function savePrefs() {
  const userId = await requireUserId()
  const { error } = await supabase.from('user_prefs').upsert({
    user_id: userId,
    custom_tags: prefsCache.customTags,
    hidden_presets: prefsCache.hiddenPresets,
    updated_at: new Date().toISOString(),
  })
  if (error) throw error
}

/** 从云端拉取书单与标签偏好（登录后调用） */
export async function refreshStore() {
  const userId = await requireUserId()
  const [{ data, error }, _] = await Promise.all([
    supabase
      .from('novels')
      .select('*')
      .eq('user_id', userId)
      .order('sort_order', { ascending: true }),
    ensurePrefs(userId),
  ])
  if (error) throw error
  novelsCache = (data || []).map(rowToNovel)
  ensureSortOrdersLocal()
  return listNovels()
}

function ensureSortOrdersLocal() {
  const needs = novelsCache.some((n) => typeof n.sortOrder !== 'number')
  if (!needs) return
  const ranked = [...novelsCache].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  ranked.forEach((n, i) => {
    if (typeof n.sortOrder !== 'number') n.sortOrder = i
  })
}

export function getAllTags() {
  const hidden = new Set(prefsCache.hiddenPresets)
  const presets = PRESET_TAGS.filter((t) => !hidden.has(t))
  const fromNovels = novelsCache.flatMap((n) => n.tags || [])
  return [...new Set([...presets, ...prefsCache.customTags, ...fromNovels])]
}

export async function addCustomTag(tag) {
  const t = tag.trim()
  if (!t) return getAllTags()
  prefsCache.hiddenPresets = prefsCache.hiddenPresets.filter((x) => x !== t)
  if (![...PRESET_TAGS, ...prefsCache.customTags].includes(t)) {
    prefsCache.customTags = [...prefsCache.customTags, t]
  }
  await savePrefs()
  return getAllTags()
}

export async function deleteTag(tag) {
  const t = String(tag || '').trim()
  if (!t) return { removedFromNovels: 0 }
  prefsCache.customTags = prefsCache.customTags.filter((x) => x !== t)
  if (PRESET_TAGS.includes(t)) {
    if (!prefsCache.hiddenPresets.includes(t)) {
      prefsCache.hiddenPresets = [...prefsCache.hiddenPresets, t]
    }
  }
  await savePrefs()

  let removedFromNovels = 0
  const userId = await requireUserId()
  const now = new Date().toISOString()
  for (const n of novelsCache) {
    if (!(n.tags || []).includes(t)) continue
    removedFromNovels += 1
    n.tags = n.tags.filter((x) => x !== t)
    n.updatedAt = Date.now()
    const { error } = await supabase
      .from('novels')
      .update({ tags: n.tags, updated_at: now })
      .eq('id', n.id)
      .eq('user_id', userId)
    if (error) throw error
  }
  return { removedFromNovels }
}

export function countNovelsWithTag(tag) {
  const t = String(tag || '').trim()
  if (!t) return 0
  return novelsCache.filter((n) => (n.tags || []).includes(t)).length
}

export function listNovels() {
  ensureSortOrdersLocal()
  return [...novelsCache].sort(
    (a, b) =>
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (b.updatedAt || 0) - (a.updatedAt || 0),
  )
}

export async function moveNovelInView(visibleIds, id, action) {
  const order = visibleIds.filter(Boolean)
  const i = order.indexOf(id)
  if (i < 0) return false
  if (action === 'top') {
    if (i === 0) return false
    order.splice(i, 1)
    order.unshift(id)
  } else if (action === 'up') {
    if (i === 0) return false
    ;[order[i - 1], order[i]] = [order[i], order[i - 1]]
  } else if (action === 'down') {
    if (i >= order.length - 1) return false
    ;[order[i], order[i + 1]] = [order[i + 1], order[i]]
  } else {
    return false
  }

  const full = listNovels().map((n) => n.id)
  const positions = visibleIds
    .map((vid) => full.indexOf(vid))
    .filter((p) => p >= 0)
    .sort((a, b) => a - b)
  if (positions.length !== order.length) return false

  const nextFull = [...full]
  positions.forEach((pos, idx) => {
    nextFull[pos] = order[idx]
  })

  const byId = new Map(novelsCache.map((n) => [n.id, n]))
  nextFull.forEach((nid, idx) => {
    const n = byId.get(nid)
    if (n) n.sortOrder = idx
  })

  const userId = await requireUserId()
  const updates = nextFull.map((nid, idx) => {
    const n = byId.get(nid)
    return supabase
      .from('novels')
      .update({ sort_order: idx })
      .eq('id', nid)
      .eq('user_id', userId)
      .then(({ error }) => {
        if (error) throw error
        return n
      })
  })
  await Promise.all(updates)
  return true
}

export function getNovel(id) {
  return novelsCache.find((n) => n.id === id) || null
}

/**
 * @param {object} data
 * @param {File} [data.attachmentFile] 新选的附件
 * @param {boolean} [data.clearAttachment] 清除已有附件
 */
export async function upsertNovel(data) {
  const userId = await requireUserId()
  const title = (data.title || '').trim()
  const author = (data.author || '').trim()
  if (!title) throw new Error('请填写书名')

  const tags = [...new Set((data.tags || []).map((t) => t.trim()).filter(Boolean))]
  for (const t of tags) {
    if (!PRESET_TAGS.includes(t) && !prefsCache.customTags.includes(t)) {
      prefsCache.customTags = [...prefsCache.customTags, t]
    }
  }
  prefsCache.hiddenPresets = prefsCache.hiddenPresets.filter((x) => !tags.includes(x))
  await savePrefs()

  const nowIso = new Date().toISOString()
  const file = data.attachmentFile instanceof File ? data.attachmentFile : null
  const clearAttachment = Boolean(data.clearAttachment) && !file

  if (data.id) {
    const existing = novelsCache.find((n) => n.id === data.id)
    if (existing) {
      let attachPatch = {}
      if (clearAttachment) {
        await removeStoragePath(existing.attachmentPath)
        attachPatch = {
          attachment_path: null,
          attachment_name: null,
          attachment_mime: null,
          attachment_size: null,
        }
      } else if (file) {
        await removeStoragePath(existing.attachmentPath)
        attachPatch = await uploadAttachmentFile(userId, data.id, file)
      }

      const { data: row, error } = await supabase
        .from('novels')
        .update({
          title,
          author,
          synopsis: (data.synopsis || '').trim(),
          tags,
          updated_at: nowIso,
          ...attachPatch,
        })
        .eq('id', data.id)
        .eq('user_id', userId)
        .select('*')
        .single()
      if (error) throw error
      const novel = rowToNovel(row)
      novelsCache = novelsCache.map((n) => (n.id === novel.id ? novel : n))
      return novel
    }
  }

  const maxOrder = novelsCache.reduce((m, n) => Math.max(m, n.sortOrder ?? 0), -1)
  const { data: row, error } = await supabase
    .from('novels')
    .insert({
      user_id: userId,
      title,
      author,
      synopsis: (data.synopsis || '').trim(),
      tags,
      sort_order: maxOrder + 1,
    })
    .select('*')
    .single()
  if (error) throw error

  let novel = rowToNovel(row)
  if (file) {
    try {
      const attachPatch = await uploadAttachmentFile(userId, novel.id, file)
      const { data: updated, error: upErr } = await supabase
        .from('novels')
        .update({ ...attachPatch, updated_at: new Date().toISOString() })
        .eq('id', novel.id)
        .eq('user_id', userId)
        .select('*')
        .single()
      if (upErr) throw upErr
      novel = rowToNovel(updated)
    } catch (err) {
      novelsCache.push(novel)
      throw new Error(`小说已保存，但附件上传失败：${err.message || err}`)
    }
  }
  novelsCache.push(novel)
  return novel
}

export async function deleteNovel(id) {
  const userId = await requireUserId()
  const existing = novelsCache.find((n) => n.id === id)
  const { error } = await supabase.from('novels').delete().eq('id', id).eq('user_id', userId)
  if (error) throw error
  novelsCache = novelsCache.filter((n) => n.id !== id)
  if (existing?.attachmentPath) await removeStoragePath(existing.attachmentPath)
}

export function searchNovels({ query = '', tags = [] } = {}) {
  const q = query.trim().toLowerCase()
  return listNovels().filter((n) => {
    const matchQ =
      !q ||
      n.title.toLowerCase().includes(q) ||
      n.author.toLowerCase().includes(q) ||
      (n.synopsis || '').toLowerCase().includes(q) ||
      (n.tags || []).some((t) => t.toLowerCase().includes(q))
    // 未选：不过滤；选 1 个：只保留带该标签；选多个：取交集（须同时含全部所选标签）
    const matchTags = !tags.length || tags.every((t) => (n.tags || []).includes(t))
    return matchQ && matchTags
  })
}

export function exportMarkdown(novels) {
  return novels
    .map((n) => {
      const tagLine = (n.tags || []).length ? `标签：${n.tags.join('、')}` : ''
      const syn = n.synopsis ? `\n\n${n.synopsis}` : ''
      const authorLine = n.author ? `\n作者：${n.author}` : ''
      return `## ${n.title}${authorLine}${tagLine ? `\n${tagLine}` : ''}${syn}`
    })
    .join('\n\n---\n\n')
}

/** 供本地迁移：当前缓存是否为空 */
export function isStoreEmpty() {
  return novelsCache.length === 0
}

/** 批量写入（本地迁移用），返回成功条数 */
export async function bulkInsertNovels(items) {
  const userId = await requireUserId()
  if (!items?.length) return 0
  const rows = items.map((n, i) => ({
    user_id: userId,
    title: (n.title || '').trim(),
    author: (n.author || '').trim(),
    synopsis: (n.synopsis || '').trim(),
    tags: Array.isArray(n.tags) ? n.tags : [],
    sort_order: typeof n.sortOrder === 'number' ? n.sortOrder : i,
  })).filter((r) => r.title)
  if (!rows.length) return 0
  const { data, error } = await supabase.from('novels').insert(rows).select('*')
  if (error) throw error
  const added = (data || []).map(rowToNovel)
  novelsCache.push(...added)
  return added.length
}

export async function replacePrefsFromLocal({ customTags = [], hiddenPresets = [] } = {}) {
  prefsCache = {
    customTags: [...new Set(customTags.map((t) => String(t).trim()).filter(Boolean))],
    hiddenPresets: [...new Set(hiddenPresets.map((t) => String(t).trim()).filter(Boolean))],
  }
  await savePrefs()
}
