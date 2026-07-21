import { boardDisplayName, boardTagName } from "../circuit.js";
import { componentRegistry, type ComponentCategory } from "../component-registry.js";

// Right-click "Boards" / "Sensors" / "Connections" submenus, each one
// entry per registered type (boardTagName/boardDisplayName in circuit.ts
// for boards, componentRegistry in component-registry.ts for the other
// two) - a new board or component type is automatically listed here too,
// no separate menu registry to maintain. Built fresh on each open (no
// persistent element to keep in sync); submenus are nested DOM (not a
// second popup) shown via CSS :hover (style.css's .context-submenu), the
// standard flyout-menu convention.

// A menu row either runs an action (a leaf, e.g. one board/component
// type) or opens a nested list (a category header like "Boards") - not
// both, so building the DOM from this doesn't need to guess which one a
// given entry is.
export interface MenuEntry {
  label: string;
  onSelect?: () => void;
  submenu?: MenuEntry[];
}

function boardMenuEntries(onAddBoard: (type: string) => void): MenuEntry[] {
  return Object.keys(boardTagName).map((type) => ({
    label: boardDisplayName[type] ?? type,
    onSelect: () => onAddBoard(type),
  }));
}

function componentMenuEntries(
  category: ComponentCategory,
  onAddComponent: (type: string) => void,
): MenuEntry[] {
  return Object.entries(componentRegistry)
    .filter(([, def]) => def.category === category)
    .map(([type, def]) => ({
      label: def.displayName,
      onSelect: () => onAddComponent(type),
    }));
}

// Flips a submenu to open on whichever side of its parent row actually
// has room, instead of always flying out to the right - a submenu whose
// parent row sits near the right edge of the window would otherwise run
// off-screen (the bug this exists to fix). Called on every hover rather
// than once at menu-build time because .context-submenu is display:none
// until :hover applies (style.css) - getBoundingClientRect() on a
// display:none element reports zero size, so there's nothing correct to
// measure before the row is actually hovered.
function positionSubmenu(row: HTMLElement, submenu: HTMLElement): void {
  const rowRect = row.getBoundingClientRect();
  const submenuRect = submenu.getBoundingClientRect();
  submenu.classList.toggle("open-left", rowRect.right + submenuRect.width > window.innerWidth);
  submenu.classList.toggle("open-up", rowRect.top + submenuRect.height > window.innerHeight);
}

function buildMenuDom(entries: MenuEntry[], onAnySelect: () => void): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "context-menu";
  for (const entry of entries) {
    if (entry.submenu) {
      const row = document.createElement("div");
      row.className = "context-menu-item has-submenu";
      const label = document.createElement("span");
      label.textContent = entry.label;
      const arrow = document.createElement("span");
      arrow.className = "submenu-arrow";
      arrow.textContent = "▸";
      row.append(label, arrow);
      const submenu = buildMenuDom(entry.submenu, onAnySelect);
      // Same base look as a top-level menu (.context-menu), plus
      // .context-submenu for the CSS that positions it as a flyout,
      // hidden until the row is hovered (style.css). Defaults to
      // opening right/down; positionSubmenu() flips either direction
      // that would run off-screen, re-checked on every hover since the
      // window can be resized while the menu isn't even open.
      submenu.classList.add("context-submenu");
      row.appendChild(submenu);
      row.addEventListener("mouseenter", () => positionSubmenu(row, submenu));
      menu.appendChild(row);
    } else {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "context-menu-item";
      row.textContent = entry.label;
      row.addEventListener("click", () => {
        entry.onSelect?.();
        onAnySelect();
      });
      menu.appendChild(row);
    }
  }
  return menu;
}

export class ContextMenu {
  private el: HTMLElement | null = null;

  constructor(
    private readonly onAddBoard: (type: string, x: number, y: number) => void,
    private readonly onAddComponent: (type: string, x: number, y: number) => void,
  ) {
    window.addEventListener("mousedown", (ev) => {
      if (this.el && !this.el.contains(ev.target as Node)) this.close();
    });
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") this.close();
    });
  }

  close(): void {
    this.el?.remove();
    this.el = null;
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(clientX: number, clientY: number, worldX: number, worldY: number): void {
    this.close();

    const entries: MenuEntry[] = [
      { label: "Boards", submenu: boardMenuEntries((type) => this.onAddBoard(type, worldX, worldY)) },
      {
        label: "Sensors",
        submenu: componentMenuEntries("sensors", (type) => this.onAddComponent(type, worldX, worldY)),
      },
      {
        label: "Connections",
        submenu: componentMenuEntries("connections", (type) => this.onAddComponent(type, worldX, worldY)),
      },
    ];

    const menu = buildMenuDom(entries, () => this.close());
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    document.body.appendChild(menu);
    this.el = menu;

    // Clamps the top-level menu itself into the viewport - a right-click
    // near the window's right/bottom edge would otherwise still open at
    // exactly the cursor position and run off-screen, the same class of
    // bug positionSubmenu() fixes for nested submenus.
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(0, window.innerWidth - rect.width)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(0, window.innerHeight - rect.height)}px`;
    }
  }
}
