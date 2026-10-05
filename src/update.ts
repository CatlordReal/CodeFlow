export const LATEST_RELEASE_URL = "https://github.com/CatlordReal/CodeFlow/releases/latest";

const NETWORK_ERROR_MARKERS = [
  "certificate",
  "connection",
  "dns",
  "error sending request",
  "network",
  "proxy",
  "timed out",
  "timeout",
  "tls",
];

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Unknown error";
}

export function formatUpdaterError(cause: unknown): string {
  const detail = errorMessage(cause);
  const normalized = detail.toLowerCase();
  if (!NETWORK_ERROR_MARKERS.some((marker) => normalized.includes(marker))) return detail;

  return `Could not reach GitHub. Check your internet, proxy, or firewall, then retry. Manual download: ${LATEST_RELEASE_URL}. Technical detail: ${detail}`;
}
