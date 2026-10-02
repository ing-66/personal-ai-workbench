import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { InterfaceLanguage } from "@t3tools/contracts/settings";

import { useClientSettings } from "./hooks/useSettings";

type TranslationValues = Readonly<Record<string, string | number>>;
type Translate = (english: string, values?: TranslationValues) => string;

const ZH_CN: Readonly<Record<string, string>> = {
  English: "English",
  "Simplified Chinese": "简体中文",
  "Interface language": "界面语言",
  "Choose the language used by menus, settings, dialogs, notifications, and other first-party interface text.":
    "选择菜单、设置、对话框、通知及其他应用界面所使用的语言。",
  Language: "语言",
  Settings: "设置",
  "All environments": "所有环境",
  "All projects": "所有项目",
  "Unavailable environment": "环境不可用",
  "Unavailable project": "项目不可用",
  Project: "项目",
  General: "通用",
  Appearance: "外观",
  Keybindings: "快捷键",
  SnapShots: "截图",
  Providers: "提供商",
  "Model Gateway": "模型网关",
  Integrations: "集成",
  "Source Control": "源代码管理",
  Connections: "连接",
  Archive: "归档",
  "Search settings...": "搜索设置…",
  "No settings found": "未找到设置",
  Organization: "组织",
  Behavior: "行为",
  "New threads": "新任务",
  Model: "模型",
  Permissions: "权限",
  Workspace: "工作区",
  "Default model for new threads. Projects can override it.":
    "新任务的默认模型，项目可以单独覆盖。",
  "Default permissions for new threads. Projects can override them.":
    "新任务的默认权限，项目可以单独覆盖。",
  "Where new threads start, unless overridden by the project or t3.json.":
    "新任务的起始工作区，项目设置或 t3.json 可以覆盖它。",
  Automatic: "自动",
  "No providers available": "没有可用的提供商",
  "Current checkout": "当前检出目录",
  "Current worktree": "当前工作树",
  "New worktree": "新建工作树",
  "Select ref": "选择引用",
  Search: "搜索",
  "Search threads": "搜索任务",
  "Clear thread search": "清除任务搜索",
  "New thread": "新任务",
  "New project": "新建项目",
  "Add a project": "添加项目",
  "Add a project to start": "添加项目后开始",
  "Choose a project": "选择项目",
  "Change project": "更换项目",
  "Choose a project to start": "选择项目后开始",
  "What should we build in {project}?": "要在 {project} 中构建什么？",
  Active: "进行中",
  Snoozed: "已暂缓",
  "Snoozed ({count})": "已暂缓（{count}）",
  Settled: "已收起",
  "Settled ({count})": "已收起（{count}）",
  "{environment} is reconnecting": "{environment} 正在重新连接",
  "{environment} is offline": "{environment} 已离线",
  Reconnect: "重新连接",
  "Disconnect server": "断开服务器",
  "Enable a provider in Settings": "请在设置中启用提供商",
  "Enable a provider in Settings to send a message": "请在设置中启用提供商后发送消息",
  "Open provider settings": "打开提供商设置",
  "No provider available": "没有可用的提供商",
  "Add action": "添加操作",
  Open: "打开",
  Commit: "提交",
  "Git actions": "Git 操作",
  "Full access": "完全访问",
  Supervised: "需确认",
  "Auto-accept edits": "自动接受编辑",
  Auto: "自动",
  "Allow commands and edits without prompts.": "无需确认即可执行命令和编辑。",
  "Ask before commands and file changes.": "执行命令或修改文件前先询问。",
  "Auto-approve edits, ask before other actions.": "自动批准编辑，其他操作仍需询问。",
  "Supported providers approve routine actions; others still ask.":
    "受支持的提供商会自动批准常规操作，其他操作仍需询问。",
  "{provider} provider status": "{provider} 提供商状态",
  "{provider} is unauthenticated": "{provider} 尚未认证",
  "Open provider setup": "打开提供商设置",
  "Ask anything...": "输入任何问题…",
  "Send a message to start the conversation.": "发送消息以开始对话。",
  "Ask for changes, send follow-ups, or attach images": "提出修改、继续追问或添加图片",
  "Ask anything, @tag files/folders, $use skills, or / for commands":
    "输入任何问题，使用 @ 标记文件或文件夹，使用 $ 调用技能，或输入 / 查看命令",
  "Project grouping": "项目分组",
  "Combine matching repositories across environments.": "合并不同环境中相同的代码仓库。",
  "Auto-settle merged threads": "自动收起已合并任务",
  "Auto-settle inactive threads": "自动收起不活跃任务",
  "Days of inactivity before auto-settle": "自动收起前的不活跃天数",
  "Settle a thread when its pull request merges. Closed pull requests still settle automatically.":
    "拉取请求合并时收起对应任务；已关闭的拉取请求仍会自动收起。",
  "Sidebar threads with no activity for this long settle automatically.":
    "侧边栏任务在此期限内无活动时自动收起。",
  "Any new activity un-settles a thread automatically.": "出现新活动时会自动恢复该任务。",
  "Thread notifications": "任务通知",
  "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while T3 Code is open.":
    "任务完成、失败或需要输入、批准时显示系统通知；仅在此设备上的 T3 Code 运行期间生效。",
  Off: "关闭",
  "In-app notifications": "应用内通知",
  "Show a toast when another thread finishes, fails, or needs input or approval while this app has focus.":
    "当应用处于前台且其他任务完成、失败或需要输入或批准时显示通知。",
  "Time format": "时间格式",
  "System default follows your browser or OS clock preference.":
    "系统默认值将遵循浏览器或操作系统的时间格式。",
  "System default": "系统默认",
  "12-hour": "12 小时制",
  "24-hour": "24 小时制",
  "Response streaming": "响应流式显示",
  "Each paragraph or code block appears as soon as it is complete.":
    "每个段落或代码块完成后立即显示。",
  "Show finished paragraphs": "显示已完成的段落",
  "Hide whitespace changes": "隐藏空白字符变更",
  "Set whether the diff panel ignores whitespace-only edits by default.":
    "设置差异面板是否默认忽略仅包含空白字符的修改。",
  "Default diff file state": "差异文件默认状态",
  "Start with files expanded or collapsed when opening diffs or a pull request's Code tab.":
    "打开差异或拉取请求的代码页时，默认展开或折叠文件。",
  Expanded: "展开",
  "Diff layout": "差异布局",
  "Show diffs stacked or side by side. The toggle in the diff toolbar changes this too.":
    "以纵向堆叠或左右并排方式显示差异，差异工具栏中的开关也会修改此项。",
  Stacked: "纵向堆叠",
  Split: "左右并排",
  "Proactive panels": "主动面板",
  "Open linked pull requests when found and turn diffs when work changes files.":
    "发现关联拉取请求时自动打开；任务修改文件时打开本轮差异。",
  "Show skills in slash menu": "在斜杠菜单中显示技能",
  "Also include skills in the / command menu. Skills always appear when you type $.":
    "同时在 / 命令菜单中列出技能；输入 $ 时始终会显示技能。",
  "Collapse composer on scroll": "滚动时折叠输入框",
  "Provider update checks": "提供商更新检查",
  "Continue threads after restarts": "重启后继续任务",
  "Background activity": "后台活动",
  Balanced: "均衡",
  "Projects & threads": "项目与任务",
  "Start from origin": "从远程分支开始",
  "Add project starts in": "添加项目的起始目录",
  Confirmations: "确认操作",
  "Unpin confirmation": "取消固定确认",
  "Archive confirmation": "归档确认",
  "Delete confirmation": "删除确认",
  "Ask before unpinning a thread from the pinned section.": "从固定区域取消固定任务前进行确认。",
  "Require a second click on the inline archive action before a thread is archived.":
    "归档任务前需要再次点击确认。",
  "Ask before deleting a thread and its chat history.": "删除任务及其聊天记录前进行确认。",
  "Text generation": "文本生成",
  "Text generation model": "文本生成模型",
  About: "关于",
  Version: "版本",
  "Current version of the application.": "当前应用版本。",
  Diagnostics: "诊断",
  "Inspect processes, resource use, and logs on this environment.":
    "检查此环境中的进程、资源使用情况和日志。",
  "Open source licenses": "开源许可证",
  "Legacy features": "旧版功能",
  Refresh: "刷新",
  "Add provider": "添加提供商",
  "Refresh provider status": "刷新提供商状态",
  "Refreshing providers": "正在刷新提供商",
  Unavailable: "不可用",
  "Disabled in settings": "在设置中已停用",
  "Not ready: {status}": "尚未就绪：{status}",
  error: "错误",
  warning: "警告",
  ready: "已就绪",
  "Not found": "未找到",
  Disabled: "已停用",
  Runtime: "运行时",
  "Display name": "显示名称",
  "Model gateway route": "模型网关路由",
  Native: "原生",
  "Binary path": "程序路径",
  "Launch arguments": "启动参数",
  Environment: "环境",
  Variables: "变量",
  "Add variable": "添加变量",
  Models: "模型",
  "Add custom model": "添加自定义模型",
  Advanced: "高级",
  "Usage providers": "用量提供商",
  "Add hub": "添加 Hub",
  "No usage providers configured.": "尚未配置用量提供商。",
  "Health check interval": "健康检查间隔",
  seconds: "秒",
  Gateway: "网关",
  "Model gateway": "模型网关",
  Status: "状态",
  Stopped: "已停止",
  Starting: "正在启动",
  Running: "运行中",
  Failed: "失败",
  Stopping: "正在停止",
  Reading: "正在读取",
  Unknown: "未知",
  "Refreshing…": "正在刷新…",
  "Testing…": "正在测试…",
  "The gateway has not reported its state yet.": "网关尚未报告状态。",
  "Reading the gateway's state.": "正在读取网关状态。",
  "This environment did not answer, so the gateway's state is unknown.":
    "此环境未响应，因此网关状态未知。",
  "The model gateway is switched off; harnesses use their own provider settings.":
    "模型网关已关闭，运行工具将使用各自的提供商设置。",
  "Add a provider profile and a route to use the gateway.": "添加提供商配置和路由后即可使用网关。",
  "The model gateway is starting.": "模型网关正在启动。",
  "The model gateway is running.": "模型网关正在运行。",
  "The model gateway could not bind a loopback port.": "模型网关无法绑定本机端口。",
  "Send this environment's harness requests through a local gateway, so upstreams can be changed without touching a harness. Off by default.":
    "通过本地网关转发此环境中的运行工具请求，无需修改运行工具即可更换上游；默认关闭。",
  "No providers yet": "尚无提供商",
  "A provider is one upstream API: a base URL, a protocol, and a key.":
    "一个提供商对应一个上游 API：包含基础 URL、协议和密钥。",
  Routes: "路由",
  "Add route": "添加路由",
  "Routes need a provider": "路由需要提供商",
  "Add a provider first; a route sends requests to the providers on it.":
    "请先添加提供商；路由会把请求发送给其中配置的提供商。",
  Usage: "用量",
  Requests: "请求数",
  Tokens: "Token",
  "Success rate": "成功率",
  Failovers: "故障转移",
  "Median latency": "延迟中位数",
  "Estimated cost": "预估费用",
  Provider: "提供商",
  Route: "路由",
  Protocol: "协议",
  "Group usage by": "用量分组方式",
  "The last {hours} hours, grouped by {dimension}. Kept for {days} days.":
    "最近 {hours} 小时，按{dimension}分组，保留 {days} 天。",
  "{input} in / {output} out": "输入 {input} / 输出 {output}",
  "{rate} of {requests}": "{requests} 次中为 {rate}",
  "Not computable here: only the Model grouping can be priced, from this environment's usage price overrides.":
    "此处无法计算；仅按模型分组时可依据此环境的用量价格覆盖项估价。",
  "Nothing was routed through the gateway in the last {hours} hours.":
    "最近 {hours} 小时内没有请求通过网关转发。",
  "No requests": "暂无请求",
  Knowledge: "知识库",
  "Knowledge endpoint": "知识库端点",
  "Knowledge token": "知识库令牌",
  "Knowledge test": "知识库测试",
  "Knowledge scope": "知识库范围",
  "Paste a token": "粘贴令牌",
  None: "无",
  "All Sources": "所有来源",
  "No SAG endpoint is configured for this environment.": "此环境尚未配置 SAG 端点。",
  "Knowledge is switched off for this environment.": "此环境的知识库功能已关闭。",
  "Testing the connection...": "正在测试连接…",
  "Connected to SAG.": "已连接到 SAG。",
  "SAG rejected the token. Check the Knowledge connection settings.":
    "SAG 拒绝了该令牌，请检查知识库连接设置。",
  "SAG refused this token for the requested scope.": "SAG 拒绝该令牌访问所请求的范围。",
  "The knowledge source this project selects no longer exists in SAG.":
    "此项目选择的知识来源已不存在于 SAG 中。",
  "SAG could not be reached at the configured endpoint.": "无法通过配置的端点连接 SAG。",
  "SAG did not answer in time.": "SAG 未在规定时间内响应。",
  "The endpoint answered, but not as a SAG MCP server.":
    "端点已响应，但不是可用的 SAG MCP 服务器。",
  "Test connection": "测试连接",
  Browser: "浏览器",
  "Agent browser access": "Agent 浏览器访问",
  Devices: "设备",
  "Device hub": "设备中心",
  "Agent device access": "Agent 设备访问",
  "Device hosts": "设备主机",
  "Add host": "添加主机",
  "No device hosts.": "尚无设备主机。",
  "Only available in the desktop app.": "仅桌面应用可用。",
  Handoff: "移交",
  "Switch CLI": "切换 CLI",
  "Switch & Continue": "切换并继续",
  "Switch this thread to another CLI harness": "将此任务切换到另一个 CLI Harness",
  "Handoff continuation instruction": "切换后的继续指令",
  "Continuation instruction": "继续指令",
  "Handoff & Continue": "移交并继续",
  "Hand off this thread": "移交此任务",
  "Baton holder": "当前接手者",
  "No handoffs yet.": "尚无移交记录。",
  "Choose a provider to continue this thread.": "选择一个提供商继续此任务。",
  Cancel: "取消",
  Save: "保存",
  Close: "关闭",
  Delete: "删除",
  Remove: "移除",
  Enable: "启用",
  Enabled: "已启用",
  "Off by default.": "默认关闭。",
};

function interpolate(message: string, values?: TranslationValues): string {
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}

export function translate(
  language: InterfaceLanguage,
  english: string,
  values?: TranslationValues,
) {
  return interpolate(language === "zh-CN" ? (ZH_CN[english] ?? english) : english, values);
}

interface I18nContextValue {
  readonly language: InterfaceLanguage;
  readonly t: Translate;
}

const I18nContext = createContext<I18nContextValue>({
  language: "en",
  t: (english, values) => interpolate(english, values),
});

export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const language = useClientSettings((settings) => settings.interfaceLanguage);
  const t = useCallback<Translate>(
    (english, values) => translate(language, english, values),
    [language],
  );
  const value = useMemo(() => ({ language, t }), [language, t]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
