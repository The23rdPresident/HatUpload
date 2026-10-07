# Connect approvals to your game

This version publishes accepted catalog definitions into the game's existing live catalog using Roblox Open Cloud. It does not upload a new Roblox avatar-shop item or charge Robux. Heads may be made by any Roblox user or group. Other base assets must still be made by Roblox; you decide which entries are accepted.

The browser never receives the Roblox API key. The key stays in a Cloudflare Worker secret. No owner key or Roblox login cookie goes into the game files or GitHub.

## 1. Update the existing game places

Publish the current 3.5.0 game files supplied with this update to their existing Main, GameServer and GameStudio destinations. Restart older servers and join a new server once to register Head support and website-managed announcements. Every place that reads this catalog needs the update. Keep the existing experience; places in a separate experience do not share its catalog.

The localized `game-updates/EnableR6Heads.lua` installer is an alternative for matching current game sources. Run it with playtests stopped in Studio Edit mode. It checks all changes before writing, backs up the three target scripts in ServerStorage, and restores original sources if a write fails. Repeating a successful installation leaves the sources unchanged. A source-version mismatch stops without modifying the game.

Classic and dynamic heads retain their original asset ID and use ItemType Head. Their meshes become static head accessories on R6. Imported face decals, textures and facial animation controls are removed; each head starts with the default Smile, uses SmoothPlastic without a material variant, and follows the character's skin color. A selected game face can still override Smile. Heads use one slot separate from hats and hair. The two Headless IDs use the invisible cosmetic path.

Website publications carry PublisherAnnouncement set to worker. The game skips those entries in its new-item announcer. Older entries and items authored directly in Studio keep their existing game announcement behavior.

## 2. Install the website, migration and announcement secret

Follow `UPGRADE.md` for the ordered installation commands. Apply the pending migrations to your existing D1 database before deploying. Migration 0005 tracks announcements; migration 0006 stores private decline feedback separately from owner review notes. No database reset or new Roblox permissions are required. If the 3.5.0 game and webhook setup is already working, follow only the 3.6.0 website update in UPGRADE.md.

Store the existing new-item webhook URL in the Worker's NEW_ITEM_WEBHOOK_URL secret using the hidden Wrangler prompt. The original URL is in ServerScriptService.Services.LegacyWebhookEndpoints under Reminisce_NewItems. Keep it private. The existing Discord endpoint and webhook.lewisakura.moe proxy formats are supported. NEW_ITEM_PING_ROLE_ID controls the optional role ping.

When Roblox confirms an accepted item is in the catalog, the Worker saves and sends its announcement without needing an online game server. Webhook problems do not decline or republish the item. Failed announcements have a separate Retry announcement action. Cron retries rate limits and service errors. Ambiguous delivery stops and asks the owner to check the channel before retrying. Confirmed deliveries are not sent again. The connection test checks webhook configuration without broadcasting a test message.

## 3. Find the Universe ID

In [Creator Dashboard](https://create.roblox.com/dashboard/creations/experiences), open the existing experience's options and copy its **Universe ID**. This is not the number in a Roblox game link, which is a Place ID.

You can also open the existing published place in Studio and run this in its command bar:

```lua
print(game.GameId)
```

A result of `0` means the local file has not been associated with the published experience yet. Select the existing destination first.

Back in your Codespace project folder, run:

```sh
npm run connect-game
```

Enter the Universe ID when prompted. This command backs up your Worker configuration, sets the target experience, enables automatic publishing, and adds the retry schedule. It never requests an API key.

## 4. Create a Roblox Open Cloud key

Open [Creator Dashboard → API Keys](https://create.roblox.com/dashboard/credentials). Create a separate key named `Reminisce Item Uploader`. Restrict its experience access to the same Universe ID.

Grant only these permissions:

| API system | Operations | Restriction |
| --- | --- | --- |
| Data Stores | Read entry, create entry, update entry | Only `ReminisceLiveCatalog_v1` in this experience |
| Messaging Service | Publish | Only this experience |

The Data Store scopes are `universe-datastores.objects:read`, `universe-datastores.objects:create`, and `universe-datastores.objects:update`. Messaging uses `universe-messaging-service:publish`. Delete entries, player-data stores, and place-publishing permissions are not required.

Cloudflare Workers do not use your Codespace's outbound IP. Leave **Restrict IP addresses** off for this direct Worker connection unless you have configured a fixed outbound proxy. Keep the experience and data-store restrictions above.

Copy the generated key privately, then run:

```sh
npx wrangler secret put ROBLOX_API_KEY
```

Paste the key only into Wrangler's secret prompt. Do not paste it into chat, a source file, `wrangler.jsonc`, or GitHub. Keep your existing owner key, `ADMIN_KEY_HASH`, `RATE_SECRET`, and Turnstile secret.

## 5. Deploy and test

```sh
npm run build &&
npx wrangler deploy
```

Open your owner page:

[Reminisce owner review](https://reminisce-catalog-community.reminiscehatimport.workers.dev/review.html)

Sign in with your existing owner key and click **Test game connection**. The test checks the installed key through Roblox key introspection and reads the game's registration and catalog; it does not publish an item. The target game name is public information and is displayed even when the key cannot read the catalog. Only **Catalog read access verified** confirms that the catalog read succeeded. Introspection shows the key's declared scopes and target restrictions; the first successful publication confirms actual write access.

Approve a new item using **Approve & publish**. The selected item refreshes while queued or publishing, and Refresh also checks its latest status. A published entry is saved in the game's catalog even if no player is currently online. Running servers are notified immediately when messaging works; the existing minute polling is the fallback. Players may need to reopen their catalog view. Servers can retry slower during a Roblox outage.

Temporary failures retain their approved item and registry reservation. Outages, rejected credentials, missing Head support and concurrent writes retry with increasing delays, up to eight attempts. A crashed delivery resumes after its lease expires. **Retry publish** retries the same job after you fix the problem. The Approved queue lets you select up to 30 failed deliveries and use **Retry selected publications**.

A duplicate in the authored or live game catalog, a retired published name, an invalid saved definition, or a definitive HTTP 400/422 catalog-write rejection automatically moves the item to Declined. Its reason is recorded and automatic retries stop. Existing game identities remain blocked from resubmission; an invalid item that was never published releases its reservation for a corrected submission. Credentials, outages and shared-catalog format problems do not cause automatic declines. A response lost after a successful write is resolved through the original job ID rather than publishing a duplicate.

Items approved before automatic publishing was enabled are not published in bulk. Choose one and click **Publish to game**. Existing game duplicates are declined rather than appearing twice.

Once queued, an item's definition is locked. Code generation and copying have been removed. Declining does not remove a live item or refund purchases; use your existing live-catalog removal workflow for deliberate removals.

## Disable automatic publishing

Set `ROBLOX_AUTO_PUBLISH` to `"false"` in `wrangler.jsonc`, then deploy. Approval controls on the owner page are disabled until publishing is enabled again. Existing queued jobs pause and retain their original target experience. Do not change the Universe ID to move queued jobs to another game.

## Checks included

The delivery tests cover atomic approval and queue insertion, owner authentication, same-origin writes, duplicates from the actual game's definitions and live catalog, conditional writes during concurrent updates, metadata preservation, retries after a response is lost after commit, stable sale timers, crashed-worker recovery, messaging fallback, older approvals, and configuration errors.

The Head installer was checked against the three supplied game versions. All nine resulting scripts compile, and local behavior checks cover static meshes, classic faces, body color, visibility restoration, backups, repeated installation, preflight rejection and rollback. Test one Head in your published game after installation; local checks do not confirm rendering against your live Roblox assets.

References: [Open Cloud data stores](https://create.roblox.com/docs/cloud/guides/data-stores), [Messaging Service](https://create.roblox.com/docs/cloud/guides/usage-messaging), [API key management](https://create.roblox.com/docs/cloud/auth/api-keys).

## Connection details

Test game connection shows the experience name, creator, Universe ID, main place, uploader version, catalog revision, item counts and registered place. Public game metadata is optional; a metadata outage does not invalidate a successful catalog read. The Head installer adds the place build version to new registrations. Older registrations may not report it. The catalog revision and publisher protocol are separate from the Roblox place build version.

Places within one experience share the catalog. Every place must have the updated catalog scripts, and existing servers running old scripts need to be restarted. Notifications trigger refreshes and the polling fallback runs every 60 seconds, subject to Roblox availability and budgets. Separate experiences do not share this catalog. The connection test reads data only: it does not prove write permissions or that every place is running the updated scripts. The shared registration identifies one registering place and is not a live heartbeat. Key introspection checks the stored key from the Worker's own network, without sending it to the browser. A temporary introspection outage does not invalidate a successful catalog read. Unknown target formats are shown as unverified rather than assumed to be allowed.

## Replace a regenerated key and retry an accepted item

Regenerating a key in Roblox does not replace the Cloudflare secret. Revoke any key shared in chat, generate a private replacement, and keep the same experience and required scopes.

In the deployed project folder run:

```sh
cd /workspaces/HatUpload/reminisce-catalog-community
npx wrangler secret put ROBLOX_API_KEY
```

Paste the replacement into the hidden prompt and press Enter. `ROBLOX_API_KEY` is the literal secret name; do not put the actual key after `secret put`. Copy only the complete key, with no surrounding quotes or parentheses. Then run:

```sh
npx wrangler deploy
```

Refresh `/review.html`, sign in and click **Test game connection**. The table separates public target information from authenticated catalog access and shows read/create/update/messaging scope checks when Roblox introspection is available.

- **HTTP 401:** Roblox rejected the stored credential. Replace the correct Worker secret and check the key is enabled and unexpired.
- **HTTP 403 on a read:** Roblox denied access to `ReminisceLiveCatalog_v1` in the configured experience. Check that the stored key has `universe-datastores.objects:read` for that exact target, that the key owner has the required group/experience access, and that IP restrictions permit the Worker. A high group rank alone does not prove access.
- **HTTP 403 on a write:** The error names `catalog` and `universe-datastores.objects:update`. Check the key's write scopes and target restrictions.
- **Missing for this target:** The installed key's declared scope or restriction does not match this experience/store, even if another key's dashboard looks correct.

After fixing access, select the already accepted item under **Approved** and click **Retry publish**. Its saved publication identity is reused; do not submit or approve another copy. A rejected request cannot be resolved by changing the website's game name or by regenerating a key without updating the secret.
