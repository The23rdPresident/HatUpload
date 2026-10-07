import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

test("feedback migration preserves private old notes and restores only automatic decline reasons", t => {
  const db = new DatabaseSync(":memory:"), migrations = new URL("../migrations/", import.meta.url);
  t.after(() => db.close());
  for (const file of readdirSync(migrations).filter(file => file.endsWith(".sql") && file < "0006_decline_feedback.sql").sort()) db.exec(readFileSync(new URL(file, migrations), "utf8"));
  for (const id of ["manual", "automatic"]) {
    db.prepare("INSERT INTO submissions(id,kind,username,status,draft_json,base_json,owner_note,created_at,updated_at) VALUES(?,'official','Community','declined',?,?,'Private historical note',1,1)").run(id, JSON.stringify({ name: id }), "{}");
  }
  db.prepare("INSERT INTO review_log(submission_id,action,record_version,created_at,session_hash) VALUES('automatic','auto-decline',3,1,'automatic-publisher')").run();
  db.prepare("INSERT INTO publish_jobs(submission_id,job_id,record_version,universe_id,draft_json,base_json,status,error,created_at,updated_at) VALUES('automatic','automatic-job',2,'123456','{}','{}','failed','This item already exists in the game.',1,1)").run();
  db.exec(readFileSync(new URL("0006_decline_feedback.sql", migrations), "utf8"));
  const manual = db.prepare("SELECT owner_note,decline_note FROM submissions WHERE id='manual'").get();
  const automatic = db.prepare("SELECT owner_note,decline_note FROM submissions WHERE id='automatic'").get();
  assert.equal(manual.owner_note, "Private historical note");
  assert.equal(manual.decline_note, "");
  assert.equal(automatic.owner_note, "Private historical note");
  assert.equal(automatic.decline_note, "This item already exists in the game.");
});
