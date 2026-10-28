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
  exportMarkdown,
  moveNovelInView,
  refreshStore,
} from './store.js'
import { getSession, signInWithPassword, signUpWithPassword, signOut, onAuthChange } from './auth.js'
import { migrateLocalIfNeeded } from './migrateLocal.js'
import { recognizeImages } from './ocr.js'
import { parseOcrText } from './parseBooks.js'
import { tagStyleAttr } from './tagColors.js'
import { parseExcelFile, downloadExcelTemplate } from './excelImport.js'
import { listImages, addImages, getImage, deleteImage, deleteImages } from './imageStore.js'

const state = {
  page: 'library', // library | import | excel | gallery
  query: '',
  filterTags: [],
  tagManage: false,
  sortMode: false,
  editingId: null,
  importFiles: [],
  importDrafts: [],
  batchTags: ['未读'],
  rawOcr: '',
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
          <h1 class="brand">书单识图</h1>
          <p class="brand-sub">收藏感兴趣、还没看的小说</p>
        </div>
        <nav class="nav">
          <button class="nav-btn ${state.page === 'library' ? 'active' : ''}" data-nav="library">小说库</button>
          <button class="nav-btn ${state.page === 'import' ? 'active' : ''}" data-nav="import">截图导入</button>
          <button class="nav-btn ${state.page === 'gallery' ? 'active' : ''}" data-nav="gallery">图库</button>
          <button class="nav-btn ${state.page === 'excel' ? 'active' : ''}" data-nav="excel">Excel导入</button>
          <button class="nav-btn" id="add-novel" type="button">手动添加</button>
        </nav>
        <div class="top-actions">
          ${state.page === 'library' ? `<button class="btn ghost" id="export-md">导出 MD</button>` : ''}
          <button class="btn" id="add-novel-primary">+ 添加小说</button>
          <span class="user-chip" title="${escapeHtml(state.user.email || '已登录')}" aria-label="${escapeHtml(state.user.email || '已登录')}">${USER_ICON_SVG}</span>
          <button class="btn ghost" id="sign-out" type="button" title="${escapeHtml(state.user.email || '')}">退出</button>
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
    ${state.galleryPreviewId ? renderGalleryLightbox() : ''}
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
        <h1 class="brand">书单识图</h1>
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
    await refreshStore()
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

function renderLibrary() {
  const novels = searchNovels({ query: state.query, tags: state.filterTags })
  const tags = getAllTags()

  return `
    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-head">
          <h2>${state.tagManage ? '管理标签' : '标签筛选'}</h2>
          <button type="button" class="btn ghost sm" id="toggle-tag-manage">${state.tagManage ? '完成' : '管理'}</button>
        </div>
        ${
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
            ? `<div class="clear-wrap"><button class="btn ghost sm" id="clear-filters">清除筛选</button></div>`
            : ''
        }
      </aside>
      <section class="main-panel">
        <div class="toolbar">
          <h2>小说库</h2>
          <div class="toolbar-right">
            <span class="muted">共 ${novels.length} 本想看</span>
            ${
              novels.length
                ? `<button type="button" class="btn ghost sm ${state.sortMode ? 'active-sort' : ''}" id="toggle-sort-mode">
                    ${state.sortMode ? '完成排序' : '排序'}
                  </button>`
                : ''
            }
          </div>
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
              </div>`
            : `<div class="empty">
                <h3 class="empty-title">书架还是空的</h3>
                <p>手动添加一本，或从截图里识别书名。</p>
                <div class="empty-actions">
                  <button class="btn" id="add-novel-empty">+ 手动添加一本</button>
                  <button class="btn ghost" data-nav="import">从截图导入</button>
                </div>
              </div>`
        }
      </section>
    </div>
  `
}

function renderCard(n, index = 0, total = 0) {
  const byline = n.author ? ` <span class="by-author">by${escapeHtml(n.author)}</span>` : ''
  const sortControls = state.sortMode
    ? `<div class="sort-controls">
        <button type="button" class="btn ghost sm" data-sort="top" data-sort-id="${n.id}" ${index === 0 ? 'disabled' : ''}>置顶</button>
        <button type="button" class="btn ghost sm" data-sort="up" data-sort-id="${n.id}" ${index === 0 ? 'disabled' : ''}>上移</button>
        <button type="button" class="btn ghost sm" data-sort="down" data-sort-id="${n.id}" ${index >= total - 1 ? 'disabled' : ''}>下移</button>
      </div>`
    : ''
  return `
    <div class="swipe-item ${state.sortMode ? 'sort-mode' : ''}" data-id="${n.id}" style="animation-delay:${Math.min(index, 8) * 40}ms">
      <div class="swipe-actions">
        <button type="button" class="swipe-btn edit" data-edit="${n.id}">编辑</button>
        <button type="button" class="swipe-btn delete" data-del="${n.id}">删除</button>
      </div>
      <div class="swipe-content">
        <div class="card-main">
          <h3>${escapeHtml(n.title)}${byline}</h3>
          <div class="card-tags">
            ${(n.tags || []).map((t) => `<span ${tagStyleAttr(t)}>${escapeHtml(t)}</span>`).join('')}
          </div>
        </div>
        ${sortControls}
        ${state.sortMode ? '' : `<span class="swipe-hint">← 左滑</span>`}
      </div>
    </div>
  `
}

function renderExcel() {
  const { excelDrafts, excelInfo, excelImporting } = state
  return `
    <div class="page-head">
      <h2>Excel 导入</h2>
      <p class="muted">支持 .xlsx / .xls / .csv · 表头建议含：书名、作者、简介、标签</p>
    </div>
    <div class="import-layout">
      <section class="panel">
        <h2>上传表格</h2>
        <p class="muted" style="margin:0 0 12px">标签可用逗号或顿号分隔，如「科幻,未读」</p>
        <div class="excel-actions">
          <button class="btn ghost" id="excel-template" type="button">下载模板</button>
          <button class="btn" id="excel-pick" type="button">选择 Excel 文件</button>
          <input type="file" id="excel-input" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv" hidden />
        </div>
        ${excelInfo ? `<p class="muted" style="margin:12px 0 0">${escapeHtml(excelInfo)}</p>` : ''}
      </section>
      <section class="panel">
        <h2>预览并入库 ${excelDrafts.length ? `（${excelDrafts.length} 条）` : ''}</h2>
        ${
          excelDrafts.length
            ? `<div class="draft-list">
                ${excelDrafts
                  .map(
                    (d, i) => `
                  <div class="draft-item">
                    <label>书名<input data-ex-title="${i}" value="${escapeHtml(d.title)}" /></label>
                    <label>作者（选填）<input data-ex-author="${i}" value="${escapeHtml(d.author)}" /></label>
                    <label>简介<textarea data-ex-synopsis="${i}" rows="2">${escapeHtml(d.synopsis || '')}</textarea></label>
                    <label>标签<input data-ex-tags="${i}" value="${escapeHtml((d.tags || []).join(','))}" /></label>
                    <div class="draft-actions">
                      <button class="btn ghost sm" data-rm-excel="${i}">移除</button>
                    </div>
                  </div>`,
                  )
                  .join('')}
              </div>
              <button class="btn" id="excel-save-all" style="margin-top:14px" ${excelImporting ? 'disabled' : ''}>
                ${excelImporting ? '入库中…' : '全部入库'}
              </button>
              <button class="btn ghost" id="excel-clear" style="margin-top:14px;margin-left:8px">清空预览</button>`
            : `<p class="muted">选择文件后，这里会列出可编辑的预览。</p>`
        }
      </section>
    </div>
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
      <p class="muted">识别后先核对原文，再手动生成条目入库</p>
    </div>
    <div class="import-layout">
      <section>
        <div class="dropzone" id="dropzone">
          <div class="dropzone-icon">图</div>
          <p>拖拽截图 / 封面到这里</p>
          <span class="muted">支持多张 · 点缩略图可移除</span>
          <button class="btn" id="pick-files" type="button">选择文件</button>
          <input type="file" id="file-input" accept="image/*" multiple hidden />
        </div>
        ${
          importFiles.length
            ? `<div class="thumbs">${importFiles
                .map(
                  (f, i) =>
                    `<img class="thumb" src="${f.preview}" alt="" title="${escapeHtml(f.file.name)}" data-rm-file="${i}" />`,
                )
                .join('')}</div>`
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
                   <button class="btn ghost" id="clear-files">清空图片</button>`
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
                  <button class="btn ghost" id="clear-ocr" type="button">清空原文</button>
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
              <button class="btn" id="save-all-drafts" style="margin-top:14px">全部入库</button>`
            : `<p class="muted">${
                rawOcr !== ''
                  ? '左侧核验完原文后，点「生成条目」会出现在这里。'
                  : '先上传截图并识别，核对原文后再生成条目。'
              }</p>`
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

function renderModal() {
  const isNew = state.editingId === 'new'
  const novel = isNew
    ? { title: '', author: '', synopsis: '', tags: ['未读'] }
    : getNovel(state.editingId) || { title: '', author: '', synopsis: '', tags: [] }
  const tags = getAllTags()

  return `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal" role="dialog">
        <h2>${isNew ? '添加小说' : '编辑小说'}</h2>
        <p class="error-text" id="form-error" hidden></p>
        <label class="field"><span>书名</span><input id="f-title" value="${escapeHtml(novel.title)}" /></label>
        <label class="field"><span>作者（选填）</span><input id="f-author" value="${escapeHtml(novel.author)}" placeholder="有同名时建议填写" /></label>
        <label class="field"><span>简介</span><textarea id="f-synopsis">${escapeHtml(novel.synopsis || '')}</textarea></label>
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
      render()
      const again = app.querySelector('#search')
      if (again) {
        again.focus()
        again.setSelectionRange(sel, sel)
      }
    }, 220)
    search.addEventListener('input', onSearch)
  }

  app.querySelector('#toggle-tag-manage')?.addEventListener('click', () => {
    state.tagManage = !state.tagManage
    render()
  })

  app.querySelector('#toggle-sort-mode')?.addEventListener('click', () => {
    state.sortMode = !state.sortMode
    render()
  })

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
      withClickGuard(() => {
        const t = btn.dataset.filterTag
        if (state.filterTags.includes(t)) {
          state.filterTags = state.filterTags.filter((x) => x !== t)
        } else {
          state.filterTags = [...state.filterTags, t]
        }
        render()
      }),
    )
  })

  app.querySelectorAll('[data-del-tag]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard(async (e) => {
        e.stopPropagation()
        const t = btn.dataset.delTag
        const used = countNovelsWithTag(t)
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
          })
          render()
        } catch (err) {
          alert(err.message || String(err))
        }
      }),
    )
  })

  app.querySelector('#clear-filters')?.addEventListener('click', () => {
    state.filterTags = []
    render()
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
    render()
  })
  app.querySelector('#add-novel')?.addEventListener('click', openAddNovel)
  app.querySelector('#add-novel-primary')?.addEventListener('click', openAddNovel)
  app.querySelector('#add-novel-empty')?.addEventListener('click', openAddNovel)

  app.querySelector('#sign-out')?.addEventListener(
    'click',
    withClickGuard(async () => {
      await runBusy('退出中…', () => signOut())
    }),
  )

  app.querySelector('#export-md')?.addEventListener(
    'click',
    withClickGuard(() => {
      const novels = searchNovels({ query: state.query, tags: state.filterTags })
      const md = exportMarkdown(novels)
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = '想看小说库.md'
      a.click()
      URL.revokeObjectURL(a.href)
    }),
  )

  app.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener(
      'click',
      withClickGuard((e) => {
        e.stopPropagation()
        state.editingId = btn.dataset.edit
        render()
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
            await runBusy('删除中…', () => deleteNovel(btn.dataset.del))
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
  bindImport()
  bindExcel()
  bindGallery()
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

  app.querySelector('#excel-template')?.addEventListener(
    'click',
    withClickGuard(() => {
      downloadExcelTemplate()
    }),
  )

  const input = app.querySelector('#excel-input')
  app.querySelector('#excel-pick')?.addEventListener('click', () => input?.click())
  input?.addEventListener('change', async () => {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    try {
      await runBusy('读取表格…', async () => {
        const { rows, sheetName, mapping } = await parseExcelFile(file)
        state.excelDrafts = rows
        state.excelInfo = `已读取「${file.name}」工作表 ${sheetName} · ${rows.length} 条 · 列映射：书名=${mapping.titleKey}${mapping.authorKey ? `，作者=${mapping.authorKey}` : ''}${mapping.tagsKey ? `，标签=${mapping.tagsKey}` : ''}`
      })
      render()
    } catch (err) {
      alert(err.message || String(err))
    }
  })

  ;['title', 'author', 'synopsis', 'tags'].forEach((key) => {
    app.querySelectorAll(`[data-ex-${key}]`).forEach((el) => {
      el.addEventListener('input', () => {
        const i = Number(el.getAttribute(`data-ex-${key}`))
        if (Number.isNaN(i)) return
        if (key === 'tags') {
          state.excelDrafts[i].tags = el.value
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean)
        } else {
          state.excelDrafts[i][key] = el.value
        }
      })
    })
  })

  app.querySelectorAll('[data-rm-excel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.excelDrafts.splice(Number(btn.dataset.rmExcel), 1)
      render()
    })
  })

  app.querySelector('#excel-clear')?.addEventListener('click', () => {
    state.excelDrafts = []
    state.excelInfo = ''
    render()
  })

  app.querySelector('#excel-save-all')?.addEventListener(
    'click',
    withClickGuard(async () => {
      if (state.excelImporting || !state.excelDrafts.length) return
      state.excelImporting = true
      render()
      let ok = 0
      const failed = []
      try {
        await runBusy('入库中…', async () => {
          for (const d of state.excelDrafts) {
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
          state.excelDrafts = failed
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

const SWIPE_OPEN = -128

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

    const getOpenX = () => (item.classList.contains('open') ? SWIPE_OPEN : 0)

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
      currentX = Math.min(0, Math.max(SWIPE_OPEN, baseX + dx))
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
        // tap: close if already open
        if (item.classList.contains('open')) {
          content.style.transform = 'translateX(0)'
          item.classList.remove('open')
        }
        return
      }

      const shouldOpen = currentX < SWIPE_OPEN / 2
      if (shouldOpen) {
        closeAllSwipes(content)
        content.style.transform = `translateX(${SWIPE_OPEN}px)`
        item.classList.add('open')
      } else {
        content.style.transform = 'translateX(0)'
        item.classList.remove('open')
      }
    }

    content.addEventListener(
      'touchstart',
      (e) => {
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

  app.querySelector('#modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') {
      state.editingId = null
      render()
    }
  })

  app.querySelector('#modal-cancel')?.addEventListener('click', () => {
    state.editingId = null
    render()
  })

  app.querySelectorAll('[data-toggle-tag]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active')
    })
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
      if (t) t.value = title
      if (a) a.value = author
      if (s) s.value = synopsis
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
    const tags = [...app.querySelectorAll('#tag-picker .tag-chip.active')]
      .map((b) => b.dataset.toggleTag)
      .filter(Boolean)
    try {
      await runBusy('保存中…', async () => {
        await upsertNovel({
          id: state.editingId === 'new' ? undefined : state.editingId,
          title,
          author,
          synopsis,
          tags,
        })
        state.editingId = null
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

function bindImport() {
  if (state.page !== 'import') return

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

  app.querySelectorAll('[data-rm-file]').forEach((img) => {
    img.addEventListener('click', () => {
      const i = Number(img.dataset.rmFile)
      URL.revokeObjectURL(state.importFiles[i].preview)
      state.importFiles.splice(i, 1)
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
          const results = await recognizeImages(files, ({ index, total, progress, name }) => {
            state.progress = {
              label: `识别 ${index + 1}/${total}：${name}（${progress}%）`,
              pct: Math.round(((index + progress / 100) / total) * 100),
            }
            state.actionBusyLabel = state.progress.label
            mountBusyOverlay()
            const bar = app.querySelector('.progress-bar > span')
            const label = app.querySelector('.progress-meta')
            if (bar) bar.style.width = `${state.progress.pct}%`
            if (label) label.textContent = state.progress.label
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
