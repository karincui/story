/** Soft fills that stay readable on light UI (library-ink palette family). */
const PALETTE = [
  { bg: '#d7ebe8', fg: '#2a5f5c' }, // teal
  { bg: '#dde6f5', fg: '#2f4570' }, // ink blue
  { bg: '#ebe0f2', fg: '#5a3d6e' }, // soft plum
  { bg: '#f3e2d8', fg: '#7a4a32' }, // clay
  { bg: '#e4efd8', fg: '#3f5c2e' }, // moss
  { bg: '#f0e4d0', fg: '#6b5528' }, // sand
  { bg: '#e0e8f0', fg: '#3d5268' }, // slate
  { bg: '#f2dfe4', fg: '#7a3d4d' }, // rose
]

const PRESET = {
  未读: 0,
  已读: 6,
  仙侠: 1,
  玄幻: 4,
  甜宠: 7,
  言情: 3,
  悬疑: 6,
  推理: 2,
  科幻: 0,
  现实: 5,
  历史: 3,
  轻小说: 2,
  追更中: 7,
}

function hashTag(tag) {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
  return h % PALETTE.length
}

export function tagTone(tag) {
  const name = String(tag || '').trim()
  const idx = Object.prototype.hasOwnProperty.call(PRESET, name) ? PRESET[name] : hashTag(name)
  return PALETTE[idx]
}

export function tagStyleAttr(tag) {
  const { bg, fg } = tagTone(tag)
  return `style="--tag-bg:${bg};--tag-fg:${fg}"`
}
