// Small, protocol-agnostic SSE parser used by the gateway adapters.
// It deliberately accepts both LF and CRLF streams and keeps UTF-8 decoding
// state across chunks so a code point split by the transport is not corrupted.

export class SseParser {
  constructor(onEvent) {
    if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");
    this.onEvent = onEvent;
    this.decoder = new TextDecoder();
    this.lineBuffer = "";
    this.event = "";
    this.id = "";
    this.retry = "";
    this.comments = [];
    this.dataLines = [];
  }

  push(chunk) {
    if (chunk == null) return;
    const text = typeof chunk === "string"
      ? chunk
      : this.decoder.decode(chunk, { stream: true });
    if (!text) return;
    this.lineBuffer += text;
    this.#consumeLines(false);
  }

  flush() {
    const tail = this.decoder.decode();
    if (tail) this.lineBuffer += tail;
    this.#consumeLines(true);
    this.#dispatch();
  }

  #consumeLines(flush) {
    while (true) {
      let index = -1;
      let separatorLength = 0;
      for (let i = 0; i < this.lineBuffer.length; i += 1) {
        const code = this.lineBuffer.charCodeAt(i);
        if (code === 10) {
          index = i;
          separatorLength = 1;
          break;
        }
        if (code === 13) {
          // A CRLF delimiter may itself be split across transport chunks. Do
          // not consume the CR until we know whether the next byte is LF,
          // otherwise that LF would look like a second blank line and dispatch
          // the current SSE event prematurely.
          if (i === this.lineBuffer.length - 1 && !flush) {
            return;
          }
          index = i;
          separatorLength = this.lineBuffer[i + 1] === "\n" ? 2 : 1;
          break;
        }
      }
      if (index < 0) break;
      const line = this.lineBuffer.slice(0, index);
      this.lineBuffer = this.lineBuffer.slice(index + separatorLength);
      this.#consumeLine(line);
    }
    if (flush && this.lineBuffer) {
      const line = this.lineBuffer;
      this.lineBuffer = "";
      this.#consumeLine(line);
    }
  }

  #consumeLine(line) {
    if (line === "") {
      this.#dispatch();
      return;
    }
    if (line.startsWith(":")) {
      this.comments.push(line.slice(1));
      return;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.event = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        this.id = value;
        break;
      case "retry":
        this.retry = value;
        break;
      default:
        break;
    }
  }

  #dispatch() {
    if (!this.event && !this.dataLines.length && !this.id && !this.retry && !this.comments.length) {
      return;
    }
    const data = this.dataLines.join("\n");
    this.onEvent({
      event: this.event || "message",
      data,
      rawData: data,
      fields: {
        event: this.event || "message",
        id: this.id || "",
        retry: this.retry || "",
        comments: [...this.comments]
      }
    });
    this.event = "";
    this.id = "";
    this.retry = "";
    this.comments = [];
    this.dataLines = [];
  }
}
