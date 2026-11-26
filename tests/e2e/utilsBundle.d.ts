// playwright-core ships pngjs inside its bundled utils module; no type
// declarations ship with it, and no new dependency is added.
declare module "playwright-core/lib/utilsBundle" {
  export interface DecodedPng {
    width: number;
    height: number;
    /** RGBA bytes, 4 per pixel, row-major. */
    data: Uint8Array;
  }
  export const PNG: {
    sync: {
      read(buffer: Uint8Array): DecodedPng;
    };
  };
}
