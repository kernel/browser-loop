import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/task.ts"],
  format: ["esm"],
  platform: "node",
  dts: false,
  sourcemap: false,
  clean: true,
  outExtensions: () => ({ js: ".js" }),
});
