// Client-side photo preparation: validates the file, then centre-crops and resizes it to a square before upload.
// This keeps uploads small (well under the API's 1.5 MB limit) and strips camera metadata such as location,
// because the image is redrawn on a canvas. The API still re-validates type, size and file signature.

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const OUTPUT_SIZE = 400;

export async function prepareProfilePhoto(file: File): Promise<string> {
  if (!ACCEPTED.includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  if (file.size > MAX_INPUT_BYTES) throw new Error('Choose an image smaller than 10 MB.');

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This image could not be read. Try another file.');
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser cannot process images.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  bitmap.close();

  // WebP where supported (smaller), JPEG otherwise.
  const webp = canvas.toDataURL('image/webp', 0.86);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.88);
}
