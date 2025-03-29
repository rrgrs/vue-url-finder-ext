const { build } = require("esbuild");

const sharedConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
};

async function buildExtension() {
  try {
    await build({
      ...sharedConfig,
      outfile: 'dist/extension.js',
      sourcemap: false,
      minify: true,
      logLevel: 'info',
    });
    console.log("[esbuild] Production build complete.");

  } catch (err) {
    console.error("[esbuild] Build failed:", err);
    process.exit(1);
  }
}

buildExtension();