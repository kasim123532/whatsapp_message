import { Router } from "express";
import { prisma } from "../db.js";
import { wsManager } from "../whatsapp.js";

const router = Router();

const CHECK_TIMEOUT_MS = 15000;
const SPLIT_SUFFIX = " — без WA";
/** DoS caps for unbounded array/object inputs. */
const MAX_BULK_IDS = 500;
const MAX_BULK_IMPORT = 2000;
const MAX_BULK_LINES = 2000;

/** E.164 range: national numbers are 7–15 digits. Returns null when invalid. */
function cleanPhoneNumber(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

function parseVarsObject(raw: unknown): Record<string, string> {
  if (typeof raw === "object" && raw !== null) return raw as Record<string, string>;
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function parseVarsArray(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).then(
    (v) => {
      clearTimeout(timer);
      return v as T;
    },
    (e) => {
      clearTimeout(timer);
      throw e;
    }
  );
}

// DB rows can say CONNECTED while the browser process is gone (restart,
// crash). The first live client wins instead of blindly taking accounts[0].
async function getLiveClient() {
  const accounts = await prisma.account.findMany({ where: { status: "CONNECTED" } });
  for (const acc of accounts) {
    const client = wsManager.getClient(acc.id);
    if (client) return client;
  }
  return null;
}

// GET all groups, subgroups, and contacts
router.get("/groups", async (req, res) => {
  try {
    const groups = await prisma.contactGroup.findMany({
      include: {
        subGroups: {
          include: {
            contacts: true
          }
        }
      }
    });

    // Map database models to match the front-end interface structure
    const mappedGroups = groups.map((g) => ({
      id: g.id,
      name: g.name,
      expanded: true,
      subGroups: g.subGroups.map((sg) => ({
        id: sg.id,
        name: sg.name,
        contacts: sg.contacts.map((c) => ({
          id: c.id,
          name: c.name || "",
          phone: c.phone,
          // One corrupt variables cell must not kill the whole listing.
          variables: parseVarsObject(c.variables),
          whatsappStatus: c.whatsappStatus
        }))
      }))
    }));

    res.json(mappedGroups);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create contact group
router.post("/groups", async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Group name is required" });
  }

  try {
    const group = await prisma.contactGroup.create({
      data: { name }
    });
    res.status(201).json(group);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE contact group
router.delete("/groups/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.contactGroup.delete({ where: { id } });
    res.json({ message: "Group deleted successfully" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create subgroup
router.post("/subgroups", async (req, res) => {
  const { groupId, name } = req.body;
  if (!groupId || !name) {
    return res.status(400).json({ error: "groupId and subgroup name are required" });
  }

  try {
    const subGroup = await prisma.subGroup.create({
      data: {
        name,
        groupId
      }
    });
    res.status(201).json(subGroup);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE subgroup
router.delete("/subgroups/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.subGroup.delete({ where: { id } });
    res.json({ message: "Subgroup deleted successfully" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create/import contacts
router.post("/contacts", async (req, res) => {
  const { subGroupId, name, phone, variables, contacts } = req.body;
  if (!subGroupId) {
    return res.status(400).json({ error: "subGroupId is required" });
  }

  try {
    // Check if subgroup exists
    const subGroup = await prisma.subGroup.findUnique({ where: { id: subGroupId } });
    if (!subGroup) {
      return res.status(404).json({ error: "Subgroup not found" });
    }

    if (contacts && Array.isArray(contacts)) {
      // Bulk Import
      if (contacts.length > MAX_BULK_IMPORT) {
        return res.status(400).json({ error: `Too many contacts at once (max ${MAX_BULK_IMPORT})` });
      }
      const createdContacts = [];
      for (const item of contacts) {
        if (!item || typeof item.phone === "undefined") continue;
        const cleanPhone = cleanPhoneNumber(item.phone);
        if (!cleanPhone) continue;
        const newContact = await prisma.contact.create({
          data: {
            name: item.name || "",
            phone: cleanPhone,
            variables: typeof item.variables === "object" ? JSON.stringify(item.variables) : JSON.stringify({}),
            whatsappStatus: "unknown",
            subGroupId
          }
        });
        createdContacts.push(newContact);
      }
      return res.status(201).json({ count: createdContacts.length });
    } else {
      // Single contact creation
      const cleanPhone = cleanPhoneNumber(phone);
      if (!cleanPhone) {
        return res.status(400).json({ error: "A valid phone number is required (7–15 digits)" });
      }

      const contact = await prisma.contact.create({
        data: {
          name: name || "",
          phone: cleanPhone,
          variables: typeof variables === "object" ? JSON.stringify(variables) : variables || "{}",
          whatsappStatus: "unknown",
          subGroupId
        }
      });
      return res.status(201).json(contact);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST bulk delete contacts
router.post("/contacts/bulk-delete", async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids array is required" });
  }
  if (ids.length > MAX_BULK_IDS) {
    return res.status(400).json({ error: `Too many ids at once (max ${MAX_BULK_IDS})` });
  }
  try {
    const cleanIds = [...new Set(ids.filter((id: any) => typeof id === "string"))];
    if (cleanIds.length === 0) {
      return res.status(400).json({ error: "ids array is required" });
    }
    // Delete campaign links first so deleteMany works even without DB-level cascade
    const linked = await prisma.campaignRecipient.findMany({
      where: { contactId: { in: cleanIds } },
      select: { campaignId: true }
    });
    await prisma.campaignRecipient.deleteMany({ where: { contactId: { in: cleanIds } } });
    const result = await prisma.contact.deleteMany({ where: { id: { in: cleanIds } } });
    // Удаление контакта меняет состав кампаний — сверяем их счётчики с реальностью
    const affected = [...new Set(linked.map((l) => l.campaignId))];
    for (const campaignId of affected) {
      const counts = await prisma.campaignRecipient.groupBy({
        by: ["status"],
        where: { campaignId },
        _count: true
      });
      let sent = 0;
      let failed = 0;
      let pending = 0;
      for (const g of counts) {
        if (g.status === "SENT") sent += g._count;
        else if (g.status === "FAILED") failed += g._count;
        else pending += g._count;
      }
      await prisma.campaign.update({ where: { id: campaignId }, data: { sent, failed, pending } }).catch(() => undefined);
    }
    res.json({ count: result.count });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST bulk move contacts to another subgroup
router.post("/contacts/bulk-move", async (req, res) => {
  const { ids, targetSubGroupId } = req.body;
  if (!Array.isArray(ids) || ids.length === 0 || !targetSubGroupId) {
    return res.status(400).json({ error: "ids and targetSubGroupId are required" });
  }
  if (ids.length > MAX_BULK_IDS) {
    return res.status(400).json({ error: `Too many ids at once (max ${MAX_BULK_IDS})` });
  }
  try {
    const target = await prisma.subGroup.findUnique({ where: { id: targetSubGroupId } });
    if (!target) {
      return res.status(404).json({ error: "Target subgroup not found" });
    }
    const cleanIds = [...new Set(ids.filter((id: any) => typeof id === "string"))];
    const result = await prisma.contact.updateMany({
      where: { id: { in: cleanIds } },
      data: { subGroupId: targetSubGroupId }
    });
    res.json({ count: result.count });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE contact
router.delete("/contacts/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const linked = await prisma.campaignRecipient.findMany({
      where: { contactId: id },
      select: { campaignId: true }
    });
    await prisma.campaignRecipient.deleteMany({ where: { contactId: id } });
    await prisma.contact.delete({ where: { id } });
    const affected = [...new Set(linked.map((l) => l.campaignId))];
    for (const campaignId of affected) {
      const counts = await prisma.campaignRecipient.groupBy({
        by: ["status"],
        where: { campaignId },
        _count: true
      });
      let sent = 0;
      let failed = 0;
      let pending = 0;
      for (const g of counts) {
        if (g.status === "SENT") sent += g._count;
        else if (g.status === "FAILED") failed += g._count;
        else pending += g._count;
      }
      await prisma.campaign.update({ where: { id: campaignId }, data: { sent, failed, pending } }).catch(() => undefined);
    }
    res.json({ message: "Contact deleted successfully" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST check WhatsApp presence of a contact
router.post("/contacts/:id/check-whatsapp", async (req, res) => {
  const { id } = req.params;
  try {
    const contact = await prisma.contact.findUnique({ where: { id } });
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }

    const client = await getLiveClient();
    if (!client) {
      return res.status(400).json({ error: "No connected WhatsApp accounts found to perform verification" });
    }

    const cleanPhone = contact.phone.replace(/\D/g, "");
    if (!cleanPhone) {
      return res.status(400).json({ error: "Contact has no valid phone number" });
    }
    const registered = await withTimeout(
      client.isRegisteredUser(`${cleanPhone}@c.us`),
      CHECK_TIMEOUT_MS,
      "WhatsApp verification timed out"
    );

    const status = registered ? "exists" : "not_found";

    await prisma.contact.update({
      where: { id },
      data: { whatsappStatus: status }
    });

    res.json({ whatsappStatus: status });
  } catch (err: any) {
    console.error(`[contacts] check-whatsapp failed:`, err?.message ?? err);
    res.status(500).json({ error: "WhatsApp verification failed, try again" });
  }
});

// POST split a subgroup by WhatsApp presence:
// - a normal subgroup moves its `not_found` contacts into a sibling
//   "<name> — без WA" subgroup (created on first use, reused afterwards);
// - a "— без WA" subgroup moves its `exists` contacts back into the base
//   "<name>" subgroup, so re-checking either side restores the invariant
//   "original holds only WA contacts".
// Body: { ids?: string[] } restricts the split to the given contacts
// (e.g. the ones just verified); omitted means all contacts of the subgroup.
router.post("/subgroups/:id/split-non-whatsapp", async (req, res) => {
  const { id } = req.params;
  const { ids } = req.body ?? {};
  try {
    const sub = await prisma.subGroup.findUnique({
      where: { id },
      include: { contacts: { select: { id: true, whatsappStatus: true } } }
    });
    if (!sub) {
      return res.status(404).json({ error: "Subgroup not found" });
    }

    const isNoWaPile = sub.name.endsWith(SPLIT_SUFFIX);
    const wantedStatus = isNoWaPile ? "exists" : "not_found";
    let candidates = sub.contacts.filter((c) => c.whatsappStatus === wantedStatus);
    if (Array.isArray(ids) && ids.length > 0) {
      const only = new Set(ids.filter((v: any) => typeof v === "string"));
      candidates = candidates.filter((c) => only.has(c.id));
    }
    if (candidates.length === 0) {
      return res.json({ moved: 0, targetSubGroupId: null, targetSubGroupName: null });
    }

    const targetName = isNoWaPile
      ? sub.name.slice(0, -SPLIT_SUFFIX.length).trim() || sub.name
      : `${sub.name}${SPLIT_SUFFIX}`;

    let target = await prisma.subGroup.findFirst({
      where: { groupId: sub.groupId, name: targetName }
    });
    if (!target) {
      target = await prisma.subGroup.create({
        data: { name: targetName, groupId: sub.groupId }
      });
    }
    if (target.id === sub.id) {
      return res.json({ moved: 0, targetSubGroupId: target.id, targetSubGroupName: target.name });
    }

    const result = await prisma.contact.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { subGroupId: target.id }
    });

    res.json({
      moved: result.count,
      targetSubGroupId: target.id,
      targetSubGroupName: target.name,
      direction: isNoWaPile ? "has-wa" : "non-wa"
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
