# Agent Note: 用户回退 —— 会话表面上的就地逻辑时间旅行

Status: implemented

English | [中文](2026-08-14-session-rewind.zh.md)

## 问题

用户无法把对话回退到过去。事件溯源日志是只追加的,因此"回退到那条消息"没有产品形态:[fork](../../implemented/feature/2026-06-30-session-store-fork-api.md) 把前缀复制到一个**新**会话并改变会话 id;压缩会从模型的上下文中不可逆地重写可见表面;没有任何操作可以重新定义当前会话历史的终点。Claude Code 的消息级检查点让回退成为用户敢于放手让 agent 长时间运行的安全网;没有它,每一次方向错误都要全额买单。

缺失的原语是:对可见历史头部的**持久、就地**重定义——保持只追加日志不动,标记"有效历史结束于 seq N",后续追加在该标记之后继续。由于 harness 从日志推导模型历史,该标记必须是表面折叠能理解的会话事件,并且被作废的未来必须仍然可作为分支读取。

## 决策

核心 `SessionEventMap` 携带一个仅日志的 `session/rewind` 事件,表面投影将其视为一次重基,`SessionStore.rewind` 追加标记与模型可见通知,Host `session.rewind` RPC 端到端接线,Web 在已完成轮次的尾部提供回退操作。

### 核心机制

- **事件词汇。** `session/rewind` 携带 `{ checkpointSeq, note? }`,仅日志(无 `surfaceOp`,不产生 LLM 消息),且**不是** `ignorable`:不认识该类型的读者拒绝重建日志,因为静默跳过该标记会恢复作废区间——与 `session/end-seed` 同类,属于"必需事件"。**不** bump `SESSION_FORMAT_VERSION`:头部、事件信封、表面机制均未改变,未知类型守卫已覆盖新词汇。
- **投影。** `foldSurface` 与增量式 `SurfaceManager` 在遇到 rewind 事件时从检查点前缀重建折叠状态,因此可见表面变为事件 `[0, checkpointSeq]` 的折叠结果,作废区间 `(checkpointSeq, rewind seq)` 不再贡献节点但保留在日志中,标记之后的追加正常继续。前缀内部的嵌套 rewind 会再次重基(`[0, checkpoint]` 的折叠就是该检查点处的表面,它本身可能包含更早的 rewind)。落在作废区间内的压缩永不生效,因此回退到压缩边界之前会恢复原始消息。管理器的 `rewindGeneration` 在每次重基时递增,使 `Session.deriveMessages` 的缓存失效不依赖替换计数(重基前后替换计数可能不变)。
- **存储操作。** `SessionStore.rewind(source, boundary, { note? }?)` 镜像 `fork` 的校验:解析 live 源、要求闭区间 `boundary` 存在且其前缀不落在未闭合 turn 内,并要求追加时刻的日志尾部也不在未闭合 turn 内(调用方先取消运行中的 agent——loop 从**完整日志**推导 turn 编号,因此回退后的 turn 无需改 loop 即可与 invariant 保持一致)。该操作追加标记,外加一条模型可见的 `user/message` 通知(source kind 为 `rewind`,文本固化在 `buildRewindNotice` 中),使下一个请求看到重基后的历史与回退记录("模型可见 ⟺ 已记录")。
- **Invariant。** `dsh-session/invariant` 伴生插件拒绝 `checkpointSeq` 不是更早事件的 rewind,以及在该位置仍有 open turn 时追加的 rewind。
- **Host RPC 与客户端。** `session.rewind` RPC 镜像 fork 的锚点→边界映射(锚点处或其后的首个 `turn/end`,回退到最后已完成轮次),先取消运行中的 agent(`agent.cancel` 且 `keepInbox: false`,然后 `whenIdle`)使尾部闭合,再对 live 会话调用 `ctx.sessions.rewind`,并在返回前落盘。Web 客户端在每个已完成轮次尾部渲染回退操作(`MessageIconActions` 回退按钮 → `apply.rewindAt` → `ISessions.rewind` → `session.rewind` wire);对话从追加的标记与通知帧自动重渲染。作废区间内的工作不被删除。

## 备选方案

- **fork 即回退(仅产品层)。** 把 "Rewind to here" 做成改名的 fork:新会话 id、前缀 seed、谱系子会话。核心零改动,但会话身份改变、用户无法"在同一个会话"继续,而且每次回退都会复制会话——它只是 UX 验证的踏脚石,不是该功能本身。
- **就地物理截断。** 删除作废事件并保留会话 id。违反整个产品赖以构建的只追加契约(回放、遥测、子代理 `parentSession` 语境、会话日志导出、审计),且已在中断 turn 的处理上多次被拒;静默丢失字节的日志不是 harness。
- **日志之外的"头指针"。** 将会话元数据中存有效头部。破坏回放确定性与请求可重建不变量:模型可见历史将依赖不在日志中的状态。
- **模型可用的回退工具。** 回退是对运行中 agent 有副作用的用户操作;模型可随时调用的工具会让 agent 自行抹掉历史。该操作由 Host 拥有。

## 后果

- **回退后的 turn 编号**只在 loop 从**完整日志**的最后一个 `turn/start` 推导下一 turn 的前提下保持一致;未来若 loop 改为从可见头部推导,必须对照 invariant 核查。
- **作废区间仍出现在所有消费原始日志的视角中**(遥测、导出、会话查询);投影人类转录的消费者必须继续使用 append-origin 事件,并可能把已回退会话视为"前缀 + 分支"。
- **穿越压缩的回退**会恢复被遮蔽的消息;这依赖持久化后端保留被遮蔽事件(压缩只重写表面,不删存储),rewind spec 显式钉住了这一保留。
- **turn 中途回退被拒绝**(store 与 invariant 双层);未来若 UX 需要,必须同时放宽两者并先调和 loop 的 open-turn 状态。
- **延后项**:keyless 快照覆盖(回退 → 继续 → 模型看到通知;回退穿越压缩恢复原始)随组装后的 web 快照通道落地;回退点边界节点与作废区间分支视图尚未渲染;回退操作在取消运行中 agent 之前没有确认弹窗。
