<p align="center">
  <img src="./brand/exports/shipbash-lockup-horizontal-white-animated.svg#gh-dark-mode-only" alt="ShipBash" width="440">
  <img src="./brand/exports/shipbash-lockup-horizontal-black-animated.svg#gh-light-mode-only" alt="ShipBash" width="440">
</p>

<p align="center"><strong>You ship it. We bash it.</strong></p>

<p align="center">你的 agent 说做完了，ShipBash 让你看到它真的能用。它像真实用户一样测试你的 Web 应用和 CLI，直接在线上跑，每个结论都有录屏。</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-141414?style=flat-square" alt="License: Apache-2.0"></a>
  <a href="https://www.npmjs.com/package/shipbash"><img src="https://img.shields.io/npm/v/shipbash?style=flat-square&label=npm&color=141414" alt="npm version of shipbash"></a>
</p>

<p align="center">
  <a href="https://shipbash.dev">官网</a> ·
  <a href="https://app.shipbash.dev">控制台</a> ·
  <a href="packages/cli">CLI</a> ·
  <a href="#自托管">自托管</a>
</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

<p align="center">
  <a href="https://shipbash.dev/shipbash-demo.mp4"><img src=".github/assets/shipbash-demo.webp" alt="在一个 Slack thread 里，有人问 ShipBash：会话刚结束就关掉 incognito，这个会话还会不会被学习？ShipBash 去测试 CLI，用录屏抓到了 bug，Claude 修好了它。" width="100%"></a>
</p>

## 它做什么

开源的 AI QA，像真实用户一样在线上使用你的 Web 应用和 CLI。每个结论都附带带字幕的录屏，每次失败都附带一份报告，可以直接交给编程 agent 去修。

给它产品的网址，它会和你一起在真实的浏览器和终端里使用你的产品，直到定下最要紧的用户旅程，比如注册、下单、安装你的 CLI。每条旅程是一个目标加几个检查点，用自然语言写，不是脚本，也不是一串选择器。

之后 ShipBash 按计划运行这些旅程，你也可以随时让它跑。在 Slack 的 thread 里 @ShipBash，它就会去检查你刚发布的东西。每个结论你都不用重测就能核对：录屏、截图、控制台输出，还有每个检查点的日志。

## 工作原理

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/how-it-works-dark.svg">
  <img src=".github/assets/how-it-works-light.svg" alt="Discover the app, pin the journeys, run them on a schedule, and get a verdict with proof. You take control for sign-ins; a failed journey becomes a report for your coding agent." width="100%">
</picture>

ShipBash 是套在通用 agent 外面的那一层：agent 操作的浏览器和终端、它的记忆，以及历次运行的记录。它不写测试脚本，每一步怎么走由 agent 根据旅程的目标和检查点来定。每次运行都在新的沙箱里开始，结束后沙箱即被删除。需要人来操作时，你在 agent 的浏览器里接手，做完交还给它；ShipBash 会加密保存登录后的会话，后续运行直接复用。

## 开始使用

托管版 [app.shipbash.dev](https://app.shipbash.dev) 目前只对受邀用户开放：登录后会进入候补名单，放行后添加产品网址，就能开始探索。

也可以把下面这行粘贴到 Claude Code、Codex 或 Cursor，让 agent 用 [`shipbash` CLI](packages/cli) 帮你配置：

```text
Read shipbash.dev/setup.md and set up ShipBash for this project.
```

在自己的终端里用 CLI 也一样：

```bash
npx shipbash login
npx shipbash projects add https://app.acme.example
npx shipbash journeys add --project <project>
```

## 自托管

一套部署包括一个 Vercel 项目（跑控制台和每次运行）和一个 Supabase 数据库。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/self-host-dark.svg">
  <img src=".github/assets/self-host-light.svg" alt="The console runs on Vercel with its data in Supabase; each run starts a Vercel Sandbox from the runner image, which drives your live app and calls the model API." width="100%">
</picture>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdohooo%2Fshipbash&project-name=shipbash&repository-name=shipbash&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D&env=OPENAI_BASE_URL,OPENAI_API_KEY,TYPESAFE_API_URL,TYPESAFE_API_KEY&envDescription=The%20endpoints%20and%20keys%20of%20the%20models%20your%20agents%20call%3A%20an%20OpenAI-compatible%20model%20and%20TypeSafe.%20The%20other%20variables%20are%20in%20.env.example.&envLink=https%3A%2F%2Fgithub.com%2Fdohooo%2Fshipbash%2Fblob%2Fmain%2F.env.example">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/deploy-button-dark.svg">
      <img src=".github/assets/deploy-button-light.svg" alt="Deploy to Vercel">
    </picture>
  </a>
</p>
<p align="center"><sub>部署完成后，再做下面三步。</sub></p>

这个按钮会克隆本仓库，创建 Vercel 项目，通过 Vercel 的 Supabase 集成挂上一个 Supabase 数据库，并让你填写 agent 所调用模型的接口地址和密钥。然后：

1. 把 `.env.example` 里其余的变量（包括仅托管版使用的那一节）加到项目的环境变量里。数据库相关的变量已由集成写好。
2. 在新仓库的本地克隆里，用项目的 `POSTGRES_URL_NON_POOLING` 执行迁移：`bunx supabase db push --db-url "$POSTGRES_URL_NON_POOLING"`。
3. 用 `packages/runner/Dockerfile` 构建 runner 镜像，推到项目的 Vercel 容器仓库，再把 `SHIPBASH_RUNNER_IMAGE` 设为推送后的镜像。

让 CLI 连到你的部署：`npx shipbash login --origin https://<your-console>`。

## 本地开发

需要 Node.js 22 及以上版本、package.json 的 `packageManager` 指定的 Bun 版本，以及 Docker。

```bash
git clone https://github.com/dohooo/shipbash.git
cd shipbash
bun install
```

把 `.env.example` 复制为 `.env`，`.env.local.example` 复制为 `.env.local`，填好后运行：

```bash
bun run dev:doctor   # check the setup without starting anything
bun run dev          # local Supabase, the runner image, the console and the runner service
```

在 <http://127.0.0.1:4173> 打开控制台；用 `localhost` 无法登录。本地运行时，同一个 runner 镜像跑在你本机的 Docker 上，不走 Vercel Sandbox。检查命令：

```bash
bun run typecheck
bun run lint
bun run build
```

提交 pull request 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[Apache License 2.0](LICENSE)。第三方声明见 [NOTICE](NOTICE)。
