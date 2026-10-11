import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { standaloneBuildOptions } from "./standalone-build-options.mjs";
import { portalMarkup } from "../src/app.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const cssPath = path.join(projectDir, "src", "styles.css");
const entryPath = path.join(projectDir, "src", "main.js");
const outputPath = path.resolve(projectDir, "..", "仓库管理系统_双击打开.html");

const [css, bundle] = await Promise.all([
  readFile(cssPath, "utf8"),
  build({
    ...standaloneBuildOptions,
    entryPoints: [entryPath],
  }),
]);

const externalImports = Object.values(bundle.metafile.inputs)
  .flatMap((input) => input.imports)
  .filter((item) => item.external);
if (externalImports.length) {
  throw new Error(`Standalone output cannot include external imports: ${externalImports.map((item) => item.path).join(", ")}`);
}

const appScript = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#f4f6f2">
  <meta name="description" content="仓库管理系统可交互静态原型，支持手机和电脑离线查看。">
  <title>仓库管理系统 · 本地演示</title>
  <style>${css}</style>
</head>
<body>
  <div id="root">${portalMarkup()}</div>
  <noscript><p class="noscript-note">请启用浏览器的 JavaScript，以使用登录及库存演示交互。</p></noscript>
  <script>
    (function () {
      function showStartupError(reason) {
        var root = document.getElementById("root");
        if (!root) return;
        root.innerHTML = '<main class="standalone-fallback standalone-error"><h1>页面启动失败</h1><p>请重新打开文件；若仍然失败，请提供下面的错误信息。</p><pre></pre></main>';
        var detail = root.querySelector("pre");
        if (detail) detail.textContent = String(reason || "未知错误");
      }
      window.addEventListener("error", function (event) {
        showStartupError(event.message || (event.error && event.error.message));
      });
      window.addEventListener("unhandledrejection", function (event) {
        showStartupError(event.reason && event.reason.message || event.reason);
      });
    }());
  </script>
  <script>${appScript}</script>
</body>
</html>
`;

await writeFile(outputPath, html, "utf8");
// Keep the previously delivered copy synchronized with the repository-root file.
await writeFile(path.join(projectDir, "仓库管理系统_双击打开.html"), html, "utf8");
console.log(`Created standalone HTML: ${outputPath}`);
console.log(`Inline bundle: ${Buffer.byteLength(appScript)} bytes; CSS: ${Buffer.byteLength(css)} bytes`);
