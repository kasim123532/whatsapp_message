#!/usr/bin/env node
/**
 * Backport of upstream whatsapp-web.js commit 064a3d5
 * "fix(media): drop __x_id before spreading mediaOptions into outgoing Msg".
 *
 * Without it, sending ANY media (photo campaigns) fails on current WhatsApp Web
 * builds with "Data passed to getter must include an id property ... got
 * undefined": MediaData's private __x_id gets spread into the outgoing Msg and
 * collides with Msg's own id. Text sends are unaffected. The fix is not in the
 * 1.34.7 release yet.
 *
 * Idempotent: a no-op once the library already contains the fix (e.g. after an
 * upgrade). Fails loudly if the code it patches has moved, so a library bump
 * can't silently ship broken media sending.
 */
const fs = require("fs");
const path = require("path");

const file = path.join(
  __dirname, "..", "node_modules", "whatsapp-web.js", "src", "util", "Injected", "Utils.js"
);
const src = fs.readFileSync(file, "utf8");

if (src.includes("__x_id")) {
  console.log("[patch-wwebjs] already contains the __x_id fix - nothing to do.");
  process.exit(0);
}

const anchor = "        // Bot's won't reply if canonicalUrl is set (linking)\n        if (botOptions) {";
if (src.split(anchor).length !== 2) {
  console.error("[patch-wwebjs] anchor not found exactly once - whatsapp-web.js changed; re-check the patch.");
  process.exit(1);
}

const fix =
  "        // MediaData is a model whose private __x_id field collides with Msg's\n" +
  "        // internal id field when its enumerable properties are spread above\n" +
  "        // (backport of upstream 064a3d5; see scripts/patch-wwebjs.cjs).\n" +
  "        if (message.__x_id) {\n" +
  "            delete message.__x_id;\n" +
  "        }\n";

fs.writeFileSync(file, src.replace(anchor, fix + anchor));
console.log("[patch-wwebjs] applied __x_id fix to whatsapp-web.js.");
