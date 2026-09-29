# 第三方组件与未随源码分发的资源

MIT 许可只覆盖本项目作者拥有相应权利的业务代码；第三方代码、补丁涉及的原代码、模型权重、字体、照片、音视频与人物资源保留各自许可。购买资源或给人物改名不等于拥有再分发权。

## LiveTalking

上游：[lipku/LiveTalking](https://github.com/lipku/LiveTalking)，维护者 lipku 及社区贡献者。上游许可证中的版权声明为 `Copyright [livetalking@lipku]`；公开副本原样保留该许可证，不以本项目的 MIT 许可替代。

本项目使用并修改的是实时数字人引擎部分；面试业务应用由本仓库维护。项目与上游无官方隶属或背书关系。感谢上游作者及其依赖项目的贡献。

### 已修改文件（相对上游基线）

以下文件均包含本项目的本地修改，逐行改动以随附补丁为准；它们不是未经修改的上游原版：

- `app.py`
- `avatars/wav2lip/genavatar.py`
- `avatars/wav2lip/inference_silence.py`
- `avatars/wav2lip_avatar.py`
- `server/asr_server.py`
- `server/routes.py`
- `server/rtc_manager.py`
- `server/session_manager.py`
- `server/webrtc.py`

### 补丁与部署

本地补丁基线提交：`a5a77f4c395c8347789a16da1843cd1b08b48eea`。补丁位于 `release/patches/livetalking-local.patch`；上游 Apache-2.0 许可随附 `LiveTalking-LICENSE.txt`。补丁涉及启动、语音/视频接口、会话控制、ASR 和嘴部推理等本地适配；没有复制整个仓库或权重。

自行克隆到 `integrations/LiveTalking`、检出上述提交后，先用 `git apply --check` 检查补丁，再应用补丁。此步骤只恢复代码，不安装 CUDA/PyTorch/FFmpeg、WSL 环境、模型、人物与语音资源。各项依赖与权重获取按上游说明执行，下载前自行核对条款。Windows 启动脚本当前默认使用 Ubuntu-22.04 与 `/opt/miniconda/envs/livetalking/bin/python`，不同安装位置需调整脚本。

## Wav2Lip 与其他模型

[Wav2Lip 上游](https://github.com/Rudrabha/Wav2Lip#non-commercial-open-source-version)对开源版本有非商用使用限制，不能因为外围业务代码使用 MIT 就宣称整套数字人可任意商用。LivePortrait、CosyVoice、MediaPipe、ASR 模型等也须分别核对源码、模型及训练数据相关许可。

本公开副本未提供原作者最终版人物图片、眨眼/点头/微笑/开场视频、LivePortrait 权重、Unity/Blender 工程或购买的服装人物。请使用自己拥有所需权利的资源并保持服务接口兼容；不要从作者测试录像反向提取人物。

前端中保留了可选媒体路径与失败回退逻辑，这些路径不代表对应素材已授权分发。正式演示前检查海报、字体、MediaPipe 的 WASM/模型，以及所有动作视频是否已按自己的资源补齐。
