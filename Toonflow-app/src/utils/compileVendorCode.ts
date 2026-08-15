import { transform } from "sucrase";

export default function compileVendorCode(source: string): string {
  const code = transform(source, { transforms: ["typescript"] }).code;

  // Vendor scripts expose their runtime API through `exports`. Some scripts
  // additionally use an empty ESM export only to isolate TypeScript globals,
  // which VM2 script mode cannot parse.
  return code.replace(/(^|\r?\n)\s*export\s*\{\s*\}\s*;?/g, "$1");
}
