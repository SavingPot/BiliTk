# BiliTk——Bilibili Toolkit

# 这是什么
这是一个基于油猴脚本的B站助手，主要功能是：
- 字幕下载
- 基于字幕的视频 AI 总结
- 视频精简链接复制
- 视频链接的 Markdown 格式复制

<br>

该脚本由 [SavingPot](https://space.bilibili.com/515982690) 开发，是一款基于 GPL3.0 协议的自由软件，如果程序有问题，欢迎提出 Issue，或是 Fork 后发起 Pull Request 合并仓库。 <br>


<br>
<br>

## 特别之处
该脚本的总结功能与常用的 B 站助手的区别是，它完全基于字幕，并且会自动修正字幕，可以直接作为笔记复制，没有常规助手那样的突兀字幕与图片，适合用来直接生成可复制的完整笔记。

<br>
<br>

## 使用方法
### 方法一. 手动安装（目前只支持手动安装）
1. 安装用户脚本管理器（此处以 Tampermonkey 为例），例如 [Tampermonkey](https://www.tampermonkey.net/) 和 [Violentmonkey](https://violentmonkey.github.io/)。
2. 浏览器可能会默认限制 Tampermonkey 的功能，所以要先在拓展管理中，打开 Tampermonkey 的设置界面，点击允许运行用户脚本。
3. 打开管理器，选择“新建脚本”。
4. 删除编辑器中的默认内容（务必注意，是所有内容！包括注释！）
5. 将 [BiliTk.user.js](https://github.com/SavingPot/BiliTk/blob/main/BiliTk.user.js) 里的文本全部复制进去。（务必注意，是全部文本，全部文本，全部文本！！！包括注释，包括注释，包括注释！！！！！！！！）
5. 保存脚本并启用。（务必不要忘记这一步！！）

<br>
<br>

## 工作原理
1. 脚本下载字幕的过程中内置限流、抖动等安全功能。<br>
2. 发送到 DeepSeek 功能是把 Skill 和字幕内容一起发送给 DeepSeek 网页端，原理是模拟用户的点击、粘贴、回车等等，因此风险相对较低。
3. 适用于绝大多数的 B 站页面，无论是普通页面，收藏列表播放页面还是稍后再看页面都可以。

<br>
<br>

## 注意
1. 本工具仅供个人学习使用，不得商用。
2. 有条件的用户请使用 BYOK 以支持国内的 AI 发展。
3. 目前 AI 总结仅支持 DeepSeek。
4. 本脚本原理上不会造成数据丢失等后果，但如果有各种相关后果，用户自行承担。
5. 本脚本安全无毒，也欢迎使用 AI 审查。

<br>
<br>

## 特别鸣谢
- 来自 [BiliClipper](https://github.com/echore/bili-clipper) 的灵感启发
- 来自 [Bilibili CC Subtitle Tool](https://github.com/WanderLandWalker/Bilibili-CC-Subtitle-Tool) 的字幕下载部分脚本

