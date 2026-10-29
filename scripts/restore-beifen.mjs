/**
 * 一次性：把 beifen.md 写入当前登录账号的小说库
 * 用法：
 *   node scripts/restore-beifen.mjs email password
 * 或设置环境变量 RESTORE_EMAIL / RESTORE_PASSWORD
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function loadEnv() {
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}

function parseWishlistMarkdown(md) {
  const text = String(md || '').replace(/^\uFEFF/, '').trim()
  if (!text) return []
  const chunks = text.split(/\n\s*---\s*\n/)
  const out = []
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/).map((l) => l.trimEnd())
    let title = ''
    let author = ''
    let tags = []
    const synopsisLines = []
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) {
        if (title) synopsisLines.push('')
        continue
      }
      const titleMatch = line.match(/^##\s+(.+)$/)
      if (titleMatch && !title) {
        title = titleMatch[1].trim()
        continue
      }
      const authorMatch = line.match(/^作者[：:]\s*(.+)$/)
      if (authorMatch) {
        author = authorMatch[1].trim()
        continue
      }
      const tagMatch = line.match(/^标签[：:]\s*(.+)$/)
      if (tagMatch) {
        tags = tagMatch[1]
          .split(/[,，、]/)
          .map((t) => t.trim())
          .filter(Boolean)
        continue
      }
      if (title) synopsisLines.push(line)
    }
    if (!title) continue
    if (!tags.length) tags = ['未读']
    if (!tags.includes('未读') && !tags.includes('已读')) tags = ['未读', ...tags]
    out.push({
      title,
      author,
      synopsis: synopsisLines.join('\n').trim(),
      tags,
      is_read: tags.includes('已读') && !tags.includes('未读'),
    })
  }
  return out
}

loadEnv()

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_ANON_KEY
const email = process.env.RESTORE_EMAIL || process.argv[2]
const password = process.env.RESTORE_PASSWORD || process.argv[3]

if (!url || !key) {
  console.error('缺少 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  process.exit(1)
}
if (!email || !password) {
  console.error('请提供登录邮箱和密码：node scripts/restore-beifen.mjs 邮箱 密码')
  process.exit(1)
}

const beifenPath = path.join(root, 'beifen.md')
const rows = parseWishlistMarkdown(fs.readFileSync(beifenPath, 'utf8'))
if (!rows.length) {
  console.error('beifen.md 没有解析出书目')
  process.exit(1)
}

const supabase = createClient(url, key)
const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password })
if (authErr) {
  console.error('登录失败：', authErr.message)
  process.exit(1)
}
const userId = authData.user.id

const { data: existing, error: listErr } = await supabase
  .from('novels')
  .select('title, author')
  .eq('user_id', userId)
if (listErr) {
  console.error('读取现有书单失败：', listErr.message)
  process.exit(1)
}

const have = new Set((existing || []).map((n) => `${n.title}||${n.author || ''}`))
const toAdd = rows.filter((r) => !have.has(`${r.title}||${r.author || ''}`))
console.log(`备份 ${rows.length} 本，已有 ${have.size} 本，待写入 ${toAdd.length} 本`)

if (!toAdd.length) {
  console.log('没有需要新增的书，结束')
  process.exit(0)
}

const { data: maxRow } = await supabase
  .from('novels')
  .select('sort_order')
  .eq('user_id', userId)
  .order('sort_order', { ascending: true })
  .limit(1)
  .maybeSingle()

let sortOrder = typeof maxRow?.sort_order === 'number' ? maxRow.sort_order - 1 : 0
// 按备份顺序写入，最后一本 sort 最小会排前面？我们用 created_at desc 默认。
// 为贴近备份文件顺序（文件从上到下），给后面的更新的 created 感：逐条 insert 即可。

let ok = 0
for (const r of toAdd) {
  const { error } = await supabase.from('novels').insert({
    user_id: userId,
    title: r.title,
    author: r.author || '',
    synopsis: r.synopsis || '',
    tags: r.tags,
    is_read: Boolean(r.is_read),
    sort_order: sortOrder,
  })
  if (error) {
    console.error(`失败「${r.title}」:`, error.message)
  } else {
    ok += 1
    sortOrder -= 1
    console.log(`+ ${r.title}`)
  }
}

console.log(`完成：成功 ${ok} / ${toAdd.length}`)
await supabase.auth.signOut()
