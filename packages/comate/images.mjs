import { createHash } from "node:crypto"
import { ProtocolRequestError } from "./protocol.mjs"

const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const IMAGES_MAX = 5
const fail = (message) => { throw new ProtocolRequestError(message) }

function imageOf(part) {
  let type, data
  if (["image_url", "input_image"].includes(part?.type)) {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url ?? "")
    if (!match) fail("Images must be inline base64 PNG, JPEG, WebP or GIF data URLs; remote URLs are not fetched")
    ;[, type, data] = match
  } else if (part?.type === "image") {
    if (part.source?.type !== "base64") fail("Images must use a base64 source")
    type = part.source.media_type
    data = part.source.data
  } else return null
  if (!TYPES.has(type) || typeof data !== "string" || !data.length || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail("Invalid image media type or base64 data")
  if (data.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4) fail("Image exceeds the 10 MiB decoded limit")
  const bytes = Buffer.from(data, "base64")
  if (bytes.toString("base64") !== data) fail("Invalid base64 image encoding")
  if (bytes.length > IMAGE_MAX_BYTES) fail("Image exceeds the 10 MiB decoded limit")
  const hash = createHash("sha256").update(bytes).digest("hex")
  return { contentType: type, data, fileName: `image-${hash.slice(0, 16)}.${type.split("/")[1]}` }
}

// Preserve text, roles, correlation IDs and image positions, without putting
// binary data into the prompt. Images travel via contexts or native results.
export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) fail("messages must be an array")
  const images = new Map()
  const normalized = messages.map((message, index) => {
    const found = []
    let content = message?.content
    if (Array.isArray(content)) content = content.map(part => {
      const image = imageOf(part)
      if (image) {
        found.push(image)
        return { type: "text", text: "[Attached image]" }
      }
      if (typeof part === "string") return { type: "text", text: part }
      if (!part || ![undefined, "text", "input_text", "output_text"].includes(part.type) || typeof part.text !== "string" || part.source || part.image_url || part.audio_url || part.video_url) fail("Unsupported content part; only text and inline images are supported")
      return part
    })
    else if (content != null && typeof content !== "string" && (typeof content !== "object" || ![undefined, "text", "input_text", "output_text"].includes(content.type) || typeof content.text !== "string" || content.source || content.image_url || content.audio_url || content.video_url)) fail("Unsupported message content")
    if (found.length) images.set(index, found)
    return { ...message, content }
  })
  return { messages: normalized, images }
}

export function imagesFrom(images, from = 0, exclude = new Set()) {
  const out = []
  for (const [index, list] of images) if (index >= from && !exclude.has(index)) out.push(...list)
  if (out.length > IMAGES_MAX) fail(`A cloud request supports at most ${IMAGES_MAX} image uploads`)
  return out
}
