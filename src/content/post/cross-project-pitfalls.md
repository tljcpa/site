---
title: "跨项目踩坑速查：那些在好几个项目里重复踩的坑"
description: "把这些项目里反复出现的坑收到一处——部署反代、端口进程、LLM 接口、前端、中文编码、数据性能、测试方法论。按现象→根因→解法记，方便下次直接 grep。同一个坑在不同项目踩第二遍太亏。"
publishDate: "2026-06-04"
tags: ["踩坑速查", "工程"]
pinned: true
---

[合规模型那篇踩坑全集](/posts/compliance-pitfalls-reference/)是单项目的。这篇是**跨项目**的——把语音日历、多平台发布、PR 审查、CAD、Screenwright、HR 筛选、盲盒分析、就业撮合器、政务工单这些项目里**反复踩到**的坑收到一处。很多坑不是某个项目独有的，是同一类问题换了个项目又来一遍，记在一起才看得出规律。

## 一、部署 / 反向代理

**SSE 流式经反代被缓冲，进度一次性吐**
- 现象：前端拿不到实时进度，等全部结束才一次性收到。
- 根因：Caddy/nginx 默认缓冲响应。
- 解法：Caddy 的 `/api` 块加 `flush_interval -1`；nginx 加 `proxy_buffering off`；后端再发 `X-Accel-Buffering: no` 双保险。出处：语音日历、多平台、PR 审查、CAD、Screenwright。

**子路径部署，无斜杠路径 404**
- 现象：`/04` 返回 404，但 `/04/` 正常。
- 根因：nginx `location /04/` 只匹配带斜杠。
- 解法：`rewrite ^/04$ /04/ permanent;`。出处：在线教育 4 题。

**共享机器多项目共存**
- 端口要错开（每项目独立高位端口 + 独立 compose project name）；用宿主机系统级 Caddy/nginx 反代、前端 dist 不进容器省内存；后端绑 `127.0.0.1:端口` 只对反代暴露。出处：七牛云三项目、CAD、Screenwright、HR。

## 二、端口 / 进程

**端口冲突，curl 命中了别人的服务**
- 现象：起 uvicorn 验证，curl `/health` 返回的不是自己的服务。
- 根因：端口被同机另一服务占了，自己的进程 bind 失败退出，curl 打到了旧服务。
- 解法：验证前先 `ss -ltnp` 确认端口空闲；健康检查返回里加 `service` 字段一眼区分。出处：语音日历。

**pkill -9 不释放端口** → 用 `fuser -k <port>/tcp`。

**nohup 后台进程 SSH 断了就死 / 看不到进度**
- 解法：`setsid` 彻底脱离终端；Python 加 `-u` 强制无缓冲否则日志不刷新。出处：语音日历、多平台、HR、模型微调。

**worker「假死」要分清是死锁还是慢**
- 现象：curl 等几分钟无响应，进程 CPU 0%。
- 根因可能是 SDK 阻塞 IO（不耗 CPU）+ 客户端超时设太短，其实是慢不是死。
- 解法：strace/直接单测确认；给 SDK 加显式 timeout 让它超时报错；curl 超时拉大。出处：HR 筛选、模型微调（vLLM 假活）。

## 三、LLM 接口

**流式最后一个 chunk 的 `choices` 是空列表** → 流循环里跳过空 choices，别直接取 `chunk.choices[0]`。出处：多平台。

**模型输出的 JSON 不合法**：截断未闭合 → 补全花括号兜底；裸双引号撑爆 `json.loads` → prompt 注入转义指令；小写枚举值 → 代码强制 `.upper()`；包 ```json 围栏 → 剥离；推理模型的 `<think>` 块 → 正则清。出处：CAD、Screenwright、论文排版、模型微调。

**模型把表达式当数值写进 JSON**（`Math.sqrt(3)` 当坐标）→ prompt 硬禁 + 正则把 `xxx(...)` 替换成 0 重解析。出处：CAD。

**造数据时模型拒答被当输出存下来** → `is_refusal()` 检测过滤；敏感内容并发触发安全过滤 → 改串行生成；极敏感样本模型死活不生成 → 人工兜底写。出处：模型微调数据集。

**LLM 对"第几个字符"没有可靠表示** → 别让它报字符偏移，让它抄首尾 marker、代码 `find` 定位 + 接续兜底。出处：Screenwright。

**embedding 相似度在 query 宽泛、候选同质时区分度不够** → 加一层 LLM 布尔判断把信号拉开（布尔占大头、cosine 作兜底）。出处：HR 筛选。

**第三方返回的数组顺序不保证** → 按字段取（如按 currency 取余额），别硬下标。出处：语音日历。

**API key 格式能反推厂商**（智谱 `{32}.{16}`）→ 别盲配成 DashScope。出处：HR、模型微调。

## 四、前端

**SSE 要带 Authorization header → 不能用 EventSource** → 用 `fetch` + `response.body.getReader()` + `TextDecoder` 手解，按 `\n\n` 切包、留半包 buffer。出处：CAD、Screenwright、aihub、多平台。

**「死按钮/点了没反应」先排浏览器缓存** → 用户缓存了旧 index.html；硬刷 + favicon 用 `%BASE_URL%` + 显式 Link/useLocation。出处：在线教育。

**中文输入法回车误发** → `@compositionstart/end` 维护 isComposing，组合态不发送。出处：aihub。

**浏览器下载链接带不了 header** → 用 `?token=` query param 鉴权。出处：CAD。

**别把工程亮点/自指内容写进给用户看的 UI** → 决策/算法解释放 README/文档，UI 只留产品体感；整行可点击时别再加「详情→」冗余按钮。出处：在线教育。

## 五、中文编码（Windows 尤其多）

**`.bat` 中文乱码** → bat 转 GBK 编码（cmd 按 GBK 解析 bat，`chcp 65001` 改不了解析）+ CRLF；.py 保持 UTF-8。彻底根治：打包文件名全英文，CSV 用 `utf-8-sig`(带 BOM)Excel 双击不乱码。出处：盲盒。

**`Content-Disposition` 文件名只能 latin-1**，中文触发 `UnicodeEncodeError` → 用固定英文名或 RFC 5987 `filename*`。出处：多平台。

**老 `.doc` 是 OLE 二进制**普通库读不了 → olefile 读 WordDocument 流按 FIB 偏移取 UTF-16。出处：模型微调清洗。

**Windows GBK 存盘、Linux UTF-8 读乱码** → 遍历 `gbk 读 → utf-8 写回`。出处：论文排版。

## 六、数据 / 性能

**百万行 Excel 读取慢** → 换 calamine（Rust）引擎，95.8 万行 25.6s vs openpyxl 2-3min。出处：盲盒。

**xlsx 硬上限 104 万行，撞上限静默丢行不报错** → 优先导 CSV。出处：盲盒。

**口径错误不报错但毁全局** → 充值订单（玩法空、1:1 返还）混进盲盒流水占 57%，逐字段摸清业务含义才发现。先摸口径再分析。出处：盲盒。

**百万行明细别全量写回 xlsx**（极慢、Excel 打不开）→ 明细导 CSV，xlsx 只放聚合。出处：盲盒。

## 七、测试方法论

**纯脚本 happy-path 测试（断言全绿）会漏 UI bug** → 真浏览器（Playwright/puppeteer）截图人工看才抓得到（重复渲染、序列化键名 `from_`↔`from` 不一致、媒介切换没回调）。出处：Screenwright、在线教育、多平台。

**单测变慢是信号** → 引入「默认启用外部调用」的组件后，间接构造它的测试会偷偷发真实网络调用；`pytest --durations` 一眼定位。出处：PR 审查。

**零成本验证限流** → 连发空内容请求（限流在空守卫之前触发，不调 LLM），精确数 400/429。出处：多平台。

**测试该确定性、脱网** → 全 mock，不发真实 HTTP/不读真实 FS（数百单测照样快）。出处：CAD、Screenwright、各项目。

## 八、安全 / 凭证

**交接文档/脚本明文存了 IP/密码/key/邮箱** → 反面教材：凭证该走环境变量/密钥管理，文档只写「在哪取」；交付包/git 只验最终干净。出处：CAD、模型微调、在线教育（多次）。

**CORS `allow_origins=["*"]` + `allow_credentials=True`** 会反射任意 Origin → credentials=False + 白名单。**经反代真实 IP 在 `X-Forwarded-For` 首段**，限流别用 `request.client.host`（那是 127.0.0.1）。出处：PR 审查、多平台、Screenwright。

**公开 POST 接口要限流**（怕 demo 被刷爆烧 API 余额）→ 进程内滑动窗口即可，别引重依赖。出处：PR、多平台、Screenwright。

## 九、工具链

**GitHub PAT 没 workflow 权限推不了 `.github/workflows/`** → 删 CI 走本地构建，或换 token。出处：PR、语音日历、本博客。

**境外机器 clone GitHub 卡死** → 切 gitclone.com 镜像、pip 清华源、模型走 ModelScope。出处：分布式训练。

**新 torch/cu 组合太新，FA/Liger/bnb wheel 跟不上** → 新建隔离 env 降到稳定版 torch，别动 base。出处：分布式、模型微调。

---

这份会随翻更多项目继续补。**同一个坑踩第二遍，是最不值的。**
