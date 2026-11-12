# `agy-acp2api` CLIProxyAPI (CPA) 插件

本目录将 `agy-acp2api` 包装为符合 CLIProxyAPI 原生 C-ABI 与官方插件商店（Plugin Store）规范的插件。

---

## 傻瓜式安装方式（CPA 插件商店一键安装）

参照 CPA 官方插件（如 [`cpa-plugin-gemini-cli`](https://github.com/router-for-me/cpa-plugin-gemini-cli) 与 [`CLIProxyAPI-Plugins-Store`](https://github.com/router-for-me/CLIProxyAPI-Plugins-Store)），本仓库已内置全自动多平台打包发布流水线（[`.github/workflows/build.yml`](../.github/workflows/build.yml) 与 [`scripts/package-release.go`](./scripts/package-release.go)）：

### 第 1 步：推送版本 tag 触发 GitHub 自动构建发布
每次推送和 PR 都会在 GitHub Actions 中编译全平台动态库（`linux/amd64`、`linux/arm64`、`darwin/amd64`、`darwin/arm64`、`windows/amd64`）用于校验；只有推送版本 tag（如 `git tag v0.1.1 && git push origin v0.1.1`）时才会发布，打包为官方商店标准格式：
- `agy-acp2api_<版本>_linux_amd64.zip` 等各平台归档包
- `checksums.txt`（SHA-256 校验清单）

并发布到本仓库（`https://github.com/besire/agy-acp2api`）的 **GitHub Releases**，同时更新 `main` 分支上的 `cpa-plugin/releases/` 与 `registry.json`。

### 第 2 步：在 CPA 管理后台添加插件源并一键安装
1. 打开你的 CPA Web 管理后台，进入 **「插件商店 (Plugin Store)」**（或在 `config.yaml` 的 `plugin-store.registry-urls` 中添加）：
   ```text
   https://raw.githubusercontent.com/besire/agy-acp2api/main/registry.json
   ```
2. 在插件商店列表中找到 **`agy-acp2api`（agy-acp2api 网关控制台）**，直接点击 **「安装 (Install)」** 按钮。
3. CPA 会自动识别你的 Ubuntu VPS 架构（如 `linux/amd64`），从 GitHub Release 下载对应的 `.zip`、校验 `checksums.txt`、解压 `agy-acp2api.so` 到 `plugins/` 目录，并自动在 `config.yaml` 中启用插件与热重载，全程无需登录 VPS 编译。

### 第 3 步：打开控制台并切换顶部导航栏
1. 安装完成后，在 CPA 后台打开插件控制台页面：
   ```text
   /v0/resource/plugins/agy-acp2api/index.html
   ```
2. 进入 **「设置」 -> 「界面适配」**，点击 **「顶部 CPA 适配」**，导航栏即刻切换为顶部水平胶囊栏并持久保存。
