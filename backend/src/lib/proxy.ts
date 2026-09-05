export interface ParsedProxy {
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const SUPPORTED_PROTOCOLS = ["http", "https", "socks4", "socks5"];

function build(
  protocol: string,
  host: string,
  port: string,
  username?: string,
  password?: string
): ParsedProxy | null {
  const cleanHost = host.trim();
  const portNum = Number(port);

  if (!cleanHost || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return null;
  }
  if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
    return null;
  }

  return {
    protocol,
    host: cleanHost,
    port: portNum,
    ...(username ? { username } : {}),
    ...(password ? { password } : {})
  };
}

/**
 * Accepts every proxy notation used across the app:
 *   host:port
 *   host:port:username:password
 *   scheme://host:port
 *   scheme://username:password@host:port
 * Returns null when the string can't be understood.
 */
export function parseProxy(raw: string | null | undefined): ParsedProxy | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  const schemeMatch = value.match(/^([a-z0-9+.-]+):\/\/(.*)$/i);
  if (schemeMatch) {
    const protocol = schemeMatch[1].toLowerCase();
    const rest = schemeMatch[2];

    // Credentials are separated by the LAST "@" so passwords may contain "@".
    const at = rest.lastIndexOf("@");
    const credentials = at === -1 ? "" : rest.slice(0, at);
    const address = at === -1 ? rest : rest.slice(at + 1);

    const [host, port] = address.split(":");
    if (!port) return null;

    const sep = credentials.indexOf(":");
    const username = sep === -1 ? credentials : credentials.slice(0, sep);
    const password = sep === -1 ? "" : credentials.slice(sep + 1);

    return build(protocol, host, port, username || undefined, password || undefined);
  }

  const parts = value.split(":").map((p) => p.trim());
  if (parts.length === 2) {
    return build("http", parts[0], parts[1]);
  }
  if (parts.length === 4) {
    return build("http", parts[0], parts[1], parts[2] || undefined, parts[3] || undefined);
  }

  return null;
}

/** The value handed to Chrome's --proxy-server flag. */
export function proxyServerArg(proxy: ParsedProxy): string {
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
}

/** Human-readable form with the password masked, safe to show in the UI. */
export function maskProxy(raw: string | null | undefined): string {
  const parsed = parseProxy(raw);
  if (!parsed) return raw?.trim() || "";
  const auth = parsed.username ? `${parsed.username}:***@` : "";
  return `${parsed.protocol}://${auth}${parsed.host}:${parsed.port}`;
}
