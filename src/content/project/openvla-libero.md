---
title: "在免费 T4 上把 OpenVLA 在 LIBERO 跑通：VLA 闭环评测 + 量化对照"
description: "在一张白嫖的 Kaggle T4 上,把 OpenVLA 7B 在 LIBERO 机器人操作基准上闭环评测全 10 任务,亲手测出 4-bit→8-bit→bf16 的量化-性能曲线。但真正的料,是 2026 新镜像跑 2024 代码趟出来的 9 个工程坑,和一次 83%→64% 的主动纠错。"
publishDate: "2026-06-09"
kind: "开源复现"
role: "独立完成(评测复现 + 量化对照)"
period: "2026-06"
highlight: "OpenVLA 7B 在 LIBERO 闭环评测全 10 任务;量化曲线 4-bit 64% → 8-bit 76.7% → 论文 84.7%;2026 镜像跑 2024 代码的 9 个工程坑"
stack: ["OpenVLA-7B", "LIBERO", "robosuite/MuJoCo", "4-bit/8-bit 量化", "Kaggle T4"]
series: "driving"
featured: true
weight: 72
---

我在往**具身智能 / 机器人 VLA**方向走的时候,发现自己有个真短板:调研报告写了一大堆(几十个 VLA 模型、十几个基准),但**一个 VLA 模型都没真跑过**。被问到 OpenVLA 时心里没底。所以这个项目的目标很直接:**不再写 survey,动手出一个能跑、有真数的东西。**

先说清楚定位:这是**机器人桌面操作**(机械臂拿碗),不是自动驾驶。两者都属 VLA,但这个项目本体是具身操作。

## 做了什么

在一张**白嫖的 Kaggle 单卡 Tesla T4(16G)**上:

- 加载 OpenVLA 官方 `openvla-7b-finetuned-libero-spatial` 检查点,**4-bit NF4 量化**塞进 T4(加载 82 秒,显存才用 4.4GB);
- 接通 **LIBERO 仿真**(robosuite + MuJoCo,EGL 无头渲染),按官方协议跑**闭环评测**:每步模型预测 7 维动作(xyz + rpy + 夹爪)→ 仿真执行 → 判定任务成败;
- 忠实复现官方预处理的那些"魔鬼常量"——图像 180° 旋转 + lanczos3 resize 224、center-crop 0.9、夹爪 normalize 后 invert、前 10 步等物体落定、每任务最多 220 步。**错一个数字,复现就是假的。**

## 真实结果

**libero_spatial 全 10 任务 × 5 次 = 50 episodes,4-bit 成功率 64.0%(32/50),耗时 166 分钟。**

| 任务 | 成功率 | 任务 | 成功率 |
|---|---|---|---|
| 1 小碗旁的黑碗 | 100% | 6 饼干盒旁的黑碗 | 80% |
| 2 桌子中央 | 80% | 7 炉子上 | 40% |
| 3 饼干盒上 | 80% | 8 盘子旁 | 40% |
| 4 抽屉顶 | 80% | 9 木柜上 | 80% |
| 0 盘子小碗之间 | 60% | 5 架在小碗上 | **0%** |

**量化-性能曲线(亲手测出,单调)**:

| 精度 | 成功率 | 显存 | 单步耗时 |
|---|---|---|---|
| 4-bit NF4 | 64.0%(32/50) | 4.4 GB | ~1.25 s |
| 8-bit | 76.7%(23/30) | ~8 GB | ~2.2 s |
| bf16(**论文数字,非我跑**) | 84.7% | ~15 GB | — |

同一套代码、同一检查点,仅把 4-bit 换 8-bit,成功率从 64% 升到 76.7%——**证实了 64% 的 gap 主因是量化,不是 bug/渲染/协议**,离论文 bf16 只差 8 个点。这条曲线本身就是"轻量化 × 性能"的一个真实数据点。

## 9 个工程坑(这才是真正的料)

在 **2026 年的 Kaggle 新镜像(transformers 5.0 / numpy 2.4 / torch 2.10 / py3.12)上,跑 2024 年的 OpenVLA 代码**,等于一场版本考古。按踩到的顺序:

1. **T4 不支持 FlashAttention-2**:T4 是 sm_75,FA2 要 sm_80+。
2. **transformers 年代错配**:OpenVLA 远程代码绑 transformers 4.40,镜像是 5.0。建不了干净隔离环境,只能在前沿镜像上硬降级回 2024 年代栈(`transformers==4.40.1` 等一串)。
3. **T4 16G 装不下全量**:7.5B × 2 ≈ 15GB > 可用显存,必 OOM。所以本项目只做评测复现(量化推理),训练留后续——量化绕不开。
4. **accelerate 没锁版本**:报 `.to is not supported for 4-bit bitsandbytes models`。根因是装成了最新 accelerate 1.13,与 transformers 4.40 错配。锁 `accelerate==0.30.1`。
5. **bitsandbytes 不能跟着 transformers 锁老版**(这个最反直觉):锁老 bnb 后报 `No module named 'triton.ops'` 和找不到 `libbitsandbytes_cuda128.so`——老 bnb 既没 CUDA 12.8 二进制、又 import 了新 triton 已删的模块。**教训:bnb 要匹配运行时的 CUDA/triton,不跟 transformers 一起锁。**
6. **eager 注意力的因果掩码 off-by-one**:报 `tensor a (277) vs b (276)`。OpenVLA 拼了 256 个图像 patch 后,eager 路径手动加掩码差 1。解法:改 `sdpa`(PyTorch 原生、T4 支持,绕过那行手写代码)——也顺带解决了坑 1。
7. **LIBERO 装了却导入不了**(隐蔽):`pip install -e` 返回 0,但 `No module named 'libero'`。根因是已运行的 Python 解释器启动时已扫过 site-packages,中途加的 `.pth` 不重载。解法:`sys.path.insert(0, LIBERO根目录)` 直接注入。
8. **LIBERO 首次导入交互式问路径**:无头 kernel 里 `input()` 直接 `EOFError`。解法:导入前给 `input` 打桩返回默认值。
9. **torch.load 的 weights_only 拦截**:PyTorch 2.6+ 默认 `weights_only=True`,LIBERO 的初始状态文件含 numpy 对象被拦。解法:打桩强制 `weights_only=False`。

还有几个"平台税"坑:Kaggle 的 kernel slug 由 title 而非 metadata 的 id 派生(导致轮询错 slug、push 撞 409);随机分到一张 ECC 故障的坏 T4(`uncorrectable ECC error`,换卡重跑);EGL 无头渲染是最大不确定点,所以**先冒烟测试**(128×128 渲染通过)再投入正式跑——最大的风险最先排除。

## 一次 83.3% → 64% 的主动纠错

这个我要专门写,因为它比那条漂亮曲线更重要。

第一轮我只跑了 task0 和 task1(两个最简单的任务),得到 **83.3%**,一度想把它写成"忠实复现、接近论文"。但跑完全部 10 个任务后,真实数字是 **64%**。我把报告里的数字改回了 64%,并写明 83.3% 是**以偏概全**——挑两个简单任务报高分,是在自欺,也违背"数据必须真实"的底线。

64% 不如 83% 好看,但它是真的。**一个会在简历里写 83% 的人,和一个跑完全集主动改回 64% 的人,是两种人。** 我想做后者。

## 诚实的边界

- **没做训练**:T4 16G 装不下全量微调,本项目是评测复现 + 量化对照,不是训练。LoRA/全量留后续。
- **task5「拿架在小碗上的黑碗」在 4-bit 和 8-bit 下都是 0%**:跨精度稳定失败、跑满步数无报错——这是 OpenVLA 对该空间配置的**真实能力边界**,不是量化或代码问题。这是个有价值的诚实观察,我留着。
- **样本量小于论文**:每任务 5 次(8-bit 3 次)vs 论文 50 次,方差大(task5 一个 0% 就压了总分 10 个点)。受免费 T4 时长所限,如实标注。
- **bf16 84.7% 是论文数字**,不是我跑的,表里标清了。

## 意义

跑通这套闭环评测栈(OpenVLA 加载 + 量化 + LIBERO 无头 EGL + 官方协议),是后续做"动作表示受控对照""轻量化 × 泛化帕累托"这些研究方向的**地基**——下一步可以在同一套栈上换动作头、测留出任务的泛化。我对前沿的系统理解写在 [VLA 是怎么让语言模型去开车的](/posts/vla-action-tokenization/) 那篇笔记里;这个项目是把其中一条线**真正跑起来**的第一步。
