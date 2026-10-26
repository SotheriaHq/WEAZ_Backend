import { v5 as uuidv5, validate as validateUuid } from 'uuid';

export function assertNotificationIdentity(id?: string, namespace?: string) {
  if (id && namespace)
    throw new Error('Use one notification identity strategy');
  if (namespace && !validateUuid(namespace))
    throw new Error('Invalid notification namespace');
}

export function recipientNotificationId(
  namespace: string,
  recipientId: string,
) {
  return uuidv5(recipientId, namespace);
}

export function productPublicationNamespace(productId: string) {
  return uuidv5(`product-first-publication:${productId}`, uuidv5.URL);
}
