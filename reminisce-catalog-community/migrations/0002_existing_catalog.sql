ALTER TABLE submissions ADD COLUMN registry_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(registry_json) AND json_type(registry_json)='array');

CREATE TABLE catalog_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  item_type TEXT NOT NULL,
  asset_id INTEGER NOT NULL,
  texture_id INTEGER NOT NULL DEFAULT 0,
  accessory_kind TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK(source IN ('existing','accepted')),
  accepted_at INTEGER NOT NULL DEFAULT 0,
  draft_json TEXT NOT NULL CHECK(json_valid(draft_json))
);
CREATE TABLE catalog_keys (
  key TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE
);
CREATE INDEX catalog_keys_item ON catalog_keys(item_id);
CREATE TABLE pending_keys (
  key TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE
);
CREATE INDEX pending_keys_submission ON pending_keys(submission_id);

UPDATE submissions SET registry_json=json_array(
  'name:'||lower(trim(json_extract(draft_json,'$.name'))),
  CASE WHEN json_extract(draft_json,'$.customTexture')=1 THEN 'reskin:' ELSE '' END ||
  CASE WHEN json_extract(draft_json,'$.itemType')='BodyPackage' THEN 'bundle:' ELSE 'asset:' END ||
  CAST(json_extract(draft_json,'$.assetId') AS INTEGER) ||
  CASE WHEN json_extract(draft_json,'$.customTexture')=1 THEN ':'||CAST(replace(json_extract(draft_json,'$.texture'),'rbxassetid://','') AS INTEGER) ELSE '' END
);
UPDATE submissions SET registry_json=json_insert(registry_json,'$[#]',
  'face-texture:'||CAST(replace(json_extract(draft_json,'$.texture'),'rbxassetid://','') AS INTEGER))
WHERE json_extract(draft_json,'$.itemType')='Face' AND CAST(replace(json_extract(draft_json,'$.texture'),'rbxassetid://','') AS INTEGER)>0;
UPDATE submissions SET registry_json=json_insert(registry_json,'$[#]','name:'||lower(trim(json_extract(base_json,'$.name'))))
WHERE kind='official' AND length(trim(coalesce(json_extract(base_json,'$.name'),'')))>0
  AND lower(trim(json_extract(base_json,'$.name')))<>lower(trim(json_extract(draft_json,'$.name')));

INSERT INTO catalog_items(id,name,item_type,asset_id,texture_id,accessory_kind,source,accepted_at,draft_json)
SELECT id,json_extract(draft_json,'$.name'),json_extract(draft_json,'$.itemType'),CAST(json_extract(draft_json,'$.assetId') AS INTEGER),
  CAST(coalesce(replace(json_extract(draft_json,'$.texture'),'rbxassetid://',''),'0') AS INTEGER),coalesce(json_extract(draft_json,'$.accessoryKind'),''),'accepted',updated_at,draft_json
FROM submissions WHERE status='approved';
INSERT OR IGNORE INTO catalog_keys(key,item_id)
SELECT value,submissions.id FROM submissions,json_each(registry_json) WHERE status='approved';
INSERT OR IGNORE INTO pending_keys(key,submission_id)
SELECT value,submissions.id FROM submissions,json_each(registry_json) WHERE status='pending';

CREATE TRIGGER submissions_check_insert BEFORE INSERT ON submissions
WHEN NEW.status IN ('pending','approved')
BEGIN
  SELECT RAISE(ABORT,'catalog_duplicate') WHERE EXISTS (
    SELECT 1 FROM catalog_keys WHERE key IN (SELECT value FROM json_each(NEW.registry_json)) AND item_id<>NEW.id
    UNION ALL
    SELECT 1 FROM pending_keys WHERE key IN (SELECT value FROM json_each(NEW.registry_json)) AND submission_id<>NEW.id
  );
END;
CREATE TRIGGER submissions_check_update BEFORE UPDATE ON submissions
WHEN NEW.status IN ('pending','approved')
BEGIN
  SELECT RAISE(ABORT,'catalog_duplicate') WHERE EXISTS (
    SELECT 1 FROM catalog_keys WHERE key IN (SELECT value FROM json_each(NEW.registry_json)) AND item_id<>NEW.id
    UNION ALL
    SELECT 1 FROM pending_keys WHERE key IN (SELECT value FROM json_each(NEW.registry_json)) AND submission_id<>NEW.id
  );
END;
CREATE TRIGGER submissions_register_insert AFTER INSERT ON submissions
BEGIN
  INSERT INTO pending_keys(key,submission_id) SELECT value,NEW.id FROM json_each(NEW.registry_json) WHERE NEW.status='pending';
  INSERT INTO catalog_items(id,name,item_type,asset_id,texture_id,accessory_kind,source,accepted_at,draft_json)
  SELECT NEW.id,json_extract(NEW.draft_json,'$.name'),json_extract(NEW.draft_json,'$.itemType'),CAST(json_extract(NEW.draft_json,'$.assetId') AS INTEGER),
    CAST(coalesce(replace(json_extract(NEW.draft_json,'$.texture'),'rbxassetid://',''),'0') AS INTEGER),coalesce(json_extract(NEW.draft_json,'$.accessoryKind'),''),'accepted',NEW.updated_at,NEW.draft_json
  WHERE NEW.status='approved';
  INSERT OR IGNORE INTO catalog_keys(key,item_id) SELECT value,NEW.id FROM json_each(NEW.registry_json) WHERE NEW.status='approved';
END;
CREATE TRIGGER submissions_register_update AFTER UPDATE ON submissions
BEGIN
  DELETE FROM pending_keys WHERE submission_id=NEW.id;
  INSERT INTO pending_keys(key,submission_id) SELECT value,NEW.id FROM json_each(NEW.registry_json) WHERE NEW.status='pending';
  INSERT INTO catalog_items(id,name,item_type,asset_id,texture_id,accessory_kind,source,accepted_at,draft_json)
  SELECT NEW.id,json_extract(NEW.draft_json,'$.name'),json_extract(NEW.draft_json,'$.itemType'),CAST(json_extract(NEW.draft_json,'$.assetId') AS INTEGER),
    CAST(coalesce(replace(json_extract(NEW.draft_json,'$.texture'),'rbxassetid://',''),'0') AS INTEGER),coalesce(json_extract(NEW.draft_json,'$.accessoryKind'),''),'accepted',NEW.updated_at,NEW.draft_json
  WHERE NEW.status='approved'
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,item_type=excluded.item_type,asset_id=excluded.asset_id,texture_id=excluded.texture_id,accessory_kind=excluded.accessory_kind,draft_json=excluded.draft_json;
  INSERT OR IGNORE INTO catalog_keys(key,item_id) SELECT value,NEW.id FROM json_each(NEW.registry_json) WHERE NEW.status='approved';
END;
