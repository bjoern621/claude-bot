const DISCORD_LIMIT = 2000;

/**
 * Split text into Discord-sized pieces, preferring line boundaries.
 */
export function chunk(text, limit = DISCORD_LIMIT) {
  const out = [];
  let buffer = "";

  for (const line of text.split("\n")) {
    if (line.length > limit) {
      if (buffer) {
        out.push(buffer);
        buffer = "";
      }
      for (let i = 0; i < line.length; i += limit) {
        out.push(line.slice(i, i + limit));
      }
      continue;
    }

    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length > limit) {
      out.push(buffer);
      buffer = line;
    } else {
      buffer = candidate;
    }
  }

  if (buffer) out.push(buffer);
  return out.length ? out : [""];
}
