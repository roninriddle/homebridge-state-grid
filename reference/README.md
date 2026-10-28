# 上游参考数据

这里放从上游 `stevenjoezhang/hass-state-grid` 抓下来的对照资料，**不参与运行**，
只在核对协议细节、排查「服务端为什么认为这是另一台设备」时翻阅。

| 文件 | 内容 | 对应实现 |
| --- | --- | --- |
| `field_policy.json` | 各接口返回字段的取值策略：必填/可空、单位、缺失时如何处理 | `src/renderer/format.ts`（缺失一律 `—`，不补 0）、`src/sgcc/client.ts` |

注意区分：`reference_environment.json`（真机环境特征）是**运行时数据**，会被
`src/sgcc/turing-profile.ts` 直接 import，因此它放在 `src/sgcc/data/` 下随编译走，
**不在这里**。这个目录里的东西则只作人工对照，不进 `dist/`、不随 `npm publish`
发布（`package.json` 的 `files` 白名单不含 `reference/`）。
