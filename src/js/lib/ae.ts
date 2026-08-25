/**
 * Typed wrappers over the ExtendScript host API (see src/jsx/aeft/aeft.ts).
 * Each returns the host's { ok, ... } object; callers check `ok`.
 */
import { evalTS } from "./utils/bolt";

export type AeResult<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

const call = <T = {}>(fn: string, ...args: any[]): Promise<AeResult<T>> =>
  (evalTS as any)(fn, ...args).catch((e: any) => ({
    ok: false,
    error: String(e && e.message ? e.message : e),
  }));

export const aeGetTime = () =>
  call<{ time: number; frameRate: number }>("getTime");

export const aeSetTime = (t: number) => call<{ time: number }>("setTime", t);

export const aeAddMarker = (t: number, comment: string) =>
  call<{ time: number }>("addMarker", t, comment);

export const aeImportFootage = (fsPath: string, addToComp: boolean) =>
  call<{ name: string; addedToComp: boolean }>(
    "importFootage",
    fsPath,
    addToComp
  );

export const aeAddSolid = (r: number, g: number, b: number, name: string) =>
  call<{ name: string }>("addSolid", r, g, b, name);

export const aeProjectInfo = () =>
  call<{ projectPath: string | null; comp: any }>("getProjectInfo");
