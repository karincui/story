import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  console.error('缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY，请检查 .env')
}

/** 登录态写入 localStorage，并自动刷新 token，短期内无需反复登录 */
export const supabase = createClient(url || '', key || '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: typeof localStorage === 'undefined' ? undefined : localStorage,
    storageKey: 'novel-app-auth',
  },
})
