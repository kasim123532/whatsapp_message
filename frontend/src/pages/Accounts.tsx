import { useEffect, useMemo, useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { QrDialog } from "@/components/QrDialog";
import {
  AlertTriangle, Loader2, LogOut, MoreHorizontal, Pencil, Plus, QrCode, Send,
  ShieldAlert, Sliders, Trash2, Wifi, WifiOff,
} from "lucide-react";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import { cn, formatCountdown } from "@/lib/utils";
import { toast } from "sonner";
import { Proxy, WhatsAppProfile } from "@/types";

const NO_PROXY = "__none__";

/** A profile with no phone behind it has never been scanned — it isn't an account yet. */
const isPending = (p: WhatsAppProfile) => !p.phone && p.status !== "CONNECTED";

const ru = (n: number) => n.toLocaleString("ru-RU");

function avatarInitials(p: WhatsAppProfile) {
  return (p.phone || p.id).slice(-2);
}

function StatTile({
  label, value, hint, icon: Icon, tone,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Wifi;
  tone: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={cn("h-3.5 w-3.5", tone)} />
        {label}
      </div>
      <div className="mt-2 font-display text-2xl font-semibold leading-none">{value}</div>
      <div className="mt-1.5 h-4 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

const Accounts = () => {
  const queryClient = useQueryClient();

  const [addOpen, setAddOpen] = useState(false);
  const [limitOpen, setLimitOpen] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [activeQrId, setActiveQrId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  const [newName, setNewName] = useState("");
  const [newProxy, setNewProxy] = useState(NO_PROXY);
  const [dayLimit, setDayLimit] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Profile being edited (name / proxy / individual daily limit)
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editProxy, setEditProxy] = useState(NO_PROXY);
  const [editLimit, setEditLimit] = useState("");

  const { data: profiles = [], isLoading } = useQuery<WhatsAppProfile[]>({
    queryKey: ["accounts"],
    queryFn: () => apiRequest("/accounts")
  });

  const { data: proxies = [] } = useQuery<Proxy[]>({
    queryKey: ["proxies"],
    queryFn: () => apiRequest("/proxies")
  });

  // Linked accounts first; profiles still waiting for a scan sink to the bottom
  // where their countdowns don't push real accounts around.
  const rows = useMemo(
    () => [...profiles].sort((a, b) => Number(isPending(a)) - Number(isPending(b))),
    [profiles]
  );

  // Both the QR window and the self-destruct deadline are wall-clock countdowns,
  // so the page needs a heartbeat — but only while something is actually ticking.
  const hasTimers = rows.some((p) => p.qrExpiresAt || p.pendingExpiresAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasTimers) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasTimers]);

  const stats = useMemo(() => {
    const linked = profiles.filter((p) => !isPending(p));
    return {
      online: profiles.filter((p) => p.status === "CONNECTED").length,
      banned: profiles.filter((p) => p.status === "BANNED").length,
      linked: linked.length,
      waiting: profiles.filter(isPending).length,
      sentToday: linked.reduce((sum, p) => sum + p.todaySent, 0),
      capacity: linked.reduce((sum, p) => sum + (p.dailyLimit > 0 ? p.dailyLimit : 0), 0),
      capped: linked.filter((p) => p.dailyLimit > 0 && p.todaySent >= p.dailyLimit).length
    };
  }, [profiles]);

  // Mutations
  const addMutation = useMutation({
    mutationFn: (data: { name?: string; proxy?: string }) =>
      apiRequest("/accounts", {
        method: "POST",
        body: JSON.stringify(data)
      }),
    onSuccess: (newProfile: WhatsAppProfile) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setAddOpen(false);
      setNewName("");
      setNewProxy(NO_PROXY);
      toast.success("Профиль создан — отсканируйте QR-код");

      // Auto initiate connection
      connectMutation.mutate(newProfile.id);
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка добавления аккаунта");
    }
  });

  const editMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: string; name: string; proxy: string; dailyLimit: number }) =>
      apiRequest(`/accounts/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: (updated: WhatsAppProfile & { restarted?: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      closeEdit();
      toast.success(
        updated.restarted
          ? "Профиль обновлён, сессия перезапускается с новым прокси"
          : "Профиль обновлён"
      );
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка сохранения профиля");
    }
  });

  const connectMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/accounts/${id}/connect`, { method: "POST" }),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setActiveQrId(id);
      setQrDialogOpen(true);
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка подключения");
    }
  });

  const disconnectMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/accounts/${id}/disconnect`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Сессия остановлена, привязка сохранена");
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка отключения");
    }
  });

  const logoutMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/accounts/${id}/logout`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Устройство отвязано, потребуется новый QR");
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка выхода из аккаунта");
    }
  });

  const limitMutation = useMutation({
    mutationFn: (data: { ids: string[]; limit: number }) =>
      apiRequest("/accounts/limit", {
        method: "POST",
        body: JSON.stringify(data)
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setLimitOpen(false);
      setDayLimit("");
      setSelected(new Set());
      toast.success("Лимиты установлены");
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка установки лимита");
    }
  });

  // One round trip per profile, but a single outcome: deleting six accounts used
  // to fire six separate toasts.
  const deleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => apiRequest(`/accounts/${id}`, { method: "DELETE" }))
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        throw new Error(`Не удалось удалить профилей: ${failed} из ${ids.length}`);
      }
      return ids;
    },
    onSuccess: (ids) => {
      toast.success(ids.length === 1 ? "Аккаунт удалён" : `Удалено профилей: ${ids.length}`);
    },
    onError: (err: any) => {
      toast.error(err.message || "Ошибка удаления");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setSelected(new Set());
      setPendingDelete(null);
    }
  });

  const activeProfileForQr = profiles.find((p) => p.id === activeQrId) ?? null;

  // Rows the janitor already collected must not linger in the selection.
  const selectedIds = useMemo(
    () => rows.filter((p) => selected.has(p.id)).map((p) => p.id),
    [rows, selected]
  );
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;

  const handleAdd = () => {
    addMutation.mutate({
      name: newName.trim(),
      proxy: newProxy === NO_PROXY ? "" : newProxy
    });
  };

  const openEdit = (profile: WhatsAppProfile) => {
    setEditId(profile.id);
    setEditName(profile.name || "");
    setEditProxy(profile.proxy || NO_PROXY);
    setEditLimit(String(profile.dailyLimit ?? 0));
  };

  const closeEdit = () => {
    setEditId(null);
    setEditName("");
    setEditProxy(NO_PROXY);
    setEditLimit("");
  };

  const handleSaveEdit = () => {
    if (!editId) return;
    editMutation.mutate({
      id: editId,
      name: editName.trim(),
      proxy: editProxy === NO_PROXY ? "" : editProxy,
      dailyLimit: parseInt(editLimit, 10) || 0
    });
  };

  const handleSetLimit = () => {
    limitMutation.mutate({ ids: selectedIds, limit: parseInt(dayLimit, 10) || 0 });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map((p) => p.id)));
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openQr = (id: string) => {
    setActiveQrId(id);
    setQrDialogOpen(true);
  };

  // The edit dialog offers the saved proxy list, plus whatever the profile is
  // already using even when that value was never added to the list.
  const proxyOptions = (current: string) => {
    const values = proxies.map((p) => p.value);
    return current && !values.includes(current) ? [current, ...values] : values;
  };

  const deleteTargets = pendingDelete
    ? rows.filter((p) => pendingDelete.includes(p.id))
    : [];

  const statusCell = (p: WhatsAppProfile) => {
    if (p.status === "CONNECTED") {
      return (
        <Badge className="gap-1 whitespace-nowrap border-wa-green/30 bg-wa-green/15 text-wa-green hover:bg-wa-green/15">
          <Wifi className="h-3 w-3" /> На связи
        </Badge>
      );
    }

    if (p.status === "BANNED") {
      return (
        <Badge variant="destructive" className="gap-1 whitespace-nowrap">
          <ShieldAlert className="h-3 w-3" /> Заблокирован
        </Badge>
      );
    }

    if (p.status === "CONNECTING") {
      const left = p.qrExpiresAt ? p.qrExpiresAt - now : null;
      return (
        <Badge className="gap-1 whitespace-nowrap border-wa-amber/30 bg-wa-amber/15 text-wa-amber hover:bg-wa-amber/15">
          <QrCode className="h-3 w-3" />
          {p.qr && left !== null ? `Сканируйте · ${formatCountdown(left)}` : "Запуск сессии"}
        </Badge>
      );
    }

    // Disconnected. For a profile that was never scanned that also means it is
    // on its way out, so show how long it has left rather than a bare status.
    if (isPending(p) && p.pendingExpiresAt) {
      return (
        <div className="flex flex-col gap-0.5">
          <Badge variant="outline" className="w-fit gap-1 whitespace-nowrap border-dashed text-muted-foreground">
            <AlertTriangle className="h-3 w-3" /> Не отсканирован
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            удалится через {formatCountdown(p.pendingExpiresAt - now)}
          </span>
        </div>
      );
    }

    return (
      <Badge variant="secondary" className="gap-1 whitespace-nowrap">
        <WifiOff className="h-3 w-3" /> Отключён
      </Badge>
    );
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-wrap items-end justify-between gap-4"
        >
          <div>
            <h1 className="font-display text-2xl font-bold">Аккаунты WhatsApp</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Номера, с которых уходят рассылки. Профиль без отсканированного кода удаляется сам.
            </p>
          </div>
          <Button className="gap-2" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Добавить аккаунт
          </Button>
        </motion.div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            icon={Wifi}
            tone="text-wa-green"
            label="На связи"
            value={`${ru(stats.online)} из ${ru(stats.linked)}`}
            hint={stats.linked === 0 ? "Ни одного номера" : "Готовы отправлять"}
          />
          <StatTile
            icon={Send}
            tone="text-primary"
            label="Отправлено сегодня"
            value={ru(stats.sentToday)}
            hint={stats.capacity > 0 ? `Лимит на день ${ru(stats.capacity)}` : "Лимиты не заданы"}
          />
          <StatTile
            icon={QrCode}
            tone="text-wa-amber"
            label="Ждут сканирования"
            value={ru(stats.waiting)}
            hint={stats.waiting > 0 ? "Отсканируйте или удалятся" : undefined}
          />
          <StatTile
            icon={ShieldAlert}
            tone={stats.banned > 0 ? "text-destructive" : "text-muted-foreground"}
            label="Требуют внимания"
            value={ru(stats.banned + stats.capped)}
            hint={
              stats.banned + stats.capped > 0
                ? `Блокировок ${ru(stats.banned)} · на лимите ${ru(stats.capped)}`
                : "Проблем нет"
            }
          />
        </div>

        <Card className="overflow-hidden">
          <div className="flex h-14 items-center justify-between gap-4 border-b px-4">
            <span className="text-sm text-muted-foreground">
              {selectedIds.length > 0
                ? `Выбрано: ${selectedIds.length}`
                : `Профилей: ${ru(rows.length)}`}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={selectedIds.length === 0}
                onClick={() => setLimitOpen(true)}
              >
                <Sliders className="h-3.5 w-3.5" /> Лимит
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-destructive hover:text-destructive"
                disabled={selectedIds.length === 0}
                onClick={() => setPendingDelete(selectedIds)}
              >
                <Trash2 className="h-3.5 w-3.5" /> Удалить
              </Button>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-12 pl-4">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    disabled={rows.length === 0}
                    aria-label="Отметить все профили"
                  />
                </TableHead>
                <TableHead>Профиль</TableHead>
                <TableHead className="hidden lg:table-cell">Прокси</TableHead>
                <TableHead className="w-56">Статус</TableHead>
                <TableHead className="w-32 text-right">Сегодня</TableHead>
                <TableHead className="hidden w-24 text-right md:table-cell">Всего</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={7} className="h-32 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
                  </TableCell>
                </TableRow>
              )}

              {!isLoading && rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={7} className="h-32 text-center text-sm text-muted-foreground">
                    Пока нет ни одного профиля. Добавьте первый аккаунт и отсканируйте QR-код.
                  </TableCell>
                </TableRow>
              )}

              {rows.map((p) => {
                const pending = isPending(p);
                const capped = p.dailyLimit > 0 && p.todaySent >= p.dailyLimit;

                return (
                  <TableRow key={p.id} data-state={selected.has(p.id) ? "selected" : undefined}>
                    <TableCell className="pl-4">
                      <Checkbox
                        checked={selected.has(p.id)}
                        onCheckedChange={() => toggleOne(p.id)}
                        aria-label="Отметить профиль"
                      />
                    </TableCell>

                    <TableCell className={cn("py-3", pending && "opacity-60")}>
                      <div className="flex items-center gap-3">
                        <div
                          className={cn(
                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-display text-xs font-bold",
                            pending
                              ? "border border-dashed border-muted-foreground/40 text-muted-foreground"
                              : "bg-primary text-primary-foreground"
                          )}
                        >
                          {pending ? <QrCode className="h-4 w-4" /> : avatarInitials(p)}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {p.phone ? `+${p.phone}` : p.name || "Новый профиль"}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {p.phone
                              ? p.name || "Без названия"
                              : "Номер появится после сканирования"}
                          </div>
                          {p.lastError && p.status !== "CONNECTED" && !pending && (
                            <div className="mt-0.5 flex items-center gap-1 text-xs text-destructive">
                              <AlertTriangle className="h-3 w-3 shrink-0" />
                              <span className="truncate">{p.lastError}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </TableCell>

                    <TableCell className={cn("hidden lg:table-cell", pending && "opacity-60")}>
                      {p.proxy ? (
                        <span className="block max-w-[180px] truncate font-mono text-xs" title={p.proxy}>
                          {p.proxy}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">без прокси</span>
                      )}
                    </TableCell>

                    <TableCell>{statusCell(p)}</TableCell>

                    <TableCell className="text-right">
                      {pending ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={cn(
                            "font-mono text-sm tabular-nums",
                            capped ? "font-semibold text-wa-amber" : "text-muted-foreground"
                          )}
                          title="Отправлено сегодня из дневного лимита"
                        >
                          {p.todaySent} / {p.dailyLimit > 0 ? p.dailyLimit : "∞"}
                        </span>
                      )}
                    </TableCell>

                    <TableCell className="hidden text-right md:table-cell">
                      {pending ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="font-mono text-sm tabular-nums text-muted-foreground">
                          {ru(p.totalSent)}
                        </span>
                      )}
                    </TableCell>

                    <TableCell className="pr-4">
                      <div className="flex items-center justify-end gap-1">
                        {p.status === "CONNECTED" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1 px-2 text-xs text-muted-foreground"
                            onClick={() => disconnectMutation.mutate(p.id)}
                            title="Остановить сессию, привязка устройства сохранится"
                          >
                            <WifiOff className="h-3.5 w-3.5" /> Стоп
                          </Button>
                        ) : p.status === "CONNECTING" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1 px-2 text-xs"
                            onClick={() => openQr(p.id)}
                          >
                            <QrCode className="h-3.5 w-3.5" /> Показать код
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1 border-wa-green/30 px-2 text-xs text-wa-green hover:bg-wa-green/10 hover:text-wa-green"
                            onClick={() => connectMutation.mutate(p.id)}
                          >
                            <Wifi className="h-3.5 w-3.5" /> Войти
                          </Button>
                        )}

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground">
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">Действия с профилем</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <DropdownMenuItem onSelect={() => openEdit(p)}>
                              <Pencil className="mr-2 h-4 w-4" /> Настройки профиля
                            </DropdownMenuItem>
                            {p.phone && (
                              <DropdownMenuItem onSelect={() => logoutMutation.mutate(p.id)}>
                                <LogOut className="mr-2 h-4 w-4" /> Отвязать устройство
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => setPendingDelete([p.id])}
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> Удалить профиль
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </div>

      {/* Add profile dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Добавить WhatsApp профиль</DialogTitle>
            <DialogDescription>
              Номер телефона вводить не нужно — он определится автоматически после сканирования QR-кода.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold">Имя профиля (для себя)</label>
              <Input
                placeholder="Call-центр 1"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold">Proxy (опционально)</label>
              <Select value={newProxy} onValueChange={setNewProxy}>
                <SelectTrigger>
                  <SelectValue placeholder="Выберите прокси" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROXY}>Без прокси</SelectItem>
                  {proxies.map((p) => (
                    <SelectItem key={p.id} value={p.value}>
                      {p.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {proxies.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Список прокси пуст — добавьте их на странице "Управление прокси".
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Отмена</Button>
            <Button onClick={handleAdd} disabled={addMutation.isPending}>
              {addMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Добавить и подключить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit profile dialog */}
      <Dialog open={editId !== null} onOpenChange={(open) => !open && closeEdit()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Настройки профиля</DialogTitle>
            <DialogDescription>
              Смена прокси перезапустит активную сессию — привязка устройства при этом сохраняется.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-semibold">Имя профиля</label>
              <Input
                placeholder="Call-центр 1"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold">Proxy</label>
              <Select value={editProxy} onValueChange={setEditProxy}>
                <SelectTrigger>
                  <SelectValue placeholder="Выберите прокси" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROXY}>Без прокси</SelectItem>
                  {proxyOptions(editProxy === NO_PROXY ? "" : editProxy).map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold">Дневной лимит сообщений</label>
              <Input
                type="number"
                min={0}
                placeholder="0 — без лимита"
                value={editLimit}
                onChange={(e) => setEditLimit(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeEdit}>Отмена</Button>
            <Button onClick={handleSaveEdit} disabled={editMutation.isPending}>
              {editMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR Scanner dialog */}
      <QrDialog
        open={qrDialogOpen}
        onOpenChange={(open) => {
          setQrDialogOpen(open);
          if (!open) setActiveQrId(null);
        }}
        profile={activeProfileForQr}
      />

      {/* Set limit dialog */}
      <Dialog open={limitOpen} onOpenChange={setLimitOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Установить лимит сообщений</DialogTitle>
            <DialogDescription>
              Максимум сообщений в день для выбранных профилей ({selectedIds.length}). 0 — без лимита.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="number"
            min={0}
            placeholder="Например, 200"
            value={dayLimit}
            onChange={(e) => setDayLimit(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setLimitOpen(false)}>Отмена</Button>
            <Button onClick={handleSetLimit} disabled={limitMutation.isPending}>
              Применить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTargets.length === 1
                ? "Удалить профиль?"
                : `Удалить профилей: ${deleteTargets.length}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Сессии будут остановлены, а привязка устройств удалена — вернуть номер можно будет
              только новым сканированием QR-кода. История отправок этих профилей тоже пропадёт.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteTargets.some((p) => p.phone) && (
            <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
              {deleteTargets
                .filter((p) => p.phone)
                .map((p) => `+${p.phone}${p.name ? ` (${p.name})` : ""}`)
                .join(", ")}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete)}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
};

export default Accounts;
