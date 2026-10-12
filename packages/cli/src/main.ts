/** The `shipbash` executable: one call, and its exit code. */
import { run } from "./cli.ts";

process.exitCode = await run(process.argv.slice(2));
