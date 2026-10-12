import { defineConfig } from "vite";

// One self-contained ES module with a shebang: its npm dependencies are
// bundled in (devDependencies, so the published package has none at run
// time), and nothing from the rest of the repository is reachable from here.
// Their license texts ship beside it in dist/THIRD_PARTY_LICENSES.md.
export default defineConfig({
	ssr: { noExternal: true },
	build: {
		target: "node20",
		ssr: "src/main.ts",
		outDir: "dist",
		emptyOutDir: true,
		minify: false,
		license: { fileName: "THIRD_PARTY_LICENSES.md" },
		rollupOptions: {
			output: { entryFileNames: "shipbash.js", banner: "#!/usr/bin/env node" },
		},
	},
});
