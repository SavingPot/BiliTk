# BiliTk——Bilibili Toolkit
一个基于油猴脚本的B站助手，主要是字幕下载与DeepSeek总结。基于 GPL3.0 协议，如果程序有问题，欢迎提出 Issue，或是 Fork 后发起 Pull Request。<br>
本脚本由[SavingPot](https://space.bilibili.com/515982690)开发。

<br>
<br>

# 使用方法
## 方法一. 手动安装（目前只支持手动安装）
1. 安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开管理器，选择“新建脚本”。
3. 删除编辑器中的默认内容，将 [Bilibili-CC-Subtitle-Tool.user.js](https://github.com/SavingPot/BiliTk/blob/main/BiliTk.user.js) 全部复制进去。
4. 保存脚本并启用。

<br>
<br>

# 工作原理
脚本通过B站官方暴露的接口来下载字幕，过程中内置限流：每批下载 N 份后休息若干秒，防止被风控封。<br>
而发送到DeepSeek功能则是把Skill和字幕内容一起发送给DeepSeek网页端，原理是模拟用户的点击、粘贴、回车等等，因此风险相对较低。

<br>
<br>

# 注意
注意：本工具仅供个人学习使用，不得商用。

<br>
<br>

# 特别鸣谢
- 来自[BiliClipper](https://github.com/echore/bili-clipper)的灵感启发
- 来自[Bilibili CC Subtitle Tool](https://github.com/WanderLandWalker/Bilibili-CC-Subtitle-Tool)的字幕下载部分脚本
