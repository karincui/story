const DB_NAME = 'novel-wishlist-images'
const DB_VERSION = 1
const STORE = 'images'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('打开图库失败'))
  })
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('图库写入失败'))
    tx.onabort = () => reject(tx.error || new Error('图库写入中止'))
  })
}

/** @returns {Promise<Array<{id:string,name:string,type:string,size:number,createdAt:number,blob:Blob}>>} */
export async function listImages() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => {
      const rows = (req.result || []).slice().sort((a, b) => b.createdAt - a.createdAt)
      resolve(rows)
    }
    req.onerror = () => reject(req.error)
  })
}

/** @returns {Promise<{id:string,name:string,type:string,size:number,createdAt:number,blob:Blob}|null>} */
export async function getImage(id) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

/**
 * @param {Array<File|Blob>} files
 * @returns {Promise<string[]>} 新增 id 列表
 */
export async function addImages(files) {
  const list = [...files].filter(Boolean)
  if (!list.length) return []
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const ids = []
  for (const file of list) {
    const id = uid()
    ids.push(id)
    store.put({
      id,
      name: file.name || `截图-${id}.png`,
      type: file.type || 'image/png',
      size: file.size || 0,
      createdAt: Date.now(),
      blob: file,
    })
  }
  await txDone(tx)
  return ids
}

export async function deleteImage(id) {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).delete(id)
  await txDone(tx)
}

export async function deleteImages(ids) {
  const list = [...new Set(ids)].filter(Boolean)
  if (!list.length) return
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  for (const id of list) store.delete(id)
  await txDone(tx)
}
