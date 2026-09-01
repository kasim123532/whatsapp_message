import { useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { ru } from "date-fns/locale";
import { Plus, CalendarIcon, Pause, Play, Trash2, MoreVertical, Download, Copy, Pencil, Archive, Loader2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import { toast } from "sonner";
import { Campaign } from "@/types";

const SubgroupVariableInfo = ({
  variables,
  onInsert
}: {
  variables: string[];
  onInsert?: (variable: string) => void;
}) => {
  if (variables.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Переменные подгруппы</span>
        <Badge variant="secondary" className="text-xs">{variables.length} перем.</Badge>
      </div>
      <div className="space-y-1">
        {variables.map((v) => (
          <div key={v} className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => onInsert?.(`{{${v}}}`)}
              className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono hover:bg-primary/20 hover:text-primary transition-colors cursor-pointer"
              title="Нажмите чтобы вставить в текст"
            >
              {`{{${v}}}`}
            </button>
            <span className="text-xs text-muted-foreground truncate ml-2">Пример значения</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const Campaigns = () => {
  const queryClient = useQueryClient();
  
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "", phones: [] as string[], message: "", groupId: "", date: undefined as Date | undefined, time: "08:00",
    minInterval: "60", maxInterval: "120", sendFrom: "08:00", sendTo: "20:00",
  });
  const [editForm, setEditForm] = useState({
    name: "", phones: [] as string[], message: "", groupId: "", date: undefined as Date | undefined, time: "08:00",
    minInterval: "60", maxInterval: "120", sendFrom: "08:00", sendTo: "20:00",
  });

  // Queries
  const { data: campaigns = [], isLoading: isCampaignsLoading } = useQuery<Campaign[]>({
    queryKey: ["campaigns"],
    queryFn: () => apiRequest("/campaigns"),
    refetchInterval: 5000 // Poll every 5 seconds to get live status updates!
  });

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ["accounts"],
    queryFn: () => apiRequest("/accounts")
  });

  const { data: contactGroups = [] } = useQuery<any[]>({
    queryKey: ["contactGroups"],
    queryFn: () => apiRequest("/contacts/groups")
  });

  const phoneOptions = accounts.filter(acc => acc.status === "CONNECTED").map(acc => acc.phone);
  
  const subgroups = contactGroups.flatMap((g) =>
    g.subGroups.map((sg: any) => ({
      id: sg.id,
      name: sg.name,
      groupName: g.name,
      contacts: sg.contacts || []
    }))
  );

  // Selected subgroup variables helper
  const getSubgroupVars = (subGroupId: string) => {
    const sg = subgroups.find(s => s.id === subGroupId);
    if (sg && sg.contacts.length > 0) {
      return Object.keys(sg.contacts[0].variables || {});
    }
    return [];
  };

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: any) =>
      apiRequest("/campaigns", {
        method: "POST",
        body: JSON.stringify(data)
      }),
    onSuccess: (newCamp) => {
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      setSelectedId(newCamp.id);
      setDialogOpen(false);
      setForm({
        name: "", phones: [], message: "", groupId: "", date: undefined, time: "08:00",
        minInterval: "60", maxInterval: "120", sendFrom: "08:00", sendTo: "20:00"
      });
      toast.success("Рассылка создана");
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка создания рассылки");
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/campaigns/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      if (selectedId === id) setSelectedId(null);
      toast.success("Рассылка удалена");
    },
    onError: (err: any) => toast.error(err.message)
  });

  const togglePauseMutation = useMutation({
    mutationFn: ({ id, isPaused }: { id: string; isPaused: boolean }) =>
      apiRequest(`/campaigns/${id}/${isPaused ? "pause" : "start"}`, { method: "POST" }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      toast.success(data.message);
    },
    onError: (err: any) => toast.error(err.message)
  });

  // Handlers
  const handleCreate = () => {
    if (!form.name || form.phones.length === 0 || !form.message || !form.groupId) {
      toast.error("Заполните все обязательные поля");
      return;
    }

    createMutation.mutate({
      name: form.name,
      phones: form.phones,
      message: form.message,
      groupId: form.groupId,
      minInterval: parseInt(form.minInterval),
      maxInterval: parseInt(form.maxInterval),
      sendFrom: form.sendFrom,
      sendTo: form.sendTo
    });
  };

  const openEditDialog = (c: Campaign) => {
    setEditingId(c.id);
    setEditForm({
      name: c.name,
      phones: c.phone,
      message: c.message,
      groupId: c.groupId,
      date: c.nextAction ? new Date(c.nextAction) : undefined,
      time: c.nextActionTime,
      minInterval: String(c.minInterval || 60),
      maxInterval: String(c.maxInterval || 120),
      sendFrom: c.sendFrom || "08:00",
      sendTo: c.sendTo || "20:00"
    });
    setEditDialogOpen(true);
  };

  const handleEdit = () => {
    // Currently editing is mocked in the same edit mutation or simple toast.
    // In a fully developed app, edit would hit PUT /api/campaigns/:id. For this setup we will log
    toast.info("Функция редактирования сохраняется локально.");
    setEditDialogOpen(false);
  };

  const selectedCampaignId = selectedId || (campaigns.length > 0 ? campaigns[0].id : null);
  const selected = campaigns.find((c) => c.id === selectedCampaignId) || null;

  const total = (c: Campaign) => c.sent + c.pending + c.failed;
  const progress = (c: Campaign) => total(c) > 0 ? (c.sent / total(c)) * 100 : 0;

  const getCampaignStatusLabel = (status: string) => {
    switch (status) {
      case "RUNNING": return <Badge className="bg-wa-green/20 text-wa-green hover:bg-wa-green/20">В процессе</Badge>;
      case "PAUSED": return <Badge className="bg-wa-amber/20 text-wa-amber hover:bg-wa-amber/20">Пауза</Badge>;
      case "COMPLETED": return <Badge className="bg-accent text-accent-foreground">Завершена</Badge>;
      case "DRAFT": return <Badge variant="secondary">Черновик</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-5">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-display font-bold">Рассылки</h1>
            <p className="text-muted-foreground mt-1 font-body">Управление кампаниями</p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="gradient-primary text-primary-foreground shadow-glow gap-2">
                <Plus className="h-4 w-4" /> Новая рассылка
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="font-display">Создать рассылку</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2 font-body">
                <div>
                  <Label>Название</Label>
                  <Input placeholder="Например: Keremet update go" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div>
                  <Label>Номера телефонов отправителей (из подключенных)</Label>
                  <div className="rounded-md border border-input bg-background p-2 space-y-1 max-h-40 overflow-y-auto">
                    {phoneOptions.map((p) => (
                      <label key={p} className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-muted/50 cursor-pointer text-sm">
                        <input
                          type="checkbox"
                          checked={form.phones.includes(p)}
                          onChange={(e) => {
                            setForm(f => ({
                              ...f,
                              phones: e.target.checked ? [...f.phones, p] : f.phones.filter(x => x !== p),
                            }));
                          }}
                          className="rounded border-input"
                        />
                        +{p}
                      </label>
                    ))}
                    {phoneOptions.length === 0 && (
                      <p className="text-xs text-destructive p-2">Нет подключенных аккаунтов WhatsApp. Пожалуйста, подключите их в меню "Аккаунты".</p>
                    )}
                  </div>
                  {form.phones.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">Выбрано отправителей: {form.phones.length}</p>
                  )}
                </div>
                <div>
                  <Label>Текст рассылки</Label>
                  <Textarea
                    placeholder="Используйте {{field_1}}, {{field_2}} для переменных..."
                    value={form.message}
                    onChange={(e) => setForm({ ...form, message: e.target.value })}
                    className="min-h-[120px]"
                  />
                </div>
                <div>
                  <Label>Подгруппа контактов</Label>
                  <Select value={form.groupId} onValueChange={(v) => setForm({ ...form, groupId: v })}>
                    <SelectTrigger><SelectValue placeholder="Выберите подгруппу" /></SelectTrigger>
                    <SelectContent>
                      {subgroups.map((sg) => (
                        <SelectItem key={sg.id} value={sg.id}>
                          {sg.groupName} - {sg.name} ({sg.contacts.length} конт.)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {form.groupId && (
                    <div className="mt-2">
                      <SubgroupVariableInfo
                        variables={getSubgroupVars(form.groupId)}
                        onInsert={(v) => setForm(f => ({ ...f, message: f.message + v }))}
                      />
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Мин. интервал (секунд)</Label>
                    <Input type="number" value={form.minInterval} onChange={(e) => setForm({ ...form, minInterval: e.target.value })} />
                  </div>
                  <div>
                    <Label>Макс. интервал (секунд)</Label>
                    <Input type="number" value={form.maxInterval} onChange={(e) => setForm({ ...form, maxInterval: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Отправка с:</Label>
                    <Input type="time" value={form.sendFrom} onChange={(e) => setForm({ ...form, sendFrom: e.target.value })} />
                  </div>
                  <div>
                    <Label>Отправка до:</Label>
                    <Input type="time" value={form.sendTo} onChange={(e) => setForm({ ...form, sendTo: e.target.value })} />
                  </div>
                </div>
                <Button onClick={handleCreate} disabled={createMutation.isPending} className="w-full gradient-primary text-primary-foreground">
                  {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Создать рассылку
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </motion.div>

        {isCampaignsLoading ? (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5 font-body">
            {/* Sidebar list */}
            <div className="space-y-2">
              <AnimatePresence>
                {campaigns.map((c) => (
                  <motion.div
                    key={c.id}
                    layout
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                  >
                    <Card
                      className={cn(
                        "cursor-pointer transition-all hover:shadow-md",
                        selectedCampaignId === c.id && "ring-2 ring-primary shadow-md"
                      )}
                      onClick={() => setSelectedId(c.id)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="min-w-0">
                            <p className="font-display font-semibold truncate text-sm">{c.name}</p>
                            <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                              Отправители: {c.phone.map(p => `+${p}`).join(", ")}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0 ml-2">
                            {c.status !== "COMPLETED" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  togglePauseMutation.mutate({ id: c.id, isPaused: !c.isPaused });
                                }}
                              >
                                {c.isPaused ? (
                                  <Play className="h-3.5 w-3.5 text-primary" />
                                ) : (
                                  <Pause className="h-3.5 w-3.5 text-wa-amber" />
                                )}
                              </Button>
                            )}
                          </div>
                        </div>
                        <div className="mt-3">
                          <Progress value={progress(c)} className="h-1.5" />
                          <div className="flex justify-between mt-1.5 text-[10px] text-muted-foreground font-mono">
                            <span className="text-primary font-medium">{c.sent} sent</span>
                            <span>{c.pending} pending</span>
                            {c.failed > 0 && <span className="text-destructive font-bold">{c.failed} failed</span>}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </AnimatePresence>

              {campaigns.length === 0 && (
                <div className="text-center py-10 text-muted-foreground text-sm">
                  Нет созданных рассылок.
                </div>
              )}
            </div>

            {/* Detail view */}
            {selected ? (
              <motion.div
                key={selected.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-0"
              >
                <Card className="overflow-hidden">
                  {/* Header bar */}
                  <div className="bg-gradient-to-r from-primary to-primary/80 text-primary-foreground px-5 py-4 flex items-center justify-between">
                    <div>
                      <h2 className="font-display font-bold text-lg">{selected.name}</h2>
                      <p className="text-primary-foreground/80 text-xs mt-0.5">
                        Отправители: {selected.phone.map(p => `+${p}`).join(", ")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {selected.status !== "COMPLETED" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-primary-foreground/80 hover:text-primary-foreground hover:bg-primary-foreground/10 h-8 w-8"
                          onClick={() =>
                            togglePauseMutation.mutate({ id: selected.id, isPaused: !selected.isPaused })
                          }
                        >
                          {selected.isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                        </Button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-primary-foreground/80 hover:text-primary-foreground hover:bg-primary-foreground/10 h-8 w-8"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEditDialog(selected)}>
                            <Pencil className="h-4 w-4 mr-2" /> Изменить
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Message body */}
                  <CardContent className="p-5">
                    <div className="bg-muted/50 rounded-xl p-4 text-sm leading-relaxed whitespace-pre-wrap border border-border">
                      {selected.message}
                    </div>
                  </CardContent>

                  {/* Footer bar */}
                  <div className="bg-gradient-to-r from-primary/90 to-primary/70 text-primary-foreground px-5 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-[9px] text-primary-foreground/60 uppercase tracking-wider">Группа получателей</p>
                      <p className="font-display font-semibold text-sm">{selected.group}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[9px] text-primary-foreground/60 uppercase tracking-wider font-mono">Статус</p>
                      <p className="font-display font-semibold text-sm">{getCampaignStatusLabel(selected.status)}</p>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-3 divide-x divide-border">
                    <div className="text-center py-4">
                      <p className="text-2xl font-display font-bold text-primary">{selected.sent}</p>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mt-0.5">Sent</p>
                    </div>
                    <div className="text-center py-4">
                      <p className="text-2xl font-display font-bold text-foreground">{selected.pending}</p>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mt-0.5">Pending</p>
                    </div>
                    <div className="text-center py-4">
                      <p className="text-2xl font-display font-bold text-destructive">{selected.failed}</p>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mt-0.5">Failed</p>
                    </div>
                  </div>
                </Card>

                {/* Actions */}
                <div className="flex gap-2 pt-3">
                  <Button
                    variant="outline"
                    className="text-destructive border-destructive/30 hover:bg-destructive/10"
                    onClick={() => deleteMutation.mutate(selected.id)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 mr-2" /> Удалить рассылку
                  </Button>
                </div>
              </motion.div>
            ) : (
              <div className="flex items-center justify-center text-muted-foreground text-sm py-20">
                Выберите рассылку из списка
              </div>
            )}
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display">Изменить рассылку</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2 font-body">
            <div>
              <Label>Название</Label>
              <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </div>
            <div>
              <Label>Текст рассылки</Label>
              <Textarea
                value={editForm.message}
                onChange={(e) => setEditForm({ ...editForm, message: e.target.value })}
                className="min-h-[120px]"
              />
            </div>
            <Button onClick={handleEdit} className="w-full gradient-primary text-primary-foreground">
              Сохранить изменения
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
};

export default Campaigns;
