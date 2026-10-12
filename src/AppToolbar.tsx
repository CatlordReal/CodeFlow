import { useEffect, useRef, type ChangeEvent, type KeyboardEvent, type SyntheticEvent } from "react";
import type { RecentProject } from "./api";
import ThemePicker from "./ThemePicker";
import "./AppToolbar.css";

export type AppToolbarProps = {
  language: "cpp" | "csharp";
  onLanguageChange: (language: "cpp" | "csharp") => void;
  recentProjects: RecentProject[];
  onNewProject: () => void;
  onOpen: () => void;
  onOpenRecent: (projectId: string) => void;
  onSaveSource: () => void;
  onSaveProject: () => void;
  onSaveAs: () => void;
  onAnalyze: () => void;
  onExportSvg: () => void;
  onExportPng: () => void;
  onCheckUpdates: () => void;
  transparency: number;
  onTransparencyChange: (value: number) => void;
  recoveryReady: boolean;
  exportReady: boolean;
  updateBusy: boolean;
};

type IconName = "chevron" | "export" | "refresh" | "save" | "update";

function Icon({ name }: { name: IconName }) {
  const paths = {
    chevron: <path d="m8 10 4 4 4-4" />,
    export: <><path d="M12 3v12" /><path d="m7 8 5-5 5 5" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></>,
    refresh: <><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" /></>,
    save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8M7 3v5h8" /></>,
    update: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
  };

  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export default function AppToolbar({
  language,
  onLanguageChange,
  recentProjects,
  onNewProject,
  onOpen,
  onOpenRecent,
  onSaveSource,
  onSaveProject,
  onSaveAs,
  onAnalyze,
  onExportSvg,
  onExportPng,
  onCheckUpdates,
  transparency,
  onTransparencyChange,
  recoveryReady,
  exportReady,
  updateBusy,
}: AppToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  const menus = () => Array.from(toolbarRef.current?.querySelectorAll<HTMLDetailsElement>(":scope > details") ?? []);
  const closeMenus = (except?: HTMLDetailsElement) => {
    for (const menu of menus()) if (menu !== except) menu.open = false;
  };
  const run = (action: () => void) => {
    closeMenus();
    action();
  };

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) closeMenus();
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, []);

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const menu = event.currentTarget;
    if (menu.open) closeMenus(menu);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const openMenu = menus().find((menu) => menu.open);
    if (!openMenu) return;
    event.preventDefault();
    openMenu.open = false;
    openMenu.querySelector<HTMLElement>(":scope > summary")?.focus();
  };

  const changeTransparency = (event: ChangeEvent<HTMLInputElement>) => {
    onTransparencyChange(Number(event.target.value));
  };

  return (
    <header className="topbar app-toolbar" data-tauri-drag-region>
      <div className="brand" aria-label="CodeFlow">
        <span className="brand__mark"><span /> <span /> <span /></span>
        <span>CodeFlow</span>
        <select className="app-toolbar__language" aria-label="Source language" value={language} onChange={(event) => onLanguageChange(event.target.value as "cpp" | "csharp")}>
          <option value="cpp">C++</option>
          <option value="csharp">C#</option>
        </select>
      </div>

      <div className="toolbar app-toolbar__actions" ref={toolbarRef} onKeyDown={handleKeyDown}>
        <details className="app-toolbar__group" onToggle={handleToggle}>
          <summary className="button">Project <Icon name="chevron" /></summary>
          <div className="app-toolbar__menu app-toolbar__menu--project" role="group" aria-label="Project actions">
            <button disabled={!recoveryReady} onClick={() => run(onNewProject)}>New project</button>
            <button disabled={!recoveryReady} onClick={() => run(onOpen)}>Open</button>
            <details className="app-toolbar__recent">
              <summary>Recent projects <Icon name="chevron" /></summary>
              <div aria-label="Recent projects">
                {recentProjects.length ? recentProjects.map((project) => (
                  <button key={project.id} disabled={!recoveryReady} onClick={() => run(() => onOpenRecent(project.id))}>{project.name}</button>
                )) : <span className="app-toolbar__empty">No recent projects</span>}
              </div>
            </details>
            <span className="app-toolbar__divider" />
            <button onClick={() => run(onSaveSource)}>Save {language === "csharp" ? "C#" : "C++"}</button>
            <button onClick={() => run(onSaveAs)}>Save as</button>
          </div>
        </details>

        <details className="app-toolbar__group" onToggle={handleToggle}>
          <summary className="button">Appearance <Icon name="chevron" /></summary>
          <div className="app-toolbar__menu app-toolbar__menu--appearance" aria-label="Appearance settings">
            <ThemePicker />
            <label className="app-toolbar__transparency" title="Window background transparency">
              <span>Transparency</span>
              <input aria-label="Transparency" type="range" min="0" max="80" value={transparency} onChange={changeTransparency} />
              <output>{transparency}%</output>
            </label>
          </div>
        </details>

        <button className="button app-toolbar__save" aria-label="Save project" onClick={onSaveProject} title="Save project (Ctrl/⌘ S)">
          <Icon name="save" /> <span>Save project</span>
        </button>

        <details className="app-toolbar__group" onToggle={handleToggle}>
          <summary className="button button--primary">Export <Icon name="chevron" /></summary>
          <div className="app-toolbar__menu" role="group" aria-label="Export actions">
            <button disabled={!exportReady} onClick={() => run(onExportSvg)}><Icon name="export" /> Export SVG</button>
            <button disabled={!exportReady} onClick={() => run(onExportPng)}>Export PNG</button>
          </div>
        </details>

        <details className="app-toolbar__group app-toolbar__group--end" onToggle={handleToggle}>
          <summary className="button">More <Icon name="chevron" /></summary>
          <div className="app-toolbar__menu" role="group" aria-label="More actions">
            <button onClick={() => run(onAnalyze)} title="Analyze (Ctrl/⌘ Enter)" aria-label="Analyze again"><Icon name="refresh" /> Analyze again</button>
            <button disabled={updateBusy} onClick={() => run(onCheckUpdates)} title="Check for updates" aria-label="Check for updates"><Icon name="update" /> Check for updates</button>
          </div>
        </details>
      </div>
    </header>
  );
}

export { AppToolbar };
