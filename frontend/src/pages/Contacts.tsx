import { useEffect, useMemo, useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus, Search, Trash2, Users, Phone, FolderPlus, ChevronRight, ChevronDown,
  Import, CheckCircle2, XCircle, Loader2, FolderOpen, UserPlus,
  ChevronLeft, ArrowRightLeft, Download, X
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import { toast } from "sonner";
import { Contact, ContactGroup } from "@/types";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

const Contacts = () => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedSubGroup, setSelectedSubGroup] = useState<{ groupId: string; subGroupId: string } | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Dialog states
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [subGroupDialogOpen, setSubGroupDialogOpen] = useState(false);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const [newGroupName, setNewGroupName] = useState("");
  const [newSubGroupName, setNewSubGroupName] = useState("");
  const [targetGroupId, setTargetGroupId] = useState("");
  const [newContact, setNewContact] = useState({ name: "", phone: "", variables: "" });
  const [importText, setImportText] = useState("");

  // Selection + pagination
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [moveTargetGroupId, setMoveTargetGroupId] = useState("");
  const [moveTargetSubGroupId, setMoveTargetSubGroupId] = useState("");

  // Queries
  const { data: groups = [], isLoading } = useQuery<ContactGroup[]>({
    queryKey: ["contactGroups"],
    queryFn: () => apiRequest("/contacts/groups")
  });

  // Mutations
  const createGroupMutation = useMutation({
    mutationFn: (name: string) => apiRequest("/contacts/groups", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contactGroups"] });
      setGroupDialogOpen(false);
      setNewGroupName("");
      toast.success("Группа создана");
    },
    onError: (err: any) => toast.error(err.message)
  });

  const deleteGroupMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/contacts/groups/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["contactGroups"] });
      if (selectedSubGroup?.groupId === id) setSelectedSubGroup(null);
      toast.success("Группа удалена");
    },
    onError: (err: any) => toast.error(err.message)
  });

  const createSubGroupMutation = useMutation({
    mutationFn: (data: { groupId: string; name: string }) =>
      apiRequest("/contacts/subgroups", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contactGroups"] });
      setSubGroupDialogOpen(false);
      setNewSubGroupName("");
      toast.success("Подгруппа создана");
    },
    onError: (err: any) => toast.error(err.message)
  });

  const deleteSubGroupMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/contacts/subgroups/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["contactGroups"] });
      if (selectedSubGroup?.subGroupId === id) setSelectedSubGroup(null);
      toast.success("Подгруппа удалена");
    },
    onError: (err: any) => toast.error(err.message)
  });

  const createContactsMutation = useMutation({
    mutationFn: (data: { subGroupId: string; name?: string; phone?: string; variables?: Record<string, string>; contacts?: any[] }) =>
      apiRequest("/contacts/contacts", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contactGroups"] });
      setContactDialogOpen(false);
      setImportDialogOpen(false);
      setNewContact({ name: "", phone: "", variables: "" });
      setImportText("");
      toast.success("Контакты добавлены");
    },
    onError: (err: any) => toast.error(err.message)
  });

  const deleteContactMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/contacts/contacts/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["contactGroups"] });
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast.success("Контакт удален");
    },
    onError: (err: any) => toast.error(err.message)
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      apiRequest("/contacts/contacts/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) }),
    onSuccess: (data: { count: number }) => {
      queryClient.invalidateQueries({ queryKey: ["contactGroups"] });
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
      toast.success(data.count === 1 ? "Контакт удален" : `Удалено контактов: ${data.count}`);
    },
    onError: (err: any) => toast.error(err.message)
  });

  const bulkMoveMutation = useMutation({
    mutationFn: (data: { ids: string[]; targetSubGroupId: string }) =>
      apiRequest("/contacts/contacts/bulk-move", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: (data: { count: number }, variables) => {
      queryClient.invalidateQueries({ queryKey: ["contactGroups"] });
      setSelectedIds(new Set());
      setMoveDialogOpen(false);
      // If contacts were moved out of the current view, keep the user on a valid page
      setPage(1);
      if (variables.targetSubGroupId !== selectedSubGroup?.subGroupId) {
        const targetGroup = groups.find((g) => g.subGroups.some((sg) => sg.id === variables.targetSubGroupId));
        if (targetGroup) {
          setSelectedSubGroup({ groupId: targetGroup.id, subGroupId: variables.targetSubGroupId });
        }
      }
      toast.success(`Перемещено контактов: ${data.count}`);
    },
    onError: (err: any) => toast.error(err.message)
  });

  const checkWhatsAppMutation = useMutation({
    mutationFn: (contactId: string) =>
      apiRequest(`/contacts/contacts/${contactId}/check-whatsapp`, { method: "POST" }),
    onMutate: (contactId) => {
      // Set status to checking instantly in client-side state cache
      queryClient.setQueryData<ContactGroup[]>(["contactGroups"], (old) => {
        if (!old) return old;
        return old.map((g) => ({
          ...g,
          subGroups: g.subGroups.map((sg) => ({
            ...sg,
            contacts: sg.contacts.map((c) =>
              c.id === contactId ? { ...c, whatsappStatus: "checking" } : c
            )
          }))
        }));
      });
    },
    onSuccess: (data, contactId) => {
      queryClient.setQueryData<ContactGroup[]>(["contactGroups"], (old) => {
        if (!old) return old;
        return old.map((g) => ({
          ...g,
          subGroups: g.subGroups.map((sg) => ({
            ...sg,
            contacts: sg.contacts.map((c) =>
              c.id === contactId ? { ...c, whatsappStatus: data.whatsappStatus } : c
            )
          }))
        }));
      });
      toast(data.whatsappStatus === "exists" ? "WhatsApp аккаунт найден" : "WhatsApp аккаунт не найден", {
        icon: data.whatsappStatus === "exists" ? "✅" : "❌"
      });
    },
    onError: (err: any, contactId) => {
      // Reset back to unknown
      queryClient.setQueryData<ContactGroup[]>(["contactGroups"], (old) => {
        if (!old) return old;
        return old.map((g) => ({
          ...g,
          subGroups: g.subGroups.map((sg) => ({
            ...sg,
            contacts: sg.contacts.map((c) =>
              c.id === contactId ? { ...c, whatsappStatus: "unknown" } : c
            )
          }))
        }));
      });
      toast.error(err.message || "Ошибка верификации");
    }
  });

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId]
    }));
  };

  const handleAddGroup = () => {
    if (!newGroupName.trim()) {
      toast.error("Введите название группы");
      return;
    }
    createGroupMutation.mutate(newGroupName.trim());
  };

  const handleAddSubGroup = () => {
    if (!newSubGroupName.trim() || !targetGroupId) {
      toast.error("Заполните все поля");
      return;
    }
    createSubGroupMutation.mutate({ groupId: targetGroupId, name: newSubGroupName.trim() });
  };

  const handleAddContact = () => {
    if (!selectedSubGroup || !newContact.phone.trim()) {
      toast.error("Заполните номер телефона");
      return;
    }
    const vars: Record<string, string> = {};
    if (newContact.variables.trim()) {
      newContact.variables.split(";").forEach((v, i) => {
        vars[`field_${i + 1}`] = v.trim();
      });
    }
    createContactsMutation.mutate({
      subGroupId: selectedSubGroup.subGroupId,
      name: newContact.name.trim() || newContact.phone.trim(),
      phone: newContact.phone.trim(),
      variables: vars
    });
  };

  const handleImport = () => {
    if (!selectedSubGroup || !importText.trim()) {
      toast.error("Вставьте данные для импорта");
      return;
    }
    const lines = importText.trim().split("\n").filter((l) => l.trim());
    const parsedContacts = lines.map((line) => {
      const parts = line.split(";").map((p) => p.trim());
      const phone = parts[0] || "";
      const vars: Record<string, string> = {};
      parts.slice(1).forEach((v, i) => {
        vars[`field_${i + 1}`] = v;
      });
      return {
        name: phone,
        phone,
        variables: vars
      };
    });

    createContactsMutation.mutate({
      subGroupId: selectedSubGroup.subGroupId,
      contacts: parsedContacts
    });
  };

  const handleCheckWhatsApp = (contactId: string) => {
    checkWhatsAppMutation.mutate(contactId);
  };

  const handleCheckAllWhatsApp = (subGroupId: string, onlyIds?: string[]) => {
    const subGroup = groups
      .flatMap((g) => g.subGroups)
      .find((sg) => sg.id === subGroupId);

    if (!subGroup) return;

    const targets = onlyIds && onlyIds.length > 0
      ? subGroup.contacts.filter((c) => onlyIds.includes(c.id))
      : subGroup.contacts;

    if (targets.length === 0) {
      toast.error("Нет контактов для проверки");
      return;
    }

    targets.forEach((c, i) => {
      setTimeout(() => {
        handleCheckWhatsApp(c.id);
      }, i * 1500); // Stagger checks to prevent rate limits
    });
    toast.success(`Проверка запущена: ${targets.length}`);
  };

  const handleDeleteContact = (contactId: string) => {
    deleteContactMutation.mutate(contactId);
  };

  const handleDeleteSubGroup = (subGroupId: string) => {
    deleteSubGroupMutation.mutate(subGroupId);
  };

  const handleDeleteGroup = (groupId: string) => {
    deleteGroupMutation.mutate(groupId);
  };

  const totalContacts = groups.reduce(
    (acc, g) => acc + g.subGroups.reduce((a, sg) => a + sg.contacts.length, 0),
    0
  );

  const activeSubGroup = selectedSubGroup
    ? groups
        .find((g) => g.id === selectedSubGroup.groupId)
        ?.subGroups.find((sg) => sg.id === selectedSubGroup.subGroupId)
    : null;

  const filteredContacts = useMemo(() => {
    if (!activeSubGroup) return [];
    const q = search.toLowerCase();
    return activeSubGroup.contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.phone.includes(search)
    );
  }, [activeSubGroup, search]);

  // Reset selection + page when switching subgroups; reset page on search
  useEffect(() => {
    setSelectedIds(new Set());
    setPage(1);
  }, [selectedSubGroup?.subGroupId]);

  useEffect(() => {
    setPage(1);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(filteredContacts.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginatedContacts = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredContacts.slice(start, start + pageSize);
  }, [filteredContacts, safePage, pageSize]);

  const from = filteredContacts.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, filteredContacts.length);

  const selectedCount = useMemo(
    () => filteredContacts.filter((c) => selectedIds.has(c.id)).length,
    [filteredContacts, selectedIds]
  );
  const selectedIdList = useMemo(
    () => filteredContacts.filter((c) => selectedIds.has(c.id)).map((c) => c.id),
    [filteredContacts, selectedIds]
  );
  const allFilteredSelected = filteredContacts.length > 0 && selectedCount === filteredContacts.length;

  const pageNumbers = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages = new Set([1, 2, safePage - 1, safePage, safePage + 1, totalPages - 1, totalPages]);
    return [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  }, [totalPages, safePage]);

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    if (allFilteredSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredContacts.forEach((c) => next.delete(c.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredContacts.forEach((c) => next.add(c.id));
        return next;
      });
    }
  };

  const clearSelection = () => setSelectedIds(new Set());

  const openMoveDialog = () => {
    if (selectedIdList.length === 0) {
      toast.error("Выберите контакты");
      return;
    }
    // Default the move target to the current group so the user only picks a subgroup
    setMoveTargetGroupId(selectedSubGroup?.groupId ?? groups[0]?.id ?? "");
    setMoveTargetSubGroupId("");
    setMoveDialogOpen(true);
  };

  const handleBulkMove = () => {
    if (!moveTargetSubGroupId) {
      toast.error("Выберите целевую подгруппу");
      return;
    }
    if (moveTargetSubGroupId === selectedSubGroup?.subGroupId) {
      toast.error("Контакты уже находятся в этой подгруппе");
      return;
    }
    bulkMoveMutation.mutate({ ids: selectedIdList, targetSubGroupId: moveTargetSubGroupId });
  };

  const escapeCsvValue = (v: string) => {
    if (/[;"\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };

  const handleExport = () => {
    const source = selectedIdList.length > 0
      ? filteredContacts.filter((c) => selectedIds.has(c.id))
      : filteredContacts;
    if (source.length === 0) {
      toast.error("Нет контактов для экспорта");
      return;
    }
    const lines = source.map((c) => {
      const varKeys = Object.keys(c.variables).sort((a, b) => {
        const na = parseInt(a.replace("field_", ""), 10) || 0;
        const nb = parseInt(b.replace("field_", ""), 10) || 0;
        return na - nb;
      });
      const cells = [c.phone, ...varKeys.map((k) => c.variables[k] ?? "")];
      return cells.map(escapeCsvValue).join(";");
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `contacts-${activeSubGroup?.name ?? "export"}-${source.length}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success(`Экспортировано: ${source.length}`);
  };

  const moveTargetSubGroups = useMemo(() => {
    const g = groups.find((gr) => gr.id === moveTargetGroupId);
    return g?.subGroups ?? [];
  }, [groups, moveTargetGroupId]);

  const whatsappIcon = (status: Contact["whatsappStatus"]) => {
    switch (status) {
      case "checking":
        return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
      case "exists":
        return <CheckCircle2 className="h-4 w-4 text-primary" />;
      case "not_found":
        return <XCircle className="h-4 w-4 text-destructive" />;
      default:
        return null;
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div>
            <h1 className="text-3xl font-display font-bold">Контакты</h1>
            <p className="text-muted-foreground mt-1">
              {groups.length} групп · {totalContacts} контактов
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="gap-2">
                  <FolderPlus className="h-4 w-4" /> Новая группа
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle className="font-display">Создать группу</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 mt-2">
                  <div>
                    <Label>Название группы</Label>
                    <Input
                      placeholder="Например: Клиенты"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAddGroup()}
                    />
                  </div>
                  <Button
                    onClick={handleAddGroup}
                    disabled={createGroupMutation.isPending}
                    className="w-full gradient-primary text-primary-foreground"
                  >
                    Создать
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </motion.div>

        {isLoading ? (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left panel - Groups tree */}
            <motion.div
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              className="lg:col-span-1"
            >
              <Card className="h-fit">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-display flex items-center gap-2">
                    <Users className="h-4 w-4 text-primary" /> Группы и подгруппы
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1">
                  {groups.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-6">
                      Нет групп. Создайте первую!
                    </p>
                  )}
                  {groups.map((group) => {
                    const isExpanded = expandedGroups[group.id] !== false; // expanded by default
                    return (
                      <div key={group.id}>
                        <div className="flex items-center gap-1 group/item">
                          <button
                            onClick={() => toggleGroup(group.id)}
                            className="p-1 rounded hover:bg-muted transition-colors"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                          </button>
                          <div className="flex items-center gap-2 flex-1 py-1.5 px-2 rounded-md hover:bg-muted/50 transition-colors cursor-default">
                            <FolderOpen className="h-4 w-4 text-primary" />
                            <span className="text-sm font-medium flex-1">{group.name}</span>
                            <Badge variant="secondary" className="text-xs">
                              {group.subGroups.reduce((a, sg) => a + sg.contacts.length, 0)}
                            </Badge>
                          </div>
                          <button
                            onClick={() => {
                              setTargetGroupId(group.id);
                              setSubGroupDialogOpen(true);
                            }}
                            className="p-1 rounded hover:bg-muted opacity-0 group-hover/item:opacity-100 transition-all"
                            title="Добавить подгруппу"
                          >
                            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                          </button>
                          <button
                            onClick={() => handleDeleteGroup(group.id)}
                            className="p-1 rounded hover:bg-destructive/10 opacity-0 group-hover/item:opacity-100 transition-all"
                            title="Удалить группу"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </button>
                        </div>
                        <AnimatePresence>
                          {isExpanded && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              className="overflow-hidden ml-6 space-y-0.5"
                            >
                              {group.subGroups.map((sg) => {
                                const isActive = selectedSubGroup?.subGroupId === sg.id;
                                return (
                                  <div
                                    key={sg.id}
                                    className={`flex items-center gap-2 py-1.5 px-2 rounded-md cursor-pointer transition-colors group/sub
                                    ${isActive ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"}`}
                                    onClick={() =>
                                      setSelectedSubGroup({
                                        groupId: group.id,
                                        subGroupId: sg.id
                                      })
                                    }
                                  >
                                    <Users className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-sm flex-1">{sg.name}</span>
                                    <Badge variant="secondary" className="text-xs">
                                      {sg.contacts.length}
                                    </Badge>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleDeleteSubGroup(sg.id);
                                      }}
                                      className="p-0.5 rounded hover:bg-destructive/10 opacity-0 group-hover/sub:opacity-100 transition-all"
                                    >
                                      <Trash2 className="h-3 w-3 text-destructive" />
                                    </button>
                                  </div>
                                );
                              })}
                              {group.subGroups.length === 0 && (
                                <p className="text-xs text-muted-foreground py-2 pl-2">
                                  Нет подгрупп
                                </p>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </motion.div>

            {/* Right panel - Contacts */}
            <motion.div
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              className="lg:col-span-2"
            >
              <Card>
                <CardHeader>
                  {activeSubGroup ? (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <CardTitle className="text-lg font-display">{activeSubGroup.name}</CardTitle>
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          onClick={() => setContactDialogOpen(true)}
                        >
                          <UserPlus className="h-3.5 w-3.5" /> Добавить
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          onClick={() => setImportDialogOpen(true)}
                        >
                          <Import className="h-3.5 w-3.5" /> Импорт
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          onClick={() =>
                            selectedSubGroup &&
                            handleCheckAllWhatsApp(selectedSubGroup.subGroupId)
                          }
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" /> Проверить WA
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <CardTitle className="text-lg font-display text-muted-foreground">
                      Выберите подгруппу слева
                    </CardTitle>
                  )}
                  {activeSubGroup && (
                    <div className="relative mt-2">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        className="pl-9"
                        placeholder="Поиск по имени или номеру…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                  )}
                  {activeSubGroup && filteredContacts.length > 0 && (
                    <div className="flex items-center justify-between gap-2 mt-3 rounded-md bg-muted/50 px-3 py-2">
                      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                        <Checkbox
                          checked={allFilteredSelected ? true : selectedCount > 0 ? "indeterminate" : false}
                          onCheckedChange={toggleAllFiltered}
                        />
                        <span className="text-muted-foreground">
                          {selectedCount > 0 ? `Выбрано: ${selectedCount}` : "Выбрать все"}
                        </span>
                      </label>
                      {selectedCount > 0 && (
                        <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={clearSelection}>
                          <X className="h-3.5 w-3.5" /> Сбросить
                        </Button>
                      )}
                    </div>
                  )}
                  {selectedCount > 0 && (
                    <div className="flex flex-wrap items-center gap-2 mt-2 rounded-md border bg-card px-3 py-2">
                      <Badge variant="secondary">{selectedCount}</Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() => selectedSubGroup && handleCheckAllWhatsApp(selectedSubGroup.subGroupId, selectedIdList)}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" /> Проверить
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={handleExport}>
                        <Download className="h-3.5 w-3.5" /> Экспорт CSV
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={openMoveDialog}>
                        <ArrowRightLeft className="h-3.5 w-3.5" /> Переместить
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="gap-1.5"
                        onClick={() => setBulkDeleteOpen(true)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Удалить
                      </Button>
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  {!activeSubGroup && (
                    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                      <Users className="h-12 w-12 mb-3 opacity-40" />
                      <p className="text-sm">Выберите подгруппу для просмотра контактов</p>
                    </div>
                  )}
                  {activeSubGroup && filteredContacts.length === 0 && (
                    <p className="text-center text-muted-foreground py-8">
                      Контакты не найдены
                    </p>
                  )}
                  <div className="space-y-1.5">
                    {paginatedContacts.map((c, i) => (
                      <motion.div
                        key={c.id}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: i * 0.02 }}
                        className={`flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors group/contact ${selectedIds.has(c.id) ? "bg-accent/50" : ""}`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <Checkbox
                            checked={selectedIds.has(c.id)}
                            onCheckedChange={() => toggleOne(c.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div className="h-9 w-9 rounded-full gradient-primary flex items-center justify-center text-primary-foreground font-semibold text-xs shrink-0">
                            {c.name ? c.name.slice(0, 2).toUpperCase() : "CO"}
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">
                              {c.name || `+${c.phone}`}
                            </p>
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <Phone className="h-3 w-3" /> +{c.phone}
                              {Object.keys(c.variables).length > 0 && (
                                <span className="ml-1 text-primary/70 truncate">
                                  ·{" "}
                                  {Object.entries(c.variables)
                                    .map(([k, v]) => `${k}=${v}`)
                                    .join(", ")}
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {whatsappIcon(c.whatsappStatus)}
                          {c.whatsappStatus === "unknown" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 opacity-0 group-hover/contact:opacity-100"
                              onClick={() => handleCheckWhatsApp(c.id)}
                              title="Проверить WhatsApp"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 opacity-0 group-hover/contact:opacity-100 text-destructive"
                            onClick={() => handleDeleteContact(c.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </motion.div>
                    ))}
                  </div>

                  {activeSubGroup && filteredContacts.length > 0 && (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mt-4 pt-4 border-t">
                      <p className="text-xs text-muted-foreground">
                        Показано {from}–{to} из {filteredContacts.length}
                        {search && ` (поиск: "${search}")`}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
                          <SelectTrigger className="h-8 w-[110px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PAGE_SIZE_OPTIONS.map((n) => (
                              <SelectItem key={n} value={String(n)}>{n} / стр</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            disabled={safePage <= 1}
                            onClick={() => setPage((p) => Math.max(1, Math.min(p, totalPages) - 1))}
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          {pageNumbers.map((p, idx, arr) => {
                            const prev = arr[idx - 1];
                            const gap = prev !== undefined && p - prev > 1;
                            return (
                              <span key={p} className="flex items-center gap-1">
                                {gap && <span className="text-muted-foreground text-xs px-0.5">…</span>}
                                <Button
                                  variant={p === safePage ? "default" : "outline"}
                                  size="sm"
                                  className="h-8 min-w-8 px-2"
                                  onClick={() => setPage(p)}
                                >
                                  {p}
                                </Button>
                              </span>
                            );
                          })}
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            disabled={safePage >= totalPages}
                            onClick={() => setPage((p) => Math.min(totalPages, Math.max(1, p) + 1))}
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          </div>
        )}
      </div>

      {/* Add SubGroup Dialog */}
      <Dialog open={subGroupDialogOpen} onOpenChange={setSubGroupDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">Создать подгруппу</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <Label>Название подгруппы</Label>
              <Input
                placeholder="Например: VIP клиенты"
                value={newSubGroupName}
                onChange={(e) => setNewSubGroupName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddSubGroup()}
              />
            </div>
            <Button
              onClick={handleAddSubGroup}
              disabled={createSubGroupMutation.isPending}
              className="w-full gradient-primary text-primary-foreground"
            >
              Создать
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Contact Dialog */}
      <Dialog open={contactDialogOpen} onOpenChange={setContactDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">Добавить контакт</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <Label>Имя (необязательно)</Label>
              <Input
                placeholder="Иван Иванов"
                value={newContact.name}
                onChange={(e) => setNewContact({ ...newContact, name: e.target.value })}
              />
            </div>
            <div>
              <Label>Номер телефона (без +)</Label>
              <Input
                placeholder="79001234567"
                value={newContact.phone}
                onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })}
              />
            </div>
            <div>
              <Label>Переменные (через точку с запятой ;)</Label>
              <Input
                placeholder="Москва; 10%; золотой"
                value={newContact.variables}
                onChange={(e) => setNewContact({ ...newContact, variables: e.target.value })}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Будут доступны в шаблонах как field_1, field_2, field_3…
              </p>
            </div>
            <Button
              onClick={handleAddContact}
              disabled={createContactsMutation.isPending}
              className="w-full gradient-primary text-primary-foreground"
            >
              Добавить
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Импорт контактов</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <Label>Вставьте данные</Label>
              <Textarea
                rows={8}
                placeholder={
                  "79001234567; Москва; 10%\n79112345678; СПб; 15%\n79253456789; Казань"
                }
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                className="font-mono text-sm"
              />

              <p className="text-xs text-muted-foreground mt-1.5">
                Формат:{" "}
                <span className="font-mono text-foreground/70">
                  номер; переменная1; переменная2; …
                </span>
                <br />
                Каждый контакт на новой строке. Без знака +.
              </p>
            </div>
            <Button
              onClick={handleImport}
              disabled={createContactsMutation.isPending}
              className="w-full gradient-primary text-primary-foreground"
            >
              Импортировать
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Move Dialog */}
      <Dialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">Переместить контакты ({selectedCount})</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <Label>Группа</Label>
              <Select value={moveTargetGroupId} onValueChange={(v) => { setMoveTargetGroupId(v); setMoveTargetSubGroupId(""); }}>
                <SelectTrigger><SelectValue placeholder="Выберите группу" /></SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Подгруппа</Label>
              <Select value={moveTargetSubGroupId} onValueChange={setMoveTargetSubGroupId}>
                <SelectTrigger><SelectValue placeholder="Выберите подгруппу" /></SelectTrigger>
                <SelectContent>
                  {moveTargetSubGroups.map((sg) => (
                    <SelectItem key={sg.id} value={sg.id}>
                      {sg.name} ({sg.contacts.length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setMoveDialogOpen(false)}>Отмена</Button>
              <Button
                onClick={handleBulkMove}
                disabled={bulkMoveMutation.isPending || !moveTargetSubGroupId}
                className="gradient-primary text-primary-foreground"
              >
                {bulkMoveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Переместить"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirm */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">Удалить контакты?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Будет удалено контактов: {selectedCount}. Это действие нельзя отменить.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDeleteOpen(false)}>Отмена</Button>
            <Button
              variant="destructive"
              onClick={() => bulkDeleteMutation.mutate(selectedIdList)}
              disabled={bulkDeleteMutation.isPending}
            >
              {bulkDeleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Удалить"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
};

export default Contacts;
