# Reminisce Item Uploader

Share the submission page with your community. Contributors suggest heads from any Roblox user or group, Roblox-created accessories, gear, classic faces, body packages, and accessory or face reskins. You review each submission at `/review.html`, edit its settings, then approve it for automatic publishing or decline it.

Accepted definitions are written to your game's shared live catalog through Roblox Open Cloud. Timed sales begin when that write succeeds. Individual and selected failed publications have retry buttons; code export has been removed. Duplicates and permanent item errors are automatically declined with their reason recorded. Credential problems, missing game support, network outages and concurrent catalog writes remain approved and retryable. See `AUTO_PUBLISH.md` for setup and `UPGRADE.md` for this update.

Prices must be whole pNgs from 0 to 50,000. Limited and Limited U stock must be whole quantities from 10 to 500; Non limited stock is unlimited. These limits apply to public submissions, owner-created items, approval edits and new publication definitions.

The owner's Decline dialog has a separate reason field. That reason is delivered to the submitter's private receipt under Your submissions on this device. The public page refreshes statuses every 30 seconds while visible and keeps the latest 100 receipts in the same browser. Automatic duplicate and permanent-error declines also include their safe reason. Private owner review notes are never shared, including historical notes. The site does not collect contact details or send email/direct messages. Migration 0006 adds the separate decline field; follow UPGRADE.md before deploying.

## Existing items and categories

The supplied 2026-10-07 list of 407 items is included in `data/current-items.txt` and `data/current-items.json`, and loaded by the database migrations. All 58 items whose asset ID is 0 are protected by name. Matching ignores letter case, repeated whitespace, Unicode width variations, invisible joiners, and curly apostrophes. Ordinary items also match their Roblox asset ID; body bundle IDs use a separate namespace. Public official items reserve their original Roblox name as well as their chosen catalog name. Pending submissions reserve their names and identities so contributors cannot fill the queue with the same item.

A new reskin may reuse an existing base if it has a new name and replacement texture. Newly submitted reskins are matched by base ID and resolved image ID, so using a decal ID or renaming the same reskin does not bypass the check. The supplied text list does not include legacy reskin texture IDs; those older variants are checked against their listed names and IDs. Additional legacy texture identities can be added as a new database migration when available.

Approval and owner-created entries add to the shared existing-item list in the same database transaction as the review. Failed or concurrent reviews cannot leave an unregistered accepted item. Declining an unaccepted item releases its pending reservation. Declining an item that was previously accepted keeps its existing-item reservation, because it may already have been published into the game. Editing an accepted entry preserves its former name and identity as reserved aliases. The owner dashboard's **Download item list** exports the current non-clothing list, including accepted entries. No repository commit is needed when accepting an item.

The accessory selector includes Hat, Hair, Face, Neck, Left shoulder, Right shoulder, Collar, Front, Back, Waist front, Waist center, Waist back, Torso, Ears, Left foot, and Right foot. Automatic shoulder and waist placement remain available. One Item type selector offers Accessory, Face, Tools, Body package, and Head. Its subtype selector appears immediately below it. Hair uses the Accessory type with the Hair subtype; classic clothing remains available to the owner.

Classic and dynamic heads are sent as ItemType Head with their original asset ID. Dynamic-head bundle links resolve to the actual head asset. Both Headless IDs remain invisible. The 3.5.0 game update gives imported heads the default Smile, removes original face textures and animation controls, uses SmoothPlastic without material overrides, follows the selected head color, and preserves normal in-game face selection.

Announcements now come from the Worker after a confirmed publication, even while the game is empty. The game suppresses those website-managed entries to avoid duplicate posts. Add NEW_ITEM_WEBHOOK_URL as a Worker secret and apply migration 0005 to enable delivery tracking. Follow UPGRADE.md to update the game places and website in order.

## Hosting from GitHub

GitHub Pages hosts the browser files. Shared submissions and private owner reviews also need the included Cloudflare Worker and D1 database. For the easiest setup and the strongest response headers, have Cloudflare serve the whole site from your GitHub repository. You can keep the repository private.

### 1. Add the project to GitHub

Extract this archive and upload the contents of `reminisce-catalog-community` to a new repository. Include `docs`, `src`, `shared`, `server`, `scripts`, `migrations`, and the files at the project root. Do not upload owner keys, secrets, `.dev.vars`, or `node_modules`.

Install Node.js 22.13 or newer, then run in the project folder:

```sh
npm ci
npm run build
npx wrangler login --device --browser=false
npx wrangler d1 create reminisce-catalog
```

For login, open the printed Cloudflare verification URL in your browser and enter its current device code there. Keep the terminal running until it reports a successful login. Do not type the device code into the terminal. If the code expires, run the login command again. This works in Codespaces without a localhost callback.

Copy the returned database ID into `database_id` in `wrangler.jsonc`. Keep the binding named `DB`. Apply the schema:

```sh
npx wrangler d1 migrations apply reminisce-catalog --remote
```

### 2. Create your owner key

Run this privately on your own computer:

```sh
npm run owner-key
```

It prints three values. Keep `OWNER_KEY` for signing into `/review.html`. Enter `ADMIN_KEY_HASH` and `RATE_SECRET` as Worker secrets. The hash is derived from a randomly generated 256-bit key, rather than a human password. Never put `OWNER_KEY` into a configuration file or GitHub.

```sh
npx wrangler secret put ADMIN_KEY_HASH
npx wrangler secret put RATE_SECRET
```

The commands prompt for each value without needing it in the command text. To rotate access later, generate a new key and replace `ADMIN_KEY_HASH`. Existing sessions stop working immediately.

### 3. Configure the verification widget

In Cloudflare's Turnstile dashboard, create a managed widget. Add your site's exact hostname, such as `reminisce-catalog-community.your-account.workers.dev`. For a custom domain, add that hostname too. Put its site key in `TURNSTILE_SITE_KEY` in `wrangler.jsonc` and enter its secret:

```sh
npx wrangler secret put TURNSTILE_SECRET
```

Use real production keys. The server rejects Turnstile testing keys. It checks both the returned hostname and the expected action for submissions and owner sign-in.

### 4. Publish the site

```sh
npm run build
npx wrangler deploy
```

Open the URL Wrangler prints. Share its home page; use `/review.html` for your owner review queue.

To deploy future changes from GitHub, connect the repository to this Worker using Cloudflare's Git integration. Set the root directory to the folder containing `wrangler.jsonc`, use build command `npm ci && npm run build`, and deploy command `npx wrangler deploy`. If you uploaded the complete project folder into your repository, the root directory is `reminisce-catalog-community`. The D1 binding and three secrets must be attached to that Worker. Apply future SQL migrations separately before deploying code that needs them.

## Optional GitHub Pages front end

Deploy the Worker and database first. In `site.config.json`, set `apiUrl` to the Worker origin, for example `https://reminisce-catalog-community.your-account.workers.dev`. Do not add `/api` to this value. Run `npm run build`, commit the rebuilt `docs` directory, and enable GitHub Pages from your branch's `/docs` folder.

Set `PUBLIC_ORIGINS` in `wrangler.jsonc` to the exact GitHub Pages origin, such as `https://yourname.github.io`, without the repository path or trailing slash, and redeploy the Worker. Add `yourname.github.io` to the Turnstile widget's allowed hostnames. Keep the origins specific; no wildcards are accepted. Use a separate Pages origin if other untrusted projects share your GitHub Pages domain.

GitHub Pages cannot apply all the HTTP security headers supplied by the Worker. The generated pages include a content security policy, but serving the complete site through the Worker is recommended. A public GitHub repository also exposes its source. Keeping backend source private requires a private repository; the delivered browser files can always be inspected.

## Using the site

- Official item: select Item type, then search by Roblox name or choose Paste item link for a catalog / bundle link or ID. Choose a result if the name has several matches. Classic and dynamic heads may be made by any Roblox user or group. Accessories, gear, classic faces and body packages must still be made by Roblox's **User account 1**. Selecting Head cannot disguise an asset of another type. For faces, the name and description fill from Roblox and the main ID field becomes Texture ID. Enter a classic face image/texture ID there; dynamic head IDs are rejected. The original Roblox item ID stays attached to the submission for ownership and duplicate verification.
- Custom reskin: choose an official Roblox base, name your variant, and supply the replacement image, texture, or decal asset ID. A readable decal is resolved to its actual image ID. The owner should check that the image is appropriate and accessible to the game. Restricted or private Roblox assets may be unavailable to the lookup service.
- Contributors can propose Non limited, Limited, Limited U, or Event reward, a pNgs price, stock for either Limited type, and an accessory/tool subtype. Checking Timed item reveals a time-on-sale duration and unit. There are no on-sale dates, off-sale dates, advanced placement controls, username requests, or contributor messages. This site does not authenticate Roblox accounts or upload image files to Roblox.
- Each submission receives a private receipt saved on that device. It can check Pending, Approved, or Declined without exposing the review queue. Clearing browser storage removes those receipts. Private review notes stay visible only to you.
- Sign in with your owner key to inspect the queue. Approval rechecks the base and texture, then queues the item for your game. Publishing must be configured before approving through the owner page. Queued and published definitions are locked.
- **Create my own item** uses the same creator rules: heads from any creator, other base types from Roblox. All entries pass field validation and shared duplicate checks.
- A failed, still-approved item has **Retry publish**. Select up to 30 failed items to use **Retry selected publications**. Both keep the original job identity, preventing duplicate writes and avoiding sale-timer resets.
- A duplicate found in the actual game's catalog moves to Declined and remains blocked from resubmission. A permanently invalid, unpublished item moves to Declined and releases its reservation so a corrected submission can be reviewed. The reason stays visible on the owner page. Declining does not remove existing game items.

## Protection and limits

Owner sessions last 30 minutes. Session tokens remain in page memory, are stored hashed on the server, and are invalidated by sign-out, expiry, or key rotation. All owner endpoints check authorization. The Roblox API key stays in Worker secrets and is never returned to the browser. Catalog data is validated and serialized as JSON; submitted text is never executed as code. Code-export routes are unavailable.

Public forms require server-verified Turnstile checks, JSON-only requests, body limits, exact allowed origins, and rate limits. SQL statements use bound values. Daily quotas are stored atomically in D1: 100 submission attempts after verification per IP per UTC day, and 200 site-wide by default. Change `SUBMISSIONS_PER_IP_PER_DAY` and `SUBMISSIONS_PER_DAY` as needed. The edge limit is 60 API requests per minute per IP and 5 sign-in attempts per minute; edge counters are regional, with a database-backed 15 sign-in attempts per hour limit as well. Shared networks also share IP limits. Ordinary Roblox lookups are cached for three minutes; submission and approval checks fetch fresh metadata.

The database stores submissions, the existing-item registry, hashed IP identifiers, hashed receipts, and review history. A scheduled cleanup removes expired sessions, old rate counters, review logs older than 180 days, and declined submissions older than 180 days. Pending and approved entries remain until the owner removes them from the database. Backup and billing settings are managed through your Cloudflare account.

Browser files are minified without comments or source maps. This reduces size and casual copying; it cannot make browser code secret or guarantee immunity to attacks. Keep Cloudflare's managed protection enabled, keep secrets private, and review contributor content before approving it.

## Verification

```sh
npm test
npm run build
npm audit
```

Tests exercise all 407 seed entries, Unicode duplicate names, renamed IDs, reskin identities, simultaneous submissions, registry updates, legacy migrations, new item types, official ownership rules, texture resolution, price and stock bounds, decline feedback, receipt privacy, owner authentication, key rotation, expired sessions, quotas, approval versions, SQL binding, permanent failure declines, registry cleanup, batch retries, conditional publishing and the removed export endpoint. The included browser files use a classic Roblox-inspired blue and white layout with official item thumbnails in search, selected-item previews, and the owner queue. Preview images show the original Roblox model; custom reskins keep the base thumbnail. The included browser files are already built and ready for GitHub Pages after setting their service URL. A package override pins the development tools' Sharp dependency to patched version 0.35.5. Avoid automatic forced audit fixes that downgrade Wrangler.

## October 7 deployment fixes

Run the included `install-catalog-update.mjs` from a separate extracted folder to update an existing installation. It preserves the deployed Worker name, D1 database ID, Turnstile site key, service URL, and existing ignore patterns. It sets the per-network daily submission limit to 100 and disables automatic HTML redirects. The existing global daily limit stays at its configured value (200 by default). Use the existing database and apply migration 0006 before deploying version 3.6.0. Cloudflare secrets and stored submissions are preserved.

Roblox and verification requests use `redirect: "manual"`, which is supported by the installed Cloudflare runtime. JSON lookups follow a bounded number of redirects only on their original HTTPS hostname. The owner document is reachable at `/review.html` and `/review`; `/review/` redirects to `/review.html` so relative asset links keep working.

## Version 3.5

Version 3.5 adds announcements independent of running Roblox servers, a durable delivery queue, safe role mentions, separate announcement retries and the game suppression marker. The game files preserve the latest supplied zombie-face and barricade changes. Imported classic and dynamic heads use Smile with their existing mesh shape and character skin color. Headless remains invisible.

Heads from any Roblox user or group remain accepted. All other base item types retain the Roblox-created restriction. Duplicate protection, immutable publication jobs, timed sales, Limited U stock, individual and selected publication retries, and the 100-per-network daily limit remain in place.

The local checks include the Cloudflare runtime, owner access, conditional catalog writes, announcement queue recovery, rate limits, secret privacy, duplicate suppression, head cleanup and equipment behavior. Live Roblox assets still need a Studio/playtest check after publishing the updated places.

For the head appearance correction on an already updated game, run game-updates/FixHeadAppearance.lua in each place in Studio Edit mode, publish to the same place, and restart older servers. Only HatService is changed; a backup is retained. The updated full installer also includes this correction. No Worker configuration changes are required for the appearance correction.

## Version 3.6

Version 3.6 adds private decline reasons, automatic status refresh, 100 locally saved receipts, price limits of 0–50,000 pNgs and limited stock limits of 10–500. Non limited items publish with unlimited stock. Private owner notes are stored separately from the reason shared with the submitter. Only a matching private receipt can read that feedback. Existing game support, publication retries and announcement delivery are retained.
