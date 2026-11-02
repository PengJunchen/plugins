# Comate cloud provider for Magpie

本地主线开发版本 `0.3.0`。通过 HTTPS 直接请求 Comate 云端，复用这台电脑的 Comate 登录态。
不调用 Comate 本地服务的会话、工具执行或取消接口；云端不可用时直接报错。
本版本尚未发布 npm，也未获社区审核批准。

## 本机使用

```sh
magpie plugin add /absolute/path/to/magpie-community-plugins/packages/comate
magpie plugin login comate 1
```

选择 `Comate account (this computer)`，然后在 Magpie 中选择实时目录中的 `comate/<model ID>`。
源码目录必须保留。插件升级后使用新会话测试，必要时重启 Magpie。
不需要 Comate 本地服务运行，但需可读的有效登录凭据和到 `https://comate.baidu.com` 的网络。
也支持手工输入 license。宿主会保存凭据；对话、系统提示、工具定义、客户端返回的工具结果会发往 Comate 云端。
插件只读 Comate 设置，不修改该文件。macOS 默认位置为
`~/Library/Application Support/Comate/User/settings.json`；可用绝对路径 `COMATE_SETTINGS_PATH` 覆盖，支持 JSONC。
Windows/Linux 路径仍有单元测试，未做本版本原机验收。

## 工具和续聊

沿用我们的完整 JSON-lines 会话回放、请求级函数别名和工具块校验。
吸收 0.2.13 的云端协议及原生函数事件解析，将已声明的函数事件转为客户端 `tool_calls`。
客户端负责执行工具并返回同一个 call ID 的结果。未声明的云端工具、原生 `TOOL` 执行事件、
不完整函数参数、失败或缺失结束事件都会报错；不会伪造成功结果或发出未知工具供客户端猜测。
每次请求新建独立云端会话并发送完整历史，因此重启宿主、切换账号/模型和并发请求无需依赖共享续聊缓存。
这种策略会增加长会话的提示长度和云端开销，尚未验证长会话性能。

支持文本、流式和非流式、`auto` / `none` / `required` / 指定函数。
工具参数需是 JSON 对象；不保证完整 JSON Schema 验证，拒绝 `strict: true`。
图片和文件暂不支持。推理可返回，但不转发推理档位、temperature、max_tokens 等生成控制。
目录仅来自当前账号的云端实时列表；没有固定模型种子，未知上下文窗口保持 0。
云端请求拒绝重定向，有总时限及取消信号；创建会话/任务和执行 POST 不自动重试。

云端路径避免了旧桌面执行端点，但这不等同于服务端所有工具均关闭或社区已接受新方案。
真实 Codex/Claude Code 完整网关验收、无客户端工具的随机文件反证及维护者重新审核仍需分别记录。

## 验证

```sh
cd packages/comate
npm test
MAGPIE_HOST=/absolute/path/to/host.js MAGPIE_BUN=/absolute/path/to/bun npm test
```

`cloud.test.mjs` 验证新云端传输，`cloud-host.test.mjs` 使用显式指定的生产 Magpie 宿主和假云端服务。
测试不会自行寻找邻近仓库。没有显式宿主/Bun 时宿主测试跳过。
`local-transport.fixture.mjs` 仅保留旧本地传输回归，未由生产入口导入，也不进入 npm 包。
旧 `models.test.mjs`、`protocol-transport.test.mjs` 和 `integration.test.mjs` 对它的测试不能作为新云端传输验收。
协议及发现测试继续覆盖两代实现的共有行为。

npm 载荷只有 LICENSE、README.md、index.mjs、cloud.mjs、protocol.mjs、discovery.mjs、package.json。
没有安装器、二进制或生命周期脚本。首次社区发布仍由 npm owner 操作。
详见源码中的 [VALIDATION.md](./VALIDATION.md)。
