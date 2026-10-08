# Classic face data

`data/classic-faces.json` stores the original face asset, name, description and image texture ID. It contains 656 decal faces and 501 dynamic bundle associations. Ordinary head imports use their existing asset IDs.

Original Decal models and catalog snapshots came from [synpixel/roblox-classic-faces](https://github.com/synpixel/roblox-classic-faces). Texture IDs were extracted from each model's Decal Texture property. Non-decal entries were omitted. Ownership checks against Roblox's original asset metadata excluded entries from other creators. Faces without saved official ownership proof are checked against Roblox when selected. Image asset types are checked during lookup, submission and approval.

Dynamic bundle associations were adapted from [filoxen/rbx-reface](https://github.com/filoxen/rbx-reface). Its MIT license is included in `THIRD_PARTY_LICENSES.txt`. Bundle ownership and asset membership are checked against Roblox's catalog. No third-party scripts or models are executed at runtime.

The Worker uses the bundled index, Roblox metadata and bounded decal content reads. Unlisted classic faces use the original asset version when available. Classic faces by Roblox users and groups are accepted; image asset types are still verified. It never treats a dynamic head's mesh texture as a face image. Ambiguous classic mappings require a specific classic face link. Face reskins can use a separately verified replacement image.

`data/dynamic-heads.json` records the six supplied examples, their source head asset IDs and verified creator identities. O_o maps to classic face 7074595 / image 7046277, Epic Face to 42070576 / 42070872, and I Am Not Amused to 7131886 / 7131857. Angry Diamond, Perfectly Round and Content, and Rectangle retain their custom meshes as Heads. Bundle membership and the head's creator must match Roblox metadata.

For other dynamic heads, the Worker reads the model's mesh ID and any separate front decal. Known default mesh IDs and supported built-in heads are recognized directly. Other supported meshes are decoded and compared with the standard head's proportions and vertical silhouette. The comparison is conservative: names alone do not classify unknown UGC heads, and inaccessible or unsupported geometry stays Head with a visible lookup message.

A standard-shaped head is classified as Face. The resolver looks for an exact original classic face match, a separate front decal, or a classic face by the same creator. If none is available, it asks for a standalone classic image or decal ID in the existing Texture ID field. It does not crop or reuse a full mesh UV texture, and submission cannot proceed with a missing or non-image texture. Heads with a different shape cannot use this fallback to submit as Faces.

Model reads are limited to 64 KiB and mesh reads to 1 MiB. Redirects stay on the approved Roblox content hosts, without API credentials. Binary models have bounded LZ4 decoding and property counts; no scripts are executed. Meshes are limited to 12,000 vertices and compressed meshes to 24,000 triangles. Supported version 7 sequential Draco meshes use the bundled Google Draco 1.5.7 decoder with a 64 MiB memory ceiling. Its Apache 2.0 license is included at `server/vendor/DRACO_LICENSE.txt`. Older supported mesh versions are read directly. Unsupported formats retain the Head classification.
