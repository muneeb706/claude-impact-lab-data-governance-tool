import { CUSTOM_POLICY_PREFIX } from './types';

export const CUSTOM_POLICY_CODE_PATTERN = /^custom\.[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/** "Export lab notebooks" -> "custom.export_lab_notebooks" (empty string if the name has no usable characters). */
export function slugifyPolicyCode(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug ? CUSTOM_POLICY_PREFIX + slug : '';
}
