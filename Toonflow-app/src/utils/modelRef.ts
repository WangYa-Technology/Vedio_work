export interface ModelReference {
  vendorId: string;
  modelName: string;
}

/**
 * Model names may contain colons (for example, a provider tier suffix).
 * Only the first colon belongs to the vendor/model boundary.
 */
export function parseModelReference(value: unknown): ModelReference {
  const normalized = String(value ?? "").trim();
  const separator = normalized.indexOf(":");
  if (separator < 1) {
    return { vendorId: normalized, modelName: "" };
  }
  return {
    vendorId: normalized.slice(0, separator),
    modelName: normalized.slice(separator + 1),
  };
}

export function formatModelReference(reference: ModelReference): string {
  return reference.vendorId && reference.modelName
    ? `${reference.vendorId}:${reference.modelName}`
    : reference.vendorId;
}
