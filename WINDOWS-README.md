# IZ2S Platform：Windows 使用说明

这是基于上游 `0.16.0-rc.5` 的 Windows x64 适配副本，包含电脑控制面板、IZlauncher、IZPSlauncher 和 File Exchange。默认使用已有的 **ESP32-S3 TextKeyboard** 固件输入 SmileBASIC 指令，也保留 Linux ARM 输入板方案。

上游项目：[byizmysh/IZ2S-Platform](https://github.com/byizmysh/IZ2S-Platform)。本复刻的 [Windows 发行版](https://github.com/Aster145/IZ2S-Platform/releases/tag/v0.16.0-rc.5-windows.1) 提供 `IZ2S-Platform-Windows.zip`，请下载该附件。GitHub 自动生成的 **Source code** 压缩包和 `git clone` 仅包含源码，不含 `data/runtime`；`SETUP-WINDOWS.cmd` 只检查运行环境，不会下载或安装依赖。

## 电脑端入口

先完整解压到一个可写目录，保留 `data/runtime`。包内附带 Node.js、Python、Pillow、pyserial、DejaVu 字体和 SPIR-V 校验器；无需 npm 安装或 Linux 环境。

| 双击文件 | 用途 |
| --- | --- |
| `SETUP-WINDOWS.cmd` | 首次检查随包运行环境，并准备可选的 ARM 输入代理安装包。保留已有设置，不安装系统软件。 |
| `START-WINDOWS.cmd` | 启动控制面板并打开浏览器；已经运行时显示并打开现有地址。 |
| `CHECK-WINDOWS.cmd` | 检查本地依赖、组件描述和模块包，不连接输入板或 Switch。 |
| `STOP-WINDOWS.cmd` | 停止此目录的控制面板和会话。 |
| `PREVIEW-WINDOWS.cmd` | 在独立临时副本中预览界面。 |

首次执行 `SETUP-WINDOWS.cmd`，成功后执行 `START-WINDOWS.cmd`。通常使用本机端口 `39517`，请打开启动窗口打印的完整地址。控制台窗口保持打开，停止时优先使用 `STOP-WINDOWS.cmd`；预览可在其控制台按 Ctrl+C 结束。

**关闭网页不会关闭服务端，也不会结束 Switch 会话。** 网页中的“安全断开连接”只结束主机会话；需要完全退出时运行 `STOP-WINDOWS.cmd`，等待 `IZ2S Platform stopped.`。

面板右上角的 **语言 / Language** 可随时切换 **简体中文 / English**，浏览器会记住所选语言。切换会即时更新导航、配置、启动向导、设备状态和操作提示，保留当前表单值、模块选择与主机会话。命令、路径、设备标识和原始诊断日志保持原文。更新已打开的面板时刷新网页即可，无需重启主机服务。

## ESP32-S3 接线与连接检查

1. ESP32-S3 的 **CH343/UART 串口**连接 Windows；支持 USB HID 的 **USB/OTG 数据口**连接 Switch。两条线路的用途不同。
2. 关闭正在占用该串口的 TextSender 等程序，然后在面板选择 **PC + ESP32-S3**。
3. 点击 **List COM ports** 查看端口，再展开 **Configure**，在 `esp32Port` 填入这块板的实际 COM 端口；`esp32Baud` 默认 `115200`，`esp32KeyGapMs` 默认 `40` 毫秒。点击 **Save configuration** 保存。
4. 点击连接检查：程序只发送 `PING`，不会输入文字。此结果确认的是串口和固件响应。
5. 接好 USB/OTG 数据线、确认 Switch 识别该键盘后，在面板确认 USB 已连接（`esp32UsbConfirmed=yes`），再次点击 **Save configuration**。现有固件的 `PING` 不提供 USB/HID 就绪状态。

适配器直接使用现有 TextKeyboard 的 `PING`、`TYPE2`、`KEY` 协议，无需重新刷固件。电脑和 Switch 还需处在可以互通的局域网；ESP32 输入线路不会代替后续 TCP/RPC 通信。

若 Switch 屏幕上的字母**大小写全部颠倒**，先取消输入，再在 **Configure → Letter case correction / 大小写反转补偿** 选择 **Swap letter case / 反转字母大小写**（`esp32SwapCase=yes`），点击 **Save configuration**。此选项默认关闭，仅对发送的字母大小写做补偿，数字、符号和按键不变；同时适用于源码和后续命令。先用短文本核对屏幕，再重新输入源码。`CAPS_FIX=1` 和 `CAPS` 只反映固件能力及其缓存状态，不能代替屏幕检查；不要同时盲目切换 Caps Lock 和此补偿选项。

## 首次安装与后续运行

**首次安装**：选择 `ns2jb by IZMYSH` 引擎，在 Switch 打开 SmileBASIC 的 `Make a Program → Direct`，按面板依次完成源码输入、检查和保存。默认保存名为 `NS2I`；操作前确认所选程序槽和保存名，避免覆盖自己的程序。

**后续运行**：按面板要求重启 Switch 并回到 SmileBASIC Direct，选择已经保存的引导程序，再选择 IZlauncher 或 IZPSlauncher。使用当前面板生成的启动步骤，完成引导程序加载、当前会话连接和菜单启动。连接检查、首次源码安装和后续启动是三个不同步骤；旧会话的 `START` 参数不能直接复用。

**File Exchange**：在电脑的 App library 加载模块，并在 Switch 菜单中打开它。FTP 地址为 Switch 的局域网 IP，端口 `2121`，匿名登录、被动模式、同时一个连接。`/save` 和 `/tmp` 可读写，`/rom` 只读；退出模块会关闭其 FTP 服务。这里提供的是 SmileBASIC 能访问的目录。USB/OTG 用于键盘输入，文件传输走局域网 FTP。

Linux ARM 输入板可改选 **PC + ARM PC**，继续使用局域网 SSH 和该板的 USB HID 接口。Windows 仅在此方案下需要可用的 OpenSSH 客户端。

## 常用命令与问题

在本目录的命令提示符运行：

```bat
START-WINDOWS.cmd --no-open
START-WINDOWS.cmd --restart
START-WINDOWS.cmd --port 39518
CHECK-WINDOWS.cmd
STOP-WINDOWS.cmd
```

- 自动化调用可先设置 `set IZ2S_NO_PAUSE=1`，否则命令结束后会保留窗口显示结果。
- 缺少 `data/runtime` 文件或 Python 模块时，重新解压完整 Windows 包。日常运行复用随包 shader；只有自行改动 shader 源码并重新构建时才需要额外 GLSL 编译器。
- 串口打不开时，检查 COM 选择和占用程序。PING 成功但 Switch 没有输入时，检查 USB/OTG 数据口、数据线和 SmileBASIC 当前界面。
- TCP/RPC 连不上时，检查电脑与 Switch 的地址、局域网互通以及 Windows 防火墙对当前 Node 程序的访问许可。

上游版权和开源许可保留在 `LICENSE`、`COPYRIGHT`、`LICENSE-SCOPE.md` 等文件中；附带运行环境的许可证保留在各自目录。

## 从源码运行

源码仓库不提交 `data/`、会话、日志和个人配置。开发者可自行安装 Node.js 22+、Python 3.9+、Pillow、pyserial、SPIR-V Tools 的 `spirv-val` 和 DejaVu 字体。Node.js 需在 PATH 中；可用 `IZ2S_PYTHON` 指定 Python 可执行文件、`SPIRV_VAL` 指定校验器、`HB_FONT_DIR` 指定 DejaVu 字体目录。用所选 Python 安装 Pillow 与 pyserial。

依赖就绪后，在源码根目录运行：

```bat
node distribution/verify.cjs
CHECK-WINDOWS.cmd
START-WINDOWS.cmd
```

`verify.cjs` 会校验源码并生成模块包。此方式不运行 `SETUP-WINDOWS.cmd`，因为该脚本要求便携包目录结构。源码已包含编译后的菜单 shader；修改 shader 后才需要额外配置 GLSL 编译器。便携环境的版本与来源记录在 `windows/runtime-sources.json`。

## 本次验证范围

中英切换已在实际浏览器验证：连接页、配置字段、应用库和失败记录可往返切换，刷新后语言保持，配置值和应用勾选状态保留；验证期间现有 Switch 会话持续连接。翻译规则的 42 个代表性样例通过。

Windows 适配的自动化检查已通过；大小写补偿更新后，17 项 Python 模拟串口断言用例和相关 8 项 Node 测试通过。已在 Windows 实测本地面板、COM 端口枚举、启动/重启/复用/停止入口、两套菜单资源生成，以及模拟 RPC 和串口协议。通过 COM15 实测确认现有 TextKeyboard 固件为 1.3，支持 TYPE2、ASCII、MAX=8192、CAPS_FIX=1。实机短文本测试中，启用大小写反转补偿后，OBS 画面确认 `' CASE TEST AaZz09!"` 的字母大小写、数字和符号输出正确。

229 行 NS2I 源码已完成实机录入，三段校验值分别为 `1947 / 439080`、`2864 / 181067`、`3068 / 713366`，全部匹配；显示的第 230 行是最后一个空行。执行 `SAVE "TXT:NS2I",0` 后，已在 OBS 画面确认 WORKSPACE 写入 `NS2I`，并返回 Direct 的 `OK`。整机重启后的引导已成功运行，控制面板显示 `Console connected`；OBS 画面确认 IZlauncher 菜单和 File Exchange 的 `/rom` 浏览均正常。

实际 FTP 测试通过局域网，以匿名、被动模式连接 Switch 的 `2121` 端口，成功列出 `/save`、`/tmp`、`/rom`，并将 `/rom/TINPUTASSIGN.CSV` 下载到电脑。服务端报告大小与实收大小均为 2179 字节，返回 `226` 完成响应，随后正常退出。此结果确认了目录浏览和实际文件下载；上传、重命名和删除尚未测试。

已修复 File Exchange 在空闲 FTP 状态不变时仍每 400 毫秒触发的无意义刷新，避免由此反复停启 GPU；4 项针对性离线测试通过。重启后再次打开 File Exchange，用户实机确认“已打开，移动流畅”。约 2 分钟的空闲观察中，未再出现该周期性刷新和 GPU 停启，GPU 心跳持续推进，连接保持正常。此前曾出现菜单移动时 `GetNpadState` 调用未返回、等待 120 秒后断开的情况，其底层挂起原因仍未确定；本次复测不能证明该问题已彻底解决。

已修复 Windows 文件短暂被占用时的日志及状态保存失败，增加有限重试。相关桥接、生命周期及状态保存回归检查和 `CHECK-WINDOWS.cmd` 已通过。此次适配包含 IZMYSH 引擎与 File Exchange；IZPSlauncher 已验证电脑端资源生成，尚未验证实机显示，直播/串流和另外两个引擎不属于已完成的 Windows 支持范围。
