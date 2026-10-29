import './style.css'
import {
  searchNovels,
  getAllTags,
  addCustomTag,
  deleteTag,
  countNovelsWithTag,
  upsertNovel,
  deleteNovel,
  getNovel,
  setNovelRead,
  setNovelWant,
  setNovelRating,
  clampRating,
  pickRandomNovel,
  rememberNovel,
  moveNovelInView,
  refreshStore,
  loadNovelsPage,
  getPageMeta,
  PAGE_SIZE,
  getAttachmentSignedUrl,
  fetchAttachmentText,
  fetchAttachmentBuffer,
  isTextAttachment,
  ATTACH_MAX_BYTES,
} from './store.js'
import { getSession, signInWithPassword, signUpWithPassword, signOut, onAuthChange } from './auth.js'
import { migrateLocalIfNeeded } from './migrateLocal.js'
import { recognizeImages, preloadOcr } from './ocr.js'
import { parseOcrText } from './parseBooks.js'
import { tagStyleAttr } from './tagColors.js'
import { parseExcelFile, downloadExcelTemplate } from './excelImport.js'
import {
  backupNovelsToBeifen,
  loadBeifenText,
  pickBeifenFile,
  planRestoreFromMarkdown,
  applyRestoreNovels,
} from './backup.js'
import { listImages, addImages, getImage, deleteImage, deleteImages } from './imageStore.js'
import { cropImageToFile } from './cropImage.js'
import { decodeTextBuffer, decodeTextBufferAsync } from './decodeText.js'

const state = {
  page: 'library', // library | import | excel | gallery
  query: '',
  filterTags: [],
  /** all | unread | want | read */
  readFilter: 'all',
  tagManage: false,
  /** 标签筛选面板是否展开 */
  tagsPanelOpen: localStorage.getItem('novel-tags-panel-open') !== '0',
  sortMode: false,
  editingId: null,
  importFiles: [],
  importDrafts: [],
  batchTags: ['未读'],
  rawOcr: '',
  /** @type {number|null} */
  cropIndex: null,
  recognizing: false,
  progress: { label: '', pct: 0 },
  importMsg: '',
  excelDrafts: [],
  excelInfo: '',
  excelImporting: false,
  galleryItems: [],
  gallerySelected: [],
  galleryPreviewId: null,
  galleryLoading: false,
  galleryMsg: '',
  authReady: false,
  user: null,
  authMode: 'login', // login | register
  authEmail: '',
  authPassword: '',
  authMsg: '',
  authBusy: false,
  actionBusy: false,
  actionBusyLabel: '',
  storeReady: false,
  storeError: '',
  /** @type {File|null} */
  pendingAttachmentFile: null,
  pendingAttachmentClear: false,
  /** txt 阅读器 */
  readerOpen: false,
  readerNovelId: null,
  readerTitle: '',
  readerText: '',
  readerFontSize: 18,
  readerError: '',
  readerEncoding: 'auto',
  /** @type {ArrayBuffer|null} */
  readerBuffer: null,
  readerPage: 1,
  readerTotalPages: 1,
  readerPercent: 0,
  /** parchment | eye-care | night | custom */
  readerTheme: localStorage.getItem('novel-reader-theme') || 'parchment',
  readerCustomBg: localStorage.getItem('novel-reader-custom-bg') || '#f7f3ea',
  readerCustomFg: localStorage.getItem('novel-reader-custom-fg') || '#2a241c',
  readerCustomBgImage: localStorage.getItem('novel-reader-custom-bg-image') || '',
  /** 阅读器「背景/编码」面板是否展开 */
  readerSettingsOpen: false,
  /** 阅读器进度条是否展开 */
  readerProgressOpen: false,
  /** 随机抽中的小说（弹层） */
  randomNovel: null,
  /** 查看详情的小说 id */
  viewingId: null,
}

/** 防重复提交：全局遮罩 + loading 文案（不整页重绘，避免表单丢失） */
async function runBusy(label, fn) {
  if (state.actionBusy || state.authBusy) return
  state.actionBusy = true
  state.actionBusyLabel = label || '处理中…'
  mountBusyOverlay()
  try {
    return await fn()
  } finally {
    state.actionBusy = false
    state.actionBusyLabel = ''
    unmountBusyOverlay()
  }
}

function mountBusyOverlay() {
  let el = document.getElementById('global-busy')
  if (!el) {
    el = document.createElement('div')
    el.id = 'global-busy'
    el.className = 'busy-overlay'
    el.setAttribute('aria-live', 'polite')
    el.setAttribute('aria-busy', 'true')
    document.body.appendChild(el)
  }
  el.innerHTML = `<div class="busy-card"><span class="busy-spinner"></span><span>${escapeHtml(state.actionBusyLabel)}</span></div>`
}

function unmountBusyOverlay() {
  document.getElementById('global-busy')?.remove()
}

function debounce(fn, ms = 250) {
  let t = 0
  return (...args) => {
    clearTimeout(t)
    t = window.setTimeout(() => fn(...args), ms)
  }
}

/** 同步操作短防抖，避免连点 */
function withClickGuard(fn, ms = 400) {
  let locked = false
  return (...args) => {
    if (locked || state.actionBusy || state.authBusy) return
    locked = true
    Promise.resolve()
      .then(() => fn(...args))
      .finally(() => {
        window.setTimeout(() => {
          locked = false
        }, ms)
      })
  }
}

function revokeGalleryPreviews() {
  for (const item of state.galleryItems) {
    if (item.preview) URL.revokeObjectURL(item.preview)
  }
}

async function loadGallery() {
  state.galleryLoading = true
  try {
    const rows = await listImages()
    revokeGalleryPreviews()
    state.galleryItems = rows.map((r) => ({
      id: r.id,
      name: r.name,
      size: r.size,
      createdAt: r.createdAt,
      preview: URL.createObjectURL(r.blob),
    }))
    const alive = new Set(state.galleryItems.map((x) => x.id))
    state.gallerySelected = state.gallerySelected.filter((id) => alive.has(id))
    if (state.galleryPreviewId && !alive.has(state.galleryPreviewId)) {
      state.galleryPreviewId = null
    }
  } finally {
    state.galleryLoading = false
  }
}

function formatBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ''
  }
}

const app = document.querySelector('#app')

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const USER_ICON_SVG = `<svg class="user-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 12a4.5 4.5 0 1 0-4.5-4.5A4.5 4.5 0 0 0 12 12Zm0 2.25c-3.75 0-7.5 1.88-7.5 4.5V21h15v-2.25c0-2.62-3.75-4.5-7.5-4.5Z"/></svg>`

/** 自绘对话框：部分内嵌浏览器会拦截原生 prompt/confirm */
function askText(title, { placeholder = '', defaultValue = '' } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop ask-dialog'
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width:360px">
        <h2>${escapeHtml(title)}</h2>
        <label class="field"><span>名称</span>
          <input id="ask-text-input" type="text" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}" />
        </label>
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="ask-text-cancel">取消</button>
          <button type="button" class="btn" id="ask-text-ok">确定</button>
        </div>
      </div>
    `
    const finish = (v) => {
      backdrop.remove()
      resolve(v)
    }
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null)
    })
    backdrop.querySelector('#ask-text-cancel').addEventListener('click', () => finish(null))
    backdrop.querySelector('#ask-text-ok').addEventListener('click', () => {
      finish(backdrop.querySelector('#ask-text-input').value)
    })
    const input = backdrop.querySelector('#ask-text-input')
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(input.value)
      } else if (e.key === 'Escape') {
        finish(null)
      }
    })
    document.body.appendChild(backdrop)
    queueMicrotask(() => {
      input.focus()
      input.select()
    })
  })
}

function askConfirm(message) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop ask-dialog'
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width:360px">
        <h2>请确认</h2>
        <p class="muted" style="margin:0 0 14px;white-space:pre-wrap">${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="ask-confirm-cancel">取消</button>
          <button type="button" class="btn" id="ask-confirm-ok">确定</button>
        </div>
      </div>
    `
    const finish = (v) => {
      backdrop.remove()
      resolve(v)
    }
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(false)
    })
    backdrop.querySelector('#ask-confirm-cancel').addEventListener('click', () => finish(false))
    backdrop.querySelector('#ask-confirm-ok').addEventListener('click', () => finish(true))
    document.body.appendChild(backdrop)
    queueMicrotask(() => backdrop.querySelector('#ask-confirm-ok').focus())
  })
}

function render() {
  const scrollY = window.scrollY

  if (!state.authReady) {
    app.innerHTML = `<div class="auth-shell"><p class="muted">正在连接…</p></div>`
    return
  }

  if (!state.user) {
    app.innerHTML = renderAuth()
    bindAuth()
    return
  }

  if (!state.storeReady) {
    app.innerHTML = `
      <div class="auth-shell">
        <p class="muted">${state.storeError ? escapeHtml(state.storeError) : '正在加载书单…'}</p>
        ${state.storeError ? `<button class="btn" id="retry-store" type="button">重试</button>` : ''}
      </div>`
    app.querySelector('#retry-store')?.addEventListener(
      'click',
      withClickGuard(() => bootStore()),
    )
    return
  }

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand-block">
          <h1 class="brand">书单</h1>
        </div>
        <nav class="nav">
          <button class="nav-btn ${state.page === 'library' ? 'active' : ''}" data-nav="library">小说库</button>
          <button class="nav-btn ${state.page === 'import' ? 'active' : ''}" data-nav="import">截图导入</button>
          <button class="nav-btn ${state.page === 'gallery' ? 'active' : ''}" data-nav="gallery">图库</button>
          <button class="nav-btn ${state.page === 'excel' ? 'active' : ''}" data-nav="excel">表格录入</button>
        </nav>
        <div class="top-actions">
          <button class="btn" id="add-novel-primary" type="button">+ 添加</button>
          <div class="account-menu">
            <button
              type="button"
              class="account-menu-btn"
              id="account-menu-btn"
              title="${escapeHtml(state.user.email || '账号')}"
              aria-label="账号菜单"
              aria-expanded="false"
              aria-haspopup="true"
            >${USER_ICON_SVG}</button>
            <div class="account-dropdown" id="account-dropdown" hidden>
              <p class="account-email">${escapeHtml(state.user.email || '已登录')}</p>
              <button type="button" class="account-item" id="backup-beifen">备份书架</button>
              <button type="button" class="account-item" id="restore-beifen">从备份恢复</button>
              <button type="button" class="account-item danger" id="sign-out">退出登录</button>
            </div>
          </div>
        </div>
        ${
          state.page === 'library'
            ? `<div class="search-wrap">
                <input class="search-input" id="search" type="search" placeholder="搜索书名 / 作者 / 标签" value="${escapeHtml(state.query)}" />
              </div>`
            : ''
        }
      </header>
      ${
        state.page === 'library'
          ? renderLibrary()
          : state.page === 'excel'
            ? renderExcel()
            : state.page === 'gallery'
              ? renderGallery()
              : renderImport()
      }
    </div>
    ${state.editingId !== null ? renderModal() : ''}
    ${state.viewingId ? renderViewModal() : ''}
    ${state.randomNovel ? renderRandomModal() : ''}
    ${state.galleryPreviewId ? renderGalleryLightbox() : ''}
    ${state.readerOpen ? renderTxtReader() : ''}
    ${state.cropIndex !== null ? renderCropModal() : ''}
  `
  bindEvents()
  // 整页重绘会把滚动顶回顶部；恢复位置，避免移除/改标签后跳回第一条
  window.scrollTo(0, scrollY)
}

function renderAuth() {
  const isRegister = state.authMode === 'register'
  return `
    <div class="auth-shell">
      <div class="auth-card">
        <h1 class="brand">书单</h1>
        <p class="brand-sub">登录后书单保存在云端，电脑和手机都能用</p>
        <div class="auth-tabs">
          <button type="button" class="auth-tab ${!isRegister ? 'active' : ''}" id="auth-tab-login" ${state.authBusy ? 'disabled' : ''}>登录</button>
          <button type="button" class="auth-tab ${isRegister ? 'active' : ''}" id="auth-tab-register" ${state.authBusy ? 'disabled' : ''}>注册</button>
        </div>
        <label class="auth-label" for="auth-email">邮箱</label>
        <input class="search-input" id="auth-email" type="email" autocomplete="email"
          placeholder="you@example.com" value="${escapeHtml(state.authEmail)}" ${state.authBusy ? 'disabled' : ''} />
        <label class="auth-label" for="auth-password">密码</label>
        <input class="search-input" id="auth-password" type="password"
          autocomplete="${isRegister ? 'new-password' : 'current-password'}"
          placeholder="${isRegister ? '至少 6 位' : '密码'}"
          value="${escapeHtml(state.authPassword)}" ${state.authBusy ? 'disabled' : ''} />
        <button class="btn" id="auth-submit" type="button" ${state.authBusy ? 'disabled' : ''}>
          ${state.authBusy ? '请稍候…' : isRegister ? '注册并登录' : '登录'}
        </button>
        ${state.authMsg ? `<p class="auth-msg">${escapeHtml(state.authMsg)}</p>` : ''}
        <p class="muted auth-hint">${isRegister ? '注册后可用同一邮箱密码在各设备登录' : '没有账号？点上方「注册」'}</p>
      </div>
    </div>
  `
}

function bindAuth() {
  const emailEl = app.querySelector('#auth-email')
  const passwordEl = app.querySelector('#auth-password')
  emailEl?.addEventListener('input', () => {
    state.authEmail = emailEl.value
  })
  passwordEl?.addEventListener('input', () => {
    state.authPassword = passwordEl.value
  })
  app.querySelector('#auth-tab-login')?.addEventListener('click', () => {
    state.authMode = 'login'
    state.authMsg = ''
    render()
  })
  app.querySelector('#auth-tab-register')?.addEventListener('click', () => {
    state.authMode = 'register'
    state.authMsg = ''
    render()
  })
  app.querySelector('#auth-submit')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const email = (emailEl?.value || state.authEmail || '').trim()
      const password = passwordEl?.value ?? state.authPassword
      if (!email) {
        state.authMsg = '请填写邮箱'
        render()
        return
      }
      if (!password || password.length < 6) {
        state.authMsg = '密码至少 6 位'
        render()
        return
      }
      state.authBusy = true
      state.authMsg = ''
      state.authEmail = email
      state.authPassword = password
      state.actionBusyLabel = state.authMode === 'register' ? '注册中…' : '登录中…'
      render()
      mountBusyOverlay()
      try {
        if (state.authMode === 'register') {
          const data = await signUpWithPassword(email, password)
          if (data?.session) {
            state.authPassword = ''
            state.authMsg = ''
          } else {
            state.authMsg =
              '注册成功。若未自动登录，请到邮箱点确认链接，或在 Supabase 关闭「Confirm email」后直接登录'
            state.authMode = 'login'
          }
        } else {
          await signInWithPassword(email, password)
          state.authPassword = ''
          state.authMsg = ''
        }
      } catch (err) {
        state.authMsg = err.message || String(err)
      } finally {
        state.authBusy = false
        unmountBusyOverlay()
        render()
      }
    }),
  )
}

async function bootStore() {
  state.storeReady = false
  state.storeError = ''
  render()
  try {
    const mig = await migrateLocalIfNeeded()
    await refreshStore({
      page: 1,
      query: state.query,
      tags: state.filterTags,
      readFilter: state.readFilter,
    })
    state.storeReady = true
    if (mig.migrated && mig.count) {
      queueMicrotask(() => alert(`已将本地 ${mig.count} 本书同步到云端`))
    }
  } catch (err) {
    state.storeError =
      (err.message || String(err)) +
      '（若提示找不到表，请先在 Supabase SQL Editor 执行 supabase/schema.sql）'
  }
  render()
}

/** 按当前筛选重新拉取某一页 */
async function reloadLibrary(page = 1) {
  await loadNovelsPage({
    page,
    query: state.query,
    tags: state.filterTags,
    readFilter: state.readFilter,
  })
}

function renderLibrary() {
  const novels = searchNovels({
    query: state.query,
    tags: state.filterTags,
    readFilter: state.readFilter,
  })
  const meta = getPageMeta()
  const tags = getAllTags()
  const readTab = (id, label) =>
    `<button type="button" class="read-filter-btn ${state.readFilter === id ? 'active' : ''}" data-read-filter="${id}">${label}</button>`
  const from = meta.total === 0 ? 0 : (meta.page - 1) * meta.pageSize + 1
  const to = Math.min(meta.page * meta.pageSize, meta.total)

  const tagsOpen = Boolean(state.tagsPanelOpen || state.tagManage)
  const tagsSummary = state.filterTags.length
    ? `已选 ${state.filterTags.length} 个：${state.filterTags.slice(0, 3).join('、')}${state.filterTags.length > 3 ? '…' : ''}`
    : '标签筛选'
  return `
    <div class="layout">
      <aside class="sidebar ${tagsOpen ? 'tags-open' : 'tags-collapsed'}">
        <div class="sidebar-head">
          <button type="button" class="tags-toggle" id="toggle-tags-panel" aria-expanded="${tagsOpen ? 'true' : 'false'}">
            <h2>${state.tagManage ? '管理标签' : '标签筛选'}</h2>
            <span class="tags-toggle-caret" aria-hidden="true">${tagsOpen ? '▴' : '▾'}</span>
          </button>
          ${
            tagsOpen
              ? `<button type="button" class="btn ghost sm" id="toggle-tag-manage">${state.tagManage ? '完成' : '管理'}</button>`
              : ''
          }
        </div>
        ${
          tagsOpen
            ? `${
                state.tagManage
                  ? `<p class="muted tag-manage-hint">点 × 删除标签；会从所有小说上移除该标签</p>`
                  : ''
              }
        <div class="tag-list ${state.tagManage ? 'managing' : ''}">
          ${tags
            .map((t) =>
              state.tagManage
                ? `<span class="tag-chip manage" ${tagStyleAttr(t)}>
                    <span class="tag-chip-label">${escapeHtml(t)}</span>
                    <button type="button" class="tag-del" data-del-tag="${escapeHtml(t)}" title="删除标签" aria-label="删除 ${escapeHtml(t)}">×</button>
                  </span>`
                : `<button type="button" class="tag-chip ${state.filterTags.includes(t) ? 'active' : ''}" data-filter-tag="${escapeHtml(t)}" ${tagStyleAttr(t)}>${escapeHtml(t)}</button>`,
            )
            .join('')}
          <button type="button" class="tag-chip add" id="add-tag">+ 新标签</button>
        </div>
        ${
          !state.tagManage && state.filterTags.length
            ? `<div class="clear-wrap">
                <p class="muted filter-hint">${
                  state.filterTags.length === 1
                    ? `已选「${escapeHtml(state.filterTags[0])}」`
                    : `已选 ${state.filterTags.length} 个标签（取交集）`
                }</p>
                <button class="btn ghost sm" id="clear-filters">清除筛选</button>
              </div>`
            : ''
        }`
            : `<button type="button" class="tags-collapsed-chip" id="toggle-tags-panel-chip">${escapeHtml(tagsSummary)}</button>`
        }
      </aside>
      <section class="main-panel">
        <div class="toolbar">
          <h2>小说库</h2>
          <div class="toolbar-right">
            <span class="muted">共 ${meta.total} 本 · 每页 ${PAGE_SIZE}</span>
            <button type="button" class="btn ghost sm" id="random-novel" title="从当前筛选里随机抽一本" ${meta.total ? '' : 'disabled'}>随机</button>
            <button type="button" class="btn ghost sm" id="refresh-library" title="从云端重新拉取书单">刷新</button>
            ${
              novels.length || state.readFilter !== 'all' || meta.total > 0
                ? `<button type="button" class="btn ghost sm ${state.sortMode ? 'active-sort' : ''}" id="toggle-sort-mode">
                    ${state.sortMode ? '完成排序' : '排序'}
                  </button>`
                : ''
            }
          </div>
        </div>
        <div class="read-filter" role="tablist" aria-label="书架筛选">
          ${readTab('all', '全部')}
          ${readTab('unread', '未读')}
          ${readTab('read', '已读')}
          ${readTab('want', '很想看')}
        </div>
        ${
          state.sortMode && novels.length
            ? `<p class="muted sort-hint">把最想看的排到前面：置顶 / 上移 / 下移（顺序会保存）</p>`
            : ''
        }
        ${
          novels.length
            ? `<div class="novel-list ${state.sortMode ? 'sorting' : ''}">
                ${novels.map((n, i) => renderCard(n, i, novels.length)).join('')}
              </div>
              <div class="pager" aria-label="分页">
                <button type="button" class="btn ghost sm" id="page-prev" ${meta.page <= 1 ? 'disabled' : ''}>上一页</button>
                <span class="pager-info">${from}-${to} / ${meta.total} · 第 ${meta.page}/${meta.totalPages} 页</span>
                <button type="button" class="btn ghost sm" id="page-next" ${meta.page >= meta.totalPages ? 'disabled' : ''}>下一页</button>
              </div>`
            : `<div class="empty">
                <h3 class="empty-title">${
                  state.readFilter === 'unread'
                    ? '没有未读书'
                    : state.readFilter === 'want'
                      ? '还没有「很想看」'
                      : state.readFilter === 'read'
                        ? '还没有已读书'
                        : state.query || state.filterTags.length
                          ? '没有匹配的书'
                          : '书架还是空的'
                }</h3>
                <p>${
                  state.readFilter === 'all' && !state.query && !state.filterTags.length
                    ? '手动添加一本，或从截图里识别书名。'
                    : state.readFilter === 'want'
                      ? '点卡片上的「很想看」标记后，会出现在这里。'
                      : '换个筛选看看，或点卡片上的「未读/已读」切换状态。'
                }</p>
                <div class="empty-actions">
                  ${
                    state.readFilter !== 'all' || state.query || state.filterTags.length
                      ? `<button class="btn ghost" id="clear-read-filter">看全部</button>`
                      : `<button class="btn" id="add-novel-empty">+ 手动添加一本</button>
                  <button class="btn ghost" data-nav="import">从截图导入</button>`
                  }
                </div>
              </div>`
        }
      </section>
    </div>
  `
}

function formatAttachSize(n) {
  if (!n || n < 1024) return `${n || 0} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function renderRandomModal() {
  const n = state.randomNovel
  if (!n) return ''
  const byline = n.author ? `<p class="random-author">作者：${escapeHtml(n.author)}</p>` : ''
  const rating = clampRating(n.rating)
  const review = (n.review || '').trim()
  const synopsis = (n.synopsis || '').trim()
  const statusTags = (n.tags || []).filter((t) => t !== '未读' && t !== '已读')
  const isTxt =
    n.attachmentPath && isTextAttachment(n.attachmentName, n.attachmentMime, n.attachmentPath)
  const filterNote =
    state.readFilter !== 'all' || state.query || state.filterTags.length
      ? `<p class="muted random-filter-note">来自当前筛选（${
          state.readFilter === 'unread'
            ? '未读'
            : state.readFilter === 'want'
              ? '很想看'
              : state.readFilter === 'read'
                ? '已读'
                : '全部'
        }${state.filterTags.length ? ` · ${escapeHtml(state.filterTags.join('、'))}` : ''}${
          state.query ? ` · 「${escapeHtml(state.query)}」` : ''
        }）</p>`
      : ''
  return `
    <div class="modal-backdrop" id="random-backdrop">
      <div class="modal random-modal" role="dialog" aria-modal="true" aria-labelledby="random-title">
        <p class="random-eyebrow">不知道看什么？抽中了</p>
        <h2 id="random-title">${escapeHtml(n.title)}</h2>
        ${byline}
        ${renderStars(rating)}
        ${
          statusTags.length
            ? `<div class="card-tags random-tags">${statusTags
                .map((t) => `<span ${tagStyleAttr(t)}>${escapeHtml(t)}</span>`)
                .join('')}</div>`
            : ''
        }
        ${review ? `<p class="random-review">${escapeHtml(review)}</p>` : ''}
        ${synopsis ? `<p class="muted random-synopsis">${escapeHtml(synopsis)}</p>` : ''}
        ${filterNote}
        <div class="modal-actions random-actions">
          <button type="button" class="btn ghost" id="random-close">关闭</button>
          <button type="button" class="btn ghost" id="random-view">查看</button>
          ${
            n.attachmentPath
              ? `<button type="button" class="btn ghost" id="random-open-attach">${isTxt ? '阅读' : '打开附件'}</button>`
              : ''
          }
          <button type="button" class="btn" id="random-again">再抽一次</button>
        </div>
      </div>
    </div>
  `
}

async function runRandomPick({ excludeId = '' } = {}) {
  const novel = await pickRandomNovel({
    query: state.query,
    tags: state.filterTags,
    readFilter: state.readFilter,
    excludeId,
  })
  if (!novel) {
    state.randomNovel = null
    alert('当前筛选里没有可抽的书')
    return null
  }
  rememberNovel(novel)
  state.randomNovel = novel
  return novel
}

/** 星星行：卡片可点改分；表单用 data-rating 容器 */
function renderStars(rating, { interactive = false, novelId = '', inputId = '' } = {}) {
  const r = clampRating(rating)
  const stars = [1, 2, 3, 4, 5]
    .map((i) => {
      const on = i <= r
      if (interactive && novelId) {
        return `<button type="button" class="star-btn ${on ? 'on' : ''}" data-rate-novel="${novelId}" data-rate-value="${i}" title="${i} 星" aria-label="${i} 星">${on ? '★' : '☆'}</button>`
      }
      if (interactive && inputId) {
        return `<button type="button" class="star-btn ${on ? 'on' : ''}" data-form-star="${i}" title="${i} 星" aria-label="${i} 星">${on ? '★' : '☆'}</button>`
      }
      return `<span class="star ${on ? 'on' : ''}" aria-hidden="true">${on ? '★' : '☆'}</span>`
    })
    .join('')
  if (inputId) {
    return `<div class="star-picker" id="${inputId}" data-rating="${r}" role="group" aria-label="评分">${stars}<button type="button" class="star-clear" data-form-star="0" ${r ? '' : 'hidden'}>清除</button></div>`
  }
  return `<div class="star-row" role="img" aria-label="${r ? `${r} 星` : '未评分'}">${stars}</div>`
}

function renderCard(n, index = 0, total = 0) {
  const byline = n.author ? ` <span class="by-author">by${escapeHtml(n.author)}</span>` : ''
  const isRead = Boolean(n.isRead)
  const wantToRead = Boolean(n.wantToRead)
  const rating = clampRating(n.rating)
  const isTxt =
    n.attachmentPath && isTextAttachment(n.attachmentName, n.attachmentMime, n.attachmentPath)
  const attach = n.attachmentPath
    ? `<button type="button" class="attach-chip" data-open-attach="${n.id}" title="${escapeHtml(n.attachmentName || '附件')}">${isTxt ? '📖 阅读' : '📎'} ${escapeHtml((n.attachmentName || '附件').slice(0, 14))}${(n.attachmentName || '').length > 14 ? '…' : ''}</button>`
    : ''
  const statusTags = (n.tags || []).filter((t) => t !== '未读' && t !== '已读')
  const reviewLine = (n.review || '').trim()
    ? `<p class="card-review">${escapeHtml(n.review.trim())}</p>`
    : ''
  const sortControls = state.sortMode
    ? `<div class="sort-controls">
        <button type="button" class="btn ghost sm" data-sort="top" data-sort-id="${n.id}" ${index === 0 ? 'disabled' : ''}>置顶</button>
        <button type="button" class="btn ghost sm" data-sort="up" data-sort-id="${n.id}" ${index === 0 ? 'disabled' : ''}>上移</button>
        <button type="button" class="btn ghost sm" data-sort="down" data-sort-id="${n.id}" ${index >= total - 1 ? 'disabled' : ''}>下移</button>
      </div>`
    : ''
  return `
    <div class="swipe-item ${isRead ? 'is-read' : 'is-unread'} ${wantToRead ? 'is-want' : ''} ${state.sortMode ? 'sort-mode' : ''}" data-id="${n.id}" style="animation-delay:${Math.min(index, 8) * 40}ms">
      <div class="swipe-actions">
        <button type="button" class="swipe-btn view" data-view="${n.id}" title="查看" aria-label="查看">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-9.27 3.11-11 7 1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>
        </button>
        <button type="button" class="swipe-btn edit" data-edit="${n.id}" title="编辑" aria-label="编辑">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm14.71-9.04a1 1 0 0 0 0-1.41l-2.51-2.51a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 2z"/></svg>
        </button>
        <button type="button" class="swipe-btn delete" data-del="${n.id}" title="删除" aria-label="删除">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
      <div class="swipe-content">
        ${
          wantToRead
            ? `<span class="want-flag" title="很想看" aria-hidden="true"></span>`
            : ''
        }
        <div class="card-main">
          <div class="card-title-row">
            <h3>${escapeHtml(n.title)}${byline}</h3>
            <button
              type="button"
              class="want-mark ${wantToRead ? 'on' : ''}"
              data-toggle-want="${n.id}"
              title="${wantToRead ? '取消很想看' : '标为很想看'}"
              aria-label="${wantToRead ? '取消很想看' : '标为很想看'}"
              aria-pressed="${wantToRead ? 'true' : 'false'}"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path fill="currentColor" d="M6 2h12a1 1 0 0 1 1 1v18.2a.5.5 0 0 1-.8.4L12 17.2l-6.2 4.4a.5.5 0 0 1-.8-.4V3a1 1 0 0 1 1-1z"/>
              </svg>
            </button>
          </div>
          ${reviewLine}
          <div class="card-tags">
            <button
              type="button"
              class="read-chip ${isRead ? 'read' : 'unread'}"
              data-toggle-read="${n.id}"
              title="${isRead ? '点一下标为未读' : '点一下标为已读'}"
              aria-pressed="${isRead ? 'true' : 'false'}"
            >${isRead ? '✓ 已读' : '未读'}</button>
            ${statusTags.map((t) => `<span ${tagStyleAttr(t)}>${escapeHtml(t)}</span>`).join('')}
            ${attach}
          </div>
          <div class="card-rating-row">
            ${renderStars(rating, { interactive: !state.sortMode, novelId: n.id })}
          </div>
        </div>
        ${sortControls}
        ${state.sortMode ? '' : `<span class="swipe-hint">← 左滑</span>`}
      </div>
    </div>
  `
}

const SHEET_COLS = ['title', 'author', 'synopsis', 'tags']
const SHEET_MIN_ROWS = 12

function emptySheetRow() {
  return { title: '', author: '', synopsis: '', tags: ['未读'] }
}

function ensureSheetRows(min = SHEET_MIN_ROWS) {
  if (!Array.isArray(state.excelDrafts)) state.excelDrafts = []
  while (state.excelDrafts.length < min) state.excelDrafts.push(emptySheetRow())
}

function sheetTagsText(tags) {
  return Array.isArray(tags) ? tags.join(',') : String(tags || '')
}

function parseSheetTags(raw, { fallbackUnread = false } = {}) {
  const tags = String(raw ?? '')
    .split(/[,，、;；|/]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (tags.length) return tags
  return fallbackUnread ? ['未读'] : []
}

function filledSheetCount() {
  return state.excelDrafts.filter((d) => String(d.title || '').trim()).length
}

/** 从剪贴板文本解析多行（Excel 复制为 TSV） */
function parseClipboardSheet(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line, i, arr) => line.length > 0 || i < arr.length - 1)
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => {
    const cols = line.split('\t')
    // 若粘贴了表头行则跳过语义在调用方处理
    return {
      title: (cols[0] || '').trim(),
      author: (cols[1] || '').trim(),
      synopsis: (cols[2] || '').trim(),
      tags: parseSheetTags(cols[3], { fallbackUnread: true }),
    }
  })
}

function looksLikeSheetHeader(row) {
  const t = normHeader(row.title)
  return t === '书名' || t === 'title' || t === '名称' || t === '小说名'
}

function normHeader(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

function renderExcel() {
  ensureSheetRows()
  const { excelDrafts, excelInfo, excelImporting } = state
  const filled = filledSheetCount()
  return `
    <div class="page-head">
      <h2>表格录入</h2>
      <p class="muted">像 Excel 一样直接填格子；也可从 Excel 复制后粘贴进来 · 支持上传 .xlsx / .csv</p>
    </div>
    <section class="panel sheet-panel">
      <div class="sheet-toolbar">
        <div class="excel-actions">
          <button class="btn" id="excel-save-all" type="button" ${excelImporting || !filled ? 'disabled' : ''}>
            ${excelImporting ? '入库中…' : `全部入库${filled ? `（${filled}）` : ''}`}
          </button>
          <button class="btn ghost" id="excel-add-rows" type="button">+ 加 5 行</button>
          <button class="btn ghost" id="excel-clear" type="button">清空</button>
          <button class="btn ghost" id="excel-template" type="button">下载模板</button>
          <button class="btn ghost" id="excel-pick" type="button">上传文件</button>
          <input type="file" id="excel-input" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv" hidden />
        </div>
        ${excelInfo ? `<p class="muted sheet-info">${escapeHtml(excelInfo)}</p>` : `<p class="muted sheet-info">点任意格开始输入；在格子里 Ctrl+V 可粘贴多行</p>`}
      </div>
      <div class="sheet-wrap">
        <table class="sheet-table" id="sheet-table">
          <thead>
            <tr>
              <th class="sheet-num">#</th>
              <th>书名</th>
              <th>作者</th>
              <th>简介</th>
              <th>标签</th>
              <th class="sheet-op"></th>
            </tr>
          </thead>
          <tbody>
            ${excelDrafts
              .map(
                (d, i) => `
              <tr data-sheet-row="${i}">
                <td class="sheet-num">${i + 1}</td>
                <td><input class="sheet-cell" data-row="${i}" data-ex-title="${i}" data-col="0" value="${escapeHtml(d.title)}" placeholder="必填" /></td>
                <td><input class="sheet-cell" data-row="${i}" data-ex-author="${i}" data-col="1" value="${escapeHtml(d.author)}" placeholder="选填" /></td>
                <td><input class="sheet-cell" data-row="${i}" data-ex-synopsis="${i}" data-col="2" value="${escapeHtml(d.synopsis || '')}" placeholder="选填" /></td>
                <td><input class="sheet-cell" data-row="${i}" data-ex-tags="${i}" data-col="3" value="${escapeHtml(sheetTagsText(d.tags))}" placeholder="未读,科幻" /></td>
                <td class="sheet-op"><button type="button" class="sheet-rm" data-rm-excel="${i}" title="删除行" aria-label="删除第 ${i + 1} 行">×</button></td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </section>
  `
}

function renderBatchTagsBar() {
  const tags = getAllTags()
  const selected = state.batchTags || []
  return `
    <div class="batch-tags">
      <div class="batch-tags-head">
        <strong>批量改标签</strong>
        <span class="muted">先点选，再应用到下方全部草稿</span>
      </div>
      <div class="batch-tag-picker" id="batch-tag-picker">
        ${tags
          .map((t) => {
            const on = selected.includes(t)
            return `<button type="button" class="tag-chip ${on ? 'active' : ''}" data-batch-toggle="${escapeHtml(t)}" ${tagStyleAttr(t)}>${escapeHtml(t)}</button>`
          })
          .join('')}
        <button type="button" class="tag-chip add" id="batch-add-tag">+ 新标签</button>
      </div>
      <div class="batch-tags-actions">
        <button class="btn sm" id="batch-tags-replace" type="button" ${selected.length ? '' : 'disabled'}>覆盖全部</button>
        <button class="btn ghost sm" id="batch-tags-append" type="button" ${selected.length ? '' : 'disabled'}>追加到全部</button>
        <button class="btn ghost sm" id="batch-tags-clear" type="button" ${selected.length ? '' : 'disabled'}>清空所选</button>
      </div>
    </div>
  `
}

function renderImport() {
  const { recognizing, progress, importDrafts, rawOcr, importFiles } = state
  return `
    <div class="page-head">
      <h2>截图导入</h2>
      <p class="muted">识别在手机/浏览器本地跑，首次会下载中文字库，可能要等一会儿；裁小图、少张图会更快</p>
    </div>
    <div class="import-layout">
      <section>
        <div class="dropzone" id="dropzone">
          <div class="dropzone-icon">图</div>
          <p>拖拽截图 / 封面到这里</p>
          <span class="muted">支持多张 · 点图裁剪 · 点 × 移除</span>
          <button class="btn" id="pick-files" type="button">选择文件</button>
          <input type="file" id="file-input" accept="image/*" multiple hidden />
        </div>
        ${
          importFiles.length
            ? `<div class="thumbs">${importFiles
                .map(
                  (f, i) => `
                  <div class="thumb-wrap">
                    <button type="button" class="thumb-btn" data-crop-file="${i}" title="点击裁剪">
                      <img class="thumb" src="${f.preview}" alt="" />
                      <span class="thumb-crop-hint">裁剪</span>
                    </button>
                    <button type="button" class="thumb-rm" data-rm-file="${i}" title="移除" aria-label="移除">×</button>
                  </div>`,
                )
                .join('')}</div>
              <p class="muted thumb-tip">点缩略图可裁剪；点 × 移除</p>`
            : ''
        }
        <div class="progress-box">
          ${
            recognizing
              ? `<div class="progress-meta">${escapeHtml(progress.label)}</div>
                 <div class="progress-bar"><span style="width:${progress.pct}%"></span></div>`
              : importFiles.length
                ? `<button class="btn" id="start-ocr">开始识别</button>
                   <button class="btn ghost" id="save-to-gallery" type="button">存入图库</button>
                   <button class="btn ghost" id="clear-files">清空图片</button>
                   <button class="btn ghost" id="copy-ocr-text" type="button" ${rawOcr.trim() ? '' : 'disabled'}>复制文字</button>`
                : ''
          }
        </div>
        ${state.importMsg ? `<p class="muted" style="margin:8px 0 0">${escapeHtml(state.importMsg)}</p>` : ''}
        ${
          rawOcr !== ''
            ? `<div class="raw-ocr-panel">
                <div class="raw-ocr-head">
                  <strong>OCR 原文</strong>
                  <span class="muted">可直接改错字 / 删行，核验完再生成</span>
                </div>
                <textarea id="raw-ocr-text" class="raw-ocr-edit" rows="14">${escapeHtml(rawOcr)}</textarea>
                <div class="raw-ocr-actions">
                  <button class="btn" id="parse-ocr" type="button">生成条目</button>
                  <button class="btn ghost" id="clear-drafts" type="button">清空条目</button>
                  <button class="btn ghost" id="clear-ocr" type="button">清空原文</button>
                  <button class="btn ghost" id="add-manual-draft" type="button">增加条目</button>
                </div>
              </div>`
            : ''
        }
      </section>
      <section class="panel">
        <h2>核对后入库 ${importDrafts.length ? `（${importDrafts.length} 本）` : ''}</h2>
        ${
          importDrafts.length
            ? `${renderBatchTagsBar()}
              <div class="draft-list">
                ${importDrafts
                  .map(
                    (d, i) => `
                  <div class="draft-item" data-draft="${i}">
                    <label>书名<input data-d-title="${i}" value="${escapeHtml(d.title)}" /></label>
                    <label>作者（选填）<input data-d-author="${i}" value="${escapeHtml(d.author)}" placeholder="有同名时建议填写" /></label>
                    <label>简介<textarea data-d-synopsis="${i}" rows="2">${escapeHtml(d.synopsis || '')}</textarea></label>
                    <label>标签（逗号分隔）<input data-d-tags="${i}" value="${escapeHtml((d.tags || []).join(','))}" placeholder="未读,科幻" /></label>
                    <div class="draft-actions">
                      <button class="btn sm" data-save-draft="${i}">入库</button>
                      <button class="btn ghost sm" data-rm-draft="${i}">移除</button>
                    </div>
                  </div>`,
                  )
                  .join('')}
              </div>
              <div class="draft-bulk-actions">
                <button class="btn" id="save-all-drafts">全部入库</button>
                <button class="btn ghost" id="add-manual-draft-side" type="button">增加条目</button>
                <button class="btn ghost" id="clear-drafts-side" type="button">清空条目</button>
              </div>`
            : `<p class="muted">${
                rawOcr !== ''
                  ? '左侧核验完原文后，点「生成条目」会出现在这里；也可点「增加条目」手填。'
                  : '可先识别截图，或直接点下方手动加一本。'
              }</p>
              <button class="btn ghost" id="add-manual-draft-empty" type="button" style="margin-top:10px">+ 增加条目</button>`
        }
      </section>
    </div>
  `
}

function renderGallery() {
  const { galleryItems, gallerySelected, galleryLoading, galleryMsg } = state
  const selected = new Set(gallerySelected)
  return `
    <div class="page-head">
      <h2>图库</h2>
      <p class="muted">截图保存在本机浏览器里，可随时取回识别 · 共 ${galleryItems.length} 张</p>
    </div>
    <div class="gallery-toolbar">
      <button class="btn" id="gallery-use-import" type="button" ${selected.size ? '' : 'disabled'}>
        用于识别${selected.size ? `（${selected.size}）` : ''}
      </button>
      <button class="btn ghost" id="gallery-del-selected" type="button" ${selected.size ? '' : 'disabled'}>
        删除所选
      </button>
      <button class="btn ghost" id="gallery-select-all" type="button" ${galleryItems.length ? '' : 'disabled'}>
        ${selected.size === galleryItems.length && galleryItems.length ? '取消全选' : '全选'}
      </button>
      ${galleryMsg ? `<span class="muted">${escapeHtml(galleryMsg)}</span>` : ''}
    </div>
    ${
      galleryLoading
        ? `<p class="muted">加载中…</p>`
        : galleryItems.length
          ? `<div class="gallery-grid">
              ${galleryItems
                .map((item) => {
                  const on = selected.has(item.id)
                  return `
                  <article class="gallery-card ${on ? 'selected' : ''}" data-gallery-id="${item.id}">
                    <label class="gallery-check">
                      <input type="checkbox" data-gallery-select="${item.id}" ${on ? 'checked' : ''} />
                    </label>
                    <button type="button" class="gallery-thumb" data-gallery-preview="${item.id}" title="查看大图">
                      <img src="${item.preview}" alt="${escapeHtml(item.name)}" />
                    </button>
                    <div class="gallery-meta">
                      <div class="gallery-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
                      <div class="muted">${formatTime(item.createdAt)} · ${formatBytes(item.size)}</div>
                    </div>
                    <button type="button" class="btn ghost sm" data-gallery-del="${item.id}">删除</button>
                  </article>`
                })
                .join('')}
            </div>`
          : `<div class="empty">
              <h3 class="empty-title">图库还是空的</h3>
              <p>在「截图导入」里选好图后，点「存入图库」即可。</p>
              <div class="empty-actions">
                <button class="btn" data-nav="import">去截图导入</button>
              </div>
            </div>`
    }
  `
}

function readerProgressKey(novelId) {
  return `novel-reader-progress:${novelId || ''}`
}

function saveReaderProgress() {
  if (!state.readerNovelId) return
  const body = app.querySelector('#reader-body')
  try {
    localStorage.setItem(
      readerProgressKey(state.readerNovelId),
      JSON.stringify({
        scrollTop: body?.scrollTop || 0,
        percent: state.readerPercent || 0,
        page: state.readerPage || 1,
        encoding: state.readerEncoding || 'auto',
      }),
    )
  } catch {
    /* ignore quota */
  }
}

function loadReaderProgress(novelId) {
  try {
    const raw = localStorage.getItem(readerProgressKey(novelId))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

let readerSeeking = false

function getReaderScrollMetrics() {
  const body = app.querySelector('#reader-body')
  if (!body) return null
  const viewH = Math.max(1, body.clientHeight)
  const totalH = Math.max(viewH, body.scrollHeight)
  const maxScroll = Math.max(0, totalH - viewH)
  return { body, viewH, totalH, maxScroll }
}

function updateReaderProgressUi() {
  const m = getReaderScrollMetrics()
  const slider = app.querySelector('#reader-progress-slider')
  const fill = app.querySelector('#reader-progress-fill')
  const pageLabel = app.querySelector('#reader-page-label')
  const pctLabel = app.querySelector('#reader-pct-label')
  if (!m) return

  const { body, viewH, totalH, maxScroll } = m
  const scroll = body.scrollTop
  const totalPages = Math.max(1, Math.ceil(totalH / viewH))
  const page =
    maxScroll <= 0
      ? 1
      : scroll + viewH >= totalH - 4
        ? totalPages
        : Math.min(totalPages, Math.floor(scroll / viewH) + 1)
  const percent = maxScroll <= 0 ? 100 : Math.min(100, Math.round((scroll / maxScroll) * 100))

  state.readerPage = page
  state.readerTotalPages = totalPages
  state.readerPercent = percent

  if (!readerSeeking) {
    if (slider) slider.value = String(percent)
    if (fill) fill.style.width = `${percent}%`
  }
  if (pageLabel) pageLabel.textContent = `${page} / ${totalPages}`
  if (pctLabel) pctLabel.textContent = `${percent}%`
  if (!readerSeeking) saveReaderProgress()
}

function seekReaderByPercent(percent) {
  const m = getReaderScrollMetrics()
  const fill = app.querySelector('#reader-progress-fill')
  const pageLabel = app.querySelector('#reader-page-label')
  const pctLabel = app.querySelector('#reader-pct-label')
  if (!m) return
  const pct = Math.max(0, Math.min(100, Number(percent) || 0))
  const { body, viewH, totalH, maxScroll } = m
  body.scrollTop = maxScroll <= 0 ? 0 : (pct / 100) * maxScroll
  if (fill) fill.style.width = `${pct}%`

  const scroll = body.scrollTop
  const totalPages = Math.max(1, Math.ceil(totalH / viewH))
  const page =
    maxScroll <= 0
      ? 1
      : scroll + viewH >= totalH - 4
        ? totalPages
        : Math.min(totalPages, Math.floor(scroll / viewH) + 1)
  state.readerPage = page
  state.readerTotalPages = totalPages
  state.readerPercent = pct
  if (pageLabel) pageLabel.textContent = `${page} / ${totalPages}`
  if (pctLabel) pctLabel.textContent = `${Math.round(pct)}%`
}

const READER_THEMES = ['parchment', 'eye-care', 'night', 'custom']
const READER_LS = {
  theme: 'novel-reader-theme',
  bg: 'novel-reader-custom-bg',
  fg: 'novel-reader-custom-fg',
  bgImage: 'novel-reader-custom-bg-image',
}

function saveReaderPref(key, value) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch (err) {
    if (String(err?.name || err).includes('Quota')) {
      alert('本地存储空间不足，背景图可能过大，请换一张更小的图')
    }
  }
}

function hexToRgba(hex, alpha) {
  const m = String(hex || '')
    .trim()
    .match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return `rgba(0,0,0,${alpha})`
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function applyReaderAppearance(shell = app.querySelector('#txt-reader')) {
  if (!shell) return
  const theme = READER_THEMES.includes(state.readerTheme) ? state.readerTheme : 'parchment'
  shell.classList.remove('theme-parchment', 'theme-eye-care', 'theme-night', 'theme-custom', 'has-bg-image')
  shell.classList.add(`theme-${theme}`)

  const body = shell.querySelector('#reader-body')
  if (theme === 'custom') {
    const bg = state.readerCustomBg || '#f7f3ea'
    const fg = state.readerCustomFg || '#2a241c'
    shell.style.setProperty('--reader-bg', bg)
    shell.style.setProperty('--reader-fg', fg)
    shell.style.setProperty('--reader-muted', hexToRgba(fg, 0.65))
    shell.style.setProperty('--reader-line', hexToRgba(fg, 0.14))
    shell.style.setProperty('--reader-panel', hexToRgba(bg, 0.92))
    shell.style.setProperty('--reader-track', hexToRgba(fg, 0.12))
    shell.style.setProperty('--reader-thumb', fg)
    shell.style.setProperty('--reader-fill', `linear-gradient(90deg, ${hexToRgba(fg, 0.45)}, ${fg})`)
    shell.style.setProperty('--reader-accent', fg)
    if (state.readerCustomBgImage) {
      shell.classList.add('has-bg-image')
      shell.style.setProperty('--reader-bg-image', `url("${state.readerCustomBgImage}")`)
      if (body) {
        body.style.backgroundImage = `url("${state.readerCustomBgImage}")`
        body.style.backgroundSize = 'cover'
        body.style.backgroundPosition = 'center'
        body.style.backgroundAttachment = 'local'
        body.style.backgroundColor = bg
      }
    } else {
      shell.style.removeProperty('--reader-bg-image')
      if (body) {
        body.style.backgroundImage = ''
        body.style.backgroundSize = ''
        body.style.backgroundPosition = ''
        body.style.backgroundAttachment = ''
        body.style.backgroundColor = ''
      }
    }
  } else {
    ;[
      '--reader-bg',
      '--reader-fg',
      '--reader-muted',
      '--reader-line',
      '--reader-panel',
      '--reader-track',
      '--reader-thumb',
      '--reader-fill',
      '--reader-accent',
      '--reader-bg-image',
    ].forEach((k) => shell.style.removeProperty(k))
    if (body) {
      body.style.backgroundImage = ''
      body.style.backgroundSize = ''
      body.style.backgroundPosition = ''
      body.style.backgroundAttachment = ''
      body.style.backgroundColor = ''
    }
  }

  app.querySelectorAll('[data-reader-theme]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.readerTheme === theme)
  })
  const customPanel = app.querySelector('#reader-custom-panel')
  if (customPanel) customPanel.hidden = theme !== 'custom'
}

function setReaderTheme(theme) {
  const next = READER_THEMES.includes(theme) ? theme : 'parchment'
  state.readerTheme = next
  saveReaderPref(READER_LS.theme, next)
  applyReaderAppearance()
}

function setReaderCustomColors({ bg, fg } = {}) {
  if (bg) {
    state.readerCustomBg = bg
    saveReaderPref(READER_LS.bg, bg)
  }
  if (fg) {
    state.readerCustomFg = fg
    saveReaderPref(READER_LS.fg, fg)
  }
  if (state.readerTheme !== 'custom') setReaderTheme('custom')
  else applyReaderAppearance()
}

async function compressImageFile(file, maxSide = 1280, quality = 0.72) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  const dataUrl = canvas.toDataURL('image/jpeg', quality)
  if (dataUrl.length > 1_800_000) {
    return canvas.toDataURL('image/jpeg', 0.55)
  }
  return dataUrl
}

async function setReaderBgImageFromFile(file) {
  if (!file) return
  if (!file.type.startsWith('image/')) {
    alert('请选择图片文件')
    return
  }
  const dataUrl = await compressImageFile(file)
  state.readerCustomBgImage = dataUrl
  saveReaderPref(READER_LS.bgImage, dataUrl)
  if (state.readerTheme !== 'custom') setReaderTheme('custom')
  else applyReaderAppearance()
}

function clearReaderBgImage() {
  state.readerCustomBgImage = ''
  saveReaderPref(READER_LS.bgImage, '')
  applyReaderAppearance()
}

function renderTxtReader() {
  const size = state.readerFontSize || 18
  const enc = state.readerEncoding || 'auto'
  const theme = READER_THEMES.includes(state.readerTheme) ? state.readerTheme : 'parchment'
  const bg = state.readerCustomBg || '#f7f3ea'
  const fg = state.readerCustomFg || '#2a241c'
  const hasImg = Boolean(state.readerCustomBgImage)
  const settingsOpen = Boolean(state.readerSettingsOpen)
  const progressOpen = Boolean(state.readerProgressOpen)
  const themeLabel =
    theme === 'eye-care' ? '护眼绿' : theme === 'night' ? '深夜' : theme === 'custom' ? '自定义' : '米白'
  const encLabel =
    enc === 'gbk' ? 'GBK' : enc === 'utf-8' ? 'UTF-8' : enc === 'utf-16le' || enc === 'utf-16be' ? 'UTF-16' : '自动'
  const pageNow = state.readerPage || 1
  const pageTotal = state.readerTotalPages || 1
  const pctNow = state.readerPercent || 0
  const encBtn = (id, label) =>
    `<button type="button" class="btn ghost sm reader-enc ${enc === id ? 'active' : ''}" data-reader-enc="${id}">${label}</button>`
  const themeBtn = (id, label, swatch) =>
    `<button type="button" class="reader-theme-btn ${theme === id ? 'active' : ''}" data-reader-theme="${id}" title="${label}" aria-label="${label}">
      <span class="reader-theme-swatch" style="--swatch:${swatch}"></span>
      <span>${label}</span>
    </button>`
  return `
    <div class="reader-shell theme-${theme}${theme === 'custom' && hasImg ? ' has-bg-image' : ''}" id="txt-reader" role="dialog" aria-modal="true" aria-label="TXT 阅读器">
      <header class="reader-bar">
        <button type="button" class="btn ghost sm" id="reader-close">关闭</button>
        <h2 class="reader-title">${escapeHtml(state.readerTitle || '阅读')}</h2>
        <div class="reader-tools">
          <button type="button" class="btn ghost sm" id="reader-font-down" title="缩小字号">A-</button>
          <button type="button" class="btn ghost sm" id="reader-font-up" title="放大字号">A+</button>
          <button type="button" class="btn ghost sm ${settingsOpen ? 'active-settings' : ''}" id="reader-settings-toggle" aria-expanded="${settingsOpen ? 'true' : 'false'}" title="背景与编码">设置</button>
          <button type="button" class="btn ghost sm ${progressOpen ? 'active-settings' : ''}" id="reader-progress-toggle" aria-expanded="${progressOpen ? 'true' : 'false'}" title="阅读进度">进度</button>
        </div>
      </header>
      <div class="reader-settings-bar" id="reader-settings-bar" ${settingsOpen ? '' : 'hidden'}>
        <div class="reader-setting-row">
          <span class="reader-setting-label">背景</span>
          <div class="reader-theme-list">
            ${themeBtn('parchment', '米白', '#f7f3ea')}
            ${themeBtn('eye-care', '护眼绿', '#c7e0c4')}
            ${themeBtn('night', '深夜', '#2b2f33')}
            ${themeBtn('custom', '自定义', bg)}
          </div>
        </div>
        <div class="reader-custom-panel" id="reader-custom-panel" ${theme === 'custom' ? '' : 'hidden'}>
          <div class="reader-setting-row">
            <label class="reader-color-field">
              <span>底色</span>
              <input type="color" id="reader-bg-color" value="${escapeHtml(bg)}" aria-label="背景颜色" />
            </label>
            <label class="reader-color-field">
              <span>字色</span>
              <input type="color" id="reader-fg-color" value="${escapeHtml(fg)}" aria-label="字体颜色" />
            </label>
            <label class="btn ghost sm reader-file-btn">
              背景图
              <input type="file" id="reader-bg-image" accept="image/*" hidden />
            </label>
            <button type="button" class="btn ghost sm" id="reader-bg-image-clear" ${hasImg ? '' : 'hidden'}>清除图片</button>
          </div>
        </div>
        <div class="reader-setting-row">
          <span class="reader-setting-label">编码</span>
          <div class="reader-enc-list">
            ${encBtn('auto', '自动')}
            ${encBtn('gbk', 'GBK')}
            ${encBtn('utf-8', 'UTF-8')}
            ${encBtn('utf-16le', 'UTF-16')}
          </div>
        </div>
      </div>
      ${
        settingsOpen
          ? ''
          : `<button type="button" class="reader-settings-chip" id="reader-settings-chip" title="展开背景与编码设置">${escapeHtml(themeLabel)} · ${escapeHtml(encLabel)} ▾</button>`
      }
      <div class="reader-body" id="reader-body" style="font-size:${size}px">
        ${
          state.readerError
            ? `<p class="error-text">${escapeHtml(state.readerError)}</p>`
            : `<pre class="reader-text">${escapeHtml(state.readerText)}</pre>`
        }
      </div>
      ${
        progressOpen
          ? `<footer class="reader-progress" aria-label="阅读进度">
        <div class="reader-progress-meta">
          <span id="reader-page-label">${pageNow} / ${pageTotal}</span>
          <span id="reader-pct-label">${pctNow}%</span>
          <button type="button" class="btn ghost sm" id="reader-progress-collapse" title="收起进度条">收起</button>
        </div>
        <div class="reader-slider-wrap">
          <div class="reader-progress-track" aria-hidden="true">
            <div class="reader-progress-fill" id="reader-progress-fill" style="width:${pctNow}%"></div>
          </div>
          <input
            type="range"
            id="reader-progress-slider"
            class="reader-progress-slider"
            min="0"
            max="100"
            step="0.1"
            value="${pctNow}"
            aria-label="拖动跳转阅读进度"
          />
        </div>
      </footer>`
          : `<button type="button" class="reader-progress-chip" id="reader-progress-chip" title="展开进度条">
        <span id="reader-page-label">${pageNow} / ${pageTotal}</span>
        <span id="reader-pct-label">${pctNow}%</span>
        <span aria-hidden="true">▴</span>
      </button>`
      }
    </div>
  `
}

async function applyReaderEncoding(encoding) {
  if (!state.readerBuffer) return
  state.readerEncoding = encoding
  const { text, encoding: used } = decodeTextBuffer(state.readerBuffer, encoding)
  state.readerText = text || ''
  state.readerError = text ? '' : '正文为空'
  if (encoding === 'auto') state.readerEncoding = used || 'auto'
  render()
}

function bindTxtReader() {
  if (!state.readerOpen) return
  const close = () => {
    saveReaderProgress()
    state.readerOpen = false
    state.readerText = ''
    state.readerError = ''
    state.readerNovelId = null
    state.readerBuffer = null
    state.readerEncoding = 'auto'
    state.readerPage = 1
    state.readerTotalPages = 1
    state.readerPercent = 0
    render()
  }
  app.querySelector('#reader-close')?.addEventListener('click', close)

  const body = app.querySelector('#reader-body')
  const refreshPages = () => {
    requestAnimationFrame(() => updateReaderProgressUi())
  }

  body?.addEventListener(
    'scroll',
    () => {
      if (readerSeeking) return
      updateReaderProgressUi()
    },
    { passive: true },
  )

  const slider = app.querySelector('#reader-progress-slider')
  const endSeek = () => {
    readerSeeking = false
    updateReaderProgressUi()
    saveReaderProgress()
  }
  slider?.addEventListener('pointerdown', () => {
    readerSeeking = true
  })
  slider?.addEventListener('pointerup', endSeek)
  slider?.addEventListener('pointercancel', endSeek)
  slider?.addEventListener('change', endSeek)
  slider?.addEventListener('input', () => {
    readerSeeking = true
    seekReaderByPercent(slider.value)
  })

  app.querySelector('#reader-font-down')?.addEventListener('click', () => {
    state.readerFontSize = Math.max(14, (state.readerFontSize || 18) - 2)
    if (body) body.style.fontSize = `${state.readerFontSize}px`
    refreshPages()
  })
  app.querySelector('#reader-font-up')?.addEventListener('click', () => {
    state.readerFontSize = Math.min(28, (state.readerFontSize || 18) + 2)
    if (body) body.style.fontSize = `${state.readerFontSize}px`
    refreshPages()
  })
  const toggleReaderSettings = () => {
    state.readerSettingsOpen = !state.readerSettingsOpen
    render()
  }
  app.querySelector('#reader-settings-toggle')?.addEventListener('click', toggleReaderSettings)
  app.querySelector('#reader-settings-chip')?.addEventListener('click', toggleReaderSettings)

  const toggleReaderProgress = () => {
    state.readerProgressOpen = !state.readerProgressOpen
    render()
  }
  app.querySelector('#reader-progress-toggle')?.addEventListener('click', toggleReaderProgress)
  app.querySelector('#reader-progress-chip')?.addEventListener('click', toggleReaderProgress)
  app.querySelector('#reader-progress-collapse')?.addEventListener('click', () => {
    state.readerProgressOpen = false
    render()
  })

  app.querySelectorAll('[data-reader-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setReaderTheme(btn.dataset.readerTheme)
    })
  })

  app.querySelector('#reader-bg-color')?.addEventListener('input', (e) => {
    setReaderCustomColors({ bg: e.target.value })
  })
  app.querySelector('#reader-fg-color')?.addEventListener('input', (e) => {
    setReaderCustomColors({ fg: e.target.value })
  })
  app.querySelector('#reader-bg-image')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      state.actionBusyLabel = '处理背景图…'
      state.actionBusy = true
      mountBusyOverlay()
      await setReaderBgImageFromFile(file)
      const clearBtn = app.querySelector('#reader-bg-image-clear')
      if (clearBtn) clearBtn.hidden = !state.readerCustomBgImage
    } catch (err) {
      alert(err.message || String(err))
    } finally {
      state.actionBusy = false
      unmountBusyOverlay()
    }
  })
  app.querySelector('#reader-bg-image-clear')?.addEventListener('click', () => {
    clearReaderBgImage()
    const clearBtn = app.querySelector('#reader-bg-image-clear')
    if (clearBtn) clearBtn.hidden = true
  })

  applyReaderAppearance()

  app.querySelectorAll('[data-reader-enc]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        state.actionBusyLabel = '切换编码…'
        state.actionBusy = true
        mountBusyOverlay()
        await applyReaderEncoding(btn.dataset.readerEnc)
      } catch (err) {
        alert(err.message || String(err))
      } finally {
        state.actionBusy = false
        unmountBusyOverlay()
      }
    })
  })

  // 恢复阅读位置并刷新页码
  const saved = loadReaderProgress(state.readerNovelId)
  requestAnimationFrame(() => {
    if (body && saved && typeof saved.scrollTop === 'number') {
      body.scrollTop = saved.scrollTop
    }
    updateReaderProgressUi()
  })
}

async function openNovelAttachment(novel) {
  if (!novel?.attachmentPath) {
    alert('没有附件')
    return
  }
  const asText = isTextAttachment(novel.attachmentName, novel.attachmentMime, novel.attachmentPath)
  if (asText) {
    state.actionBusyLabel = '加载正文…'
    state.actionBusy = true
    mountBusyOverlay()
    try {
      const buf = await fetchAttachmentBuffer(novel.attachmentPath)
      const { text, encoding } = await decodeTextBufferAsync(buf, 'auto')
      state.readerBuffer = buf
      state.readerEncoding = encoding || 'auto'
      state.readerOpen = true
      state.readerNovelId = novel.id
      state.readerTitle = novel.title || novel.attachmentName || '阅读'
      state.readerText = text || ''
      state.readerError = text ? '' : '正文为空'
    } catch (err) {
      const msg = String(err?.message || err)
      const friendly = /Importing a module script failed|Failed to fetch dynamically imported module/i.test(
        msg,
      )
        ? '当前手机浏览器加载解码组件失败，请刷新页面后再试；若仍不行，可先用电脑打开该 TXT'
        : msg
      state.readerOpen = true
      state.readerNovelId = novel.id
      state.readerTitle = novel.title || novel.attachmentName || '阅读'
      state.readerText = ''
      state.readerBuffer = null
      state.readerError = friendly
      alert(friendly)
    } finally {
      state.actionBusy = false
      unmountBusyOverlay()
      render()
      queueMicrotask(() => {
        const body = app.querySelector('#reader-body')
        if (body) body.scrollTop = 0
      })
    }
    return
  }
  state.actionBusyLabel = '打开附件…'
  state.actionBusy = true
  mountBusyOverlay()
  try {
    const url = await getAttachmentSignedUrl(novel.attachmentPath)
    const win = window.open(url, '_blank', 'noopener,noreferrer')
    if (!win) alert('浏览器拦截了新窗口，请允许弹窗后重试')
  } catch (err) {
    alert(err.message || String(err))
  } finally {
    state.actionBusy = false
    unmountBusyOverlay()
  }
}

function renderGalleryLightbox() {
  const item = state.galleryItems.find((x) => x.id === state.galleryPreviewId)
  if (!item) return ''
  return `
    <div class="modal-backdrop gallery-lightbox" id="gallery-lightbox">
      <div class="gallery-lightbox-inner">
        <img src="${item.preview}" alt="${escapeHtml(item.name)}" />
        <div class="gallery-lightbox-bar">
          <span>${escapeHtml(item.name)}</span>
          <button type="button" class="btn ghost sm" id="gallery-lightbox-close">关闭</button>
        </div>
      </div>
    </div>
  `
}

function renderAttachmentField(novel) {
  const pending = state.pendingAttachmentFile
  const cleared = state.pendingAttachmentClear
  const existing = !cleared && novel.attachmentPath ? novel : null
  let status = '未选择（可选）'
  if (pending) {
    status = `待上传：${pending.name}（${formatAttachSize(pending.size)}）`
  } else if (existing) {
    status = `已有：${existing.attachmentName || '附件'}${existing.attachmentSize != null ? `（${formatAttachSize(existing.attachmentSize)}）` : ''}`
  }
  const canClear = Boolean(pending || existing)
  return `
    <div class="field attach-field">
      <span>附件（选填，最大 20MB）</span>
      <div class="attach-row">
        <button type="button" class="btn ghost sm" id="f-attach-pick">选择文件</button>
        ${canClear ? `<button type="button" class="btn ghost sm" id="f-attach-clear">移除</button>` : ''}
        <input type="file" id="f-attach-input" hidden />
      </div>
      <p class="muted attach-status" id="f-attach-status">${escapeHtml(status)}</p>
    </div>
  `
}

function renderViewModal() {
  const novel = getNovel(state.viewingId)
  if (!novel) return ''
  const byline = novel.author ? `<p class="view-meta">作者：${escapeHtml(novel.author)}</p>` : ''
  const rating = clampRating(novel.rating)
  const review = (novel.review || '').trim()
  const synopsis = (novel.synopsis || '').trim()
  const statusTags = (novel.tags || []).filter((t) => t !== '未读' && t !== '已读')
  const isRead = Boolean(novel.isRead)
  const wantToRead = Boolean(novel.wantToRead)
  const isTxt =
    novel.attachmentPath &&
    isTextAttachment(novel.attachmentName, novel.attachmentMime, novel.attachmentPath)
  const attachLine = novel.attachmentPath
    ? `<p class="view-attach"><button type="button" class="btn ghost sm" id="view-open-attach">${isTxt ? '阅读附件' : '打开附件'} · ${escapeHtml(novel.attachmentName || '附件')}${novel.attachmentSize != null ? `（${formatAttachSize(novel.attachmentSize)}）` : ''}</button></p>`
    : ''
  return `
    <div class="modal-backdrop" id="view-backdrop">
      <div class="modal view-modal" role="dialog" aria-modal="true" aria-labelledby="view-title">
        <h2 id="view-title">${escapeHtml(novel.title)}</h2>
        ${byline}
        <div class="view-row">
          ${renderStars(rating)}
          <span class="read-chip ${isRead ? 'read' : 'unread'} view-read-chip">${isRead ? '✓ 已读' : '未读'}</span>
          ${
            wantToRead
              ? `<span class="want-mark on view-want-mark" title="很想看" aria-label="很想看">
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path fill="currentColor" d="M6 2h12a1 1 0 0 1 1 1v18.2a.5.5 0 0 1-.8.4L12 17.2l-6.2 4.4a.5.5 0 0 1-.8-.4V3a1 1 0 0 1 1-1z"/>
                  </svg>
                </span>`
              : ''
          }
        </div>
        ${
          statusTags.length
            ? `<div class="card-tags view-tags">${statusTags
                .map((t) => `<span ${tagStyleAttr(t)}>${escapeHtml(t)}</span>`)
                .join('')}</div>`
            : ''
        }
        <div class="view-block">
          <h3>评价</h3>
          <p class="${review ? '' : 'muted'}">${review ? escapeHtml(review) : '还没有写评价'}</p>
        </div>
        <div class="view-block">
          <h3>简介</h3>
          <p class="${synopsis ? '' : 'muted'}">${synopsis ? escapeHtml(synopsis) : '暂无简介'}</p>
        </div>
        ${attachLine}
        <div class="modal-actions">
          <button type="button" class="btn ghost" id="view-close">关闭</button>
          <button type="button" class="btn" id="view-edit">编辑</button>
        </div>
      </div>
    </div>
  `
}

function renderModal() {
  const isNew = state.editingId === 'new'
  const novel = isNew
    ? { title: '', author: '', synopsis: '', tags: ['未读'], rating: 0, review: '' }
    : getNovel(state.editingId) || { title: '', author: '', synopsis: '', tags: [], rating: 0, review: '' }
  const tags = getAllTags()

  return `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal modal-edit" role="dialog">
        <h2>${isNew ? '添加小说' : '编辑小说'}</h2>
        <p class="error-text" id="form-error" hidden></p>
        <label class="field"><span>书名</span><input id="f-title" value="${escapeHtml(novel.title)}" /></label>
        <label class="field"><span>作者（选填）</span><input id="f-author" value="${escapeHtml(novel.author)}" placeholder="有同名时建议填写" /></label>
        <label class="field"><span>简介</span><textarea id="f-synopsis" rows="8" placeholder="剧情简介、备注…">${escapeHtml(novel.synopsis || '')}</textarea></label>
        <div class="field">
          <span>评分与标记</span>
          <div class="form-mark-row">
            ${renderStars(novel.rating || 0, { interactive: true, inputId: 'f-rating' })}
            <button
              type="button"
              class="want-chip form-want ${novel.wantToRead ? 'on' : ''}"
              id="f-want"
              aria-pressed="${novel.wantToRead ? 'true' : 'false'}"
              title="标为很想看"
            >${novel.wantToRead ? '★ 很想看' : '☆ 很想看'}</button>
          </div>
        </div>
        <label class="field"><span>评价</span><textarea id="f-review" rows="6" placeholder="写几句观感…">${escapeHtml(novel.review || '')}</textarea></label>
        ${renderAttachmentField(novel)}
        <div class="field">
          <span>标签（可多选，也可新增）</span>
          <div class="tag-picker" id="tag-picker">
            ${tags
              .map((t) => {
                const on = (novel.tags || []).includes(t)
                return `<button type="button" class="tag-chip ${on ? 'active' : ''}" data-toggle-tag="${escapeHtml(t)}" ${tagStyleAttr(t)}>${escapeHtml(t)}</button>`
              })
              .join('')}
            <button type="button" class="tag-chip add" id="modal-add-tag">+ 新标签</button>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" id="modal-cancel">取消</button>
          <button class="btn" id="modal-save">保存</button>
        </div>
      </div>
    </div>
  `
}

function bindEvents() {
  app.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard(async () => {
        const page = btn.dataset.nav
        state.page = page
        state.importMsg = ''
        state.galleryMsg = ''
        state.galleryPreviewId = null
        if (page === 'gallery') {
          await runBusy('加载图库…', async () => {
            state.galleryLoading = true
            render()
            await loadGallery()
          })
        }
        render()
      }),
    )
  })

  const search = app.querySelector('#search')
  if (search) {
    const onSearch = debounce(() => {
      state.query = search.value
      const sel = search.selectionStart
      runBusy('搜索…', () => reloadLibrary(1))
        .then(() => {
          render()
          const again = app.querySelector('#search')
          if (again) {
            again.focus()
            again.setSelectionRange(sel, sel)
          }
        })
        .catch((err) => alert(err.message || String(err)))
    }, 320)
    search.addEventListener('input', onSearch)
  }

  const setTagsPanelOpen = (open) => {
    state.tagsPanelOpen = Boolean(open)
    try {
      localStorage.setItem('novel-tags-panel-open', state.tagsPanelOpen ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  app.querySelector('#toggle-tags-panel')?.addEventListener('click', () => {
    if (state.tagManage) {
      state.tagManage = false
      setTagsPanelOpen(false)
    } else {
      setTagsPanelOpen(!state.tagsPanelOpen)
    }
    render()
  })
  app.querySelector('#toggle-tags-panel-chip')?.addEventListener('click', () => {
    setTagsPanelOpen(true)
    render()
  })
  app.querySelector('#toggle-tag-manage')?.addEventListener('click', () => {
    state.tagManage = !state.tagManage
    if (state.tagManage) setTagsPanelOpen(true)
    render()
  })

  app.querySelector('#toggle-sort-mode')?.addEventListener('click', () => {
    state.sortMode = !state.sortMode
    render()
  })

  app.querySelector('#refresh-library')?.addEventListener(
    'click',
    withClickGuard(async () => {
      try {
        const meta = getPageMeta()
        await runBusy('刷新书单…', () =>
          refreshStore({
            page: meta.page || 1,
            query: state.query,
            tags: state.filterTags,
            readFilter: state.readFilter,
          }),
        )
        render()
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )

  app.querySelector('#random-novel')?.addEventListener(
    'click',
    withClickGuard(async () => {
      try {
        await runBusy('抽一本…', () => runRandomPick())
        render()
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )

  app.querySelector('#page-prev')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const meta = getPageMeta()
      if (meta.page <= 1) return
      try {
        await runBusy('加载上一页…', () => reloadLibrary(meta.page - 1))
        render()
        window.scrollTo(0, 0)
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )
  app.querySelector('#page-next')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const meta = getPageMeta()
      if (meta.page >= meta.totalPages) return
      try {
        await runBusy('加载下一页…', () => reloadLibrary(meta.page + 1))
        render()
        window.scrollTo(0, 0)
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )

  app.querySelectorAll('[data-sort]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard(async (e) => {
        e.stopPropagation()
        const id = btn.dataset.sortId
        const action = btn.dataset.sort
        const visibleIds = [...app.querySelectorAll('.novel-list .swipe-item')].map((el) => el.dataset.id)
        try {
          const moved = await runBusy('排序中…', () => moveNovelInView(visibleIds, id, action))
          if (moved) render()
        } catch (err) {
          alert(err.message || String(err))
        }
      }),
    )
  })

  app.querySelectorAll('[data-filter-tag]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard(async () => {
        const t = btn.dataset.filterTag
        if (state.filterTags.includes(t)) {
          state.filterTags = state.filterTags.filter((x) => x !== t)
        } else {
          state.filterTags = [...state.filterTags, t]
        }
        try {
          await runBusy('筛选中…', () => reloadLibrary(1))
          render()
        } catch (err) {
          alert(err.message || String(err))
        }
      }),
    )
  })

  app.querySelectorAll('[data-del-tag]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard(async (e) => {
        e.stopPropagation()
        const t = btn.dataset.delTag
        let used = 0
        try {
          used = await countNovelsWithTag(t)
        } catch {
          used = 0
        }
        const msg =
          used > 0
            ? `确定删除标签「${t}」？\n将从 ${used} 本小说上移除该标签。`
            : `确定删除标签「${t}」？`
        if (!(await askConfirm(msg))) return
        try {
          await runBusy('删除标签…', async () => {
            await deleteTag(t)
            state.filterTags = state.filterTags.filter((x) => x !== t)
            state.batchTags = (state.batchTags || []).filter((x) => x !== t)
            await reloadLibrary(1)
          })
          render()
        } catch (err) {
          alert(err.message || String(err))
        }
      }),
    )
  })

  app.querySelector('#clear-filters')?.addEventListener(
    'click',
    withClickGuard(async () => {
      state.filterTags = []
      try {
        await runBusy('清除筛选…', () => reloadLibrary(1))
        render()
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )

  app.querySelectorAll('[data-read-filter]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard(async () => {
        state.readFilter = btn.dataset.readFilter || 'all'
        try {
          await runBusy('筛选中…', () => reloadLibrary(1))
          render()
        } catch (err) {
          alert(err.message || String(err))
        }
      }),
    )
  })
  app.querySelector('#clear-read-filter')?.addEventListener(
    'click',
    withClickGuard(async () => {
      state.readFilter = 'all'
      state.query = ''
      state.filterTags = []
      try {
        await runBusy('加载书单…', () => reloadLibrary(1))
        render()
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )

  app.querySelectorAll('[data-toggle-read]').forEach((btn) => {
    const stop = (e) => e.stopPropagation()
    btn.addEventListener('pointerdown', stop)
    btn.addEventListener('touchstart', stop, { passive: true })
    btn.addEventListener(
      'click',
      withClickGuard(async (e) => {
        e.preventDefault()
        e.stopPropagation()
        const id = btn.dataset.toggleRead
        const novel = getNovel(id)
        if (!novel) return
        try {
          await runBusy(novel.isRead ? '标为未读…' : '标为已读…', async () => {
            await setNovelRead(id, !novel.isRead)
            await reloadLibrary(getPageMeta().page)
          })
          render()
        } catch (err) {
          alert(err.message || String(err))
        }
      }),
    )
  })

  app.querySelectorAll('[data-toggle-want]').forEach((btn) => {
    const stop = (e) => e.stopPropagation()
    btn.addEventListener('pointerdown', stop)
    btn.addEventListener('touchstart', stop, { passive: true })
    btn.addEventListener(
      'click',
      withClickGuard(async (e) => {
        e.preventDefault()
        e.stopPropagation()
        const id = btn.dataset.toggleWant
        const novel = getNovel(id)
        if (!novel) return
        try {
          await runBusy(novel.wantToRead ? '取消很想看…' : '标为很想看…', async () => {
            await setNovelWant(id, !novel.wantToRead)
            await reloadLibrary(getPageMeta().page)
          })
          render()
        } catch (err) {
          alert(err.message || String(err))
        }
      }),
    )
  })

  app.querySelectorAll('[data-rate-novel]').forEach((btn) => {
    const stop = (e) => e.stopPropagation()
    btn.addEventListener('pointerdown', stop)
    btn.addEventListener('touchstart', stop, { passive: true })
    btn.addEventListener(
      'click',
      withClickGuard(async (e) => {
        e.preventDefault()
        e.stopPropagation()
        const id = btn.dataset.rateNovel
        const value = Number(btn.dataset.rateValue)
        if (!id || Number.isNaN(value)) return
        try {
          await runBusy('评分…', async () => {
            await setNovelRating(id, value)
          })
          render()
        } catch (err) {
          alert(err.message || String(err))
        }
      }),
    )
  })

  app.querySelector('#add-tag')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const name = await askText('新标签名称')
      if (name?.trim()) {
        try {
          await runBusy('添加标签…', () => addCustomTag(name.trim()))
          render()
        } catch (err) {
          alert(err.message || String(err))
        }
      }
    }),
  )

  const openAddNovel = withClickGuard(() => {
    state.editingId = 'new'
    state.viewingId = null
    state.pendingAttachmentFile = null
    state.pendingAttachmentClear = false
    render()
  })
  app.querySelector('#add-novel-primary')?.addEventListener('click', openAddNovel)
  app.querySelector('#add-novel-empty')?.addEventListener('click', openAddNovel)

  const accountBtn = app.querySelector('#account-menu-btn')
  const accountDrop = app.querySelector('#account-dropdown')
  accountBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    const open = accountDrop?.hasAttribute('hidden')
    if (!accountDrop) return
    if (open) {
      accountDrop.removeAttribute('hidden')
      accountBtn.setAttribute('aria-expanded', 'true')
    } else {
      accountDrop.setAttribute('hidden', '')
      accountBtn.setAttribute('aria-expanded', 'false')
    }
  })
  document.addEventListener(
    'click',
    (e) => {
      if (!accountDrop || accountDrop.hasAttribute('hidden')) return
      if (e.target?.closest?.('.account-menu')) return
      accountDrop.setAttribute('hidden', '')
      accountBtn?.setAttribute('aria-expanded', 'false')
    },
    { once: true },
  )

  app.querySelector('#sign-out')?.addEventListener(
    'click',
    withClickGuard(async () => {
      await runBusy('退出中…', () => signOut())
    }),
  )

  app.querySelector('#backup-beifen')?.addEventListener(
    'click',
    withClickGuard(async () => {
      try {
        const result = await runBusy('备份中…', () => backupNovelsToBeifen())
        if (result.wroteLocal) {
          alert(`已备份 ${result.count} 本到项目里的 beifen.md，并下载了一份副本`)
        } else {
          alert(
            `已下载 beifen.md（${result.count} 本）。\n请把它保存/覆盖到：\n小说test\\novel-app\\beifen.md\n\n（本地 npm run dev 时会自动写入该文件）`,
          )
        }
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )

  app.querySelector('#restore-beifen')?.addEventListener(
    'click',
    withClickGuard(async () => {
      try {
        let text = await loadBeifenText()
        const fromLocal = Boolean(text?.trim())
        if (!fromLocal) {
          if (
            !(await askConfirm(
              '读不到项目里的 beifen.md（线上需手动选文件）。\n是否现在选择备份文件？',
            ))
          ) {
            return
          }
          text = await pickBeifenFile()
        }
        if (!text?.trim()) {
          alert('没有读到备份内容')
          return
        }
        const plan = planRestoreFromMarkdown(text)
        if (!plan.toAdd.length) {
          alert(`备份共 ${plan.total} 本，都已在书架上`)
          return
        }
        if (
          !(await askConfirm(
            `${fromLocal ? '将读取 beifen.md。\n' : ''}将导入 ${plan.toAdd.length} 本${
              plan.skipped ? `（跳过已有 ${plan.skipped} 本）` : ''
            }，确定？`,
          ))
        ) {
          return
        }
        const result = await runBusy('恢复中…', () =>
          applyRestoreNovels(plan.toAdd, {
            onProgress: (label) => {
              state.actionBusyLabel = label
              mountBusyOverlay()
            },
          }),
        )
        if (result.failed.length) {
          alert(
            `已恢复 ${result.ok} 本，失败 ${result.failed.length} 本：\n${result.failed.slice(0, 5).join('\n')}`,
          )
        } else {
          alert(`已从备份恢复 ${result.ok} 本${plan.skipped ? `（跳过已有 ${plan.skipped}）` : ''}`)
        }
        render()
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )

  app.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard((e) => {
        e.stopPropagation()
        state.viewingId = btn.dataset.view
        state.editingId = null
        render()
      }),
    )
  })

  app.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard((e) => {
        e.stopPropagation()
        state.editingId = btn.dataset.edit
        state.viewingId = null
        state.pendingAttachmentFile = null
        state.pendingAttachmentClear = false
        render()
      }),
    )
  })

  app.querySelectorAll('[data-open-attach]').forEach((btn) => {
    const stop = (e) => {
      e.stopPropagation()
    }
    btn.addEventListener('pointerdown', stop)
    btn.addEventListener('touchstart', stop, { passive: true })
    btn.addEventListener(
      'click',
      withClickGuard(async (e) => {
        e.preventDefault()
        e.stopPropagation()
        const novel = getNovel(btn.dataset.openAttach)
        if (!novel?.attachmentPath) {
          alert('没有附件路径，请重新上传附件')
          return
        }
        try {
          await openNovelAttachment(novel)
        } catch (err) {
          alert(err.message || String(err))
        }
      }),
    )
  })

  app.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard(async (e) => {
        e.stopPropagation()
        if (await askConfirm('确定删除这本小说？')) {
          try {
            await runBusy('删除中…', async () => {
              await deleteNovel(btn.dataset.del)
              await reloadLibrary(getPageMeta().page)
            })
            render()
          } catch (err) {
            alert(err.message || String(err))
          }
        }
      }),
    )
  })

  bindSwipe()
  bindModal()
  bindViewModal()
  bindRandomModal()
  bindImport()
  bindExcel()
  bindGallery()
  bindTxtReader()
  bindCropModal()
}

function bindViewModal() {
  if (!state.viewingId) return

  const close = () => {
    state.viewingId = null
    render()
  }

  app.querySelector('#view-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'view-backdrop') close()
  })
  app.querySelector('#view-close')?.addEventListener('click', close)

  app.querySelector('#view-edit')?.addEventListener('click', () => {
    const id = state.viewingId
    if (!id) return
    state.editingId = id
    state.viewingId = null
    state.pendingAttachmentFile = null
    state.pendingAttachmentClear = false
    render()
  })

  app.querySelector('#view-open-attach')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const novel = getNovel(state.viewingId)
      if (!novel?.attachmentPath) return
      try {
        await openNovelAttachment(novel)
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )
}

function bindRandomModal() {
  if (!state.randomNovel) return

  const close = () => {
    state.randomNovel = null
    render()
  }

  app.querySelector('#random-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'random-backdrop') close()
  })
  app.querySelector('#random-close')?.addEventListener('click', close)

  app.querySelector('#random-again')?.addEventListener(
    'click',
    withClickGuard(async () => {
      try {
        await runBusy('再抽一次…', () =>
          runRandomPick({ excludeId: state.randomNovel?.id || '' }),
        )
        render()
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )

  app.querySelector('#random-view')?.addEventListener('click', () => {
    const n = state.randomNovel
    if (!n) return
    rememberNovel(n)
    state.viewingId = n.id
    state.editingId = null
    state.randomNovel = null
    render()
  })

  app.querySelector('#random-open-attach')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const n = state.randomNovel
      if (!n?.attachmentPath) return
      try {
        state.randomNovel = null
        await openNovelAttachment(n)
      } catch (err) {
        alert(err.message || String(err))
        render()
      }
    }),
  )
}

function bindGallery() {
  if (state.page !== 'gallery' && !state.galleryPreviewId) return

  app.querySelectorAll('[data-gallery-select]').forEach((el) => {
    el.addEventListener('change', () => {
      const id = el.dataset.gallerySelect
      if (el.checked) {
        if (!state.gallerySelected.includes(id)) state.gallerySelected = [...state.gallerySelected, id]
      } else {
        state.gallerySelected = state.gallerySelected.filter((x) => x !== id)
      }
      render()
    })
  })

  app.querySelector('#gallery-select-all')?.addEventListener('click', () => {
    if (state.gallerySelected.length === state.galleryItems.length) {
      state.gallerySelected = []
    } else {
      state.gallerySelected = state.galleryItems.map((x) => x.id)
    }
    render()
  })

  app.querySelectorAll('[data-gallery-preview]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.galleryPreviewId = btn.dataset.galleryPreview
      render()
    })
  })

  const closeLightbox = () => {
    state.galleryPreviewId = null
    render()
  }
  app.querySelector('#gallery-lightbox-close')?.addEventListener('click', closeLightbox)
  app.querySelector('#gallery-lightbox')?.addEventListener('click', (e) => {
    if (e.target.id === 'gallery-lightbox') closeLightbox()
  })

  app.querySelectorAll('[data-gallery-del]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard(async () => {
        const id = btn.dataset.galleryDel
        if (!(await askConfirm('确定从本机图库删除这张图？'))) return
        await runBusy('删除中…', async () => {
          await deleteImage(id)
          state.gallerySelected = state.gallerySelected.filter((x) => x !== id)
          if (state.galleryPreviewId === id) state.galleryPreviewId = null
          state.galleryMsg = '已删除'
          await loadGallery()
        })
        render()
      }),
    )
  })

  app.querySelector('#gallery-del-selected')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const ids = [...state.gallerySelected]
      if (!ids.length) return
      if (!(await askConfirm(`确定删除所选 ${ids.length} 张图？`))) return
      await runBusy('删除中…', async () => {
        await deleteImages(ids)
        state.gallerySelected = []
        state.galleryPreviewId = null
        state.galleryMsg = `已删除 ${ids.length} 张`
        await loadGallery()
      })
      render()
    }),
  )

  app.querySelector('#gallery-use-import')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const ids = [...state.gallerySelected]
      if (!ids.length) return
      await runBusy('载入图片…', async () => {
        const next = []
        for (const id of ids) {
          const row = await getImage(id)
          if (!row?.blob) continue
          const file = new File([row.blob], row.name || `截图-${id}.png`, {
            type: row.type || 'image/png',
          })
          next.push({ file, preview: URL.createObjectURL(row.blob) })
        }
        if (!next.length) {
          state.galleryMsg = '未能读取所选图片'
          return
        }
        state.importFiles.forEach((f) => URL.revokeObjectURL(f.preview))
        state.importFiles = next
        state.importDrafts = []
        state.rawOcr = ''
        state.importMsg = `已从图库载入 ${next.length} 张，可开始识别`
        state.gallerySelected = []
        state.galleryPreviewId = null
        state.page = 'import'
      })
      render()
    }),
  )
}

function bindExcel() {
  if (state.page !== 'excel') return
  ensureSheetRows()

  app.querySelector('#excel-template')?.addEventListener(
    'click',
    withClickGuard(() => {
      downloadExcelTemplate()
    }),
  )

  app.querySelector('#excel-add-rows')?.addEventListener('click', () => {
    for (let n = 0; n < 5; n++) state.excelDrafts.push(emptySheetRow())
    render()
  })

  const input = app.querySelector('#excel-input')
  app.querySelector('#excel-pick')?.addEventListener('click', () => input?.click())
  input?.addEventListener('change', async () => {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    try {
      await runBusy('读取表格…', async () => {
        const { rows, sheetName, mapping } = await parseExcelFile(file)
        state.excelDrafts = rows.length ? rows : [emptySheetRow()]
        ensureSheetRows()
        state.excelInfo = `已读取「${file.name}」工作表 ${sheetName} · ${rows.length} 条 · 列映射：书名=${mapping.titleKey}${mapping.authorKey ? `，作者=${mapping.authorKey}` : ''}${mapping.tagsKey ? `，标签=${mapping.tagsKey}` : ''}`
      })
      render()
    } catch (err) {
      alert(err.message || String(err))
    }
  })

  const syncSaveBtn = () => {
    const btn = app.querySelector('#excel-save-all')
    if (!btn || state.excelImporting) return
    const n = filledSheetCount()
    btn.disabled = !n
    btn.textContent = n ? `全部入库（${n}）` : '全部入库'
  }

  ;['title', 'author', 'synopsis', 'tags'].forEach((key) => {
    app.querySelectorAll(`[data-ex-${key}]`).forEach((el) => {
      el.addEventListener('input', () => {
        const i = Number(el.getAttribute(`data-ex-${key}`))
        if (Number.isNaN(i) || !state.excelDrafts[i]) return
        if (key === 'tags') {
          state.excelDrafts[i].tags = parseSheetTags(el.value)
        } else {
          state.excelDrafts[i][key] = el.value
        }
        if (key === 'title') syncSaveBtn()
      })
    })
  })

  const table = app.querySelector('#sheet-table')
  table?.addEventListener('keydown', (e) => {
    const cell = e.target?.closest?.('.sheet-cell')
    if (!cell) return
    const row = Number(cell.dataset.row)
    const col = Number(cell.dataset.col)
    if (Number.isNaN(row) || Number.isNaN(col)) return

    const focusCell = (r, c) => {
      const key = SHEET_COLS[c]
      if (!key) return
      const next = app.querySelector(`[data-ex-${key}="${r}"]`)
      next?.focus()
      next?.select?.()
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (row >= state.excelDrafts.length - 1) {
        state.excelDrafts.push(emptySheetRow())
        const focusRow = row + 1
        const focusCol = col
        render()
        queueMicrotask(() => focusCell(focusRow, focusCol))
      } else {
        focusCell(row + 1, col)
      }
    } else if (e.key === 'ArrowDown' && !e.altKey) {
      e.preventDefault()
      if (row < state.excelDrafts.length - 1) focusCell(row + 1, col)
    } else if (e.key === 'ArrowUp' && !e.altKey) {
      e.preventDefault()
      if (row > 0) focusCell(row - 1, col)
    }
  })

  table?.addEventListener('paste', (e) => {
    const cell = e.target?.closest?.('.sheet-cell')
    if (!cell) return
    const text = e.clipboardData?.getData('text') || ''
    if (!text.includes('\t') && !text.includes('\n')) return // 单格普通粘贴

    e.preventDefault()
    let rows = parseClipboardSheet(text)
    if (rows.length && looksLikeSheetHeader(rows[0])) rows = rows.slice(1)
    if (!rows.length) return

    const startRow = Number(cell.dataset.row) || 0
    const startCol = Number(cell.dataset.col) || 0

    // 从当前格起按列偏移写入（支持从中间列粘贴）
    for (let ri = 0; ri < rows.length; ri++) {
      const r = startRow + ri
      while (state.excelDrafts.length <= r) state.excelDrafts.push(emptySheetRow())
      const src = rows[ri]
      const vals = [src.title, src.author, src.synopsis, sheetTagsText(src.tags)]
      for (let ci = 0; ci < vals.length; ci++) {
        const targetCol = startCol + ci
        if (targetCol >= SHEET_COLS.length) break
        const key = SHEET_COLS[targetCol]
        if (key === 'tags') state.excelDrafts[r].tags = parseSheetTags(vals[ci], { fallbackUnread: true })
        else state.excelDrafts[r][key] = vals[ci]
      }
    }
    ensureSheetRows()
    state.excelInfo = `已粘贴 ${rows.length} 行`
    const focusRow = startRow
    const focusCol = startCol
    render()
    queueMicrotask(() => {
      const key = SHEET_COLS[focusCol]
      app.querySelector(`[data-ex-${key}="${focusRow}"]`)?.focus()
    })
  })

  app.querySelectorAll('[data-rm-excel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.excelDrafts.splice(Number(btn.dataset.rmExcel), 1)
      ensureSheetRows()
      render()
    })
  })

  app.querySelector('#excel-clear')?.addEventListener(
    'click',
    withClickGuard(async () => {
      if (filledSheetCount() && !(await askConfirm('清空表格里的全部内容？'))) return
      state.excelDrafts = []
      ensureSheetRows()
      state.excelInfo = ''
      render()
    }),
  )

  app.querySelector('#excel-save-all')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const toSave = state.excelDrafts.filter((d) => String(d.title || '').trim())
      if (state.excelImporting || !toSave.length) return
      state.excelImporting = true
      render()
      let ok = 0
      const failed = []
      try {
        await runBusy('入库中…', async () => {
          for (const d of toSave) {
            try {
              await upsertNovel({
                title: d.title,
                author: d.author,
                synopsis: d.synopsis,
                tags: d.tags?.length ? d.tags : ['未读'],
              })
              ok++
            } catch {
              failed.push(d)
            }
          }
          state.excelDrafts = failed.length ? failed : []
          ensureSheetRows()
          state.excelInfo = failed.length
            ? `成功 ${ok} 条，失败 ${failed.length} 条（多半缺书名），请改后重试`
            : `成功入库 ${ok} 条`
          if (!failed.length) state.page = 'library'
        })
      } finally {
        state.excelImporting = false
      }
      if (!failed.length) alert(`已导入 ${ok} 本小说`)
      else alert(`成功 ${ok} 条，还有 ${failed.length} 条未入库`)
      render()
    }),
  )
}

/** 左滑距离必须等于操作区实际宽度，否则编辑按钮会被挡住 */
function swipeOpenX(itemEl) {
  const actions = itemEl?.querySelector?.('.swipe-actions')
  const w = actions?.getBoundingClientRect?.().width
  if (w && w > 0) return -Math.round(w)
  const cssW = itemEl
    ? parseFloat(getComputedStyle(itemEl).getPropertyValue('--swipe-actions-w'))
    : NaN
  return -(Number.isFinite(cssW) && cssW > 0 ? Math.round(cssW) : 96)
}

function closeAllSwipes(except = null) {
  app.querySelectorAll('.swipe-item.open .swipe-content').forEach((el) => {
    if (except && el === except) return
    el.style.transform = 'translateX(0)'
    el.parentElement?.classList.remove('open')
  })
}

function bindSwipe() {
  if (state.sortMode) return
  app.querySelectorAll('.swipe-item').forEach((item) => {
    const content = item.querySelector('.swipe-content')
    if (!content) return

    let startX = 0
    let startY = 0
    let baseX = 0
    let currentX = 0
    let tracking = false
    let locked = null // 'h' | 'v'
    let moved = false

    const getOpenX = () => (item.classList.contains('open') ? swipeOpenX(item) : 0)
    const isInteractive = (target) =>
      Boolean(target?.closest?.('button, a, input, textarea, label, .attach-chip'))

    const onStart = (clientX, clientY) => {
      tracking = true
      locked = null
      moved = false
      startX = clientX
      startY = clientY
      baseX = getOpenX()
      currentX = baseX
      content.style.transition = 'none'
    }

    const onMove = (clientX, clientY, e) => {
      if (!tracking) return
      const dx = clientX - startX
      const dy = clientY - startY
      if (!locked) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
        locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
        if (locked === 'v') {
          tracking = false
          return
        }
      }
      if (locked !== 'h') return
      e?.preventDefault?.()
      moved = true
      const openX = swipeOpenX(item)
      currentX = Math.min(0, Math.max(openX, baseX + dx))
      content.style.transform = `translateX(${currentX}px)`
    }

    const onEnd = () => {
      if (!tracking && locked !== 'h') {
        content.style.transition = ''
        tracking = false
        return
      }
      const wasTracking = tracking || locked === 'h'
      tracking = false
      content.style.transition = ''
      if (!wasTracking) return

      if (!moved) {
        // tap: close if already open；否则进入查看
        if (item.classList.contains('open')) {
          content.style.transform = 'translateX(0)'
          item.classList.remove('open')
        } else if (!state.sortMode) {
          const id = item.dataset.id
          if (id) {
            state.viewingId = id
            state.editingId = null
            render()
          }
        }
        return
      }

      const openX = swipeOpenX(item)
      const shouldOpen = currentX < openX / 2
      if (shouldOpen) {
        closeAllSwipes(content)
        content.style.transform = `translateX(${openX}px)`
        item.classList.add('open')
      } else {
        content.style.transform = 'translateX(0)'
        item.classList.remove('open')
      }
    }

    content.addEventListener(
      'touchstart',
      (e) => {
        if (isInteractive(e.target)) return
        const t = e.touches[0]
        onStart(t.clientX, t.clientY)
      },
      { passive: true },
    )
    content.addEventListener(
      'touchmove',
      (e) => {
        const t = e.touches[0]
        onMove(t.clientX, t.clientY, e)
      },
      { passive: false },
    )
    content.addEventListener('touchend', onEnd)
    content.addEventListener('touchcancel', onEnd)

    content.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return
      if (e.button !== 0) return
      if (isInteractive(e.target)) return
      onStart(e.clientX, e.clientY)
      content.setPointerCapture?.(e.pointerId)
    })
    content.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return
      onMove(e.clientX, e.clientY, e)
    })
    content.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return
      onEnd()
    })
    content.addEventListener('pointercancel', (e) => {
      if (e.pointerType === 'touch') return
      onEnd()
    })
  })
}

function bindModal() {
  if (state.editingId === null) return
  const selected = new Set(
    state.editingId === 'new'
      ? ['未读']
      : getNovel(state.editingId)?.tags || [],
  )

  // Sync from DOM active chips after render
  app.querySelectorAll('#tag-picker .tag-chip.active').forEach((el) => {
    if (el.dataset.toggleTag) selected.add(el.dataset.toggleTag)
  })

  const closeModal = () => {
    state.editingId = null
    state.pendingAttachmentFile = null
    state.pendingAttachmentClear = false
    render()
  }

  app.querySelector('#modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal()
  })

  app.querySelector('#modal-cancel')?.addEventListener('click', closeModal)

  const attachInput = app.querySelector('#f-attach-input')
  app.querySelector('#f-attach-pick')?.addEventListener('click', () => attachInput?.click())
  attachInput?.addEventListener('change', () => {
    const file = attachInput.files?.[0]
    attachInput.value = ''
    if (!file) return
    if (file.size > ATTACH_MAX_BYTES) {
      alert('附件不能超过 20MB')
      return
    }
    state.pendingAttachmentFile = file
    state.pendingAttachmentClear = false
    const status = app.querySelector('#f-attach-status')
    if (status) status.textContent = `待上传：${file.name}（${formatAttachSize(file.size)}）`
    if (!app.querySelector('#f-attach-clear')) {
      const row = app.querySelector('.attach-row')
      if (row) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'btn ghost sm'
        btn.id = 'f-attach-clear'
        btn.textContent = '移除'
        row.appendChild(btn)
        btn.addEventListener('click', () => {
          state.pendingAttachmentFile = null
          state.pendingAttachmentClear = true
          if (status) status.textContent = '未选择（可选）'
          btn.remove()
        })
      }
    }
  })
  app.querySelector('#f-attach-clear')?.addEventListener('click', () => {
    state.pendingAttachmentFile = null
    state.pendingAttachmentClear = true
    const status = app.querySelector('#f-attach-status')
    if (status) status.textContent = '未选择（可选）'
    app.querySelector('#f-attach-clear')?.remove()
  })

  app.querySelectorAll('[data-toggle-tag]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active')
    })
  })

  const paintFormStars = (rating) => {
    const picker = app.querySelector('#f-rating')
    if (!picker) return
    const r = clampRating(rating)
    picker.dataset.rating = String(r)
    picker.querySelectorAll('[data-form-star]').forEach((btn) => {
      const v = Number(btn.dataset.formStar)
      if (v === 0) {
        btn.hidden = !r
        return
      }
      const on = v <= r
      btn.classList.toggle('on', on)
      btn.textContent = on ? '★' : '☆'
    })
  }

  app.querySelectorAll('#f-rating [data-form-star]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const picker = app.querySelector('#f-rating')
      const next = Number(btn.dataset.formStar)
      const cur = clampRating(picker?.dataset.rating)
      // 再点同一星 → 清除
      paintFormStars(next === cur && next > 0 ? 0 : next)
    })
  })

  const paintFormWant = (on) => {
    const btn = app.querySelector('#f-want')
    if (!btn) return
    const next = Boolean(on)
    btn.classList.toggle('on', next)
    btn.setAttribute('aria-pressed', next ? 'true' : 'false')
    btn.textContent = next ? '★ 很想看' : '☆ 很想看'
  }

  app.querySelector('#f-want')?.addEventListener('click', () => {
    const btn = app.querySelector('#f-want')
    paintFormWant(btn?.getAttribute('aria-pressed') !== 'true')
  })

  app.querySelector('#modal-add-tag')?.addEventListener(
    'click',
    withClickGuard(async () => {
    const name = await askText('新标签名称')
    if (!name?.trim()) return
    try {
      await runBusy('添加标签…', () => addCustomTag(name.trim()))
    } catch (err) {
      alert(err.message || String(err))
      return
    }
    // Re-open modal keeping fields
    const title = app.querySelector('#f-title')?.value
    const author = app.querySelector('#f-author')?.value
    const synopsis = app.querySelector('#f-synopsis')?.value
    const review = app.querySelector('#f-review')?.value
    const rating = clampRating(app.querySelector('#f-rating')?.dataset.rating)
    const wantOn = app.querySelector('#f-want')?.getAttribute('aria-pressed') === 'true'
    const active = [...app.querySelectorAll('#tag-picker .tag-chip.active')]
      .map((b) => b.dataset.toggleTag)
      .filter(Boolean)
    active.push(name.trim())
    render()
    // After re-render restore
    queueMicrotask(() => {
      const t = app.querySelector('#f-title')
      const a = app.querySelector('#f-author')
      const s = app.querySelector('#f-synopsis')
      const rv = app.querySelector('#f-review')
      if (t) t.value = title
      if (a) a.value = author
      if (s) s.value = synopsis
      if (rv) rv.value = review
      paintFormStars(rating)
      paintFormWant(wantOn)
      app.querySelectorAll('[data-toggle-tag]').forEach((b) => {
        if (active.includes(b.dataset.toggleTag)) b.classList.add('active')
        else b.classList.remove('active')
      })
    })
  }),
  )

  app.querySelector('#modal-save')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const title = app.querySelector('#f-title').value
      const author = app.querySelector('#f-author').value
      const synopsis = app.querySelector('#f-synopsis').value
      const review = app.querySelector('#f-review')?.value || ''
      const rating = clampRating(app.querySelector('#f-rating')?.dataset.rating)
      const wantToRead = app.querySelector('#f-want')?.getAttribute('aria-pressed') === 'true'
      const tags = [...app.querySelectorAll('#tag-picker .tag-chip.active')]
        .map((b) => b.dataset.toggleTag)
        .filter(Boolean)
      try {
        const isNew = state.editingId === 'new'
        await runBusy('保存中…', async () => {
          await upsertNovel({
            id: isNew ? undefined : state.editingId,
            title,
            author,
            synopsis,
            review,
            rating,
            wantToRead,
            tags,
            attachmentFile: state.pendingAttachmentFile || undefined,
            clearAttachment: state.pendingAttachmentClear,
          })
          state.editingId = null
          state.pendingAttachmentFile = null
          state.pendingAttachmentClear = false
          await reloadLibrary(isNew ? 1 : getPageMeta().page)
        })
        render()
      } catch (err) {
        const el = app.querySelector('#form-error')
        if (el) {
          el.hidden = false
          el.textContent = err.message
        } else {
          alert(err.message || String(err))
        }
      }
    }),
  )
}

/** @type {{ index: number, natW: number, natH: number, sel: { x: number, y: number, w: number, h: number } } | null} */
let cropSession = null

function closeCropModal() {
  state.cropIndex = null
  cropSession = null
  render()
}

function renderCropModal() {
  const item = state.importFiles[state.cropIndex]
  if (!item) return ''
  return `
    <div class="modal-backdrop crop-backdrop" id="crop-backdrop">
      <div class="crop-modal" role="dialog" aria-modal="true" aria-label="裁剪图片">
        <div class="crop-modal-head">
          <h2>裁剪图片</h2>
          <p class="muted">拖动选区，拖角缩放；裁掉无关内容再识别更准</p>
        </div>
        <div class="crop-stage" id="crop-stage">
          <div class="crop-frame" id="crop-frame">
            <img id="crop-img" class="crop-img" src="${item.preview}" alt="" draggable="false" />
            <div class="crop-box" id="crop-box" hidden>
              <span class="crop-handle" data-handle="nw"></span>
              <span class="crop-handle" data-handle="ne"></span>
              <span class="crop-handle" data-handle="sw"></span>
              <span class="crop-handle" data-handle="se"></span>
            </div>
          </div>
        </div>
        <div class="crop-modal-actions">
          <button type="button" class="btn ghost" id="crop-cancel">取消</button>
          <button type="button" class="btn ghost" id="crop-reset">重置</button>
          <button type="button" class="btn" id="crop-apply">完成裁剪</button>
        </div>
      </div>
    </div>
  `
}

function syncCropBoxDom() {
  const img = app.querySelector('#crop-img')
  const box = app.querySelector('#crop-box')
  if (!img || !box || !cropSession) return
  const scaleX = img.clientWidth / cropSession.natW
  const scaleY = img.clientHeight / cropSession.natH
  const { x, y, w, h } = cropSession.sel
  box.hidden = false
  box.style.left = `${x * scaleX}px`
  box.style.top = `${y * scaleY}px`
  box.style.width = `${w * scaleX}px`
  box.style.height = `${h * scaleY}px`
}

function clampCropSel(sel, natW, natH) {
  const min = 24
  let { x, y, w, h } = sel
  w = Math.max(min, Math.min(w, natW))
  h = Math.max(min, Math.min(h, natH))
  x = Math.max(0, Math.min(x, natW - w))
  y = Math.max(0, Math.min(y, natH - h))
  return { x, y, w, h }
}

function initCropSelection(natW, natH) {
  const pad = Math.round(Math.min(natW, natH) * 0.06)
  return clampCropSel(
    {
      x: pad,
      y: pad,
      w: Math.max(24, natW - pad * 2),
      h: Math.max(24, natH - pad * 2),
    },
    natW,
    natH,
  )
}

function bindCropModal() {
  if (state.cropIndex === null) return
  const item = state.importFiles[state.cropIndex]
  if (!item) {
    closeCropModal()
    return
  }

  const img = app.querySelector('#crop-img')
  const box = app.querySelector('#crop-box')
  const stage = app.querySelector('#crop-stage')
  if (!img || !box || !stage) return

  const setup = () => {
    cropSession = {
      index: state.cropIndex,
      natW: img.naturalWidth || img.width,
      natH: img.naturalHeight || img.height,
      sel: initCropSelection(img.naturalWidth || img.width, img.naturalHeight || img.height),
    }
    syncCropBoxDom()
  }

  if (img.complete && img.naturalWidth) setup()
  else img.addEventListener('load', setup, { once: true })

  app.querySelector('#crop-cancel')?.addEventListener('click', () => closeCropModal())
  app.querySelector('#crop-backdrop')?.addEventListener('click', (e) => {
    if (e.target?.id === 'crop-backdrop') closeCropModal()
  })
  app.querySelector('#crop-reset')?.addEventListener('click', () => {
    if (!cropSession) return
    cropSession.sel = initCropSelection(cropSession.natW, cropSession.natH)
    syncCropBoxDom()
  })
  app.querySelector('#crop-apply')?.addEventListener(
    'click',
    withClickGuard(async () => {
      if (!cropSession) return
      const idx = cropSession.index
      const src = state.importFiles[idx]
      if (!src) {
        closeCropModal()
        return
      }
      try {
        await runBusy('裁剪中…', async () => {
          const mime = src.file.type && src.file.type.startsWith('image/') ? src.file.type : 'image/jpeg'
          const file = await cropImageToFile(src.preview, cropSession.sel, src.file.name, mime)
          URL.revokeObjectURL(src.preview)
          state.importFiles[idx] = {
            file,
            preview: URL.createObjectURL(file),
          }
          state.importMsg = `已裁剪：${file.name}`
        })
        state.cropIndex = null
        cropSession = null
        render()
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )

  /** @type {{ mode: 'move'|'nw'|'ne'|'sw'|'se', startX: number, startY: number, orig: {x:number,y:number,w:number,h:number} } | null} */
  let drag = null

  const onPointerMove = (e) => {
    if (!drag || !cropSession || !img) return
    const scaleX = cropSession.natW / img.clientWidth
    const scaleY = cropSession.natH / img.clientHeight
    const dx = (e.clientX - drag.startX) * scaleX
    const dy = (e.clientY - drag.startY) * scaleY
    const o = drag.orig
    let next = { ...o }
    if (drag.mode === 'move') {
      next = { x: o.x + dx, y: o.y + dy, w: o.w, h: o.h }
    } else if (drag.mode === 'se') {
      next = { x: o.x, y: o.y, w: o.w + dx, h: o.h + dy }
    } else if (drag.mode === 'nw') {
      next = { x: o.x + dx, y: o.y + dy, w: o.w - dx, h: o.h - dy }
    } else if (drag.mode === 'ne') {
      next = { x: o.x, y: o.y + dy, w: o.w + dx, h: o.h - dy }
    } else if (drag.mode === 'sw') {
      next = { x: o.x + dx, y: o.y, w: o.w - dx, h: o.h + dy }
    }
    cropSession.sel = clampCropSel(next, cropSession.natW, cropSession.natH)
    syncCropBoxDom()
  }

  const endDrag = () => {
    drag = null
  }

  box.addEventListener('pointerdown', (e) => {
    if (!cropSession) return
    const handle = e.target?.dataset?.handle
    e.preventDefault()
    e.stopPropagation()
    box.setPointerCapture?.(e.pointerId)
    drag = {
      mode: handle || 'move',
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...cropSession.sel },
    }
  })
  box.addEventListener('pointermove', onPointerMove)
  box.addEventListener('pointerup', endDrag)
  box.addEventListener('pointercancel', endDrag)
}

function bindImport() {
  if (state.page !== 'import') return
  // 进入截图页就预加载字库，避免点「开始识别」才开始下
  preloadOcr()

  app.querySelectorAll('[data-batch-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.batchToggle
      if (state.batchTags.includes(t)) {
        state.batchTags = state.batchTags.filter((x) => x !== t)
      } else {
        state.batchTags = [...state.batchTags, t]
      }
      render()
    })
  })

  app.querySelector('#batch-add-tag')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const name = await askText('新标签名称')
      if (!name?.trim()) return
      const t = name.trim()
      try {
        await runBusy('添加标签…', () => addCustomTag(t))
        if (!state.batchTags.includes(t)) state.batchTags = [...state.batchTags, t]
        render()
      } catch (err) {
        alert(err.message || String(err))
      }
    }),
  )

  app.querySelector('#batch-tags-clear')?.addEventListener('click', () => {
    state.batchTags = []
    render()
  })

  app.querySelector('#batch-tags-replace')?.addEventListener('click', () => {
    if (!state.batchTags.length || !state.importDrafts.length) return
    const tags = [...state.batchTags]
    state.importDrafts = state.importDrafts.map((d) => ({ ...d, tags: [...tags] }))
    render()
  })

  app.querySelector('#batch-tags-append')?.addEventListener('click', () => {
    if (!state.batchTags.length || !state.importDrafts.length) return
    const add = state.batchTags
    state.importDrafts = state.importDrafts.map((d) => ({
      ...d,
      tags: [...new Set([...(d.tags || []), ...add])],
    }))
    render()
  })

  const input = app.querySelector('#file-input')
  const dropzone = app.querySelector('#dropzone')

  const addFiles = (fileList) => {
    const files = [...fileList].filter((f) => f.type.startsWith('image/'))
    files.forEach((file) => {
      state.importFiles.push({
        file,
        preview: URL.createObjectURL(file),
      })
    })
    render()
  }

  app.querySelector('#pick-files')?.addEventListener('click', () => input?.click())
  input?.addEventListener('change', () => {
    if (input.files?.length) addFiles(input.files)
    input.value = ''
  })

  dropzone?.addEventListener('dragover', (e) => {
    e.preventDefault()
    dropzone.classList.add('dragover')
  })
  dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('dragover'))
  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault()
    dropzone.classList.remove('dragover')
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
  })

  app.querySelector('#clear-files')?.addEventListener('click', () => {
    state.importFiles.forEach((f) => URL.revokeObjectURL(f.preview))
    state.importFiles = []
    state.rawOcr = ''
    state.importDrafts = []
    state.importMsg = ''
    render()
  })

  app.querySelector('#copy-ocr-text')?.addEventListener(
    'click',
    withClickGuard(async () => {
      const text = (app.querySelector('#raw-ocr-text')?.value ?? state.rawOcr ?? '').trim()
      if (!text) {
        alert('还没有可复制的文字，请先识别')
        return
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
        } else {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.setAttribute('readonly', '')
          ta.style.position = 'fixed'
          ta.style.left = '-9999px'
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        state.importMsg = '已复制识别文字'
        render()
      } catch (err) {
        alert(`复制失败：${err.message || err}`)
      }
    }),
  )

  app.querySelector('#save-to-gallery')?.addEventListener(
    'click',
    withClickGuard(async () => {
      if (!state.importFiles.length) return
      const files = state.importFiles.map((f) => f.file)
      try {
        await runBusy('存入图库…', async () => {
          const ids = await addImages(files)
          state.importMsg = `已存入图库 ${ids.length} 张`
        })
      } catch (err) {
        state.importMsg = `存图失败：${err.message || err}`
      }
      render()
    }),
  )

  app.querySelectorAll('[data-crop-file]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const i = Number(btn.dataset.cropFile)
      if (Number.isNaN(i) || !state.importFiles[i]) return
      state.cropIndex = i
      render()
    })
  })

  app.querySelectorAll('[data-rm-file]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const i = Number(btn.dataset.rmFile)
      if (Number.isNaN(i) || !state.importFiles[i]) return
      URL.revokeObjectURL(state.importFiles[i].preview)
      state.importFiles.splice(i, 1)
      if (state.cropIndex === i) {
        state.cropIndex = null
        cropSession = null
      } else if (state.cropIndex != null && state.cropIndex > i) {
        state.cropIndex -= 1
      }
      render()
    })
  })

  app.querySelector('#start-ocr')?.addEventListener(
    'click',
    withClickGuard(async () => {
      if (!state.importFiles.length || state.recognizing) return
      state.recognizing = true
      state.progress = { label: '准备识别…', pct: 0 }
      render()
      try {
        await runBusy('识别中…', async () => {
          const files = state.importFiles.map((f) => f.file)
          const results = await recognizeImages(files, ({ index, total, progress, name, label }) => {
            const phase = label ? ` · ${label}` : ''
            state.progress = {
              label: `第 ${index + 1}/${total} 张「${name}」${phase}（${progress}%）`,
              pct: Math.round(((index + progress / 100) / total) * 100),
            }
            state.actionBusyLabel = state.progress.label
            mountBusyOverlay()
            const bar = app.querySelector('.progress-bar > span')
            const meta = app.querySelector('.progress-meta')
            if (bar) bar.style.width = `${state.progress.pct}%`
            if (meta) meta.textContent = state.progress.label
          })
          state.rawOcr = results.map((r) => `【${r.name}】\n${r.text}`).join('\n\n')
          state.importDrafts = []
        })
      } catch (err) {
        alert(`识别失败：${err.message || err}`)
      } finally {
        state.recognizing = false
        render()
      }
    }),
  )

  const rawOcrEl = app.querySelector('#raw-ocr-text')
  rawOcrEl?.addEventListener('input', () => {
    state.rawOcr = rawOcrEl.value
  })

  app.querySelector('#clear-ocr')?.addEventListener('click', () => {
    state.rawOcr = ''
    render()
  })

  const addManualDraft = () => {
    state.importDrafts = [
      ...state.importDrafts,
      { title: '', author: '', synopsis: '', tags: ['未读'] },
    ]
    render()
    queueMicrotask(() => {
      const i = state.importDrafts.length - 1
      app.querySelector(`[data-d-title="${i}"]`)?.focus()
    })
  }
  app.querySelector('#add-manual-draft')?.addEventListener('click', addManualDraft)
  app.querySelector('#add-manual-draft-side')?.addEventListener('click', addManualDraft)
  app.querySelector('#add-manual-draft-empty')?.addEventListener('click', addManualDraft)

  // 只清右侧「待入库预览」，绝不删书架已入库数据
  const clearDraftEntries = withClickGuard(async () => {
    if (!state.importDrafts.length) {
      alert('右侧没有待入库条目')
      return
    }
    if (
      !(await askConfirm(
        `确定清空右侧 ${state.importDrafts.length} 条待入库预览？\n（不会删除小说库里已保存的书）`,
      ))
    ) {
      return
    }
    state.importDrafts = []
    render()
  })
  app.querySelector('#clear-drafts')?.addEventListener('click', clearDraftEntries)
  app.querySelector('#clear-drafts-side')?.addEventListener('click', clearDraftEntries)

  app.querySelector('#parse-ocr')?.addEventListener(
    'click',
    withClickGuard(() => {
      const text = (app.querySelector('#raw-ocr-text')?.value ?? state.rawOcr)
        .replace(/^【[^】]+】\s*$/gm, '')
        .trim()
      state.rawOcr = app.querySelector('#raw-ocr-text')?.value ?? state.rawOcr
      if (!text) {
        alert('原文为空，请先识别或粘贴文本')
        return
      }
      const parsed = parseOcrText(text)
      if (!parsed.length) {
        alert('没解析出书名，请再改改原文后重试')
        return
      }
      state.importDrafts = parsed.map((p) => ({
        title: p.title,
        author: p.author || '',
        synopsis: '',
        tags: ['未读'],
      }))
      render()
    }),
  )

  ;['title', 'author', 'synopsis', 'tags'].forEach((key) => {
    app.querySelectorAll(`[data-d-${key}]`).forEach((el) => {
      el.addEventListener('input', () => {
        const i = Number(el.getAttribute(`data-d-${key}`))
        if (Number.isNaN(i)) return
        if (key === 'tags') {
          state.importDrafts[i].tags = el.value
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean)
        } else {
          state.importDrafts[i][key] = el.value
        }
      })
    })
  })

  app.querySelectorAll('[data-rm-draft]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.importDrafts.splice(Number(btn.dataset.rmDraft), 1)
      render()
    })
  })

  const saveOne = async (i) => {
    const d = state.importDrafts[i]
    await upsertNovel({
      title: d.title,
      author: d.author,
      synopsis: d.synopsis,
      tags: d.tags?.length ? d.tags : ['未读'],
    })
  }

  app.querySelectorAll('[data-save-draft]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard(async () => {
        try {
          const i = Number(btn.dataset.saveDraft)
          await runBusy('入库中…', async () => {
            await saveOne(i)
            state.importDrafts.splice(i, 1)
          })
          alert('已入库')
          render()
        } catch (err) {
          alert(err.message)
        }
      }),
    )
  })

  app.querySelector('#save-all-drafts')?.addEventListener(
    'click',
    withClickGuard(async () => {
      try {
        let failed = 0
        await runBusy('全部入库…', async () => {
          const remaining = []
          for (let i = 0; i < state.importDrafts.length; i++) {
            try {
              await saveOne(i)
            } catch {
              remaining.push(state.importDrafts[i])
            }
          }
          failed = remaining.length
          state.importDrafts = remaining
          if (!failed) state.page = 'library'
        })
        if (failed) alert(`有 ${failed} 条未入库（多半缺书名），请补全后重试`)
        else alert('已全部入库')
        render()
      } catch (err) {
        alert(err.message)
      }
    }),
  )
}

let bootingStore = false

async function boot() {
  render()
  onAuthChange(async (session) => {
    const next = session?.user || null
    const prevId = state.user?.id
    state.user = next
    state.authReady = true
    if (!next) {
      state.storeReady = false
      state.storeError = ''
      render()
      return
    }
    if (next.id !== prevId || !state.storeReady) {
      if (bootingStore) return
      bootingStore = true
      try {
        await bootStore()
      } finally {
        bootingStore = false
      }
    } else {
      render()
    }
  })

  try {
    const session = await getSession()
    if (!state.authReady) {
      state.user = session?.user || null
      state.authReady = true
      render()
      if (state.user && !state.storeReady && !bootingStore) {
        bootingStore = true
        try {
          await bootStore()
        } finally {
          bootingStore = false
        }
      }
    }
  } catch (err) {
    console.error(err)
    state.authReady = true
    state.user = null
    render()
  }
}

boot()
