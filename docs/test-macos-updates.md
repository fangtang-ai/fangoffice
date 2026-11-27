# Mac 测试版签名与升级验收

仅操作 `com.fangtang.app.test`、测试站账号配置和 OSS `test/` 下的 Mac 工件。
正式版、`stable/`、其他测试平台的 feed 保持原样。正式版构建和更新行为不变。

## 暂时没有 Apple 开发者证书

未签名的 Mac 测试包使用“自动检测新版、手动覆盖安装”：发现新版本后直接打开对应 DMG 下载入口，
不会提供无法生效的“重启安装”。这不等于已恢复自动安装；不关闭签名校验或修改系统信任。
签名专用 workflow 继续严格拒绝缺少凭据的构建，不会自动降级。

普通测试候选仍可通过已有 Release workflow 的 `channel=test`、`signed_test_macos=false`、`publish=false`
构建。在明确验收手动更新路径后，只发布对应的测试 Mac 工件。不得把这个包当作签名验收成功。
`fangtangMacAutoUpdate` 元数据仅在签名测试构建中为 `true`；Windows/Linux 不受该 Mac 专用标记影响。

## 凭据配置

在 GitHub `fangtang-ai/fangoffice` 的 **office-test-macos** environment 配置以下 secrets。
也可使用同名 repository secrets。证书和密码不要提交到 Git，也不要粘贴到聊天。

| Secret                                 | 内容                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| `TEST_MAC_CSC_LINK`                    | 含私钥的 Developer ID Application `.p12` 文件，单行 base64   |
| `TEST_MAC_CSC_KEY_PASSWORD`            | `.p12` 导出密码                                              |
| `TEST_MAC_CSC_NAME`                    | 完整身份，例如 `Developer ID Application: 公司名称 (TEAMID)` |
| `TEST_MAC_APPLE_ID`                    | 有权为该团队提交公证的 Apple ID                              |
| `TEST_MAC_APPLE_APP_SPECIFIC_PASSWORD` | 该 Apple ID 的 app-specific password                         |
| `TEST_MAC_APPLE_TEAM_ID`               | 对应的 10 位 Team ID                                         |

发布时沿用已有 `OSS_RELEASE_AK_ID` / `OSS_RELEASE_AK_SECRET`。
不需要修改正式版 secrets。上述 Apple 签名和公证凭据缺失时，preflight 必须失败，不得退化成 unsigned 发布。
不能用 ad-hoc 签名、自签证书、关闭 Gatekeeper 或禁用签名校验代替公司 Developer ID。

## 候选构建与发布

第一次可从已经注册的 **Release** workflow 在候选分支上触发：

```sh
gh workflow run release.yml --repo fangtang-ai/fangoffice \
  --ref <candidate-branch> \
  -f channel=test -f signed_test_macos=true \
  -f expected_version=0.9.16 -f publish=false
```

候选分支 `apps/shell/package.json` 与 lockfile 版本必须匹配，且严格高于已发布的测试 Mac 版本。
`publish=false` 只生成 `signed-test-macos` CI artifact；`publish=true` 才发布测试 Mac 工件。
签名入口不会进入旧的 unsigned 矩阵构建，也不会创建 GitHub 正式 Release。
`release-test-macos.yml` 同时支持独立人工触发和被已有 Release workflow 调用。

必须通过：

1. 完整 CI 测试、类型检查、原生引擎和 Electron e2e。
2. 真实 Developer ID 签名、Apple 公证及 stapling。
3. 解压实际分发 ZIP，检查版本、测试 bundle ID、同一 Team ID、测试账号地址、测试更新地址、无 local override。
4. 实际运行 `codesign --verify --deep --strict`、`xcrun stapler validate` 和 `spctl --assess`；DMG 也验证签名和公证票据。
5. 更新 feed 与安装工件 SHA512 一致。先上传 Mac ZIP/DMG，再更新 `test/latest-mac.yml`。
6. 匿名读取新 feed 与工件；三个 stable feed 和测试 Windows/Linux feed 发布前后相同。

验收脚本可以独立执行：

```sh
APPLE_TEAM_ID=<expected-team> node scripts/verify-test-macos-release.cjs \
  --artifacts <staged-ci-artifacts> --version 0.9.16
```

## 旧版迁移与升级实测

### 原有 0.9.14 / 0.9.15 unsigned 安装

先实际尝试旧版更新并记录错误，不能仅凭 feed、下载缓存或弹窗认定升级成功。
现有旧包签名校验失败，不能保证直接自动迁移为 Developer ID 签名包。
若 Squirrel 拒绝旧包，使用已公证的 0.9.16 DMG **首次手动覆盖**测试 app；这是签名迁移步骤，不算自动升级成功。
保留 `~/Library/Application Support/方塘Office-Test`，不得清空登录态、项目、聊天或用户文件。

### 有效签名旧版 → 同团队签名新版

1. 安装通过校验的 0.9.16 测试版并登录；留一份虚构文档和既有知识库，记录版本、账号及内容。
2. 以同一 Developer ID / Team ID、同一测试 bundle ID 构建 0.9.17。不得覆盖旧版本安装工件，不改 stable。
3. 运行 0.9.16 后等待启动检查（15 秒）；已运行客户端周期为 4 小时，可正常退出重开触发启动检查。当前产品按用户确认下载与重启，不是静默安装。
4. 确认实际发现 0.9.17，点击更新，观察下载完成，再点击重启安装。
5. 重启后“关于”必须显示 0.9.17；再次验证实际安装 app 的签名、公证、bundle ID、Team ID 和测试更新地址。
6. 登录账号、虚构文档、项目和个人知识库必须保留；重复启动不得再次安装同一版本，不得降级。

记录两个阶段各自的结果。没有有效凭据或没有实际成功重启到新版时，标记“未完成”，不能以模拟 updater 事件或人工复制 app 替代自动升级验收。

参考：[Electron macOS 自动更新的签名要求](https://www.electronjs.org/docs/latest/api/auto-updater#macos)、[electron-builder 签名配置](https://www.electron.build/v26/docs/features/code-signing/)。
