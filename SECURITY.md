# 发布安全与个人信息说明

## 本机保留、公开副本排除

| 类别 | 主要位置 | 原因 |
| --- | --- | --- |
| API 与登录签名密钥 | `.env`、`api/`、`data/.jwt_secret` | 可用于消耗额度或伪造身份 |
| 管理员和学生账号 | `data/` 下 SQLite 及 WAL/SHM | 含账号、密码哈希与关联信息；哈希也不能公开 |
| 简历、回答和报告 | `data/uploads`、数据库、`data/documents`、`outputs` | 真实身份、联系方式、经历和面试内容 |
| 录音录像与分析记录 | `data/recordings`、日志、截图 | 声音、面部、行为和对话等个人信息 |
| 局域网证书 | `data/lan-cert` | 私钥与本机信任材料不能共享复用 |
| 私人测试剧本 | 本机 `apps/web/src/data/adminInterviewScript.json` | 会被前端构建嵌入；公开副本必须整份替换成虚构样例 |
| 交付文档、缓存和历史 | `deliverables`、`tmp`、`outputs`、根目录截图等 | 可能包含真实姓名、账户、旧 Key、电脑路径与演示记录 |
| 第三方模型和人物资源 | `assets`、`integrations`、Web public 媒体 | 涉及独立授权，不由本项目 MIT 许可覆盖 |

“排除公开发布”不等于加密；这些文件仍在本机，也不会被本工具删除。不要把 `.gitignore` 当作保险箱：它不会移除已经提交过的文件，也不会清除旧提交、分支、标签、缓存或别人已克隆的内容。

## 每次发布流程

1. 扫描白名单源码：`python scripts/public_release.py`。只报告位置、规则和数量，不打印密钥值。
2. 审核发布清单 `release/public-files.json`；新增文件默认不公开。核查许可和全部公开文字，不要靠简单替换姓名来脱敏整份简历。
3. 导出至新的精简目录；不复制依赖、数据库、图片、视频或模型。再用 `--check-tree` 扫描整个导出目录。
4. 在导出目录执行测试、构建，人工复核后才初始化/推送 GitHub。测试和构建产生的数据、依赖和 dist 不能作为上传文件；重新生成干净导出更稳妥。
5. 若准备推送已有仓库，额外检查全部分支、标签、历史提交及已跟踪文件；本工具不是 Git 全历史审计器。
6. 公开副本随附 GitHub Actions 当前源码检查（尚未上传/运行）。它不能阻止第一次上传泄漏，发布前本地检查仍是必需的。GitHub secret scanning / GitGuardian 应在确认上传范围后另行配置。普通 ggshield secret scan 使用 GitGuardian 服务分析，不能描述成完全离线。当前工具是离线规则检查，不冒充 GitGuardian。

发现已经公开的真实 Key，先在服务商侧撤销/轮换，再处理仓库历史。删除当前文件、改名或设置私有仓库不能保证之前的副本失效。工具不会擅自轮换 Key、改账单或删除历史。

参考：[GitHub 敏感数据移除说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)、[ggshield 配置](https://docs.gitguardian.com/ggshield-docs/configuration)。

## 首次配置边界

- GUI 只供部署者在本机操作，不监听网络端口，不向浏览器或 localStorage 下发 Key。
- `.env` 是权限受限的本机文本，不是加密保险箱；同一系统账号或管理员仍可能读取。
- 新管理员密码至少 12 位并含字母、数字；保存为与后端一致的 PBKDF2 加盐哈希。已存在管理员绝不重置，同名学生不升级。
- 配置窗口拒绝密码首尾空白和控制字符，避免登录输入的清理规则导致无法登录；中间普通空格保留。
- 本地启动前核对端口所有者及其项目标记，公开源码副本不得直接复用另一个项目的 API/网页服务。
- 自定义/生产数据库拒绝使用该简化 GUI，需采用受控部署流程。
- 不联网验证 Key；有效性、余额、服务商限额需另外确认。软件预算保护需要真实价格配置，不保证账单绝对封顶。
- 配置过程若在管理员创建后保存 Key 失败，再次打开只补充 Key，不覆盖密码；异常退出的锁文件需确认无配置进程后再处理。
