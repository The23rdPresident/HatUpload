# Update to version 3.8

This update distinguishes faces on the standard Roblox head from custom head shapes and accepts UGC faces. Keep your current game files. Faces use the existing Face definition format with a standalone classic image; custom-shaped heads use the existing Head format.

## Install in your existing Codespace

Download the updated `Reminisce_Community_Catalog_GitHub_20261007.zip` and upload it to `/workspaces/HatUpload`, beside your existing `reminisce-catalog-community` folder. Use the new download, replacing an older ZIP with the same filename.

Run this block in the Codespace terminal. Each command waits for the previous command to succeed:

```sh
cd /workspaces/HatUpload &&
mkdir -p /tmp/reminisce-faces-v38 &&
unzip -o Reminisce_Community_Catalog_GitHub_20261007.zip -d /tmp/reminisce-faces-v38 &&
node /tmp/reminisce-faces-v38/install-catalog-update.mjs /workspaces/HatUpload/reminisce-catalog-community &&
cd /workspaces/HatUpload/reminisce-catalog-community &&
npm ci &&
npm test &&
npm run build &&
npx wrangler deploy
```

The installer checks the target project and backs up its Worker configuration. It preserves your Worker name, D1 database name and ID, Turnstile site key, service URL, publishing settings, development secrets and existing ignore patterns. Cloudflare's stored secrets remain attached to the same Worker. The daily upload limit stays at 100 per network.

Upgrading from version 3.7 needs no new migration, game registration or API key changes. If your deployment predates version 3.6, apply the included database migrations using the existing database name from `wrangler.jsonc` before deployment. Do not create a new database.

## Check the updated site

Open the existing public URL and hard refresh with Ctrl+Shift+R. Search by name or choose Paste item link. The Item type updates automatically after lookup, including when a face link was entered while Head was selected.

The supplied O_o, Epic Face and I Am Not Amused bundle links select Face and fill their original classic image IDs. Angry Diamond, Perfectly Round and Content and Rectangle select Head and keep their head asset IDs. Existing items are still blocked: for example, Epic Face is already in the supplied game catalog, so its dynamic link cannot submit another copy.

Faces and heads can be made by Roblox users or groups. A standard-shaped UGC head with no identifiable original classic face or separate front decal asks for a standalone face image or decal in the same Texture ID field. Full head mesh textures cannot be used as face images. Normal resolved faces have a locked texture field; reskins can use a verified replacement. If Roblox will not provide readable geometry, an unknown item stays Head and the lookup explains how to use a classic face link instead.

Your owner page remains at `/review.html`. Its Test game connection report shows uploader version 3.8.0. Existing submissions, approvals, published items and private receipts remain stored in the same database.

## Save the update to GitHub

```sh
cd /workspaces/HatUpload &&
git add reminisce-catalog-community &&
git commit -m "Classify dynamic faces and support UGC faces" &&
git push
```

The ZIP and dependencies do not need to be committed. The project ignore file excludes `node_modules`, development secrets and Wrangler state.
