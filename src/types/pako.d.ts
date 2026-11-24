/** The part of pako 1.x (a dependency of utif2) that the TIFF import uses. */
declare module 'pako' {
  export function deflate(data: Uint8Array): Uint8Array;
  export class Inflate {
    constructor(options?: { raw?: boolean; chunkSize?: number });
    push(data: Uint8Array, mode?: boolean | number): boolean;
    onData: (chunk: Uint8Array) => void;
    onEnd: (status: number) => void;
    err: number;
    msg: string;
  }
  export function inflateRaw(data: Uint8Array): Uint8Array;
  const pako: { Inflate: typeof Inflate; inflateRaw: typeof inflateRaw; deflate: typeof deflate };
  export default pako;
}
