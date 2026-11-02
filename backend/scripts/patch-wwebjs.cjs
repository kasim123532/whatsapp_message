#!/usr/bin/env node
/**
 * Backports for whatsapp-web.js 1.34.7 against current WhatsApp Web builds.
 * Each patch is idempotent (no-op once applied or fixed upstream) and the
 * script fails loudly if the code it patches has moved, so a library bump
 * can't silently ship broken media sending / message ids.
 *
 * 1. Upstream 064a3d5 "drop __x_id before spreading mediaOptions into outgoing
 *    Msg". Without it, sending ANY media (photo campaigns) fails with "Data
 *    passed to getter must include an id property ... got undefined":
 *    MediaData's private __x_id gets spread into the outgoing Msg and collides
 *    with Msg's own id. Text sends are unaffected.
 *
 * 2. sendMessage() looks the sent message up with `newMsgKey._serialized`, which
 *    WhatsApp renamed to `$1` (same rename upstream handles in 58ddf15). The
 *    lookup then returns undefined, so sendMessage() resolves with no message
 *    and the delivery log has no WhatsApp message id.
 */
const fs = require("fs");
const path = require("path");

const file = path.join(
  __dirname, "..", "node_modules", "whatsapp-web.js", "src", "util", "Injected", "Utils.js"
);
let src = fs.readFileSync(file, "utf8");
let changed = false;

function patch(name, { alreadyIf, anchor, replacement }) {
  if (src.includes(alreadyIf)) {
    console.log(`[patch-wwebjs] ${name}: already present - nothing to do.`);
    return;
  }
  if (src.split(anchor).length !== 2) {
    console.error(`[patch-wwebjs] ${name}: anchor not found exactly once - whatsapp-web.js changed; re-check the patch.`);
    process.exit(1);
  }
  src = src.replace(anchor, () => replacement);
  changed = true;
  console.log(`[patch-wwebjs] ${name}: applied.`);
}

patch("media __x_id", {
  alreadyIf: "__x_id",
  anchor: "        // Bot's won't reply if canonicalUrl is set (linking)\n        if (botOptions) {",
  replacement:
    "        // MediaData is a model whose private __x_id field collides with Msg's\n" +
    "        // internal id field when its enumerable properties are spread above\n" +
    "        // (backport of upstream 064a3d5; see scripts/patch-wwebjs.cjs).\n" +
    "        if (message.__x_id) {\n" +
    "            delete message.__x_id;\n" +
    "        }\n" +
    "        // Bot's won't reply if canonicalUrl is set (linking)\n        if (botOptions) {"
});

patch("sent message lookup $1", {
  alreadyIf: "newMsgKey._serialized || newMsgKey.$1",
  anchor: ".Msg.get(newMsgKey._serialized);",
  replacement: ".Msg.get(newMsgKey._serialized || newMsgKey.$1);"
});

if (changed) fs.writeFileSync(file, src);
