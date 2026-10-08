/* UI language (SPEC §10).
 *
 * English is the source of truth: `en` defines the key set, `zh` is typed against it, so a
 * missing or stray translation is a compile error rather than a string that silently falls back.
 * `system` resolves against the OS once per `setLang` — like the theme, it is not frozen at boot.
 *
 * Two kinds of string, handled differently:
 *
 *  - **Static shell text** lives in `index.html` with a `data-i18n` (or `-title` / `-aria-label`
 *    / `-placeholder`) attribute; `applyStatic()` fills it. The English text stays inline, so the
 *    shell still reads correctly if this module never runs.
 *  - **Everything rendered by a module** goes through `t()` at render time. A language change
 *    therefore has to re-render, which `main.ts applyLang()` does in one place.
 *
 * Do not put `data-i18n` on text a module owns (the watcher count, the viewer's engine name):
 * `applyStatic()` would overwrite live data with the key's fallback.
 */
import type { Lang } from "./ipc";

export type { Lang };

const en = {
  // ---- window chrome ----
  "tabs.allTitle": "all tabs (ctrl shift A)",
  "tabs.allAria": "all tabs",
  "win.minimize": "minimize",
  "win.maximize": "maximize",
  "win.close": "close",
  "sidebar.toggle": "toggle sidebar (ctrl B)",
  "sidebar.resize": "resize explorer",
  "view.preview": "preview",
  "view.split": "split",
  "view.source": "source",
  "toolbar.rerender": "re-render (ctrl R)",
  "find.trigger": "find (ctrl F)",
  "find.label": "find",
  "outline.toggle": "toggle outline (ctrl alt O)",
  "outline.resize": "resize outline",
  "theme.toggle": "toggle theme",
  "settings.open": "settings (ctrl ,)",

  // ---- sidebar / empty state ----
  "sidebar.label": "explorer",
  "sidebar.openFolder": "open folder",
  "sidebar.openFolderTitle": "open folder (ctrl shift O)",
  "sidebar.filter": "filter by name · esc closes",
  "sidebar.showFilter": "filter by file name",
  "sidebar.mdOnlyTitle": "list markdown files only",
  "sidebar.noMatches": "no files match the filter",
  "sidebar.noMarkdown": "no markdown files here",
  "sidebar.watching": "watching {n} files",
  "empty.title": "Drop a folder or .md file here",
  "empty.subtitle": "mermaid · dot · d2 render locally — no network needed, no telemetry",
  "empty.openFolder": "open folder",
  "empty.openFile": "open file",
  "empty.shortcutOpen": "open",
  "empty.shortcutRecent": "recent",
  "empty.shortcutHelp": "help",
  "empty.recentHead": "recent",

  // ---- views / find ----
  "view.readonly": "read-only",
  "find.placeholder": "find in document",
  "find.prevTitle": "previous (shift enter)",
  "find.prev": "previous match",
  "find.nextTitle": "next (enter)",
  "find.next": "next match",
  "find.case": "match case",
  "find.closeTitle": "close (esc)",
  "find.close": "close find",

  // ---- diagram viewer ----
  "viewer.zoomOut": "zoom out",
  "viewer.zoomReset": "reset zoom",
  "viewer.zoomIn": "zoom in",
  "viewer.copySvg": "copy svg",
  "viewer.copySource": "copy source",
  "viewer.closeTitle": "close (esc)",
  "viewer.close": "close",
  "viewer.hints": "scroll to zoom · drag to pan · esc to close",
  "viewer.noOutput": "this diagram has no rendered output yet",

  // ---- diagram cards ----
  "diagram.loading": "rendering…",

  // ---- overlays ----
  "settings.title": "settings",
  "settings.closeTitle": "close (esc)",
  "settings.close": "close settings",
  "help.title": "help",
  "help.closeTitle": "close (esc)",
  "help.close": "close help",
  "help.licences": "engines — mermaid (MIT) · graphviz (Apache-2.0) · d2 (MPL-2.0)",

  // ---- about ----
  "about.toolbar": "about",
  "about.title": "about",
  "about.closeTitle": "close (esc)",
  "about.close": "close about",
  "about.intro": "A fast, minimal Markdown reader: typesetting and diagrams are produced on this machine, and nothing about you is sent anywhere. The only request it makes on its own is the update manifest — a version number and a download URL. Capabilities: preview · split · source　edit in place on request, saved with the file's own encoding and line endings　mermaid · dot · d2 · math · code colouring rendered locally　width presets · font size · zoom　outline · find · immersive reading　session restore · live reload　bilingual · light and dark",
  "about.k.author": "author",
  // The author's name as he writes it — deliberately not transliterated.
  "about.author": "道荣（黄超）",
  "about.k.engines": "engines",
  "about.d2Note": "bundled — wasm inlined (~11.5 MB)",
  "about.k.editor": "editor",
  "about.editorNote": "CodeMirror 6 — loaded on demand, ~0.5 MB minified (167 KB gzip)",
  "about.k.data": "data",
  "about.reveal": "open",
  "about.github": "open the project page on GitHub",
  "about.checkUpdate": "check for updates",
  "about.checking": "checking…",
  "about.upToDate": "up to date (v{v})",
  "about.available": "v{v} is available",
  "about.installUpdate": "download and install",
  "about.downloading": "downloading {n}%",
  "about.downloadingUnknown": "downloading…",
  "about.installing": "installing… the app will restart",
  "about.updateFailed": "update failed: {msg}",
  "about.notices": "shipped with the app: LICENSE · THIRD-PARTY.md",
  "about.k.logs": "logs",
  "about.openLogs": "open",
  // "logs" is the effective directory; the unclean one names the run that died so a report can be matched to it.
  "about.unclean": "the previous run did not shut down cleanly (run {run})",

  // ---- outline ----
  "outline.label": "outline",
  "outline.diagrams": "diagrams",
  "outline.none": "none",
  "outline.diagram": "diagram",

  // ---- status bar ----
  "status.words": "{n} words",
  "status.rendered": "rendered in {n} ms",
  "status.watching": "watching {n} files",
  "status.lossyTitle": "the file is not valid UTF-8; invalid bytes were replaced while rendering",
  "status.truncated": "truncated",
  "status.truncatedTitle": "the file is larger than 8 MB — only its first 8 MB is shown",
  "status.engine": "{id} engine",
  "status.measureTitle": "reading width — {name}",
  "status.resetZoom": "reset zoom (ctrl 0)",
  "status.updateAvailable": "v{v} available",
  "status.updateTitle": "open about to update",

  // ---- immersive ----
  "immersive.exit": "exit",
  "immersive.toast": "immersive — hover the top edge or press esc to exit",

  // ---- theme / language values ----
  "theme.system": "system",
  "theme.light": "light",
  "theme.dark": "dark",
  "theme.switchLight": "switch to light",
  "theme.switchDark": "switch to dark",
  "lang.system": "system",
  "measure.narrow": "narrow",
  "measure.comfortable": "comfortable",
  "measure.full": "full",

  // ---- tabs / menus ----
  "tabs.all": "all tabs · {n}",
  "tab.close": "close tab",
  "tab.changed": "changed on disk",
  "menu.recent": "recent",

  // ---- toasts ----
  "toast.sourceCopied": "source copied to clipboard",
  "toast.svgCopied": "svg copied to clipboard",
  "toast.noRecent": "no recent files yet",
  "toast.noTabs": "no tabs open",
  "toast.cacheCleared": "render cache cleared",
  "toast.logOpenFailed": "could not open the log folder",
  "toast.logDirChanged": "logs now go to {path}",
  "toast.logDirFailed": "could not change the log directory",

  // ---- errors ----
  "err.gone": "{path} is gone",
  "err.denied": "no permission to read {path}",
  "err.notText": "{path} is not a text file",
  "err.conflict": "{path} changed on disk since it was opened, so the save was refused",
  "err.refused": "refused to write {path}",

  // ---- editing (SPEC §12) ----
  "view.editing": "editing",
  "view.editTitle": "edit (ctrl E)",
  "view.doneTitle": "done (esc)",
  "view.blocked.truncated": "not editable — the file is past the 8 MiB cap, so only its start is here",
  "view.blocked.lossy": "not editable — the file is not valid UTF-8, so saving would make the replacement permanent",
  "view.blocked.mixed": "not editable — the file mixes line endings, so saving would rewrite them all",
  "view.blocked.missing": "not editable — the file is gone",
  "view.blocked.readonly": "not editable — the file is read-only for this user",
  "edit.failed": "the editor could not load, so the pane stays read-only",
  "edit.pinned": "pinned — a preview tab is reused in place, so edits would be replaced by the next click",
  "edit.saved": "saved",
  "edit.unsaved": "unsaved",
  "edit.reloaded": "{name} changed on disk — the buffer was reloaded",
  "edit.saveTitle": "save (ctrl S)",
  "unsaved.title": "unsaved changes",
  "unsaved.save": "save",
  "unsaved.discard": "discard",
  "unsaved.cancel": "cancel",
  "unsaved.leave": "leave the editable pane",
  "unsaved.close": "close {name}",
  "unsaved.closeMany": "close {n} unsaved tabs",
  "unsaved.quit": "Quit with {n} unsaved buffer(s)",
  "unsaved.body": "{what}? This buffer has changes that are not in the file.",

  // ---- settings rows ----
  "settings.section.reading": "reading",
  "settings.section.files": "files",
  "settings.section.cache": "cache",
  "settings.section.diagnostics": "diagnostics",
  "settings.logLevel": "log level",
  "settings.logLevelSub": "written to a file on this machine; nothing is uploaded",
  "settings.level.off": "off",
  "settings.level.error": "error",
  "settings.level.warn": "warn",
  "settings.level.info": "info",
  "settings.level.debug": "debug",
  "settings.logDir": "log directory",
  "settings.logDirSub": "empty uses the platform default",
  "settings.logDirChange": "change…",
  "settings.logDirReset": "reset",
  "settings.theme": "theme",
  "settings.themeSub": "follows the system by default",
  "settings.fontSize": "document font size",
  "settings.fontSizeSub": "multiplies with the status bar zoom, never overrides it",
  "settings.measure": "reading width",
  "settings.measureSub": "the column every block shares — headings, tables and code included",
  "settings.smaller": "smaller",
  "settings.larger": "larger",
  "settings.reduceMotion": "reduce motion",
  "settings.reduceMotionSub": "also respects the OS setting",
  "settings.math": "math",
  "settings.mathSub": "renders $…$ and $$…$$ · off by default, so prices stay prices",
  "settings.language": "language",
  "settings.languageSub": "applies immediately, persisted with the session",
  "settings.cacheSvg": "rendered svg",
  "settings.cacheSub": "in memory, capped at 6 MB",
  "settings.clear": "clear",
  "settings.empty": "empty",
  "settings.defaultApp": "default app",
  "settings.defaultAppSub": "what opens .md files",
  "settings.defaultAppIs": "opens .md files: {name}",
  "settings.defaultAppNone": "not MarkdownAura",
  "settings.defaultAppSet": "make default",
  "settings.defaultAppChoose": "choose…",
  "toast.defaultAppSet": "MarkdownAura is now the default .md app",
  "toast.defaultAppDialog": "pick MarkdownAura in the dialog and tick \u201calways\u201d",
  "toast.defaultAppSettings": "the Windows settings page is open — pick MarkdownAura there",
  "toast.defaultAppFailed": "could not change the default app",
  "toast.defaultAppOffer": "MarkdownAura is not your default .md app — Settings has a row for it",

  // ---- help ----
  "help.group.file": "file",
  "help.group.view": "view",
  "help.group.find": "find",
  "help.group.edit": "edit",
  "help.syntaxHead": "diagram syntax",
  "help.note.mermaid": "flowchart, sequence, er, gantt",
  "help.note.dot": "graphviz digraph syntax",
  "help.note.d2": "bundled (~11.5 MB)",
  "help.key.openFile": "open file",
  "help.key.openFolder": "open folder",
  "help.key.recent": "recent files",
  "help.key.listTabs": "list all tabs",
  "help.key.closeTab": "close tab",
  "help.key.nextTab": "next tab",
  "help.key.goToTab": "go to tab",
  "help.key.toggleSidebar": "toggle sidebar",
  "help.key.toggleOutline": "toggle outline",
  "help.key.reRender": "re-render",
  "help.key.settings": "settings",
  "help.key.zoom": "zoom in / out",
  "help.key.zoomReset": "reset zoom",
  "help.key.measure": "reading width",
  "help.key.immersive": "immersive",
  "help.key.help": "help",
  "help.key.find": "find in document",
  "help.key.nextMatch": "next match",
  "help.key.prevMatch": "previous match",
  "help.key.closeFind": "close the topmost layer",
  "help.key.edit": "edit the source pane",
  "help.key.save": "save",
  "help.key.undo": "undo, while the pane is editable",
  "help.key.redo": "redo, while the pane is editable",
} as const;

export type Key = keyof typeof en;
type Params = Record<string, string | number>;

const zh: Record<Key, string> = {
  "tabs.allTitle": "全部标签页 (ctrl shift A)",
  "tabs.allAria": "全部标签页",
  "win.minimize": "最小化",
  "win.maximize": "最大化",
  "win.close": "关闭",
  "sidebar.toggle": "显示/隐藏侧栏 (ctrl B)",
  "sidebar.resize": "调整资源管理器宽度",
  "view.preview": "预览",
  "view.split": "分栏",
  "view.source": "源码",
  "toolbar.rerender": "重新渲染 (ctrl R)",
  "find.trigger": "查找 (ctrl F)",
  "find.label": "查找",
  "outline.toggle": "显示/隐藏大纲 (ctrl alt O)",
  "outline.resize": "调整大纲宽度",
  "theme.toggle": "切换主题",
  "settings.open": "设置 (ctrl ,)",

  "sidebar.label": "资源管理器",
  "sidebar.openFolder": "打开文件夹",
  "sidebar.openFolderTitle": "打开文件夹 (ctrl shift O)",
  "sidebar.filter": "按文件名筛选 · esc 收起",
  "sidebar.showFilter": "按文件名筛选",
  "sidebar.mdOnlyTitle": "只列出 Markdown 文件",
  "sidebar.noMatches": "没有匹配的文件",
  "sidebar.noMarkdown": "这里没有 Markdown 文件",
  "sidebar.watching": "正在监视 {n} 个文件",
  "empty.title": "把文件夹或 .md 文件拖到这里",
  "empty.subtitle": "mermaid · dot · d2 本地渲染 — 无需联网、不采集任何数据",
  "empty.openFolder": "打开文件夹",
  "empty.openFile": "打开文件",
  "empty.shortcutOpen": "打开",
  "empty.shortcutRecent": "最近",
  "empty.shortcutHelp": "帮助",
  "empty.recentHead": "最近",

  "view.readonly": "只读",
  "find.placeholder": "在文档中查找",
  "find.prevTitle": "上一个 (shift enter)",
  "find.prev": "上一个匹配",
  "find.nextTitle": "下一个 (enter)",
  "find.next": "下一个匹配",
  "find.case": "区分大小写",
  "find.closeTitle": "关闭 (esc)",
  "find.close": "关闭查找",

  "viewer.zoomOut": "缩小",
  "viewer.zoomReset": "重置缩放",
  "viewer.zoomIn": "放大",
  "viewer.copySvg": "复制 SVG",
  "viewer.copySource": "复制源码",
  "viewer.closeTitle": "关闭 (esc)",
  "viewer.close": "关闭",
  "viewer.hints": "滚轮缩放 · 拖拽平移 · esc 关闭",
  "viewer.noOutput": "该图表尚未渲染出结果",

  // ---- diagram cards ----
  "diagram.loading": "渲染中…",

  "settings.title": "设置",
  "settings.closeTitle": "关闭 (esc)",
  "settings.close": "关闭设置",
  "help.title": "帮助",
  "help.closeTitle": "关闭 (esc)",
  "help.close": "关闭帮助",
  "help.licences": "引擎 — mermaid (MIT) · graphviz (Apache-2.0) · d2 (MPL-2.0)",

  "about.toolbar": "关于",
  "about.title": "关于",
  "about.closeTitle": "关闭 (esc)",
  "about.close": "关闭关于",
  "about.intro": "极速极简的 Markdown 阅读器：排版和图表都在本机完成，不向任何地方发送关于你的信息。它唯一会自行发起的请求是更新清单——一个版本号与一个下载地址。能力：预览 · 分栏 · 源码　按需就地编辑 · 按原编码与行尾写回　mermaid · dot · d2 · 数学 · 代码着色 本地渲染　行宽档位 · 字号 · 缩放　大纲 · 查找 · 沉浸阅读　会话恢复 · 变更自动刷新　中英双语 · 深浅主题",
  "about.k.author": "作者",
  "about.author": "道荣（黄超）",
  "about.k.engines": "引擎",
  "about.d2Note": "已内置 — wasm 内联（约 11.5 MB）",
  "about.k.editor": "编辑器",
  "about.editorNote": "CodeMirror 6 — 按需加载，约 0.5 MB（gzip 167 KB）",
  "about.k.data": "数据",
  "about.reveal": "打开",
  "about.github": "在 GitHub 上打开项目主页",
  "about.checkUpdate": "检查更新",
  "about.checking": "检查中…",
  "about.upToDate": "已是最新（v{v}）",
  "about.available": "发现新版本 v{v}",
  "about.installUpdate": "下载并安装",
  "about.downloading": "下载中 {n}%",
  "about.downloadingUnknown": "下载中…",
  "about.installing": "安装中…应用将自动重启",
  "about.updateFailed": "更新失败：{msg}",
  "about.notices": "随程序分发：LICENSE · THIRD-PARTY.md",
  "about.k.logs": "日志",
  "about.openLogs": "打开",
  "about.unclean": "上次运行没有正常退出（运行 {run}）",

  "outline.label": "大纲",
  "outline.diagrams": "图表",
  "outline.none": "无",
  "outline.diagram": "图表",

  "status.words": "{n} 词",
  "status.rendered": "渲染耗时 {n} ms",
  "status.watching": "正在监视 {n} 个文件",
  "status.lossyTitle": "文件不是合法 UTF-8；渲染时非法字节已被替换",
  "status.truncated": "已截断",
  "status.truncatedTitle": "文件超过 8 MB — 仅显示前 8 MB",
  "status.engine": "{id} 引擎",
  "status.measureTitle": "阅读宽度 — {name}",
  "status.resetZoom": "重置缩放 (ctrl 0)",
  "status.updateAvailable": "有 v{v} 可用",
  "status.updateTitle": "打开关于面板进行更新",

  "immersive.exit": "退出",
  "immersive.toast": "沉浸模式 — 悬停顶部边缘或按 esc 退出",

  "theme.system": "跟随系统",
  "theme.light": "浅色",
  "theme.dark": "深色",
  "theme.switchLight": "切换到浅色",
  "theme.switchDark": "切换到深色",
  "lang.system": "跟随系统",
  "measure.narrow": "窄",
  "measure.comfortable": "舒适",
  "measure.full": "撑满",

  "tabs.all": "全部标签页 · {n}",
  "tab.close": "关闭标签页",
  "tab.changed": "磁盘上已改动",
  "menu.recent": "最近",

  "toast.sourceCopied": "源码已复制到剪贴板",
  "toast.svgCopied": "SVG 已复制到剪贴板",
  "toast.noRecent": "暂无最近文件",
  "toast.noTabs": "没有打开的标签页",
  "toast.cacheCleared": "渲染缓存已清空",
  "toast.logOpenFailed": "无法打开日志文件夹",
  "toast.logDirChanged": "日志现在写入 {path}",
  "toast.logDirFailed": "无法更改日志目录",

  "err.gone": "{path} 已不存在",
  "err.denied": "没有读取 {path} 的权限",
  "err.notText": "{path} 不是文本文件",
  "err.conflict": "{path} 在打开之后已被改动，因此拒绝保存",
  "err.refused": "拒绝写入 {path}",

  "view.editing": "编辑中",
  "view.editTitle": "编辑 (ctrl E)",
  "view.doneTitle": "完成 (esc)",
  "view.blocked.truncated": "不可编辑——文件超过 8 MiB 上限，这里只有它的开头",
  "view.blocked.lossy": "不可编辑——文件不是合法 UTF-8，保存会让替换字符永久化",
  "view.blocked.mixed": "不可编辑——文件混用了行尾，保存会把它们全部改写",
  "view.blocked.missing": "不可编辑——文件已不存在",
  "view.blocked.readonly": "不可编辑——该文件对当前用户只读",
  "edit.failed": "编辑器加载失败，窗格保持只读",
  "edit.pinned": "已转为常驻——预览标签页会被就地复用，否则编辑会被下一次点击替换",
  "edit.saved": "已保存",
  "edit.unsaved": "未保存",
  "edit.reloaded": "{name} 已在磁盘上被改动——缓冲区已重新载入",
  "edit.saveTitle": "保存 (ctrl S)",
  "unsaved.title": "未保存的修改",
  "unsaved.save": "保存",
  "unsaved.discard": "放弃",
  "unsaved.cancel": "取消",
  "unsaved.leave": "离开编辑状态",
  "unsaved.close": "关闭 {name}",
  "unsaved.closeMany": "关闭 {n} 个未保存的标签页",
  "unsaved.quit": "带着 {n} 个未保存的缓冲区退出",
  "unsaved.body": "{what}？这个缓冲区里有尚未写入文件的修改。",

  "settings.section.reading": "阅读",
  "settings.section.files": "文件",
  "settings.section.cache": "缓存",
  "settings.section.diagnostics": "诊断",
  "settings.logLevel": "日志级别",
  "settings.logLevelSub": "写入本机的日志文件；不上传任何内容",
  "settings.level.off": "关闭",
  "settings.level.error": "错误",
  "settings.level.warn": "警告",
  "settings.level.info": "信息",
  "settings.level.debug": "调试",
  "settings.logDir": "日志目录",
  "settings.logDirSub": "留空则使用平台默认位置",
  "settings.logDirChange": "更改…",
  "settings.logDirReset": "重置",
  "settings.theme": "主题",
  "settings.themeSub": "默认跟随系统",
  "settings.fontSize": "正文字号",
  "settings.fontSizeSub": "与状态栏缩放相乘，互不覆盖",
  "settings.measure": "阅读宽度",
  "settings.measureSub": "所有内容共用这一栏——标题、表格、代码都在内",
  "settings.smaller": "减小",
  "settings.larger": "增大",
  "settings.reduceMotion": "减少动效",
  "settings.reduceMotionSub": "同时遵循系统设置",
  "settings.math": "数学公式",
  "settings.mathSub": "渲染 $…$ 与 $$…$$ · 默认关闭，价格数字不会被当成公式",
  "settings.language": "语言",
  "settings.languageSub": "立即生效，随会话保存",
  "settings.cacheSvg": "已渲染 SVG",
  "settings.cacheSub": "内存中，上限 6 MB",
  "settings.clear": "清空",
  "settings.empty": "空",
  "settings.defaultApp": "默认应用",
  "settings.defaultAppSub": "打开 .md 用的是哪个应用",
  "settings.defaultAppIs": "打开 .md：{name}",
  "settings.defaultAppNone": "不是 MarkdownAura",
  "settings.defaultAppSet": "设为默认",
  "settings.defaultAppChoose": "去选择…",
  "toast.defaultAppSet": "MarkdownAura 现在是默认的 .md 应用",
  "toast.defaultAppDialog": "在对话框里选 MarkdownAura，并勾上\u201c始终\u201d",
  "toast.defaultAppSettings": "已打开 Windows 设置页，在那里选 MarkdownAura",
  "toast.defaultAppFailed": "未能更改默认应用",
  "toast.defaultAppOffer": "MarkdownAura 还不是你的默认 .md 应用——设置里有对应一行",

  "help.group.file": "文件",
  "help.group.view": "视图",
  "help.group.find": "查找",
  "help.group.edit": "编辑",
  "help.syntaxHead": "图表语法",
  "help.note.mermaid": "flowchart、sequence、er、gantt",
  "help.note.dot": "graphviz digraph 语法",
  "help.note.d2": "已内置（约 11.5 MB）",
  "help.key.openFile": "打开文件",
  "help.key.openFolder": "打开文件夹",
  "help.key.recent": "最近文件",
  "help.key.listTabs": "列出全部标签页",
  "help.key.closeTab": "关闭标签页",
  "help.key.nextTab": "下一个标签页",
  "help.key.goToTab": "跳到第 N 个标签页",
  "help.key.toggleSidebar": "显示/隐藏侧栏",
  "help.key.toggleOutline": "显示/隐藏大纲",
  "help.key.reRender": "重新渲染",
  "help.key.settings": "设置",
  "help.key.zoom": "缩小 / 放大",
  "help.key.zoomReset": "重置缩放",
  "help.key.measure": "阅读宽度",
  "help.key.immersive": "沉浸模式",
  "help.key.help": "帮助",
  "help.key.find": "在文档中查找",
  "help.key.nextMatch": "下一个匹配",
  "help.key.prevMatch": "上一个匹配",
  "help.key.closeFind": "关闭最上层",
  "help.key.edit": "编辑源码窗格",
  "help.key.save": "保存",
  "help.key.undo": "撤销（编辑状态下）",
  "help.key.redo": "重做（编辑状态下）",
};

const CATALOGUES: Record<"en" | "zh-CN", Record<Key, string>> = { en, "zh-CN": zh };

export type Resolved = keyof typeof CATALOGUES;

let active: Resolved = "en";

function resolve(lang: Lang): Resolved {
  if (lang !== "system") return lang;
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  return tags.some((tag) => tag.toLowerCase().startsWith("zh")) ? "zh-CN" : "en";
}

/** The stored choice lives in `state.lang`; this module only keeps the resolution of it. */
export function setLang(next: Lang): void {
  active = resolve(next);
}

function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export function t(key: Key, params?: Params): string {
  const text = CATALOGUES[active][key] ?? CATALOGUES.en[key] ?? key;
  return interpolate(text, params);
}

/** Locale-aware number formatting, so `1480342` groups the way the active language expects.
 *  Three call sites (`statusbar`, `settings`) must agree on the locale, which is why it lives
 *  here rather than being a `toLocaleString()` sprinkled at each one. */
export function num(value: number): string {
  return value.toLocaleString(active);
}

const ATTRS: Array<[string, string]> = [
  ["data-i18n", "textContent"],
  ["data-i18n-title", "title"],
];

/** Fills the static shell. Called on boot and after every language change. */
export function applyStatic(root: ParentNode = document): void {
  for (const [attr, prop] of ATTRS) {
    for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      const key = el.getAttribute(attr) as Key | null;
      if (!key) continue;
      if (prop === "textContent") el.textContent = t(key);
      else el.title = t(key);
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    const key = el.getAttribute("data-i18n-aria-label") as Key | null;
    if (key) el.setAttribute("aria-label", t(key));
  }
  for (const el of root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    const key = el.getAttribute("data-i18n-placeholder") as Key | null;
    if (key) el.placeholder = t(key);
  }
  document.documentElement.lang = active;
}
