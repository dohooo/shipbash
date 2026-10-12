/** Opens a URL in the user's browser; the URL is printed either way, so a failure here costs nothing. */
import { spawn } from "node:child_process";

export function openInBrowser(
	url: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const [command, args] =
		platform === "darwin"
			? ["open", [url]]
			: platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.on("error", () => undefined);
		child.unref();
		return true;
	} catch {
		return false;
	}
}
