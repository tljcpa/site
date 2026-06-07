---
title: "AI Hub：多渠道 AI 平台"
description: "一个开箱即用的多渠道 AI 平台：对话、文生图、用户系统、卡密充值、管理后台。把多家模型统一成一套 OpenAI 兼容接口，多 Key 轮询调度。也如实记几处巧思和几处宣传大于实现。"
publishDate: "2026-04-25"
kind: "个人"
role: "全栈独立开发"
period: "2026-04"
highlight: "渠道抽象 + 多 Key 轮询；extra_body 透传非标准文生图参数;流式中独立 DB session 的生命周期处理"
stack: ["Vue 3", "TypeScript", "FastAPI", "SQLAlchemy", "OpenAI SDK"]
repoUrl: "https://github.com/tljcpa/aihub"
demoUrl: "http://aihub.zdwktlj.top"
weight: 75
---

一个完整的多渠道 AI 平台，前后端一个人做下来：把市面各家模型（OpenAI、Claude、智谱、硅基流动等任意 OpenAI 兼容接口）统一接进来，对外提供对话、文生图、用户系统、卡密充值和一整套管理后台。有[在线演示站](http://aihub.zdwktlj.top)。重写这篇时我把代码通读了一遍，所以下面讲的是代码真实做了什么，也把几处"宣传大于实现"如实标出来。

## 核心：渠道抽象 + 多 Key 轮询

工程上最关键的抽象是**渠道（channel）**。不同厂商 API 各不同但大多兼容 OpenAI 格式，所以我把每个上游抽象成一个渠道，统一走 `AsyncOpenAI(base_url=...)`——靠 base_url 切厂商，**没有每厂商的 if 分支、没有适配类**，"适配"完全外包给"上游必须 OpenAI 兼容"这个前提。

一个渠道可以挂多个 Key，请求在这些 Key 之间轮转。**这里要诚实**：当年 README 写"自动负载均衡"，但代码看其实是**简单的 round-robin**（模块级计数器 + 取模 + 加锁），并没有按 Key 的实际负载或失败率加权。而且计数器是进程内内存态，多 worker 下不全局一致、重启清零。说它是"多 Key 轮询"准确，说"负载均衡"是当年措辞夸大了。即便如此，多 Key 轮转在单 Key 限流/额度用尽时确实能摊压力、提可用性。

权限分层做得对：管理员能看到渠道完整对象（含 Key），普通用户拿到的是脱敏视图——**Key 永不下发前端**。

## 几个我自己觉得不错的巧思

这些是代码里真实存在、也确实解决问题的：

- **`extra_body` 透传非标准文生图参数**：OpenAI SDK 的 `images.generate` 不收 steps/cfg/seed/negative_prompt，我把它们塞进 SDK 的 `extra_body`，SDK 不校验直接透传给上游。这样一套接口同时兼容忽略这些参数的 DALL·E 和吃这些参数的 SD 系。
- **流式输出里的 DB session 生命周期处理**：SSE 流式回复时，generator 在原请求的 DB 依赖生命周期之外执行——所以用户消息先 commit 持久化，AI 回复落库时**新开一个独立 session**，并把 session_id/user_id/credits 先快照成不可变局部变量再进 generator，避免访问已失效的 ORM 对象。这是 async 流式 + ORM 的典型陷阱，我踩过并在代码里注释了。
- **前端用 fetch + reader 手解 SSE**：不用 EventSource（因为要带 Authorization header），改 `response.body.getReader()` + 手动 `split('\n\n')` 处理跨包边界，还做了中文输入法组合态判断防回车误发。
- **额度设计**：`credits=-1` 表无限（校验只判 `==0`）；卡密续期用 `expires_at = max(现有, now) + days`，已有有效期就叠加。HTTP 402 Payment Required 语义也用得准。
- **Artifacts 预览**：正则抽 AI 回复里的 ```html 代码块，塞进 `<iframe sandbox>` 沙箱侧栏预览。

## 关于"热配置不重启"的真相

README 说"全局配置在线编辑无需重启即可生效"，代码看其实**根本没有缓存**——`get_config()` 每次调用都现场重读 `config.json`，`save_config()` 直接覆写。因为永不缓存，写完下次读自然生效，"不重启即生效"就是这么实现的。优点是极简、零失效逻辑；代价是每个请求都磁盘读一次 config（小站可忽略）。渠道配置同理（每次现读 `channels.json`，写时加锁）。把渠道和配置用 JSON 文件存、关系数据才用 SQLite，是这个项目一个明确的取舍。

## 管理后台与用户系统

后台是工作量很大的一块：渠道管理、模型启停/改名/排序、卡密批量生成（次数+有效期双维度，一次性兑换）、邀请码（独立于卡密、控制注册准入）、用户管理（调额度/角色/封禁）、使用统计（按天聚合 chat/image 调用量）、专栏（预设 system prompt 的对话入口）、公告。鉴权用 JWT + bcrypt，后台叠加 admin 角色校验。

**几处该如实记的安全/落差**（也是复盘价值）：`config.json` 里配了 `daily_limit`/`rate_limit`，但后端代码里**没找到实际执行限流的逻辑**——是预留未实现的配置；`JWT_SECRET` 有个 `changeme` 的缺省值（生产必须改）；启动自举管理员时把密码明文打到了日志。这些是真实存在的瑕疵，写出来比藏着强。

## 技术栈

前端 Vue 3 + TS + Vite + Pinia + Vue Router（运行期生产依赖只有 axios/marked/highlight.js，无 UI 组件库、纯手写 CSS 变量主题）；后端 Python + FastAPI + SQLAlchemy(async) + SQLite + OpenAI SDK。

## 小结

这是我做过最完整的全栈产品：从用户能用的对话/绘图，到运营要的渠道调度、卡密、统计。做下来最大的体会是，"接个模型出对话框"只是开头，真正撑起平台的是渠道抽象、多 Key 调度、流式里的那些生命周期细节。这次重写也借机把当年 README 里"负载均衡""热配置"几处夸大的措辞，按代码实际更正了——一个平台值不值得信，恰恰在于敢不敢把没做到的说成没做到。
