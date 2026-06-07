---
title: "8 卡跑 7B：一次分布式微调的真实账本，和一个被打脸的提速判断"
description: "把一个 7B 模型放到 8 张 4090 上做 QLoRA 微调，我以为关掉 gradient checkpointing 能快一半，结果只快了 5%。这篇记这次分布式训练的真实配置、A/B/C 三套提速方案的实测对比，以及'GC 省的是显存不是速度'这个被硬件打脸打明白的教训。"
publishDate: "2026-05-25"
tags: ["分布式训练", "大模型微调", "DeepSpeed", "实习"]
pinned: true
series: compliance
---

那个内容合规模型项目（[总览](/projects/content-moderation-finetune/)）后期有一次换路子：领导要求"模型换成 7B、数据集换成新的 800MB 那个、其他跟上次一样"，跑在一台 **8 卡机器**上。前面几轮都是单卡（[六轮微调](/posts/finetune-six-experiments/)），这次是真正的多卡分布式。这篇把这次的真实账本记下来——包括一个我判断错、被硬件直接打脸的提速决定。

## 硬件：8 张 4090，但没有 NVLink

机器是 **8× RTX 4090，每张 24GB**，503GB 内存，数据盘 160G。但有个关键限制：**没有 NVLink，多卡之间走 PCIe 4.0**。这个细节后面会变成提速的天花板。

任务是用 QLoRA 微调 Qwen2.5-7B-Instruct，数据集是新的 80 万条（839MB，278024 条，用 Qwen 真实 tokenizer 全量统计是 1.85 亿 token，平均 666 token/条、最长 1070）。

## 为什么是 7B + QLoRA，而不是 14B 全参

上一版部署的是 14B + QLoRA(4bit) → merge → AWQ INT4。这里要说清一个判断：**上次用 QLoRA 不是因为 QLoRA 效果好，是被单卡 24G 显存逼的**——14B 的 BF16 权重就 28GB，单卡装都装不下，连推理都得量化。这次有 8 张卡，但领导要求"其他跟上次一样"，所以照旧 QLoRA，先把"8 卡训 7B 要多久"这个问题摸清楚。

这里还差点踩个坑：下模型时差点下成 `Qwen2.5-VL-7B-Instruct`（多模态版）。我拦住了——VL 不是纯文本版，多一个 600M 的视觉编码器、template 是 `qwen2_vl`、autoawq 对 VL 支持还不稳，而我们的数据是纯文本，视觉部分纯属死重。正确目标是 `Qwen2.5-7B-Instruct` 纯文本版。**下模型前先确认是不是你要的那个变体**，这种坑下错了要重下十几个 G。

## 并行方式：纯 DDP，不上 ZeRO

这是个明确的决策：**用纯 DDP（数据并行），不开 DeepSpeed ZeRO**。原因是 **QLoRA（4bit 量化）和 ZeRO 不兼容**——ZeRO 要切分优化器状态/梯度/参数，和 4bit 量化的权重打架。所以 8 卡就是简单的数据并行：每张卡放一份完整的量化模型 + LoRA，各喂一部分数据，梯度 all-reduce 同步。

启动是 `FORCE_TORCHRUN=1` + `llamafactory-cli train`，8 卡 DDP（"Initializing 8 distributed tasks at 127.0.0.1"），配了 `NCCL_DEBUG=WARN`、`TOKENIZERS_PARALLELISM=false`、一个很大的 `ddp_timeout`。可训练参数 161M / 7.78B = **2.08%**。

等效 batch 严格对齐上次：上次单卡是 bs=1 × accum=16 = 16；这次 bs=1 × accum=2 × 8 卡 = 全局 16。**部署的每个参数都要和上次对齐**，否则没法说"只换了模型和数据"。

## A / B / C 三套提速方案，和那个被打脸的判断

先跑了个 50 步的 dry-run：稳态 **1.10 秒/步**，8 卡聚合吞吐约 9800 token/s，LoRA adapter 才 161M、存 checkpoint 只要 3.4 秒。据此估算正式训练 17376 步 × 1.10s ≈ **5.3 小时**。

领导问"5.5 小时这么慢吗"。我拆了瓶颈：单个 micro-batch 前向+反向约 0.45s，accum=2 串两个约 0.90s，DDP 的梯度 all-reduce（PCIe 无 NVLink）约 0.20s，合计 1.10s/步。然后给了三套方案：

| 方案 | 配置 | 全局 batch | 我的预估 | 实测 |
|---|---|---|---|---|
| A（当前） | bs1, accum2, GC 开 | 16 | 5.5h | 基准 |
| B | bs2, accum1, GC 开 | 16 | **2.8h** | **~4.6h（没快）** |
| C | bs2, accum1, **GC 关** | 16 | **2h** | **~4.6h（只快 5%）** |

我当时的判断是：关掉 gradient checkpointing（GC）能省下重算前向的开销、提速 30-50%。结果切到 C，稳态从 0.96s/步……还是 0.96s/步左右，**只快了约 5%**。

我当场承认判断错了，去查根因——一看 `nvidia-smi`：每张卡的 **GPU 利用率已经 93-97%、几乎打满**，显存只用了 13.4-13.9GB（24G 富裕一半），功耗 238-344W。问题就清楚了：

> **GC 救的是显存，不是速度。** 它用"反向时重算前向"换显存，所以代价是时间。但只有当 GPU 算力没打满、重算能填进空闲时，关掉它才提速。这次显存本来就富裕、GPU 算力已经 93-97% 打满，关 GC 省下的那点重算时间**根本没有空闲算力去承接**，自然快不了。

结论是：**~4.6h 就是 8 张 4090 跑 7B QLoRA 的硬件上限，不是配置没调对。** 再折腾 batch/accum/GC 都没用，瓶颈在算力本身（以及 PCIe 无 NVLink 的通信）。真要更快只有换 Unsloth 这种 kernel 级优化，但那会严重偏离"和上次对齐"的约束，不值当。最后接受 4.6h，C 方案跑到底，不再折腾。

## 真实训练数字

正式训练 17377 步，起始 loss 0.8439，稳态 1.02-1.07 it/s ≈ 0.96s/步，每卡显存 13.4-13.9GB、利用率 93-97%。每 200 步存一个 checkpoint（约 1.9GB）。end-to-end 收敛到约 **4 小时 45 分**。

**但这次训练没跑完**——跑到约 8%（step 1400+）时机器要关机，停了，取回 19GB / 7 个 checkpoint 和全部日志/配置。所以那个 4.6h 是外推值，不是完整跑完的实测。诚实记一下。

## 环境与运维的坑

- **不动 base 的新 torch**：机器 base 是 torch 2.10.0+cu128（2026 年初的新组合），太新，FlashAttention / Liger / bitsandbytes 的预编译 wheel 跟不上，硬装会进编译地狱。所以新建了个隔离的 conda env（Python 3.10）+ **torch 2.5.1+cu121**，装稳定版的 LLaMA-Factory + flash-attn 预编译 wheel。
- **conda 建 env 被 ToS 拦**：`CondaToSNonInteractiveError`，得先 `conda tos accept` 两个 channel。
- **GitHub clone 卡死**：境外到境内不通/极慢，切 `gitclone.com` 镜像；pip 全程清华源；模型走 ModelScope 下。
- **tensorboard 没装直接崩训练**：`report_to: tensorboard` 但 pip 装 llamafactory 不自带 tensorboard，trainer 初始化 TensorBoardCallback 时崩。装上就好。我选 tensorboard 而不是 wandb，是因为它离线、文件可备份，不依赖网络。
- **旁路 GPU 监控**：写了个独立进程每 5 秒采 `nvidia-smi`（util/显存/功耗/温度）写 CSV，和训练同寿命、互不影响。这是后来能一眼看出"GPU 已打满"的依据。

## 一个共享机器上的真实场景：util=0% ≠ 空闲

另一台 8 卡机器（共享集群）盘点时，8 张卡全被占着，但有个反直觉的现象：**有两张卡挂着 vLLM、显存占满 21.7GB，但 GPU 利用率是 0%**——因为 vLLM 在线等请求，不来请求就不算，但显存一直占着。

教训：**判断一张卡能不能用，不能只看利用率**。util=0% 可能是"占着显存等活"，不是"空闲"。真正空闲要看显存也几乎没占。那台机器我权限最低、不能碰别人的卡，最后真正能用的只有一张还占着 4.8G 的卡，单卡跑 7B QLoRA 都紧巴。

## 小结

这次分布式训练最有价值的不是"学会了 8 卡怎么配"，是两个被现实校准的判断：

- **多卡不是线性提速**。8 卡跑 7B QLoRA，~4.6h 就是硬件上限，瓶颈在算力和 PCIe 通信（无 NVLink），不是参数没调对。指望靠改 batch/GC 把它砍半，是不懂瓶颈在哪。
- **GC 省显存不省速度**。GPU 算力打满时关 GC 几乎无收益；只有显存紧、算力有空闲时它才换得到时间。先看 `nvidia-smi` 的 util 再决定关不关，别凭感觉。

每次想当然地"这样能更快"之前，先把瓶颈测出来——这次要不是有那个每 5 秒采样的监控，我可能还在折腾 batch size，而真相是 GPU 早就打满了。
