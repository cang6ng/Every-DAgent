import type { Metafile } from "esbuild";

export interface BuildAppOptions {
  readonly packageRoot?: string;
  readonly outDir?: string;
  readonly quiet?: boolean;
}

export interface BuildAppResult {
  readonly outDir: string;
  readonly browserMetafile: Metafile;
  readonly serverMetafile: Metafile;
}

/** Builds the browser bundle, the server bundle and the static page into `outDir`. */
export function buildApp(options?: BuildAppOptions): Promise<BuildAppResult>;
