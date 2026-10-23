# dsh-compact-window

把 **DSH NEXT** 桌面窗口变成置顶的便签式小窗：只占 425px 宽，随时可以收成一个浮层，边栏变成抽屉，不挤压聊天区。

Small-window mode for the **DSH NEXT** desktop app (Windows): turn the main window into a 425px-wide, always-on-top sticky window. The other desktop client, `dsh desktop`, is not supported.

---

## 功能

- **一键进小窗**：输入框右侧（发送键左边）的"画中画"图标。窗口切成 425 逻辑像素宽、置顶、不占任务栏
- **置顶开关**：小窗顶部右上角、系统按钮左边的"图钉"。取消后其他程序可以盖住它；选择会被记住
- **拖动**：小窗顶部 40px 是拖动带，跨显示器、不同缩放比例都保持 425 逻辑像素宽
- **抽屉式侧栏**：小窗里展开侧栏会以抽屉形式浮在聊天上，不再把文字挤成一团
- **过渡动效**：进出小窗有半透明遮罩 + 缓动动画；侧栏开合在普通窗口下也有 200ms 过渡
- **状态记忆**：小窗位置、置顶偏好会记住；进入小窗前侧栏是开着的，退出时自动恢复

## 环境要求

| 要求 | 说明 |
|---|---|
| **Windows** | 窗口操作走 Win32（user32），macOS/Linux 上插件会让按钮自动隐藏 |
| **DSH NEXT 桌面端** | **只支持 DSH NEXT**。需要能操作原生窗口的桌面宿主；浏览器里的 Web GUI 只是网页，没有窗口可调 |
| **其他桌面客户端** | 另一个桌面端 **`dsh desktop` 未适配，预计不可用**；找不到窗口时插件只会隐藏按钮，不会误操作 |
| **koffi** | DSH NEXT 自带（`resources/app.asar.unpacked/node_modules/koffi`）；找不到时会降级到 PowerShell，无拖动动效 |
| **PowerShell** | 仅用于启动时发现一次窗口句柄；之后全部在 Node 内完成 |

已测试版本：DSH NEXT `0.2.1-rc.2`（profile `desktop`）。

## 安装

在 DSH 的插件管理里搜索 `dsh-compact-window` 安装，或让 Agent 执行：

```
plugin_manager install_bundle dsh-compact-window
```

安装后进入任意会话，输入框右侧会出现小窗按钮；没有出现就刷新一次页面（`Ctrl+R`）。

## 已知限制

- **依赖 DSH 内部布局**：抽屉与侧栏动画依赖框架层的 `data-shell-overlay` / `data-sidebar-collapsed` 和 `grid-template-columns`，这些不是公开契约。DSH 大版本改布局时可能失效，失效表现是"退回原来的挤压样式"，不会崩溃
- **不修改 DSH 安装目录**：所有操作都在运行时通过 Win32 完成，升级 DSH 不会覆盖；卸载插件时会自动还原窗口
- **系统"减弱动态效果"不生效**：为了让侧栏有动画，插件会覆盖框架里 `prefers-reduced-motion` 的禁用规则。不想要动画的话把 `client.js` 里的 `FRAME_ANIM_CSS` 去掉即可

## 实现

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：窗口几何、置顶、隐藏任务栏、拖动循环、动画、`/compact-window` 路由 |
| `client.js` | 客户端半：按钮、拖动带、图钉、遮罩、抽屉样式、侧栏过渡 |
| `window.ps1` | 启动时发现窗口句柄的兜底（koffi 不可用时才走） |
| `cordis.patch.yml` | 插入 `compact-window` 插件行 |
| `locale/*.json` | 插件管理页显示的名称与描述 |
| `icon.svg` | 插件图标 |

窗口操作全部在 Host 进程内用 koffi 直接调 Win32，不拉起额外进程（首次窗口发现除外）。

## License

MIT