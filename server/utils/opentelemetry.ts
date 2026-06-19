export type GlobalWithOpenTelemetrySdk = typeof globalThis & {
  __coopOpenTelemetrySdk?: { shutdown: () => Promise<void> };
};
