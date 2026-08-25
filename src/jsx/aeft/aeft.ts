/**
 * Nekomitai ExtendScript host API (After Effects side).
 * Every function returns a plain JSON-serializable object with an `ok` flag —
 * evalTS() on the panel side parses it. Never throw across the bridge.
 */

const BIN_NAME = "Nekomitai";

const err = (e: any): { ok: false; error: string } => ({
  ok: false,
  error: String(e && e.message ? e.message : e),
});

const getActiveComp = (): CompItem | null => {
  const item = app.project.activeItem;
  return item && item instanceof CompItem ? item : null;
};

const getBin = (): FolderItem => {
  for (let i = 1; i <= app.project.numItems; i++) {
    const item = app.project.items[i];
    if (item instanceof FolderItem && item.name === BIN_NAME) return item;
  }
  return app.project.items.addFolder(BIN_NAME);
};

/** Liveness + environment probe used by the Diagnostics screen. */
export const ping = () => {
  try {
    return {
      ok: true,
      appVersion: String(app.version),
      build: String(app.buildName),
      projectPath: app.project.file ? app.project.file.fsName : null,
      numItems: app.project.numItems,
    };
  } catch (e) {
    return err(e);
  }
};

/** Project + active comp info (fps/duration feed the sync UI; path keys boards). */
export const getProjectInfo = () => {
  try {
    const comp = getActiveComp();
    return {
      ok: true,
      projectPath: app.project.file ? app.project.file.fsName : null,
      comp: comp
        ? {
            name: comp.name,
            duration: comp.duration,
            frameRate: comp.frameRate,
            width: comp.width,
            height: comp.height,
            time: comp.time,
          }
        : null,
    };
  } catch (e) {
    return err(e);
  }
};

/** Current Time Indicator of the active comp (scrub-sync poll target). */
export const getTime = () => {
  try {
    const comp = getActiveComp();
    if (!comp) return { ok: false, error: "No active composition" };
    return { ok: true, time: comp.time, frameRate: comp.frameRate };
  } catch (e) {
    return err(e);
  }
};

export const setTime = (t: number) => {
  try {
    const comp = getActiveComp();
    if (!comp) return { ok: false, error: "No active composition" };
    comp.time = Math.max(0, Math.min(t, comp.duration));
    return { ok: true, time: comp.time };
  } catch (e) {
    return err(e);
  }
};

/** Comp marker carrying a reference note (video URL + timecode). */
export const addMarker = (t: number, comment: string) => {
  try {
    const comp = getActiveComp();
    if (!comp) return { ok: false, error: "No active composition" };
    app.beginUndoGroup("Nekomitai Marker");
    try {
      const marker = new MarkerValue(comment);
      comp.markerProperty.setValueAtTime(t, marker);
      return { ok: true, time: t };
    } finally {
      app.endUndoGroup();
    }
  } catch (e) {
    return err(e);
  }
};

/** Import a downloaded file into the Nekomitai bin; optionally add to the active comp. */
export const importFootage = (fsPath: string, addToComp: boolean) => {
  try {
    const file = new File(fsPath);
    if (!file.exists) return { ok: false, error: "File not found: " + fsPath };
    app.beginUndoGroup("Nekomitai Import");
    try {
      const io = new ImportOptions(file);
      const item = app.project.importFile(io) as FootageItem;
      item.parentFolder = getBin();
      let addedToComp = false;
      const comp = getActiveComp();
      if (addToComp && comp) {
        comp.layers.add(item);
        addedToComp = true;
      }
      return { ok: true, name: item.name, addedToComp: addedToComp };
    } finally {
      app.endUndoGroup();
    }
  } catch (e) {
    return err(e);
  }
};

/** Comp-sized solid from a picked color (r/g/b as 0–1 floats). */
export const addSolid = (r: number, g: number, b: number, name: string) => {
  try {
    const comp = getActiveComp();
    if (!comp) return { ok: false, error: "No active composition" };
    app.beginUndoGroup("Nekomitai Solid");
    try {
      const layer = comp.layers.addSolid(
        [r, g, b],
        name || "Nekomitai Solid",
        comp.width,
        comp.height,
        comp.pixelAspect,
        comp.duration
      );
      return { ok: true, name: layer.name };
    } finally {
      app.endUndoGroup();
    }
  } catch (e) {
    return err(e);
  }
};
