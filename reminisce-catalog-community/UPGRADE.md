# Updating a deployed catalog

## October 7, version 3.2

Upload the updated Reminisce_Community_Catalog_GitHub_20261007.zip to the top level of your HatUpload Codespace. Run these commands in order, stopping if any command fails:

```sh
cd /workspaces/HatUpload && unzip -o Reminisce_Community_Catalog_GitHub_20261007.zip -d /tmp/reminisce-catalog-update-v5
node /tmp/reminisce-catalog-update-v5/install-catalog-update.mjs /workspaces/HatUpload/reminisce-catalog-community
cd /workspaces/HatUpload/reminisce-catalog-community && npm ci && npm test && npm run build
npx wrangler deploy
git add .
git commit -m "Simplify item uploader and correct Limited U exports"
git push
```

The installer preserves your Worker name, D1 database ID/binding, Turnstile site key, service URL, private development secrets, and ignore patterns. It keeps the per-network quota at 100 and preserves your configured global quota. It does not recreate the database or reset Cloudflare secrets. No new schema migration is needed when updating version 3.1.

This release adds the supplied icon and Reminisce Item Uploader title, removes redundant categories and advanced placement, limits new catalog options to Non limited / Limited / Limited U / Event reward, replaces date schedules with an optional timed-item duration, and removes contributor usernames/messages. Item search has Search by name and Paste item link modes. Faces ask for their classic Texture ID in Item details while retaining the verified original Roblox item internally.

Limited U now has fixed stock with repeat purchases and no mandatory timer. Its export sets LimitedU, Stock, and MaxPerUser accordingly. The older Roblox game reference uses different Limited U rules: update the game's HatDefinitions and buying logic to honor this definition before publishing such items. The owner export warns about this requirement; this package updates only the website. Older zero-stock Limited U submissions need a stock count before export.

After deployment, open your submission page or /review.html and hard refresh with Ctrl+Shift+R. Sign in with your current owner key. The existing-item registry continues to grow atomically on approval, and accepted or pending duplicates remain blocked.

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
