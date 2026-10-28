# 书单

本地网页小工具：把感兴趣、还没看的小说存进自己的库；支持截图 OCR 导入、多标签分类、作者/简介，方便以后搜索。

## 线上部署

Vercel + Supabase 的发布步骤、环境变量与回调地址配置见 **[docs/部署说明.md](docs/部署说明.md)**。

## 使用

```bash
cd novel-app
npm install
npm run dev
```

浏览器打开终端里提示的地址（一般是 `http://localhost:5173`）。

数据默认存 **Supabase 云端**（邮箱 + 密码登录后同步）。首次登录若本地还有旧书单会自动上传一次。图库截图仍在本机 IndexedDB。

### 接入 Supabase（一次性）

1. 复制 `.env.example` 为 `.env`，填入 `VITE_SUPABASE_URL` 与 Publishable/anon key  
2. 在 Supabase **SQL Editor** 执行 `supabase/schema.sql`  
3. **Authentication → Providers → Email**：开启 Email；个人自用建议关闭 **Confirm email**（否则注册后还要点邮件）  
4. **Authentication → URL Configuration**：Site URL / Redirect URLs 填本地或 Vercel 地址  
5. `npm run dev` 后用「注册 / 登录」创建账号

## 功能

- **小说库**：卡片展示书名、作者、标签、简介；搜索书名/作者/标签；左侧多选标签筛选
- **标签**：内置预设（未读、仙侠、甜宠…），可随时「+ 新标签」
- **截图导入**：单本封面或多本书单（如「书名 by 作者」列表）→ OCR 识别 → 核对后可全部入库
- **Excel 导入**：下载模板或上传 `.xlsx` / `.xls` / `.csv`（列：书名、作者、简介、标签），预览后批量入库
- **手动添加 / 编辑 / 删除**、可选附件（≤20MB）；`.txt` 可在应用内阅读（自动识别 UTF-8 / UTF-16 / GBK）
- **导出 Markdown**

## 配色

方案 A「图书馆墨色」：蓝灰底 `#E8EEF2`、墨蓝字 `#1B2A4A`、青绿强调 `#3D7A7A`。
