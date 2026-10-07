# Updating a deployed catalog

## October 7, version 3.1

Upload the new `Reminisce_Community_Catalog_GitHub_20261007.zip` to the top level of your HatUpload Codespace. Extract the update into a separate temporary directory, then run the included installer against your deployed project:

```sh
cd /workspaces/HatUpload
unzip -o Reminisce_Community_Catalog_GitHub_20261007.zip -d /tmp/reminisce-catalog-update-v4
node /tmp/reminisce-catalog-update-v4/install-catalog-update.mjs /workspaces/HatUpload/reminisce-catalog-community
cd /workspaces/HatUpload/reminisce-catalog-community
npm ci && npm test && npm run build
npx wrangler deploy
git add .
git commit -m "Fix catalog lookup and review routes; simplify layout"
git push
```

Run one block at a time and stop if a command fails. This update preserves your Worker name, D1 database ID and binding, Turnstile site key, service URL, and ignore rules. It does not recreate the database, delete submissions, or replace Cloudflare secrets. The source configuration uses valid JSON; keep that format when editing it before running the installer.

The per-network daily limit increases to 100 verified submission attempts. The site-wide limit remains whatever you already configured (200 by default). Roblox API and Turnstile requests use a redirect mode supported by Cloudflare. HTML handling is explicitly disabled so the owner page works at `/review.html`; `/review` also works and `/review/` redirects to the HTML document.

The blue and white interface follows the supplied classic Roblox games-page reference. Search results, the selected item, and the review queue show Roblox-generated thumbnails. A reskin shows its original base; this update does not render a new model with your replacement texture.

After deployment, open the root submission page and `/review.html`. Hard refresh with Ctrl+Shift+R if the previous page is cached. The owner key remains the one associated with your current Cloudflare `ADMIN_KEY_HASH`.

## Older installations

# Update your current HatUpload installation

1. Open your existing Codespace. Keep your current `wrangler.jsonc`, `site.config.json`, and any private `.dev.vars` file. Your Worker name, database ID, public origins, and Turnstile site key belong to your installation.
2. Extract the updated archive. Copy its project files into `/workspaces/HatUpload/reminisce-catalog-community`, replacing the old versions except the configuration files above. Include the new `data` directory and all three migration files. Keep your existing database and Cloudflare secrets; do not recreate them or generate another owner key.
3. Run in the Codespace terminal:

```sh
cd /workspaces/HatUpload/reminisce-catalog-community
npm ci
npm test
npx wrangler d1 migrations apply reminisce-catalog --remote
npm run build
npx wrangler deploy
```

Apply the database migrations before deploying the new Worker. Wrangler applies only unapplied migrations, preserving existing submissions and owner sessions. They create the shared existing-item registry, register any entries already approved on the site, and add the 407 supplied items. Some older duplicate pending submissions may need to be declined before another matching entry can be approved.

4. Open the website URL printed by deployment and refresh it. Sign in at `/review.html` with your existing owner key. **Download item list** includes your initial catalog and accepted entries. Accepting an item updates this database list immediately for all contributors.
5. Commit the updated project to GitHub:

```sh
git add .
git commit -m "Add existing-item checks and catalog categories"
git push
```

The website never writes to your Roblox DataStore directly. Run generated publisher code in Roblox Studio as before. The complete publisher now refuses existing game items rather than replacing them. Publishing items outside this website still requires keeping the website registry current; the publisher's final game check remains an additional safeguard.

Heads and precise attachment choices require matching support in the game's definition, catalog, and equipment code. This archive changes the website and exports those fields; it does not update the place files. See the field contract in `README.md`.
