# Windows 安装版

## 安装与启动

从 [正式版本](https://github.com/Wahuwahuuu/AsterCite/releases/latest) 下载 `AsterCite-1.3.0-windows-x64-setup.exe`，安装后从开始菜单打开 AsterCite。

支持 Windows 10 / 11 x64，推荐 16 GB 内存和至少 10 GB 可用磁盘空间。安装包包含 Node.js、Python、CPU 检索环境和论文库，不需要先安装开发工具。

首次启动会下载约 4.6 GB 的 BGE 检索模型，窗口会显示下载进度。中断后再次启动即可继续；以后启动直接使用本机模型。

在启动窗口中填写：

- **模型服务地址**：服务商提供的 OpenAI 兼容接口地址，通常以 `/v1` 或 `/v4` 结尾。
- **模型名称**：服务商的模型 ID。需要支持流式响应与工具调用。
- **本次密钥**：你自己的 API key。也可提前设置 `PIPAPER_API_KEY`，启动时留空。
- **兼容方式与推理强度**：通常选择“通用 OpenAI 兼容”；智谱选择“智谱 Z.ai”，并按模型支持情况选择推理强度。
- **上下文容量与最大输出**：按所用模型的容量填写。

点击“启动问答”。检索模型加载完成后会自动打开浏览器，开始自由提问。问答调用费用取决于你选择的模型服务。

## 在网页中使用

左侧可以查找论文、限定问题范围；中间输入问题并继续追问；点击回答中的引用编号，右侧会显示对应原文。

可以先选择一篇论文，询问“这篇论文解决什么问题，核心方法是什么？请给出原文依据”，然后追问方法细节或与另一篇论文比较。

关闭服务窗口即可停止。再次启动后，在同一浏览器的“最近对话”中继续。配置、会话与模型保存在安装目录，升级安装会保留这些内容。密钥只用于当前运行，不写入配置文件；下次启动时重新提供，或使用自己的环境变量。

## 常见问题

**下载中断**：保留安装目录，重新打开 AsterCite。已有的模型文件和下载进度会被继续使用。

**浏览器没有自动打开**：等待窗口显示“完整问答”后，打开 `http://127.0.0.1:4173`。

**提示端口被占用**：关闭之前的 AsterCite 服务窗口，再次启动。

**模型返回错误**：检查模型名称、服务地址、余额以及工具调用支持情况。重新启动可更换模型设置；更换模型后新建对话。

**准备模型时磁盘不足**：可重新安装到空间充足的目录。首次使用需要下载检索模型，不需要下载生成模型。

**卸载**：通过 Windows“已安装的应用”卸载。自行下载的模型、配置和会话会留在原目录；确认不再需要后可手动删除该目录。

## 使用 CLI

在安装目录打开终端，设置自己的 `PIPAPER_API_KEY` 后执行：

```powershell
.runtime/node/node.exe agent/cli.ts --session research
```

CLI 沿用启动窗口保存的模型配置和同一论文库，CLI 与网页分别保存会话。

## 从源码构建安装包

构建机使用 Windows x64、Node.js 24.11.1、Python 3.12.13、[uv](https://docs.astral.sh/uv/getting-started/installation/) 与 [Inno Setup 6](https://jrsoftware.org/isdl.php)。

```powershell
npm ci --ignore-scripts
uv venv .local/desktop-cpu --python 3.12.13
uv pip sync desktop/requirements-win-x64.lock --python .local/desktop-cpu/Scripts/python.exe --require-hashes --only-binary :all:
python desktop/build_windows.py --cpu-python .local/desktop-cpu/Scripts/python.exe --stage .release-work/windows-stage --iscc "C:/Program Files (x86)/Inno Setup 6/ISCC.exe"
```

产物保存在 `dist/`。构建只收集 `desktop/product-files.json` 中列出的产品文件。内置论文和 CPU 索引来自 `desktop/resources/`，安装后可直接使用；检索模型在首次启动时准备。
