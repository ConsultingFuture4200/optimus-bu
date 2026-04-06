import { marked, type Tokens } from "marked";
import DOMPurify from "isomorphic-dompurify";

// Downshift headings by 2 levels so # → <h3>, ## → <h4>
// Prevents conflict with page <h1> "Board Workstation"
const renderer = new marked.Renderer();
renderer.heading = function ({ tokens, depth }: Tokens.Heading) {
  const shifted = Math.min(depth + 2, 6);
  const text = this.parser.parseInline(tokens);
  return `<h${shifted}>${text}</h${shifted}>\n`;
};

marked.setOptions({ renderer, breaks: true });

export function markdownToHtml(md: string): string {
  return DOMPurify.sanitize(marked.parse(md) as string);
}
