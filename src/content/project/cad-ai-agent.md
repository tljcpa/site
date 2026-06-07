---
title: "CAD AI Agent：自然语言画 CAD 图"
description: "用中文说一句话，自动画出 CAD 图纸（DXF）。LLM 走 function calling + ReAct 循环驱动 ezdxf 操作 2D 图纸，前端 SSE 实时展示。重点不是接通，而是把 LLM 那些不靠谱的输出一个个驯服。"
publishDate: "2026-04-12"
kind: "个人"
role: "全栈独立开发"
period: "2026-04"
highlight: "七层可替换抽象 + function-calling/ReAct 驱动 ezdxf；驯服了 13 类 LLM 与 CAD 库的真实坑"
stack: ["FastAPI", "ezdxf", "SiliconFlow", "React", "ReAct Agent"]
weight: 66
---

用自然语言画 CAD 图：用户说"画一个 10×6 米的场地，里面铺 3×4 排光伏板，四周留 0.5 米余量并标尺寸"，系统自动生成 DXF 图纸。链路是：中文指令 → LLM（function calling）→ ReAct 循环调工具 → ezdxf 操作 DXF → 存盘 → 前端 SSE 实时展示 + 下载。三个入口：CLI、REST API、Web 前端。

先把范围说清：**CAD 内核是 ezdxf（纯 Python，只处理 2D DXF），不是 FreeCAD/OpenCASCADE 那种 3D 实体建模**。所以这是 2D 矢量图纸生成。真实落地场景是光伏板平面布置图，对着甲方给的样图风格画。

## 架构：七层可替换抽象，一条铁律

整个系统是七个可替换的抽象层（ABC + 工厂 + 配置字符串注入）：LLM provider、格式处理（DXF/DWG）、CAD 引擎、工具协议适配、存储后端、Agent 策略、认证后端。有一条铁律：**业务代码禁止 import 具体实现类，`ezdxf` 只允许出现在引擎层和格式层那几个文件里**。这样换 CAD 库、换 LLM、换存储，都只动一层。

LLM 用 SiliconFlow（OpenAI 兼容），生产实际用 DeepSeek-V3。转换机制是 **OpenAI function calling**，不是自己设计 DSL、也不是纯 prompt 解析——把每个工具转成 function schema，`tool_choice:auto`，让模型自己决定调哪个。外面套 **ReAct 循环**：思考 → 调 LLM（带工具）→ 有 tool_call 就执行并把结果喂回历史再循环 → 没有就输出文本作终答，最多 20 轮。

## 真正花时间的：驯服 LLM 的不靠谱输出

接通 function calling 不难，难的是 LLM 的输出花样百出。系统 prompt 里塞了一堆硬约束，每一条背后都是一个坑：

- **坐标禁止写表达式**：LLM 喜欢在 JSON 里写 `Math.sqrt(3)` 或 `math.pi` 当坐标值，导致解析失败。prompt 硬禁 + 代码层用正则把 `xxx(...)` 替换成 0 再重解析。
- **重复图形必须用批量工具**：让模型用 `draw_rectangle_grid` / `add_entities_batch`，不能循环调 `add_entity`（几十块光伏板循环调会爆 token、也容易错）。
- **geometry 字段放错层级**：LLM 经常把 center/radius/start/end 放到顶层而不是 geometry 里，导致 TypeError 崩溃。加了 fallback——从顶层把这些字段抽出来归一化（`x/y/z`→center、`start_x`→start）。
- **截断 / 非法 JSON**：模型返回的 tool 参数有时 JSON 没闭合，写了个 `_try_fix_json()` 补全未闭合的花括号，实在不行塞 `{"_raw": raw}` 兜底。
- **方位约定**：prompt 里写死 E-W = X 轴、N-S = Y 轴、title block 放 y<0，否则模型画的图方位乱。

## ezdxf 这个 CAD 库本身的坑

LLM 之外，CAD 库 ezdxf 也有一串只有真用了才知道的坑：

- **要文本流不是字节流**：ezdxf 的 read/write 必须用 `io.StringIO`，桥接存储层（字节）时要 `decode/encode` 转。
- **关闭图层时 color 变负数**：ezdxf 里图层关闭后颜色值会变成负的（3 → -3），读取必须 `abs()`。
- **PNG 预览直接放弃**：matplotlib 和 NumPy 2.x 的 ABI 不兼容，PNG 渲染用不了，`render_preview(png)` 直接抛 NotImplementedError，只支持 SVG。这种第三方 ABI 冲突修不动，就老实只做 SVG。
- **DIMENSION 实体会在重建时丢失**：保存 DXF 时如果走文档重建会把尺寸标注丢掉，所以 `save()` 对 DXF 直写底层 doc 对象、绕过重建，保住尺寸/块/线型。
- **尺寸文字用 `set_text()` 不用 dimpost**（dimpost 的格式串会报错），而且改完必须 `render()`。
- **线型不预注册会失败**：DASHED/CENTER/HIDDEN 这些线型启动时得先 `_ensure_linetypes()` 注册，否则用的时候报错。

## 一个被否决的、完全不同的设计

这个项目有个值得记的架构 pivot。磁盘上有一份 codex 写的原始设计规范，和最终落地的几乎零交集——那份要的是 **FreeCAD 0.21 headless 做 3D 建模 + Google Gemini + IR 中间表示层 + 显式状态机（IDLE→理解→澄清→预览→执行→完成）+ codegen 生成 FreeCAD 脚本在沙箱里执行**。而最终走的是 **ezdxf 2D + SiliconFlow + function calling 直接驱动工具 + ReAct，没有 IR、没有状态机、没有脚本 codegen**。

从"Gemini + FreeCAD + IR + 状态机 + 3D"彻底转向了"SiliconFlow + ezdxf + function calling + ReAct + 2D"。后者简单得多、也真正落地了（codex 那份只有提示词、没有一行代码）。**一个想得很全的复杂方案（IR + 状态机 + 沙箱 codegen），常常输给一个想清楚了边界的简单方案。**

## 工程细节

- **DWG 降级处理**：写 DWG 先生成 DXF，PATH 里有 ODAFileConverter 就调它转（无头服务器没 DISPLAY 时自动套 `xvfb-run`），没有就把 DXF 直接写成 .dwg 后缀并 warn。
- **SSE 流式**：chat 返回 `text/event-stream`，事件分 context/thinking/tool_call/tool_result/text/error；前端用 fetch + ReadableStream 手解（EventSource 不支持 POST），按 `\n\n` 切包。
- **对话持久化到磁盘 JSON**：同时存 ui_messages（前端展示）和 llm_messages（恢复上下文）+ active_drawing（重启恢复当前图）。
- **下载鉴权用 `?token=` query param**：因为浏览器的 `<img>`/下载链接带不了 Authorization header。
- **人工兜底**：留了个 `gen_solar_panel.py` 直接用 ezdxf 出标准光伏图——AI 不稳定时的确定性兜底（设 `$INSUNITS=4` 毫米、`$LTSCALE=100`、控制标注样式）。
- **多进程部署的隐患**：对话上下文存在内存字典里，多 worker 部署会丢，得换 Redis/DB——这条记着，单 worker demo 没暴露。
- 还有几个环境坑：目录初始属 root 不可写要 `chmod 777`；实际 Python 是 3.10 不是 3.11。

## 一个安全反面教材

交接文档 `HANDOVER.md` 里**明文存了生产服务器 IP、root 密码、SiliconFlow API key、测试账号密码**。这是个真实的安全坏味道——交接是为了让下个人能接手，但凭证不该明文进文档（应该用环境变量/密钥管理，文档只写"key 在哪取"）。记下来当反面教材。

## 小结

这个项目我最有体会的是：**让 LLM 驱动一个确定性工具（CAD），一大半工作是给模型的不靠谱输出兜底**——表达式当坐标、字段放错层、JSON 截断，这些 prompt 约束加代码 fallback，才是它能稳定出图的真正原因。加上 ezdxf 那串"只有真用了才知道"的坑（文本流、负颜色、尺寸丢失），以及那个从 3D 复杂方案退回 2D 简单方案的判断。322 个测试全程脱网 mock，没有一个发真实 HTTP 或读真实文件系统。
