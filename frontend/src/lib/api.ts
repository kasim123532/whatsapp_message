const isDev = import.meta.env.DEV;

export const API_URL = import.meta.env.VITE_API_URL || (isDev ? "http://localhost:5000/api" : `${window.location.origin}/api`);
export const WS_URL = import.meta.env.VITE_WS_URL || (isDev ? "ws://localhost:5000" : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`);

const TOKEN_KEY = "wa_auth_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable — the session just won't survive a reload
  }
}

/** Headers every dashboard request needs (JSON + the login token). */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

// Helper fetch wrappers
export async function apiRequest(path: string, options?: RequestInit) {
  const url = `${API_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options?.headers || {})
    }
  });

  if (response.status === 401 && getToken()) {
    // The token expired or the password changed — send the user back to login.
    setToken(null);
    window.dispatchEvent(new Event("auth-expired"));
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
  }

  return response.json();
}
