/**
 * The two-letter mark that stands for a product or a team wherever there is no
 * room to spell it: the icon rail's switcher, the settings tables, the faces on
 * a sign-in row. Deriving it is nobody's shell work, and three surfaces outside
 * the rail read it, so it answers for itself here.
 */
import type { Project } from "../../lib/web-client";

/**
 * The icon rail's two-letter project mark, derived from the product's
 * hostname: the first letter of the leftmost distinguishing label, then the
 * first letter of the registrable domain — the TLD supplies the second letter
 * when there is no subdomain (shop.northwind.example → SN, northwind.example → NE).
 */
export function projectMark(project: Pick<Project, "name" | "productionUrl"> | null): string {
  if (!project) return "–";
  const source = project.productionUrl ?? project.name;
  let host = source;
  try {
    host = new URL(source).hostname;
  } catch {
    // The project name may already be a bare hostname.
  }
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels[0] === "www") labels.shift();
  const first = labels.at(0);
  const second = labels.length >= 3 ? labels.at(-2) : labels.at(1);
  if (first && second) return (first.charAt(0) + second.charAt(0)).toUpperCase();
  return (host.slice(0, 2) || "–").toUpperCase();
}

/** The same mark for a team, from the words of its name (Northwind QA → NQ). */
export function teamMark(name: string): string {
  const words = name.split(/\s+/u).filter(Boolean);
  const first = words[0] ?? "";
  const second = words[1];
  return ((second ? first.slice(0, 1) + second.slice(0, 1) : first.slice(0, 2)) || "–").toUpperCase();
}
