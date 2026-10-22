/**
 * Discord attachments turned into something the model can read.
 *
 * Shared by the question itself, whose files travel with the prompt, and by
 * read_attachment, which fetches a file from an earlier message on request.
 */

const TEXT_BYTES = Number(process.env.ATTACHMENT_MAX_TEXT_BYTES ?? 262_144); // 256 KiB
const IMAGE_BYTES = Number(process.env.ATTACHMENT_MAX_IMAGE_BYTES ?? 4_194_304); // 4 MiB
const PDF_BYTES = Number(process.env.ATTACHMENT_MAX_PDF_BYTES ?? 10_485_760); // 10 MiB
const TEXT_CHARS = Number(process.env.ATTACHMENT_MAX_CHARS ?? 8000);

// The model downsamples anything with a longer side, so larger pixels cost
// bandwidth and the image byte limit while adding no detail.
const IMAGE_MAX_SIDE = 1568;

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|sql|x-sh))/;
const TEXT_EXTENSIONS =
  /\.(txt|log|md|json|jsonl|csv|tsv|ya?ml|toml|ini|cfg|conf|xml|html?|css|diff|patch|sql|sh|bash|ps1|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|dockerfile|env\.example)$/i;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const IMAGE_EXTENSIONS = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** "image", "pdf", "text", or null for a file the model cannot take. */
export function kindOf(file) {
  const type = mimeOf(file);
  if (IMAGE_TYPES.test(type)) return "image";
  if (type === "application/pdf" || /\.pdf$/i.test(file.name ?? "")) return "pdf";
  if (TEXT_TYPES.test(type) || TEXT_EXTENSIONS.test(file.name ?? "")) return "text";
  return null;
}

/** Declared content type, or one guessed from the extension when Discord sent none. */
function mimeOf(file) {
  const declared = file.contentType?.split(";")[0]?.trim();
  if (declared) return declared;
  const extension = /\.([a-z0-9]+)$/i.exec(file.name ?? "")?.[1]?.toLowerCase();
  return IMAGE_EXTENSIONS[extension] ?? "";
}

/**
 * Download one attachment.
 *
 * Resolves to `{ kind: "image", data, mimeType }`, `{ kind: "pdf", data }` or
 * `{ kind: "text", text, note }`, with `data` base64. Throws a sentence the
 * model can relay when the file is of an unreadable kind or too large.
 */
export async function loadAttachment(file) {
  const kind = kindOf(file);
  if (!kind) {
    throw new Error(
      `"${file.name}" is ${mimeOf(file) || "an unknown type"}, which I cannot read. ` +
        "I can read text-like files, PDFs and PNG/JPEG/GIF/WebP images.",
    );
  }

  if (kind === "image") return loadImage(file);

  const cap = kind === "pdf" ? PDF_BYTES : TEXT_BYTES;
  if (file.size > cap) {
    throw new Error(`"${file.name}" is ${size(file.size)}, over the ${size(cap)} limit for this kind of file.`);
  }
  const buffer = await download(file.url);

  if (kind === "pdf") return { kind, data: buffer.toString("base64") };

  let text = buffer.toString("utf8");
  let note = "";
  if (text.length > TEXT_CHARS) {
    // Keep the tail: stack traces and logs put the interesting part last.
    text = text.slice(-TEXT_CHARS);
    note = `showing the last ${TEXT_CHARS} characters of ${buffer.length} bytes`;
  }
  return { kind, text, note };
}

/**
 * Phone screenshots routinely exceed the byte limit at full size.
 * Discord's media proxy scales them down on request,
 * and the original stays the fallback while it fits.
 */
async function loadImage(file) {
  const scaled = scaledProxyURL(file);
  if (scaled) {
    const response = await fetch(scaled).catch(() => null);
    const type = response?.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (response?.ok && IMAGE_TYPES.test(type)) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length <= IMAGE_BYTES) {
        return { kind: "image", data: buffer.toString("base64"), mimeType: type };
      }
    }
  }

  if (file.size > IMAGE_BYTES) {
    throw new Error(`"${file.name}" is ${size(file.size)}, over the ${size(IMAGE_BYTES)} limit for images.`);
  }
  const buffer = await download(file.url);
  return { kind: "image", data: buffer.toString("base64"), mimeType: mimeOf(file) };
}

/** Proxy URL at most IMAGE_MAX_SIDE on the longer side, or null when no scaling helps. */
function scaledProxyURL(file) {
  const { proxyURL, width, height } = file;
  if (!proxyURL || !width || !height) return null;

  const longest = Math.max(width, height);
  if (longest <= IMAGE_MAX_SIDE && file.size <= IMAGE_BYTES) return null;

  const factor = Math.min(1, IMAGE_MAX_SIDE / longest);
  const url = new URL(proxyURL);
  url.searchParams.set("width", String(Math.max(1, Math.round(width * factor))));
  url.searchParams.set("height", String(Math.max(1, Math.round(height * factor))));
  // WebP keeps the bytes down. A GIF keeps its format to stay animated.
  if (mimeOf(file) !== "image/gif") url.searchParams.set("format", "webp");
  return url.toString();
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

/** Files on a message, forwarded ones included, which Discord keeps on the snapshot. */
export function attachmentsOf(message) {
  const own = [...(message.attachments?.values() ?? [])];
  const forwarded = [...(message.messageSnapshots?.values() ?? [])].flatMap((snapshot) => [
    ...(snapshot.attachments?.values() ?? []),
  ]);
  return [...own, ...forwarded];
}

export function size(bytes) {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KiB`;
}
