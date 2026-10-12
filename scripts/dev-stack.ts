/**
 * One-command local development stack.
 *
 *   bun run dev         Preflight-check, ensure Supabase + Runner image, then
 *                       run Web (4173) and Runner (4174) in the foreground.
 *   bun run dev:doctor  Run every check without starting anything.
 *
 * The orchestrator reuses the supervisor's own building blocks
 * (ensureLocalSupabase, ensureRunnerImage), so local development and the
 * `db:*` scripts can never drift apart: the GitHub OAuth provider injection,
 * the loopback Docker network, and the Supabase keys all come from the same
 * code path. Configuration lives in `.env` and `.env.local` at the
 * repository root (gitignored, dev-stack-env-file.ts); every requirement is
 * validated up front by the one configuration reader (configuration.ts) and
 * the stack refuses to start with a precise remediation message instead of
 * failing mysteriously later.
 */
import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { type Configuration, ConfigurationError, readConfiguration } from "../packages/control-plane/src/configuration.ts";
import { ensureRunnerImage } from "../packages/control-plane/src/runner-image-identity.ts";
import { CONFIG_ROOT, ENV_FILE, LOCAL_ENV_FILE, loadEnvFiles } from "./dev-stack-env-file.ts";
import { ensureSignInEncryptionKeys } from "./dev-stack-sign-in-keys.ts";
import {
  ensureLocalSupabase,
  type LocalSupabaseEnvironment,
} from "../packages/control-plane/src/supervisor.ts";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

const WEB_PORT = 4173;
const RUNNER_PORT = 4174;
const PUBLIC_URL_DEFAULT = `http://127.0.0.1:${String(WEB_PORT)}`;

const CONFIGURATION_HELP = [
  `  Copy .env.example to ${ENV_FILE} and .env.local.example to ${LOCAL_ENV_FILE}, then fill them in.`,
  "  A local sign-in OAuth app (GitHub or Google) calls back to http://127.0.0.1:55321/auth/v1/callback.",
].join("\n");

class PreflightError extends Error {}

function ok(message: string): void {
  console.log(`  [32m✓[0m ${message}`);
}

function warn(message: string): void {
  console.log(`  [33m![0m ${message}`);
}

function section(title: string): void {
  console.log(`\n[1m${title}[0m`);
}

function fail(message: string, help?: string): never {
  throw new PreflightError(help ? `${message}\n${help}` : message);
}

async function commandSucceeds(command: string, args: string[], timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise(false);
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code === 0);
    });
  });
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 1_000 });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once("error", () => resolvePromise(false));
  });
}

function checkNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    fail(
      `Node ${process.versions.node} 过旧（需要 >= 22，@supabase 依赖原生 WebSocket）。`,
      "  运行 `nvm use 22`（仓库已提供 .nvmrc），或安装 Node 22+。",
    );
  }
  ok(`Node ${process.versions.node}`);
}

function checkDocker(): Promise<void> {
  return commandSucceeds("docker", ["info"]).then((running) => {
    if (!running) fail("Docker 不可用。", "  请先启动 Docker Desktop 再重试。");
    ok("Docker 运行中");
  });
}

function loadConfigurationFiles(): void {
  const loaded = loadEnvFiles(CONFIG_ROOT, process.env);
  for (const { file, applied } of loaded) ok(`Loaded ${file} (${String(applied.length)} variables)`);
  if (loaded.length === 0) warn("No .env or .env.local found; reading the shell's environment only");
}

/** The one configuration reader decides what is missing, and which integrations are on. */
function checkConfiguration(): Configuration {
  let configuration: Configuration;
  try {
    configuration = readConfiguration(process.env, "local");
  } catch (error) {
    if (error instanceof ConfigurationError) fail(error.message, CONFIGURATION_HELP);
    throw error;
  }
  const { integrations, signInProviders } = configuration;
  const github = !integrations.github ? "off" : "app" in integrations.github ? "configured" : "registered locally on first use";
  ok(`Configuration complete (sign-in: ${signInProviders.join(", ")})`);
  ok(`Slack ${integrations.slack ? "on" : "off"} · GitHub App ${github}`);
  return configuration;
}

function checkPublicUrl(): void {
  const configured = process.env.SHIPBASH_PUBLIC_URL?.trim();
  if (!configured) {
    process.env.SHIPBASH_PUBLIC_URL = PUBLIC_URL_DEFAULT;
    ok(`SHIPBASH_PUBLIC_URL 使用默认值 ${PUBLIC_URL_DEFAULT}`);
    return;
  }
  const url = new URL(configured);
  if (url.hostname === "localhost") {
    fail(
      "SHIPBASH_PUBLIC_URL 不能使用 localhost。",
      "  OAuth 回调锚定在 127.0.0.1（Supabase site_url），跨主机会丢失登录 Cookie。\n" +
        `  请改为 ${PUBLIC_URL_DEFAULT}。`,
    );
  }
  ok(`SHIPBASH_PUBLIC_URL = ${url.origin}`);
}

function checkActorSigningSecret(): void {
  const secret = process.env.SHIPBASH_ACTOR_SIGNING_SECRET?.trim();
  if (secret && Buffer.byteLength(secret, "utf8") >= 32) {
    ok("Actor 签名密钥在位");
    return;
  }
  const generated = randomBytes(32).toString("base64url");
  appendFileSync(LOCAL_ENV_FILE, `SHIPBASH_ACTOR_SIGNING_SECRET=${generated}\n`);
  chmodSync(LOCAL_ENV_FILE, 0o600);
  process.env.SHIPBASH_ACTOR_SIGNING_SECRET = generated;
  ok("已生成 Actor 签名密钥并写入 .env.local（Web 与 Runner 共用）");
}

async function ensureSupabase(configuration: Configuration): Promise<LocalSupabaseEnvironment> {
  const environment = await ensureLocalSupabase(ROOT, process.env);
  ok(`Supabase 就绪（${environment.apiUrl}）`);
  for (const provider of configuration.signInProviders) {
    const authorize = new URL("/auth/v1/authorize", environment.apiUrl);
    authorize.searchParams.set("provider", provider);
    authorize.searchParams.set("redirect_to", `${process.env.SHIPBASH_PUBLIC_URL ?? PUBLIC_URL_DEFAULT}/auth/callback`);
    const probe = await fetch(authorize, { redirect: "manual" }).catch(() => null);
    if (probe?.status !== 302) {
      fail(
        `${provider} 登录探针失败（/authorize 返回 ${String(probe?.status ?? "无响应")}，预期 302）。`,
        `  GoTrue 未启用 ${provider} provider。通常是 Supabase 容器由旧配置启动：\n` +
          "  运行 `bunx supabase stop` 后重新 `bun run dev` 让编排器带凭据重建。",
      );
    }
    ok(`${provider} 登录探针通过（/authorize → 302）`);
  }
  return environment;
}

async function ensureImage(): Promise<void> {
  console.log("  … Runner 镜像检查（首次构建需数分钟）");
  await ensureRunnerImage();
  ok("Runner 镜像就绪");
}

/**
 * A stack served from another worktree passes every port check and then
 * runs different code than the files being edited. When a listener exists,
 * its working directory must live under this repository root.
 */
async function checkStackOrigin(): Promise<void> {
  const root = process.cwd();
  for (const port of [4173, 4174]) {
    let pid = "";
    try {
      pid = execSync(`lsof -nP -ti tcp:${port} -s tcp:listen`, { encoding: "utf8" }).trim().split("\n")[0] ?? "";
    } catch {
      continue; // nothing listening — the start path will own the port
    }
    if (!pid) continue;
    let cwd = "";
    try {
      const fields = execSync(`lsof -a -p ${pid} -d cwd -Fn`, { encoding: "utf8" });
      cwd = fields.split("\n").find((line: string) => line.startsWith("n"))?.slice(1) ?? "";
    } catch {
      continue;
    }
    if (cwd && !cwd.startsWith(root)) {
      fail(
        `Port ${port} is served from ${cwd} — a different worktree. ` +
          "Stop that stack first (or work there): a stack from another " +
          "worktree runs different code than the files you are editing.",
      );
    }
  }
  ok("running services (if any) belong to this worktree");
}

async function checkPorts(requireFree: boolean): Promise<void> {
  for (const [name, port] of [["Web", WEB_PORT], ["Runner", RUNNER_PORT]] as const) {
    const inUse = await portInUse(port);
    if (!inUse) {
      ok(`${name} 端口 ${String(port)} 空闲`);
    } else if (requireFree) {
      fail(
        `${name} 端口 ${String(port)} 已被占用。`,
        "  可能已有一个 dev 实例在跑：直接使用它，或先停掉再重试。",
      );
    } else {
      warn(`${name} 端口 ${String(port)} 已被占用（服务可能已在运行）`);
    }
  }
}

function runStack(supabase: LocalSupabaseEnvironment): void {
  const project = resolve(process.env.SHIPBASH_PROJECT_PATH ?? ROOT);
  const executable = (name: string): string =>
    resolve(ROOT, "node_modules", ".bin", `${name}${process.platform === "win32" ? ".cmd" : ""}`);
  const shared: NodeJS.ProcessEnv = {
    ...process.env,
    SHIPBASH_PUBLIC_URL: process.env.SHIPBASH_PUBLIC_URL ?? PUBLIC_URL_DEFAULT,
    SHIPBASH_RUNNER_URL: `http://127.0.0.1:${String(RUNNER_PORT)}`,
    NEXT_PUBLIC_SUPABASE_URL: supabase.apiUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase.publishableKey,
  };

  const children: { name: string; process: ReturnType<typeof spawn> }[] = [
    {
      name: "Web",
      process: spawn(executable("next"), ["dev", "--hostname", "127.0.0.1", "--port", String(WEB_PORT)], {
        cwd: join(ROOT, "apps", "console"),
        stdio: "inherit",
        env: shared,
      }),
    },
    {
      name: "Runner",
      process: spawn(executable("tsx"), [
        "watch",
        "packages/control-plane/src/service.ts",
        "--project",
        project,
        "--port",
        String(RUNNER_PORT),
      ], {
        cwd: ROOT,
        stdio: "inherit",
        env: {
          ...shared,
          SHIPBASH_PROJECT_PATH: project,
          POSTGRES_URL: supabase.databaseUrl,
          SUPABASE_URL: supabase.apiUrl,
          SUPABASE_SECRET_KEY: supabase.serviceRoleKey,
        },
      }),
    },
  ];

  let stopping = false;
  const stop = (signal: NodeJS.Signals = "SIGTERM"): void => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.process.exitCode === null) child.process.kill(signal);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => stop(signal));
  }
  for (const child of children) {
    child.process.once("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
      stop();
    });
    child.process.once("exit", (code, signal) => {
      if (!stopping) {
        // A child died on its own (not our SIGTERM): say so loudly and name it,
        // then take the whole stack down together — a running Web against a dead
        // Runner (or the reverse) is a half-up stack that reads as "still fine".
        const how = code !== null ? `exit code ${String(code)}` : `signal ${String(signal)}`;
        console.error(
          `\n[31m✗ The ${child.name} process exited unexpectedly (${how}).[0m\n`
          + "  Stopping the dev stack. Fix the cause above, then run `bun run dev` to restart.\n",
        );
        process.exitCode = code ?? (signal ? 1 : 0);
        stop();
      }
    });
  }
}

async function main(): Promise<void> {
  const doctor = process.argv.includes("--doctor");

  section("环境预检");
  checkNodeVersion();
  await checkDocker();
  loadConfigurationFiles();
  checkPublicUrl();
  checkActorSigningSecret();
  ok(ensureSignInEncryptionKeys(LOCAL_ENV_FILE));
  const configuration = checkConfiguration();
  await checkStackOrigin();
  await checkPorts(!doctor);

  section("基础设施");
  const supabase = await ensureSupabase(configuration);
  await ensureImage();

  if (doctor) {
    section("结论");
    ok("全部检查通过，可以 bun run dev");
    return;
  }

  section(`启动服务（Web http://127.0.0.1:${String(WEB_PORT)} · Runner http://127.0.0.1:${String(RUNNER_PORT)}）`);
  runStack(supabase);
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    if (error instanceof PreflightError) {
      console.error(`\n[31m✗[0m ${error.message}\n`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
