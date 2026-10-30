# 第三方组件声明 / Third-Party Notices

本项目**自己的代码**采用 [MIT License](LICENSE)（© 2026 albetta009）。

但**便携包（`MYAssistant-clean-*.zip`）里还包含第三方组件**，它们各自遵循自己的许可，不适用本项目的 MIT：

---

## 1. SnowLuma（QQ 协议端）

- 版本：2.0.3（`runtime/snowluma/`）
- 许可：**SnowLuma Source-Available Non-Commercial License**
- 随包附带：`runtime/snowluma/EULA.md`、`runtime/snowluma/PRIVACY.md`（未做任何修改）
- 允许：个人使用、非商业自托管、以及在许可条件下的非商业再分发
- 限制：**商业使用**、以及**公开发布修改版/衍生版**，均需著作权人事先书面授权
- 版权人联系方式：motricseven@foxmail.com

> 便携包只是把 SnowLuma 的官方发行包原样放在一起，**没有修改、没有拆出它的专有组件单独分发**。
> 如果你要用于商业用途，请自行联系其作者取得授权。

## 2. Node.js

- 许可：MIT
- 用途：核心运行时（`runtime/node/node.exe`）与 SnowLuma 自带运行时

## 3. Microsoft Edge WebView2

- 许可：Microsoft 软件许可条款
- 用途：仅当系统已安装 WebView2 Runtime 时由启动器使用；本包**不包含**其二进制

---

## 使用范围

便携包**仅供个人、非商业用途**使用。商用、或修改后公开再发布，请分别取得各第三方组件的授权。

如果你只需要本项目代码，下载 **源码包**（`MYAssistant-source-*.zip`）即可，它只包含 MIT 授权的自有代码。
