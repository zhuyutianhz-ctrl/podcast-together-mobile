# 一起听播客

一个轻量的异地同步听播客网页。两个人打开同一个房间链接，粘贴小宇宙公开单集链接、播客 RSS 链接，或 mp3/m4a 音频链接后，就可以同步播放、暂停和拖动进度。

## 重要边界

这个程序不能直接控制小宇宙 App 内部播放器。它的工作方式是：从公开网页或 RSS 中解析音频地址，然后在网页播放器里同步播放状态。

## 本地试用

```bash
node server.js
```

打开：

```text
http://127.0.0.1:4173
```

## 异地使用方案

### 方案一：临时分享，适合马上用

在你电脑上运行服务，然后用 Cloudflare Tunnel、ngrok、Tailscale Funnel 等工具生成一个公网 HTTPS 地址。对方打开这个 HTTPS 地址即可。

示例流程：

1. 启动本程序：`node server.js`
2. 用隧道工具把本机 `4173` 端口映射到公网。
3. 把生成的 HTTPS 链接发给对方。
4. 两个人进入同一个房间链接，例如：`https://你的公网地址/?room=LOVE01`

优点是最快；缺点是你的电脑和隧道工具需要一直开着。

### 方案二：部署到云平台，适合长期使用

把这个目录部署到 Render、Railway、Fly.io 或一台 VPS。运行命令是：

```bash
node server.js
```

环境变量建议：

```text
NODE_ENV=production
```

云平台通常会自动提供 `PORT`，保留平台默认值即可。Render 的 Web Service 会提供公网 HTTPS 地址，适合手机直接打开。

不建议直接部署到纯静态托管或普通 serverless 平台，因为这个程序需要长期连接来同步房间状态。

#### Render 快速部署参数

如果不用 `render.yaml` 蓝图，而是在 Render 界面手动创建 Web Service，可以填写：

```text
Language: Node
Build Command: npm install
Start Command: node server.js
Health Check Path: /api/health
Environment Variable: NODE_ENV=production
```

Render 免费实例可能在长时间无人访问后休眠。第一次打开会慢一些；开始听之后保持网页打开即可。

## 使用方式

1. 一个人打开公网地址并创建房间。
2. 分享房间链接给另一个人。
3. 粘贴小宇宙公开单集链接、RSS 链接，或直接音频链接。
4. 两个人都点“准备收听”。
5. 任意一方播放、暂停、跳转进度，另一方会同步跟随。

## 数据说明

房间状态保存在运行中的服务内存里。服务重启后，房间状态会清空。这个设计适合两人临时同步收听，不适合保存长期账号数据。
