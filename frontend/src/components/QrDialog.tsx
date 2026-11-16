import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, CheckCircle2, RefreshCw, AlertTriangle, Copy } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import { formatCountdown } from "@/lib/utils";
import { toast } from "sonner";
import { WhatsAppProfile } from "@/types";

interface QrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Live profile row; the QR itself arrives over the WebSocket. */
  profile: WhatsAppProfile | null | undefined;
}

/**
 * The dialog opens while the backend is still starting the browser, so the row
 * still reads "not running". Wait this long before calling a handshake dead.
 */
const STARTUP_GRACE_MS = 6000;

export function QrDialog({ open, onOpenChange, profile }: QrDialogProps) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [openedAt, setOpenedAt] = useState(() => Date.now());

  const id = profile?.id ?? null;
  const connected = profile?.status === "CONNECTED";
  const expiresAt = profile?.qrExpiresAt ?? null;
  const msLeft = expiresAt ? expiresAt - now : null;

  // The handshake is over when the server dropped the browser without linking a
  // phone — either the window elapsed or the launch failed outright.
  const expired =
    !connected &&
    !profile?.qr &&
    profile?.running === false &&
    profile?.status !== "CONNECTING" &&
    now - openedAt > STARTUP_GRACE_MS;

  useEffect(() => {
    if (!open) return;
    setOpenedAt(Date.now());
    setNow(Date.now());
  }, [open, id]);

  useEffect(() => {
    if (!open || connected) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, connected]);

  const refreshMutation = useMutation({
    mutationFn: (accountId: string) =>
      apiRequest(`/accounts/${accountId}/refresh-qr`, { method: "POST" }),
    onSuccess: () => {
      setOpenedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.info("Генерируем новый код...");
    },
    onError: (err: any) => toast.error(err.message || "Не удалось обновить код")
  });

  // A shared link has to keep working after this dialog closes, so the profile
  // stops being a throwaway draft the moment its link leaves the room.
  const keepMutation = useMutation({
    mutationFn: (accountId: string) =>
      apiRequest(`/accounts/${accountId}`, {
        method: "PATCH",
        body: JSON.stringify({ draft: false })
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    }
  });

  const inviteLink = id ? `${window.location.origin}/connect/${id}` : "";

  // navigator.clipboard is undefined outside a secure context (plain HTTP on a
  // non-localhost host, common for a self-hosted deploy). The fallback has to
  // mount its textarea INSIDE the dialog: Radix traps focus in the modal, so a
  // textarea appended to <body> can never take focus and execCommand copies
  // nothing.
  const writeToClipboard = async (text: string, host: HTMLElement) => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // permission denied — fall through to the legacy path
      }
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    host.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    host.removeChild(textarea);
    if (!ok) throw new Error("execCommand copy failed");
  };

  const copyInviteLink = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!inviteLink || !id) return;
    // Sharing the link is what makes the profile permanent, whether or not the
    // clipboard cooperates — the operator can still copy it from the field.
    if (profile?.isDraft) {
      keepMutation.mutate(id);
    }
    try {
      await writeToClipboard(inviteLink, e.currentTarget.parentElement ?? document.body);
    } catch {
      toast.error("Не удалось скопировать автоматически — скопируйте ссылку из поля ниже");
      return;
    }
    toast.success("Ссылка скопирована — профиль сохранён до сканирования");
  };

  // Closing the dialog must NOT touch the session: the QR stays scannable (the
  // server tears the browser down on its own when the QR window ends), and a
  // phone that was scanned a moment ago still finishes linking in the background.
  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Авторизовать WhatsApp</DialogTitle>
          <DialogDescription>
            {connected
              ? "Профиль подключен."
              : "Отсканируйте QR-код в мобильном приложении WhatsApp."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center justify-center p-4">
          {connected ? (
            <div className="flex flex-col items-center gap-2 py-10">
              <CheckCircle2 className="h-16 w-16 text-wa-green" />
              <p className="font-medium">
                {profile?.phone ? `+${profile.phone}` : "WhatsApp"} подключен
              </p>
              {profile?.name && (
                <p className="text-sm text-muted-foreground">{profile.name}</p>
              )}
            </div>
          ) : expired ? (
            <div className="h-64 w-64 border-2 border-dashed border-destructive/40 rounded-lg flex flex-col items-center justify-center text-sm p-4 text-center gap-3">
              <AlertTriangle className="h-8 w-8 text-destructive" />
              <p className="text-muted-foreground">
                {profile?.lastError || "QR-код устарел — его никто не отсканировал."}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={!id || refreshMutation.isPending}
                onClick={() => id && refreshMutation.mutate(id)}
              >
                {refreshMutation.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                )}
                Обновить код
              </Button>
            </div>
          ) : profile?.qr ? (
            <>
              <div className="border p-2 bg-white rounded-lg">
                <img
                  src={profile.qr}
                  alt="WhatsApp QR Code"
                  className="h-64 w-64 object-contain"
                />
              </div>
              {msLeft !== null && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Действителен ещё {formatCountdown(msLeft)}
                </p>
              )}
            </>
          ) : (
            <div className="h-64 w-64 border-2 border-dashed border-muted-foreground/30 rounded-lg flex flex-col items-center justify-center text-muted-foreground text-sm p-4 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary mb-2" />
              Запускаем сессию и генерируем QR-код...
            </div>
          )}

          {!connected && (
            <>
              <div className="mt-4 space-y-2 text-xs text-muted-foreground">
                <p>1. Откройте WhatsApp на телефоне.</p>
                <p>2. Нажмите Меню (три точки) или Настройки &rarr; Связанные устройства.</p>
                <p>3. Нажмите "Привязка устройства" и наведите на этот код.</p>
              </div>
              <div className="mt-3 w-full">
                <p className="text-xs text-muted-foreground text-center mb-1">
                  Подключает чужой WhatsApp? Отправьте ссылку — тот же QR откроется у него.
                </p>
                <Button variant="outline" size="sm" className="w-full" onClick={copyInviteLink}>
                  <Copy className="mr-2 h-3.5 w-3.5" />
                  Скопировать ссылку для отправки
                </Button>
                <Input
                  readOnly
                  value={inviteLink}
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.currentTarget.select()}
                  className="mt-2 h-8 text-xs"
                />
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground text-center">
                {profile?.isDraft
                  ? "Окно можно закрыть — QR останется доступен в списке профилей. Если его не отсканировать, профиль удалится сам."
                  : "Окно можно закрыть — QR останется доступен, пока не истечёт время."}
              </p>
            </>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => handleOpenChange(false)} className="w-full">
            {connected ? "Готово" : "Закрыть"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
