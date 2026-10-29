import { supabase } from './supabase.js'
import { decodeTextBuffer } from './decodeText.js'

export const PRESET_TAGS = [
  '未读',
  '已读',
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

/** @type {Array<{id:string,title:string,author:string,synopsis:string,tags:string[],sortOrder:number,isRead:boolean,rating:number,review:string,attachmentPath?:string|null,attachmentName?:string|null,attachmentMime?:string|null,attachmentSize?:number|null,createdAt:number,updatedAt:number}>} */
let novelsCache = []
/** @type {{ customTags: string[], hiddenPresets: string[] }} */
let prefsCache = { customTags: [], hiddenPresets: [] }

function syncReadTags(tags, isRead) {
  const next = (tags || []).filter((t) => t !== '未读' && t !== '已读')
  next.unshift(isRead ? '已读' : '未读')
  return next
}

/** @param {unknown} n @returns {number} 0–5 */
export function clampRating(n) {
  const r = Number(n)
  if (!Number.isFinite(r) || r <= 0) return 0
  return Math.min(5, Math.round(r))
}

function rowToNovel(row) {
  const tags = Array.isArray(row.tags) ? row.tags : []
  const isRead =
    typeof row.is_read === 'boolean'
      ? row.is_read
      : tags.includes('已读') && !tags.includes('未读')
  return {
    id: row.id,
    title: row.title || '',
    author: row.author || '',
    synopsis: row.synopsis || '',
    tags,
    sortOrder: row.sort_order ?? 0,
    isRead: Boolean(isRead),
    rating: clampRating(row.rating),
    review: row.review || '',
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

/** 下载文本附件原始字节（可本地切换编码，无需重新上传） */
export async function fetchAttachmentBuffer(path) {
  const blob = await downloadAttachmentBlob(path)
  return blob.arrayBuffer()
}

/** 读取 txt 等文本附件（自动识别 UTF-8 / UTF-16 / GBK） */
export async function fetchAttachmentText(path, encoding = 'auto') {
  const buf = await fetchAttachmentBuffer(path)
  return decodeTextBuffer(buf, encoding)
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

export const PAGE_SIZE = 20

/** @type {{ page: number, pageSize: number, total: number, totalPages: number, query: string, tags: string[], readFilter: string }} */
let pageMeta = {
  page: 1,
  pageSize: PAGE_SIZE,
  total: 0,
  totalPages: 1,
  query: '',
  tags: [],
  readFilter: 'all',
}

/** 全部书的标签汇总（轻量字段，用于侧边栏） */
let novelTagsCache = []

export function getPageMeta() {
  return { ...pageMeta }
}

async function refreshNovelTags(userId) {
  const { data, error } = await supabase.from('novels').select('tags').eq('user_id', userId)
  if (error) throw error
  novelTagsCache = [
    ...new Set((data || []).flatMap((r) => (Array.isArray(r.tags) ? r.tags : []))),
  ]
}

/**
 * 给列表/随机共用的筛选条件
 * @param {import('@supabase/supabase-js').PostgrestFilterBuilder} q
 * @param {{ query?: string, tags?: string[], readFilter?: string }} opts
 */
function applyNovelFilters(q, { query = '', tags = [], readFilter = 'all' } = {}) {
  if (readFilter === 'read') q = q.eq('is_read', true)
  else if (readFilter === 'unread') q = q.eq('is_read', false)

  for (const t of tags) {
    if (t) q = q.contains('tags', [t])
  }

  const qstr = String(query || '')
    .trim()
    .replace(/[%_,]/g, ' ')
  if (qstr) {
    q = q.or(
      `title.ilike.%${qstr}%,author.ilike.%${qstr}%,synopsis.ilike.%${qstr}%,review.ilike.%${qstr}%`,
    )
  }
  return q
}

/**
 * 从当前筛选结果里随机抽一本（服务端按 offset 取）
 * @param {{ query?: string, tags?: string[], readFilter?: 'all'|'unread'|'read', excludeId?: string }} [opts]
 * @returns {Promise<object|null>}
 */
export async function pickRandomNovel(opts = {}) {
  const userId = await requireUserId()
  const query = opts.query ?? pageMeta.query ?? ''
  const tags = opts.tags ?? pageMeta.tags ?? []
  const readFilter = opts.readFilter ?? pageMeta.readFilter ?? 'all'
  const excludeId = opts.excludeId || ''

  const { count, error: countErr } = await applyNovelFilters(
    supabase.from('novels').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    { query, tags, readFilter },
  )
  if (countErr) throw countErr
  const total = count ?? 0
  if (total <= 0) return null

  const fetchAt = async (offset) => {
    const { data, error } = await applyNovelFilters(
      supabase.from('novels').select('*').eq('user_id', userId),
      { query, tags, readFilter },
    )
      .order('id', { ascending: true })
      .range(offset, offset)
    if (error) throw error
    return data?.[0] ? rowToNovel(data[0]) : null
  }

  // 尽量避开刚抽到的同一本
  for (let attempt = 0; attempt < 8; attempt++) {
    const novel = await fetchAt(Math.floor(Math.random() * total))
    if (!novel) return null
    if (!excludeId || novel.id !== excludeId || total === 1) return novel
  }
  return fetchAt(Math.floor(Math.random() * total))
}

/**
 * 分页拉取小说列表（服务端筛选/排序）
 * @param {{ page?: number, query?: string, tags?: string[], readFilter?: 'all'|'unread'|'read' }} [opts]
 */
export async function loadNovelsPage(opts = {}) {
  const userId = await requireUserId()
  const query = opts.query ?? pageMeta.query ?? ''
  const tags = opts.tags ?? pageMeta.tags ?? []
  const readFilter = opts.readFilter ?? pageMeta.readFilter ?? 'all'
  let page = Math.max(1, Number(opts.page) || pageMeta.page || 1)

  let q = applyNovelFilters(
    supabase.from('novels').select('*', { count: 'exact' }).eq('user_id', userId),
    { query, tags, readFilter },
  )

  if (getLibrarySortPref() === 'manual') {
    q = q.order('sort_order', { ascending: true }).order('created_at', { ascending: false })
  } else {
    q = q.order('created_at', { ascending: false }).order('sort_order', { ascending: true })
  }

  // 先查总数，避免页码越界
  const from = (page - 1) * PAGE_SIZE
  const to = from + PAGE_SIZE - 1
  const { data, error, count } = await q.range(from, to)
  if (error) throw error

  const total = count ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1)
  if (page > totalPages) {
    page = totalPages
    if (total === 0) {
      novelsCache = []
    } else {
      return loadNovelsPage({ page, query, tags, readFilter })
    }
  } else {
    novelsCache = (data || []).map(rowToNovel)
  }

  ensureSortOrdersLocal()
  pageMeta = {
    page,
    pageSize: PAGE_SIZE,
    total,
    totalPages,
    query,
    tags: [...tags],
    readFilter,
  }
  return listNovels()
}

/** 从云端拉取偏好 + 第一页书单（登录后调用） */
export async function refreshStore(opts = {}) {
  const userId = await requireUserId()
  await ensurePrefs(userId)
  await refreshNovelTags(userId)
  return loadNovelsPage({
    page: opts.page || 1,
    query: opts.query ?? '',
    tags: opts.tags ?? [],
    readFilter: opts.readFilter ?? 'all',
  })
}

/** 备份用：拉取全部小说（分页拼齐） */
export async function fetchAllNovels() {
  const userId = await requireUserId()
  const all = []
  let page = 0
  const size = 100
  for (;;) {
    const from = page * size
    const to = from + size - 1
    let q = supabase.from('novels').select('*').eq('user_id', userId)
    if (getLibrarySortPref() === 'manual') {
      q = q.order('sort_order', { ascending: true }).order('created_at', { ascending: false })
    } else {
      q = q.order('created_at', { ascending: false }).order('sort_order', { ascending: true })
    }
    const { data, error } = await q.range(from, to)
    if (error) throw error
    const batch = (data || []).map(rowToNovel)
    all.push(...batch)
    if (batch.length < size) break
    page += 1
  }
  return all
}

const LIBRARY_SORT_PREF_KEY = 'novel-library-sort-pref'

function getLibrarySortPref() {
  try {
    const v = localStorage.getItem(LIBRARY_SORT_PREF_KEY)
    return v === 'manual' ? 'manual' : 'added_desc'
  } catch {
    return 'added_desc'
  }
}

function setLibrarySortPref(pref) {
  try {
    localStorage.setItem(LIBRARY_SORT_PREF_KEY, pref === 'manual' ? 'manual' : 'added_desc')
  } catch {
    /* ignore */
  }
}

function ensureSortOrdersLocal() {
  const needs = novelsCache.some((n) => typeof n.sortOrder !== 'number')
  if (!needs) return
  const ranked = [...novelsCache].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  ranked.forEach((n, i) => {
    if (typeof n.sortOrder !== 'number') n.sortOrder = i
  })
}

export function getAllTags() {
  const hidden = new Set(prefsCache.hiddenPresets)
  const presets = PRESET_TAGS.filter((t) => !hidden.has(t))
  const fromNovels = [
    ...novelTagsCache,
    ...novelsCache.flatMap((n) => n.tags || []),
  ]
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

  const userId = await requireUserId()
  const { data: rows, error: listErr } = await supabase
    .from('novels')
    .select('id, tags')
    .eq('user_id', userId)
    .contains('tags', [t])
  if (listErr) throw listErr

  let removedFromNovels = 0
  const now = new Date().toISOString()
  for (const row of rows || []) {
    const nextTags = (row.tags || []).filter((x) => x !== t)
    removedFromNovels += 1
    const { error } = await supabase
      .from('novels')
      .update({ tags: nextTags, updated_at: now })
      .eq('id', row.id)
      .eq('user_id', userId)
    if (error) throw error
    const cached = novelsCache.find((n) => n.id === row.id)
    if (cached) {
      cached.tags = nextTags
      cached.updatedAt = Date.now()
    }
  }
  novelTagsCache = novelTagsCache.filter((x) => x !== t)
  return { removedFromNovels }
}

export async function countNovelsWithTag(tag) {
  const t = String(tag || '').trim()
  if (!t) return 0
  const userId = await requireUserId()
  const { count, error } = await supabase
    .from('novels')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .contains('tags', [t])
  if (error) throw error
  return count || 0
}

export function listNovels() {
  ensureSortOrdersLocal()
  // 默认：按添加时间倒序（新加的在最前）；手动点过「排序」后改用 sort_order
  if (getLibrarySortPref() === 'manual') {
    return [...novelsCache].sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (b.createdAt || 0) - (a.createdAt || 0),
    )
  }
  return [...novelsCache].sort(
    (a, b) =>
      (b.createdAt || 0) - (a.createdAt || 0) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
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

  const base = (Math.max(1, pageMeta.page) - 1) * PAGE_SIZE
  const byId = new Map(novelsCache.map((n) => [n.id, n]))
  nextFull.forEach((nid, idx) => {
    const n = byId.get(nid)
    if (n) n.sortOrder = base + idx
  })

  const userId = await requireUserId()
  const updates = nextFull.map((nid, idx) => {
    const n = byId.get(nid)
    return supabase
      .from('novels')
      .update({ sort_order: base + idx })
      .eq('id', nid)
      .eq('user_id', userId)
      .then(({ error }) => {
        if (error) throw error
        return n
      })
  })
  await Promise.all(updates)
  setLibrarySortPref('manual')
  return true
}

export function getNovel(id) {
  return novelsCache.find((n) => n.id === id) || null
}

/** 把某本放进当前页缓存（随机抽到但不在本页时，便于编辑/评分） */
export function rememberNovel(novel) {
  if (!novel?.id) return
  const i = novelsCache.findIndex((n) => n.id === novel.id)
  if (i >= 0) novelsCache[i] = novel
  else novelsCache.push(novel)
}

/** 切换已读 / 未读（同步「已读」「未读」标签） */
export async function setNovelRead(id, isRead) {
  const userId = await requireUserId()
  const existing = novelsCache.find((n) => n.id === id)
  if (!existing) throw new Error('找不到这本小说')
  const nextRead = Boolean(isRead)
  const tags = syncReadTags(existing.tags, nextRead)
  const { data: row, error } = await supabase
    .from('novels')
    .update({
      is_read: nextRead,
      tags,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw error
  const novel = rowToNovel(row)
  novelsCache = novelsCache.map((n) => (n.id === novel.id ? novel : n))
  return novel
}

/** 设置评分 0–5（再点同一星可取消为 0） */
export async function setNovelRating(id, rating) {
  const userId = await requireUserId()
  const existing = novelsCache.find((n) => n.id === id)
  if (!existing) throw new Error('找不到这本小说')
  let next = clampRating(rating)
  if (next === existing.rating && next > 0) next = 0
  const { data: row, error } = await supabase
    .from('novels')
    .update({
      rating: next,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw error
  const novel = rowToNovel(row)
  novelsCache = novelsCache.map((n) => (n.id === novel.id ? novel : n))
  return novel
}

/**
 * @param {object} data
 * @param {File} [data.attachmentFile] 新选的附件
 * @param {boolean} [data.clearAttachment] 清除已有附件
 * @param {boolean} [data.isRead]
 */
export async function upsertNovel(data) {
  const userId = await requireUserId()
  const title = (data.title || '').trim()
  const author = (data.author || '').trim()
  if (!title) throw new Error('请填写书名')

  let tags = [...new Set((data.tags || []).map((t) => t.trim()).filter(Boolean))]
  const hasReadTag = tags.includes('已读')
  const hasUnreadTag = tags.includes('未读')
  let isRead =
    typeof data.isRead === 'boolean'
      ? data.isRead
      : hasReadTag && !hasUnreadTag
        ? true
        : false
  if (hasReadTag && !hasUnreadTag) isRead = true
  if (hasUnreadTag && !hasReadTag) isRead = false
  tags = syncReadTags(tags, isRead)

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

      const rating =
        data.rating !== undefined ? clampRating(data.rating) : clampRating(existing.rating)
      const review =
        data.review !== undefined ? String(data.review || '').trim() : existing.review || ''

      const { data: row, error } = await supabase
        .from('novels')
        .update({
          title,
          author,
          synopsis: (data.synopsis || '').trim(),
          tags,
          is_read: isRead,
          rating,
          review,
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

  const rating = clampRating(data.rating)
  const review = String(data.review || '').trim()

  // 新书排到最前（添加倒序）；手动排序模式下也插到第一位
  const minOrder = novelsCache.reduce((m, n) => Math.min(m, n.sortOrder ?? 0), 0)
  const { data: row, error } = await supabase
    .from('novels')
    .insert({
      user_id: userId,
      title,
      author,
      synopsis: (data.synopsis || '').trim(),
      tags,
      is_read: isRead,
      rating,
      review,
      sort_order: novelsCache.length ? minOrder - 1 : 0,
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

/** 清空当前账号下全部小说（含附件），不可恢复 */
export async function clearAllNovels() {
  const userId = await requireUserId()
  const { data: rows, error: listErr } = await supabase
    .from('novels')
    .select('id, attachment_path')
    .eq('user_id', userId)
  if (listErr) throw listErr
  if (!rows?.length) {
    novelsCache = []
    pageMeta = { ...pageMeta, page: 1, total: 0, totalPages: 1 }
    novelTagsCache = []
    return 0
  }

  const paths = rows.map((n) => n.attachment_path).filter(Boolean)
  const { error } = await supabase.from('novels').delete().eq('user_id', userId)
  if (error) throw error
  novelsCache = []
  pageMeta = { ...pageMeta, page: 1, total: 0, totalPages: 1 }
  novelTagsCache = []

  if (paths.length) {
    const { error: rmErr } = await supabase.storage.from(ATTACH_BUCKET).remove(paths)
    if (rmErr) console.warn('清空附件时部分失败', rmErr.message || rmErr)
  }
  return rows.length
}

/**
 * @param {{ query?: string, tags?: string[], readFilter?: 'all'|'unread'|'read' }} opts
 */
export function searchNovels({ query = '', tags = [], readFilter = 'all' } = {}) {
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
    const matchRead =
      readFilter === 'all' ||
      (readFilter === 'read' ? n.isRead : !n.isRead)
    return matchQ && matchTags && matchRead
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
