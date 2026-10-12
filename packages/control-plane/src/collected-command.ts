import { spawn } from "node:child_process";

export interface CollectedCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export function runCollectedCommand(
	executable: string,
	args: readonly string[],
	options: { cwd?: string | undefined; env: NodeJS.ProcessEnv },
): Promise<CollectedCommandResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(executable, [...args], {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			resolvePromise({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}
