// Minimal independent XML reader for the ISOXML round-trip test (task 7.3).
// Not a general XML parser — just enough to count elements and read
// attributes on the flat, self-closing/simple-nesting TASKDATA.XML this
// project generates. Deliberately not shared with src/exports/isoxml.ts's
// string templating, per the same "independent relecture" principle as
// tests/exports-shp-reader.ts (design.md D8).
export interface XmlTag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
}

export function parseTags(xml: string): XmlTag[] {
  const tags: XmlTag[] = [];
  const tagRe = /<([A-Za-z0-9_]+)((?:\s+[A-Za-z0-9_]+="[^"]*")*)\s*(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xml)) !== null) {
    const [, name, attrText, selfClose] = match;
    const attrs: Record<string, string> = {};
    const attrRe = /([A-Za-z0-9_]+)="([^"]*)"/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(attrText!)) !== null) {
      attrs[attrMatch[1]!] = attrMatch[2]!
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
    }
    tags.push({ name: name!, attrs, selfClosing: selfClose === "/" });
  }
  return tags;
}

export function countTag(tags: XmlTag[], name: string): number {
  return tags.filter((t) => t.name === name).length;
}
