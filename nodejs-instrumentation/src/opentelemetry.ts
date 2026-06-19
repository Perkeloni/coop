import { type NodeSDK } from '@opentelemetry/sdk-node';

export type GlobalWithOpenTelemetrySdk = typeof globalThis & {
  __coopOpenTelemetrySdk?: Pick<NodeSDK, 'shutdown'>;
};
