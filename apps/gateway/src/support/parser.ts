import { z } from "zod";

export interface ParsedHeader {
  intent: string;
  confidence: number;
}

export interface ParserPushResult {
  deltas: string[];
  header: ParsedHeader | null;
  badHeader: boolean;
}

const headerSchema = z.object({
  intent: z.string().min(1).max(100),
  confidence: z.coerce.number().min(0).max(1),
});

function parseHeaderLine(line: string): ParsedHeader | null {
  try {
    const parsed = headerSchema.safeParse(JSON.parse(line));
    if (!parsed.success) return null;
    return { intent: parsed.data.intent, confidence: parsed.data.confidence };
  } catch {
    return null;
  }
}

export class ChunkParser {
  header: ParsedHeader | null = null;
  private buf = "";
  private headerDone = false;
  private badHeaderFlag = false;
  private separatorSeen = false;
  private answerStarted = false;


  get badHeader(): boolean {
    return this.badHeaderFlag;
  }

  push(text: string): ParserPushResult {
    const deltas: string[] = [];
    if (this.badHeaderFlag) {
      return { deltas, header: null, badHeader: true };
    }
    this.buf += text;

    if (!this.headerDone) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) {
        return { deltas, header: null, badHeader: false };
      }
      const headerLine = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      const parsed = parseHeaderLine(headerLine);
      if (!parsed) {
        this.badHeaderFlag = true;
        return { deltas, header: null, badHeader: true };
      }
      this.header = parsed;
      this.headerDone = true;
    }

    while (this.buf.length > 0) {
      if (this.separatorSeen && this.answerStarted) {
        deltas.push(this.buf);
        this.buf = "";
        break;
      }
      const nl = this.buf.indexOf("\n");
      if (nl === -1) {
        if (!this.separatorSeen) {
          if (this.buf.trim() === "---") {
            this.separatorSeen = true;
            this.buf = "";
          }
          break;
        }
        if (this.buf.startsWith("---")) {
          break;
        }
        deltas.push(this.buf);
        this.buf = "";
        this.answerStarted = true;
        break;
      }
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim() === "---") {
        this.separatorSeen = true;
        continue;
      }
      if (line.trim() === "" && !this.answerStarted) {
        continue;
      }
      deltas.push(line + "\n");
      this.answerStarted = true;
    }

    return { deltas, header: this.header, badHeader: false };
  }
}
