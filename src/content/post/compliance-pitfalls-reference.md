---
title: "合规模型踩坑与决策全集（自用速查）"
description: "这是给我自己的速查表，不是给别人看的故事。把那个合规模型项目从数据到部署踩过的每一个坑，按现象→根因→解法记全，方便下次直接 grep，不用重新踩一遍。条目会持续补。"
publishDate: "2026-05-21"
tags: ["踩坑速查", "大模型微调", "实习"]
pinned: true
series: compliance
---

这篇和别的不一样——它不是复盘故事，是给我自己的**速查表**。那个内容合规模型项目（[总览](/projects/content-moderation-finetune/)）从数据工程到部署，坑太多，压成感悟我下次照样重踩。所以这里按"现象 → 根因 → 解法"把每个坑记全，能 grep 到、能照着避开就行。不追求文笔，追求完整。

## 一、环境 / 工具链

**T-1 装新包把 torch 装坏**
- 现象：`ImportError: cannot import name 'PreTrainedConfig'` / `get_free_symbols` / vLLM 起不来。
- 根因：装 llm-compressor / 升 transformers 时把 torch 2.6.0 的文件混进了 2.10.x 的；`pip --force-reinstall --no-deps` 只覆盖不删多余文件，残留约 70 个新版文件（`mm_grouped.py`/`cutedsl/`）。
- 解法：transformers 钉 4.51.3；从 wheel 全量提取 torch 文件覆盖；`find` 列出不属于该 wheel 的多余文件逐个删；被改名的 `functorch` 子目录（`~ompile`/`~inops`）`mv` 改回。
- 防：**已有环境的机器先 read-only 诊断（pip show / import / ls）再动手，绝不假设"没装"就直接装。**

**T-2 vLLM segfault**
- 现象：模型权重加载成功（2/2 shards），随后在 torch.compile / dynamo 阶段段错误，EngineCore failed。
- 根因：torch 混版导致 dynamo / cudagraph 崩。
- 解法：`--enforce-eager` 禁掉 torch.compile。对准确率无影响，每次推理慢 5-10 秒。

**T-3 AWQ 量化崩**
- 现象：autoawq import 直接 Segmentation fault。
- 根因：autoawq 0.2.9 与 transformers 4.55.1 不兼容（autoawq 最后只测到 4.51.3）。
- 解法：改用 llm-compressor 做 AWQ；量化必须 `device_map='cpu'`（14B BF16=28GB > 24GB 显存，放 cuda 会 OOM）。

**T-4 FA2 / FSDP2 不兼容**
- 现象：`undefined symbol`（flash-attn 预编译 wheel 与 torch ABI 不匹配）；坏的 flash-attn 还会污染整个 transformers 导不进来。
- 解法：`pip uninstall flash-attn`，config 改 `flash_attn=sdpa`；FA2 装不上不影响功能。

**T-5 LLaMA-Factory 启动报错瀑布**
- `Cannot open data/dataset_info.json` → 必须 `cd /root/LLaMA-Factory` 再启动。
- transformers 版本检查不过 → `DISABLE_VERSION_CHECK=1`。
- DeepSpeed 要 torchrun → `FORCE_TORCHRUN=1`。
- `llamafactory.train` 不能直接执行 → 用 `llamafactory-cli train`。
- torchaudio / video_utils ABI 报错 → patch `mm_plugin.py` 把 import 改 try/except。

## 二、训练

**TR-1 loss 低得反常 ≠ 训得好**
- 现象：exp_005 train_loss=0.0137。
- 根因：`cutoff_len=1024` 截断长样本，助手输出落在 1024 外、不参与损失计算，平均 loss 被算低（loss mask 只算助手 token）。
- 解法：cutoff 放开到 4096，loss 回到真实 0.245。**不同截断/mask 下的 loss 不可比。**
- 附：Instruct 模型微调 loss 起点本就低（0.3-0.5，非 base 的 2.0+）+ 输出是规律 JSON，所以更容易低；5 epoch（loss 0.040）是过拟合，3 epoch 足够。

**TR-2 改 cutoff 前先量数据**
- 现象：exp_006 花近 3 小时把 cutoff 提到 4096。
- 根因：以为训练样本超长，实测 99.9% 在 1024 内（最长 1070）。超长的是塞进 prompt 的规则不是数据。
- 教训：**改超参前先实测数据分布，别脑补瓶颈。**

**TR-3 4096 cutoff 的代价**
- 吞吐 15 → 2.03 samples/s（慢约 7 倍），一轮 22 分 → 2 小时 48 分。冲新高前算成本。

**TR-4 Hard Negative 把召回干崩（最惨）**
- 现象：exp_009 平均 Recall 77.1% → 46.3%（-30.8pp），loss 曲线还很漂亮（4.458→0.355）。
- 根因：`make_hard_neg.py` 去重只比规则短名、没比完整标题（带平台前缀），导致**正确答案本身被当成 Hard Negative 放进 prompt**；28.3% 样本有标题碰撞。模型收到"答案是这三条"+"这三条别选"的矛盾信号，学成"什么都别选"。
- 解法：去重比完整标题；回滚 exp_008。
- 教训：**指标崩了去抽训练样本人看——这种 bug 在 loss 上完全看不出。冲新高前钉死可回退基线（5 分钟回滚脚本）。**

**TR-5 数据泄露**
- 必须先切验证集、再对训练部分过采样，否则过采样把验证样本复制进训练集，指标虚高。

## 三、评估（这是这个项目最大的坑区）

**E-1 评估格式和训练分布不一致**
- 现象：合规判断 93%+ 但溯源率 35-52%。
- 根因：评估一次塞全量规则（53/107 条），而训练每条只见 1-3 条规则，模型没见过这种格式。
- 解法：按类别逐组推理再合并（per-category），对齐训练分布，不用重训。

**E-2 padding 方向制造假准确率**
- 根因：批量评估 `padding_side="left"` + 去头保尾，尾部 JSON 指令保住（还能吐合法 JSON）但头部规则被砍，模型几乎没看规则就给出高准确率。
- 教训：高指标先核对模型真实看到的输入（padding / 截断方向）。

**E-3 zip 配对让规则归类假性 0%**
- 根因：评估脚本用 `zip(pred, exp)` 按位置配对违规，顺序不同全判错（单条违规时刚好对上，所以单测 89.7% 是假象）。
- 解法：改集合匹配。修完才暴露真问题：精确率只有 5-8%，模型过度预测（抖音 TP=9/FP=166）。

**E-4 全 0% 指标 = 模型名写错**
- 根因：vLLM `--served-model-name exp_008-AWQ`，但 eval 脚本 MODEL 写完整路径 → 404 → 请求静默失败返回空 → 全 0%。
- 解法：脚本 MODEL 写 served-model-name。

**E-5 自洽率是盲点**
- 现象：self-check（拿模型预测当标准答案重跑）R=96%。
- 根因：只衡量两次推理一致性，temperature=0 本来就稳，基座没微调也能 90%+。
- 教训：**自洽率证明不了能力，不能拿来充数。**

**E-6 溯源率的口径（核心）**
- 同一个 exp_008：严格（子 agent 看全 344 条规则当 GT）28.87% / 实用合理 91.23% / per-rule 漂移 93.6% / sample-level 二分类 96.9% / self-check 96%。
- 验证 28.87% 不是模型差：拉 DeepSeek-v4-pro 同口径跑也只 31.22%（我 32.92%）→ 是 RAG 召回天花板（子 agent 看全集、模型只检索 top-K）。
- 教训：**一个数字低，先用同口径拉个更强的模型一起跑，分清是模型问题还是口径对谁都这样。报数必须标口径。**

**E-7 测试集 GT 本身错 25%**
- 现象：别人拿一份 Excel 测试集测出低分。
- 根因：GT 由大模型生成，硬错率约 25%（平台标错、规则名是编的、什么都塞"过度营销"）。
- 教训：用错 GT 测出的低分 = 模型与生成 GT 的 LLM 的一致性，不是真实能力；模型更精准反而分更低。

**E-8 vLLM 非确定性**
- temperature=0 下并发 batching 浮点累加顺序变化仍致 5-10% 输出飘动；报 R 应标 ±3-5pp。

## 四、数据

**D-1 违规原文必须是精确子串**
- 现象：公众号 830 条里 67 条（8.1%）original_text 不是文案的精确子串。
- 根因：标注时"精简"了原文。
- 解法：头尾锚点法修（ratio>0.5 可修、否则剔）。教训：否则模型学到"精简引用"坏习惯。

**D-2 模型从记忆背答案（视频号 0% 召回）**
- 根因：同一违规在训练数据里被打 4 个不同文档的冲突标题，模型学成"随机吐一个"而非"从 prompt 复制"。一对多标签污染，加前缀无效（一对一才有效）。
- 解法：统一训练标签 / 后处理模糊匹配映射回标准标题。

**D-3 训练数据污染致误报**
- 某 AI 类别 566 条样本里 23.9% 文案与 AI 无关却塞进 AI 的 prompt，违规标题还标成别平台规则 → 模型在 AI 类别疯狂误报。

**D-4 造数据时模型拒答被当输出**
- 生成敏感类样本时模型返回"暂时无法回答"被存进数据集。解法：`is_refusal()` 检测过滤；敏感规则用多模型分工（一个生成合规、一个生成违规、第三个兜底）。

**D-5 "永远满分"的作弊评估**
- 某安全检查写 `skip_safety_check:true`，跳过真实检查永远满分。改成真实检查（验证改写后是否仍含违规词）。

**D-6 deepseek-r1 的 think 块**
- 推理模型输出 `<think>` 块，`.strip()` 不够，要 `strip_llm_artifacts()` 正则清。

**D-7 有一类规则根本造不出违规样本**
- "鼓励如实标识 AI"的违规是"用了 AI 没标识"，但光看文本看不出用没用 AI，硬造全是无中生有。识别出"这条造不了"本身是结论。

**D-8 爬虫逆向接口、不解 HTML**
- 拦截 XHR/JSON 做接口逆向（列表/分类树/详情），比解渲染后 HTML 稳。分类树和分页逆向迭代了 6 个版本。图片规则用 PaddleOCR + LLM 清洗。

**D-9 手解 .doc 二进制**
- 老政策是 Word97 `.doc`（OLE 复合二进制），普通库读不了：olefile 读 `WordDocument` 流，按 FIB 头偏移取 UTF-16 正文。

## 五、部署 / 运维

**O-1 nohup 看不到进度** → Python 加 `-u` 强制无缓冲。
**O-2 端口占用 pkill -9 不释放** → 用 `fuser -k <port>/tcp`。
**O-3 中文路径在 SSH heredoc 报语法错** → 本地 Write 写好再 scp，SSH 只负责执行。
**O-4 scp 不支持续传**，断了重头来；大文件逐个 scp + md5 校验。
**O-5 .env 相对路径致 key 空** → key 空时 SDK 报的是 `APIConnectionError`（伪装成网络问题），实为找不到 .env；用基于 `__file__` 的绝对路径。
**O-6 SSE 经 Caddy 要关缓冲** → 反代块加 `flush_interval -1` + 后端发 `X-Accel-Buffering: no`，否则进度流被攒着一次性吐。
**O-7 反向 SSH 隧道连只读机** → `ssh -R` 在本机开端口，不改本机网络；隧道会软死（TCP 通但 HTTP 000），换端口重建。
**O-8 上下文压缩状态倒退** → 长对话压缩后恢复的摘要可能是几天前的旧任务，会重跑已被超越的工作；靠人工拉回话题纠偏；关键状态落盘 `_CURRENT_RUN_STATE.md`。
**O-9 vLLM 假活** → 主进程 listen、`/v1/models` 22ms 返回，但 EngineCore 子进程被同事挤死，`/v1/chat/completions` 永久卡死；诊断点是 nvidia-smi 没该 pid。
**O-10 自更新脚本陷阱** → 部署脚本自己的 `git pull` 在运行中替换了脚本本身，第一次跑的是旧版，重跑才生效。
**O-11 sudo rm -rf 连带删线上文件** → 把不该被 build 清理的产物（视频）移到 build 目录之外。

## 六、关键决策（为什么这么选）

- **不用 RAG 做主方案**：领导要精确溯源、不能漏，召回优先；RAG 检索易偏差。但公众号 53 条全在一类、塞不进 per-category，是 RAG 唯一适用场景 → 最终混合（公众号 RAG、其余 per-category）。
- **三阶段推理（scan→verify→dedup）**：去重让精确率明显回升；verify 是压 FP 的关键（去掉 verify 精确率从 ~48% 掉到 ~23%）。
- **结构 > 模型**：同方案小红书 59% vs 公众号 11%，差距来自规则分类结构（53 条挤一类），不是模型能力。
- **AWQ INT4 上线**：28GB BF16 → ~10GB，跑 24G 卡。drift 约 -0.75pp（量化未明显退化）。
- **对外报数**：88.5%（明显违规子集）/ 单平台最高 92.1% / 严格 70-78%，每个标口径；不报最松的 90%。

---

这份会随着我翻别的项目继续补。它的全部意义就一句：**下次别再踩同一个坑。**
