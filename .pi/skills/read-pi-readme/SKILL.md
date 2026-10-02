---
name: read-pi-readme
description: 阅读 pi-coding-agent 的 README.md 并给出结论；或根据 README 中的链接进一步查询 docs/ 目录下的其他文档以获取详细信息。仅通过 /skill:read-pi-readme 手动触发，不自动加载。
disable-model-invocation: true
---

# read-pi-readme

## 用途

回答用户关于 pi-coding-agent 的配置、使用、扩展、自定义等问题。

## 步骤

1. 读取主文档：
   `C:\Users\tengs\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\README.md`

2. 根据用户问题，在 README 中定位相关章节（目录、Prompt Templates、Skills、Extensions、Settings、Context Files 等）

3. 总结并给出直接结论

4. 如需更深信息，根据 README 中的相对路径（例如 `docs/skills.md`、`docs/extensions.md`），读取 `C:\Users\tengs\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\` 目录下对应文件

5. 必要时结合 `examples/` 目录（`C:\Users\tengs\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\examples\`）查看示例

## 输出规范

- 用中文回答
- 直接给出结论，避免长篇引用
- 引用具体章节或文件名时给出路径，便于用户复核