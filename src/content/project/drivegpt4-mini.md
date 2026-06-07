---
title: "DriveGPT4-Mini：可解释驾驶决策的 VLM 微调复现"
description: "用 QLoRA 微调 Qwen2-VL-2B，让它对驾驶场景图输出结构化的「该怎么开 + 为什么」。一个 50 条样本的迷你复现，验证数据生成到 VLM 微调到可解释决策整条路线。真正的价值在那 7 个踩坑，和两个可迁移的 debug 心法。"
publishDate: "2026-06-02"
kind: "开源复现"
role: "我定方案与技术纪律，执行交给一个独立 agent 在远程 4090 上 SSH 跑完"
period: "2026-06"
highlight: "QLoRA 微调后 loss 2.087→1.428（↓31%），7.28GB 显存跑通；7 个真实坑，含 FSDP 版本坑与 SDPA shape bug 的诊断心法"
stack: ["Qwen2-VL-2B", "QLoRA", "ms-swift", "Azure GPT-4.1-mini", "RTX 4090"]
weight: 62
---

> 这是一个迷你复现：50 条样本、AI 辅助完成，目的是验证技术路线可行，不代表产品级能力。它证明了"路线能跑通"，**没有**证明模型真的看懂了场景——这条诚实声明是项目的一部分。

我最近在入门具身智能和智能驾驶方向，这是我在这个方向上动手做的第一个小复现。目标不是做出能用的驾驶模型，而是把"**数据生成 → VLM 微调 → 可解释决策**"这条完整路线跑通一遍，搞清楚每一步的工程细节。

先说清楚我在这个项目里做了什么、没做什么：**方案、技术选型、工程纪律是我定的**（写成一份自包含的 brief），**执行**交给一个独立 agent 在远程租的 4090 上 SSH 自主跑完。我不假装这是手敲逐行写的——但每一个技术决策和每一个坑的根因，我都对它负责。这恰好是我现在的工作方式：用 AI 放大执行，但对原理和判断负责。

## 它做什么

用 QLoRA 微调 Qwen2-VL-2B-Instruct，让它对一张驾驶场景图，输出固定三段式的结构化决策：

```
【场景描述】车辆在夜间行驶，前方无其他车辆，路面清晰，视线良好。
【驾驶决策】保持车速平稳，适当使用远光灯辅助视线，注意观察周围环境。
【原因分析】夜间视线受限……保持车速平稳有助于维持安全距离，避免紧急制动引发追尾。
```

微调前的 base 模型只会输出自由格式的散文式描述，没有固定结构、也没有可追溯的推理链。微调后稳定输出带【原因分析】的三段式——这是"可解释驾驶决策"的核心。这一步是真实可见的：**模型学会了"怎么说"**。

## 整条流水线

1. **数据生成**：本想用公开数据集 comma10k，但它的 GitHub 索引文件 404 了（仓库结构变过），于是 fallback 到 PIL 合成 50 张语义驾驶场景图（640×480，含道路 / 红绿灯 / 行人 / 前车 / 雨天 / 雾天 / 夜间 / 施工区等 10 类元素），再用 Azure GPT-4.1-mini 的视觉接口对每张图自动生成【场景+决策+原因】标注，**零人工**，真实消耗约 3 万 token。切成 train 42 条 + test 8 条。
2. **微调**：ms-swift 4.2.3，一条 `swift sft`。QLoRA（4bit NF4 + 双重量化，LoRA rank=16 / alpha=32 / dropout=0.05），`per_device_batch=2`、`grad_accum=8`、`lr=1e-4` cosine、5 epoch、`max_length=512`、`bf16`、开 gradient checkpointing。可训练参数 18.5M / 2227M，只占 **0.83%**。
3. **部署**：`swift export` 把 LoRA 合并成 4.2GB 单模型（merge 用了不到 30 秒），可进一步 INT8 量化到约 2.3GB（这步是写好的命令，不确定是否真跑过，如实标注）。

## 真实训练结果

| 指标 | 训练前 | 训练后 |
|------|-------|-------|
| Loss | 2.087 | 1.428（↓31%） |
| Token 准确率 | 52.4% | 63.3%（+10.9pp） |
| 可训练参数 | — | 18.5M / 2227M（0.83%） |
| 显存峰值 | — | 7.28 GB（24G RTX 4090，只用约 30%） |
| 训练时间 | — | 33 秒 / 15 步 |

样本量很小（50 条 / 15 步），所以这些数字证明的是"路线跑通了、方向对了"，不是模型有多强。

**而且我要诚实点破一个失败**：对比 demo 里，模型的输出常和图对不上——参考标注是"湿滑雨天"，模型却说成"夜间行驶"；参考是"红灯路口"，模型自由发挥成别的。合成图的视觉信号太弱、样本太少，模型学会了"怎么说"（格式迁移成功），**但没学会"看懂"**（视觉对齐没成功）。这正是迷你复现该暴露的事实，不该藏。

## 7 个真实的坑

这个项目最值钱的是这部分。

1. **外部数据源是脆弱依赖**：comma10k 的 `files.txt` 返回 404（仓库结构变了）。没死磕，触发 fallback 用合成图。教训：对验证性复现，"小而有语义 + 高质量标注"比"大而无标注"更有用，且外部 URL 必须有 fallback。

2. **跨机器的绝对路径**：本地生成的 JSONL 里图片存的是本机绝对路径，scp 到 GPU 机后 `os.path.exists` 全 False。批量替换路径前缀才修好。教训：数据集里存相对路径，或生成时就用目标机路径。

3. **ms-swift × torch 的 FSDP2 版本坑（最讲究）**：启动报 `ImportError: cannot import name FSDPModule from torch.distributed.fsdp`。定位法是看 Traceback 最内层，落到 swift 某个 callback 里写死的 `from torch.distributed.fsdp import FSDPModule`。根因：torch 2.4 引入 FSDP2 本该把它提到 `torch.distributed.fsdp`，但这个 2.5.1+cu124 构建里它实际还在 `torch.distributed._composable.fsdp`，而 ms-swift 写死了新路径。解法：patch 成 `try 新路径 except ImportError 用旧路径`，**不回退版本**（回退风险更大）。这是"框架 A 版本 × 框架 B 版本"的经典错配。

4. **视觉 encoder 的 gradient checkpointing 失效**：WARNING 说 `Qwen2VisionTransformer... has no attribute _require_grads_hook`。它是 WARNING 不是 ERROR，训练继续。根因是 ms-swift 想给视觉 encoder 开重计算但该类没实现接口；但 QLoRA 冻结了 base、视觉 encoder 本就不参与梯度，所以**实质无影响**，显存仍在预算内。教训：WARNING ≠ ERROR，要读懂来源判断能不能忽略，别一看红字就停。

5. **训练步数比预期少（心算坑）**：只跑了 15 步，一开始以为出错。其实 42 ÷（per_device 2 × grad_accum 8）≈ 2.6 步/epoch × 5 ≈ 13-15 步，对的。有效步数 = 总样本 ÷（per_device_batch × grad_accum × 设备数）——忘了 grad_accum 会除掉实际更新次数。

6. **SDPA 注意力的 shape bug（诊断方法很漂亮）**：推理报 `Expected ... [12, 440] but got [12, 221]`。关键诊断：**base 模型也报同样的错 → 立刻排除 adapter 问题，锁定到框架层**。注意到 440 = 2 × 221，指向 Qwen2-VL 动态分辨率的 spatial merge 在 SDPA 模式下的 shape bug。曾误以为是量化冲突，去掉 4bit 仍报错才排除。解法：改用原生 transformers + `attn_implementation="eager"` 绕过 SDPA（eager 慢约 20-30%，demo 只跑几次可接受）。

7. **f-string 被 SSH heredoc 转义破坏**：在 SSH heredoc 里写 Python，f-string 里 `split("/")` 的双引号被 shell 吃掉变成 `split(/)`，报 `SyntaxError`。纪律：复杂 Python（含引号 / 反引号 / `$`）一律本地写好再 scp 传，SSH 只负责执行、不负责写代码。

## 两个可迁移的 debug 心法

比起具体的 bug，这两个心法更值钱，单独点出来：

- **"base 也复现 → 排除自己改的部分、锁定框架/环境"**（坑 6）。控制变量法：把你引入的变量（adapter、量化）拿掉，如果错误还在，问题就不在你这。
- **"看 Traceback 最内层那行 import / 调用"**（坑 3）。报错栈最外层是你的代码，但根因往往在最内层第三方库的某一行，顺着它去查源码比瞎猜快得多。

## 几个真实的工程决策

- **选 2B 不选 7B**：24G 卡上 2B QLoRA 只用 4-7GB 很稳，7B 虽塞得下但慢 3-4 倍，验证 pipeline 没必要上 7B。
- **选 ms-swift 不选 LLaMA-Factory**：魔搭官方对 Qwen2-VL QLoRA 开箱即用；brief 里写明"卡住就换 LLaMA-Factory"作退路。
- **明确克制，不堆名词**：不上 CARLA/Isaac Gym（装环境拖垮项目）、不上 DeepSpeed（单卡 2B 用它是负优化、面试也 defend 不了）、不做 RL（不在本项目范围）。这些只在文档层面讨论。**知道什么不做，和知道做什么一样重要**——为了简历好看硬塞撑不住的技术，反而会在面试里被拷打穿。

## 为什么记这个

它本身很小，但对我有意义：这是我在具身智能/驾驶方向上，第一次把多模态数据生成、PEFT 微调、可解释输出这三件事串成一条能跑的流水线，也踩透了一串真实的框架坑。再往前走的东西（真实数据集、视觉对齐、端到端 VLA），都建立在先把这条小路线吃透的基础上。它配套的"对前沿的理解"我单独写在了 [VLA 是怎么让语言模型去开车的](/posts/vla-action-tokenization/) 那篇学习笔记里。
