# Reminisce Community Catalog

Share the submission page with your community. Contributors suggest official Roblox accessories, gear, classic faces, classic heads, body packages, or custom accessory and face reskins. You review each submission at `/review.html`, edit its settings, approve or decline it, and generate your LiveCatalogPublisher code from approved entries.

Generated code uses your game's `Texture`, `AccessoryKind`, stock, reward, and sale scheduling fields. Sale durations start when the code is run. The publisher checks the game's current definitions and live catalog before writing; a duplicate stops the complete batch. The site itself does not publish anything into Roblox. Existing installations should follow `UPGRADE.md` before deployment.

## Existing items and categories

The supplied 2026-10-07 list of 407 items is included in `data/current-items.txt` and `data/current-items.json`, and loaded by the database migrations. All 58 items whose asset ID is 0 are protected by name. Matching ignores letter case, repeated whitespace, Unicode width variations, invisible joiners, and curly apostrophes. Ordinary items also match their Roblox asset ID; body bundle IDs use a separate namespace. Public official items reserve their original Roblox name as well as their chosen catalog name. Pending submissions reserve their names and identities so contributors cannot fill the queue with the same item.

A new reskin may reuse an existing base if it has a new name and replacement texture. Newly submitted reskins are matched by base ID and resolved image ID, so using a decal ID or renaming the same reskin does not bypass the check. The supplied text list does not include legacy reskin texture IDs; those older variants are checked against their listed names and IDs. Additional legacy texture identities can be added as a new database migration when available.

Approval and owner-created entries add to the shared existing-item list in the same database transaction as the review. Failed or concurrent reviews cannot leave an unregistered accepted item. Declining an unaccepted item releases its pending reservation. Declining an item that was previously accepted keeps its existing-item reservation, because it may already have been published into the game. Editing an accepted entry preserves its former name and identity as reserved aliases. The owner dashboard's **Download item list** exports the current non-clothing list, including accepted entries. No repository commit is needed when accepting an item.

The accessory selector includes Hat, Hair, Face, Neck, Left shoulder, Right shoulder, Collar, Front, Back, Waist front, Waist center, Waist back, Torso, Ears, Left foot, and Right foot. Automatic shoulder and waist placement remain available. Item types additionally include Tool / gear, Body package, Head, and Classic face; classic clothing remains available to the owner.

The available game reference supports the broad `AccessoryKind` values, but its normalizer does not retain detailed placement metadata or accept `ItemType = "Head"`. The site exports detailed categories as `AccessoryCategory`, specific attachments as `AccessoryAttachment`, and shoulder side as `ShoulderSide`, while retaining the broad compatible `AccessoryKind`. Your game's definition normalizer, catalog filters, and equipment code must support these fields and `Head` for the new detail choices to take effect in game. This website update does not modify your Roblox place files. Public Head lookup accepts classic head assets; dynamic heads and other unsupported asset classes remain excluded.

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

- Official item: choose a search category and search by Roblox name, catalog / bundle link, or ID. Choose a result if the name has several matches. The item must be a supported accessory, gear, classic face, classic head, or body package created by Roblox's **User account 1**; Group 1 and other creators are rejected by the server. Classic face image IDs are resolved automatically.
- Custom reskin: choose an official Roblox base, name your variant, and supply the replacement image, texture, or decal asset ID. A readable decal is resolved to its actual image ID. The owner should check that the image is appropriate and accessible to the game. Restricted or private Roblox assets may be unavailable to the lookup service.
- Contributors can propose a catalog type, pNgs price, numbered stock, sale dates or duration, accessory category, placement, and rainbow effect. Their usernames are self-reported. This site does not authenticate Roblox accounts or upload image files to Roblox.
- Each submission receives a private receipt saved on that device. It can check Pending, Approved, or Declined without exposing the review queue. Clearing browser storage removes those receipts. Private review notes stay visible only to you.
- Sign in with your owner key to inspect the queue. Approval rechecks the base and texture. Approving an item selects it for export. Select more approved items, then use **Generate selected code** to copy the full publisher or just its `ITEMS` table. Pending and declined items cannot be exported, even through direct API requests.
- **Create my own item** retains the owner's form for hats, hair, faces, gear, clothing, body packages, and heads. Owner-created entries are not subject to the public official-base rule. They still pass the website's field validation and shared duplicate checks.
- Accepted entries can be edited in the owner queue. Newly submitted or created entries cannot replace an existing item. Exported batches reject duplicate names, including differences in capitalization or Unicode width.

## Protection and limits

Owner sessions last 30 minutes. Session tokens remain in page memory, are stored hashed on the server, and are invalidated by sign-out, expiry, or key rotation. All owner endpoints check authorization. The publisher template is server-side and never shipped in public assets. Input values are validated and escaped for Lua; generated code is never executed by the website.

Public forms require server-verified Turnstile checks, JSON-only requests, body limits, exact allowed origins, and rate limits. SQL statements use bound values. Daily quotas are stored atomically in D1: 100 submission attempts after verification per IP per UTC day, and 200 site-wide by default. Change `SUBMISSIONS_PER_IP_PER_DAY` and `SUBMISSIONS_PER_DAY` as needed. The edge limit is 60 API requests per minute per IP and 5 sign-in attempts per minute; edge counters are regional, with a database-backed 15 sign-in attempts per hour limit as well. Shared networks also share IP limits. Ordinary Roblox lookups are cached for three minutes; submission and approval checks fetch fresh metadata.

The database stores submissions, the existing-item registry, hashed IP identifiers, hashed receipts, and review history. A scheduled cleanup removes expired sessions, old rate counters, review logs older than 180 days, and declined submissions older than 180 days. Pending and approved entries remain until the owner removes them from the database. Backup and billing settings are managed through your Cloudflare account.

Browser files are minified without comments or source maps. This reduces size and casual copying; it cannot make browser code secret or guarantee immunity to attacks. Keep Cloudflare's managed protection enabled, keep secrets private, and review contributor content before approving it.

## Verification

```sh
npm test
npm run build
npm audit
```

Tests exercise all 407 seed entries, Unicode duplicate names, renamed IDs, reskin identities, simultaneous submissions, registry updates, legacy migrations, new item types, official ownership rules, texture resolution, receipt privacy, owner authentication, key rotation, expired sessions, quotas, approval versions, SQL binding, Lua escaping, and the approved-only export boundary. The included browser files use a classic Roblox-inspired blue and white layout with official item thumbnails in search, selected-item previews, and the owner queue. Preview images show the original Roblox model; custom reskins keep the base thumbnail. The included browser files are already built and ready for GitHub Pages after setting their service URL. A package override pins the development tools' Sharp dependency to patched version 0.35.5. Avoid automatic forced audit fixes that downgrade Wrangler.

## October 7 deployment fix

Run the included `install-catalog-update.mjs` from a separate extracted folder to update an existing installation. It preserves the deployed Worker name, D1 database ID, Turnstile site key, service URL, and existing ignore patterns. It sets the per-network daily submission limit to 100 and disables automatic HTML redirects. The existing global daily limit stays at its configured value (200 by default). No new database or schema migration is required for this update. Cloudflare secrets and stored submissions are unchanged.

Roblox and verification requests use `redirect: "manual"`, which is supported by the installed Cloudflare runtime. JSON lookups follow a bounded number of redirects only on their original HTTPS hostname. The owner document is reachable at `/review.html` and `/review`; `/review/` redirects to `/review.html` so relative asset links keep working.
