# Update to version 3.6.0

This website update adds private decline feedback and sensible catalog limits:

| Setting | Allowed value |
| --- | --- |
| Price | Whole pNgs from 0 through 50,000 |
| Limited and Limited U stock | Whole quantities from 10 through 500 |
| Non limited stock | Unlimited, stored as Stock 0 in the game definition |

The form and server enforce the same rules for community submissions, owner-created items and approval edits. Event rewards remain free. Existing catalog definitions in the game are not rewritten.

The Decline dialog has a separate reason field. Submitters see this reason under **Your submissions on this device** on the public page. Status refreshes every 30 seconds while that page is visible, when returning to it, and when clicking Refresh status. The last 100 private receipts are saved in the same browser. This is website feedback; the uploader does not collect an email address or send a direct message.

Private owner review notes remain private, including notes entered before this update. Automatic declines for duplicates or permanent publishing errors also provide the submitter with their safe rejection reason. A receipt ID alone cannot reveal feedback: each status check also requires its matching secret receipt key.

## Install on your existing site

Upload the new `Reminisce_Community_Catalog_GitHub_20261007.zip` into `/workspaces/HatUpload`, alongside the existing project, then run:

```sh
cd /workspaces/HatUpload &&
unzip -o Reminisce_Community_Catalog_GitHub_20261007.zip -d /tmp/reminisce-catalog-3-6 &&
node /tmp/reminisce-catalog-3-6/install-catalog-update.mjs /workspaces/HatUpload/reminisce-catalog-community &&
cd /workspaces/HatUpload/reminisce-catalog-community &&
npm ci &&
npm test &&
npm run build &&
npx wrangler d1 migrations apply reminisce-catalog-v3 --remote &&
npx wrangler deploy
```

If your existing D1 database has another name, replace `reminisce-catalog-v3` with `database_name` from `wrangler.jsonc`. Approve applying migration 0006 when Wrangler prompts. It adds the dedicated decline reason and preserves existing submissions and private review notes. Apply it before deploying the new Worker; earlier migrations are skipped when already installed.

Your existing game update, owner key, Roblox key, announcement webhook, Worker address and database binding remain in place. No additional game changes or API permissions are needed for this website update. The installer keeps the current configuration and daily upload limit of 100.

Open the existing public and owner pages and refresh them:

- Public: https://reminisce-catalog-community.reminiscehatimport.workers.dev/
- Owner: https://reminisce-catalog-community.reminiscehatimport.workers.dev/review.html

The owner connection report now shows uploader version 3.6.0. Decline a new submission with a reason, then return to its submitting browser to see the reason in its private receipt.

Save the updated code to GitHub:

```sh
cd /workspaces/HatUpload &&
git add reminisce-catalog-community &&
git commit -m "Add private decline feedback and catalog price and stock limits" &&
git push
```

## Earlier game and webhook setup

The sections below describe the 3.5.0 game and announcement update. If it is already installed, the website sequence above is all that is needed for 3.6.0.


## Head appearance correction

The latest game files clear the mesh texture, remove original face decals and SurfaceAppearance, keep the mesh shape, and add the game's default Smile to the front. Imported heads use SmoothPlastic with an empty MaterialVariant and zero Reflectance. When worn, they follow the player's selected head color and game face. Headless remains invisible. The appearance cache version was raised so older imported models rebuild automatically.

If you already installed 3.5.0, this correction needs only a game update. Either publish the updated files below to their existing places or run the complete `game-updates/FixHeadAppearance.lua` in each current place's Studio Command Bar with playtests stopped. That installer updates only HatService, makes a backup and checks the expected source before writing. Publish each place and restart its older servers. No website deployment, secret replacement or database migration is needed solely for this head correction.

The website archive also contains an updated full installer for matching pre-3.5 game sources and for the previous 3.5.0 release. If you have not installed the webhook update yet, follow the complete sequence below.

Accepted items are announced by the website after Roblox confirms publication. No player needs to be in the game. The game skips website-managed announcements, and the website keeps delivery status and a separate Retry announcement button. Publication failures never announce an item.

## 1. Publish the updated game files first

Open each supplied file in Roblox Studio and use File > Publish to Roblox As to select its existing place in experience 6377498041:

- `GameMain_ItemPublishing_SmoothHeads_20261007.rbxl` → your existing main place.
- `GameServer_ItemPublishing_SmoothHeads_20261007.rbxl` → your existing gameplay/server place.
- `GameStudio_ItemPublishing_SmoothHeads_20261007.rbxl` → your existing Studio place.

Keep the same experience and places. Restart servers running the previous version, then join a new server once to refresh the shared uploader registration. After that, announcements work with nobody online. Update every place that reads this catalog so an older server cannot send a second announcement.

These files were patched from the versions supplied with this request. Only HatDefinitions, HatService and ServerMain were changed. Existing Halloween, zombie-face, barricade, economy, webhook endpoints and other scripts were retained. Imports keep the head shape, remove its original decals, textures and facial animation controls, use SmoothPlastic, and add the default Smile. A player's chosen game face can still replace Smile. Headless stays invisible.

If you have made newer changes since sending those files, `game-updates/EnableR6Heads.lua` patches the matching scripts in place in Studio Edit mode and keeps a backup. It checks all source changes before writing. If its source-version check fails, keep your current place and update the three scripts from a matching file instead of overwriting newer work.

## 2. Install and migrate the website

Upload the new `Reminisce_Community_Catalog_GitHub_20261007.zip` into `/workspaces/HatUpload`, alongside the existing project. Run this block. Each `&&` stops the sequence on a failure.

```sh
cd /workspaces/HatUpload &&
unzip -o Reminisce_Community_Catalog_GitHub_20261007.zip -d /tmp/reminisce-catalog-3-5 &&
node /tmp/reminisce-catalog-3-5/install-catalog-update.mjs /workspaces/HatUpload/reminisce-catalog-community &&
cd /workspaces/HatUpload/reminisce-catalog-community &&
npm ci &&
npm test &&
npm run build &&
npx wrangler d1 migrations apply reminisce-catalog-v3 --remote
```

If your D1 database name differs, use `database_name` from your existing `wrangler.jsonc`. Migration 0005 adds announcement tracking and preserves existing submissions, publication jobs, catalog entries and sessions. Do not create another database. Older publications retain their game-managed announcement behavior; this update does not broadcast the old catalog again.

The installer preserves your Worker name, database binding and ID, Turnstile site key, API URL, development secrets, existing ignore patterns and Roblox settings. Existing owner and Roblox API keys remain in place. The public quota remains 100 submissions per network per day.

## 3. Add the existing announcement webhook as a Worker secret

In Studio, open `ServerScriptService.Services.LegacyWebhookEndpoints` and privately copy the complete URL assigned to `Reminisce_NewItems`. You can also use a Discord webhook URL copied from the intended channel's integrations. The existing `webhook.lewisakura.moe` endpoint format is supported.

Run this command by itself in the project folder:

```sh
npx wrangler secret put NEW_ITEM_WEBHOOK_URL
```

Paste the URL into the hidden prompt and press Enter. Keep it out of GitHub, configuration files, screenshots and chat. Use the same new-item channel as the game. The existing role ping is preserved through `NEW_ITEM_PING_ROLE_ID`; an empty value disables the ping. Only that role is allowed to be mentioned.

## 4. Deploy and check

```sh
npx wrangler deploy
```

Refresh `/review.html`, sign in with your existing owner key, and click Test game connection. The report should show uploader version 3.5.0, a configured webhook secret, and the game announcement update installed in the registered place. The test reads configuration and Roblox data; it does not send a test message or verify every place.

Accept one genuinely new item while the game is empty. After publication, the owner page should show Announcement sent. A rejected webhook leaves the item published and displays Retry announcement. Retry publish is only for a failed game publication; retrying an announcement does not reset stock or sale timers. Rate limits and service errors retry from the saved queue. If delivery cannot be confirmed, check the channel before using Retry announcement to avoid another ping.

Then save the code to GitHub:

```sh
cd /workspaces/HatUpload &&
git add reminisce-catalog-community &&
git commit -m "Send item announcements from uploader and normalize head faces" &&
git push
```

`node_modules`, development secrets and Wrangler state remain ignored. No Roblox API permission changes are required for this update.
