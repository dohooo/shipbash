// Inside a Vercel Sandbox made from the runner image, run as a runner child
// runs there (uid 10001, the child environment; scripts/sandbox-browser-smoke.ts
// starts it): a Case lane's desktop, its browser launched as every lane
// launches one (harness-browser.mjs), one agent-browser command joining it,
// the desktop probe, and the browser ended — and the shell's masking, whose
// rules are packages the bundle carries: a package the install left out
// fails here, at release, not in a walk. Prints one JSON line; exits 1
// unless the browser answered and a token was masked.
import { existsSync, readFileSync } from "node:fs";

const RUNTIME = process.env.SHIPBASH_RUNTIME_DIRECTORY ?? "/shipbash/runtime";
const { agentBrowser, cleanBrowserEnvironment } = await import(`${RUNTIME}/suite-runner/browser.mjs`);
const { startSuiteDisplay } = await import(`${RUNTIME}/suite-runner/display.mjs`);
const { stopManagedServices } = await import(`${RUNTIME}/suite-runner/processes.mjs`);
const { launchHarnessBrowser, runsContainerised } = await import(`${RUNTIME}/harness-browser.mjs`);
const { prepareDesktopBrowser } = await import(`${RUNTIME}/desktop-browser.mjs`);
const { redactor } = await import(`${RUNTIME}/suite-runner/redaction.mjs`);
const { maskTerminalText } = await import(`${RUNTIME}/terminal-text-masking.mjs`);

const read = (path) => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
};

const env = cleanBrowserEnvironment({ AGENT_BROWSER_NAMESPACE: "sandbox-smoke", AGENT_BROWSER_SESSION: "sandbox-smoke" });
// What decides Chromium's own sandbox here, as agent-browser decided it.
const where = {
  uid: process.geteuid?.() ?? null,
  containerised: runsContainerised({ env }),
  dockerenv: existsSync("/.dockerenv"),
  containerenv: existsSync("/run/.containerenv"),
  cgroup: read("/proc/1/cgroup")?.slice(0, 200) ?? null,
  ci: env.CI ?? null,
};
const masked = await maskTerminalText("GITHUB_TOKEN=ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8\r\n", { redactor, columns: 100 }); // gitleaks:allow
const display = await startSuiteDisplay(env);
const result = { probe: "sandbox-browser", ...where, masked, ok: false };
try {
  const started = Date.now();
  const browser = await launchHarnessBrowser({ env, desktop: true });
  result.launchMs = Date.now() - started;
  // The features the browser runs with, from its own command line.
  result.enableFeatures = (read(`/proc/${String(browser.pid)}/cmdline`) ?? "").split("\0").find((arg) => arg.startsWith("--enable-features=")) ?? null;
  try {
    const answered = Date.now();
    await agentBrowser(["open", "data:text/html,<title>sandbox-smoke</title><h1>ok</h1>"], env);
    result.firstCommandMs = Date.now() - answered;
    await prepareDesktopBrowser(agentBrowser, env, {});
    result.title = (await agentBrowser(["eval", "document.title"], env)).json?.data?.result ?? null;
    result.ok = result.title === "sandbox-smoke" && masked === "GITHUB_TOKEN=[REDACTED]\r\n";
  } finally {
    await browser.close();
  }
} catch (error) {
  result.error = String(error?.message ?? error).slice(0, 1_000);
} finally {
  await stopManagedServices(display);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
