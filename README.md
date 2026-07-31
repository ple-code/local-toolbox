# Local Toolbox

一个本地优先的小工具合集，用来处理浏览器自动化、文档导出和日常批处理任务。

当前第一个工具是 `html2pdf`：打开需要登录态的网页，把页面导出为 PDF；多个 URL 会打包成 ZIP 下载。

## HTML to PDF

启动 Web 工具：

```sh
npm start
```

然后打开：

```sh
http://127.0.0.1:5187
```

在页面里粘贴一个或多个 URL：

- 点击“打开登录窗口”会打开独立 Chrome，并进入带回跳地址的极客邦登录页。
- 可以在页面里配置“账密登录地址”；自动登录会优先打开这个地址。
- 点击“开始导出”会触发浏览器下载。
- 一个 URL 下载 PDF，多个 URL 下载 ZIP。
- 导出时会先用第一个 URL 打开一个预热 tab，不生成 PDF；之后再用新 tab 生成真正的文件，避开首次打开时的一次性页面指引。
- 每次打开真实导出 tab 前会随机等待，默认 5-15 秒，减少批量访问时过于规律的行为。
- 导出完成后会关闭自动化 Chrome 窗口，只保留 `.chrome-profile/` 里的登录态。

当前优先适配这类文章页：

```sh
https://time.geekbang.org/column/article/999533?screen=full
```

随机等待时间可以通过环境变量调整：

```sh
MIN_TAB_DELAY_MS=5000 MAX_TAB_DELAY_MS=15000 npm start
```

## CLI

```sh
node ./bin/html2pdf.mjs 'https://time.geekbang.org/column/article/999533?screen=full'
```

指定输出路径：

```sh
node ./bin/html2pdf.mjs 'https://time.geekbang.org/column/article/999533?screen=full' -o output/geektime-999533.pdf
```

如果已经登录过，不想每次暂停：

```sh
node ./bin/html2pdf.mjs 'https://time.geekbang.org/column/article/999533?screen=full' --no-pause
```

## Runtime State

登录态保存在：

```sh
.chrome-profile/
```

这个目录只给本工具使用，不会读取你日常 Chrome 的个人资料。删除该目录后，下次运行需要重新登录。

## Requirements

- Node.js 22+
- macOS 上安装了 `/Applications/Google Chrome.app`
- Linux 上安装 Chromium，或设置 `CHROME_PATH=/path/to/chrome`

## Deployment Notes

在有图形会话的 Linux 机器上运行时，可以显式指定显示环境和浏览器路径：

```sh
DISPLAY=:0 XAUTHORITY=/run/user/1000/gdm/Xauthority CHROME_PATH=/path/to/chrome npm start
```

对外提供 Web 页面时设置监听地址：

```sh
HOST=0.0.0.0 PORT=5187 npm start
```

e540 上可以直接运行：

```sh
./run-e540.sh
```

后台启动/停止：

```sh
./start-e540.sh
./stop-e540.sh
```
