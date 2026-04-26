/** Join class names, filtering out falsy values. */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

/** Map a finding severity to Tailwind utility classes. */
export function severityClass(severity: string): string {
  switch (severity.toLowerCase()) {
    case "critical":
      return "severity-critical";
    case "high":
      return "severity-high";
    case "medium":
      return "severity-medium";
    case "low":
      return "severity-low";
    default:
      return "severity-info";
  }
}

/** Map a release-gate status to a colour. */
export function gateStatusClass(status: string): string {
  switch (status) {
    case "pass":
      return "text-green-700 bg-green-50 border-green-200";
    case "warn":
      return "text-yellow-700 bg-yellow-50 border-yellow-200";
    case "block":
      return "text-red-700 bg-red-50 border-red-200";
    default:
      return "text-gray-600 bg-gray-50 border-gray-200";
  }
}

/** Format ISO timestamp to locale string. */
export function fmtDate(iso: string | undefined): string {
  if (!iso) {
    return "n/a";
  }

  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Capitalise the first letter. */
export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
