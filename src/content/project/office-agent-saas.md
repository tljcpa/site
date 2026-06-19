---
title: "HITL 办公 Agent SaaS：可恢复状态机 + 接口驱动架构"
description: "一个支持人在回路（Human-in-the-Loop）的办公 Agent 示例工程。技术含量在「WAIT_USER/resume 可恢复状态机 + asyncio.Event 协程唤醒 + 40 条 pytest 覆盖安全与状态机全分支」。诚实在前：这是 AI 辅助开发的项目，我主导架构、任务拆解、review 与多轮安全加固，不是逐行手写。"
publishDate: "2026-06-18"
kind: "个人"
role: "架构设计与任务编排（AI 辅助开发，真人主导设计 / review / 安全加固）"
period: "2026-03 ~ 2026-06"
highlight: "5 阶段可恢复状态机（IDLE→EXECUTE→WAIT_USER→resume→DONE），40 条 pytest 覆盖 JWT 伪造/过期、Fernet 加解密、沙箱目录穿越、状态机全分支；GitHub Actions 双 job CI"
stack: ["FastAPI", "React", "TypeScript", "asyncio", "SQLAlchemy", "JWT", "Fernet", "pytest", "GitHub Actions"]
repoUrl: "https://github.com/tljcpa/-AI-Agent-SaaS-"
weight: 50
---

先把话说在前面：**这是个 AI 辅助开发的项目**——所有 commit 是 agent 跑出来的，我的真实角色是定架构、拆任务、review、和多轮安全加固迭代，不是逐行手搓。把它当「我设计并把控、AI 落实现」的工程来看，别当手写成果。下面写的技术含量是仓库里实打实能跑、测试能过的代码。

它是什么：一个办公场景的 AI Agent 示例工程。用户上传 Office 文件（Word/Excel/PDF），通过 WebSocket 给 Agent 派任务，Agent 跑 ReAct 循环调工具操作文件；过程中若缺前置条件（比如还没传文件）会**挂起请求用户介入**，用户补齐后唤醒 Agent 续跑——这就是「人在回路」。

## 核心：HITL 可恢复状态机（最硬的一块）

办公任务有前置依赖（得先有文件才能操作）。Agent 跑到一半发现没文件，不能直接报错终止，而要**挂起等用户补齐**。怎么做到「挂起 - 唤醒」而不是轮询：

- 协程跑到 `WAIT_USER` 时，注册一个 `asyncio.Event`，然后 `await asyncio.wait_for(event.wait(), timeout=300)` 阻塞挂起（带 5 分钟超时兜底，超时转 ERROR）；
- 外部 WebSocket 收到用户的「已上传，继续」消息后调 `resume()`，校验阶段和动作匹配后 `event.set()` 唤醒原协程；
- 原协程从挂起点继续往下跑、重新拉文件列表、进 EXECUTE。

这是**协程级的挂起 - 唤醒**。并发安全靠 `asyncio.Lock` 保护事件字典，事件所有权交给 `start()` 的 `finally` 幂等清理，解决「事件泄漏 / 重复唤醒」。

## 工具调度：假设 LLM 输出不可信

Agent 调工具前做三道校验——① 未知工具名拦截；② 按 schema 的 `properties` 白名单过滤参数（丢掉 LLM 乱塞的多余 key）；③ `required` 必填缺失拦截；调度内部还剔除重复的 `user_id` 避免「重复关键字参数」报错。整套设计的前提就是**LLM 的工具调用参数可能乱来，工具层必须挡**。

ReAct 主循环还有两个防爆细节：消息历史滑动窗口（超长时保留所有 system + 最近非 system，防上下文无限膨胀）、单次工具结果 >6000 字符截断（防爆 token）。

## 接口驱动：换厂商不动业务代码

用 `typing.Protocol` 定义 `StorageProvider / LLMProvider / OfficeAPIProvider` 三套抽象，`ProviderFactory` 按配置装配实现：存储切 local/OneDrive、LLM 切智谱 GLM/OpenAI 兼容、office 切 local/mock/Graph。换 LLM 或存储后端只改 config + 加一个 adapter，DI 容器统一装配。

## 安全设计（4 条，每条解决一个具体威胁）

- **JWT + bcrypt**：bcrypt 存密码（自带随机盐），HS256 签 JWT，对非法/过期/错密钥 token 静默返回 None 不抛异常。
- **Fernet 加密 OneDrive token**：access/refresh token 落库前对称加密、不存明文；生产强制 `TOKEN_ENCRYPT_KEY` 环境变量，缺了直接抛错（防多实例密钥不一致 + 防明文泄露）。
- **本地存储沙箱 + 目录穿越防护**：每用户独立子目录，写入剥掉路径成分（`Path(filename).name`），读取做 `relative_to` 越界校验，挡 `../../etc/passwd` 这类穿越。
- **上传魔数校验**：扩展名白名单 + 10MB 上限 + 文件名危险字符拦截 + **magic bytes 校验**（PDF 查 `%PDF`、docx/xlsx 查 `PK\x03\x04`、老格式查 OLE 头），防伪造文件类型。

## 真实坑（现象 → 根因 → 解法，从 22 个 PR 里挖）

- **OneDrive token 刷新竞态**：多协程同时发现 token 过期、并发去刷新、互相覆盖。解法是 DB 行级 claim——`UPDATE ... WHERE is_refreshing=False` 用 `rowcount` 判断抢锁成功，抢不到的协程指数退避等待，`finally` 释放锁。
- **进程内会话状态在多 worker 下丢失**：`session_states` 存进程内存，多 worker 时 WebSocket 跨 worker 路由就找不到状态。**没做 Redis 外置，就明说没做**——文档要求单 worker 或 sticky session，运行时检测 `WEB_CONCURRENCY>1` 打告警，注释写明「水平扩展需迁 Redis」。这是诚实边界，不是已解决。
- **会话状态无限增长**：`session_states` 只增不减有 OOM 风险。解法：TTL 1 小时 + 上限 1000 会话 + 60s 节流清理（双重检查锁防并发重复清理）。
- **PAT 缺 workflow scope 推不了 CI 文件**：创建 PR 的 token 只有 repo scope，GitHub 拒推 `.github/workflows/`。解法：CI 配置先放仓库根、文档写明合并后由有权限者 `git mv` 激活。（这个坑本博客自己也踩过。）

## 真实数字

**40 条 pytest**（全用 Fake Provider，不触真实 LLM/网络/磁盘）：状态机全分支 9（含无文件→WAIT_USER→resume→DONE、resume 动作不匹配不唤醒、达 max_steps 告警）、安全 9（JWT 伪造/过期返 None）、crypto 5（Fernet 往返、错密钥失败、生产无 key 强制抛错）、本地存储 7（路径成分剥离、穿越抛错、用户隔离）、工具注册 7、状态枚举 3。**GitHub Actions 双 job CI**：后端 `pytest`（Python 3.11）+ 前端 `tsc -b && vite build`（一次类型检查 + 打包验证），push main 和任意 PR 触发。

## 诚实边界

- **AI 辅助开发**（最重要，前面说过，这里再钉一次）：真人主导设计 / review / 加固，AI 写实现，不假装手搓。
- **没有真实 LLM 端到端验证**：测试全用 Fake Provider，没有实际接智谱 GLM 跑通任务的记录。
- **OneDrive/Graph 真实操作未验证**：office 默认 provider 是 local，还有 mock 模式返回假数据；Graph adapter 代码在，但无端到端跑通证据。
- **不支持水平扩展**（会话状态进程内存，Redis 化是 TODO）、**数据库默认 SQLite**（无迁移脚本）、**UNDERSTAND/PLAN 阶段是空壳**（枚举有、主流程没启用）、**无前端测试 / 无 E2E**。

## 小结

这个项目最值得看的是那个 HITL 可恢复状态机——它解决的是「Agent 长流程中途需要人类输入」这个真问题，用协程级的挂起 - 唤醒而不是轮询。以及那一整段诚实边界：是 AI 辅助开发、真实 LLM 和 OneDrive 都没端到端验证、不支持水平扩展——能跑过的就是那 40 个测试覆盖的部分，没验的就明说没验。工程骨架和安全加固是真的，但我不会把一个 mock 层能跑的脚手架说成上线产品。
