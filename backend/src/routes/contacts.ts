import { Router } from "express";
import { prisma } from "../db.js";
import { wsManager } from "../whatsapp.js";

const router = Router();

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
          variables: JSON.parse(c.variables || "{}"),
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
      const createdContacts = [];
      for (const item of contacts) {
        if (!item.phone) continue;
        const cleanPhone = item.phone.replace(/\D/g, "");
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
      if (!phone) {
        return res.status(400).json({ error: "Phone number is required for a single contact" });
      }

      const cleanPhone = phone.replace(/\D/g, "");
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

// DELETE contact
router.delete("/contacts/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.contact.delete({ where: { id } });
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

    // Find any connected whatsapp client
    const accounts = await prisma.account.findMany({ where: { status: "CONNECTED" } });
    if (accounts.length === 0) {
      return res.status(400).json({ error: "No connected WhatsApp accounts found to perform verification" });
    }

    const client = wsManager.getClient(accounts[0].id);
    if (!client) {
      return res.status(400).json({ error: "WhatsApp service for account is not initialized or ready" });
    }

    const cleanPhone = contact.phone.replace(/\D/g, "");
    const registered = await client.isRegisteredUser(`${cleanPhone}@c.us`);

    const status = registered ? "exists" : "not_found";
    
    await prisma.contact.update({
      where: { id },
      data: { whatsappStatus: status }
    });

    res.json({ whatsappStatus: status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
