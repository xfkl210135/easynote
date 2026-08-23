function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
}

function escapeAttr(value: string): string { return escapeHtml(value).replace(/`/g, "&#96;"); }

let renderSequence = 0;
let mermaidPromise: Promise<(typeof import("mermaid"))["default"]> | null = null;

function loadMermaid() {
  mermaidPromise ||= import("mermaid").then(({ default: instance }) => {
    instance.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      flowchart: { htmlLabels: true, useMaxWidth: true },
      sequence: { useMaxWidth: true },
      theme: "neutral",
    });
    return instance;
  });
  return mermaidPromise;
}

export function renderMermaidBlock(source: string, language = "mermaid"): string {
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  if (!normalized || language.toLowerCase() !== "mermaid") return "";
  return `<div class="mermaid-diagram" contenteditable="false" data-mermaid-source="${escapeAttr(normalized)}"><pre class="mermaid-source">${escapeHtml(normalized)}</pre></div>`;
}

export function mermaidSourceFromElement(element: HTMLElement): string { return element.dataset.mermaidSource || ""; }

export function codeSourceFromBlock(block: HTMLElement): string {
  return (block.innerText || block.textContent || "").replace(/\r\n?/g, "\n");
}

export function prepareMermaidForStorage(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".mermaid-diagram[data-mermaid-source]").forEach((element) => {
    const source = mermaidSourceFromElement(element);
    delete element.dataset.mermaidRenderedSource;
    element.setAttribute("contenteditable", "false");
    element.innerHTML = `<pre class="mermaid-source">${escapeHtml(source)}</pre>`;
  });
}

export function replaceCompletedMermaidFences(root: HTMLElement): boolean {
  let changed = false;
  root.querySelectorAll<HTMLElement>("pre").forEach((block) => {
    const raw = codeSourceFromBlock(block);
    const fenced = raw.match(/^```mermaid\s*\n([\s\S]*?)\n?```\s*$/i);
    const source = fenced?.[1]?.trim() || "";
    if (!source) return;
    const holder = root.ownerDocument.createElement("div"); holder.innerHTML = renderMermaidBlock(source);
    const diagram = holder.firstElementChild; if (!diagram) return;
    block.replaceWith(diagram); changed = true;
  });
  return changed;
}

export function renderMermaidSourceBlock(block: HTMLElement): HTMLElement | null {
  const raw = codeSourceFromBlock(block);
  const fenced = raw.match(/^```mermaid\s*\n([\s\S]*?)\n?```\s*$/i);
  const source = (fenced?.[1] || raw).trim();
  if (!source) return null;
  const holder = block.ownerDocument.createElement("div"); holder.innerHTML = renderMermaidBlock(source);
  const diagram = holder.firstElementChild as HTMLElement | null;
  if (diagram) block.replaceWith(diagram);
  return diagram;
}

export function editMermaidDiagram(element: HTMLElement): HTMLElement | null {
  const source = mermaidSourceFromElement(element); if (!source) return null;
  const block = element.ownerDocument.createElement("pre");
  block.dataset.codeLanguage = "mermaid"; block.textContent = source; element.replaceWith(block); return block;
}

export async function hydrateMermaidDiagrams(root: ParentNode): Promise<void> {
  if ((root as HTMLElement).ownerDocument) replaceCompletedMermaidFences(root as HTMLElement);
  const diagrams = [...root.querySelectorAll<HTMLElement>(".mermaid-diagram[data-mermaid-source]")];
  if (!diagrams.length) return;
  const mermaid = await loadMermaid();
  for (const element of diagrams) {
    const source = mermaidSourceFromElement(element);
    if (!source || element.dataset.mermaidRenderedSource === source) continue;
    element.dataset.mermaidRenderedSource = source;
    element.setAttribute("aria-label", "Mermaid 图表");
    element.setAttribute("role", "img");
    try {
      const id = `easynote-mermaid-${Date.now()}-${renderSequence += 1}`;
      const { svg, bindFunctions } = await mermaid.render(id, source);
      element.innerHTML = svg;
      bindFunctions?.(element);
      element.classList.remove("mermaid-error");
    } catch (error) {
      delete element.dataset.mermaidRenderedSource;
      element.classList.add("mermaid-error");
      element.innerHTML = `<strong>Mermaid 语法错误</strong><pre class="mermaid-source">${escapeHtml(source)}</pre>`;
      console.warn("EasyNote Mermaid render failed", error);
    }
  }
}
