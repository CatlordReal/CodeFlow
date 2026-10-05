import { invoke } from "@tauri-apps/api/core";
import type { FlowGraph, FunctionInfo } from "./types";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function inspectCpp(source: string): Promise<FunctionInfo[]> {
  if (isTauri()) {
    return invoke<FunctionInfo[]>("inspect_cpp", { source });
  }
  return previewFunctions(source);
}

export async function analyzeCpp(
  source: string,
  functionId: string,
  includeComments: boolean,
): Promise<FlowGraph> {
  if (isTauri()) {
    return invoke<FlowGraph>("analyze_cpp", { source, functionId, includeComments });
  }
  return previewGraph(source, includeComments);
}

export async function saveDocument(
  name: string,
  contents: string,
  extension: "cpp" | "svg" | "codeflow",
): Promise<boolean> {
  const hasExtension = extension === "cpp"
    ? /\.(?:cpp|cc|cxx|h|hh|hpp|hxx)$/i.test(name)
    : name.toLowerCase().endsWith(`.${extension}`);
  const fileName = hasExtension ? name : `${name}.${extension}`;
  if (isTauri()) {
    return invoke<boolean>("save_document", { name: fileName, contents, extension });
  }
  const mime = extension === "svg" ? "image/svg+xml" : "text/x-c++src;charset=utf-8";
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function previewFunctions(source: string): FunctionInfo[] {
  const match = /(?:^|\n)\s*[\w:<>,*&\s]+\s+(\w+)\s*\([^;{}]*\)\s*\{/m.exec(source);
  if (!match || match.index === undefined) return [];
  const line = source.slice(0, match.index).split("\n").length;
  return [{ id: `preview:${match.index}`, name: match[1], line }];
}

function previewGraph(source: string, includeComments: boolean): FlowGraph {
  const lines = source.split("\n");
  const firstByte = (needle: string) => new TextEncoder().encode(source.slice(0, Math.max(0, source.indexOf(needle)))).length;
  const node = (
    id: string,
    label: string,
    kind: string,
    needle: string,
    comments: string[] = [],
  ) => {
    const index = Math.max(0, source.indexOf(needle));
    return {
      id,
      label,
      kind,
      line: source.slice(0, index).split("\n").length,
      start_byte: firstByte(needle),
      end_byte: firstByte(needle) + new TextEncoder().encode(needle).length,
      comments: includeComments ? comments : [],
    };
  };
  const loopText = lines.find((line) => line.includes("for ("))?.trim() ?? "for each value";
  const conditionText = lines.find((line) => line.includes("if ("))?.trim().replace(/\s*\{\s*$/, "") ?? "value > 0";
  return {
    nodes: [
      node("start", "Start", "start", "{"),
      node("loop", loopText, "decision", loopText, ["Scan each value."]),
      node("check", conditionText, "decision", conditionText),
      node("found", "return value", "return", "return value"),
      node("fallback", "return 0", "return", "return 0"),
    ],
    edges: [
      { id: "e1", source: "start", target: "loop", label: "" },
      { id: "e2", source: "loop", target: "check", label: "Next" },
      { id: "e3", source: "check", target: "found", label: "Yes" },
      { id: "e4", source: "check", target: "loop", label: "No" },
      { id: "e5", source: "loop", target: "fallback", label: "Done" },
    ],
    diagnostics: ["Browser preview uses a simplified sample graph. Desktop builds use the C++ analyzer."],
  };
}
