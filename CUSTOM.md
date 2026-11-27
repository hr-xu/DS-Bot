# DS Bot — `custom` 日常自用增强分支

本分支基于上游 [`Fei2411/DS-Bot`](https://github.com/Fei2411/DS-Bot) 的 `dev` 分支长期维护，定位为**生产级日常自用版**：在严守 DS Bot 原生单运行时与 DSH 插件边界的前提下，强化多 Agent 群聊执行过程的可观测性、现场介入/纠偏能力，以及本地 CLI Agent 的日常使用体验。

- `dev` 分支：与上游 `origin/dev` 保持 100% 一致，不做任何自用改动。
- `fix/*`、`feat/*` 分支：面向回馈上游的独立 PR 分支，单分支只做一件事。
- `custom` 分支：日常使用的全量集成版，定期在最新 `dev` 之上合并/重整；上游已合入的补丁会在同步时顺手移除。

---

## 一、相对上游 `dev` 新增的自用能力

当前基准：`origin/dev` `a19cbdfe`（含 `v0.4.0` 自研前端、`#2189` 多账号 CLI Profile、`ContextRuntime` 等最新上游更新）

1. **本地 CLI 活动时间线与折叠渲染（上游 PR `#2062`）**
   - 本地 CLI Agent（Claude Code / Codex / ACP 等）流式输出文本与工具调用穿插时，按真实时间顺序呈现，不再把整段工具回显堆叠在回复上方。
   - 连续命令/工具调用默认以可展开的 `ActivityFold` 折叠展示，保持对话流清爽。
2. **本地 CLI 上下文窗口跨重启持久化（上游 PR `#2095`）**
   - 将本地 CLI 上报的 context window 占用按 `(route, model)` 持久化并在回合结算/挂起时落盘，接入 `ContextRuntime` 后重启 DSH 继续准确展示上下文水位，并在自定义 Agent/Profile 变更或移除时同步清理窗口缓存。
3. **历史分段思维链补全 + 右侧统一宽度的群成员工作会话面板**
   - 历史分段（`parts`）回翻时保留思考链（CoT）、CLI 活动行与思考耗时。
   - 在群聊右侧 `BotPanel` 中以统一面板宽度内嵌打开群成员的真实工作会话（与新版 `Tasks` / `Workspace` Tab 共存），支持展开到主视图与一键返回群聊，随时查看成员底稿与工具调用流。
4. **群成员工作会话内就地纠偏（Steer）与群隔离 `/side` 旁路追问**
   - 在查看群成员工作会话时，可直接复用输入框实时打断改道（Steer），同步记入群账本并保护待决 `batch` 屏障，不误唤醒其他成员。
   - 支持在群成员工作会话中按群隔离发起 `/side` 旁路快照追问，不打断正在执行的任务、也不往大群刷屏。
5. **群成员级暂停 / 恢复（Pause / Resume）**
   - 群内支持对单个正在工作的成员执行 Pause（取消当前执行但保留 `batch` 屏障、停泊期间新到达的 `@` 呼叫），确认或补充指令后再 Resume 接着干，无需粗暴 `Stop` 作废。
6. **权限控制体验增强 + 本地 CLI 实时 ACP 模式同步与单聊/子代理审批兜底**
   - 优化 Bot 设置、输入框权限胶囊（`BotPermissionPill`）与本地 CLI 权限说明文案。
   - 切换权限预设时实时同步活跃 ACP 会话模式，并在收紧权限时自动清空会话级放行缓存；为本地 CLI 审批提供「本会话允许（Allow for session）」。
   - 修复单聊/子代理/未挂载输入框场景及群成员工作会话中的权限审批 UI 兜底展示与 locale 查找。
7. **ACP 冷恢复回放防护、本地 CLI 运行态可见性与排队消息加固**
   - 拦截 ACP `session/load` 历史回放串台，清理残留事件；流式文本停顿超过 1.5s 后恢复底部 `ActivityIndicator` 并实时透出并行工具/切段状态。
   - 加固 `QueueDock` 运行态排队标签与 `next-step` 交接期可见性，并对 ACP 运行期重复输入去重。

---

## 二、DSH Desktop 日常挂载（共用同一份 `~/.dsh` 数据）

所有 Bot、群聊、会话记录、记忆和密钥都保存在 `~/.dsh/bot/` 与 `~/.dsh/sessions/`。通过把 DSH Desktop 的 profile 依赖改为 `link:` 指向本地 `ds-bot` 目录，可以无缝继承全部现有数据，且插件更新检查（`src/host/update.js`）识别到 `link:` 后会自动关闭更新提示，不会被官方发版覆盖。

先**完全退出 DSH Desktop**（`⌘Q`），在终端执行：

```bash
# 1. 备份当前官方 desktop profile 配置（方便随时回滚）
cp ~/.dsh/profiles/desktop/package.json ~/.dsh/profiles/desktop/package.json.official.bak

# 2. 将 ds-bot 指向本仓库的 ds-bot 目录（路径按本机实际位置调整）
node -e '
const fs = require("fs");
const p = process.env.HOME + "/.dsh/profiles/desktop/package.json";
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies["ds-bot"] = "link:" + process.env.HOME + "/.dsh/bot/workspace/ds-bot-upstream/ds-bot";
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
'

# 3. 建立 pnpm 软链
cd ~/.dsh/profiles/desktop && pnpm install
```

重新打开 **DeepSeek Harness.app** 即生效。

### 一键切回官方版 DSH Desktop

先完全退出 DSH Desktop（`⌘Q`），再执行：

```bash
cp ~/.dsh/profiles/desktop/package.json.official.bak ~/.dsh/profiles/desktop/package.json
cd ~/.dsh/profiles/desktop && pnpm install
```

> 若升级 DSH Desktop 版本后插件无法启动，可执行 `npx ds-bot doctor --fix` 无损修复 profile 中旧版本依赖钉死问题。

---

## 三、随时切换 / 对照测试官方版本

`~/.dsh/bot/state.lock` 为单写锁，同一份 `~/.dsh` 同一时刻只允许一个可写进程。

### 方式 A：分时共用同一份 `~/.dsh`（推荐，看同一份真实数据）

首次初始化一个独立的 `official` profile：

```bash
mkdir -p ~/.dsh/profiles/official
cat > ~/.dsh/profiles/official/package.json <<'EOF'
{
  "name": "dsh-profile-official",
  "private": true,
  "dependencies": {
    "ds-bot": "latest"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "ds-bot"]
    }
  }
}
EOF
cd ~/.dsh/profiles/official && pnpm install
```

需要用官方版时：先退出 DSH Desktop，再运行：

```bash
npx @deepseek-ai/dsh@0.2.2-rc.5 --profile official web
```

测完 `Ctrl+C` 停止后再打开 DSH Desktop 切回自用版，全程只维护一份底层数据。

### 方式 B：不关闭 DSH Desktop，并排开一个官方版沙盒对照

```bash
DSH_HOME=/tmp/dsh-official-sandbox npx @deepseek-ai/dsh@0.2.2-rc.5 web
# 用完清理：rm -rf /tmp/dsh-official-sandbox
```

---

## 四、本地修改与同步上游 `dev`

### 日常修改自用版代码

- 修改 `ds-bot/src/host/`：直接重启 DSH Desktop 即生效，无需重跑 `pnpm install`。
- 修改 `ds-bot/src/client/`：严禁手改 `ds-bot/client.js`，先重编再重启/刷新：

```bash
cd ds-bot
node scripts/build-client.mjs
node scripts/build-client.mjs --check
npm run lint
```

### 定期同步上游 `Fei2411/DS-Bot:dev`

```bash
# 1. 快进同步上游 dev 并推到 fork
git fetch origin dev
git checkout dev && git merge --ff-only origin/dev
git push fork dev

# 2. 更新 custom（合并或按需 rebase；若上游已合入某项 PR 则顺手剔除）
git checkout custom
git merge dev

# 3. 如有 client.js 冲突直接重编并验证门禁
cd ds-bot
node scripts/build-client.mjs
node scripts/build-client.mjs --check
npm run lint
npm test
```
