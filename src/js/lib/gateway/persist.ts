/**
 * Tiny JSON persistence for panel state (open tabs, reference boards), stored
 * under the per-user data folder. Never written into the extension install dir
 * (read-only + wiped on update).
 */
import { fs, path, os } from "../cep/node";

const dataDir = (): string => {
  const base =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));
  const dir = path.join(base, "Nekomitai", "state");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const fileFor = (name: string) =>
  path.join(dataDir(), name.replace(/[^a-z0-9_-]/gi, "_") + ".json");

export const readJson = (name: string): any => {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), "utf8"));
  } catch {
    return null;
  }
};

export const writeJson = (name: string, value: any): boolean => {
  try {
    fs.writeFileSync(fileFor(name), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};
