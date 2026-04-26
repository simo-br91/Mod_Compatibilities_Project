export function createPlatformId(prefix: string, seed?: string): string {
  const suffix = seed ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${suffix}`;
}

