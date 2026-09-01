import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WS_URL } from "@/lib/api";
import { toast } from "sonner";
import { WhatsAppProfile } from "@/types";

const WebSocketContext = createContext<WebSocket | null>(null);

export const WebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryCountRef = useRef(0);
  const [socket, setSocket] = useState<WebSocket | null>(null);

  useEffect(() => {
    function connect() {
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        return;
      }

      console.log(`[WS] Connecting to ${WS_URL}...`);
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[WS] Connected to backend");
        retryCountRef.current = 0; // Reset retry count on success
        setSocket(ws);
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          
          if (payload.type === "qr") {
            queryClient.setQueryData<WhatsAppProfile[]>(["accounts"], (old) => {
              if (!old) return old;
              return old.map((acc) =>
                acc.phone === payload.phone
                  ? { ...acc, qr: payload.qr, status: "CONNECTING" }
                  : acc
              );
            });
          } else if (payload.type === "status") {
            queryClient.setQueryData<WhatsAppProfile[]>(["accounts"], (old) => {
              if (!old) return old;
              
              const existingAccount = old.find((acc) => acc.phone === payload.phone);
              if (existingAccount && existingAccount.status !== payload.status) {
                if (payload.status === "CONNECTED") {
                  toast.success(`Аккаунт ${payload.phone} подключен`);
                } else if (payload.status === "DISCONNECTED") {
                  toast.info(`Аккаунт ${payload.phone} отключен`);
                } else if (payload.status === "BANNED") {
                  toast.error(`Аккаунт ${payload.phone} заблокирован!`);
                }
              }

              return old.map((acc) =>
                acc.phone === payload.phone
                  ? {
                      ...acc,
                      status: payload.status,
                      qr: payload.status === "CONNECTED" ? null : acc.qr
                    }
                  : acc
              );
            });
          }
        } catch (err) {
          console.error("[WS] Message parsing error:", err);
        }
      };

      ws.onclose = () => {
        console.log("[WS] Connection closed. Retrying...");
        wsRef.current = null;
        setSocket(null);

        // Exponential backoff capped at 16s
        const backoff = Math.min(1000 * Math.pow(2, retryCountRef.current), 16000);
        retryCountRef.current += 1;
        
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, backoff);
      };

      ws.onerror = (error) => {
        console.error("[WS] Socket error:", error);
      };
    }

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on cleanup unmount
        wsRef.current.close();
      }
    };
  }, [queryClient]);

  return (
    <WebSocketContext.Provider value={socket}>
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocket = () => useContext(WebSocketContext);
