import {
  isStoreEmpty,
  bulkInsertNovels,
  replacePrefsFromLocal,
  refreshStore,
} from './store.js'

const STORAGE_KEY = 'novel-wishlist-v1'
const TAGS_KEY = 'novel-wishlist-tags-v1'
const HIDDEN_PRESETS_KEY = 'novel-wishlist-hidden-presets-v1'
const MIGRATED_FLAG = 'novel-wishlist-migrated-to-supabase'

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

/**
 * 若云端为空且本地还有旧书单，则上传一次。
 * @returns {Promise<{ migrated: boolean, count: number }>}
 */
export async function migrateLocalIfNeeded() {
  if (localStorage.getItem(MIGRATED_FLAG) === '1') {
    return { migrated: false, count: 0 }
  }
  await refreshStore()
  if (!isStoreEmpty()) {
    localStorage.setItem(MIGRATED_FLAG, '1')
    return { migrated: false, count: 0 }
  }

  const localNovels = readJson(STORAGE_KEY, [])
  const customTags = readJson(TAGS_KEY, [])
  const hiddenPresets = readJson(HIDDEN_PRESETS_KEY, [])
  if (!localNovels.length && !customTags.length && !hiddenPresets.length) {
    localStorage.setItem(MIGRATED_FLAG, '1')
    return { migrated: false, count: 0 }
  }

  if (customTags.length || hiddenPresets.length) {
    await replacePrefsFromLocal({ customTags, hiddenPresets })
  }
  const count = await bulkInsertNovels(localNovels)
  localStorage.setItem(MIGRATED_FLAG, '1')
  // 保留本地备份，不自动删除，避免迁移失败丢数据
  return { migrated: true, count }
}
