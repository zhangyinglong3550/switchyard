import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IMAGE_EXTENSIONS = Object.freeze({
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
});

function safeStem(value, index) {
  const stem = path.basename(String(value || `image-${index + 1}`), path.extname(String(value || "")))
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return stem || `image-${index + 1}`;
}

export function materializeImageAttachments(attachments = [], { root = os.tmpdir() } = {}) {
  const images = attachments.filter((item) => item?.kind === "image");
  if (!images.length) return { directory: "", files: [], cleanup() {} };

  const directory = fs.mkdtempSync(path.join(root, "switchyard-mobile-attachments-"));
  fs.chmodSync(directory, 0o700);
  const files = [];
  try {
    images.forEach((image, index) => {
      const extension = IMAGE_EXTENSIONS[String(image.mimeType || "").toLowerCase()];
      if (!extension) throw new Error(`不支持的图片格式：${image.mimeType || "unknown"}`);
      const file = path.join(directory, `${String(index + 1).padStart(2, "0")}-${safeStem(image.name, index)}${extension}`);
      fs.writeFileSync(file, Buffer.from(String(image.data || ""), "base64"), { mode: 0o600, flag: "wx" });
      files.push({ ...image, path: file });
    });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  return {
    directory,
    files,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}
