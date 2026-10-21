import {
  Folder,
  FolderOpen,
  FileText,
  FolderTree,
  RefreshCw,
  Plus,
  Minus,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommitVertical,
  Terminal,
  Check,
  FolderInput,
  FolderX,
  Copy,
  Pencil,
  X,
  createElement,
} from 'lucide';

// IconNode is the array format used by Lucide
// [tag: string, attrs: SVGProps][]
type IconNode = Parameters<typeof createElement>[0];

const iconRegistry: Record<string, IconNode> = {
  folder: Folder,
  folderOpen: FolderOpen,
  fileText: FileText,
  folderTree: FolderTree,
  refreshCw: RefreshCw,
  plus: Plus,
  minus: Minus,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  gitBranch: GitBranch,
  gitCommitVertical: GitCommitVertical,
  terminal: Terminal,
  check: Check,
  folderInput: FolderInput,
  folderClose: FolderX,
  copy: Copy,
  edit: Pencil,
  x: X,
};

export function getIcon(
  name: string,
  size: number = 16,
  className: string = '',
): string {
  const Icon = iconRegistry[name];
  if (!Icon) {
    console.warn(`Icon "${name}" not found in registry`);
    return '';
  }

  // Create SVG element using lucide's createElement function
  const svgElement = createElement(Icon);

  // Apply size and class
  svgElement.setAttribute('width', String(size));
  svgElement.setAttribute('height', String(size));
  const classes = ['icon', ...className.split(/\s+/).filter(Boolean)];
  svgElement.classList.add(...classes);

  return svgElement.outerHTML;
}

export function createIconElement(
  name: string,
  size: number = 16,
  className: string = '',
): SVGElement {
  const Icon = iconRegistry[name];
  if (!Icon) {
    console.warn(`Icon "${name}" not found in registry`);
    return document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  }

  // Create SVG element using lucide's createElement function
  const svgElement = createElement(Icon);

  // Apply size and class
  svgElement.setAttribute('width', String(size));
  svgElement.setAttribute('height', String(size));
  const classes = ['icon', ...className.split(/\s+/).filter(Boolean)];
  svgElement.classList.add(...classes);

  return svgElement;
}

// Export the registry for direct access if needed
export { iconRegistry };
export type IconName = keyof typeof iconRegistry;
