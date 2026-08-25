/**
 * Boards screen — per-project reference bookmarks. Clicking an item opens it in
 * the browser via the shared 'nm:open' window event.
 */
import { useEffect, useState } from "react";
import type { GatewayInfo } from "../../lib/gateway/server";
import {
  Board,
  BoardsFile,
  GLOBAL_KEY,
  loadBoards,
  saveBoards,
  newId,
} from "../../lib/boards";
import { aeProjectInfo } from "../../lib/ae";

export const openInBrowser = (url: string) =>
  window.dispatchEvent(new CustomEvent("nm:open", { detail: url }));

export const Boards = ({ gateway }: { gateway: GatewayInfo | null }) => {
  const [all, setAll] = useState<BoardsFile>({});
  const [projectKey, setProjectKey] = useState<string>(GLOBAL_KEY);
  const [projectName, setProjectName] = useState<string>("No project");

  useEffect(() => {
    if (!gateway) return;
    loadBoards(gateway).then(setAll);
    aeProjectInfo().then((r) => {
      if (r.ok && r.projectPath) {
        setProjectKey(r.projectPath);
        setProjectName(r.projectPath.split(/[\\/]/).pop() || r.projectPath);
      }
    });
  }, [gateway]);

  const boards: Board[] = all[projectKey] || [];

  const persist = (next: Board[]) => {
    const data = { ...all, [projectKey]: next };
    setAll(data);
    if (gateway) saveBoards(gateway, data);
  };

  const addBoard = () => {
    const name = prompt("New board name:", "References");
    if (!name) return;
    persist([...boards, { id: newId(), name, items: [] }]);
  };

  const removeBoard = (id: string) =>
    persist(boards.filter((b) => b.id !== id));

  const removeItem = (boardId: string, url: string) =>
    persist(
      boards.map((b) =>
        b.id === boardId ? { ...b, items: b.items.filter((i) => i.url !== url) } : b
      )
    );

  if (!gateway)
    return (
      <div className="nm-placeholder">
        <h2>Boards</h2>
        <p>Waiting for the Gateway…</p>
      </div>
    );

  return (
    <div className="nm-boards">
      <div className="nm-boards-head">
        <div>
          <h2>Reference boards</h2>
          <span className="nm-hint">Project: {projectName}</span>
        </div>
        <button onClick={addBoard}>+ New board</button>
      </div>

      {boards.length === 0 && (
        <div className="nm-placeholder">
          <p>
            No boards for this project yet. Create one, then use ☆ in the
            browser to save pages and videos here.
          </p>
        </div>
      )}

      {boards.map((b) => (
        <section key={b.id} className="nm-board">
          <div className="nm-board-title">
            <strong>{b.name}</strong>
            <span className="nm-hint">{b.items.length}</span>
            <button className="nm-board-del" onClick={() => removeBoard(b.id)}>
              Delete
            </button>
          </div>
          <div className="nm-board-grid">
            {b.items.map((it) => (
              <div key={it.url} className="nm-card-item" title={it.url}>
                <div
                  className="nm-thumb"
                  onClick={() => openInBrowser(it.url)}
                  role="button"
                >
                  {it.thumb ? (
                    <img src={it.thumb} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                  ) : (
                    <span>{it.title.slice(0, 1).toUpperCase()}</span>
                  )}
                </div>
                <div className="nm-card-label">
                  <span onClick={() => openInBrowser(it.url)}>{it.title}</span>
                  <button onClick={() => removeItem(b.id, it.url)} aria-label="Remove">
                    ×
                  </button>
                </div>
              </div>
            ))}
            {b.items.length === 0 && (
              <span className="nm-hint">Empty — save pages here with ☆</span>
            )}
          </div>
        </section>
      ))}
    </div>
  );
};
