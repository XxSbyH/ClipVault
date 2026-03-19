import { logger } from '../logger/logger';

export interface ProcessedImageResult {
  buffer: Buffer;
  originalSize: number;
  compressedSize: number;
  width: number;
  height: number;
}

export async function compressImage(buffer: Buffer): Promise<ProcessedImageResult> {
  const originalSize = buffer.length;
  try {
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default;

    if (originalSize < 500 * 1024) {
      const meta = await sharp(buffer).metadata();
      return {
        buffer,
        originalSize,
        compressedSize: buffer.length,
        width: meta.width ?? 0,
        height: meta.height ?? 0
      };
    }

    const quality = originalSize < 5 * 1024 * 1024 ? 85 : 75;
    const processed = await sharp(buffer)
      .rotate()
      .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    const meta = await sharp(processed).metadata();
    return {
      buffer: processed,
      originalSize,
      compressedSize: processed.length,
      width: meta.width ?? 0,
      height: meta.height ?? 0
    };
  } catch (error) {
    logger.warn('image', `图片压缩失败，回退原图: ${String(error)}`);
    return {
      buffer,
      originalSize,
      compressedSize: buffer.length,
      width: 0,
      height: 0
    };
  }
}
