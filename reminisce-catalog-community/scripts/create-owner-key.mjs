import { randomBytes, createHash } from "node:crypto";

const key = randomBytes(32).toString("base64url");

console.log("OWNER_KEY=" + key);

console.log("ADMIN_KEY_HASH=" + createHash("sha256").update(key).digest("hex"));

console.log("RATE_SECRET=" + randomBytes(32).toString("base64url"));
