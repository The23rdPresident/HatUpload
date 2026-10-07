import { readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";

import { minify } from "terser";

const config = JSON.parse(await readFile("site.config.json", "utf8"));

const apiUrl = String(config.apiUrl || "").replace(/\/$/, "");

if (apiUrl) {
  const url = new URL(apiUrl);
  if (url.protocol !== "https:" || url.origin !== apiUrl) throw new Error("apiUrl must be an HTTPS origin without a path.");
}

await rm("docs", {
  recursive: true,
  force: true
});

await mkdir("docs/assets", {
  recursive: true
});

for (const [source, target] of [ [ "shared/core.js", "core" ], [ "src/ui.js", "ui" ], [ "src/submit.js", "submit" ], [ "src/review.js", "review" ] ]) {
  const result = await minify(await readFile(source, "utf8"), {
    compress: true,
    mangle: true,
    format: {
      comments: false
    },
    sourceMap: false
  });
  await writeFile("docs/assets/" + target + ".min.js", result.code + "\n");
}

const stylesheet = (await readFile("src/styles.css", "utf8")).replace(/\s+/g, " ").replace(/\s*([{};:,])\s*/g, "$1").trim();

await writeFile("docs/assets/styles.min.css", stylesheet);

const form = await readFile("src/item-form.html", "utf8"), contributor = await readFile("src/contributor.html", "utf8");

const publicForm = form.replace('<div class="editor-footer">', contributor + '<div class="editor-footer">');

const policy = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data: https://*.rbxcdn.com; connect-src 'self' https://challenges.cloudflare.com" + (apiUrl ? " " + apiUrl : "") + "; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'";

for (const page of [ "index", "review" ]) {
  let html = (await readFile("src/" + page + ".html", "utf8")).replace("{{ITEM_FORM}}", form).replace("{{PUBLIC_FORM}}", publicForm);
  html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '">');
  await writeFile("docs/" + page + ".html", html.replace(/>\s+</g, "><").trim() + "\n");
}

await writeFile("docs/config.js", "window.SITE_CONFIG=" + JSON.stringify({
  apiUrl: apiUrl
}) + ";\n");

await copyFile("src/favicon.png", "docs/favicon.png");

await writeFile("docs/.nojekyll", "");

console.log("Website built in docs/.");
